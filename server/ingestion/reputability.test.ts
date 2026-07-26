/**
 * Tests for the OFFLINE STUB path of the reputability gate
 * (server/ingestion/reputability.ts).
 *
 * The live LLM judge is never called here — we test the deterministic domain
 * heuristic and the no-credential fallback, plus the verified/pending gating that
 * the worker derives from the score and REPUTABILITY_VERIFY_THRESHOLD.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  scoreSource,
  scoreSourceOffline,
  combineScores,
  REPUTABILITY_VERIFY_THRESHOLD,
  type SourceToScore,
} from './reputability.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const CLAIM = 'Arctic sea ice set a record low maximum in 2025.';

function src(overrides: Partial<SourceToScore>): SourceToScore {
  return {
    url: 'https://www.nature.com/articles/s43247-022-00498-3',
    publisher: 'Nature',
    quoteSnippet: 'The Arctic has warmed nearly four times faster than the globe.',
    claim: CLAIM,
    ...overrides,
  };
}

/** The gating rule the worker applies to the score. */
function gate(score: number): 'verified' | 'pending' {
  return score >= REPUTABILITY_VERIFY_THRESHOLD ? 'verified' : 'pending';
}

describe('scoreSourceOffline — deterministic domain heuristic', () => {
  it('always returns a score within [0, 1] and is deterministic', () => {
    const input = src({ url: 'https://some-unknown-outlet.test/story' });
    const a = scoreSourceOffline(input);
    const b = scoreSourceOffline(input);
    expect(a).toEqual(b);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(a.provenance).toBe('offline-stub');
  });

  it('verifies a reputable curated domain (Nature)', () => {
    const r = scoreSourceOffline(src({ url: 'https://www.nature.com/x' }));
    expect(r.score).toBeGreaterThanOrEqual(REPUTABILITY_VERIFY_THRESHOLD);
    expect(gate(r.score)).toBe('verified');
  });

  it('verifies a government/intergovernmental source (NASA, IEA)', () => {
    expect(gate(scoreSourceOffline(src({ url: 'https://www.nasa.gov/earth' })).score)).toBe(
      'verified',
    );
    expect(gate(scoreSourceOffline(src({ url: 'https://www.iea.org/reports' })).score)).toBe(
      'verified',
    );
  });

  it('leaves a placeholder/self-published domain pending', () => {
    expect(gate(scoreSourceOffline(src({ url: 'https://example.org/x' })).score)).toBe(
      'pending',
    );
    expect(gate(scoreSourceOffline(src({ url: 'https://medium.com/@x/post' })).score)).toBe(
      'pending',
    );
  });

  it('leaves a claim with no source URL pending', () => {
    const r = scoreSourceOffline(src({ url: null }));
    expect(r.score).toBeLessThan(REPUTABILITY_VERIFY_THRESHOLD);
    expect(gate(r.score)).toBe('pending');
  });

  it('penalises plain HTTP transport', () => {
    const https = scoreSourceOffline(src({ url: 'https://www.reuters.com/x' }));
    const http = scoreSourceOffline(src({ url: 'http://www.reuters.com/x' }));
    expect(http.score).toBeLessThan(https.score);
  });
});

describe('scoreSource — no-credential fallback', () => {
  it('uses the offline heuristic when neither provider key is present', async () => {
    vi.stubEnv('FIREWORKS_API_KEY', '');
    vi.stubEnv('FIRECRAWL_API_KEY', '');

    const input = src({ url: 'https://www.nature.com/x' });
    const result = await scoreSource(input);
    expect(result.provenance).toBe('offline-stub');
    expect(result).toEqual(scoreSourceOffline(input));
  });
});

describe('combineScores — credibility and claim support are separate axes', () => {
  // Regression: one conflated score rejected a Nature article at 0.15 while
  // researchgate.net passed, leaving 1 of 99 factors citing primary literature.
  // A paper states its threshold in a table, so any ONE extracted quote supports
  // the claim only partially — a property of quoting a paper, not a defect in it.
  it('lets a primary source with a partial quote clear the bar', () => {
    expect(combineScores(0.95, 0.4)).toBeGreaterThanOrEqual(REPUTABILITY_VERIFY_THRESHOLD);
  });

  it('does not let a perfect quote carry a repost aggregator over it', () => {
    // ResearchGate hosting a real paper is still a mirror, not a publisher.
    expect(combineScores(0.45, 1.0)).toBeLessThan(REPUTABILITY_VERIFY_THRESHOLD);
  });

  it('floors to zero when the quote does not support the claim at all', () => {
    // A mis-cite or hallucinated quote is not rescued by the publisher name.
    expect(combineScores(1.0, 0.05)).toBe(0);
  });

  it('weights credibility above support, the noisier axis', () => {
    expect(combineScores(0.9, 0.5)).toBeGreaterThan(combineScores(0.5, 0.9));
  });
});
