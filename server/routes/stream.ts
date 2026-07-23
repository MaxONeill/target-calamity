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
    // slow query can never starve notification delivery.
    const listener: PoolClient = await ctx.pool.connect();
    await listener.query(`LISTEN ${NOTIFY_CHANNEL}`);

    const onNotification = (msg: Notification): void => {
      if (msg.channel !== NOTIFY_CHANNEL) return;
      // The worker's payload is expected to be a JSON factor delta; pass it
      // through verbatim (default to an empty object if a bare NOTIFY arrives).
      broadcast('factor', msg.payload ?? '{}');
    };
    listener.on('notification', onNotification);

    fastify.addHook('onClose', async () => {
      listener.removeListener('notification', onNotification);
      try {
        await listener.query(`UNLISTEN ${NOTIFY_CHANNEL}`);
      } catch {
        // The connection may already be tearing down; nothing to unlisten.
      }
      listener.release();
    });

    fastify.log.info({ channel: NOTIFY_CHANNEL }, 'SSE stream bound to Postgres LISTEN/NOTIFY');
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
