import { describe, it, expect } from 'vitest';
import {
  deriveClock,
  targetDeadlineMs,
  yearToEpochMs,
  confidenceForCount,
  type ClockFactorInput,
} from './clockModel.js';

const derive = (factors: ClockFactorInput[]) => deriveClock(factors);

describe('deriveClock — anchor', () => {
  it('is indeterminate with no tipping points', () => {
    const m = derive([{ effect: -0.8, significance: 0.9, domains: ['climate'] }]);
    expect(m.hasBaseline).toBe(false);
    expect(m.targetYear).toBeNull();
    expect(m.band).toBeNull();
    expect(m.confidence).not.toBe('indeterminate'); // has evidence, just no anchor
  });

  it('is fully indeterminate with no factors at all', () => {
    const m = derive([]);
    expect(m.hasBaseline).toBe(false);
    expect(m.hasEvidence).toBe(false);
    expect(m.confidence).toBe('indeterminate');
  });

  it('anchors the median between two thresholds, weighted by significance', () => {
    const m = derive([
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2040 }, domains: [] },
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2060 }, domains: [] },
    ]);
    expect(m.baselineTargetYear).toBeGreaterThan(2045);
    expect(m.baselineTargetYear).toBeLessThan(2055);
    expect(m.band).not.toBeNull();
    expect(m.band!.p25).toBeLessThan(m.band!.p50);
    expect(m.band!.p50).toBeLessThan(m.band!.p75);
  });

  it('a heavier threshold pulls the anchor toward its year', () => {
    const m = derive([
      { effect: 0, significance: 0.2, tippingPoint: { centralYear: 2040 }, domains: [] },
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2060 }, domains: [] },
    ]);
    expect(m.baselineTargetYear).toBeGreaterThan(2050);
  });
});

describe('deriveClock — forces interpolate within the published range', () => {
  const ocean = (centralYear = 2060): ClockFactorInput => ({
    effect: -0.4,
    significance: 0.9,
    tippingPoint: { centralYear, earliestYear: 2050, latestYear: 2075 },
    domains: ['ocean'],
  });

  it('a domain-matched Calamity force moves the estimate earlier, never past the bound', () => {
    const m = derive([
      ocean(),
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
    ]);
    const t = m.thresholds[0]!;
    expect(t.warpedYear).toBeLessThan(2060);
    expect(t.warpedYear).toBeGreaterThanOrEqual(2050); // clamped to the earliest bound
    expect(m.shiftYears).toBeLessThan(0);
  });

  it('a domain-matched Humanity force moves it later, never past the latest bound', () => {
    const m = derive([
      { effect: 0.4, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2050, latestYear: 2075 }, domains: ['ocean'] },
      { effect: 0.9, significance: 0.9, domains: ['ocean'] },
      { effect: 0.9, significance: 0.9, domains: ['ocean'] },
    ]);
    const t = m.thresholds[0]!;
    expect(t.warpedYear).toBeGreaterThan(2060);
    expect(t.warpedYear).toBeLessThanOrEqual(2075);
  });

  it('strong, well-evidenced Calamity pushes most of the way to the earliest bound', () => {
    const forces: ClockFactorInput[] = Array.from({ length: 10 }, () => ({
      effect: -1,
      significance: 1,
      domains: ['ocean'] as const,
    }));
    const m = derive([ocean(), ...forces]);
    // Evidence-mass damping means it approaches — not exactly reaches — the 2050
    // bound: a 10-year room, moved well past halfway, clamped at the bound.
    expect(m.thresholds[0]!.warpedYear).toBeLessThan(2054);
    expect(m.thresholds[0]!.warpedYear).toBeGreaterThanOrEqual(2050);
  });

  it('a wider published range permits a larger shift than a tight one', () => {
    const forces: ClockFactorInput[] = [
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
    ];
    const wide = derive([
      { effect: -0.4, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2045, latestYear: 2080 }, domains: ['ocean'] },
      ...forces,
    ]);
    const tight = derive([
      { effect: -0.4, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2058, latestYear: 2062 }, domains: ['ocean'] },
      ...forces,
    ]);
    expect(Math.abs(wide.thresholds[0]!.shiftYears)).toBeGreaterThan(
      Math.abs(tight.thresholds[0]!.shiftYears),
    );
  });

  it('thinner evidence moves the estimate less than a strong, corroborated force', () => {
    const thin = derive([ocean(), { effect: -0.9, significance: 0.9, domains: ['ocean'] }]);
    const strong = derive([
      ocean(),
      ...Array.from({ length: 8 }, () => ({ effect: -0.9, significance: 0.9, domains: ['ocean'] as const })),
    ]);
    expect(Math.abs(strong.shiftYears)).toBeGreaterThan(Math.abs(thin.shiftYears));
  });

  it('climate force reaches an ocean threshold via the upstream link', () => {
    const m = derive([ocean(), { effect: -0.9, significance: 0.9, domains: ['climate'] }]);
    expect(m.shiftYears).toBeLessThan(0);
  });

  it('an UNRELATED-domain force does not move the threshold', () => {
    const calm = derive([ocean()]);
    const withUnrelated = derive([ocean(), { effect: -0.9, significance: 0.9, domains: ['society'] }]);
    expect(withUnrelated.targetYear).toBeCloseTo(calm.targetYear!, 3);
  });

  it('a systemic (undomained) force applies to every threshold', () => {
    const calm = derive([{ effect: 0, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2050, latestYear: 2075 }, domains: ['ocean'] }]);
    const withSystemic = derive([
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2050, latestYear: 2075 }, domains: ['ocean'] },
      { effect: -0.9, significance: 0.9, domains: [] },
    ]);
    expect(withSystemic.targetYear!).toBeLessThan(calm.targetYear!);
  });
});

