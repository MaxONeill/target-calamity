import { describe, it, expect } from 'vitest';
import { displayWeightScaler, withDisplayWeight } from './displayWeight.js';

describe('displayWeightScaler', () => {
  it('stretches a compressed set across the display range', () => {
    // The corpus this exists for: defensible per-item scores, narrow spread.
    const scale = displayWeightScaler([0.7, 0.75, 0.8, 0.85, 0.9]);
    expect(scale(0.7)).toBeLessThan(0.2);
    expect(scale(0.9)).toBeGreaterThan(0.9);
  });

  it('is monotonic — order is never altered, only spacing', () => {
    const input = [0.2, 0.45, 0.5, 0.62, 0.8, 0.95];
    const scale = displayWeightScaler(input);
    const out = input.map(scale);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
    }
  });

  it('absorbs a single outlier at realistic corpus size', () => {
    // True min/max would compress the whole set into a sliver around the
    // outlier. At the field's actual size (~89) p5 sits past several items, so
    // one extreme value barely moves the scale.
    const body = Array.from({ length: 60 }, (_, i) => 0.7 + (i / 60) * 0.2);
    const withoutOutlier = displayWeightScaler(body);
    const withOutlier = displayWeightScaler([0.001, ...body]);
    expect(Math.abs(withOutlier(0.8) - withoutOutlier(0.8))).toBeLessThan(0.05);
  });

  it('is only weakly robust on a small set — a documented limitation', () => {
    // Below ~20 items the 5th percentile is close to the minimum, so an outlier
    // still shifts the scale. Recorded rather than hidden: it is the reason
    // nothing in the model may depend on this transform.
    const withoutOutlier = displayWeightScaler([0.7, 0.75, 0.8, 0.85, 0.9]);
    const withOutlier = displayWeightScaler([0.001, 0.7, 0.75, 0.8, 0.85, 0.9]);
    expect(withOutlier(0.8)).not.toBeCloseTo(withoutOutlier(0.8), 1);
  });

  it('passes a set with no spread through untouched', () => {
    // Nothing to stretch; amplifying rounding noise would invent structure.
    const scale = displayWeightScaler([0.8, 0.8, 0.8]);
    expect(scale(0.8)).toBe(0.8);
  });

  it('handles a single item and an empty set without producing NaN', () => {
    expect(displayWeightScaler([0.42])(0.42)).toBe(0.42);
    expect(displayWeightScaler([])(0.42)).toBe(0.42);
  });

  it('keeps the lowest factor faintly visible rather than at zero', () => {
    // Zero would read as "no data", which the globe reserves for untinted
    // geography — a real factor must never be indistinguishable from absence.
    const scale = displayWeightScaler([0.1, 0.5, 0.9]);
    expect(scale(0.1)).toBeGreaterThan(0);
  });

  it('clamps values beyond the percentile bounds into range', () => {
    const scale = displayWeightScaler([0.4, 0.5, 0.6]);
    expect(scale(0.99)).toBeLessThanOrEqual(1);
    expect(scale(0.0)).toBeGreaterThanOrEqual(0);
  });
});

describe('withDisplayWeight', () => {
  it('rewrites significance and leaves every other field intact', () => {
    const items = [
      { id: 'a', significance: 0.7, effect: -0.5 },
      { id: 'b', significance: 0.9, effect: 0.2 },
      { id: 'c', significance: 0.8, effect: -0.1 },
    ];
    const out = withDisplayWeight(items);
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(out.map((i) => i.effect)).toEqual([-0.5, 0.2, -0.1]);
    expect(out[1]!.significance).toBeGreaterThan(out[2]!.significance);
  });

  it('does not mutate the input — the Clock keeps the raw scores', () => {
    const items = [{ significance: 0.7 }, { significance: 0.9 }];
    withDisplayWeight(items);
    expect(items[0]!.significance).toBe(0.7);
    expect(items[1]!.significance).toBe(0.9);
  });
});
