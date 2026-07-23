/**
 * Tests for the PURE Phase C/D decision math (server/ingestion/dedupe.ts).
 *
 * This is the arithmetic that decides whether an inbound report escalates an
 * existing factor or lands as a new one, and by how much a parent's weight moves
 * — the part the module README claims is "pure and unit-testable in isolation".
 * No I/O, no database, no LLM: candidates and a verdict go in, a deterministic
 * outcome comes out.
 *
 * Ownership focus:
 *   - recalculateOnEscalation: bounded + convex + correct monotonicity per
 *     directionality (significance may only fall when de-escalating).
 *   - compareCandidates / selectParent: a TOTAL, stable order (distance → age →
 *     id) so two workers never disagree on the parent.
 *   - resolveOutcome: the deterministic guards around a possibly-vague verdict
 *     (unknown/ hallucinated parent id falls back to the nearest candidate).
 */
import { describe, it, expect } from 'vitest';
import {
  compareCandidates,
  escalationLambda,
  filterCandidates,
  recalculateOnEscalation,
  resolveOutcome,
  selectParent,
  CANDIDATE_DISTANCE_CEILING,
  type FactorCandidate,
  type ResolverVerdict,
} from './dedupe.js';

function candidate(overrides: Partial<FactorCandidate> = {}): FactorCandidate {
  return {
    id: overrides.id ?? 'aaaaaaaa-0000-0000-0000-000000000000',
    effect: overrides.effect ?? -0.5,
    significance: overrides.significance ?? 0.5,
    createdAt: overrides.createdAt ?? new Date('2025-01-01T00:00:00Z'),
    citationCount: overrides.citationCount ?? 1,
    distance: overrides.distance ?? 0.1,
  };
}

describe('escalationLambda — blend weight decays with corroboration', () => {
  it('is 1/(n+1) and clamps negative counts to 0', () => {
    expect(escalationLambda(0)).toBeCloseTo(1, 12);
    expect(escalationLambda(1)).toBeCloseTo(1 / 2, 12);
    expect(escalationLambda(3)).toBeCloseTo(1 / 4, 12);
    expect(escalationLambda(9)).toBeCloseTo(1 / 10, 12);
    expect(escalationLambda(-5)).toBeCloseTo(1, 12); // guarded to n=0
  });

  it('is monotonically non-increasing in citation count', () => {
    let prev = Infinity;
    for (let n = 0; n <= 50; n++) {
      const l = escalationLambda(n);
      expect(l).toBeLessThanOrEqual(prev + 1e-12);
      expect(l).toBeGreaterThan(0);
      expect(l).toBeLessThanOrEqual(1);
      prev = l;
    }
  });
});

describe('recalculateOnEscalation — the ADR-19 convex blend', () => {
  it('blends effect at λ and never lowers significance when corroborating', () => {
    // λ = 1/(1+1) = 0.5. effect' = 0.5·0.4 + 0.5·0.8 = 0.6.
    // blendedSig = 0.5·0.6 + 0.5·0.4 = 0.5, but corroborating takes max(parent,blend)=0.6.
    const out = recalculateOnEscalation(
      { effect: 0.4, significance: 0.6, citationCount: 1 },
      { effect: 0.8, significance: 0.4 },
      'corroborating',
    );
    expect(out.effect).toBeCloseTo(0.6, 12);
    expect(out.significance).toBeCloseTo(0.6, 12); // not lowered below the parent
  });

  it('de-escalating is the ONLY case significance may fall', () => {
    const out = recalculateOnEscalation(
      { effect: 0.4, significance: 0.6, citationCount: 1 },
      { effect: 0.8, significance: 0.4 },
      'de-escalating',
    );
    expect(out.effect).toBeCloseTo(0.6, 12);
    expect(out.significance).toBeCloseTo(0.5, 12); // the blend, allowed to drop
    expect(out.significance).toBeLessThan(0.6);
  });

  it('intensifying is non-decreasing in significance like corroborating', () => {
    const out = recalculateOnEscalation(
      { effect: -0.2, significance: 0.7, citationCount: 1 },
      { effect: -0.9, significance: 0.5 },
      'intensifying',
    );
    expect(out.significance).toBeGreaterThanOrEqual(0.7);
  });

  it('clamps out-of-range incoming and parent values into domain before blending', () => {
    const out = recalculateOnEscalation(
      { effect: -3, significance: 5, citationCount: 0 }, // λ = 1 → all newcomer
      { effect: 9, significance: -2 },
      'de-escalating',
    );
    // incoming clamped: effect 9→1, significance -2→0; λ=1 so output = incoming.
    expect(out.effect).toBeCloseTo(1, 12);
    expect(out.significance).toBeCloseTo(0, 12);
  });

  it('keeps outputs in [-1,1] × [0,1] for adversarial inputs', () => {
    for (const d of ['corroborating', 'intensifying', 'de-escalating'] as const) {
      const out = recalculateOnEscalation(
        { effect: 1e6, significance: -1e6, citationCount: 2 },
        { effect: -1e6, significance: 1e6 },
        d,
      );
      expect(out.effect).toBeGreaterThanOrEqual(-1);
      expect(out.effect).toBeLessThanOrEqual(1);
      expect(out.significance).toBeGreaterThanOrEqual(0);
      expect(out.significance).toBeLessThanOrEqual(1);
    }
  });

  it('repeated corroboration saturates rather than growing without bound', () => {
    let parent = { effect: 0.2, significance: 0.2, citationCount: 1 };
    for (let i = 0; i < 100; i++) {
      const out = recalculateOnEscalation(
        parent,
        { effect: 1, significance: 1 },
        'corroborating',
      );
      parent = { ...out, citationCount: parent.citationCount + 1 };
      expect(out.effect).toBeLessThanOrEqual(1);
      expect(out.significance).toBeLessThanOrEqual(1);
    }
    expect(parent.effect).toBeLessThanOrEqual(1);
    expect(parent.significance).toBeGreaterThan(0.2); // it did move upward
  });
});

