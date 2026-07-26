import { useCallback, useMemo, useRef } from 'react';
import { Clock } from './components/Clock/index.js';
import { FactorDetails } from './components/FactorDetails/index.js';
import { FightTheClock } from './components/FightTheClock/index.js';
import { Sidebar } from './components/Sidebar/index.js';
import { Slideout } from './components/Slideout/Slideout.js';
import { StatusBar } from './components/StatusBar/StatusBar.js';
import { SubmitFactor } from './components/SubmitFactor/index.js';
import { useFactorCoords } from './hooks/useFactorCoords.js';
import { useFactorFeed } from './hooks/useFactorFeed.js';
import { useFactorStream } from './hooks/useFactorStream.js';
import { useFieldPins } from './hooks/useFieldPins.js';
import { useScene } from './hooks/useScene.js';
import { useSelectedFactor } from './hooks/useSelectedFactor.js';
import { useSlideoutPanel } from './hooks/useSlideoutPanel.js';
import { useSwipe, type SwipeGesture } from './hooks/useSwipe.js';
import { toClockFactor, toClockProjection } from './lib/clock/toClockFactor.js';
import type { SceneHandle } from './scene/types.js';

/**
 * Composition root: wires the three.js instrument to the UI and to the two
 * independent data paths.
 *
 * Those paths stay separate on purpose. The feed drives the sidebar and nothing
 * on the GPU; the field drives the shader and is refetched only on a stream
 * invalidation, never on a camera move, scroll, sort or selection. That is what
 * makes the rendered planet a function of the data alone.
 */
export function App(): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  // Coastlines stay on; the toggle was removed from the top bar.
  const landVisible = true;

  const appRef = useRef<HTMLDivElement>(null);

  const feed = useFactorFeed();
  const { fieldPins, globalFactors, projections, reloadField } = useFieldPins();
  const panel = useSlideoutPanel();

  // Touch gestures for the panel. Opening is restricted to a right-edge strip
  // rather than the whole screen: a horizontal drag anywhere else is an orbit,
  // and the strip sits above the canvas so the globe never sees the gesture at
  // all. Closing is unambiguous — the swipe has to start on the open panel.
  const onSwipe = useCallback(
    ({ direction, target }: SwipeGesture) => {
      const node = target instanceof Element ? target : null;
      if (direction === 'left' && !panel.open && node?.closest('.tc-edge-swipe')) {
        panel.openFeed();
      } else if (direction === 'right' && panel.open && node?.closest('#tc-slideout')) {
        panel.closePanel();
      }
    },
    [panel],
  );
  useSwipe(appRef, { onSwipe });

  const coordsRef = useFactorCoords(fieldPins, feed.factors);

  const selectFactor = useCallback(
    (id: string, options?: { scrollIntoView?: boolean }) => {
      panel.selectFactor(id);

      const coords = coordsRef.current?.get(id);
      if (coords) {
        sceneRef.current?.alignToLatLon(coords.lat, coords.lon);
      }

      if (options?.scrollIntoView) {
        window.requestAnimationFrame(() => {
          document.getElementById(`tc-factor-${id}`)?.scrollIntoView({ block: 'nearest' });
        });
      }
    },
    [panel, coordsRef],
  );

  useScene({
    mountRef,
    sceneRef,
    fieldPins,
    globalFactors,
    selectedId: panel.selectedId,
    landVisible,
    onPickFactor: useCallback(
      (id: string) => selectFactor(id, { scrollIntoView: true }),
      [selectFactor],
    ),
    // Hover emphasis is imperative on purpose: routing it through React state
    // would re-render the tree on every pointer move for a purely visual cue.
    onHoverFactor: useCallback((id: string | null) => {
      sceneRef.current?.setHighlighted(id);
      document.body.style.cursor = id ? 'pointer' : '';
    }, []),
    // The scene drops its own alignment lock on manual input; nothing on the
    // React side needs to react, so this is a no-op.
    onInterrupt: useCallback(() => {}, []),
  });

  const streamStatus = useFactorStream({
    onFactorChanged: feed.patchFactor,
    onFieldInvalidated: reloadField,
  });

  // The full record for the selected factor: the feed row when it is loaded,
  // otherwise fetched by id on demand (pins and ring arcs are usually not on the
  // first feed page once the set is large).
  const selectedFactor = useSelectedFactor(panel.selectedId, feed.factors);

  // While the full record is still resolving, fall back to the lean field pin so
  // the panel shows metrics rather than nothing.
  const selectedPin = useMemo(
    () =>
      panel.selectedId && !selectedFactor
        ? fieldPins.find((p) => p.id === panel.selectedId) ?? null
        : null,
    [panel.selectedId, selectedFactor, fieldPins],
  );

  // Placeless factors are aggregated alongside located ones. They are off the
  // spatial bake, but they are frequently the heaviest in the set, so excluding
  // them here would quietly bias the countdown toward whatever happens to have
  // coordinates.
  const clockFactors = useMemo(
    () => [...fieldPins, ...globalFactors].map(toClockFactor),
    [fieldPins, globalFactors],
  );

  const clockProjections = useMemo(() => projections.map(toClockProjection), [projections]);

  return (
    <div className="tc-app" data-panel-open={panel.open} ref={appRef}>
      <div className="tc-globe-mount" ref={mountRef} aria-hidden="true" />

      <div className="tc-overlay">
        {/* Touch-only catcher for the edge swipe that opens the feed. It exists
            to sit ABOVE the canvas, so the opening gesture does not also orbit
            the globe. Hidden entirely for fine pointers. */}
        <div className="tc-edge-swipe" aria-hidden="true" />

        <StatusBar streamStatus={streamStatus} />

        <div className="tc-clock-slot">
          <Clock factors={clockFactors} projections={clockProjections} />
        </div>

        {/* Bottom-centre CTA. Shifts with the globe when the panel opens so it
            stays under the globe's visible centre (see .tc-fight-slot). */}
        <div className="tc-fight-slot">
          <FightTheClock />
        </div>

        <Slideout
          open={panel.open}
          mode={panel.mode}
          onOpen={panel.openFeed}
          onCollapse={panel.closePanel}
        >
          {panel.mode === 'submit' ? (
            <SubmitFactor onClose={panel.closeSubmit} />
          ) : panel.mode === 'detail' ? (
            <FactorDetails
              factor={selectedFactor}
              pin={selectedPin}
              onClose={panel.clearSelection}
            />
          ) : (
            <Sidebar
              factors={feed.factors}
              selectedId={panel.selectedId}
              onSelect={selectFactor}
              sortMode={feed.sortMode}
              onSortModeChange={feed.setSortMode}
              onLoadMore={feed.loadMore}
              hasMore={feed.hasMore}
              loading={feed.loading}
              onOpenSubmit={panel.openSubmit}
            />
          )}
        </Slideout>
      </div>
    </div>
  );
}

export default App;
