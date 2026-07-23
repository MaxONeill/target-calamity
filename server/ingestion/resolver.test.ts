/**
 * Offline tests for the Phase D resolver (server/ingestion/resolver.ts) and the
 * deterministic fallback (`createStubResolver` in pipeline.ts).
 *
 * The live LLM is NEVER called here. We test the pure proposal→verdict mapping,
 * the domain clamping, the directionality derivation, and the
 * deterministic stub resolver that is the offline path.
 */
import { describe, it, expect } from 'vitest';
import {
  clampTo,
  deriveDirectionality,
  verdictFromProposal,
  type ResolutionProposal,
} from './resolver.js';
import { createStubResolver, type ResolutionRequest } from './pipeline.js';

function req(overrides: Partial<ResolutionRequest> = {}): ResolutionRequest {
  return {
    incoming: {
      name: 'Incoming',
      description: 'An incoming factor.',
      effect: -0.5,
      significance: 0.5,
      spatialPath: 'global',
    },
    candidates: [
      { id: 'c1', name: 'Nearest', description: 'x', effect: -0.4, significance: 0.5, distance: 0.05 },
      { id: 'c2', name: 'Farther', description: 'y', effect: -0.2, significance: 0.3, distance: 0.2 },
    ],
    ...overrides,
  };
}

describe('clampTo — domain clamping (ADR-11a)', () => {
  it('clamps into range and collapses non-finite to lo', () => {
    expect(clampTo(2, -1, 1)).toBe(1);
    expect(clampTo(-2, -1, 1)).toBe(-1);
    expect(clampTo(0.3, 0, 1)).toBe(0.3);
    expect(clampTo(Number.NaN, 0, 1)).toBe(0);
    expect(clampTo(Number.POSITIVE_INFINITY, 0, 1)).toBe(0);
  });
});

describe('deriveDirectionality', () => {
  it('is corroborating when significance unstated or ~equal', () => {
    expect(deriveDirectionality(undefined, 0.5)).toBe('corroborating');
    expect(deriveDirectionality(0.5, 0.5)).toBe('corroborating');
  });
  it('intensifies when proposed significance is materially higher', () => {
    expect(deriveDirectionality(0.8, 0.5)).toBe('intensifying');
  });
  it('de-escalates when proposed significance is materially lower', () => {
    expect(deriveDirectionality(0.2, 0.5)).toBe('de-escalating');
  });
  it('clamps an out-of-domain proposal before comparing', () => {
    // 5 → clamps to 1 (> parent) → intensifying; -5 → clamps to 0 (< parent).
    expect(deriveDirectionality(5, 0.5)).toBe('intensifying');
    expect(deriveDirectionality(-5, 0.5)).toBe('de-escalating');
  });
});

describe('verdictFromProposal', () => {
  it('maps an independent proposal to an insert verdict', () => {
    const p: ResolutionProposal = { relation: 'independent', rationale: 'distinct' };
    expect(verdictFromProposal(p, req())).toEqual({ kind: 'independent' });
  });

  it('escalates against the NEAREST candidate (never a named/hallucinated id)', () => {
    const p: ResolutionProposal = {
      relation: 'escalation',
      updatedSignificance: 0.9,
      rationale: 'same ongoing event, worse',
    };
    const v = verdictFromProposal(p, req());
    expect(v).toEqual({ kind: 'escalation', parentId: 'c1', directionality: 'intensifying' });
  });

  it('falls back to independent when escalation has no candidates', () => {
    const p: ResolutionProposal = { relation: 'escalation', rationale: 'x' };
    expect(verdictFromProposal(p, req({ candidates: [] }))).toEqual({ kind: 'independent' });
  });

  it('defaults to corroborating when escalation omits a proposed significance', () => {
    const p: ResolutionProposal = { relation: 'escalation', rationale: 'more evidence' };
    const v = verdictFromProposal(p, req());
    expect(v).toEqual({ kind: 'escalation', parentId: 'c1', directionality: 'corroborating' });
  });
});

describe('createStubResolver — deterministic offline fallback', () => {
  it('escalates the nearest candidate within the collision threshold', async () => {
    const r = createStubResolver(0.15);
    const v = await r.resolve(req());
    expect(v).toEqual({ kind: 'escalation', parentId: 'c1', directionality: 'corroborating' });
  });

  it('declares independent when the nearest candidate is beyond the threshold', async () => {
    const r = createStubResolver(0.15);
    const v = await r.resolve(
      req({
        candidates: [
          { id: 'c1', name: 'n', description: 'x', effect: -0.4, significance: 0.5, distance: 0.25 },
        ],
      }),
    );
    expect(v).toEqual({ kind: 'independent' });
  });

  it('declares independent when there are no candidates', async () => {
    const r = createStubResolver();
    expect(await r.resolve(req({ candidates: [] }))).toEqual({ kind: 'independent' });
  });
});
