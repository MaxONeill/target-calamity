import { describe, it, expect } from 'vitest';
import {
  deriveClock,
  targetDeadlineMs,
  yearToEpochMs,
  confidenceForCount,
  type ClockFactorInput,
  type Projection,
  type QuantityThreshold,
} from './clockModel.js';

const derive = (factors: ClockFactorInput[], projections: Projection[] = []) =>
  deriveClock(factors, projections);

/** A neutral-effect factor carrying a window-closing threshold. */
const closer = (centralYear: number, significance = 0.9): ClockFactorInput => ({
  effect: 0,
  significance,
  tippingPoint: { centralYear, closesWindow: true },
  domains: [],
});

describe('deriveClock — anchor', () => {
  it('is indeterminate with no tipping points', () => {
    const m = derive([{ effect: -0.8, significance: 0.9, domains: ['climate'] }]);
    expect(m.hasBaseline).toBe(false);
    expect(m.targetYear).toBeNull();
    expect(m.band).toBeNull();
    // Confidence tiers on ANCHORS, so no anchor means indeterminate even with
    // plenty of evidence. It describes the countdown, and there is no
    // countdown. The factor still counts as evidence — see hasEvidence.
    expect(m.confidence).toBe('indeterminate');
    expect(m.hasEvidence).toBe(true);
  });

  it('is fully indeterminate with no factors at all', () => {
    const m = derive([]);
    expect(m.hasBaseline).toBe(false);
    expect(m.hasEvidence).toBe(false);
    expect(m.confidence).toBe('indeterminate');
  });

  it('tracks the FIRST window-closer, not the average of them', () => {
    // The window closes when the earliest closer is crossed. A median over the
    // catalogue would land between 2040 and 2060; that year is not an event
    // anyone experiences.
    const m = derive([
      closer(2040),
      closer(2060),
    ]);
    expect(m.baselineTargetYear).toBeLessThan(2045);
    expect(m.band).not.toBeNull();
    expect(m.band!.p25).toBeLessThan(m.band!.p50);
    expect(m.band!.p50).toBeLessThan(m.band!.p75);
  });

  it('a later threshold barely moves the estimate; an earlier one pulls it in', () => {
    const alone = derive([closer(2060)]);
    const plusLater = derive([closer(2060), closer(2080)]);
    const plusEarlier = derive([closer(2060), closer(2035)]);

    // Adding a later way to fail changes the FIRST failure only marginally.
    expect(Math.abs(plusLater.baselineTargetYear! - alone.baselineTargetYear!)).toBeLessThan(2);
    // Finding an earlier one is exactly when a course-correction horizon should
    // move, and it moves a lot.
    expect(plusEarlier.baselineTargetYear!).toBeLessThan(alone.baselineTargetYear! - 10);
  });

  it('a thinly-evidenced early threshold contributes less hazard than a strong one', () => {
    const weak = derive([closer(2040, 0.2), closer(2060, 0.9)]);
    const strong = derive([closer(2040, 0.9), closer(2060, 0.9)]);
    expect(strong.baselineTargetYear!).toBeLessThan(weak.baselineTargetYear!);
  });

  it('more ways to fail cannot push the first crossing later', () => {
    const one = derive([closer(2050)]);
    const many = derive([closer(2050), closer(2055), closer(2065)]);
    expect(many.baselineTargetYear!).toBeLessThanOrEqual(one.baselineTargetYear!);
  });
});

