-- =============================================================================
-- Target: Calamity — 002_ingestion.sql
-- Phase-1 support schema for the §3 Reconciliation Loop's CONCRETE adapter
-- (server/ingestion/pgRepository.ts). 001_init.sql defines the factor/citation/
-- revision core; this migration adds the two surfaces the ingestion ports need
-- that the core schema did not provide:
--
--   * citations.content_hash  — the  idempotency key. contentHash(item) is
--     recorded on the citation so a re-ingest of the same item is caught by
--     IngestionRepository.existsByContentHash BEFORE any extraction/embedding
--     spend. Partial-unique so the ledger also enforces idempotency in the DB,
--     not only in app code.
--   * ingestion_quarantine    — where value-validation / allowlist rejects land
--. Rejected items must NEVER reach `factors`; they are parked
--     here with a reason for later inspection.
--
-- Applied after 001 by both bootstrap paths (docker initdb runs *.sql in order;
-- `npm run db:migrate` applies files not yet in schema_migrations). Idempotent
-- guards (IF NOT EXISTS) so a re-run is a no-op.
-- =============================================================================

--  idempotency key. Nullable: hand-curated/seed citations have none, and a
-- NULL does not collide under the partial unique index below.
ALTER TABLE citations ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Serves existsByContentHash(hash) as an index-only lookup and enforces that no
-- two citations carry the same ingest hash (the idempotency guarantee, at the DB
-- level). Partial so the many NULL (seed) rows are excluded and never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_citations_content_hash
    ON citations (content_hash) WHERE content_hash IS NOT NULL;

-- finding 27 — the quarantine sink. Rejected drafts are routed here, never to
-- `factors`. `payload` keeps a best-effort snapshot of the offending draft.
CREATE TABLE IF NOT EXISTS ingestion_quarantine (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reason         TEXT NOT NULL,
    publisher      TEXT NOT NULL,
    source_url     TEXT,
    payload        JSONB,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Self-register in the migration ledger (see 001_init.sql / server/db/migrate.ts).
INSERT INTO schema_migrations (filename) VALUES ('002_ingestion.sql')
    ON CONFLICT DO NOTHING;
