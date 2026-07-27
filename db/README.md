# Database — Target: Calamity

PostgreSQL schema for the Phase-1 system. This directory owns the migrations and
the deviations they encode from the two specs.

## Layout

| File                                           | Status              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/001_init.sql`                      | **active**          | Phase-1 core schema: `factors`, `citations`, `factor_revisions`, `schema_migrations` ledger, triggers, indexes.                                                                                                                                                                                                                                                                                                                               |
| `migrations/002_ingestion.sql`                 | **active**          | Phase-1 ingestion support: `citations.content_hash` ( idempotency key) + partial-unique index, and the `ingestion_quarantine` sink (finding 27).                                                                                                                                                                                                                                                                                              |
| `migrations/003_tipping_points.sql`            | **active**          | `factors.tipping_point JSONB` (nullable) — the dated tipping-point threshold a factor may carry, matching the shared `TippingPointSchema`. Feeds the Clock's countdown baseline.                                                                                                                                                                                                                                                              |
| `migrations/004_reputability.sql`              | **active**          | `factors.reputability_score REAL` + `reputability_reasoning TEXT` (both nullable) — the reputability gate's audit trail (deciding source's score + reasoning, /-37), with a `CHECK` bounding the score to `[0,1]` when present.                                                                                                                                                                                                               |
| `migrations/005_submissions.sql`               | **active**          | `submissions` + `banned_submitters` — anonymous Phase-1 factor submissions. Identity is stored ONLY as salted SHA-256 digests (`ip_hash`, `device_hash`); there is no raw-IP column. Carries the outcome trail (`accepted`/`rejected_noise`/`quarantined`/`rate_limited`/`duplicate`) and the shadow-ban list.                                                                                                                                |
| `migrations/009_trigger_search_path.sql`       | **active**          | Adds `SET search_path = public, pg_catalog` to the three trigger functions from `001_init.sql`. They referenced `factors` / `factor_revisions` unqualified, so they resolved only when the _caller's_ search_path included `public` — which `pg_restore` (`search_path = ''`) does not, making a data-only restore fail with `relation "factor_revisions" does not exist` unless `--disable-triggers` was passed. Bodies otherwise unchanged. |
| `migrations/003_future_federation.sql.planned` | **not a migration** | Phase-2 `registered_nodes` DDL. The `.planned` suffix keeps the runner from applying it. Do not apply in Phase 1.                                                                                                                                                                                                                                                                                                                             |

The migration runner (`server/db/migrate.ts`) only picks up files matching
`^NNN_*.sql$`. `001_init.sql`, `002_ingestion.sql`, `003_tipping_points.sql`,
`004_reputability.sql`, and `005_submissions.sql` match;
`003_future_federation.sql.planned` does not, by
design (the shared `003` numeric prefix is harmless — the ledger keys on the full
filename, and only the `.sql` file is ever applied). Files apply in filename order,
so `004` lands after `003_tipping_points.sql` and `005` after `004`.

### How re-running stays idempotent

`server/db/migrate.ts` keeps a `schema_migrations(filename, applied_at)` ledger
(created by `001_init.sql`, `IF NOT EXISTS`). Every migration file self-registers
with an `INSERT ... ON CONFLICT DO NOTHING` at its end, so **both** bootstrap
paths populate the same ledger:

- **docker first boot** runs every `*.sql` via `docker-entrypoint-initdb.d`; each
  file records itself.
- **`npm run db:migrate`** reads the ledger and applies only files not yet in it,
  each in its own transaction.

So `db:migrate` is safe to re-run against an already-initialised volume (it
applies nothing until a genuinely new migration file appears) and is also how a
later migration reaches a volume that initdb only bootstrapped with the earlier
ones.

## Required platform versions

Verified against the `pgvector/pgvector:pg17` image with PostGIS added,
i.e. **PostgreSQL 17.x, pgvector 0.8.5, ltree 1.3, PostGIS 3.6.4**. The hard floors
the schema actually requires:

| Component  | Minimum                   | Why                                                                                                      |
| ---------- | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| PostgreSQL | **13+** (we run 17)       | `gen_random_uuid()` is a core built-in from PG13; `pgcrypto` is therefore **not** required (finding #7). |
| pgvector   | **0.7.0+** (we run 0.8.5) | `halfvec` type + `halfvec_cosine_ops` HNSW opclass.                                                      |
| PostGIS    | **3.0+** (we run 3.6.4)   | `geography(Point,4326)` + GiST.                                                                          |

Extensions enabled by the migration: `vector`, `ltree`, `postgis`.

> The stock `pgvector/pgvector:pg17` image does **not** ship PostGIS. The
> `docker-compose` service must use an image that provides both `vector` and
> `postgis` (e.g. build a layer that `apt-get install postgresql-17-postgis-3` on
> top of `pgvector/pgvector:pg17`, or use an equivalent combined image). The
> migration `CREATE EXTENSION IF NOT EXISTS postgis;` will fail if the PostGIS
> files are not present on the server. (`docker-compose.yml` is owned elsewhere.)

## Applying

Preferred — the runner tracks what it has applied via `schema_migrations`, so it
is safe to re-run and it applies each pending file in order:

```bash
npm run db:migrate          # DATABASE_URL must point at a vector+ltree+postgis DB
```

Manual, one file at a time (equivalent for a single file; the file self-registers
in `schema_migrations` on success):

```bash
# against a running server that has vector + ltree + postgis available
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_init.sql
```

Within a single file, only the extension block and the ledger table are guarded
with `IF NOT EXISTS`; the `CREATE TABLE`/`CREATE INDEX` statements in `001` are
not, so a given migration file must run against a database that has not already
applied it — which is exactly what the `schema_migrations` ledger guarantees when
you go through `npm run db:migrate`. Each file runs as a single unit — do not
split the extension block from the DDL (the `halfvec` column and the `hnsw` index
both depend on `vector`).

## Verification performed

`001_init.sql` was applied into a live `pgvector/pgvector:pg17` + PostGIS 3.6.4
container and exercised. Confirmed:

- Full migration applies cleanly end to end.
- Generated columns compute correctly: `geog` = `ST_MakePoint(lon, lat)` in SRID
  4326, `zone_level` from `nlevel(spatial_path)`, `search_tsv` populated.
- `nlevel`, `ST_MakePoint`, `ST_SetSRID`, and the `geometry→geography` cast are all
  `IMMUTABLE` — which is what makes the `zone_level` and `geog` **generated
  columns** legal. The trigger fallback is **not** needed.
- Event-log wiring: INSERT auto-writes a genesis `factor_revisions` row;
  an `escalation`/`de-escalation`/`correction` revision folds into the `factors`
  projection and bumps `updated_at`, while `seq` stays immutable.
- Every CHECK rejects its poison value: `effect` out of `[-1,1]` and `NaN`;
  negative `significance`; `lat`/`lon` out of range (including the "silent band"
  `lat=95` and `±Infinity`); rootless and depth-3 `spatial_path`; bad
  `verification_state`; NULL `citations.factor_id`; explicit NULL `updated_at`.
  Boundary values (`effect=-1`, `significance=1`, `lat=90`, `lon=-180`) insert.
- `halfvec(512)` inserts; the `ORDER BY embedding <=> $1 LIMIT k` query plans onto
  `idx_factors_embedding_hnsw` (the `WHERE dist < 0.15` predicate form would **not**
  — see /finding #8/#30, honored in the ingestion query, not the schema).
- `ST_DWithin` viewport query works with no antimeridian/pole special case.

## Schema decisions

The reasoning behind the non-obvious choices in `001_init.sql` — the append-only
revision log, the PostGIS viewport predicate, keysetting on `seq`, the enforced
range constraints, and the `halfvec(512)` embedding width — is recorded in
`docs/ARCHITECTURE.md` rather than duplicated here.

## Notes for adjacent modules (not owned here)

- The HNSW dedup query MUST be `ORDER BY embedding <=> $1 LIMIT k` then filter
  `< 0.15` in app code; a `WHERE dist < 0.15` predicate ignores the index.
  Raise `hnsw.ef_search` above the default 40 in the ingestion worker.
- The shader field set comes from `GET /api/field` (camera/cursor-invariant,
  `WHERE verification_state='verified'`), never the paginated feed.
- Viewport queries use `ST_DWithin`/`ST_Intersects` on `geog`, not a `lat/lon`
  box — no antimeridian or pole special cases.
