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
 *   2. FORCES WARP THE ANCHOR — the other factors are pressures and
 *      counter-forces, not dated thresholds. Each acts only on the tipping points
 *      it is causally linked to, by shared {@link Domain} (see
 *      `shared/domains.ts`): deforestation moves the Amazon threshold, clean
 *      energy moves the climate-driven ones, not the AMOC one directly. A
 *      threshold's arrival is warped by the net force of its driving domains,
 *      scaled by (a) how much runway remains to it — you can bend a distant
 *      threshold more than an imminent one — and (b) how much evidence backs the
 *      force. There is no flat year cap; the shift emerges from the physics.
 *
 *   3. THE ONE ASSUMPTION — {@link ELASTICITY_DEFAULT}, a dimensionless measure
 *      of how far collective force can bend a timeline (a fraction of its
 *      runway). It cannot be derived from data; it is surfaced as the modeling
 *      choice it is, and its EFFECT is data-scaled rather than hardcoded in years.
 *
 * What this model deliberately does NOT claim: the anchor is a weighted aggregate
 * of published, individually-uncertain estimates; the band is the honest spread,
 * not a precise deadline; and `netPolarity == 0` means "balanced" only when
 * {@link ClockModel.hasEvidence} (never read 0 as balanced without checking it).
 *
 * `deriveClock` is PURE and deterministic: it reads only its arguments (including
 * the reference `nowYear`), calls no clock, and emits absolute years. The view
 * converts those to a live countdown, so the model stays unit-testable.
 */
import type { VerificationState } from '../../../shared/types.js';
import {
  DOMAIN_LABELS,
  drivingDomains,
  type Domain,
} from '../../../shared/domains.js';

/**
 * A dated, (near-)irreversible threshold a factor represents. Optional on a
 * factor — most factors have none. `centralYear` is the best estimate; the
 * optional bounds carry the published uncertainty range.
 */
export interface TippingPoint {
  readonly centralYear: number;
  readonly earliestYear?: number;
  readonly latestYear?: number;
  readonly label?: string;
}

/**
 * Dimensionless elasticity: the maximum fraction of a threshold's remaining
 * runway that the net force can move it, at full tilt and full evidence. The one
 * irreducible modeling assumption — surfaced in the UI as such.
 */
export const ELASTICITY_DEFAULT = 0.35;

/** Half-width (years) assumed around a `centralYear` that lacks a published range. */
const DEFAULT_SPREAD_YEARS = 8;

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
  readonly effect: number;
  readonly significance: number;
  readonly verificationState?: VerificationState;
  readonly tippingPoint?: TippingPoint | null;
  readonly domains?: readonly Domain[];
}

/** Reference frame for the derivation. `nowYear` is a decimal calendar year. */
export interface DeriveOptions {
  readonly nowYear: number;
  readonly elasticity?: number;
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

/** One threshold's contribution to the anchor, before and after the warp. */
export interface ThresholdContribution {
  readonly label: string | null;
  readonly significance: number;
  readonly baselineYear: number;
  readonly warpedYear: number;
  /** Years the force moved it (signed; < 0 = sooner). */
  readonly shiftYears: number;
  readonly drivingDomains: readonly Domain[];
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
  readonly tippingPointCount: number;
  readonly hasBaseline: boolean;
  /** Median of the UN-warped arrival mixture (the pure anchor), or null. */
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
  /** The elasticity actually used. */
  readonly elasticity: number;

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
  /** Normalized weight (Σ = 1 across the set). */
  w: number;
}

/** Significance-weighted mixture CDF over arrival years. */
function mixtureCdf(dists: readonly ArrivalDist[], y: number): number {
  let sum = 0;
  for (const d of dists) sum += d.w * triangularCdf(y, d.a, d.c, d.b);
  return sum;
}

/** Invert the mixture CDF at `level` by bisection over the support. */
function quantile(dists: readonly ArrivalDist[], level: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of dists) {
    if (d.a < lo) lo = d.a;
    if (d.b > hi) hi = d.b;
  }
  if (!Number.isFinite(lo) || hi <= lo) return Number.isFinite(lo) ? lo : 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mixtureCdf(dists, mid) < level) lo = mid;
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
  label: string | null;
  significance: number;
  central: number;
  earliest: number;
  latest: number;
  domains: readonly Domain[];
}

