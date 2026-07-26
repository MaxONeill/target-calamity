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
import fastifyStatic from '@fastify/static';
import { createDatabase, type AppContext } from './db.js';
import factorsRoutes from './routes/factors.js';
import fieldRoutes from './routes/field.js';
import streamRoutes from './routes/stream.js';
import submitRoutes from './routes/submit.js';
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

/**
 * In production the Fastify server also serves the built client, so the whole
 * app is one origin and there is no CORS surface (matching the dev proxy). In
 * dev the client is served by Vite, so this is skipped when `dist/` is absent.
 * The API routes above are registered first and win; the SPA fallback returns
 * `index.html` only for non-API GETs so client-side routes resolve.
 */
if (existsSync(CLIENT_DIST)) {
  await app.register(fastifyStatic, { root: CLIENT_DIST, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.method !== 'GET' || request.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    reply.sendFile('index.html');
  });
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
