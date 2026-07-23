# Database — Target: Calamity

PostgreSQL schema for the Phase-1 system. This directory owns the migrations and
the deviations they encode from the two specs.

## Layout

| File | Status | What it is |
| --- | --- | --- |
| `migrations/001_init.sql` | **active** | Phase-1 core schema: `factors`, `citations`, `factor_revisions`, `schema_migrations` ledger, triggers, indexes. |
| `migrations/002_ingestion.sql` | **active** | Phase-1 ingestion support: `citations.content_hash` (ADR-21 idempotency key) + partial-unique index, and the `ingestion_quarantine` sink (finding 27). |
| `migrations/003_tipping_points.sql` | **active** | `factors.tipping_point JSONB` (nullable) — the dated tipping-point threshold a factor may carry, matching the shared `TippingPointSchema` (ADR-34/-35). Feeds the Clock's countdown baseline. |
| `migrations/004_reputability.sql` | **active** | `factors.reputability_score REAL` + `reputability_reasoning TEXT` (both nullable) — the reputability gate's audit trail (deciding source's score + reasoning, ADR-33/-37), with a `CHECK` bounding the score to `[0,1]` when present. |
| `migrations/005_submissions.sql` | **active** | `submissions` + `banned_submitters` — anonymous Phase-1 factor submissions (ADR-45). Identity is stored ONLY as salted SHA-256 digests (`ip_hash`, `device_hash`); there is no raw-IP column. Carries the outcome trail (`accepted`/`rejected_noise`/`quarantined`/`rate_limited`/`duplicate`) and the shadow-ban list. |
| `migrations/003_future_federation.sql.planned` | **not a migration** | Phase-2 `registered_nodes` DDL. The `.planned` suffix keeps the runner from applying it. Do not apply in Phase 1. |

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

Verified against the `pgvector/pgvector:pg17` image (ADR-22) with PostGIS added,
i.e. **PostgreSQL 17.x, pgvector 0.8.5, ltree 1.3, PostGIS 3.6.4**. The hard floors
the schema actually requires:

