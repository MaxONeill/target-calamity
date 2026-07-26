/**
 * GET /api/stream — Server-Sent Events for live factor updates.
 *
 * The spec describes a continuous feed but no delivery mechanism; polling is the
 * wrong shape. In DB mode a single dedicated client holds a Postgres `LISTEN` on
 * `factor_updates` and fans NOTIFY payloads out to every connected browser. This
 * is how escalations reach already-cached cards (confirmed defects #13/#21: the
 * backfill feed keysets on the immutable `seq` and therefore will NOT resurface
 * an escalated row — the delta stream is the out-of-band path that does).
 *
 * In seed mode (no DATABASE_URL) there is no Postgres to LISTEN on, so the
 * endpoint degrades cleanly: it still opens the SSE channel and keeps it alive,
 * it just never emits factor deltas. No error.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Notification, PoolClient } from 'pg';
import type { ServerResponse } from 'node:http';

/** Postgres NOTIFY channel the ingestion worker signals on. */
const NOTIFY_CHANNEL = 'factor_updates';

/** Heartbeat interval — keeps proxies from closing an idle SSE connection. */
const KEEPALIVE_MS = 15_000;

/**
 * Backoff for re-binding the LISTEN client after the database goes away.
 * Doubles from MIN to MAX so a long outage settles into a slow retry instead of
 * hammering a database that is still starting up.
 */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export default async function streamRoutes(fastify: FastifyInstance): Promise<void> {
  const ctx = fastify.appCtx;

  // Every open SSE connection's raw response. One broadcast writes to all.
  const clients = new Set<ServerResponse>();

  function broadcast(event: string, data: string): void {
    const frame = `event: ${event}\ndata: ${data}\n\n`;
    for (const res of clients) {
      // A client can disconnect between the async 'close'/'error' cleanup firing
      // and this write, leaving a dead socket in the Set. Writing to it would
      // throw an unhandled stream error (there is no per-write catch otherwise)
      // and a synchronous throw would abort the loop, starving every client
      // after the dead one. Skip/evict already-ended sockets and guard the rest.
      if (res.writableEnded || res.destroyed) {
        clients.delete(res);
        continue;
      }
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  if (ctx.mode === 'db') {
    // Dedicated long-lived client for LISTEN — separate from the query pool so a
    // slow query can never starve notification delivery. It is rebound on loss
    // rather than held forever: see bindListener.
    // Captured here because `bindListener` is a hoisted function declaration,
    // which TS analyses without this block's `ctx.mode === 'db'` narrowing.
    const pool = ctx.pool;
    let listener: PoolClient | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let backoffMs = RECONNECT_MIN_MS;
    let closing = false;

    const onNotification = (msg: Notification): void => {
      if (msg.channel !== NOTIFY_CHANNEL) return;
      // The worker's payload is expected to be a JSON factor delta; pass it
      // through verbatim (default to an empty object if a bare NOTIFY arrives).
      broadcast('factor', msg.payload ?? '{}');
    };

    /** Drop a dead client. Idempotent — loss can be observed more than once. */
    const discard = (client: PoolClient, err?: Error): void => {
      client.removeListener('notification', onNotification);
      client.removeAllListeners('error');
      if (listener === client) listener = null;
      try {
        // Releasing WITH an error destroys the connection instead of returning a
        // broken one to the pool, where it would be handed to the next caller.
        client.release(err ?? true);
      } catch {
        // Already released by the pool's own error handling.
      }
    };

    const scheduleRebind = (): void => {
      if (closing || reconnectTimer !== null) return;
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void bindListener();
      }, delay);
      // Must not hold the event loop open during shutdown.
      reconnectTimer.unref();
    };

    async function bindListener(): Promise<void> {
      if (closing) return;
      try {
        const client = await pool.connect();
        // THE reason this route used to take the whole process down: a FATAL
        // from the server (57P01 when Postgres restarts or fails over) arrives
        // as an 'error' event on the client. With no listener attached, Node
        // treats it as an unhandled 'error' and exits. A database restart must
        // degrade live deltas, never kill the web service.
        client.on('error', (err: Error) => {
          if (closing) return;
          fastify.log.warn({ err, channel: NOTIFY_CHANNEL }, 'LISTEN client lost; rebinding');
          discard(client, err);
          scheduleRebind();
        });
        client.on('notification', onNotification);
        await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
        listener = client;
        backoffMs = RECONNECT_MIN_MS;
        fastify.log.info({ channel: NOTIFY_CHANNEL }, 'SSE stream bound to Postgres LISTEN/NOTIFY');
      } catch (err) {
        // Includes the database simply not being up yet. Serving the client and
        // the feed matters more than live deltas, so retry rather than throw.
        fastify.log.warn({ err, channel: NOTIFY_CHANNEL }, 'LISTEN bind failed; will retry');
        scheduleRebind();
      }
    }

    await bindListener();

    fastify.addHook('onClose', async () => {
      closing = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const client = listener;
      if (client === null) return;
      listener = null;
      client.removeListener('notification', onNotification);
      client.removeAllListeners('error');
      try {
        await client.query(`UNLISTEN ${NOTIFY_CHANNEL}`);
      } catch {
        // The connection may already be tearing down; nothing to unlisten.
      }
      try {
        client.release();
      } catch {
        // Already released.
      }
    });
  } else {
    fastify.log.info('SSE stream in seed mode: keepalive only, no live deltas ( degrade)');
  }

  fastify.get('/api/stream', (req: FastifyRequest, reply: FastifyReply) => {
    // Take over the raw socket — Fastify must not try to serialize a reply.
    reply.hijack();
    const res = reply.raw;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering (nginx) so events flush immediately.
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`event: ready\ndata: ${JSON.stringify({ mode: ctx.mode })}\n\n`);

    clients.add(res);

    const keepalive = setInterval(() => {
      // A comment line is a valid SSE heartbeat that clients ignore.
      res.write(`: keepalive\n\n`);
    }, KEEPALIVE_MS);

    const cleanup = (): void => {
      clearInterval(keepalive);
      clients.delete(res);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
    // A stream error on the response socket (e.g. a write to a peer that reset
    // the connection) must not surface as an uncaught exception. Attaching an
    // 'error' listener both handles it and evicts the dead socket from the Set.
    res.on('error', cleanup);
  });
}
