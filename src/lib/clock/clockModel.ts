/**
 * The Clock — derivation model.
 *
 * NEITHER spec defines
 * what the Clock counts down TO, nor how the factor set produces a time value.
 * They call it "a data-driven model tracking humanity's window of viable
 * course-correction" with "ticking countdown values", but give no target, no
 * formula, no units. So we define it here, explicitly and inspectably.
 *
 * DESIGN (owner directive): the countdown is anchored to the polycrisis's own
 * TIPPING POINTS, not to an invented window. Some factors carry a dated,
 * irreversible threshold ({@link TippingPoint}) — e.g. AMOC collapse (~2050),
 * an ice-free Arctic, coral loss at 2 °C, Amazon dieback; most factors (lobbying
 * capture, textile waste, clean-energy investment) do NOT — they are pressures or
 * counter-forces, not dated thresholds. The model therefore works in two stages:
 *
 *   1. BASELINE TARGET — the significance-weighted mean of the central tipping
 *      years, over the factors that HAVE a tipping point. Nearer, heavier
 *      thresholds dominate. This is a physical, data-grounded baseline, not a
 *      guess. With no tipping-point factors there is no baseline and the Clock is
 *      `indeterminate` rather than inventing one.
 *   2. DIRECTION + MAGNITUDE MODIFY IT — the net polarity P ∈ [-1, 1] (the
 *      significance-weighted mean of signed effect across ALL contributing
 *      factors; its magnitude is embodied in the weighting) shifts the baseline:
 *      net Calamity (P < 0) pulls the target date SOONER, net Humanity (P > 0)
 *      pushes it LATER, bounded by an operator-set {@link ClockHorizonConfig}
 *      (`maxShiftYears`). That bound is an estimate the operator configures — it
 *      is NOT a seed data figure and is NOT hardcoded as the answer.
 *
 * What this model deliberately does NOT claim:
 *   - The baseline is a weighted aggregate of published tipping-point estimates,
 *     each of which is itself uncertain (ranges, contested timelines). The UI
 *     surfaces the baseline, the shift, and the evidence, and the explainer states
 *     plainly that the countdown is an ESTIMATE, never a measured deadline.
 *   - `netPolarity == 0` means balanced ONLY when {@link ClockModel.hasEvidence};
 *     with no evidence it is also 0 — never read 0 as "balanced" without checking
 *     `hasEvidence` (the no-data vs equilibrium trap).
 *   - The confidence tiers are illustrative thresholds on evidence volume, not a
 *     calibrated statistic.
 *
 * `deriveClock` is PURE and deterministic: it reads only its arguments, calls no
 * clock, allocates no globals, and emits an absolute {@link ClockModel.targetYear}.
 * The view layer converts that to a wall-clock deadline (via {@link
 * targetDeadlineMs}) and counts down toward it, so this stays unit-testable.
 */
import type { VerificationState } from '../../../shared/types.js';

/**
 * A dated, (near-)irreversible threshold a factor represents. Optional on a
 * factor — most factors have none. `centralYear` is the best estimate; the
 * optional bounds carry the published uncertainty range for display.
 */
export interface TippingPoint {
  /** Best-estimate calendar year the threshold is crossed (e.g. 2050). */
  readonly centralYear: number;
  /** Optional earliest credible year (lower bound of the published range). */
  readonly earliestYear?: number;
  /** Optional latest credible year (upper bound of the published range). */
  readonly latestYear?: number;
  /** Short provenance label, e.g. "AMOC collapse (Ditlevsen 2023)". */
  readonly label?: string;
}

/**
 * How far net sentiment (direction) may move the physical tipping-point baseline,
 * in years. An operator-set ESTIMATE, configurable (env-driven in the app), NOT a
 * seed data fact and NOT baked in as the answer. {@link DEFAULT_CLOCK_HORIZON} is
 * only the fallback when the app supplies nothing.
 */
export interface ClockHorizonConfig {
  readonly maxShiftYears: number;
}

