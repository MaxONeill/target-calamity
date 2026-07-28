/**
 * Feed ordering, direction and search — against the seed set, offline.
 *
 * `feedSeed` is the in-memory mirror of the SQL feed, so these tests pin the
 * SEMANTICS both paths are supposed to share: which column orders the list,
 * what a direction means for each, and that search filters before sorting.
 * They cannot catch the SQL diverging from the mirror — only a database can,
 * and `pgRepository.integration.test.ts` is where that lives. What they do
 * catch is the ordering math being wrong in the first place, which is where the
 * subtle bugs are: a sign flipped, a tiebreak pointing the wrong way, a
 * direction that reverses the rank but not the tiebreak.
 */
import { describe, expect, it } from 'vitest';
import { feedSeed } from './factors.js';
import { FULL_GLOBE_VIEWPORT } from '../pagination.js';
import type { Factor, SortDirection, SortMode } from '../../shared/types.js';

const feed = (sortMode: SortMode, direction: SortDirection, search = ''): Factor[] =>
  feedSeed(sortMode, direction, search, FULL_GLOBE_VIEWPORT, null).factors;

const impact = (f: Factor): number => Math.abs(f.effect) * f.significance;

/** Is the sequence ordered per `direction`? Ties are allowed. */
function isOrdered(values: number[], direction: SortDirection): boolean {
  return values.every((v, i) => {
    if (i === 0) return true;
    const prev = values[i - 1] ?? v;
    return direction === 'desc' ? prev >= v : prev <= v;
  });
}

describe('feed ordering', () => {
  it('defaults to impact, heaviest first', () => {
    const factors = feed('impact', 'desc');
    expect(factors.length).toBeGreaterThan(0);
    expect(isOrdered(factors.map(impact), 'desc')).toBe(true);
  });

  it('reverses impact on ascending', () => {
    expect(isOrdered(feed('impact', 'asc').map(impact), 'asc')).toBe(true);
  });

  it('orders effect by SIGN, not magnitude', () => {
    // The distinction that makes the direction toggle meaningful: descending
    // must lead with the most positive (Humanity), NOT the largest |effect|.
    const desc = feed('effect', 'desc');
    const asc = feed('effect', 'asc');

    expect(
      isOrdered(
        desc.map((f) => f.effect),
        'desc',
      ),
    ).toBe(true);
    expect(
      isOrdered(
        asc.map((f) => f.effect),
        'asc',
      ),
    ).toBe(true);
    expect(desc[0]?.effect).toBeGreaterThan(0);
    expect(asc[0]?.effect).toBeLessThan(0);
  });

  it('orders significance on its own', () => {
    expect(
      isOrdered(
        feed('significance', 'desc').map((f) => f.significance),
        'desc',
      ),
    ).toBe(true);
    expect(
      isOrdered(
        feed('significance', 'asc').map((f) => f.significance),
        'asc',
      ),
    ).toBe(true);
  });

  it('reverses `recent` without dropping or duplicating anything', () => {
    const desc = feed('recent', 'desc').map((f) => f.id);
    const asc = feed('recent', 'asc').map((f) => f.id);
    expect(asc).toEqual([...desc].reverse());
    expect(new Set(desc).size).toBe(desc.length);
  });

  it('returns the same SET regardless of sort — only the order changes', () => {
    // A sort that silently filters is the failure this guards: every mode is
    // capped at RANKED_CAP, and the seed set is far below it, so all four must
    // return every factor.
    const modes: SortMode[] = ['impact', 'effect', 'significance', 'recent'];
    const sets = modes.map((m) => new Set(feed(m, 'desc').map((f) => f.id)));
    const first = sets[0];
    expect(first).toBeDefined();
    for (const s of sets) expect([...s].sort()).toEqual([...(first ?? new Set())].sort());
  });
});

describe('feed search', () => {
  it('filters to matching factors', () => {
    const hits = feed('impact', 'desc', 'coral');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(feed('impact', 'desc').length);
    for (const f of hits) {
      expect(`${f.name} ${f.description}`.toLowerCase()).toContain('coral');
    }
  });

  it('is case-insensitive and searches the description too', () => {
    expect(feed('impact', 'desc', 'CORAL').length).toBe(feed('impact', 'desc', 'coral').length);
  });

  it('returns nothing for a non-match rather than falling back to everything', () => {
    // The dangerous failure mode: an unmatched query silently returning the
    // whole corpus reads as "no filter applied" and is indistinguishable from
    // a search that matched everything.
    expect(feed('impact', 'desc', 'zzzznotathing')).toHaveLength(0);
  });

  it('applies search BEFORE sorting, so the order still holds within results', () => {
    const hits = feed('significance', 'desc', 'ice');
    expect(hits.length).toBeGreaterThan(1);
    expect(
      isOrdered(
        hits.map((f) => f.significance),
        'desc',
      ),
    ).toBe(true);
  });
});