/**
 * Derive the Clock state from a factor set. Pure and total: any input (empty,
 * all-pending, poison values, no tipping points) yields a well-defined
 * {@link ClockModel} — `hasBaseline === false` / `targetYear === null` rather
 * than a NaN or throw.
 */
export function deriveClock(
  factors: readonly ClockFactorInput[],
  options: DeriveOptions,
): ClockModel {
  const nowYear = options.nowYear;
  const elasticity = Number.isFinite(options.elasticity)
    ? Math.max(0, options.elasticity as number)
    : ELASTICITY_DEFAULT;

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

    // Threshold-bearing factors additionally anchor the countdown.
    const tp = f.tippingPoint;
    if (tp && Number.isFinite(tp.centralYear) && significance > 0) {
      const central = tp.centralYear;
      const earliest = Number.isFinite(tp.earliestYear ?? NaN)
        ? Math.min(tp.earliestYear as number, central)
        : central - DEFAULT_SPREAD_YEARS;
      const latest = Number.isFinite(tp.latestYear ?? NaN)
        ? Math.max(tp.latestYear as number, central)
        : central + DEFAULT_SPREAD_YEARS;
      thresholdsRaw.push({
        label: tp.label ?? null,
        significance,
        central,
        earliest,
        latest,
        domains,
      });
    }
  }

  const hasEvidence = totalSignificance > 0;
  const netPolarity = hasEvidence ? clamp(netCharge / totalSignificance, -1, 1) : 0;

  const forceOf = (acc: Accumulator): number =>
    acc.weight > 0 ? clamp(acc.weightedEffect / acc.weight, -1, 1) : 0;

  /* --------------------------- warp each threshold ------------------------ */
  const warpedDists: ArrivalDist[] = [];
  const baselineDists: ArrivalDist[] = [];
  const thresholds: ThresholdContribution[] = [];
  const totalTippingSig = thresholdsRaw.reduce((s, t) => s + t.significance, 0);

  let baselineEarliestYear: number | null = null;
  let baselineLatestYear: number | null = null;

  for (const t of thresholdsRaw) {
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
    const runway = Math.max(0, t.central - nowYear);
    const shift = force * elasticity * runway * mass;

    const wNorm = totalTippingSig > 0 ? t.significance / totalTippingSig : 0;
    baselineDists.push({ a: t.earliest, c: t.central, b: t.latest, w: wNorm });
    warpedDists.push({
      a: t.earliest + shift,
      c: t.central + shift,
      b: t.latest + shift,
      w: wNorm,
    });

    thresholds.push({
      label: t.label,
      significance: t.significance,
      baselineYear: t.central,
      warpedYear: t.central + shift,
      shiftYears: shift,
      drivingDomains: [...driving],
    });

    baselineEarliestYear =
      baselineEarliestYear === null ? t.earliest : Math.min(baselineEarliestYear, t.earliest);
    baselineLatestYear =
      baselineLatestYear === null ? t.latest : Math.max(baselineLatestYear, t.latest);
  }

  const hasBaseline = warpedDists.length > 0 && totalTippingSig > 0;
  const baselineTargetYear = hasBaseline ? quantile(baselineDists, 0.5) : null;
  const targetYear = hasBaseline ? quantile(warpedDists, 0.5) : null;
  const band: ClockBand | null = hasBaseline
    ? {
        p25: quantile(warpedDists, 0.25),
        p50: targetYear as number,
        p75: quantile(warpedDists, 0.75),
      }
    : null;
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
  domainForces.sort(
    (a, b) => Math.abs(b.netForce * b.weight) - Math.abs(a.netForce * a.weight),
  );

  // Nearest, heaviest threshold first — the Why panel reads top-down.
  thresholds.sort((a, b) => a.warpedYear - b.warpedYear);

  return {
    contributingCount,
    pendingCount,
    rejectedCount,
    totalSignificance,
    calamityLoad,
    humanityBuffer,
    netPolarity,
    hasEvidence,
    tippingPointCount: thresholdsRaw.length,
    hasBaseline,
    baselineTargetYear,
    baselineEarliestYear,
    baselineLatestYear,
    shiftYears,
    targetYear,
    band,
    domainForces,
    thresholds,
    elasticity,
    confidence: confidenceForCount(contributingCount),
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
