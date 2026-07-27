-- Every counter-effort candidate the researcher saw, admitted or rejected.
--
-- Exists so a gating decision can be REVISITED WITHOUT RE-CRAWLING. Retrieval is
-- the expensive half of this pipeline; the judgement about what to admit is
-- cheap and will be tuned repeatedly. Keeping only the survivors meant every
-- threshold change cost a full re-crawl.
--
-- The log is not a substitute, which is the lesson that produced this table: a
-- rejection line carries a publisher, a score and a name truncated to 40
-- characters. It has no URL, no quote and no description — so replaying one
-- would mean inventing exactly the fields that make an effort citable. Storing
-- the candidate turns a re-crawl into a SQL update.
--
-- BOTH AXES are kept, not the combined score. They answer different questions —
-- credibility is about the publisher, support is about whether the quote names
-- this organisation at all — and a future gate may want to move one and not the
-- other. Storing only the blend would discard the distinction it needs.

CREATE TABLE IF NOT EXISTS counter_effort_candidates (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Mirrors counter_efforts: exactly one scope, same CHECK.
    requirement_id UUID REFERENCES requirements(id) ON DELETE CASCADE,
    factor_id      UUID REFERENCES factors(id) ON DELETE CASCADE,

    name           TEXT NOT NULL,
    description    TEXT NOT NULL,
    stage          TEXT,
    source_url     TEXT NOT NULL,
    publisher      TEXT,
    quote          TEXT NOT NULL,

    credibility    REAL NOT NULL,
    support        REAL NOT NULL,
    /** Did it clear the gate in force at the time it was seen? */
    admitted       BOOLEAN NOT NULL,

    seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT counter_effort_candidates_scope_check
        CHECK ((requirement_id IS NULL) <> (factor_id IS NULL))
);

-- The replay query: "what did we reject that a new gate would now admit?"
CREATE INDEX IF NOT EXISTS idx_cec_admitted
    ON counter_effort_candidates (admitted, credibility, support);

CREATE INDEX IF NOT EXISTS idx_cec_requirement
    ON counter_effort_candidates (requirement_id);

CREATE INDEX IF NOT EXISTS idx_cec_factor
    ON counter_effort_candidates (factor_id);

-- One row per candidate per subject, so a re-run refreshes its scores rather
-- than stacking duplicates of the same organisation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cec_identity
    ON counter_effort_candidates (
        COALESCE(requirement_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(factor_id, '00000000-0000-0000-0000-000000000000'::uuid),
        lower(name)
    );
