/**
 * The Clock — derivation model.
 *
 * Neither the product brief nor any source defines what the Clock counts down TO
 * or how the factor set produces a time value, so it is defined here, explicitly
 * and inspectably. The design has three moving parts:
 *
 *   1. ANCHOR — the dated tipping points. Rather than averaging their years (an
 *      average of incommensurable thresholds means nothing), each threshold is a
 *      significance-weighted arrival-time distribution built from its
 *      earliest/central/latest range. Their normalized mixture is a proper CDF
 *      over "when does the polycrisis cross a point of no return", and the Clock
 *      targets its median — with the interquartile p25–p75 years as an honest
 *      band. Heavier and nearer thresholds dominate by construction.
 *
 *   2. FORCES INTERPOLATE WITHIN THE PUBLISHED RANGE — the other factors are
 *      pressures and counter-forces, not dated thresholds. Each acts only on the
 *      tipping points it is causally linked to, by shared {@link Domain} (see
 *      `shared/domains.ts`): deforestation moves the Amazon threshold, clean
 *      energy moves the climate-driven ones, not the AMOC one directly. Crucially,
 *      the net force does NOT bend a threshold by some invented amount — it moves
 *      the best estimate WITHIN the threshold's own published uncertainty band.
 *      Full net Calamity pulls the estimate to the earliest published year, full
 *      net Humanity to the latest; a balanced or thinly-evidenced set barely
 *      moves it. So the maximum a factor can shift a date is the science's own
 *      stated uncertainty — there is no free "elasticity" constant to choose, and
 *      the model can never claim a date outside what was published.
 *
 * What this model deliberately does NOT claim: the anchor is a weighted aggregate
 * of published, individually-uncertain estimates; the band is the honest spread,
 * not a precise deadline; and `netPolarity == 0` means "balanced" only when
 * {@link ClockModel.hasEvidence} (never read 0 as balanced without checking it).
 * A threshold that publishes only a central year gets an assumed band derived
 * from its peers (the median published half-width), so even that fallback is
 * data-grounded rather than a tuned constant.
 *
 * `deriveClock` is PURE and deterministic: it reads only its arguments, calls no
 * clock, and emits absolute years. The view converts those to a live countdown,
 * so the model stays unit-testable.
 */
import type { VerificationState } from '../../../shared/types.js';
import { DOMAIN_LABELS, drivingDomains, type Domain } from '../../../shared/domains.js';

/**
 * A dated, (near-)irreversible threshold a factor represents. Optional on a
 * factor — most factors have none. `centralYear` is the best estimate; the
 * optional bounds carry the published uncertainty range.
 */
/**
 * A threshold stated against a measurable quantity rather than a year. Dated by
 * reading a {@link Projection} for the same quantity — see `dateFromProjection`.
 */
export interface QuantityThreshold {
  readonly quantity: string;
  readonly value: number;
  readonly unit: string;
  /** Reference the value is stated against. Must match the projection's. */
  readonly baseline?: string;
  readonly lowValue?: number;
  readonly highValue?: number;
  /**
   * The projection this was matched to, resolved SERVER-side (quantity identity
   * is a semantic problem needing embeddings). When absent the model falls back
   * to an exact quantity+unit match, which is enough for curated data but will
   * miss "global temperature" vs "GMST anomaly".
   */
  readonly projectionId?: string;
}

/** A published trajectory for a quantity. Ascending by year, ≥ 2 points. */
export interface Projection {
  readonly id?: string;
  readonly quantity: string;
  readonly unit: string;
  readonly baseline?: string;
  /** Scenario assumes action beyond what is implemented. Absent → treated true. */
  readonly assumesFutureAction?: boolean;
  readonly points: readonly { readonly year: number; readonly value: number }[];
}

/**
 * What reversing an already-crossed threshold would take.
 *
 * Read from sources, never derived. `timescaleYears` in particular is a
 * published restoration timescale and is never computed from `effort` —
 * converting "requires large-scale carbon removal" into a number of years
 * would be an unsourced figure that reads like a sourced one.
 */
export interface Recovery {
  readonly timescaleYears?: number;
  readonly timescaleLowYears?: number;
  readonly timescaleHighYears?: number;
  readonly effort: string;
  readonly reasoning: string;
  readonly quote: string;
  readonly sourceUrl: string;
  readonly publisher?: string;
}

