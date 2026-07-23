/**
 * Tests for the Clock derivation model (src/ui/clockModel.ts).
 *
 * The model anchors the countdown to the polycrisis's TIPPING POINTS: a
 * significance-weighted baseline of dated thresholds, shifted by net direction
 * (Calamity sooner, Humanity later). Coverage focus:
 *   - baseline is the significance-weighted mean of central tipping years;
 *   - direction shifts it the correct way, bounded by the config;
 *   - no tipping points → indeterminate (targetYear null), never invented;
 *   - the no-data vs balance distinction (P=0 from balance vs from emptiness);
 *   - polarity is monotonic, clamped, and poison-proof;
 *   - year→epoch conversion is pure/deterministic.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveClock,
  confidenceForCount,
  targetDeadlineMs,
  yearToEpochMs,
  DEFAULT_CLOCK_HORIZON,
  type ClockFactorInput,
} from './clockModel.js';

const calamity: ClockFactorInput = { effect: -1, significance: 1 };
const humanity: ClockFactorInput = { effect: 1, significance: 1 };
const MAX_SHIFT = DEFAULT_CLOCK_HORIZON.maxShiftYears;

/** A dated-threshold factor: a calamity tipping point at `year`. */
function tp(year: number, effect = -1, significance = 1): ClockFactorInput {
  return { effect, significance, tippingPoint: { centralYear: year } };
}

describe('deriveClock — empty / no-evidence handling', () => {
  it('empty set is well-defined, not NaN, and has no baseline', () => {
    const m = deriveClock([]);
    expect(m.hasEvidence).toBe(false);
    expect(m.hasBaseline).toBe(false);
    expect(m.targetYear).toBeNull();
    expect(m.baselineTargetYear).toBeNull();
    expect(m.contributingCount).toBe(0);
    expect(m.tippingPointCount).toBe(0);
    expect(m.netPolarity).toBe(0);
    expect(Number.isNaN(m.netPolarity)).toBe(false);
    expect(m.confidence).toBe('indeterminate');
  });

  it('factors without tipping points give evidence but no baseline', () => {
    const m = deriveClock([calamity, humanity]);
    expect(m.hasEvidence).toBe(true);
    expect(m.contributingCount).toBe(2);
    expect(m.hasBaseline).toBe(false); // no dated threshold in the set
    expect(m.targetYear).toBeNull();
    expect(m.tippingPointCount).toBe(0);
  });

  it('a zero-significance factor contributes no evidence and no baseline weight', () => {
    const m = deriveClock([{ ...tp(2050), significance: 0 }]);
    expect(m.contributingCount).toBe(1);
    expect(m.totalSignificance).toBe(0);
    expect(m.hasEvidence).toBe(false);
    expect(m.hasBaseline).toBe(false); // zero significance → no baseline weight
    expect(m.targetYear).toBeNull();
  });
});

describe('deriveClock — the no-data vs. balance distinction', () => {
  it('genuine balance yields P≈0 hasEvidence=true — distinct from empty', () => {
    const balanced = deriveClock([calamity, humanity]);
    expect(balanced.netPolarity).toBeCloseTo(0, 12);
    expect(balanced.hasEvidence).toBe(true);
    const empty = deriveClock([]);
    expect(empty.netPolarity).toBe(0);
    expect(balanced.hasEvidence).not.toBe(empty.hasEvidence);
  });
});

