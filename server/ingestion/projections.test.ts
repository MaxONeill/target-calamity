/**
 * Tests for projection extraction (server/ingestion/projections.ts).
 *
 * Offline only: the live path needs both provider keys. What matters here is
 * the REJECTION behaviour. A projection's blast radius is larger than a
 * factor's — a wrong curve mis-dates every threshold pinned to its quantity,
 * silently — so every case below is one where returning nothing beats returning
 * something plausible.
 */
import { describe, it, expect } from 'vitest';
import { normalizeProjection, projectionQuery } from './projections.js';

const docs = [
  {
    url: 'https://climateactiontracker.org/global/temperatures/',
    title: 'Global temperatures',
    publisher: 'climateactiontracker.org',
    description: '',
    markdown: 'text',
  },
];

const base = {
  found: true,
  quantity: 'global mean surface temperature anomaly',
  unit: 'degC',
  baseline: 'pre-industrial (1850-1900)',
  scenario: 'current policies',
  assumesFutureAction: false,
  points: [
    { year: 2020, value: 1.1 },
    { year: 2100, value: 2.7 },
  ],
  sourceIndex: 1,
  quote: 'Warming reaches 2.7C by 2100 under current policies, from 1.1C in 2020.',
};

describe('normalizeProjection', () => {
  it('keeps a well-formed curve and resolves the source', () => {
    const p = normalizeProjection(base, docs);
    expect(p).toEqual({
      quantity: 'global mean surface temperature anomaly',
      unit: 'degC',
      baseline: 'pre-industrial (1850-1900)',
      scenario: 'current policies',
      assumesFutureAction: false,
      points: [
        { year: 2020, value: 1.1 },
        { year: 2100, value: 2.7 },
      ],
      sourceUrl: 'https://climateactiontracker.org/global/temperatures/',
      sourceTitle: 'Global temperatures',
    });
  });

  it('drops the curve when the model reports no usable trajectory', () => {
    expect(normalizeProjection({ ...base, found: false }, docs)).toBeNull();
  });

  it('drops a curve with fewer than two points', () => {
    // One point cannot be interpolated; inventing a second is the failure mode.
    expect(
      normalizeProjection({ ...base, points: [{ year: 2050, value: 2 }] }, docs),
    ).toBeNull();
  });

  it('drops a hallucinated source index rather than inventing a URL', () => {
    expect(normalizeProjection({ ...base, sourceIndex: 99 }, docs)).toBeNull();
    expect(normalizeProjection({ ...base, sourceIndex: 0 }, docs)).toBeNull();
  });

  it('sorts points and collapses duplicate years', () => {
    // Two values for one year make interpolation ambiguous. The first stated
    // wins rather than an averaged invention.
    const p = normalizeProjection(
      {
        ...base,
        points: [
          { year: 2100, value: 2.7 },
          { year: 2020, value: 1.1 },
          { year: 2020, value: 1.4 },
        ],
      },
      docs,
    );
    expect(p!.points).toEqual([
      { year: 2020, value: 1.1 },
      { year: 2100, value: 2.7 },
    ]);
  });

  it('drops non-finite points and rejects if too few survive', () => {
    expect(
      normalizeProjection(
        { ...base, points: [{ year: 2020, value: Number.NaN }, { year: 2100, value: 2.7 }] },
        docs,
      ),
    ).toBeNull();
  });

  it('omits an unstated baseline rather than inventing one', () => {
    // The model refuses to match a threshold whose baseline it cannot confirm,
    // so absent must stay absent — never filled in with a plausible default.
    const p = normalizeProjection({ ...base, baseline: null }, docs);
    expect(p).not.toBeNull();
    expect(p).not.toHaveProperty('baseline');
  });

  it('treats an unstated scenario as assuming future action', () => {
    // An unlabelled pathway cannot be shown to be assumption-free, and guessing
    // permissively is what lets forces double-count against a curve.
    const p = normalizeProjection(
      { ...base, scenario: null, assumesFutureAction: true },
      docs,
    );
    expect(p!.assumesFutureAction).toBe(true);
    expect(p).not.toHaveProperty('scenario');
  });

  it('drops a curve with no quantity or no unit', () => {
    expect(normalizeProjection({ ...base, quantity: '  ' }, docs)).toBeNull();
    expect(normalizeProjection({ ...base, unit: '' }, docs)).toBeNull();
  });
});

describe('projectionQuery', () => {
  it('asks for the requested quantity, aimed at pages carrying a series', () => {
    // Milestone years and "table" on purpose: a query for the narrative returns
    // explainers that state one endpoint, and one point cannot be interpolated.
    const q = projectionQuery({ quantity: 'ocean surface pH', unit: 'pH' });
    expect(q).toContain('ocean surface pH');
    expect(q).toContain('projected values');
    expect(q).toContain('2100');
  });
});