export interface TippingPoint {
  /** Present when the source published a year. Otherwise dated by quantity. */
  readonly centralYear?: number;
  readonly earliestYear?: number;
  readonly latestYear?: number;
  readonly quantityThreshold?: QuantityThreshold;
  readonly recovery?: Recovery;
  readonly label?: string;
  /**
   * Crossing this ends the possibility of correction. Only these anchor the
   * Clock; see `closesWindow` in shared/schema.ts. Absent → false.
   */
  readonly closesWindow?: boolean;
}

/**
 * Assumed half-width (years) around a `centralYear` used ONLY when NO threshold
 * in the set publishes a range to derive one from. When at least one does, the
 * assumed spread is the median of the published half-widths (see `deriveClock`),
 * so this constant is a last-resort fallback rather than a tuned parameter.
 */
const FALLBACK_SPREAD_YEARS = 10;

/** Weight at which evidence mass reaches 0.5 (saturating: more evidence → →1). */
const EVIDENCE_HALF_SATURATION = 4;

/** Julian year in milliseconds. */
export const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export type ClockConfidence = 'indeterminate' | 'low' | 'moderate' | 'substantial';

/**
 * Minimal input the model needs from a factor. `FieldPin`/`GlobalFactor` satisfy
 * it structurally. `verificationState` absent → contributes; `'pending'` →
 * excluded. `tippingPoint` present → anchors. `domains` absent/empty → systemic.
 */
export interface ClockFactorInput {
  /**
   * The factor's id, so a threshold can be joined to rows keyed on it —
   * contingency chains, in particular. Optional because the aggregation itself
   * never needs it and the tests construct inputs without one.
   */
  readonly id?: string;
  readonly effect: number;
  readonly significance: number;
  readonly verificationState?: VerificationState;
  readonly tippingPoint?: TippingPoint | null;
  readonly domains?: readonly Domain[];
}

/** Net force exerted within one domain (for the Why panel). */
export interface DomainForce {
  readonly domain: Domain | 'systemic';
  readonly label: string;
  /** Significance-weighted mean signed effect in this domain, ∈ [-1, 1]. */
  readonly netForce: number;
  /** Σ significance backing that force. */
  readonly weight: number;
  readonly factorCount: number;
}

/**
 * How a threshold got its year.
 *  - `published`  the source stated a year outright
 *  - `projected`  stated against a quantity, dated from a published projection
 */
export type ThresholdDating = 'published' | 'projected';

/** One threshold's contribution to the anchor, before and after the warp. */
export interface ThresholdContribution {
  /** The factor this came from. Null when the input carried no id. */
  readonly factorId: string | null;
  readonly label: string | null;
  readonly significance: number;
  readonly baselineYear: number;
  readonly warpedYear: number;
  /** Years the force moved it (signed; < 0 = sooner). */
  readonly shiftYears: number;
  readonly drivingDomains: readonly Domain[];
  /**
   * Whether this threshold anchors the countdown, i.e. crossing it closes the
   * course-correction window. Non-anchoring thresholds are still shown — they
   * are real dated evidence — but they do not move the target year.
   */
  readonly anchors: boolean;
  /** Where the year came from. Shown so a reader can audit the derivation. */
  readonly dating: ThresholdDating;
  /** False when forces were withheld to avoid double-counting a scenario. */
  readonly forcesApply: boolean;
  /**
   * Whether this threshold's estimated year is already behind us.
   *
   * Derived from the model's own dates, not from a stored flag, so it stays
   * true to whatever the evidence currently says. It is REPORTING only — a
   * crossed threshold contributes to the countdown exactly as it did before it
   * was crossed. A forecast that jumped because a date it predicted arrived
   * would be a badly calibrated forecast.
   */
  readonly crossed: boolean;
  /** What reversal would take, once crossed. Absent until assessed. */
  readonly recovery: Recovery | null;
}

/** Interquartile band of the arrival-time mixture. */
export interface ClockBand {
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
}

/** Fully-derived Clock state. Every field is inspectable by the UI. */
export interface ClockModel {
  readonly contributingCount: number;
  readonly pendingCount: number;
  readonly rejectedCount: number;

