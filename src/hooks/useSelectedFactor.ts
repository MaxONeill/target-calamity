import { useEffect, useState } from 'react';
import { FactorByIdResponseSchema } from '../../shared/schema.js';
import type { Factor } from '../../shared/types.js';

/**
 * Resolves the fully-loaded {@link Factor} for the current selection.
 *
 * Prefers a factor already present in the loaded feed pages. When the selection
 * is a pin or ring arc whose card has not been paged in — common once the feed
 * has more rows than one page — it fetches `GET /api/factors/:id` on demand and
 * caches the result, so the detail view shows the full record (description,
 * citations) instead of lean field metrics. Returns null while a fetch is in
 * flight or when the id genuinely has no record.
 */
export function useSelectedFactor(
  selectedId: string | null,
  feedFactors: readonly Factor[],
): Factor | null {
  const [fetched, setFetched] = useState<Record<string, Factor>>({});

  const fromFeed = selectedId
    ? feedFactors.find((f) => f.id === selectedId) ?? null
    : null;

  useEffect(() => {
    if (!selectedId || fromFeed || fetched[selectedId]) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/factors/${selectedId}`);
        if (!res.ok) return; // 404 → leave null; the panel shows its own fallback
        const { factor } = FactorByIdResponseSchema.parse(await res.json());
        if (!cancelled) setFetched((prev) => ({ ...prev, [factor.id]: factor }));
      } catch (err) {
        console.error('[factor] by-id fetch failed:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedId, fromFeed, fetched]);

  if (fromFeed) return fromFeed;
  return selectedId ? fetched[selectedId] ?? null : null;
}