describe('compareCandidates / selectParent — a total, stable order', () => {
  it('orders by distance, then oldest createdAt, then ascending id', () => {
    const near = candidate({ id: 'b', distance: 0.05 });
    const farOld = candidate({
      id: 'c',
      distance: 0.2,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    const farNew = candidate({
      id: 'a',
      distance: 0.2,
      createdAt: new Date('2024-01-01T00:00:00Z'),
    });
    const sorted = [farNew, farOld, near].sort(compareCandidates);
    expect(sorted.map((c) => c.id)).toEqual(['b', 'c', 'a']); // near, then older-far, then newer-far
  });

  it('breaks an exact distance+age tie by ascending id (deterministic across workers)', () => {
    const same = { distance: 0.1, createdAt: new Date('2025-01-01T00:00:00Z') };
    const x = candidate({ id: 'id-zzz', ...same });
    const y = candidate({ id: 'id-aaa', ...same });
    expect([x, y].sort(compareCandidates).map((c) => c.id)).toEqual(['id-aaa', 'id-zzz']);
    // ...and the mirror input yields the identical order (stable, order-independent).
    expect([y, x].sort(compareCandidates).map((c) => c.id)).toEqual(['id-aaa', 'id-zzz']);
  });

  it('selectParent returns the single best candidate and does not mutate input', () => {
    const list = [
      candidate({ id: 'far', distance: 0.25 }),
      candidate({ id: 'near', distance: 0.02 }),
    ];
    const snapshot = list.map((c) => c.id);
    expect(selectParent(list)?.id).toBe('near');
    expect(list.map((c) => c.id)).toEqual(snapshot); // unmutated
  });

  it('selectParent returns null for an empty candidate set', () => {
    expect(selectParent([])).toBeNull();
  });
});

describe('filterCandidates — ceiling filter + explicit ordering', () => {
  it('drops candidates beyond the ceiling and returns the rest in distance order', () => {
    const kept = filterCandidates([
      candidate({ id: 'mid', distance: 0.2 }),
      candidate({ id: 'over', distance: CANDIDATE_DISTANCE_CEILING + 0.01 }),
      candidate({ id: 'near', distance: 0.01 }),
    ]);
    expect(kept.map((c) => c.id)).toEqual(['near', 'mid']);
  });

  it('keeps a candidate sitting exactly on the ceiling', () => {
    const kept = filterCandidates([candidate({ id: 'edge', distance: CANDIDATE_DISTANCE_CEILING })]);
    expect(kept.map((c) => c.id)).toEqual(['edge']);
  });
});

describe('resolveOutcome — deterministic guards over the verdict', () => {
  const incoming = { effect: -0.9, significance: 0.8 };

  it('independent verdict → insert', () => {
    const out = resolveOutcome({ kind: 'independent' }, [candidate()], incoming);
    expect(out.kind).toBe('insert');
  });

  it('escalation but no candidates → insert (cannot escalate nothing)', () => {
    const verdict: ResolverVerdict = {
      kind: 'escalation',
      parentId: 'ghost',
      directionality: 'intensifying',
    };
    expect(resolveOutcome(verdict, [], incoming).kind).toBe('insert');
  });

  it('escalation naming a real candidate escalates exactly that one', () => {
    const chosen = candidate({ id: 'target', effect: 0.3, significance: 0.5, citationCount: 1 });
    const other = candidate({ id: 'other', distance: 0.02 });
    const out = resolveOutcome(
      { kind: 'escalation', parentId: 'target', directionality: 'intensifying' },
      [other, chosen],
      incoming,
    );
    expect(out.kind).toBe('escalate');
    if (out.kind === 'escalate') {
      expect(out.parent.id).toBe('target');
      expect(out.directionality).toBe('intensifying');
      // recomputed via the  blend, in-domain.
      expect(out.recalculated.effect).toBeGreaterThanOrEqual(-1);
      expect(out.recalculated.effect).toBeLessThanOrEqual(1);
    }
  });

  it('escalation naming an UNKNOWN id falls back to the deterministic nearest, not the hallucination', () => {
    const near = candidate({ id: 'near', distance: 0.02 });
    const far = candidate({ id: 'far', distance: 0.25 });
    const out = resolveOutcome(
      { kind: 'escalation', parentId: 'does-not-exist', directionality: 'corroborating' },
      [far, near],
      incoming,
    );
    expect(out.kind).toBe('escalate');
    if (out.kind === 'escalate') {
      expect(out.parent.id).toBe('near'); // nearest candidate, never the bogus id
    }
  });
});