describe('deriveClock — tipping-point baseline', () => {
  it('baseline is the significance-weighted mean of central tipping years', () => {
    // In-domain weights (significance is clamped to [0,1]):
    // 0.25 @ 2040 and 0.75 @ 2060 → (0.25·2040 + 0.75·2060)/1.0 = 2055
    const m = deriveClock([
      { effect: 0, significance: 0.25, tippingPoint: { centralYear: 2040 } },
      { effect: 0, significance: 0.75, tippingPoint: { centralYear: 2060 } },
    ]);
    expect(m.hasBaseline).toBe(true);
    expect(m.tippingPointCount).toBe(2);
    expect(m.baselineTargetYear).toBeCloseTo(2055, 9);
    // effect 0 → P 0 → no shift → target == baseline
    expect(m.shiftYears).toBeCloseTo(0, 12);
    expect(m.targetYear).toBeCloseTo(2055, 9);
  });

  it('captures earliest/latest bounds for context', () => {
    const m = deriveClock([
      { effect: 0, significance: 1, tippingPoint: { centralYear: 2050, earliestYear: 2037, latestYear: 2095 } },
      { effect: 0, significance: 1, tippingPoint: { centralYear: 2030, earliestYear: 2028 } },
    ]);
    expect(m.baselineEarliestYear).toBe(2028); // min of earliests
    expect(m.baselineLatestYear).toBe(2095); // max of latests
  });

  it('factors without a tipping point do not move the baseline (only the shift)', () => {
    const withNoise = deriveClock([
      tp(2050, 0, 1), // baseline anchor, neutral effect
      { effect: 1, significance: 1 }, // humanity, no threshold
    ]);
    // baseline is purely the 2050 anchor; humanity only shifts it later
    expect(withNoise.baselineTargetYear).toBeCloseTo(2050, 9);
    expect(withNoise.targetYear).toBeGreaterThan(2050);
  });
});

describe('deriveClock — direction shifts the baseline the correct way', () => {
  it('net Calamity pulls the target SOONER than the baseline', () => {
    const m = deriveClock([tp(2050, -1, 1)]); // pure calamity threshold
    expect(m.netPolarity).toBeCloseTo(-1, 12);
    expect(m.baselineTargetYear).toBeCloseTo(2050, 9);
    expect(m.shiftYears).toBeCloseTo(-MAX_SHIFT, 9);
    expect(m.targetYear).toBeCloseTo(2050 - MAX_SHIFT, 9);
    expect(m.targetYear!).toBeLessThan(m.baselineTargetYear!);
  });

  it('net Humanity pushes the target LATER than the baseline', () => {
    // Anchor a neutral baseline, add net-humanity pressure.
    const m = deriveClock([
      tp(2050, 0, 1),
      { effect: 1, significance: 1 },
    ]);
    expect(m.netPolarity).toBeGreaterThan(0);
    expect(m.baselineTargetYear).toBeCloseTo(2050, 9);
    expect(m.targetYear!).toBeGreaterThan(m.baselineTargetYear!);
  });

  it('balanced direction leaves the baseline unshifted', () => {
    const m = deriveClock([
      tp(2050, -1, 1), // calamity threshold
      { effect: 1, significance: 1 }, // equal-and-opposite humanity
    ]);
    expect(m.netPolarity).toBeCloseTo(0, 12);
    expect(m.shiftYears).toBeCloseTo(0, 12);
    expect(m.targetYear).toBeCloseTo(2050, 9);
  });

  it('a stronger net Calamity pulls the target monotonically sooner', () => {
    let prev = Infinity;
    for (const w of [0, 0.25, 0.5, 0.75, 1]) {
      const m = deriveClock([
        tp(2050, 0, 1), // fixed neutral baseline anchor
        { effect: 1, significance: 0.5 }, // fixed humanity
        { effect: -1, significance: w }, // growing calamity
      ]);
      expect(m.targetYear!).toBeLessThanOrEqual(prev + 1e-9);
      prev = m.targetYear!;
    }
  });

  it('respects a custom horizon config (shift bound is not hardcoded)', () => {
    const wide = deriveClock([tp(2050, -1, 1)], { maxShiftYears: 20 });
    expect(wide.targetYear).toBeCloseTo(2030, 9); // 2050 - 20
    const none = deriveClock([tp(2050, -1, 1)], { maxShiftYears: 0 });
    expect(none.targetYear).toBeCloseTo(2050, 9); // no shift allowed
  });
});

