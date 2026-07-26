-- Remember that a factor was checked for a quantity threshold and had none.
--
-- `backfill:quantities` now performs a Firecrawl SEARCH per candidate factor, so
-- re-running it is expensive: without this column every factor that yielded no
-- threshold is researched again from scratch. The second run of the day checked
-- 48 rows -- 48 searches -- to gain one threshold, because "no threshold" and
-- "not yet checked" were indistinguishable in the data.
--
-- Only NEGATIVES need recording. A positive is self-evident: tipping_point stops
-- being NULL, and the existing `AND tipping_point IS NULL` guard already skips
-- it. So this column answers exactly one question: have we already spent a
-- search on this row and come back empty?
--
-- A timestamp rather than a boolean so the check can be re-opened later without
-- losing the record of when it was made. Re-checking everything is then a
-- deliberate, dated decision (`SET threshold_checked_at = NULL WHERE ...`)
-- rather than an accident of running a script twice.

ALTER TABLE factors
  ADD COLUMN IF NOT EXISTS threshold_checked_at TIMESTAMPTZ;

COMMENT ON COLUMN factors.threshold_checked_at IS
  'When a quantity-threshold search last came back empty for this factor. NULL = never checked, or a threshold was found (see tipping_point).';

-- Partial: the backfill only ever scans rows with no tipping point, so the index
-- covers exactly the candidate set and nothing else.
CREATE INDEX IF NOT EXISTS idx_factors_threshold_unchecked
    ON factors (threshold_checked_at)
    WHERE tipping_point IS NULL;