  readonly totalSignificance: number;
  readonly calamityLoad: number;
  readonly humanityBuffer: number;

  readonly netPolarity: number;
  readonly hasEvidence: boolean;

  /* --------------------------- tipping-point anchor ----------------------- */
  /** Window-closing thresholds — what the countdown actually rests on. */
  readonly tippingPointCount: number;
  /** Every dated threshold in view, anchoring or not. Always ≥ the above. */
  readonly datedThresholdCount: number;
  /**
   * Anchors whose estimated year is already behind us.
   *
   * Reported so the UI can state plainly what has been passed and what
   * reversing it would take. It does not enter the countdown: see
   * `referenceYear` on {@link deriveClock}.
   */
  readonly crossedCount: number;
  readonly hasBaseline: boolean;
  /** Median of the UN-warped first-crossing distribution, or null. */
  readonly baselineTargetYear: number | null;
  readonly baselineEarliestYear: number | null;
  readonly baselineLatestYear: number | null;

  /* ------------------------------ warped target --------------------------- */
  /** Net years the forces moved the median (signed; < 0 = sooner). */
  readonly shiftYears: number;
  /** Median of the warped arrival mixture. Absolute year, or null. */
  readonly targetYear: number | null;
  /** Interquartile band of the warped mixture (the honest range), or null. */
  readonly band: ClockBand | null;

  /* ------------------------------- derivation ----------------------------- */
  /** Net force per domain, sorted by influence — the modifiers, explained. */
  readonly domainForces: readonly DomainForce[];
  /** Each anchor threshold and how the forces moved it. */
  readonly thresholds: readonly ThresholdContribution[];
  /**
   * The assumed half-width (years) applied to thresholds that published only a
   * central year — the median of the peer half-widths, or the fallback constant
   * when none published a range. Null when every threshold carried its own range.
   */
  readonly assumedSpreadYears: number | null;

  readonly confidence: ClockConfidence;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function confidenceForCount(count: number): ClockConfidence {
  if (count <= 0) return 'indeterminate';
  if (count < 5) return 'low';
  if (count < 20) return 'moderate';
  return 'substantial';
}

/* -------------------------------------------------------------------------- */
/* Arrival-time distribution math (pure)                                      */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Dating a quantity threshold from a published projection                    */
/* -------------------------------------------------------------------------- */

/** Loose key for the fallback match. Server-side resolution is semantic. */
function quantityKey(quantity: string, unit: string): string {
  return `${quantity.trim().toLowerCase()}|${unit.trim().toLowerCase()}`;
}

/**
 * Find the projection a quantity threshold should be read against.
 *
 * Prefers the server-resolved `projectionId`. The string fallback is
 * deliberately STRICT — exact quantity and unit after casing/space
 * normalisation — because a loose match here is not a missing anchor, it is a
 * confidently wrong year. Baselines must agree too: "1.5 degC above
 * pre-industrial" and "1.5 degC above 1986-2005" are the same quantity and unit
 * roughly 0.6 degC apart, so a mismatch (or an unknown on either side) refuses.
 */
function findProjection(
  threshold: QuantityThreshold,
  projections: readonly Projection[],
): Projection | null {
  if (threshold.projectionId !== undefined) {
    const byId = projections.find((p) => p.id === threshold.projectionId);
    if (!byId) return null;
    return baselinesAgree(threshold.baseline, byId.baseline) ? byId : null;
  }
  const key = quantityKey(threshold.quantity, threshold.unit);
  const match = projections.find((p) => quantityKey(p.quantity, p.unit) === key);
  if (!match) return null;
  return baselinesAgree(threshold.baseline, match.baseline) ? match : null;
}

/**
 * Both stated and equal (case/space-insensitive), or both genuinely absent.
 * An unknown baseline on either side refuses: a threshold nobody anchored to a
 * reference cannot be safely read against a curve that has one.
 */
function baselinesAgree(a: string | undefined, b: string | undefined): boolean {
  const norm = (s: string | undefined): string | null => {
    const t = s?.trim().toLowerCase();
    return t === undefined || t === '' ? null : t;
  };
  const left = norm(a);
  const right = norm(b);
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return left === right;
}

/**
 * The year a projection first reaches `value`, by linear interpolation between
 * the two bracketing points.
 *
 * Handles both directions: a rising quantity (warming, CO2) is crossed from
 * below, a falling one (ocean pH, ice extent) from above. Returns null when the
 * curve never reaches the value within its published span — extrapolating past
 * the last point would be inventing a year, which is the one thing this model
 * refuses to do.
 */
export function dateFromProjection(projection: Projection, value: number): number | null {
  const pts = [...projection.points]
    .filter((p) => Number.isFinite(p.year) && Number.isFinite(p.value))
    .sort((a, b) => a.year - b.year);
  if (pts.length < 2) return null;

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const lo = Math.min(prev.value, cur.value);
    const hi = Math.max(prev.value, cur.value);
    if (value < lo || value > hi) continue;

    const span = cur.value - prev.value;
    // A flat segment straddling the value: it is reached at the segment start.
    if (span === 0) return prev.year;
    const t = (value - prev.value) / span;
    return prev.year + t * (cur.year - prev.year);
  }
  return null;
}

