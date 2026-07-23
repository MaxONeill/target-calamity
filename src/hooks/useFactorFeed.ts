import { useCallback, useEffect, useRef, useState } from 'react';
import { FeedResponseSchema } from '../../shared/schema.js';
import type { Factor, SortMode } from '../../shared/types.js';

export interface FactorFeed {
  factors: Factor[];
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  loadMore: () => void;
  hasMore: boolean;
  loading: boolean;
  /** Replaces one cached card in place, for live deltas. */
  patchFactor: (updated: Factor) => void;
}

/**
 * The sidebar's data path: cursor-paginated `GET /api/factors`.
 *
 * Drives the list and nothing on the GPU. A generation token guards against
 * out-of-order responses when the sort mode flips mid-flight, since a stale
 * response must not clobber a newer list. Changing sort discards the cursor and
 * restarts from page one, because it is a different result set.
 */
export function useFactorFeed(): FactorFeed {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const generationRef = useRef(0);

  const fetchPage = useCallback(
    async (mode: SortMode, cursor: string | null, generation: number): Promise<void> => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ sortMode: mode });
        if (cursor) params.set('cursor', cursor);

        const res = await fetch(`/api/factors?${params.toString()}`);
        if (!res.ok) throw new Error(`factors ${res.status}`);
        const parsed = FeedResponseSchema.parse(await res.json());

        if (generation !== generationRef.current) return;
        setFactors((prev) => (cursor ? [...prev, ...parsed.factors] : parsed.factors));
        setNextCursor(parsed.nextCursor);
      } catch (err) {
        if (generation === generationRef.current) console.error('[feed] fetch failed:', err);
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          setHasLoadedOnce(true);
        }
      }
    },
    [],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    setFactors([]);
    setNextCursor(null);
    setHasLoadedOnce(false);
    void fetchPage(sortMode, null, generation);
  }, [sortMode, fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || nextCursor === null) return;
    void fetchPage(sortMode, nextCursor, generationRef.current);
  }, [loading, nextCursor, sortMode, fetchPage]);

  const patchFactor = useCallback((updated: Factor) => {
    setFactors((prev) => {
      const index = prev.findIndex((f) => f.id === updated.id);
      if (index === -1) return prev;
      const copy = prev.slice();
      copy[index] = updated;
      return copy;
    });
  }, []);

  return {
    factors,
    sortMode,
    setSortMode,
    loadMore,
    hasMore: nextCursor !== null,
    loading: loading || !hasLoadedOnce,
    patchFactor,
  };
}