describe('deriveClock — thresholds dated from a projection', () => {
  // The tipping-point literature publishes degrees, not years: "Greenland
  // destabilises at ~1.5 degC". Requiring a year excluded exactly the anchors
  // this product exists for. The year is recovered by reading a published
  // trajectory — a lookup across two cited sources, not an estimate.
  const warming: Projection = {
    id: 'p-warm',
    quantity: 'global mean surface temperature anomaly',
    unit: 'degC',
    baseline: 'pre-industrial (1850-1900)',
    assumesFutureAction: false, // a current-policies pathway
    points: [
      { year: 2020, value: 1.1 },
      { year: 2050, value: 2.0 },
      { year: 2100, value: 2.7 },
    ],
  };

  const atWarming = (value: number, extra: Partial<QuantityThreshold> = {}): ClockFactorInput => ({
    effect: -0.6,
    significance: 0.9,
    domains: [],
    tippingPoint: {
      closesWindow: true,
      quantityThreshold: {
        quantity: 'global mean surface temperature anomaly',
        unit: 'degC',
        baseline: 'pre-industrial (1850-1900)',
        value,
        ...extra,
      },
    },
  });

  it('interpolates the crossing year between the bracketing points', () => {
    // 1.55 degC is halfway from 1.1 (2020) to 2.0 (2050) → 2035.
    const m = derive([atWarming(1.55)], [warming]);
    expect(m.thresholds).toHaveLength(1);
    expect(m.thresholds[0]!.baselineYear).toBeCloseTo(2035, 0);
    expect(m.thresholds[0]!.dating).toBe('projected');
  });

  it('handles a falling quantity, crossed from above', () => {
    const ph: Projection = {
      quantity: 'ocean surface pH',
      unit: 'pH',
      assumesFutureAction: false,
      points: [
        { year: 2020, value: 8.1 },
        { year: 2100, value: 7.7 },
      ],
    };
    const m = derive(
      [
        {
          effect: -0.6,
          significance: 0.9,
          domains: [],
          tippingPoint: {
            closesWindow: true,
            quantityThreshold: { quantity: 'ocean surface pH', unit: 'pH', value: 7.9 },
          },
        },
      ],
      [ph],
    );
    expect(m.thresholds[0]!.baselineYear).toBeCloseTo(2060, 0);
  });

  it('carries the SOURCE range through, rather than an assumed spread', () => {
    const m = derive([atWarming(1.55, { lowValue: 1.1, highValue: 2.0 })], [warming]);
    expect(m.assumedSpreadYears).toBeNull(); // no fallback spread was needed
    expect(m.band).not.toBeNull();
  });

  it('refuses when the curve never reaches the value in its published span', () => {
    // 3.5 degC is beyond the projection's last point. Extrapolating would be
    // inventing a year, so the threshold is dropped entirely.
    const m = derive([atWarming(3.5)], [warming]);
    expect(m.datedThresholdCount).toBe(0);
    expect(m.hasBaseline).toBe(false);
  });

  it('refuses when the baselines disagree', () => {
    // Same quantity, same unit, ~0.6 degC apart. Matching these produces a
    // confidently wrong year, which is worse than no anchor.
    const m = derive([atWarming(1.55, { baseline: 'vs 1986-2005' })], [warming]);
    expect(m.datedThresholdCount).toBe(0);
  });

  it('refuses when only one side states a baseline', () => {
    // Destructured out rather than set to undefined: under
    // exactOptionalPropertyTypes an explicit `undefined` is not the same as an
    // absent key, and absent is what a source with no stated baseline gives us.
    const { baseline: _omitted, ...noBaseline } = warming;
    const m = derive([atWarming(1.55)], [noBaseline]);
    expect(m.datedThresholdCount).toBe(0);
  });

  it('refuses when no projection covers the quantity', () => {
    const m = derive([atWarming(1.55)], []);
    expect(m.datedThresholdCount).toBe(0);
  });
});