/** A threshold reduced to years, however it was originally stated. */
interface DatedThreshold {
  central: number;
  earliest: number | undefined;
  latest: number | undefined;
  dating: ThresholdDating;
  forcesApply: boolean;
}

/**
 * Reduce a tipping point to calendar years.
 *
 * A published year is used as-is. A quantity threshold is dated by reading its
 * projection, and its published value range (`lowValue`/`highValue`) is dated
 * the same way, so the uncertainty carried into the Clock is the SOURCE's
 * uncertainty rather than an assumed spread.
 *
 * Note the bound ordering: on a falling quantity (ocean pH, ice extent) a lower
 * threshold value is reached LATER, so the dated bounds arrive reversed and are
 * sorted rather than assumed.
 *
 * Returns null when the threshold cannot be dated honestly — no matching
 * projection, disagreeing baselines, or a curve that never reaches the value
 * inside its published span. A threshold that cannot be dated is dropped, never
 * estimated.
 */
function dateThreshold(
  tp: TippingPoint,
  projections: readonly Projection[],
): DatedThreshold | null {
  if (Number.isFinite(tp.centralYear)) {
    const central = tp.centralYear as number;
    return {
      central,
      earliest: Number.isFinite(tp.earliestYear ?? NaN)
        ? Math.min(tp.earliestYear as number, central)
        : undefined,
      latest: Number.isFinite(tp.latestYear ?? NaN)
        ? Math.max(tp.latestYear as number, central)
        : undefined,
      dating: 'published',
      // A directly published year embeds no scenario, so nothing is duplicated.
      forcesApply: true,
    };
  }

  const qt = tp.quantityThreshold;
  if (!qt || !Number.isFinite(qt.value)) return null;

  const projection = findProjection(qt, projections);
  if (!projection) return null;

  const central = dateFromProjection(projection, qt.value);
  if (central === null) return null;

  const bounds = [qt.lowValue, qt.highValue]
    .filter((v): v is number => Number.isFinite(v ?? NaN))
    .map((v) => dateFromProjection(projection, v))
    .filter((y): y is number => y !== null)
    .sort((a, b) => a - b);

  return {
    central,
    earliest: bounds.length > 0 ? Math.min(bounds[0]!, central) : undefined,
    latest: bounds.length > 0 ? Math.max(bounds[bounds.length - 1]!, central) : undefined,
    dating: 'projected',
    // Absent → treated as assuming future action. An unlabelled scenario cannot
    // be shown to be assumption-free, and guessing permissively is what makes
    // the Clock read later than any source supports.
    forcesApply: projection.assumesFutureAction === false,
  };
}

/** Triangular CDF with support [a, b] and mode c. Robust at the c=a / c=b edges. */
function triangularCdf(y: number, a: number, c: number, b: number): number {
  if (b <= a) return y >= a ? 1 : 0;
  const mode = clamp(c, a, b);
  if (y <= a) return 0;
  if (y >= b) return 1;
  if (y < mode) return ((y - a) * (y - a)) / ((b - a) * (mode - a));
  if (y > mode) return 1 - ((b - y) * (b - y)) / ((b - a) * (b - mode));
  return (mode - a) / (b - a);
}

