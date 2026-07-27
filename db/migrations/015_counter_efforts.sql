-- Counter-efforts: who is actually working on the thing that is missing.
--
-- This is the product's other half. The Clock detects; this routes. A reader
-- who reaches "roughly halving global emissions [absent]" and finds nothing
-- underneath it has been told the problem and abandoned at it.
--
-- Distinct from `requirement_efforts`, which matched requirements to Humanity
-- factors ALREADY ingested. That was tried first and matched nothing at all --
-- eight requirements, zero hits -- because the factor set is a record of what
-- is happening in the world, not a directory of who is working on what. These
-- rows are RESEARCHED: retrieved, extracted and gated on their own terms, the
-- same as any other claim in the system.
--
-- Attached to a requirement rather than to a factor because a requirement is
-- specific enough to route on. "Coral reef decline" has no useful answer to
-- "who is working on this"; "scalable, climate-resilient reef restoration
-- techniques" does. The factor_id column exists so the same machinery can later
-- hang efforts off a factor directly, once the shape has proven itself here.

CREATE TABLE IF NOT EXISTS counter_efforts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Exactly one of these is set. A requirement-scoped effort answers "who is
    -- working on this missing capability"; a factor-scoped one would answer
    -- "who is working against this force".
    requirement_id UUID REFERENCES requirements(id) ON DELETE CASCADE,
    factor_id      UUID REFERENCES factors(id) ON DELETE CASCADE,

    -- Who: an organisation, programme, project or research group.
    name           TEXT NOT NULL,
    -- What they are doing about it, in the source's terms.
    description    TEXT NOT NULL,
    -- Where it has got to: research / pilot / deploying / operating / unclear.
    -- Free text rather than an enum, because maturity vocabulary varies by field
    -- and forcing it into fixed buckets would mean inventing the mapping.
    stage          TEXT,

    -- Provenance on the same terms as citations: a real URL and the verbatim
    -- sentence this was read from. A row without them is not admitted -- an
    -- unsourced list of organisations is a directory of plausible names, which
    -- is worse than an empty section.
    source_url     TEXT NOT NULL,
    publisher      TEXT,
    quote          TEXT NOT NULL,

    -- For dedupe across requirements: the same organisation legitimately
    -- addresses several, and the same width/opclass as everywhere else keeps
    -- the existing k-NN machinery applicable.
    embedding      halfvec(512),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT counter_efforts_scope_check
        CHECK ((requirement_id IS NULL) <> (factor_id IS NULL))
);

-- Fetch the efforts for a requirement.
CREATE INDEX IF NOT EXISTS idx_counter_efforts_requirement
    ON counter_efforts (requirement_id);

CREATE INDEX IF NOT EXISTS idx_counter_efforts_factor
    ON counter_efforts (factor_id);

CREATE INDEX IF NOT EXISTS idx_counter_efforts_embedding
    ON counter_efforts USING hnsw (embedding halfvec_cosine_ops);

-- One effort per name per requirement, so a re-run refines rather than
-- accumulating near-duplicates of the same organisation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_efforts_identity
    ON counter_efforts (
        COALESCE(requirement_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(factor_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(name)
    );

DROP TRIGGER IF EXISTS trg_counter_efforts_touch_updated_at ON counter_efforts;

-- search_path pinned, per migration 009.
CREATE OR REPLACE FUNCTION tc_counter_efforts_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_counter_efforts_touch_updated_at
    BEFORE UPDATE ON counter_efforts
    FOR EACH ROW EXECUTE FUNCTION tc_counter_efforts_touch_updated_at();
