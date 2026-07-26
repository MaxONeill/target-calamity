/**
 * Tests for comparative significance scoring (backfillSignificance.ts).
 *
 * Offline: only the pure ranking→score mapping is exercised, which is where the
 * correctness lives. Every rejection case below is one where writing a score
 * would be worse than leaving the batch unscored — the fallback is a re-run,
 * not a guess.
 */
import { describe, it, expect } from 'vitest';
import { scoresFromRanking } from './backfillSignificance.js';

// Anchor ids and their fixed scores, mirrored from the module.
const A = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

describe('scoresFromRanking', () => {
  it('scores an item between the anchors it was ranked between', () => {
    // f1 sits between A2 (0.90) and A3 (0.72), so it must land in that interval.
    const ranked = ['A1', 'A2', 'f1', 'A3', 'A4', 'A5', 'A6'];
    const out = scoresFromRanking(ranked, ['f1']);
    expect(out).not.toBeNull();
    const f1 = out!.get('f1')!;
    expect(f1).toBeLessThan(0.9);
    expect(f1).toBeGreaterThan(0.72);
  });

  it('separates two items ranked on opposite sides of an anchor', () => {
    // The whole point: coral above the single-species anchor, lynx below it.
    const ranked = ['A1', 'A2', 'coral', 'A3', 'A4', 'A5', 'lynx', 'A6'];
    const out = scoresFromRanking(ranked, ['coral', 'lynx'])!;
    expect(out.get('coral')!).toBeGreaterThan(0.72);
    expect(out.get('lynx')!).toBeLessThan(0.25);
  });

  it('caps an item ranked above every anchor rather than inventing a ceiling', () => {
    const ranked = ['top', ...A];
    const out = scoresFromRanking(ranked, ['top'])!;
    expect(out.get('top')!).toBeLessThanOrEqual(1);
    expect(out.get('top')!).toBeGreaterThan(0.97);
  });

  it('floors an item ranked below every anchor', () => {
    const ranked = [...A, 'bottom'];
    const out = scoresFromRanking(ranked, ['bottom'])!;
    expect(out.get('bottom')!).toBeGreaterThan(0);
    expect(out.get('bottom')!).toBeLessThan(0.06);
  });

  it('rejects a ranking that omits an item', () => {
    expect(scoresFromRanking(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], ['f1'])).toBeNull();
  });

  it('rejects a ranking that duplicates an item', () => {
    expect(scoresFromRanking(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'f1', 'f1'], ['f1'])).toBeNull();
  });

  it('rejects a ranking containing an unknown id', () => {
    expect(
      scoresFromRanking(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'ghost'], ['f1']),
    ).toBeNull();
  });

  it('rejects a ranking where the anchors themselves are out of order', () => {
    // The anchors' order is definitional. If the model cannot get those right,
    // its ordering of the real factors is not worth persisting.
    const ranked = ['A2', 'A1', 'f1', 'A3', 'A4', 'A5', 'A6'];
    expect(scoresFromRanking(ranked, ['f1'])).toBeNull();
  });

  it('is monotonic: an earlier rank never scores lower than a later one', () => {
    const ranked = ['A1', 'a', 'A2', 'b', 'A3', 'c', 'A4', 'd', 'A5', 'e', 'A6'];
    const out = scoresFromRanking(ranked, ['a', 'b', 'c', 'd', 'e'])!;
    const scores = ['a', 'b', 'c', 'd', 'e'].map((id) => out.get(id)!);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });
});
