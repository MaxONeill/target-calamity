/**
 * The one rule that turns coordinates into a placement kind.
 *
 * Migration 018 added `factors.location_kind` and, with it, a constraint that
 * makes a coordinate without a kind unwritable:
 *
 *     CHECK ((lat IS NULL) = (location_kind IS NULL))
 *
 * Every writer therefore has to answer "what KIND of point is this?" — and both
 * ingestion writers were shipped before the column existed, so neither did.
 * The result was not a subtle drift: from the commit that added 018, ANY
 * ingested factor carrying coordinates failed to insert. It went unnoticed only
 * because the offline tests write to the in-memory repository, which has no
 * constraints, so nothing exercised the real SQL against the real schema.
 *
 * WHY `measured` IS THE HONEST ANSWER HERE, and not a guess. Migration 018
 * backfilled the existing rows with exactly this rule —
 *
 *     -- Everything already carrying coordinates came from a source that placed it.
 *     UPDATE factors SET location_kind = 'measured' WHERE lat IS NOT NULL …
 *
 * — and the extractor's contract agrees: `lat` is "WGS84 degrees, or null when
 * the factor is genuinely placeless" (see `NewFactorInput`). The pipeline emits
 * a coordinate only when a source placed the thing, which is what `measured`
 * means. So this introduces no new editorial judgement; it applies the one
 * already made, at the point of writing rather than in a one-off backfill.
 *
 * WHAT THIS DELIBERATELY CANNOT PRODUCE is `representative`. A representative
 * point is OUR choice about where to draw a distributed phenomenon, it requires
 * a `location_note` explaining that choice to the reader, and deciding it needs
 * a prompt built around REFUSING to place things. That is
 * `backfillLocations.ts`, and it must stay there: an ingestion path that quietly
 * invented representative points would be exactly the fabrication 018 exists to
 * prevent. The two compose — this places what a source placed, the backfill
 * later offers points for what it did not, and `FORCE never re-places a
 * measured factor` keeps the boundary.
 */
import type { LocationKind } from '../../shared/types.js';

/**
 * The placement kind implied by a coordinate: `measured` when there is one,
 * `null` when the factor is placeless. Both writers call this rather than
 * repeating the ternary — a second copy is how the two drift apart, which is
 * the shape of the bug this replaces.
 */
export function locationKindFor(lat: number | null): LocationKind | null {
  return lat === null ? null : 'measured';
}
