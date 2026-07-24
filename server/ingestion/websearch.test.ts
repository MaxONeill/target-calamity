/**
 * Tests for the OFFLINE STUB path of Phase A research (server/ingestion/websearch.ts).
 *
 * These never touch the network or the live API — they exercise the deterministic
 * offline stub and the no-credential fallback. The live path (Firecrawl retrieval
 * + typed extraction) is intentionally NOT called here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  normalizeCandidate,
  renderSourceBlocks,
  researchFactors,
  researchFactorsOffline,
} from './websearch.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('researchFactorsOffline — deterministic offline candidates', () => {
  it('is deterministic for a given topic', () => {
    expect(researchFactorsOffline('arctic sea ice record low')).toEqual(
      researchFactorsOffline('arctic sea ice record low'),
    );
  });

  it('varies by topic', () => {
    expect(researchFactorsOffline('permafrost carbon feedback')).not.toEqual(
      researchFactorsOffline('clean energy investment'),
    );
  });

  it('produces at least one candidate with in-domain values', () => {
    const candidates = researchFactorsOffline('global biodiversity loss');
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      // effect is a SIGNED direction in [-1, 1]; significance a magnitude in [0, 1].
      expect(c.effect).toBeGreaterThanOrEqual(-1);
      expect(c.effect).toBeLessThanOrEqual(1);
      expect(c.significance).toBeGreaterThanOrEqual(0);
      expect(c.significance).toBeLessThanOrEqual(1);
      expect(c.lat).toBeGreaterThanOrEqual(-90);
      expect(c.lat).toBeLessThanOrEqual(90);
      expect(c.lon).toBeGreaterThanOrEqual(-180);
      expect(c.lon).toBeLessThanOrEqual(180);
      expect(c.spatialPath).toBe('global');
      expect(c.sources.length).toBeGreaterThan(0);
      // Offline sources are deliberate placeholders (kept 'pending' by the gate).
      expect(c.sources[0]!.url).toMatch(/^https:\/\/example\.org\//);
      expect(c.sources[0]!.verbatim).toBe(false);
    }
  });
});

describe('researchFactors — no-credential fallback', () => {
  it('returns the offline stub when neither provider key is present', async () => {
    vi.stubEnv('FIREWORKS_API_KEY', '');
    vi.stubEnv('FIRECRAWL_API_KEY', '');

    const topic = 'sea-level rise projections';
    const result = await researchFactors(topic);
    expect(result).toEqual(researchFactorsOffline(topic));
  });

  it('honours maxCandidates as an upper bound', async () => {
    vi.stubEnv('FIREWORKS_API_KEY', '');
    vi.stubEnv('FIRECRAWL_API_KEY', '');

    const result = await researchFactors('economic inequality trends', {
      maxCandidates: 1,
    });
    expect(result.length).toBeLessThanOrEqual(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  — provenance assembly from Firecrawl results                        */
/* -------------------------------------------------------------------------- */

describe('normalizeCandidate — citations resolve to REAL retrieved sources', () => {
  const docs = [
    {
      url: 'https://nsidc.org/report',
      title: 'Sea ice',
      publisher: 'nsidc.org',
      description: '',
      markdown: 'text',
    },
    {
      url: 'https://www.iea.org/reports/x',
      title: 'Energy',
      publisher: 'iea.org',
      description: '',
      markdown: 'text',
    },
  ];

  const base = {
    name: 'Test factor',
    description: 'A description.',
    effect: -0.5,
    significance: 0.6,
    lat: 10,
    lon: 20,
    spatialPath: 'global',
    tippingPoint: null,
  };

  it('substitutes the retrieved URL + publisher for a cited index', () => {
    const c = normalizeCandidate(
      { ...base, sources: [{ sourceIndex: 2, quoteSnippet: 'a quote', verbatim: true }] },
      docs,
    );
    expect(c!.sources).toEqual([
      {
        url: 'https://www.iea.org/reports/x',
        publisher: 'iea.org',
        quoteSnippet: 'a quote',
        verbatim: true,
      },
    ]);
  });

  it('drops a hallucinated / out-of-range source index rather than inventing a URL', () => {
    const c = normalizeCandidate(
      {
        ...base,
        sources: [
          { sourceIndex: 99, quoteSnippet: 'q', verbatim: false },
          { sourceIndex: 0, quoteSnippet: 'q', verbatim: false },
          { sourceIndex: 1, quoteSnippet: 'kept', verbatim: false },
        ],
      },
      docs,
    );
    expect(c!.sources).toHaveLength(1);
    expect(c!.sources[0]!.url).toBe('https://nsidc.org/report');
  });

  it('drops a citation with an empty quote', () => {
    const c = normalizeCandidate(
      { ...base, sources: [{ sourceIndex: 1, quoteSnippet: '   ', verbatim: true }] },
      docs,
    );
    expect(c!.sources).toEqual([]);
  });

  it('clamps out-of-domain numbers and collapses a bad spatialPath', () => {
    const c = normalizeCandidate(
      { ...base, effect: -5, significance: 9, lat: 200, lon: -900, spatialPath: 'Nope!', sources: [] },
      docs,
    );
    expect(c).toMatchObject({
      effect: -1,
      significance: 1,
      lat: 90,
      lon: -180,
      spatialPath: 'global',
    });
  });

  it('keeps a dated tipping point, including a contested year-range', () => {
    const c = normalizeCandidate(
      {
        ...base,
        tippingPoint: {
          centralYear: 2057,
          earliestYear: 2025,
          latestYear: 2095,
          label: 'AMOC collapse (Ditlevsen & Ditlevsen 2023)',
        },
        sources: [{ sourceIndex: 1, quoteSnippet: 'q', verbatim: true }],
      },
      docs,
    );
    expect(c!.tippingPoint).toEqual({
      centralYear: 2057,
      earliestYear: 2025,
      latestYear: 2095,
      label: 'AMOC collapse (Ditlevsen & Ditlevsen 2023)',
    });
  });

  it('omits the tipping point when the model returns null', () => {
    const c = normalizeCandidate(
      { ...base, tippingPoint: null, sources: [{ sourceIndex: 1, quoteSnippet: 'q', verbatim: true }] },
      docs,
    );
    expect(c!.tippingPoint).toBeUndefined();
  });
});

describe('renderSourceBlocks', () => {
  it('numbers sources from 1 and includes their real URLs', () => {
    const out = renderSourceBlocks([
      { url: 'https://a.test/1', title: 'A', publisher: 'a.test', description: '', markdown: 'body A' },
      { url: 'https://b.test/2', title: 'B', publisher: 'b.test', description: 'desc B', markdown: '' },
    ]);
    expect(out).toContain('SOURCE 1');
    expect(out).toContain('https://a.test/1');
    expect(out).toContain('body A');
    expect(out).toContain('SOURCE 2');
    // Falls back to the search snippet when no markdown was scraped.
    expect(out).toContain('desc B');
  });
});