interface ArrivalDist {
  a: number;
  c: number;
  b: number;
  /**
   * Probability this threshold is real and relevant — the factor's significance,
   * read in its natural [0, 1] sense. NOT a normalized mixture weight: each
   * threshold is an independent way for the window to close, not a share of one.
   */
  p: number;
}

/**
 * CDF of the FIRST crossing among the anchors:
 *
 *     F(y) = 1 − Π (1 − pᵢ · Fᵢ(y))
 *
 * The window closes when the earliest window-closing threshold is crossed, not
 * when some average of them is. That distinction is the whole point of this
 * model: a median over catalogued thresholds has no referent — nobody
 * experiences "the median tipping point" — whereas "the first crossing after
 * which correction no longer restores the system" is a claim you can defend in
 * a sentence and audit against sources.
 *
 * It also behaves correctly under new evidence. Finding a LATER threshold barely
 * moves the estimate; finding an EARLIER one pulls it in, which is exactly when
 * a course-correction horizon should move. A weighted median instead lurched
 * whenever an anchor entered or left, because it hopped between clusters.
 *
 * ASSUMPTION: independence. Real thresholds are positively correlated, and
 * correlation makes the true first crossing LATER than this. The model is
 * therefore biased early — the conservative direction for a planning horizon,
 * but a real limitation and not to be presented as neutral.
 */
function firstCrossingCdf(dists: readonly ArrivalDist[], y: number): number {
  let survival = 1;
  for (const d of dists) survival *= 1 - d.p * triangularCdf(y, d.a, d.c, d.b);
  return 1 - survival;
}

/**
 * Ceiling of {@link firstCrossingCdf} as y → ∞. Below 1 whenever any anchor is
 * less than fully significant: thin evidence cannot assert certainty.
 */
function firstCrossingCeiling(dists: readonly ArrivalDist[]): number {
  let survival = 1;
  for (const d of dists) survival *= 1 - d.p;
  return 1 - survival;
}

/**
 * Invert the first-crossing CDF at `level`.
 *
 * Returns null when the curve never reaches `level` — the evidence does not
 * support asserting the window has closed by ANY year at that confidence. The
 * countdown then suppresses rather than naming a year it cannot support, which
 * is the same rule as having no anchors at all, arrived at by the math instead
 * of by a special case.
 */
