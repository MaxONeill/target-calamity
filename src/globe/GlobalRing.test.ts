import { describe, it, expect } from 'vitest';
import { fieldInfluence, orderByInfluence } from './GlobalRing.js';

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
