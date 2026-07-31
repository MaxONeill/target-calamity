/**
 * Fastify bootstrap for Target: Calamity.
 *
 * Reads `DATABASE_URL`. When it is present the API runs against Postgres
 * (pgvector + ltree + PostGIS). When it is ABSENT the server MUST still
 * run: it falls back to serving `SEED_FACTORS` from `shared/seed.ts` and logs
 * loudly that it is in seed mode, so the whole app is demonstrable without a
 * database. Every route branches on `appCtx.mode` and runs the in-memory
 * equivalent in seed mode.
 *
 * vite.config.ts proxies `/api/*` here in dev, so there is no CORS surface.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createDatabase, type AppContext } from './db.js';
import factorsRoutes from './routes/factors.js';
import fieldRoutes from './routes/field.js';
import streamRoutes from './routes/stream.js';
import submitRoutes from './routes/submit.js';
import staticClient from './staticClient.js';
import { readSubmissionSalt } from './submissions/identity.js';

// Railway (and most PaaS) inject the bind port as $PORT. Fall back to API_PORT
// for local dev, then a default.
const API_PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);

/** The built client, served in production. `<repo>/dist`, two levels up from server/. */
const CLIENT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const DATABASE_URL = process.env.DATABASE_URL;

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
});

/* -------------------------------------------------------------------------- */
/* Mode selection                                                             */
/* -------------------------------------------------------------------------- */

let ctx: AppContext;
if (DATABASE_URL && DATABASE_URL.trim() !== '') {
  const { db, pool } = createDatabase(DATABASE_URL);
  ctx = { mode: 'db', db, pool };
  app.log.info('Live DB mode — serving factors from PostgreSQL');
} else {
  ctx = { mode: 'seed' };
  app.log.warn(
    'SEED MODE — no DATABASE_URL set. Serving SEED_FACTORS from shared/seed.ts. ' +
      'The feed, field, and stream endpoints all run; ingestion and live deltas do not.',
  );
}

app.decorate<AppContext>('appCtx', ctx);

/* -------------------------------------------------------------------------- */
/* Submission salt                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Anonymous submissions hash the client IP and device id with `SUBMISSION_SALT`
 * so no raw identifier is ever stored. In DB mode a missing salt is FATAL: the
 * alternative is writing unsalted digests, which for the enumerable IPv4 space
 * is a reversible encoding of the IP — a privacy failure that would be baked
 * permanently into the rows before anyone noticed. Fail at boot instead.
 *
 * In seed mode there is no durable store to poison, so we generate an ephemeral
 * per-process salt and log it loudly: the endpoint stays demonstrable without a
 * database, and its rate limits/bans reset on restart by construction.
 */
let submissionSalt: string;
if (ctx.mode === 'db') {
  submissionSalt = readSubmissionSalt(process.env); // throws → process exits
} else {
  try {
    submissionSalt = readSubmissionSalt(process.env);
  } catch {
    submissionSalt = randomUUID();
    app.log.warn(
      'SEED MODE — no SUBMISSION_SALT set; using an EPHEMERAL per-process salt. ' +
        'Submission rate limits and shadow bans reset on every restart. Set ' +
        'SUBMISSION_SALT before running with a DATABASE_URL.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Security headers                                                           */
/* -------------------------------------------------------------------------- */

/** Set on a real deployment; also gates HSTS below. */
const canonicalHost = process.env.CANONICAL_HOST?.trim().toLowerCase();

/**
 * Baseline response headers. Hand-rolled rather than pulling in a helmet
 * dependency: it is a dozen constants, and every one of them is a decision
 * worth being able to read here.
 *
 * The CSP is tight because this app genuinely loads nothing from anywhere else.
 * The external origins in the bundle (x.com, reddit, whatsapp…) are share-link
 * HREFS — top-level navigations, which CSP does not govern — not subresources.
 *
 *   style-src allows 'unsafe-inline' because index.html carries an inline
 *   <style> block for the first-paint background. Everything else is 'self'.
 *
 *   img-src allows data: and blob: because the globe builds its land-mask
 *   texture on a canvas rather than fetching one.
 *
 *   connect-src is 'self' only: the feed, the field and the SSE stream are all
 *   same-origin, so anything reaching outward is a bug or an injection.
 *
 * Referrer-Policy matters more here than it looks. Without it the full URL goes
 * to every share target a reader clicks through to. This app hashes IPs so a
 * database dump cannot recover them; leaking browsing context to third parties
 * by default would undercut that for no benefit.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

app.addHook('onSend', async (_request, reply) => {
  void reply.header('Content-Security-Policy', CSP);
  void reply.header('X-Content-Type-Options', 'nosniff');
  void reply.header('X-Frame-Options', 'DENY');
  void reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  void reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  // HSTS only on a real deployment. Sent from a local http server it would pin
  // localhost to https in the developer's browser, which is a memorable
  // afternoon and not a security win.
  if (canonicalHost) {
    void reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
});

/* -------------------------------------------------------------------------- */
/* Canonical host                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Redirect every other hostname to the canonical one.
 *
 * The deployment answers on more than one domain — the .com was registered
 * defensively alongside the .org, and Railway serves both from this same
 * service with a certificate each. Serving identical content on both is
 * duplicate content: search engines pick a winner themselves, links split
 * between two addresses, and the share URL stops matching what people see.
 *
 * Off unless `CANONICAL_HOST` is set, so localhost, preview deployments and
 * seed mode are untouched — a redirect that fires in development would send a
 * developer to production, which is a memorable way to lose an afternoon.
 *
 * TWO CARVE-OUTS, both load-bearing:
 *   - `/api/health` is exempt. Railway's healthcheck calls it on an internal
 *     hostname; redirecting that would fail the check and roll back a deploy
 *     that is otherwise fine.
 *   - 308, not 301. A 301 permits a client to re-issue a POST as a GET, which
 *     would silently turn a factor submission into a page view. 308 preserves
 *     the method.
 */
if (canonicalHost) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/health')) return;
    // `host` carries the port; compare on the hostname alone so an explicit
    // :443 or a proxy-added port does not read as a different site.
    const host = request.headers.host?.toLowerCase().split(':')[0];
    if (!host || host === canonicalHost) return;
    await reply.code(308).redirect(`https://${canonicalHost}${request.url}`);
  });
  app.log.info(`Canonical host ${canonicalHost} — other hostnames 308 to it.`);
}

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

app.get('/api/health', async () => ({
  status: 'ok',
  mode: ctx.mode,
  time: new Date().toISOString(),
}));

await app.register(factorsRoutes);
await app.register(fieldRoutes);
await app.register(streamRoutes);
await app.register(submitRoutes, { salt: submissionSalt });

/* -------------------------------------------------------------------------- */
/* Static client (production)                                                 */
/* -------------------------------------------------------------------------- */

if (existsSync(CLIENT_DIST)) {
  await app.register(staticClient, { root: CLIENT_DIST });
  app.log.info('Serving built client from dist/');
} else {
  app.log.info('No dist/ — API only (client served by Vite in dev)');
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close(); // runs onClose hooks (releases the SSE LISTEN client)
    if (ctx.mode === 'db') {
      await ctx.pool.end();
    }
  } catch (err) {
    app.log.error(err, 'error during shutdown');
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: API_PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err, 'failed to start');
  process.exit(1);
}
