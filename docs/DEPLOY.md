# Deploying to Railway

The app is three things: a **web service** (Fastify serving the API and the built
client from one origin), a **Postgres** database with three extensions, and —
optionally, later — the **ingestion worker**. This guide covers a from-scratch
Railway deploy.

## 1. The database (do this first)

The schema needs `pgvector` **and** `PostGIS` **and** `ltree`. Railway's default
Postgres image does **not** include PostGIS, so deploy our own image instead:

1. Add a service from this repo and set its **Root Directory** to `db`. That
   makes Railway read `db/railway.toml`, which selects the Dockerfile builder
   (`pgvector/pgvector:pg17` + PostGIS + ltree) and sets **no** start command.
   This step is load-bearing: with the repo-root `railway.toml` in effect the
   database inherits the web service's `npm start` and fails to boot with
   _"The executable 'npm' could not be found"_ — the Postgres image has no Node.
2. Add a **Volume** mounted at `/var/lib/postgresql/data` so data survives
   redeploys, and set `PGDATA=/var/lib/postgresql/data/pgdata`. Railway volumes
   are ext4 and arrive containing `lost+found`; the Postgres entrypoint refuses
   to `initdb` into a non-empty directory that has no `PG_VERSION`, so the data
   must live in a subdirectory the image creates itself. Local `docker compose`
   needs no such setting because Docker named volumes start genuinely empty.
3. Set the service's env vars — `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   `POSTGRES_DB` — to match the `DATABASE_URL` you'll give the web service, plus
   `TZ=UTC` and `PGTZ=UTC` (the pagination cursor depends on ordering).

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

| Var                  | Value                                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | `postgresql://${{db.POSTGRES_USER}}:${{db.POSTGRES_PASSWORD}}@${{db.RAILWAY_PRIVATE_DOMAIN}}:5432/${{db.POSTGRES_DB}}` | Reference the Postgres service by its exact name. Use the **private** domain — it keeps database traffic off the public internet. (The stated reason used to be that the public TCP proxy _expects_ TLS; it does not. It refuses `sslmode=require` outright, so anything reaching Postgres through it, including `psql` and `pg_dump`, travels unencrypted. That is an argument for the private domain, not against it.) Its presence switches the app from seed mode to DB mode. |
| `SUBMISSION_SALT`    | a long random secret                                                                                                   | **Fatal if missing in DB mode.** Generate once with `openssl rand -base64 32`. Use a different value per environment — sharing one makes a leaked dev secret enough to reverse production's IP digests. Rotating it resets all bans / rate-limit windows.                                                                                                                                                                                                                         |
| `TRUST_PROXY`        | `1`                                                                                                                    | Railway sits behind a proxy; this makes the first `X-Forwarded-For` hop the real client IP for submission rate-limiting. Wrong (`0`) collapses every client onto the proxy address.                                                                                                                                                                                                                                                                                               |
| `NODE_ENV`           | `production`                                                                                                           | Load-bearing at runtime: it's what makes `embeddings.ts` throw instead of silently falling back to the offline stub when `FIREWORKS_API_KEY` is absent.                                                                                                                                                                                                                                                                                                                           |
| `NPM_CONFIG_INCLUDE` | `dev`                                                                                                                  | Required **because** of `NODE_ENV=production`, which otherwise makes npm skip `devDependencies` — where `typescript` and `vite` live. Without it the build fails with `sh: 1: tsc: not found`.                                                                                                                                                                                                                                                                                    |

`PORT` is injected by Railway automatically — the server binds to it.

### Optional

| Var                                 | Default | Notes                                                                        |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------- |
| `FIREWORKS_API_KEY`                 | —       | Only if the web service should ever run ingestion. Not needed just to serve. |
| `SERPER_API_KEY` or `BRAVE_API_KEY` | —       | Same. One search provider is required.                                       |
| `LOG_LEVEL`                         | `info`  |                                                                              |

The elevation grid (`public/elevation-grid.json`) is bundled into `dist/` by the
build, so terrain works with no extra step.

## 3. The ingestion worker (defer this)

The worker spends real money on Fireworks + the search provider on every cycle, so do
**not** wire it to run automatically on first deploy. When you're ready:

- **Cheapest / safest:** a Railway **Cron** service running `npm run ingest:once`
  on a schedule you choose (e.g. daily), with `INGEST_BATCH_TOPICS` small.
- **Always-on:** a separate service with start command `npm run ingest`. It
  no-ops without both provider keys + `DATABASE_URL`, so it's inert until you
  set them.

Either way it needs `DATABASE_URL`, `FIREWORKS_API_KEY`, a search key, and
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
