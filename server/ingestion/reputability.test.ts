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
