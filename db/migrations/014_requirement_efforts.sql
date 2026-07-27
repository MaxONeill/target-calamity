-- Route requirements to the counter-efforts already being tracked.
--
-- The contingency tree says what reversing a crossed threshold would take. Its
-- leaves -- "scalable climate-resilient restoration", "roughly halving global
-- emissions" -- are the actionable end of the product, and the factor set
-- ALREADY contains Humanity factors describing work on exactly those things.
-- Until now those factors were only weight in an aggregate. This is the join
-- that turns a detector into a router.
--
-- Many-to-many on purpose: one requirement can have several efforts behind it,
-- and one effort can address several requirements across different chains.
--
-- WHAT A ROW MEANS, and does not: this is a SEMANTIC match between a
-- requirement's wording and a factor's, not a claim that the factor satisfies
-- the requirement. `distance` is kept so a reader can see how close the match
-- actually was, and the UI must present these as related work rather than as
-- solutions. Overstating that link would be the same failure as an invented
-- dependency, dressed as helpfulness.

CREATE TABLE IF NOT EXISTS requirement_efforts (
    requirement_id UUID NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
    factor_id      UUID NOT NULL REFERENCES factors(id) ON DELETE CASCADE,

    -- Exact cosine distance at match time. Stored rather than recomputed so the
    -- match is auditable after the fact, and so a later change to the ceiling is
    -- visible as a change rather than silently re-deciding history.
    distance       REAL NOT NULL,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (requirement_id, factor_id)
);

-- Fetch every effort for a requirement, closest first.
CREATE INDEX IF NOT EXISTS idx_requirement_efforts_requirement
    ON requirement_efforts (requirement_id, distance);

-- The reverse question: which requirements does this effort address? That is
-- the view that makes a counter-effort legible as leverage rather than as one
-- more item in a feed.
CREATE INDEX IF NOT EXISTS idx_requirement_efforts_factor
    ON requirement_efforts (factor_id);
