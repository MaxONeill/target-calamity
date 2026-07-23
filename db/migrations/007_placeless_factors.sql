-- Allows a factor to have no location.
--
-- Some factors are genuinely placeless — global income concentration has no
-- centroid, and forcing one onto it put every such factor at (0,0), which is a
-- real place in the Gulf of Guinea. That both fabricated a location and piled
-- their combined charge into a single artificial hotspot.
--
-- NULL lat/lon now means "this factor has no location". Such factors are shown
-- on the global ring rather than as pins, and are excluded from the field bake
-- while still counting toward the Clock aggregate.
--
-- The existing range CHECKs already pass on NULL, so they are left as they are.
-- `geog` is GENERATED from (lon, lat) and ST_MakePoint returns NULL for NULL
-- input, so a placeless factor gets a NULL geog automatically. Viewport queries
-- must therefore test `geog IS NULL OR ST_Intersects(...)`: a factor that is
-- nowhere in particular can never be out of view.

ALTER TABLE factors ALTER COLUMN lat DROP NOT NULL;
ALTER TABLE factors ALTER COLUMN lon DROP NOT NULL;

-- Both or neither: a half-located factor is not a meaningful state, and would
-- silently produce a NULL geog while still looking located to the type system.
ALTER TABLE factors
  ADD CONSTRAINT factors_location_complete
  CHECK ((lat IS NULL) = (lon IS NULL));

-- Partial index for the field query, which selects only located factors.
CREATE INDEX IF NOT EXISTS idx_factors_located
  ON factors ((ABS(effect * significance)) DESC, id ASC)
  WHERE lat IS NOT NULL;
