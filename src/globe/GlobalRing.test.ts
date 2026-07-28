import { describe, it, expect } from 'vitest';
import { arcGap, arcSweeps, fieldInfluence, orderByInfluence } from './GlobalRing.js';

const f = (id: string, effect: number, significance: number) => ({
  id,
  effect,
  significance,
});

describe('fieldInfluence', () => {
  it('is |effect| * significance, so polarity does not change weight', () => {
    // A strong Humanity factor weighs as much as an equally strong Calamity one;
    // direction is carried by effect's sign elsewhere, not by its magnitude here.
    expect(fieldInfluence(f('a', -0.8, 0.5))).toBeCloseTo(0.4);
    expect(fieldInfluence(f('b', 0.8, 0.5))).toBeCloseTo(0.4);
  });

  it('floors a negative significance at zero rather than flipping the sign', () => {
    expect(fieldInfluence(f('a', -0.8, -0.5))).toBe(0);
  });
});

describe('orderByInfluence', () => {
  it('ranks by influence, not by significance alone', () => {
    // The bug this fixes: `hi-sig` has the larger significance but the smaller
    // influence, so ordering by significance would put it first while the arc
    // widths said otherwise.
    const ordered = orderByInfluence([
      f('hi-sig', 0.1, 0.9), // influence 0.09
      f('hi-inf', 0.9, 0.5), // influence 0.45
    ]);
    expect(ordered.map((x) => x.id)).toEqual(['hi-inf', 'hi-sig']);
  });

  it('is descending', () => {
    const ordered = orderByInfluence([f('c', 0.2, 0.2), f('a', 0.9, 0.9), f('b', 0.5, 0.5)]);
    expect(ordered.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties on id so arcs cannot swap between renders', () => {
    const ordered = orderByInfluence([f('z', 0.5, 0.5), f('a', 0.5, 0.5)]);
    expect(ordered.map((x) => x.id)).toEqual(['a', 'z']);
  });

  it('does not mutate its input', () => {
    const input = [f('c', 0.2, 0.2), f('a', 0.9, 0.9)];
    orderByInfluence(input);
    expect(input.map((x) => x.id)).toEqual(['c', 'a']);
  });

  it('handles an empty set', () => {
    expect(orderByInfluence([])).toEqual([]);
  });
});

describe('arcSweeps', () => {
  const usable = (n: number): number => Math.PI * 2 - arcGap(n) * n;

  /** The live shape: 74 placeless factors, influence 0.03 … 0.80. */
  const liveSet = (): { effect: number; significance: number }[] => [
    { effect: -0.03, significance: 1 }, // "Three reviews completed"
    { effect: -0.05, significance: 1 },
    ...Array.from({ length: 72 }, (_, i) => ({
      effect: -(0.1 + (i % 8) * 0.09),
      significance: 1,
    })),
  ];

  it('sums to the angle available, so the ring closes exactly', () => {
    const factors = liveSet();
    const total = arcSweeps(factors, usable(factors.length)).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(usable(factors.length), 10);
  });

  it('gives the lightest factor a far bigger sliver than proportional alone', () => {
    // The reported bug: at 74 factors the smallest swept ~0.0034 rad, about a
    // pixel. Anything an order of magnitude better is the point of the floor.
    const factors = liveSet();
    const sweeps = arcSweeps(factors, usable(factors.length));
    const smallest = Math.min(...sweeps);
    const proportionalOnly = usable(factors.length) * (0.03 / 32.5);

    expect(smallest).toBeGreaterThan(proportionalOnly * 5);
  });

  it('never lets the floors exceed the angle that exists', () => {
    // A flat floor at high counts would reserve more than the ring has and
    // push arcs past 2*pi, overlapping the start of the ring.
    for (const n of [1, 5, 40, 74, 150, 400]) {
      const factors = Array.from({ length: n }, () => ({ effect: -0.5, significance: 0.5 }));
      const sweeps = arcSweeps(factors, usable(n));
      expect(sweeps.every((s) => s >= 0)).toBe(true);
      expect(sweeps.reduce((a, b) => a + b, 0)).toBeCloseTo(usable(n), 8);
    }
  });

  it('preserves ORDER — a heavier factor is never given a narrower arc', () => {
    // The floor may flatten differences; it must never invert them.
    const factors = [
      { effect: -0.8, significance: 1 },
      { effect: -0.4, significance: 1 },
      { effect: -0.03, significance: 1 },
    ];
    const sweeps = arcSweeps(factors, usable(3));
    expect(sweeps[0]).toBeGreaterThanOrEqual(sweeps[1] ?? 0);
    expect(sweeps[1]).toBeGreaterThanOrEqual(sweeps[2] ?? 0);
  });

  it('keeps arcs above the floor proportional to each other', () => {
    // What survives the floor: two heavy factors still compare correctly, so
    // width is still a magnitude wherever it is not clamped.
    const factors = [
      { effect: -0.8, significance: 1 },
      { effect: -0.4, significance: 1 },
    ];
    const [a, b] = arcSweeps(factors, usable(2));
    const floorEach = Math.min(0.045, (usable(2) / 2) * 0.5);
    expect((a ?? 0) - floorEach).toBeCloseTo(2 * ((b ?? 0) - floorEach), 6);
  });

  it('falls back to equal widths when every influence is zero', () => {
    const factors = Array.from({ length: 4 }, () => ({ effect: 0, significance: 0 }));
    const sweeps = arcSweeps(factors, usable(4));
    for (const s of sweeps) expect(s).toBeCloseTo(usable(4) / 4, 8);
  });

  it('handles an empty set and a non-positive budget', () => {
    expect(arcSweeps([], usable(0))).toEqual([]);
    expect(arcSweeps([{ effect: -1, significance: 1 }], 0)).toEqual([0]);
  });
});

describe('arcGap', () => {
  it('uses the preferred gap while the ring has room', () => {
    expect(arcGap(4)).toBeCloseTo(0.035, 6);
  });

  it('keeps the usable angle POSITIVE at any count', () => {
    // The bug this exists for: a fixed 0.035 gap consumes the whole circle at
    // 179 factors and overruns it past that, so arcs were laid out from a
    // negative budget and wrapped back over the start of the ring.
    for (const n of [1, 74, 179, 180, 400, 5000]) {
      const usable = Math.PI * 2 - arcGap(n) * n;
      expect(usable).toBeGreaterThan(0);
    }
  });

  it('never lets gaps claim more than their share of the circle', () => {
    for (const n of [74, 180, 400]) {
      expect(arcGap(n) * n).toBeLessThanOrEqual(Math.PI * 2 * 0.35 + 1e-9);
    }
  });

  it('hands angle back to the arcs at the live count', () => {
    // 74 placeless factors today: the gap tightens and the arcs get the rest.
    expect(arcGap(74)).toBeLessThan(0.035);
    expect(Math.PI * 2 - arcGap(74) * 74).toBeGreaterThan(Math.PI * 2 - 0.035 * 74);
  });
});
