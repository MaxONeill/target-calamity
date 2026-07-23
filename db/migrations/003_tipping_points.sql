-- =============================================================================
-- Target: Calamity — 003_tipping_points.sql
-- Adds the dated tipping-point threshold a factor may carry.
--
-- The Clock's countdown is anchored to the polycrisis's own TIPPING POINTS: a
-- significance-weighted baseline of dated thresholds (AMOC collapse, an ice-free
-- Arctic, Amazon large-scale collapse exposure, …), shifted by net direction.
-- MOST factors have NO dated threshold (they are pressures or counter-forces),
-- so this column is NULLABLE and left NULL for the majority — it is populated
-- only where the sources give a concrete dated/near-dated threshold.
--
-- Stored as JSONB matching the shared `TippingPointSchema`
-- (shared/schema.ts) field-for-field:
--   { centralYear: number, earliestYear?: number, latestYear?: number, label?: string }
-- node-postgres returns a jsonb column already-parsed, so the server maps it
-- straight to `tippingPoint` and re-validates through zod.
--
-- Applied after 002 by both bootstrap paths (docker initdb runs *.sql in order;
-- `npm run db:migrate` applies files not yet in schema_migrations). Idempotent
-- guard (IF NOT EXISTS) so a re-run is a no-op.
-- =============================================================================

ALTER TABLE factors ADD COLUMN IF NOT EXISTS tipping_point JSONB;

-- Self-register in the migration ledger (see 001_init.sql / server/db/migrate.ts).
INSERT INTO schema_migrations (filename) VALUES ('003_tipping_points.sql')
    ON CONFLICT DO NOTHING;