/** Fallback horizon config. The app overrides this with an env-configured value. */
export const DEFAULT_CLOCK_HORIZON: ClockHorizonConfig = { maxShiftYears: 5 };

/** Julian year in milliseconds. */
export const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Confidence in the projection, driven purely by how much verified evidence
 * informs it. Deliberately coarse and honestly labelled — see the module note.
 */
export type ClockConfidence =
  | 'indeterminate'
  | 'low'
  | 'moderate'
  | 'substantial';

/**
 * Minimal input shape the model needs from a factor. `Factor` and `FieldPin`
 * from the shared contract satisfy it structurally, so callers pass the feed set
 * directly. `verificationState` optional: absent → contributes; `'pending'` →
 * excluded. `tippingPoint` optional: present → informs the baseline.
 */
export interface ClockFactorInput {
  readonly effect: number;
  readonly significance: number;
  readonly verificationState?: VerificationState;
  readonly tippingPoint?: TippingPoint | null;
}

/** Fully-derived Clock state. Every field is inspectable by the UI. */
export interface ClockModel {
  /** Factors that actually drove the model (finite, non-pending). */
  readonly contributingCount: number;
  /** Factors excluded because they are `pending`. */
  readonly pendingCount: number;
  /** Factors excluded because effect/significance was non-finite. */
  readonly rejectedCount: number;

  /** Σ significance over contributing factors. */
  readonly totalSignificance: number;
  /** Σ |effect·significance| over contributing factors with effect < 0. */
  readonly calamityLoad: number;
  /** Σ  effect·significance  over contributing factors with effect > 0. */
  readonly humanityBuffer: number;

  /**
   * Significance-weighted mean of signed effect, clamped to [-1, 1]. -1 = pure
   * Calamity, +1 = pure Humanity, 0 = balanced (only when {@link hasEvidence}).
   */
  readonly netPolarity: number;
  /** True when at least one contributing factor carried nonzero significance. */
  readonly hasEvidence: boolean;

  /* --------------------------- tipping-point baseline --------------------- */
  /** Contributing factors that carry a (finite) tipping point. */
  readonly tippingPointCount: number;
  /** True when at least one tipping-point factor informs the baseline. */
  readonly hasBaseline: boolean;
  /** Significance-weighted mean central tipping year, or null with no baseline. */
  readonly baselineTargetYear: number | null;
  /** Nearest earliest-bound among tipping factors (context), or null. */
  readonly baselineEarliestYear: number | null;
  /** Furthest latest-bound among tipping factors (context), or null. */
  readonly baselineLatestYear: number | null;

  /* ------------------------------ modified target ------------------------- */
  /** Years the baseline was shifted by net direction (signed; <0 = sooner). */
  readonly shiftYears: number;
  /** Baseline shifted by direction·magnitude. Absolute year, or null. */
  readonly targetYear: number | null;

