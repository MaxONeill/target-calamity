import { describe, it, expect } from 'vitest';
import {
  deriveClock,
  targetDeadlineMs,
  yearToEpochMs,
  confidenceForCount,
  ELASTICITY_DEFAULT,
  type ClockFactorInput,
} from './clockModel.js';

const NOW = 2025;
const derive = (factors: ClockFactorInput[], elasticity = ELASTICITY_DEFAULT) =>
  deriveClock(factors, { nowYear: NOW, elasticity });

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
      { effect: -0.5, significance: 0.9, tippingPoint: { centralYear: 2040 }, domains: [] },
      { effect: -0.5, significance: 0.9, tippingPoint: { centralYear: 2060 }, domains: [] },
    ]);
    expect(m.baselineTargetYear).toBeGreaterThan(2045);
    expect(m.baselineTargetYear).toBeLessThan(2055);
    expect(m.band).not.toBeNull();
    expect(m.band!.p25).toBeLessThan(m.band!.p50);
    expect(m.band!.p50).toBeLessThan(m.band!.p75);
  });

  it('a heavier threshold pulls the anchor toward its year', () => {
    const m = derive([
      { effect: -0.5, significance: 0.2, tippingPoint: { centralYear: 2040 }, domains: [] },
      { effect: -0.5, significance: 0.9, tippingPoint: { centralYear: 2060 }, domains: [] },
    ]);
    expect(m.baselineTargetYear).toBeGreaterThan(2050);
  });
});

describe('deriveClock — force warp', () => {
  const oceanThreshold: ClockFactorInput = {
    effect: -0.8,
    significance: 0.9,
    tippingPoint: { centralYear: 2060, earliestYear: 2050, latestYear: 2075 },
    domains: ['ocean'],
  };

  it('a domain-matched Calamity force pulls the threshold sooner', () => {
    const calm = derive([oceanThreshold]);
    const withForce = derive([
      oceanThreshold,
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
    ]);
    expect(withForce.targetYear!).toBeLessThan(calm.targetYear!);
    expect(withForce.shiftYears).toBeLessThan(0);
  });

  it('a domain-matched Humanity force pushes the threshold later', () => {
    const withForce = derive([
      oceanThreshold,
      { effect: 0.9, significance: 0.9, domains: ['ocean'] },
    ]);
    expect(withForce.shiftYears).toBeGreaterThan(0);
    expect(withForce.targetYear!).toBeGreaterThan(oceanThreshold.tippingPoint!.centralYear);
  });

  it('climate force reaches an ocean threshold via the upstream link', () => {
    const withClimate = derive([
      oceanThreshold,
      { effect: -0.9, significance: 0.9, domains: ['climate'] },
    ]);
    expect(withClimate.shiftYears).toBeLessThan(0);
  });

  it('an UNRELATED-domain force does not move the threshold', () => {
    const calm = derive([oceanThreshold]);
    const withUnrelated = derive([
      oceanThreshold,
      { effect: -0.9, significance: 0.9, domains: ['society'] },
    ]);
    expect(withUnrelated.targetYear).toBeCloseTo(calm.targetYear!, 3);
  });

  it('a systemic (undomained) force applies to every threshold', () => {
    const calm = derive([oceanThreshold]);
    const withSystemic = derive([
      oceanThreshold,
      { effect: -0.9, significance: 0.9, domains: [] },
    ]);
    expect(withSystemic.targetYear!).toBeLessThan(calm.targetYear!);
  });

  it('elasticity scales the shift; zero elasticity means no warp', () => {
    const none = derive([oceanThreshold, { effect: -0.9, significance: 0.9, domains: ['ocean'] }], 0);
    expect(none.shiftYears).toBeCloseTo(0, 6);
    const more = derive([oceanThreshold, { effect: -0.9, significance: 0.9, domains: ['ocean'] }], 0.6);
    const less = derive([oceanThreshold, { effect: -0.9, significance: 0.9, domains: ['ocean'] }], 0.2);
    expect(Math.abs(more.shiftYears)).toBeGreaterThan(Math.abs(less.shiftYears));
  });

  it('the same force bends a distant threshold more than an imminent one', () => {
    const near = derive([
      { effect: -0.8, significance: 0.9, tippingPoint: { centralYear: 2028 }, domains: ['ocean'] },
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
    ]);
    const far = derive([
      { effect: -0.8, significance: 0.9, tippingPoint: { centralYear: 2075 }, domains: ['ocean'] },
      { effect: -0.9, significance: 0.9, domains: ['ocean'] },
    ]);
    expect(Math.abs(far.shiftYears)).toBeGreaterThan(Math.abs(near.shiftYears));
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
      { effect: -0.8, significance: 0.9, tippingPoint: { centralYear: 2060, label: 'AMOC' }, domains: ['ocean'] },
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