describe('deriveClock — polarity monotonicity, clamping, poison resistance', () => {
  it('netPolarity is monotonic non-decreasing in a single factor effect', () => {
    let prev = -Infinity;
    for (let e = -1; e <= 1 + 1e-9; e += 0.25) {
      const p = deriveClock([{ effect: e, significance: 1 }]).netPolarity;
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it('out-of-range effect/significance are clamped', () => {
    const m = deriveClock([{ effect: -5, significance: 3 }]);
    expect(m.netPolarity).toBeCloseTo(-1, 12);
    expect(m.netPolarity).toBeGreaterThanOrEqual(-1);
  });

  it('non-finite effect/significance are rejected, not propagated', () => {
    const m = deriveClock([
      calamity,
      { effect: NaN, significance: 1 },
      { effect: Infinity, significance: 1 },
      { effect: 1, significance: NaN },
    ]);
    expect(m.rejectedCount).toBe(3);
    expect(m.contributingCount).toBe(1);
    expect(Number.isFinite(m.netPolarity)).toBe(true);
    expect(m.netPolarity).toBeCloseTo(-1, 12);
  });

  it('a non-finite tipping year is ignored, not propagated into the baseline', () => {
    const m = deriveClock([
      { effect: 0, significance: 1, tippingPoint: { centralYear: 2050 } },
      { effect: 0, significance: 1, tippingPoint: { centralYear: NaN } },
    ]);
    expect(m.tippingPointCount).toBe(1); // the NaN-year one is not counted
    expect(m.baselineTargetYear).toBeCloseTo(2050, 9);
    expect(Number.isFinite(m.targetYear!)).toBe(true);
  });
});

describe('deriveClock — pending exclusion', () => {
  it('pending factors are excluded from both derivation and baseline', () => {
    const m = deriveClock([
      { effect: -1, significance: 1, verificationState: 'verified', tippingPoint: { centralYear: 2050 } },
      { effect: 1, significance: 1, verificationState: 'pending', tippingPoint: { centralYear: 2100 } },
    ]);
    expect(m.pendingCount).toBe(1);
    expect(m.contributingCount).toBe(1);
    expect(m.tippingPointCount).toBe(1); // pending 2100 threshold excluded
    expect(m.baselineTargetYear).toBeCloseTo(2050, 9);
    expect(m.netPolarity).toBeCloseTo(-1, 12);
  });
});

describe('deriveClock — purity / determinism', () => {
  it('same input yields deep-equal output and does not mutate the input', () => {
    const input: ClockFactorInput[] = [calamity, humanity, tp(2050)];
    const snapshot = JSON.parse(JSON.stringify(input));
    const a = deriveClock(input);
    const b = deriveClock(input);
    expect(a).toEqual(b);
    expect(input).toEqual(snapshot);
  });
});

describe('confidenceForCount — coarse but monotonic tiers', () => {
  it('maps counts to the documented tiers', () => {
    expect(confidenceForCount(0)).toBe('indeterminate');
    expect(confidenceForCount(-3)).toBe('indeterminate');
    expect(confidenceForCount(1)).toBe('low');
    expect(confidenceForCount(4)).toBe('low');
    expect(confidenceForCount(5)).toBe('moderate');
    expect(confidenceForCount(19)).toBe('moderate');
    expect(confidenceForCount(20)).toBe('substantial');
  });

  it('confidence rank never decreases as count grows', () => {
    const rank: Record<string, number> = {
      indeterminate: 0,
      low: 1,
      moderate: 2,
      substantial: 3,
    };
    let prev = -1;
    for (let n = 0; n <= 40; n++) {
      const r = rank[confidenceForCount(n)]!;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

describe('yearToEpochMs / targetDeadlineMs — pure, deterministic', () => {
  it('whole years map to the UTC year start', () => {
    expect(yearToEpochMs(2050)).toBe(Date.UTC(2050, 0, 1));
    expect(yearToEpochMs(2000)).toBe(Date.UTC(2000, 0, 1));
  });

  it('fractional years interpolate within the calendar year', () => {
    const start = Date.UTC(2050, 0, 1);
    const end = Date.UTC(2051, 0, 1);
    expect(yearToEpochMs(2050.5)).toBeCloseTo(start + 0.5 * (end - start), 3);
  });

  it('a sooner target yields an earlier deadline', () => {
    const sooner = deriveClock([tp(2050, -1, 1)]); // shifted earlier
    const later = deriveClock([tp(2050, 1, 1)]); // shifted later
    expect(targetDeadlineMs(sooner)!).toBeLessThan(targetDeadlineMs(later)!);
  });

  it('null target (no baseline) yields a null deadline', () => {
    expect(targetDeadlineMs(deriveClock([]))).toBeNull();
    expect(targetDeadlineMs(deriveClock([calamity]))).toBeNull();
  });
});
