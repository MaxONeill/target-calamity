-- Pin search_path on the trigger functions from 001_init.sql.
--
-- As written they referenced `factor_revisions` and `factors` unqualified and
-- carried no search_path of their own, so they resolved correctly only when the
-- CALLER's search_path happened to include `public`. That is not something a
-- trigger can assume:
--
--   pg_restore runs its session with `search_path = ''` (it schema-qualifies
--   everything it emits). Loading a data-only dump therefore fired
--   tc_factors_write_genesis_revision, which failed with
--   `relation "factor_revisions" does not exist`, aborting the COPY into
--   factors and cascading into FK violations on citations and
--   factor_revisions. Restoring a dump into a fresh environment was impossible
--   without --disable-triggers.
--
-- Attaching `SET search_path` makes resolution a property of the function
-- rather than of whoever happens to call it. It also closes the standard
-- search-path capture vector, where an object in an earlier schema shadows the
-- intended table or operator.
--
-- tc_factors_touch_updated_at references no table, but is pinned too so the
-- rule is uniform: every trigger function here resolves names for itself.
-- pg_catalog is always implicitly searched, so NOW() and friends are unaffected.
--
-- CREATE OR REPLACE FUNCTION only locks the function, not the tables, so this is
-- safe to apply to a live database. Bodies are otherwise byte-identical to
-- 001_init.sql — only the search_path attribute is added.

CREATE OR REPLACE FUNCTION tc_factors_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tc_factors_write_genesis_revision() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    INSERT INTO factor_revisions (factor_id, effect, significance, revision_reason, changed_at)
    VALUES (NEW.id, NEW.effect, NEW.significance, 'insert', NEW.created_at);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION tc_apply_revision_to_projection() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
    IF NEW.revision_reason <> 'insert' THEN
        UPDATE factors
           SET effect = NEW.effect,
               significance = NEW.significance
         WHERE id = NEW.factor_id;
    END IF;
    RETURN NULL;  -- AFTER trigger: return value ignored
END;
$$;