describe('deriveClock — forces vs scenario double-counting', () => {
  const curve = (assumesFutureAction: boolean | undefined): Projection => ({
    quantity: 'co2 concentration',
    unit: 'ppm',
    ...(assumesFutureAction === undefined ? {} : { assumesFutureAction }),
    points: [
      { year: 2020, value: 415 },
      { year: 2100, value: 615 },
    ],
  });

  const threshold: ClockFactorInput = {
    effect: -0.6,
    significance: 0.9,
    domains: ['climate'],
    tippingPoint: {
      closesWindow: true,
      quantityThreshold: { quantity: 'co2 concentration', unit: 'ppm', value: 500 },
    },
  };
  const humanityForce: ClockFactorInput = {
    effect: 0.9,
    significance: 0.9,
    domains: ['climate'],
  };

  it('applies forces to a no-further-action curve', () => {
    const m = derive([threshold, humanityForce], [curve(false)]);
    expect(m.thresholds[0]!.forcesApply).toBe(true);
  });

  it('withholds forces when the scenario already assumes future action', () => {
    // A mitigation pathway has the clean-energy expansion baked in. Bending it
    // with a clean-energy factor counts the same action twice.
    const m = derive([threshold, humanityForce], [curve(true)]);
    expect(m.thresholds[0]!.forcesApply).toBe(false);
    expect(m.thresholds[0]!.shiftYears).toBe(0);
    expect(m.thresholds[0]!.anchors).toBe(true); // still dated, still anchoring
  });

  it('treats an unlabelled scenario as assuming action', () => {
    // Guessing permissively is what makes the Clock read later than any source
    // supports, so an unlabelled curve gets the conservative treatment.
    const m = derive([threshold, humanityForce], [curve(undefined)]);
    expect(m.thresholds[0]!.forcesApply).toBe(false);
  });

  it('always applies forces to a directly published year', () => {
    const m = derive([closer(2050), humanityForce], []);
    expect(m.thresholds[0]!.dating).toBe('published');
    expect(m.thresholds[0]!.forcesApply).toBe(true);
  });
});

describe('deriveClock — only window-closers anchor', () => {
  it('ignores a dated threshold that does not close the window', () => {
    const m = derive([
      { effect: -0.8, significance: 0.9, tippingPoint: { centralYear: 2035 }, domains: [] },
    ]);
    expect(m.datedThresholdCount).toBe(1);
    expect(m.tippingPointCount).toBe(0);
    expect(m.hasBaseline).toBe(false);
    expect(m.targetYear).toBeNull();
  });

  it('still reports the non-anchoring threshold as evidence', () => {
    const m = derive([
      { effect: -0.8, significance: 0.9, tippingPoint: { centralYear: 2035 }, domains: [] },
      closer(2050),
    ]);
    expect(m.thresholds).toHaveLength(2);
    expect(m.thresholds.filter((t) => t.anchors)).toHaveLength(1);
    // Anchors sort first regardless of year, so the reader sees what the
    // countdown rests on before what merely informs it.
    expect(m.thresholds[0]!.anchors).toBe(true);
    expect(m.thresholds[0]!.baselineYear).toBe(2050);
  });

  it('a non-boolean closesWindow never silently anchors', () => {
    // JSONB is unvalidated at the DB boundary, so anything can arrive in this
    // key. Only a literal `true` counts; the cast here stands in for that
    // untrusted read path.
    const m = derive([
      {
        effect: -0.8,
        significance: 0.9,
        tippingPoint: { centralYear: 2035, closesWindow: 'yes' as unknown as boolean },
        domains: [],
      },
    ]);
    expect(m.tippingPointCount).toBe(0);
  });

  it('suppresses when the anchors never reach even odds', () => {
    // One closer at significance 0.4 tops out at a 40% chance of ever closing.
    // Naming a year would assert more than the evidence supports.
    const m = derive([closer(2040, 0.4)]);
    expect(m.tippingPointCount).toBe(1);
    expect(m.targetYear).toBeNull();
    expect(m.hasBaseline).toBe(false);
    expect(m.band).toBeNull();
  });

  it('two moderate closers together can clear the bar one alone cannot', () => {
    const alone = derive([closer(2040, 0.4)]);
    const pair = derive([closer(2040, 0.4), closer(2045, 0.4)]);
    expect(alone.targetYear).toBeNull();
    expect(pair.targetYear).not.toBeNull(); // 1 − 0.6·0.6 = 0.64 ≥ 0.5
  });
});

