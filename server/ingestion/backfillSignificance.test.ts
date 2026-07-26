/**
 * Tests for comparative significance scoring (backfillSignificance.ts).
 *
 * Offline: only the pure ranking→score mapping is exercised, which is where the
 * correctness lives. Every rejection case below is one where writing a score
 * would be worse than leaving the batch unscored — the fallback is a re-run,
 * not a guess. Each also asserts the REASON, because a rejection costs a re-run
 * and "unusable" does not say whether to fix the prompt, the batch, or the
 * anchors.
 */
import { describe, it, expect } from 'vitest';
import { scoresFromRanking } from './backfillSignificance.js';

/** Anchor ids in their definitional order, mirrored from the module. */
const A = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

/** Unwrap a ranking expected to succeed. */
function ok(ranked: string[], ids: string[]): Map<string, number> {
  const result = scoresFromRanking(ranked, ids);
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`);
  return result.scores;
}

/** The rejection reason for a ranking expected to fail. */
function reason(ranked: string[], ids: string[]): string {
  const result = scoresFromRanking(ranked, ids);
  if (result.ok) throw new Error('expected rejection, got scores');
  return result.reason;
}

describe('scoresFromRanking', () => {
  it('scores an item between the anchors it was ranked between', () => {
    // f1 sits between A2 (0.90) and A3 (0.72), so it must land in that interval.
    const scores = ok(['A1', 'A2', 'f1', 'A3', 'A4', 'A5', 'A6'], ['f1']);
    expect(scores.get('f1')!).toBeLessThan(0.9);
    expect(scores.get('f1')!).toBeGreaterThan(0.72);
  });

  it('separates two items ranked on opposite sides of an anchor', () => {
    // The whole point: coral above the single-species anchor, lynx below it.
    const scores = ok(
      ['A1', 'A2', 'coral', 'A3', 'A4', 'A5', 'lynx', 'A6'],
      ['coral', 'lynx'],
    );
    expect(scores.get('coral')!).toBeGreaterThan(0.72);
    expect(scores.get('lynx')!).toBeLessThan(0.25);
  });

  it('caps an item ranked above every anchor rather than inventing a ceiling', () => {
    const scores = ok(['top', ...A], ['top']);
    expect(scores.get('top')!).toBeLessThanOrEqual(1);
    expect(scores.get('top')!).toBeGreaterThan(0.97);
  });

  it('floors an item ranked below every anchor', () => {
    const scores = ok([...A, 'bottom'], ['bottom']);
    expect(scores.get('bottom')!).toBeGreaterThan(0);
    expect(scores.get('bottom')!).toBeLessThan(0.06);
  });

  it('is monotonic: an earlier rank never scores lower than a later one', () => {
    const scores = ok(
      ['A1', 'a', 'A2', 'b', 'A3', 'c', 'A4', 'd', 'A5', 'e', 'A6'],
      ['a', 'b', 'c', 'd', 'e'],
    );
    const values = ['a', 'b', 'c', 'd', 'e'].map((id) => scores.get(id)!);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    }
  });

  it('names an omitted id', () => {
    expect(reason([...A], ['f1'])).toContain('omitted');
    expect(reason([...A], ['f1'])).toContain('f1');
  });

  it('names a duplicated id', () => {
    expect(reason([...A, 'f1', 'f1'], ['f1'])).toContain('duplicated');
  });

  it('names an invented id', () => {
    expect(reason([...A, 'ghost'], ['f1'])).toContain('invented');
    expect(reason([...A, 'ghost'], ['f1'])).toContain('ghost');
  });

  it('names anchors returned out of their definitional order', () => {
    // Their order is definitional. A model that cannot reproduce it has not
    // produced an ordering worth persisting.
    const r = reason(['A2', 'A1', 'f1', 'A3', 'A4', 'A5', 'A6'], ['f1']);
    expect(r).toContain('out of order');
  });
});