  readonly confidence: ClockConfidence;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Confidence tier from contributing-factor count. Thresholds are illustrative,
 * not calibrated (see module note); they exist so evidence volume is visible.
 */
export function confidenceForCount(count: number): ClockConfidence {
  if (count <= 0) return 'indeterminate';
  if (count < 5) return 'low';
  if (count < 20) return 'moderate';
  return 'substantial';
}

/**
 * Derive the Clock state from a factor set and a horizon config. Pure and total:
 * any input (empty, all-pending, poison values, no tipping points) yields a
 * well-defined {@link ClockModel} — `hasBaseline === false` / `targetYear === null`
 * rather than a NaN or throw.
 */
export function deriveClock(
  factors: readonly ClockFactorInput[],
  horizon: ClockHorizonConfig = DEFAULT_CLOCK_HORIZON,
): ClockModel {
  let contributingCount = 0;
  let pendingCount = 0;
  let rejectedCount = 0;

  let totalSignificance = 0;
  let calamityLoad = 0;
  let humanityBuffer = 0;
  let netCharge = 0;

  // Tipping-point accumulators (significance-weighted mean of central years).
  let tippingPointCount = 0;
  let tippingSignificance = 0;
  let tippingWeightedYear = 0;
  let baselineEarliestYear: number | null = null;
  let baselineLatestYear: number | null = null;

  for (const f of factors) {
    if (f.verificationState === 'pending') {
      pendingCount += 1;
      continue;
    }
    // Defense in depth: a stray NaN/±Infinity from the driver would otherwise
    // poison every downstream sum. Drop it here, count it, move on.
    if (!Number.isFinite(f.effect) || !Number.isFinite(f.significance)) {
      rejectedCount += 1;
      continue;
    }

    // Bound to the enforced domains (shared/schema + DB CHECKs).
    const effect = clamp(f.effect, -1, 1);
    const significance = clamp(f.significance, 0, 1);
    const charge = effect * significance;

    contributingCount += 1;
    totalSignificance += significance;
    netCharge += charge;
    if (charge < 0) calamityLoad += -charge;
    else humanityBuffer += charge;

    // Tipping point (if any) informs the physical baseline. Weight by
    // significance so heavier thresholds dominate; skip zero-significance and
    // non-finite years so they can't distort the mean.
    const tp = f.tippingPoint;
    if (tp && Number.isFinite(tp.centralYear) && significance > 0) {
      tippingPointCount += 1;
      tippingSignificance += significance;
      tippingWeightedYear += significance * tp.centralYear;
      if (Number.isFinite(tp.earliestYear ?? NaN)) {
        const e = tp.earliestYear as number;
        baselineEarliestYear =
          baselineEarliestYear === null ? e : Math.min(baselineEarliestYear, e);
      }
      if (Number.isFinite(tp.latestYear ?? NaN)) {
        const l = tp.latestYear as number;
        baselineLatestYear =
          baselineLatestYear === null ? l : Math.max(baselineLatestYear, l);
      }
    }
  }

  const hasEvidence = totalSignificance > 0;
  const netPolarity = hasEvidence
    ? clamp(netCharge / totalSignificance, -1, 1)
    : 0;

  const hasBaseline = tippingSignificance > 0;
  const baselineTargetYear = hasBaseline
    ? tippingWeightedYear / tippingSignificance
    : null;

  // Direction·magnitude shift: net Calamity (P<0) pulls sooner, net Humanity
  // (P>0) pushes later. |P| is significance-weighted, so magnitude is embodied.
  // Bounded by the operator-set maxShiftYears (an estimate, see config note).
  const maxShift = Number.isFinite(horizon.maxShiftYears)
    ? Math.max(0, horizon.maxShiftYears)
    : DEFAULT_CLOCK_HORIZON.maxShiftYears;
  const shiftYears = hasBaseline ? netPolarity * maxShift : 0;
  const targetYear =
    baselineTargetYear === null ? null : baselineTargetYear + shiftYears;

  return {
    contributingCount,
    pendingCount,
    rejectedCount,
    totalSignificance,
    calamityLoad,
    humanityBuffer,
    netPolarity,
    hasEvidence,
    tippingPointCount,
    hasBaseline,
    baselineTargetYear,
    baselineEarliestYear,
    baselineLatestYear,
    shiftYears,
    targetYear,
    confidence: confidenceForCount(contributingCount),
  };
}

/**
 * Convert a decimal calendar year to an epoch-ms instant. Deterministic: uses
 * `Date.UTC` (a pure function of its arguments — NOT the wall clock), so the
 * model + this helper stay unit-testable. Fractional years interpolate linearly
 * across the calendar year (leap years included).
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
 * no tipping-point baseline (Clock renders indeterminate). Pure — the view
 * subtracts `Date.now()` to drive the live countdown.
 */
export function targetDeadlineMs(model: ClockModel): number | null {
  return model.targetYear === null ? null : yearToEpochMs(model.targetYear);
}
