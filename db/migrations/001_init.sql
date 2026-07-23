-- =============================================================================
-- Target: Calamity — 001_init.sql
-- Phase 1 schema. Derived from spec-comprehensive.md §2 (authoritative baseline)
-- and spec.md (v3.2) §2, as revised by the adopted ADRs in docs/ARCHITECTURE.md.
--
-- Every departure from the literal spec DDL carries a ""
-- comment stating what the spec said, what we do instead, and why. A full,
-- ADR-keyed deviation list also lives in db/README.md.
--
-- -----------------------------------------------------------------------------
-- MINIMUM PLATFORM REQUIREMENTS (verified against pgvector/pgvector:pg17 —
--  — with PostgreSQL 17.x, pgvector 0.8.5, ltree 1.3, PostGIS 3.6.4):
--
--   * PostgreSQL >= 13   — gen_random_uuid() is a CORE built-in from PG13 on, so
--                          pgcrypto is deliberately NOT required.
--                          We target/verify on PG17.
--   * pgvector  >= 0.7.0 — halfvec type + halfvec_cosine_ops HNSW opclass.
--                          We target/verify on 0.8.5. (HNSW halfvec dimension cap
--                          is 4000; our 512 dims are well under — do not downsize.)
--   * PostGIS   >= 3.0   — geography(Point,4326) + GiST. Verified on 3.6.4.
--
-- Verified in-container: nlevel(), ST_MakePoint(), ST_SetSRID(), and the
-- geometry->geography cast are all IMMUTABLE, which is what makes the zone_level
-- and geog GENERATED columns below legal without a trigger fallback.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Migration ledger (see server/db/migrate.ts).
-- -----------------------------------------------------------------------------
-- Both bootstrap paths converge here: the docker-entrypoint-initdb.d hook runs
-- this file's raw SQL (which self-registers at the very end), and `npm run
-- db:migrate` reads this ledger to skip already-applied files. CREATE ... IF NOT
-- EXISTS so re-running against an initialised volume is a no-op.
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Core Extensions
-- -----------------------------------------------------------------------------
--  wrote `CREATE EXTENSION ... pgvector;`.
-- There is no pgvector.control file — the extension the project installs is named
-- `vector`. The spec statement ERRORs on every platform (IF NOT EXISTS
-- does not suppress it, since "pgvector" can never already be present under that
-- name) and aborts the whole migration transaction. We use the correct name, and
-- do NOT hard-code `WITH SCHEMA` (portable form; managed hosts default search_path
-- correctly — finding #6). `vector` must be created before the halfvec column and
-- the HNSW index, which both come from it.
CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: halfvec type, hnsw AM, cosine opclass
CREATE EXTENSION IF NOT EXISTS ltree;    -- hierarchical spatial_path
-- the specs never enable PostGIS; the
-- viewport filter was a raw `lat/lon BETWEEN` box. We add PostGIS so viewport
-- queries use a real spherical predicate (ST_DWithin / ST_Intersects) that does
-- not break across the antimeridian or degenerate at the poles (findings #20/#22/#34).
CREATE EXTENSION IF NOT EXISTS postgis;  -- geography(Point,4326) + GiST

-- -----------------------------------------------------------------------------
-- factors — current-state projection of the append-only factor_revisions log.
-- -----------------------------------------------------------------------------
-- On event sourcing:  calls the store "event-sourced"
-- but the spec schema is a single mutable table whose Phase D UPDATE destroys the
-- prior effect/significance in place. We make the claim true:
-- `factor_revisions` (below) is the append-only log; `factors` is the current-state
-- read model maintained from it by trigger. Direct INSERT seeds a factor (and auto-
-- writes its genesis revision); escalations (Phase D) append a revision, which the
-- projection trigger folds into these columns. See the "Write path" note at the end.
CREATE TABLE factors (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- the spec paginates the feed on
    -- (updated_at, id). Phase D mutates updated_at, so a factor sitting below a
    -- live keyset cursor that escalates jumps ABOVE the cursor and is silently
    -- skipped for the rest of the scroll session (findings #13/#21). `seq` is an
    -- insert-only, monotonic, immutable total-order key: assigned once at INSERT,
    -- NEVER rewritten on escalation. The feed cursor keys on (seq DESC); updated_at
    -- is reserved for the out-of-band changed_since delta path.
    seq                      BIGINT GENERATED ALWAYS AS IDENTITY,

    -- spec had bare `LTREE NOT NULL` with the "global /
    -- global.[country_code]" bound stated only in a comment. We enforce it: the
    -- path must be rooted at `global` and be at most 2 levels deep (findings
    -- #11/#33). One-line ALTER to relax when the §8/Phase-2 variable-depth phase
    -- lands. Verified: this rejects rootless paths ('foo.bar') and depth-3 paths.
    spatial_path             LTREE NOT NULL
                               CHECK (spatial_path <@ 'global'::ltree
                                      AND nlevel(spatial_path) <= 2),

    name                     TEXT NOT NULL,
    description              TEXT NOT NULL,

    -- spec stored `VECTOR(1536)`. We store `halfvec(512)`
    -- — embeddings are Matryoshka-truncated to 512 dims via the embedding API's
    -- `dimensions` param and half-precision-packed (~2x storage cut, negligible
    -- HNSW recall loss). Nullable: set during Phase B, so it may be absent between
    -- extraction and vectorization (HNSW simply does not index NULLs).
    embedding                halfvec(512),

    -- spec used bare unbounded `NUMERIC` (arbitrary
    -- precision, up to 131072 integer digits — accepts effect = -99999, and even
    -- 'NaN'::numeric passes a typmod). These reach the shader as float32 anyway.
    -- effect is bounded to [-1,1] — load-bearing for the
    --  two-field color model, whose normalized polarity P inherits effect's
    -- units, so the ±0.5 ramp thresholds only mean anything if effect is bounded
    -- (findings #4/#10/#32). BETWEEN also rejects NaN/±Infinity — we do
    -- NOT use the `x = x` idiom, which passes NaN for float and is TRUE for numeric.
    effect                   REAL NOT NULL CHECK (effect BETWEEN -1.0 AND 1.0),
                                 -- signed charge: Negative = Calamity, Positive = Humanity
    -- spec commented "Scale 0.0 to 1.0" but
    -- enforced nothing — a NEGATIVE significance silently inverts a factor's
    -- polarity (a Calamity renders resilient blue). The non-negativity half is the
    -- correctness fix.
    significance             REAL NOT NULL CHECK (significance BETWEEN 0.0 AND 1.0),

    -- spec used NUMERIC(8,6)/(9,6). We use DOUBLE PRECISION.
    -- Stored in WGS84 DEGREES (finding #1/): lat in [-90,90], lon in [-180,180].
    -- The range CHECKs close the "silent band" where e.g. lat=95 inserts cleanly
    -- (numeric-overflow only fires past the type max, not past the valid range —
    -- finding #16) and also reject NaN/±Infinity via BETWEEN.
    lat                      DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90.0 AND 90.0),
    lon                      DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180.0 AND 180.0),

    -- the spec has no spatial column; §4 filtered a lat/lon
    -- box. `geog` is a GENERATED point in SRID 4326 derived from (lon, lat) — note
    -- ST_MakePoint takes (X=lon, Y=lat). It backs ST_DWithin/ST_Intersects viewport
    -- queries with no antimeridian/pole special cases. Verified IMMUTABLE:
    -- ST_MakePoint, ST_SetSRID, and the geometry->geography cast are all immutable,
    -- so a STORED generated column is legal (no trigger needed).
    geog                     geography(Point, 4326)
                               GENERATED ALWAYS AS
                               (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,

    -- spec stored `zone_level TEXT NOT NULL` as a second,
    -- unconstrained source of truth for a value fully determined by
    -- nlevel(spatial_path) — the two could drift (findings #11/#33). We derive it as
    -- a STORED generated column so drift is structurally impossible. Verified:
    -- nlevel() is IMMUTABLE, so this is legal (the  trigger fallback is NOT
    -- needed). Wire format is byte-identical to the spec (still a TEXT 'global' /
    -- 'national'). The `ELSE 'national'` branch is only correct while depth <= 2,
    -- which the spatial_path CHECK above guarantees.
    zone_level               TEXT GENERATED ALWAYS AS
                               (CASE nlevel(spatial_path) WHEN 1 THEN 'global'
                                                          ELSE 'national' END) STORED,

    -- factors extracted by the Phase A/B LLM pipeline land
    -- 'pending' and are marked unreviewed in the UI, distinct from 'verified'
    -- entries. §3 is an unbounded LLM write path; this costs nothing and lets the
    -- feed / field / Clock gate on review state. Default 'pending' so ingestion is
    -- fail-safe; seed/hand-curated rows are inserted 'verified'.
    verification_state       TEXT NOT NULL DEFAULT 'pending'
                               CHECK (verification_state IN ('verified', 'pending')),

    -- full-text vector for hybrid retrieval alongside the
    -- HNSW vector index — this seed data is dense with named entities and figures
    -- where keyword search beats pure vector. GENERATED STORED; the two-arg
    -- to_tsvector('english', ...) form is IMMUTABLE (the one-arg form, which reads
    -- the default_text_search_config GUC, is only STABLE and would be rejected here).
    search_tsv               tsvector GENERATED ALWAYS AS
                               (to_tsvector('english',
                                            coalesce(name, '') || ' ' || coalesce(description, ''))) STORED,

    -- From : cryptographic anchor for the Phase-2 Gestalt F2F
    -- deep-link. UNIQUE (a NULL is allowed and does not collide under UNIQUE).
    gestalt_channel_address  BYTEA UNIQUE,

    -- spec wrote `TIMESTAMPTZ DEFAULT NOW()` WITHOUT
    -- NOT NULL. DEFAULT does not imply NOT NULL — an explicit ...VALUES(NULL)
    -- (common ORM behavior for an unset optional field) stores NULL, and a NULL
    -- cursor sort key makes the row unreachable via keyset pagination forever
    --. Both are NOT NULL.
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- citations — append-only verification layer ("One-to-Many Strict").
-- -----------------------------------------------------------------------------
CREATE TABLE citations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- spec omitted NOT NULL, so a FK permits NULL and
    -- orphan, cascade-unreachable citations accumulate, contradicting
    -- the "One-to-Many Strict" header. Now NOT NULL.
    factor_id     UUID NOT NULL REFERENCES factors(id) ON DELETE CASCADE,

    source_url    TEXT,                                   -- from spec (nullable: not every source is a URL)
    publisher     TEXT NOT NULL,
    quote_snippet TEXT NOT NULL,
    analyst_notes TEXT,                                   -- nullable free-text (from spec)

    -- NOT NULL added for hygiene and because the  index below
    -- orders on it.
    retrieved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- factor_revisions — the append-only event log.
-- -----------------------------------------------------------------------------
-- the spec has no history table and Phase D overwrites
-- effect/significance in place (finding #17/#31). Every change to a factor's
-- weighting is appended here; `factors` is the projection of the newest revision.
-- This makes Phase D auditable (before/after + reason + the citation that
-- justified it) and preserves the Clock's history over time.
CREATE TABLE factor_revisions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    factor_id       UUID NOT NULL REFERENCES factors(id) ON DELETE CASCADE,

    -- Same bounds as the projection columns, so the log can never carry a value the
    -- projection would reject (; Phase D /  must clamp into this domain).
    effect          REAL NOT NULL CHECK (effect BETWEEN -1.0 AND 1.0),
    significance    REAL NOT NULL CHECK (significance BETWEEN 0.0 AND 1.0),

    -- 'insert' (genesis) | 'escalation' | 'de-escalation' | 'correction'.
    revision_reason TEXT NOT NULL DEFAULT 'insert'
                       CHECK (revision_reason IN ('insert', 'escalation', 'de-escalation', 'correction')),

    -- The citation that justified this revision (NULL for the genesis row). If the
    -- citation is later removed, keep the revision but null the link.
    citation_id     UUID REFERENCES citations(id) ON DELETE SET NULL,

    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- Triggers: updated_at maintenance + event-log <-> projection wiring.
-- =============================================================================

-- Any direct UPDATE to a factor bumps updated_at. seq is GENERATED ... AS IDENTITY
-- and is never assignable on UPDATE, so it stays immutable regardless.
CREATE FUNCTION tc_factors_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_factors_touch_updated_at
    BEFORE UPDATE ON factors
    FOR EACH ROW EXECUTE FUNCTION tc_factors_touch_updated_at();

-- On factor INSERT, auto-write the genesis revision so the append-only log is
-- complete without relying on the application to remember. changed_at is pinned to
-- the factor's created_at so the log's first row matches the projection exactly.
CREATE FUNCTION tc_factors_write_genesis_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO factor_revisions (factor_id, effect, significance, revision_reason, changed_at)
    VALUES (NEW.id, NEW.effect, NEW.significance, 'insert', NEW.created_at);
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_factors_write_genesis_revision
    AFTER INSERT ON factors
    FOR EACH ROW EXECUTE FUNCTION tc_factors_write_genesis_revision();

-- On a NON-genesis revision, fold it into the projection. 'insert' revisions carry
-- the values the projection already has, so they are skipped (no redundant write /
-- no recursion). The BEFORE UPDATE trigger above sets updated_at = NOW() as a side
-- effect, which is exactly the Phase D contract (escalations bump updated_at).
CREATE FUNCTION tc_apply_revision_to_projection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.revision_reason <> 'insert' THEN
        UPDATE factors
           SET effect = NEW.effect,
               significance = NEW.significance
         WHERE id = NEW.factor_id;
    END IF;
    RETURN NULL;  -- AFTER trigger: return value ignored
END;
$$;

CREATE TRIGGER trg_apply_revision_to_projection
    AFTER INSERT ON factor_revisions
    FOR EACH ROW EXECUTE FUNCTION tc_apply_revision_to_projection();

-- =============================================================================
-- Indexes
-- =============================================================================

-- From : hierarchical spatial_path traversal.
CREATE INDEX idx_factors_spatial_path ON factors USING gist (spatial_path);

-- replaces the spec's idx_factors_cursor_pagination on
-- (updated_at DESC, id DESC) as the FEED cursor index. The feed keysets on the
-- immutable seq (see the seq column note); seq is unique on its own, id kept as a
-- defensive tiebreak.
CREATE INDEX idx_factors_feed_seq ON factors (seq DESC, id DESC);

-- Retained for the out-of-band changed_since delta endpoint, which MAY
-- legitimately key on updated_at because it patches already-cached cards in place
-- rather than driving a keyset scroll.
CREATE INDEX idx_factors_updated_at ON factors (updated_at DESC, id DESC);

-- supports the §4 "Sorting Override" magnitude mode
-- (ORDER BY abs(effect) DESC, id DESC). abs(real) is IMMUTABLE so the expression
-- index is legal; the spec provided no index for this sort, making it a full scan +
-- sort every request (findings #18/#19/#23).
CREATE INDEX idx_factors_magnitude ON factors (abs(effect) DESC, id DESC);

-- backs GET /api/field, the camera/cursor-INVARIANT field
-- endpoint whose set drives the shader (NOT the paginated feed — findings #5). Ranks
-- by actual field influence ABS(effect*significance); `id ASC` tiebreak is
-- mandatory for determinism (Postgres has no stable order for ties).
CREATE INDEX idx_factors_field_rank ON factors ((ABS(effect * significance)) DESC, id ASC);

-- GiST on the geography point for real spherical viewport
-- queries (ST_DWithin / ST_Intersects).
CREATE INDEX idx_factors_geog ON factors USING gist (geog);

-- HNSW over the halfvec embedding with the cosine opclass,
-- for the Phase C dedup nearest-neighbour query. Build params m=16 / ef_construction=64
-- are a documented starting point (findings #8/#30); the ingestion worker should
-- raise hnsw.ef_search well above the default 40 for the dedup workload. NOTE the
-- query MUST be `ORDER BY embedding <=> $1 LIMIT k` — a `WHERE dist < 0.15` predicate
-- will NOT use this index and falls back to a seq scan (finding #8//-30).
CREATE INDEX idx_factors_embedding_hnsw
    ON factors USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- GIN over the generated tsvector for the keyword half of
-- hybrid retrieval.
CREATE INDEX idx_factors_search_tsv ON factors USING gin (search_tsv);

-- the spec provided no index on the FK
-- referencing side. Postgres never auto-indexes it, so every ON DELETE CASCADE and
-- every per-card citation fetch was a full scan of the (largest) citations table.
-- factor_id leads (serves the equality lookup and the cascade); retrieved_at DESC
-- lets "newest citation first" be served straight from the index.
CREATE INDEX idx_citations_factor_id ON citations (factor_id, retrieved_at DESC);

-- Audit/replay fetch of a factor's revision history in order.
CREATE INDEX idx_factor_revisions_factor ON factor_revisions (factor_id, changed_at DESC);

-- =============================================================================
-- Write-path contract, for implementers of the ingestion pipeline (§3):
--
--   INSERT a new factor  (Phase D "No Collision"):
--     1. INSERT INTO factors (...) VALUES (...) RETURNING id;    -- genesis revision auto-written
--     2. INSERT INTO citations (factor_id, ...) VALUES (id, ...);
--        (do 1+2 in one transaction so a factor is never citation-less)
--
--   ESCALATE an existing factor (Phase D "Collision" -> escalation):
--     1. INSERT INTO citations (factor_id, ...) VALUES (parent_id, ...) RETURNING id;
--     2. INSERT INTO factor_revisions (factor_id, effect, significance, revision_reason, citation_id)
--        VALUES (parent_id, <clamped new effect>, <clamped new significance>, 'escalation', cit_id);
--        -> the projection trigger folds the new weights into factors and bumps updated_at.
--        Never UPDATE factors.effect/significance directly; always append a revision.
--        seq is NEVER touched by escalation, keeping the feed cursor stable.
-- =============================================================================

-- Self-register in the migration ledger so the docker initdb path and the
-- `npm run db:migrate` runner agree this file has been applied (idempotent).
INSERT INTO schema_migrations (filename) VALUES ('001_init.sql')
    ON CONFLICT DO NOTHING;
