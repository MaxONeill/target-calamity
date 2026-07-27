-- Replace the factor set with db/seed-data.sql.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/apply-seed-data.sql
--
-- DESTRUCTIVE. It empties factors, citations, factor_revisions and projections
-- before loading. Take a backup first:
--
--   pg_dump "$DATABASE_URL" -Fc --no-owner -f before.dump
--
-- Why replace rather than merge. The seed's INSERTs cannot update a row that is
-- already there, so on a database that already holds the factors — production,
-- after any earlier restore — a merge silently keeps every stale significance,
-- every missing closesWindow judgement, and every un-dated threshold. The whole
-- point of re-seeding is the re-scoring, which a merge discards.
--
-- What is NOT touched: submissions, banned_submitters, ingestion_quarantine and
-- schema_migrations. Submissions are user-contributed and irreplaceable; the
-- ledger belongs to the migration runner. Only the four tables the pipeline
-- owns are replaced.
--
-- session_replication_role = replica does two necessary things for a bulk load:
--
--   1. Disables triggers. factors carries an AFTER INSERT trigger that writes a
--      genesis row into factor_revisions, and the seed already contains those
--      rows — without this, every revision is duplicated.
--   2. Disables FK checks, so citations may load before their factors rather
--      than forcing the seed into dependency order.
--
-- Requires superuser (the Postgres role Railway provisions is one).
--
-- One transaction: a failure mid-load rolls back to the previous set rather
-- than leaving the field half-empty and the Clock anchored on a fragment.

BEGIN;

SET session_replication_role = replica;

-- Every table the pipeline owns. counter_efforts and requirements are listed
-- explicitly rather than left to CASCADE: they would be cleared anyway as
-- children of factors, but naming them keeps this list a readable statement of
-- what the reload replaces, and a table added later that is NOT a child of
-- factors would otherwise be silently missed.
-- counter_efforts is GONE: migration 017 replaced it with organisations +
-- organisation_links. Naming a dropped table here is not a harmless leftover —
-- TRUNCATE fails on it, and the failure lands after BEGIN, so the whole reload
-- aborts. Both new tables must be listed or the reload leaves stale
-- organisations pointing at factors that no longer exist.
TRUNCATE TABLE public.citations, public.factor_revisions, public.factors,
               public.projections, public.requirements, public.requirement_efforts,
               public.counter_effort_candidates,
               public.organisations, public.organisation_links;

\i db/seed-data.sql

SET session_replication_role = DEFAULT;

COMMIT;

-- Confirm what landed. A row count is not enough: the anchors are what the
-- countdown rests on, and a load that produced factors but no closesWindow
-- judgements would suppress the Clock while looking successful.
SELECT
  (SELECT count(*) FROM public.factors)      AS factors,
  (SELECT count(*) FROM public.citations)    AS citations,
  (SELECT count(*) FROM public.projections)  AS projections,
  (SELECT count(*) FROM public.factors
    WHERE tipping_point->>'closesWindow' = 'true')       AS anchors,
  (SELECT count(*) FROM public.factors
    WHERE significance_scale IS NOT NULL)                AS scored,
  -- The routing surface. `orgs` at 0 with factors loaded means the reload
  -- landed but the organisation tables did not, which shows up in the UI as
  -- "no effort found addressing this" on every factor — a wrong finding, not a
  -- blank space, so it is worth catching here rather than in the browser.
  -- `links` matters separately: organisations with no links are unreachable,
  -- which reads identically in the UI.
  (SELECT count(*) FROM public.organisations)            AS orgs,
  (SELECT count(*) FROM public.organisation_links)       AS links,
  (SELECT count(*) FROM public.requirements)             AS requirements,
  (SELECT count(*) FROM public.counter_effort_candidates) AS candidates,
  -- Placement (018). `placed` counts pins; `representative` counts the ones we
  -- chose rather than a source measuring. A load that lost location_kind would
  -- show placed = 0 and an empty globe.
  (SELECT count(*) FROM public.factors WHERE lat IS NOT NULL)  AS placed,
  (SELECT count(*) FROM public.factors
    WHERE location_kind = 'representative')              AS representative,
  (SELECT last_value FROM public.factors_seq_seq)        AS seq_last;