describe('deriveClock — beneficial milestones do not anchor the countdown', () => {
  // Regression: "China's record clean energy deployment" (effect +0.85) carried
  // Ember's 2028 projection for clean electricity meeting all demand growth. It
  // was the nearest and heaviest dated event in the set, so the countdown to
  // the closing of the course-correction window was pulled IN by good news, and
  // the Why panel painted its shift Calamity red because "sooner" reads as
  // "worse". The countdown may only anchor on thresholds it counts DOWN to.
  const milestone: ClockFactorInput = {
    effect: 0.85,
    significance: 0.9,
    tippingPoint: { centralYear: 2028, earliestYear: 2025, latestYear: 2029 },
    domains: ['climate', 'economy'],
  };
  const deadline: ClockFactorInput = {
    effect: -0.7,
    significance: 0.8,
    tippingPoint: {
      centralYear: 2050,
      earliestYear: 2045,
      latestYear: 2055,
      closesWindow: true,
    },
    domains: ['climate'],
  };

  it('excludes a positive-effect factor’s threshold from the anchor set', () => {
    const m = derive([milestone, deadline]);
    expect(m.tippingPointCount).toBe(1);
    expect(m.thresholds).toHaveLength(1);
  });

  it('does not let good news pull the target year earlier', () => {
    const withMilestone = derive([milestone, deadline]);
    const withoutMilestone = derive([deadline]);
    expect(withMilestone.baselineTargetYear).toBe(withoutMilestone.baselineTargetYear);
  });

  it('still counts the milestone as a Humanity force', () => {
    const m = derive([milestone, deadline]);
    // It contributes to the aggregate and pushes the remaining threshold later,
    // which is the influence a beneficial factor should have.
    expect(m.contributingCount).toBe(2);
    expect(m.humanityBuffer).toBeGreaterThan(0);
    expect(m.thresholds[0]!.warpedYear).toBeGreaterThan(2050);
  });

  it('a neutral factor may still carry a real deadline', () => {
    const m = derive([
      {
        effect: 0,
        significance: 0.8,
        tippingPoint: { centralYear: 2040, closesWindow: true },
        domains: ['ocean'],
      },
    ]);
    expect(m.tippingPointCount).toBe(1);
  });
});

describe('deriveClock — forces interpolate within the published range', () => {
  const ocean = (centralYear = 2060): ClockFactorInput => ({
    effect: -0.4,
    significance: 0.9,
    tippingPoint: { centralYear, earliestYear: 2050, latestYear: 2075, closesWindow: true },
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
    // The threshold carrier is adverse; the FORCES are what is positive. A
    // positive carrier no longer anchors at all (see the beneficial-milestone
    // suite below), and the net ocean force here is still Humanity:
    // (-0.4 + 0.9 + 0.9) weighted → +0.47.
    const m = derive([
      ocean(),
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
      { effect: -0.4, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2045, latestYear: 2080, closesWindow: true }, domains: ['ocean'] },
      ...forces,
    ]);
    const tight = derive([
      { effect: -0.4, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2058, latestYear: 2062, closesWindow: true }, domains: ['ocean'] },
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
    const anchor: ClockFactorInput = { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2060, earliestYear: 2050, latestYear: 2075, closesWindow: true }, domains: ['ocean'] };
    const calm = derive([anchor]);
    const withSystemic = derive([anchor, { effect: -0.9, significance: 0.9, domains: [] }]);
    expect(withSystemic.targetYear!).toBeLessThan(calm.targetYear!);
  });
});

describe('deriveClock — assumed band from peers', () => {
  it('gives a range-less threshold the median peer half-width', () => {
    const m = derive([
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2050, earliestYear: 2040, latestYear: 2060, closesWindow: true }, domains: [] },
      { effect: 0, significance: 0.9, tippingPoint: { centralYear: 2055, closesWindow: true }, domains: [] }, // no range
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
      { effect: -0.8, significance: 0.9, verificationState: 'pending', tippingPoint: { centralYear: 2040, closesWindow: true }, domains: ['ocean'] },
      { effect: -0.5, significance: 0.9, verificationState: 'verified', tippingPoint: { centralYear: 2060, closesWindow: true }, domains: ['ocean'] },
    ]);
    expect(m.pendingCount).toBe(1);
    expect(m.contributingCount).toBe(1);
    expect(m.baselineTargetYear).toBeGreaterThan(2050);
  });

  it('rejects non-finite values without poisoning the result', () => {
    const m = derive([
      { effect: NaN, significance: 0.9, domains: ['ocean'] },
      { effect: -0.5, significance: Infinity, domains: ['ocean'] },
      { effect: -0.5, significance: 0.9, tippingPoint: { centralYear: 2050, closesWindow: true }, domains: ['ocean'] },
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
