import { useCallback, useEffect, useRef, useState } from 'react';
import { FeedResponseSchema } from '../../shared/schema.js';
import type { Factor, SortDirection, SortMode } from '../../shared/types.js';

/** Debounce for the search box, ms. */
const SEARCH_DEBOUNCE_MS = 250;

export interface FactorFeed {
  factors: Factor[];
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  direction: SortDirection;
  setDirection: (direction: SortDirection) => void;
  /** What the reader has typed — updates immediately, so the input stays responsive. */
  search: string;
  setSearch: (search: string) => void;
  loadMore: () => void;
  hasMore: boolean;
  loading: boolean;
  /** Replaces one cached card in place, for live deltas. */
  patchFactor: (updated: Factor) => void;
}

/**
 * The sidebar's data path: `GET /api/factors`, cursor-paginated in `recent` and
 * a bounded snapshot in every other mode.
 *
 * Drives the list and nothing on the GPU. A generation token guards against
 * out-of-order responses: any control change can leave a request in flight, and
 * a slow answer to an abandoned query must not clobber a newer list. Changing
 * ANY of sort, direction or search discards the cursor and restarts from page
 * one, because each produces a different result set — replaying a cursor across
 * them would page through a list that no longer exists.
 *
 * SEARCH IS SERVER-SIDE, and debounced here rather than sent per keystroke. It
 * has to be server-side: filtering what the client happens to have paged in
 * would quietly search the first 50 factors and present the result as if it
 * searched the corpus, which is the kind of confident-but-partial answer this
 * project avoids everywhere else.
 */
export function useFactorFeed(): FactorFeed {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>('impact');
  const [direction, setDirection] = useState<SortDirection>('desc');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  const generationRef = useRef(0);

  // Typing is immediate; querying is not. Without this every keystroke is a
  // round trip, and the intermediate answers arrive out of order.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  const fetchPage = useCallback(
    async (
      mode: SortMode,
      dir: SortDirection,
      query: string,
      cursor: string | null,
      generation: number,
    ): Promise<void> => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ sortMode: mode, direction: dir });
        if (query) params.set('search', query);
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
    void fetchPage(sortMode, direction, debouncedSearch, null, generation);
  }, [sortMode, direction, debouncedSearch, fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || nextCursor === null) return;
    void fetchPage(sortMode, direction, debouncedSearch, nextCursor, generationRef.current);
  }, [loading, nextCursor, sortMode, direction, debouncedSearch, fetchPage]);

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
    direction,
    setDirection,
    search,
    setSearch,
    loadMore,
    hasMore: nextCursor !== null,
    loading: loading || !hasLoadedOnce,
    patchFactor,
  };
}
