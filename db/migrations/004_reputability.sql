-- =============================================================================
-- Target: Calamity — 004_reputability.sql
-- Persists the reputability gate's audit trail on the factor.
--
--  landed the LLM source-credibility gate: it scores every source of a
-- candidate, takes the MAX, and gates verified/pending on
-- REPUTABILITY_VERIFY_THRESHOLD (0.7). Until now the DECIDING score + the model's
-- reasoning were only LOGGED — the verification_state was the only persisted
-- trace.  makes the gate AUDITABLE: the deciding source's score and its
-- reasoning are stored on the factor, so a viewer (and the FactorDetails panel)
-- can see WHY a factor is verified or pending.
--
--   reputability_score      REAL   — the deciding (max) source score in [0, 1]
--   reputability_reasoning  TEXT   — the model/heuristic justification
--
-- Both are NULLABLE and left NULL for seed / hand-curated factors and for any
-- factor ingested before this migration — the audit trail exists only where the
-- gate actually ran. A CHECK bounds the score to [0, 1] WHEN PRESENT (NULL is
-- allowed), mirroring the shared `FactorSchema` (z.number().min(0).max(1)).
--
-- Applied after 003 by both bootstrap paths (docker initdb runs *.sql in order;
-- `npm run db:migrate` applies files not yet in schema_migrations). Idempotent
-- guards (IF NOT EXISTS) so a re-run is a no-op.
-- =============================================================================

ALTER TABLE factors ADD COLUMN IF NOT EXISTS reputability_score REAL;
ALTER TABLE factors ADD COLUMN IF NOT EXISTS reputability_reasoning TEXT;

-- Bound the score to [0, 1] when present (NULL passes — most rows have no audit
-- trail). Guarded so a re-run does not error on the already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'factors_reputability_score_range'
  ) THEN
    ALTER TABLE factors
      ADD CONSTRAINT factors_reputability_score_range
      CHECK (reputability_score IS NULL OR (reputability_score >= 0 AND reputability_score <= 1));
  END IF;
END $$;

-- Self-register in the migration ledger (see 001_init.sql / server/db/migrate.ts).
INSERT INTO schema_migrations (filename) VALUES ('004_reputability.sql')
    ON CONFLICT DO NOTHING;
