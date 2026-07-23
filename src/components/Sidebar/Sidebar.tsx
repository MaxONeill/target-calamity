/**
 * Sidebar — the linear factor feed.
 *
 * A scrollable `role="listbox"` of {@link FactorCard}s with:
 *  - a sort toggle ('recent' = updated_at desc / 'magnitude' = |effect| desc),
 *    matching 's "Sorting Override" (: mode-tagged pagination);
 *  - infinite scroll via IntersectionObserver, calling `onLoadMore` when the
 *    bottom sentinel enters view and there is more to fetch;
 *  - full keyboard accessibility: roving tabindex, Up/Down/Home/End to move,
 *    Enter/Space to commit selection.
 *
 * This component is presentational: it owns no data-fetching. The parent holds
 * the paged factor list and pagination state (`hasMore`, `loading`) and reacts
 * to `onLoadMore` / `onSortModeChange` / `onSelect`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Factor, SortMode } from '../../../shared/types.js';
import { FactorCard } from '../FactorCard/index.js';
import './Sidebar.css';

export interface SidebarProps {
  factors: Factor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  sortMode: SortMode;
  onSortModeChange: (mode: SortMode) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
}

const SORT_LABELS: Record<SortMode, string> = {
  recent: 'Recent',
  magnitude: 'Magnitude',
};

export function Sidebar({
  factors,
  selectedId,
  onSelect,
  sortMode,
  onSortModeChange,
  onLoadMore,
  hasMore,
  loading,
}: SidebarProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Index of the card that currently holds the roving tabindex (0). Keyboard
  // navigation moves this; it is not the same as the selected factor.
  const [focusedIndex, setFocusedIndex] = useState(0);

  // Keep the roving index in range as the feed grows/shrinks, and align it with
  // an externally-driven selection so Tab lands on the selected card.
  useLayoutEffect(() => {
    if (factors.length === 0) {
      if (focusedIndex !== 0) setFocusedIndex(0);
      return;
    }
    if (selectedId !== null) {
      const selIdx = factors.findIndex((f) => f.id === selectedId);
      if (selIdx !== -1 && selIdx !== focusedIndex) {
        setFocusedIndex(selIdx);
        return;
      }
    }
    if (focusedIndex > factors.length - 1) {
      setFocusedIndex(factors.length - 1);
    }
  }, [factors, selectedId, focusedIndex]);

  const focusCard = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(factors.length - 1, index));
      setFocusedIndex(clamped);
      const node = cardRefs.current[clamped];
      if (node) {
        node.focus();
        node.scrollIntoView({ block: 'nearest' });
      }
    },
    [factors.length],
  );

  const onListKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (factors.length === 0) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusCard(focusedIndex + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusCard(focusedIndex - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusCard(0);
          break;
        case 'End':
          e.preventDefault();
          focusCard(factors.length - 1);
          break;
        case 'Enter':
        case ' ': {
          e.preventDefault();
          const target = factors[focusedIndex];
          if (target) onSelect(target.id);
          break;
        }
        default:
          break;
      }
    },
    [factors, focusedIndex, focusCard, onSelect],
  );

  // Infinite scroll. Re-subscribes when the fetch gate (hasMore/loading) or the
  // callback identity changes so the observer never fires against stale state.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) {
          onLoadMore();
        }
      },
      { root: scrollRef.current, rootMargin: '240px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  const activeDescendant =
    factors.length > 0 && focusedIndex < factors.length
      ? `tc-factor-${factors[focusedIndex]!.id}`
      : undefined;

  const isEmpty = factors.length === 0;

  return (
    <aside className="tc-sidebar" aria-label="Factor feed">
      <header className="tc-sidebar__header">
        <div className="tc-sidebar__titlerow">
          <h2 className="tc-sidebar__title">Factor Feed</h2>
          <span className="tc-sidebar__count" aria-live="polite">
            {factors.length}
            {hasMore ? '+' : ''} tracked
          </span>
        </div>

        <div
          className="tc-sorttoggle"
          role="group"
          aria-label="Sort factor feed"
        >
          {(['recent', 'magnitude'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="tc-sorttoggle__btn"
              aria-pressed={sortMode === mode}
              onClick={() => {
                if (sortMode !== mode) onSortModeChange(mode);
              }}
            >
              {SORT_LABELS[mode]}
            </button>
          ))}
        </div>
      </header>

      <div className="tc-sidebar__scroll" ref={scrollRef}>
        {isEmpty && !loading ? (
          <div className="tc-sidebar__empty">
            <div className="tc-sidebar__empty-glyph" aria-hidden="true">
              {'⌀'}
            </div>
            No factors in the current view.
          </div>
        ) : isEmpty && loading ? (
          <div className="tc-sidebar__empty">
            <span className="tc-sidebar__spinner" aria-hidden="true" />
            Loading feed…
          </div>
        ) : (
          <div
            className="tc-sidebar__list"
            role="listbox"
            aria-label="Tracked factors"
            aria-activedescendant={activeDescendant}
            onKeyDown={onListKeyDown}
          >
            {factors.map((factor, index) => (
              <FactorCard
                key={factor.id}
                ref={(el) => {
                  cardRefs.current[index] = el;
                }}
                factor={factor}
                selected={factor.id === selectedId}
                tabIndex={index === Math.min(focusedIndex, factors.length - 1) ? 0 : -1}
                onSelect={onSelect}
              />
            ))}

            {/* Bottom sentinel + status line. */}
            <div className="tc-sidebar__sentinel" ref={sentinelRef}>
              {hasMore ? (
                loading ? (
                  <>
                    <span className="tc-sidebar__spinner" aria-hidden="true" />
                    Loading more…
                  </>
                ) : (
                  <span aria-hidden="true">↓ scroll for more</span>
                )
              ) : (
                <span className="tc-sidebar__end">— end of feed —</span>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

export default Sidebar;
