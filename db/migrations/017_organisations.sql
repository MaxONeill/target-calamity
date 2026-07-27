-- Counter-efforts become ORGANISATIONS with one identity each, cross-linked to
-- everything they address.
--
-- `counter_efforts` stored a row per (target, organisation), so the Coral Reef
-- Alliance existed three times with three ids and three embeddings, and nothing
-- in the data said they were the same body. A reader could not see that one
-- organisation works across several thresholds, which is exactly the signal a
-- router should surface.
--
-- WHY AN ORGANISATION IS NOT A FACTOR. A factor carries `effect` and
-- `significance` and moves the Clock. An organisation has no defensible values
-- for either: nobody publishes how many years NOAA's reef programme shifts the
-- reef threshold, so the number would be invented. Worse, if existence moved the
-- countdown, the countdown would become a function of HOW HARD WE SEARCHED —
-- research more organisations, gain more years, with nothing changed in the
-- world. And the Clock already counts this work once, through the measured
-- outcomes that are factors ("Climate finance goal exceeded").
--
-- Efforts reach the Clock through `relation = 'produced'` instead: a measurable,
-- dated RESULT is ingested as an ordinary factor, earns its effect and
-- significance from published evidence like any other, and is linked back to the
-- organisation that produced it. So the Clock responds to what an effort has
-- achieved, and cannot be inflated by an organisation that exists and achieves
-- nothing.

CREATE TABLE IF NOT EXISTS organisations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    /** How far along, in a source's words. Free text; vocabulary varies by field. */
    stage       TEXT,
    /** For dedupe when the same body is found again under another name form. */
    embedding   halfvec(512),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per name. This is what `counter_efforts` lacked.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organisations_name ON organisations (lower(name));

CREATE INDEX IF NOT EXISTS idx_organisations_embedding
    ON organisations USING hnsw (embedding halfvec_cosine_ops);

/**
 * What an organisation has to do with a factor or a requirement.
 *
 *   addresses — works on this problem / this missing capability. Reporting, not
 *               a claim of impact, and it never touches the Clock.
 *   produced  — this factor is a MEASURED outcome of that organisation's work.
 *               The factor moves the Clock on its own published evidence; the
 *               link only records who is behind it.
 */
CREATE TABLE IF NOT EXISTS organisation_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

    -- Exactly one target.
    factor_id       UUID REFERENCES factors(id) ON DELETE CASCADE,
    requirement_id  UUID REFERENCES requirements(id) ON DELETE CASCADE,

    relation        TEXT NOT NULL DEFAULT 'addresses'
                    CHECK (relation IN ('addresses', 'produced')),

    -- Provenance is per LINK, not per organisation: the source that says this
    -- body works on THIS threshold is a different citation from the one that
    -- says it works on another. Collapsing them onto the organisation would
    -- leave every link pointing at whichever page was found first.
    source_url      TEXT NOT NULL,
    publisher       TEXT,
    quote           TEXT NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT organisation_links_scope_check
        CHECK ((factor_id IS NULL) <> (requirement_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organisation_links_identity
    ON organisation_links (
        organisation_id,
        COALESCE(factor_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(requirement_id, '00000000-0000-0000-0000-000000000000'::uuid),
        relation
    );

CREATE INDEX IF NOT EXISTS idx_organisation_links_factor ON organisation_links (factor_id);
CREATE INDEX IF NOT EXISTS idx_organisation_links_requirement
    ON organisation_links (requirement_id);
CREATE INDEX IF NOT EXISTS idx_organisation_links_org ON organisation_links (organisation_id);

DROP TRIGGER IF EXISTS trg_organisations_touch_updated_at ON organisations;

-- search_path pinned, per migration 009.
CREATE OR REPLACE FUNCTION tc_organisations_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_organisations_touch_updated_at
    BEFORE UPDATE ON organisations
    FOR EACH ROW EXECUTE FUNCTION tc_organisations_touch_updated_at();

/* ------------------------------------------------------------------------- */
/* Migrate counter_efforts -> organisations + organisation_links              */
/* ------------------------------------------------------------------------- */

-- One organisation per distinct name. Where the same body was stored several
-- times, the longest description wins: it is the one that actually says what
-- they do, rather than the terse variant a second page happened to yield.
INSERT INTO organisations (name, description, stage, embedding)
SELECT DISTINCT ON (lower(ce.name))
       ce.name,
       ce.description,
       ce.stage,
       ce.embedding
  FROM counter_efforts ce
 ORDER BY lower(ce.name), length(ce.description) DESC, ce.created_at
ON CONFLICT DO NOTHING;

-- Every original row becomes a link, keeping its own source and quote.
INSERT INTO organisation_links
       (organisation_id, factor_id, requirement_id, relation, source_url, publisher, quote, created_at)
SELECT o.id, ce.factor_id, ce.requirement_id, 'addresses',
       ce.source_url, ce.publisher, ce.quote, ce.created_at
  FROM counter_efforts ce
  JOIN organisations o ON lower(o.name) = lower(ce.name)
ON CONFLICT DO NOTHING;

-- Superseded. The candidate store (counter_effort_candidates) is deliberately
-- KEPT: it is what makes a gate change replayable without re-crawling, and it
-- records rejections that have no organisation row by design.
DROP TABLE IF EXISTS counter_efforts;
