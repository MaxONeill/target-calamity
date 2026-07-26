-- Projections: published trajectories for measurable quantities.
--
-- Why this table exists. The tipping-point literature publishes thresholds in
-- UNITS, not years — "the Greenland ice sheet destabilises at ~1.5 degC",
-- "Amazon dieback beyond 20-25% deforested". The extraction only accepted a
-- year and (correctly) refused to invent one, so the canonical tipping elements
-- were all present as factors carrying no threshold at all. A projection is the
-- second source that turns a published threshold into a published date: read
-- the curve, find when it reaches the value. Nobody estimates the year.
--
-- A projection's blast radius is larger than a factor's. A wrong factor nudges
-- an aggregate; a wrong projection mis-dates EVERY threshold pinned to its
-- quantity. It is gated like a factor but should clear a higher bar.

CREATE TABLE IF NOT EXISTS projections (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What is projected, in the SOURCE's own words. Free text on purpose: a
    -- controlled vocabulary would cap coverage at whatever was anticipated, and
    -- identity ("global temperature" vs "GMST anomaly") is the problem this
    -- schema already solves for factors with an embedding plus a resolver.
    quantity      TEXT NOT NULL,
    unit          TEXT NOT NULL,

    -- The reference values are stated against, e.g. 'pre-industrial (1850-1900)'.
    -- Load-bearing: "1.5 degC above pre-industrial" and "1.5 degC above
    -- 1986-2005" are the same quantity and unit ~0.6 degC apart. A threshold is
    -- only dated against a projection whose baseline AGREES; unknown on either
    -- side refuses rather than guesses.
    baseline      TEXT,

    -- The scenario as the source names it: 'current policies', 'SSP2-4.5',
    -- 'business as usual'. Copied verbatim, never inferred.
    scenario      TEXT,

    -- TRUE when the scenario bakes in action beyond what is already implemented.
    -- Decides whether the Clock's forces may bend this curve: a mitigation
    -- pathway already assumes the clean-energy expansion, so letting a
    -- clean-energy factor push it further counts the same action twice.
    -- NULL means unlabelled, which the model treats as TRUE — an unlabelled
    -- scenario cannot be shown to be assumption-free, and guessing permissively
    -- is what makes the Clock read later than any source supports.
    assumes_future_action BOOLEAN,

    -- The curve: [{"year": 2050, "value": 2.0}, ...]. JSONB rather than a child
    -- table because a curve is always read whole, never queried point-wise.
    points        JSONB NOT NULL,

    source_url    TEXT NOT NULL,
    source_title  TEXT,

    -- Semantic identity for matching a threshold's quantity to a projection.
    -- Same width and opclass as factors.embedding so the same client and the
    -- same dedupe math apply. Nullable: a curated row may predate vectorisation.
    embedding     halfvec(512),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- A curve needs at least two points to interpolate between.
    CONSTRAINT projections_points_check
        CHECK (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) >= 2)
);

-- One projection per (quantity, unit, baseline, scenario). Re-ingesting the same
-- source updates in place instead of accumulating near-duplicate curves that
-- would date the same threshold differently on different reads.
-- COALESCE because NULL never equals NULL in a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projections_identity
    ON projections (quantity, unit, COALESCE(baseline, ''), COALESCE(scenario, ''));

-- k-NN for quantity resolution. Mirrors the factors index: HNSW, cosine.
CREATE INDEX IF NOT EXISTS idx_projections_embedding
    ON projections USING hnsw (embedding halfvec_cosine_ops);

DROP TRIGGER IF EXISTS trg_projections_touch_updated_at ON projections;

-- search_path pinned for the same reason as migration 009: pg_restore runs with
-- search_path = '' and an unqualified reference would fail there.
CREATE OR REPLACE FUNCTION tc_projections_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_projections_touch_updated_at
    BEFORE UPDATE ON projections
    FOR EACH ROW EXECUTE FUNCTION tc_projections_touch_updated_at();