| Component | Minimum | Why |
| --- | --- | --- |
| PostgreSQL | **13+** (we run 17) | `gen_random_uuid()` is a core built-in from PG13; `pgcrypto` is therefore **not** required (finding #7). |
| pgvector | **0.7.0+** (we run 0.8.5) | `halfvec` type + `halfvec_cosine_ops` HNSW opclass (ADR-12). |
| PostGIS | **3.0+** (we run 3.6.4) | `geography(Point,4326)` + GiST (ADR-8). |

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
  columns** legal. The ADR-10 trigger fallback is **not** needed.
- Event-log wiring (ADR-13): INSERT auto-writes a genesis `factor_revisions` row;
  an `escalation`/`de-escalation`/`correction` revision folds into the `factors`
  projection and bumps `updated_at`, while `seq` stays immutable.
- Every CHECK rejects its poison value: `effect` out of `[-1,1]` and `NaN`;
  negative `significance`; `lat`/`lon` out of range (including the "silent band"
  `lat=95` and `±Infinity`); rootless and depth-3 `spatial_path`; bad
  `verification_state`; NULL `citations.factor_id`; explicit NULL `updated_at`.
  Boundary values (`effect=-1`, `significance=1`, `lat=90`, `lon=-180`) insert.
- `halfvec(512)` inserts; the `ORDER BY embedding <=> $1 LIMIT k` query plans onto
  `idx_factors_embedding_hnsw` (the `WHERE dist < 0.15` predicate form would **not**
  — see ADR-18/finding #8/#30, honored in the ingestion query, not the schema).
- `ST_DWithin` viewport query works with no antimeridian/pole special case.

## Deviations from the specs, keyed to ADR

Every item below is also carried as a `SPEC DEVIATION (ADR-n)` comment at its site
in `001_init.sql`.

### Extensions

- **ADR-14 — extension name.** Spec: `CREATE EXTENSION ... pgvector;`. There is no
  `pgvector.control`; the extension is named `vector`. The spec statement ERRORs on
  every platform and aborts the migration (`IF NOT EXISTS` does not save it —
  finding #6). Fixed to `CREATE EXTENSION IF NOT EXISTS vector;`, no hard-coded
  `WITH SCHEMA` (portable form).
- **ADR-8 — PostGIS enabled.** The specs never enable PostGIS; we add it for real
  spherical viewport queries.

### `factors` columns

- **ADR-9 — float types.** `effect`/`significance` → `REAL`; `lat`/`lon` →
  `DOUBLE PRECISION`. Spec used unbounded `NUMERIC`/`NUMERIC(8,6)/(9,6)`. These
  reach the shader as float32 regardless.
- **ADR-11 / ADR-11a — enforce documented ranges.**
  `CHECK (effect BETWEEN -1 AND 1)`, `CHECK (significance BETWEEN 0 AND 1)`,
  `CHECK (lat BETWEEN -90 AND 90)`, `CHECK (lon BETWEEN -180 AND 180)`. Spec
  declared these only in comments. `BETWEEN` also rejects `NaN`/`±Infinity`
  (finding #9); the `x = x` idiom is **not** used (it is TRUE for `numeric` NaN).
  The `effect` bound is load-bearing for the ADR-3 color model (findings
  #4/#9/#10/#16/#32/#33). Negative `significance` (polarity inversion) is blocked.
- **ADR-8 — `geog` generated column.** `geography(Point,4326)` derived
  `GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon,lat),4326)::geography) STORED`.
  New column; the spec had no spatial type.
- **ADR-10 — `zone_level` generated column.** Derived
  `GENERATED ALWAYS AS (CASE nlevel(spatial_path) WHEN 1 THEN 'global' ELSE 'national' END) STORED`
  instead of a stored, unconstrained second source of truth that could drift from
  `spatial_path` (findings #11/#33). **Used the generated-column path, not the
  trigger fallback**, because `nlevel` is verified `IMMUTABLE`.
- **ADR-11 — path constraint.**
  `CHECK (spatial_path <@ 'global' AND nlevel(spatial_path) <= 2)` — enforces the
  "Global/National only" bound the spec stated only in a comment; rejects rootless
  and depth-3 paths. Relax when Phase 2 lands.
- **ADR-20 — `verification_state`.** New `TEXT NOT NULL DEFAULT 'pending'
  CHECK (... IN ('verified','pending'))`; LLM-ingested factors land unreviewed.
- **ADR-12 — `embedding halfvec(512)` + `search_tsv`.** Spec stored
  `VECTOR(1536)`. We store Matryoshka-truncated half-precision `halfvec(512)` and
  add a generated `tsvector` for hybrid retrieval. The two-arg
  `to_tsvector('english', …)` form is used (IMMUTABLE; the one-arg form is only
  STABLE and cannot be used in a generated column).
- **ADR-11 — `created_at`/`updated_at` NOT NULL.** Spec wrote `DEFAULT NOW()`
  without `NOT NULL`; an explicit `NULL` sort key makes a row permanently
  unreachable via keyset pagination (finding #12).
- **ADR-15 / ADR-15a — `seq` immutable pagination key.** New
  `BIGINT GENERATED ALWAYS AS IDENTITY`. Feed keysets on `(seq DESC)` because Phase
  D mutates `updated_at`; keying the cursor on `updated_at` silently skips
  escalating factors mid-scroll (findings #13/#21). `seq` is assigned once at
  INSERT and never on escalation.

### `citations`

- **ADR-11 — `factor_id NOT NULL`** (findings #14). Contradicted the
  "One-to-Many Strict" header otherwise; orphans are cascade-unreachable.
- **`retrieved_at NOT NULL`** hygiene (finding #12); the ADR-11 index orders on it.
- `source_url` kept nullable (spec) — not every source is a URL; the strict FK fix
  is `factor_id`, per ADR-11. (Finding #31's `source_url NOT NULL` suggestion is not
  an adopted ADR, so not applied.)
- **ADR-21 — `content_hash`** (added in `002_ingestion.sql`, nullable): the ingest
  idempotency key recorded on the citation so a re-ingest of the same item is caught
  before any embedding spend. Partial-unique (`WHERE content_hash IS NOT NULL`) so
  seed/hand-curated citations (which have none) never collide.

### `factors.tipping_point` (migration 003)

- **ADR-34/-35 — `tipping_point JSONB`** (added in `003_tipping_points.sql`,
  nullable). The dated, (near-)irreversible threshold a factor may represent
  (`{ centralYear, earliestYear?, latestYear?, label? }`, matching the shared
  `TippingPointSchema`). NULL for the majority of factors (pressures/counter-forces
  are not dated thresholds); populated only where the sources give a concrete dated
  threshold. node-postgres returns it already-parsed; the feed/field routes map it
  to `tippingPoint` and re-validate through zod. It feeds the Clock's
  significance-weighted countdown baseline (ADR-34), so the field-pin projection
  carries it too (ADR-35).

### `factors.reputability_score` / `reputability_reasoning` (migration 004)

- **ADR-33/-37 — the reputability gate's audit trail** (added in `004_reputability.sql`,
  both nullable). `reputability_score REAL` is the DECIDING (max-scoring) source's
  credibility score and `reputability_reasoning TEXT` the model/heuristic
  justification behind the `verification_state`. A `CHECK
  (reputability_score IS NULL OR (reputability_score >= 0 AND reputability_score
  <= 1))` bounds the score to `[0,1]` **when present**, mirroring the shared
  `FactorSchema` (`z.number().min(0).max(1)`). NULL for seed/hand-curated factors
  and anything ingested before this migration — the audit trail exists only where
  the gate ran. The feed route maps them to `reputabilityScore` /
  `reputabilityReasoning`, dropping a SQL null so the never-`null` `.optional()`
  contract holds, and re-validates through zod (ADR-23). Persisted on insert by
  the ingestion write path (`pgRepository.ts`); escalations do not touch it. Added
  to `factors` only — the lean `FieldPin` projection deliberately omits it (ADR-26).

### `submissions` / `banned_submitters` (migration 005)

- **ADR-45 — anonymous Phase-1 submissions.** `submissions` records EVERY attempt
  with its outcome (`CHECK status IN ('accepted','rejected_noise','quarantined',
  'rate_limited','duplicate')`), and `banned_submitters` is the shadow-ban list
  (`CHECK` that at least one of `ip_hash`/`device_hash` is present, so a row can
  never ban everybody).
- **No raw identifier is stored anywhere.** `ip_hash` and `device_hash` are
  `sha256(SUBMISSION_SALT ‖ value)` in lowercase hex. The salt lives only in the
  environment and is REQUIRED (the server refuses to boot in DB mode without it):
  an unsalted `sha256(ip)` is trivially reversible across the ~4.3e9 IPv4 space,
  so it would be an encoding of the address, not a protection. Rotating the salt
  invalidates every hash — bans and rate-limit windows reset.
- **Note what the table does NOT have:** no `effect`, `significance`,
  `verification_state`, `lat`, `lon` or `tipping_point`. Those are system-assigned
  by the vetting pipeline; the request schema is `.strict()` so a submitter
  supplying one is rejected before any write.
- **Indexes.** `(ip_hash, created_at DESC)` and `(device_hash, created_at DESC)`
  serve the 24h-window lookup (the check is an OR over both halves);
  `(status, created_at DESC)` serves operator review of a given reject pile.
  `banned_submitters` indexes each half separately.

### `factor_revisions` (new table)

- **ADR-13 — event sourcing made real.** Spec §2 claims "event-sourced" but Phase D
  overwrites `effect`/`significance` in place (findings #17/#31). Append-only log;
  `factors` is the current-state projection maintained by trigger. Bounds mirror
  the projection so the log can never carry a value the projection rejects
  (ADR-11a; Phase D / ADR-19 clamps into range).

### Triggers

- **ADR-11 — `updated_at` trigger.** `BEFORE UPDATE` sets `updated_at = NOW()`.
- **ADR-13 — genesis + projection triggers.** `AFTER INSERT ON factors` writes the
  genesis revision; `AFTER INSERT ON factor_revisions` folds non-genesis revisions
  into the projection. See the write-path contract at the bottom of `001_init.sql`.

### Indexes

- **ADR-15a — `idx_factors_feed_seq` `(seq DESC, id DESC)`** replaces the spec's
  `idx_factors_cursor_pagination` on `(updated_at DESC, id DESC)` as the feed
  cursor index.
- **`idx_factors_updated_at` `(updated_at DESC, id DESC)`** retained for the
  out-of-band `changed_since` delta path (ADR-17).
- **ADR-15 — `idx_factors_magnitude` `(abs(effect) DESC, id DESC)`** for the §4
  magnitude "Sorting Override" (findings #18/#19/#23); spec provided none.
- **ADR-26 — `idx_factors_field_rank` `((ABS(effect*significance)) DESC, id ASC)`**
  for `GET /api/field` (findings #5). `id ASC` tiebreak is mandatory for
  determinism.
- **ADR-8 — `idx_factors_geog`** GiST on `geog`.
- **ADR-12 — `idx_factors_embedding_hnsw`** HNSW `(embedding halfvec_cosine_ops)
  WITH (m=16, ef_construction=64)`; and **`idx_factors_search_tsv`** GIN on
  `search_tsv`.
- **ADR-11 — `idx_citations_factor_id` `(factor_id, retrieved_at DESC)`** — the FK
  referencing side is never auto-indexed; without it every cascade delete and every
  per-card citation fetch is a full scan (findings #15/#24).
- **`idx_factor_revisions_factor` `(factor_id, changed_at DESC)`** for audit/replay.

## Notes for adjacent modules (not owned here)

- The HNSW dedup query MUST be `ORDER BY embedding <=> $1 LIMIT k` then filter
  `< 0.15` in app code (ADR-18); a `WHERE dist < 0.15` predicate ignores the index.
  Raise `hnsw.ef_search` above the default 40 in the ingestion worker.
- The shader field set comes from `GET /api/field` (camera/cursor-invariant,
  `WHERE verification_state='verified'`), never the paginated feed (ADR-26).
- Viewport queries use `ST_DWithin`/`ST_Intersects` on `geog`, not a `lat/lon`
  box (ADR-8) — no antimeridian or pole special cases.
