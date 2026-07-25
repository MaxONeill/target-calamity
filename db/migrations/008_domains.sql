-- Causal domain tags on factors (see shared/domains.ts).
--
-- The Clock links a factor's force to the tipping points it moves by shared
-- domain. Domains are assigned by the extraction LLM at ingestion and stored
-- here. Rows predating this column (and seed-mode factors) fall back to the
-- deterministic keyword classifier at read time, so no backfill is required —
-- though re-ingesting upgrades a row to the model's own classification.

ALTER TABLE factors
  ADD COLUMN IF NOT EXISTS domains TEXT[] NOT NULL DEFAULT '{}';
