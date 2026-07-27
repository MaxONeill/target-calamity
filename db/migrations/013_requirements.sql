-- Contingency chains: what it would actually take to reverse a crossed threshold.
--
-- A flat "requires atmospheric CO2 below 450 ppm" is a dead end for a reader.
-- The chain is the useful part:
--
--   reverse warm-water reef loss
--     -> requires CO2 below 450-500 ppm
--        -> requires sustained net-negative emissions
--           -> requires carbon removal at gigatonne scale  [status: partial]
--
-- Each link is a CITED claim, never the model's own reasoning. Dependency chains
-- are the most fabrication-prone output in this system: a model will produce a
-- fluent, plausible, entirely invented chain faster than anything else, and a
-- wrong link is hard to spot because it reads like engineering. So an edge
-- exists only where a retrieved source states it, with a verbatim quote, through
-- the same reputability gate as every other claim.
--
-- A leaf with status 'unknown' is therefore a FEATURE. It marks the point where
-- no source describes what comes next -- which is exactly the thing that needs
-- inventing, and far more useful than a manufactured next step.

CREATE TABLE IF NOT EXISTS requirements (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- The threshold this chain is rooted at. Denormalised onto every node, not
    -- just the root, so fetching a whole tree is one indexed read.
    factor_id   UUID NOT NULL REFERENCES factors(id) ON DELETE CASCADE,

    -- NULL on a root node (depth 0), which states what reversing the threshold
    -- itself requires.
    parent_id   UUID REFERENCES requirements(id) ON DELETE CASCADE,

    -- What is needed, in the source's own terms.
    statement   TEXT NOT NULL,

    -- Where this stands today:
    --   exists  - available now at the scale required
    --   partial - exists, but not at the scale or cost required
    --   absent  - does not exist; would have to be developed
    --   unknown - no source describes its status. Also the terminal marker when
    --             nothing states what this requirement in turn depends on.
    status      TEXT NOT NULL DEFAULT 'unknown',

    -- 0 at the root. Capped by the expansion pass, not by the schema, so the cap
    -- can change without a migration.
    depth       INT NOT NULL DEFAULT 0,

    -- Provenance, on the same terms as citations: a real URL and the verbatim
    -- sentence the link was read from. A node without these is not admitted.
    source_url  TEXT,
    publisher   TEXT,
    quote       TEXT,
    -- Shown to the reader, not merely logged -- the chain is the argument, so
    -- each step has to justify itself in plain language.
    reasoning   TEXT,

    -- Same width and opclass as factors.embedding, so the existing k-NN
    -- machinery applies unchanged. Two uses: collapsing near-identical
    -- requirements across different chains, and matching a requirement to the
    -- Humanity factors already tracked that address it.
    embedding   halfvec(512),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT requirements_status_check
        CHECK (status IN ('exists', 'partial', 'absent', 'unknown')),
    -- A root has no parent and a non-root does; nothing else is a valid tree.
    CONSTRAINT requirements_root_check
        CHECK ((depth = 0) = (parent_id IS NULL))
);

-- Whole-tree fetch for one threshold, in reading order.
CREATE INDEX IF NOT EXISTS idx_requirements_factor
    ON requirements (factor_id, depth, id);

-- Child lookup during expansion.
CREATE INDEX IF NOT EXISTS idx_requirements_parent
    ON requirements (parent_id);

-- k-NN over requirement statements. Mirrors the factors index.
CREATE INDEX IF NOT EXISTS idx_requirements_embedding
    ON requirements USING hnsw (embedding halfvec_cosine_ops);

-- One statement per parent, so a re-run refines rather than duplicating a chain.
-- COALESCE because NULL never equals NULL in a unique index, and roots have no
-- parent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_requirements_identity
    ON requirements (factor_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(statement));

DROP TRIGGER IF EXISTS trg_requirements_touch_updated_at ON requirements;

-- search_path pinned, per migration 009: pg_restore runs with search_path = ''
-- and an unqualified reference would fail there.
CREATE OR REPLACE FUNCTION tc_requirements_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_requirements_touch_updated_at
    BEFORE UPDATE ON requirements
    FOR EACH ROW EXECUTE FUNCTION tc_requirements_touch_updated_at();
