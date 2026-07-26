# Deploying to Railway

The app is three things: a **web service** (Fastify serving the API and the built
client from one origin), a **Postgres** database with three extensions, and —
optionally, later — the **ingestion worker**. This guide covers a from-scratch
Railway deploy.

## 1. The database (do this first)

The schema needs `pgvector` **and** `PostGIS` **and** `ltree`. Railway's default
Postgres image does **not** include PostGIS, so deploy our own image instead:

1. New project → **Empty Service** → **Deploy from Dockerfile**, pointing at
   `db/Dockerfile` (it's `pgvector/pgvector:pg17` + PostGIS + ltree).
2. Add a **Volume** mounted at `/var/lib/postgresql/data` so data survives
   redeploys.
3. Set the service's env vars — `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   `POSTGRES_DB` — to match the `DATABASE_URL` you'll give the web service.

The extensions are enabled per-database by the migrations (`CREATE EXTENSION …`),
which the web service runs on start — nothing to do by hand.

## 2. The web service

1. Add a service from this repo. Railway reads `railway.toml`:
   build = `npm run build` (typecheck + client build), start = `npm start`
   (migrate + serve), healthcheck = `/api/health`.
2. Set the environment variables below.
3. Deploy. The start command applies migrations, then serves the API and the
   client on `$PORT`. The globe, feed, field, SSE stream and submission endpoint
   all run from that one origin — no CORS.

### Required environment variables

| Var | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://user:pass@<pg-service>:5432/db` | Reference the Postgres service. Its presence switches the app from seed mode to DB mode. |
| `SUBMISSION_SALT` | a long random secret | **Fatal if missing in DB mode.** Generate once: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Rotating it resets all bans / rate-limit windows. |
| `TRUST_PROXY` | `1` | Railway sits behind a proxy; this makes the first `X-Forwarded-For` hop the real client IP for submission rate-limiting. Wrong (`0`) collapses every client onto the proxy address. |
| `NODE_ENV` | `production` | |

`PORT` is injected by Railway automatically — the server binds to it.

### Optional

| Var | Default | Notes |
| --- | --- | --- |
| `FIREWORKS_API_KEY` | — | Only if the web service should ever run ingestion. Not needed just to serve. |
| `FIRECRAWL_API_KEY` | — | Same. |
| `LOG_LEVEL` | `info` | |

The elevation grid (`public/elevation-grid.json`) is bundled into `dist/` by the
build, so terrain works with no extra step.

## 3. The ingestion worker (defer this)

The worker spends real money on Fireworks + Firecrawl on every cycle, so do
**not** wire it to run automatically on first deploy. When you're ready:

- **Cheapest / safest:** a Railway **Cron** service running `npm run ingest:once`
  on a schedule you choose (e.g. daily), with `INGEST_BATCH_TOPICS` small.
- **Always-on:** a separate service with start command `npm run ingest`. It
  no-ops without both provider keys + `DATABASE_URL`, so it's inert until you
  set them.

Either way it needs `DATABASE_URL`, `FIREWORKS_API_KEY`, `FIRECRAWL_API_KEY`, and
`EMBEDDING_MODEL` (a Matryoshka-capable 512-dim model — see `.env.example`).

## 4. Domain + TLS

Add your domain (e.g. `targetcalamity.com`) to the web service in Railway; it
issues TLS automatically. Then update the two placeholders in
`src/components/FightTheClock/FightTheClock.tsx` (`SHARE_URL`, `DISCORD_URL`) and
redeploy.

## Notes

- **Migrations run on web start.** With one replica that's fine; before scaling
  the web service out, move `tsx server/db/migrate.ts` to a release/pre-deploy
  step so replicas don't race.
- **Seed mode still works with no database** — if `DATABASE_URL` is unset the app
  serves the curated seed set (no ingestion, no submissions persistence). Useful
  for a zero-dependency preview environment.
