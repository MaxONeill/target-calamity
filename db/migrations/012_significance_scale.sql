-- Record the SCALE BAND a factor's significance was scored against.
--
-- `significance` was previously assigned from a one-line instruction —
-- "significance is in [0, 1] (weight/confidence)" — with no rubric and no
-- anchors, which also conflated magnitude with source confidence (scored
-- separately by the reputability gate). The result was a corpus that stopped
-- discriminating: 88 of 89 verified factors between 0.40 and 0.93, 22 at
-- exactly 0.70, the bottom half of the range unused, and global coral-reef
-- collapse scoring the same 0.90 as an Iberian lynx recovery.
--
-- The band is stored, not just the number, for two reasons:
--
--   1. AUDITABILITY. "0.25" is not reviewable; "subnational" is, and it names
--      the judgement to argue with. Same reason the reputability gate persists
--      its reasoning rather than only its score.
--   2. RESUMABILITY. It distinguishes "scored under the rubric" from "carried
--      over from before it existed", so the backfill is re-runnable without
--      re-spending a call on every row.
--
-- Bands (server/ingestion/backfillSignificance.ts is the authority):
--   planetary    0.90-1.00   an Earth-system subsystem
--   continental  0.70-0.85   multi-national, or a globally dominant sector
--   national     0.40-0.65   one country, sector, or biome region
--   subnational  0.15-0.35   part of a country, a single species, one ecosystem
--   site         0.02-0.14   a single location or organisation
--
-- Deliberately TEXT with a CHECK rather than an enum type: adding a band later
-- should be a migration, not an ALTER TYPE that locks the table.

ALTER TABLE factors
  ADD COLUMN IF NOT EXISTS significance_scale TEXT;

ALTER TABLE factors
  DROP CONSTRAINT IF EXISTS factors_significance_scale_check;

ALTER TABLE factors
  ADD CONSTRAINT factors_significance_scale_check
  CHECK (significance_scale IS NULL OR significance_scale IN
    ('planetary', 'continental', 'national', 'subnational', 'site'));

COMMENT ON COLUMN factors.significance_scale IS
  'Scale band significance was scored against. NULL = scored before the rubric existed.';
