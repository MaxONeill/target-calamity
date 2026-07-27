-- Distinguish a MEASURED location from a REPRESENTATIVE one.
--
-- 78 of 114 verified factors had no coordinates, so the globe showed an absence
-- of research rather than an absence of events. Most of those factors are about
-- somewhere — warm-water coral reefs are not nowhere — but the source stated a
-- phenomenon rather than a point, so nothing could be placed.
--
-- Placing them anyway is only honest if the map says which kind of pin it is.
-- A representative point is OUR editorial choice about where a global
-- phenomenon is best shown; presenting that as though a source measured it
-- there would be exactly the fabrication this system refuses elsewhere. So the
-- kind travels with the coordinates, all the way to the pin:
--
--   measured        the source located it. Full-thickness pin.
--   representative  we chose a point that stands for it, with the reason
--                   recorded in location_note. Rendered visibly thinner.
--   (null)          placeless. No pin at all, which stays a legitimate answer:
--                   "1.9 billion vaccine doses delivered globally" has no
--                   honest point, and inventing one would be worse than a gap.
--
-- Thickness is the right channel because it is the only free one: pin LENGTH
-- already encodes significance and HUE encodes effect, so overloading either
-- would corrupt a reading the globe already makes.

ALTER TABLE factors
    ADD COLUMN IF NOT EXISTS location_kind TEXT
        CHECK (location_kind IN ('measured', 'representative')),
    -- Why this point stands for this phenomenon, in plain words, shown to the
    -- reader. A representative placement without its reasoning is indefensible:
    -- the reader cannot tell an editorial choice from a measurement.
    ADD COLUMN IF NOT EXISTS location_note TEXT;

-- Everything already carrying coordinates came from a source that placed it.
UPDATE factors
   SET location_kind = 'measured'
 WHERE lat IS NOT NULL AND location_kind IS NULL;

-- A kind without a point, or a point without a kind, is a row that will render
-- wrongly one way or the other.
ALTER TABLE factors
    DROP CONSTRAINT IF EXISTS factors_location_kind_check;
ALTER TABLE factors
    ADD CONSTRAINT factors_location_kind_check
        CHECK ((lat IS NULL) = (location_kind IS NULL));

-- The backfill selects on "placed but not yet judged" and on the placeless set.
CREATE INDEX IF NOT EXISTS idx_factors_location_kind
    ON factors (location_kind);