function firstCrossingQuantile(dists: readonly ArrivalDist[], level: number): number | null {
  if (dists.length === 0) return null;
  if (firstCrossingCeiling(dists) < level) return null;

  let lo = Infinity;
  let hi = -Infinity;
  for (const d of dists) {
    if (d.a < lo) lo = d.a;
    if (d.b > hi) hi = d.b;
  }
  if (!Number.isFinite(lo)) return null;
  if (hi <= lo) return lo;

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (firstCrossingCdf(dists, mid) < level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* -------------------------------------------------------------------------- */

interface Accumulator {
  weight: number;
  weightedEffect: number;
  count: number;
}

interface ThresholdRaw {
  factorId: string | null;
  label: string | null;
  significance: number;
  central: number;
  /** Published bounds, undefined when the source gave only a central year. */
  earliestPub: number | undefined;
  latestPub: number | undefined;
  domains: readonly Domain[];
  /** Anchors the countdown. Absent on the source data → false. */
  closesWindow: boolean;
  /** "1.5 degC — global warming", when the threshold was stated that way. */
  quantityLabel: string | null;
  /** Carried through for reporting. Never consulted by the countdown math. */
  recovery: Recovery | null;
  /** How the year was obtained — surfaced so the derivation stays inspectable. */
  dating: ThresholdDating;
  /**
   * False when the projection that dated this threshold already assumes future
   * action. Forces must not bend such a curve: a mitigation pathway has the
   * clean-energy expansion baked in, so pushing it further with a clean-energy
   * factor counts the same action twice.
   */
  forcesApply: boolean;
}

/** Median of a non-empty list (linear-interpolated). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Derive the Clock state from a factor set. Pure and total: any input (empty,
 * all-pending, poison values, no tipping points) yields a well-defined
 * {@link ClockModel} — `hasBaseline === false` / `targetYear === null` rather
 * than a NaN or throw.
 */
export function deriveClock(
  factors: readonly ClockFactorInput[],
  projections: readonly Projection[] = [],
  /**
   * The year "now", used ONLY to report which thresholds are already behind us.
   *
   * Passed in rather than read from the clock so this function stays pure —
   * same inputs, same output — which is what makes the aggregation testable and
   * what `targetDeadlineMs` already assumes by taking "now" at the edge.
   *
   * It is deliberately not consulted by any of the countdown math. A crossed
   * threshold contributes to the target exactly as it did the day before it was
   * crossed; a forecast that moved because a date it predicted arrived would be
   * a badly calibrated forecast, not an updated one.
   *
   * The default of 0 means "report nothing as crossed", which is the right
   * answer for a caller that has not supplied a reference point.
   */
  referenceYear = 0,
): ClockModel {
  let contributingCount = 0;
  let pendingCount = 0;
  let rejectedCount = 0;

  let totalSignificance = 0;
  let calamityLoad = 0;
  let humanityBuffer = 0;
  let netCharge = 0;

  // Force accumulators, per domain plus a systemic bucket for unclassified.
  const byDomain = new Map<Domain, Accumulator>();
  const systemic: Accumulator = { weight: 0, weightedEffect: 0, count: 0 };
  const thresholdsRaw: ThresholdRaw[] = [];

  const bump = (acc: Accumulator, sig: number, effect: number): void => {
    acc.weight += sig;
    acc.weightedEffect += sig * effect;
    acc.count += 1;
  };

  for (const f of factors) {
    if (f.verificationState === 'pending') {
      pendingCount += 1;
      continue;
    }
    if (!Number.isFinite(f.effect) || !Number.isFinite(f.significance)) {
      rejectedCount += 1;
      continue;
    }

    const effect = clamp(f.effect, -1, 1);
    const significance = clamp(f.significance, 0, 1);

    contributingCount += 1;
    totalSignificance += significance;
    netCharge += effect * significance;
    if (effect * significance < 0) calamityLoad += -(effect * significance);
    else humanityBuffer += effect * significance;

    // Every factor exerts force in each of its domains (systemic when none).
    const domains = f.domains ?? [];
    if (domains.length === 0) {
      bump(systemic, significance, effect);
    } else {
      for (const d of domains) {
        const acc = byDomain.get(d) ?? { weight: 0, weightedEffect: 0, count: 0 };
        bump(acc, significance, effect);
        byDomain.set(d, acc);
      }
    }

    // Threshold-bearing factors additionally anchor the countdown — but only
    // ADVERSE ones.
    //
    // The countdown measures how long the window for course-correction stays
    // open, so its anchors must be thresholds you are counting DOWN to. A
    // beneficial milestone is a dated event you are counting FORWARD to, and
    // admitting one inverts the model twice over: it drags the aggregate target
    // earlier (good news shortening the window), and the per-threshold shift
    // renders as Calamity red because the model reads "sooner" as "worse".
    //
    // A real case: "China's record clean energy deployment" (effect +0.85)
    // carries Ember's 2028 projection for clean electricity meeting all demand
    // growth. It was the nearest AND heaviest threshold in the set, so it pulled
    // the whole countdown in.
    //
    // Polarity is taken from the carrying factor's own `effect` rather than a
    // new schema field: it is already required, already validated, and a factor
    // that helps does not carry a deadline. Only `effect > 0` is excluded —
    // neutral factors (documented opposing forces) can still carry a genuine
    // adverse threshold, and dropping those would lose real deadlines.
    const tp = effect > 0 ? undefined : f.tippingPoint;
    const dated = tp && significance > 0 ? dateThreshold(tp, projections) : null;
    if (tp && dated) {
      const central = dated.central;
      thresholdsRaw.push({
        factorId: f.id ?? null,
        label: tp.label ?? null,
        significance,
        central,
        earliestPub: dated.earliest,
        latestPub: dated.latest,
        dating: dated.dating,
        forcesApply: dated.forcesApply,
        quantityLabel: tp.quantityThreshold
          ? `${tp.quantityThreshold.value} ${tp.quantityThreshold.unit} — ${tp.quantityThreshold.quantity}`
          : null,
        recovery: tp.recovery ?? null,
        domains,
        // Strict `=== true`: absent, null, or anything non-boolean means nobody
        // has judged it, and an unjudged threshold must not drive the headline.
        closesWindow: tp.closesWindow === true,
      });
    }
  }

  // The assumed band for thresholds that published only a central year: the
  // median of the published half-widths across the set (data-grounded), or the
  // fallback constant when nothing published a range.
  const publishedHalfWidths: number[] = [];
  for (const t of thresholdsRaw) {
    if (t.earliestPub !== undefined) publishedHalfWidths.push(t.central - t.earliestPub);
    if (t.latestPub !== undefined) publishedHalfWidths.push(t.latestPub - t.central);
  }
  const derivedSpread =
    publishedHalfWidths.length > 0 ? median(publishedHalfWidths) : FALLBACK_SPREAD_YEARS;
  const usedFallbackSpread = thresholdsRaw.some(
    (t) => t.earliestPub === undefined || t.latestPub === undefined,
  );

  const hasEvidence = totalSignificance > 0;
  const netPolarity = hasEvidence ? clamp(netCharge / totalSignificance, -1, 1) : 0;

  const forceOf = (acc: Accumulator): number =>
    acc.weight > 0 ? clamp(acc.weightedEffect / acc.weight, -1, 1) : 0;

  /* --------------------------- warp each threshold ------------------------ */
  // Anchor sets hold ONLY window-closing thresholds. Every dated threshold is
  // still warped and reported for display; the distinction is what the countdown
  // is allowed to rest on.
  const anchorWarped: ArrivalDist[] = [];
  const anchorBaseline: ArrivalDist[] = [];
  const thresholds: ThresholdContribution[] = [];

  let baselineEarliestYear: number | null = null;
  let baselineLatestYear: number | null = null;

  for (const t of thresholdsRaw) {
    const earliest = t.earliestPub ?? t.central - derivedSpread;
    const latest = t.latestPub ?? t.central + derivedSpread;

    const driving = drivingDomains(t.domains);

    // Aggregate the force of the driving domains (by their mass) with the
    // systemic force, which always applies.
    let num = systemic.weightedEffect;
    let den = systemic.weight;
    for (const d of driving) {
      const acc = byDomain.get(d);
      if (acc) {
        num += acc.weightedEffect;
        den += acc.weight;
      }
    }
    const force = den > 0 ? clamp(num / den, -1, 1) : 0;
    const mass = den / (den + EVIDENCE_HALF_SATURATION); // evidence damping ∈ [0,1)

    // Move the estimate WITHIN the published band: Calamity toward `earliest`,
    // Humanity toward `latest`. At full force + full evidence it reaches the
    // bound; it can never move past it. The band itself does not move.
    //
    // Withheld when the dating projection already assumes future action: that
    // curve has the mitigation baked in, so bending it with the same factors
    // counts them twice. The threshold still anchors — it is dated, just not
    // re-shifted — and `forcesApply: false` is reported so the panel can say so.
    const room = force < 0 ? t.central - earliest : latest - t.central;
    const warpedCentral = t.forcesApply
      ? clamp(t.central + force * room * mass, earliest, latest)
      : t.central;

    thresholds.push({
      // A quantity-stated threshold usually has no prose label — the source
      // stated a number, not a name. Falling back to that number is derived
      // display text, not invented data, and beats rendering "Unlabelled".
      factorId: t.factorId,
      label: t.label ?? t.quantityLabel,
      significance: t.significance,
      baselineYear: t.central,
      warpedYear: warpedCentral,
      shiftYears: warpedCentral - t.central,
      drivingDomains: [...driving],
      anchors: t.closesWindow,
      dating: t.dating,
      forcesApply: t.forcesApply,
      // Reported, never fed back. `crossed` is derived from the warped year
      // against the reference year rather than stored, so it tracks whatever
      // the evidence currently says — and neither it nor `recovery` appears
      // anywhere in the first-crossing math above.
      crossed: warpedCentral < referenceYear,
      recovery: t.recovery,
    });

    if (!t.closesWindow) continue;

    anchorBaseline.push({ a: earliest, c: t.central, b: latest, p: t.significance });
    anchorWarped.push({ a: earliest, c: warpedCentral, b: latest, p: t.significance });

    baselineEarliestYear =
      baselineEarliestYear === null ? earliest : Math.min(baselineEarliestYear, earliest);
    baselineLatestYear =
      baselineLatestYear === null ? latest : Math.max(baselineLatestYear, latest);
  }

  const targetYear = firstCrossingQuantile(anchorWarped, 0.5);
  const baselineTargetYear = firstCrossingQuantile(anchorBaseline, 0.5);
  // Null target = the anchors' combined probability never reaches even odds, so
  // there is no year we can claim the window has closed by. Suppress.
  const hasBaseline = targetYear !== null;

  const p25 = firstCrossingQuantile(anchorWarped, 0.25);
  const p75 = firstCrossingQuantile(anchorWarped, 0.75);
  // p75 can be absent while the median exists — a single moderately-significant
  // anchor tops out below 0.75. Report no band rather than inventing an edge.
  const band: ClockBand | null =
    targetYear !== null && p25 !== null && p75 !== null ? { p25, p50: targetYear, p75 } : null;

  const shiftYears =
    baselineTargetYear !== null && targetYear !== null ? targetYear - baselineTargetYear : 0;

  /* ----------------------------- domain forces ---------------------------- */
  const domainForces: DomainForce[] = [];
  for (const [domain, acc] of byDomain) {
    domainForces.push({
      domain,
      label: DOMAIN_LABELS[domain],
      netForce: forceOf(acc),
      weight: acc.weight,
      factorCount: acc.count,
    });
  }
  if (systemic.count > 0) {
    domainForces.push({
      domain: 'systemic',
      label: 'Cross-cutting',
      netForce: forceOf(systemic),
      weight: systemic.weight,
      factorCount: systemic.count,
    });
  }
  domainForces.sort((a, b) => Math.abs(b.netForce * b.weight) - Math.abs(a.netForce * a.weight));

  // Anchors first, then by year — the Why panel reads top-down, and what the
  // countdown rests on should be what a reader sees first.
  thresholds.sort((a, b) =>
    a.anchors === b.anchors ? a.warpedYear - b.warpedYear : a.anchors ? -1 : 1,
  );

  return {
    contributingCount,
    pendingCount,
    rejectedCount,
    totalSignificance,
    calamityLoad,
    humanityBuffer,
    netPolarity,
    hasEvidence,
    tippingPointCount: anchorWarped.length,
    datedThresholdCount: thresholdsRaw.length,
    crossedCount: thresholds.filter((t) => t.anchors && t.crossed).length,
    hasBaseline,
    baselineTargetYear,
    baselineEarliestYear,
    baselineLatestYear,
    shiftYears,
    targetYear,
    band,
    domainForces,
    thresholds,
    assumedSpreadYears: hasBaseline && usedFallbackSpread ? derivedSpread : null,
    // Tiered on the ANCHOR count, not the factor count.
    //
    // This reported `substantial` off 99 contributing factors while the
    // countdown rested on one threshold — and a single reclassification moved
    // the target six years. Confidence has to describe the number it sits next
    // to, and that number is a function of the anchors alone: the other 95
    // factors are forces that shift a date within its published band, not
    // evidence about when the window closes.
    confidence: confidenceForCount(anchorWarped.length),
  };
}

/**
 * Convert a decimal calendar year to an epoch-ms instant. Deterministic (uses
 * `Date.UTC`, a pure function of its arguments), so the model + this helper stay
 * unit-testable. Fractional years interpolate linearly across the calendar year.
 */
export function yearToEpochMs(year: number): number {
  const whole = Math.floor(year);
  const frac = year - whole;
  const start = Date.UTC(whole, 0, 1);
  const end = Date.UTC(whole + 1, 0, 1);
  return start + frac * (end - start);
}

/**
 * The absolute wall-clock instant the countdown targets, or null when there is
 * no tipping-point baseline. Pure — the view subtracts `Date.now()` to drive the
 * live countdown.
 */
export function targetDeadlineMs(model: ClockModel): number | null {
  return model.targetYear === null ? null : yearToEpochMs(model.targetYear);
}