describe('deriveClock — assumed band from peers', () => {
  it('gives a range-less threshold the median peer half-width', () => {
    const m = derive([
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2050, earliestYear: 2040, latestYear: 2060 }, domains: [] },
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2055 }, domains: [] }, // no range
    ]);
    // Peer half-widths are 10 and 10 → assumed spread 10.
    expect(m.assumedSpreadYears).toBe(10);
  });

  it('reports null when every threshold published its own range', () => {
    const m = derive([
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2050, earliestYear: 2045, latestYear: 2058 }, domains: [] },
    ]);
    expect(m.assumedSpreadYears).toBeNull();
  });
});

describe('deriveClock — derivation output', () => {
  it('reports per-domain forces sorted by influence', () => {
    const m = derive([
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
      { effect: 0.2, significance: 0.1, domains: ['society'] },
      { effect: -0.5, significance: 0.8, tippingPoint: { centralYear: 2050 }, domains: ['ocean'] },
    ]);
    expect(m.domainForces[0]!.domain).toBe('ocean');
    const ocean = m.domainForces.find((f) => f.domain === 'ocean')!;
    expect(ocean.factorCount).toBe(2);
    expect(ocean.netForce).toBeLessThan(0);
  });

  it('lists each threshold with its shift and driving domains', () => {
    const m = derive([
      { effect: -0.4, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2050, latestYear: 2075, label: 'AMOC' }, domains: ['ocean'] },
      { effect: -0.9, significance: 0.9, domains: ['climate'] },
    ]);
    expect(m.thresholds).toHaveLength(1);
    const t = m.thresholds[0]!;
    expect(t.label).toBe('AMOC');
    expect(t.drivingDomains).toContain('ocean');
    expect(t.drivingDomains).toContain('climate'); // upstream
    expect(t.warpedYear).toBeLessThan(t.baselineYear);
  });
});

describe('deriveClock — robustness', () => {
  it('excludes pending factors and counts them', () => {
    const m = derive([
      { effect: -0.8, significance: 0.9, verificationState: 'pending', tippingPoint: { centralYear: 2040 }, domains: ['ocean'] },
      { effect: -0.5, significance: 0.9, verificationState: 'verified', tippingPoint: { centralYear: 2060 }, domains: ['ocean'] },
    ]);
    expect(m.pendingCount).toBe(1);
    expect(m.contributingCount).toBe(1);
    expect(m.baselineTargetYear).toBeGreaterThan(2050);
  });

  it('rejects non-finite values without poisoning the result', () => {
    const m = derive([
      { effect: NaN, significance: 0.9, domains: ['ocean'] },
      { effect: -0.5, significance: Infinity, domains: ['ocean'] },
      { effect: -0.5, significance: 0.9, tippingPoint: { centralYear: 2050 }, domains: ['ocean'] },
    ]);
    expect(m.rejectedCount).toBe(2);
    expect(m.contributingCount).toBe(1);
    expect(Number.isFinite(m.targetYear!)).toBe(true);
  });

  it('drops a tipping point with a non-finite central year', () => {
    const m = derive([
      { effect: -0.5, significance: 0.9, tippingPoint: { centralYear: NaN }, domains: ['ocean'] },
    ]);
    expect(m.hasBaseline).toBe(false);
  });
});

describe('helpers', () => {
  it('confidenceForCount tiers on evidence volume', () => {
    expect(confidenceForCount(0)).toBe('indeterminate');
    expect(confidenceForCount(3)).toBe('low');
    expect(confidenceForCount(10)).toBe('moderate');
    expect(confidenceForCount(30)).toBe('substantial');
  });

  it('yearToEpochMs maps to the calendar-year start', () => {
    expect(yearToEpochMs(2050)).toBe(Date.UTC(2050, 0, 1));
  });

  it('targetDeadlineMs is null without a baseline', () => {
    expect(targetDeadlineMs(derive([]))).toBeNull();
  });
});
