import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Clock } from './components/Clock/index.js';
import { FactorDetails } from './components/FactorDetails/index.js';
import { PinPeek } from './components/PinPeek/index.js';
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
import { withDisplayWeight } from './lib/displayWeight.js';
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
/** Shallow, order-sensitive id comparison — the peek's list is ordered. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function App(): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);
  /*
   * Coastlines OFF. With the basemap greyed and the ice toned down, the outline
   * stopped earning its place: the land/ocean boundary already reads from the
   * colour difference, and a second line over it was one more thing between the
   * reader and the pins.
   *
   * Hidden rather than removed — this is the scene's existing `setLandVisible`
   * channel, so it is one boolean to bring them back, and `Coastlines` keeps its
   * dimmed colour ready for that.
   */
  const landVisible = false;

  const appRef = useRef<HTMLDivElement>(null);

  const feed = useFactorFeed();
  const { fieldPins, globalFactors, projections, requirements, settled, reloadField } =
    useFieldPins();
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

  // Display-only re-weighting for the GPU. Scoring produces sound per-item
  // judgements but a narrow spread, so a globe tinted straight from
  // `significance` shows far less variation than the judgements contain.
  //
  // The Clock deliberately keeps the RAW values (see clockFactors below):
  // significance is `p` in its first-crossing model, and a corpus-relative
  // number would assert a certainty no source gave, as well as making a
  // factor's weight depend on what else happens to have been ingested.
  const scenePins = useMemo(() => withDisplayWeight(fieldPins), [fieldPins]);
  const sceneGlobalFactors = useMemo(() => withDisplayWeight(globalFactors), [globalFactors]);

  /*
   * Which pins the cursor is over, and where the cursor is. Held in React state
   * rather than pushed imperatively into the scene, because the peek is DOM —
   * it has to be clickable to reach an occluded pin, which a canvas overlay
   * cannot be.
   */
  const [peek, setPeek] = useState<{ ids: readonly string[]; x: number; y: number }>({
    ids: [],
    x: 0,
    y: 0,
  });

  const closePeek = useCallback(() => {
    setPeek((prev) => (prev.ids.length === 0 ? prev : { ids: [], x: 0, y: 0 }));
  }, []);

  const pinsById = useMemo(() => new Map(fieldPins.map((p) => [p.id, p])), [fieldPins]);
  const peekPins = useMemo(
    () => peek.ids.map((id) => pinsById.get(id)).filter((p) => p !== undefined),
    [peek.ids, pinsById],
  );

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
    // Display weights, not raw scores — the GPU is the only consumer that wants
    // a corpus-relative number.
    fieldPins: scenePins,
    globalFactors: sceneGlobalFactors,
    fieldReady: settled,
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
    onHoverPins: useCallback((ids: readonly string[], x: number, y: number) => {
      /*
       * THE ANCHOR IS LATCHED ON OPEN and never moved while the peek is up.
       *
       * Re-anchoring only when the pin SET changed was not enough: in a densely
       * populated area the set changes on nearly every pointer step, so the panel
       * re-anchored constantly and walked away from the cursor exactly as before.
       * Content may update freely; the position may not.
       *
       * Nothing closes the peek from here, an empty list included. Dismissal is
       * the panel's own business, governed by how far the cursor has travelled
       * from its EDGES — the only rule under which the trip from pin to row is
       * guaranteed to stay possible while the list keeps changing underneath it.
       */
      setPeek((prev) => {
        if (ids.length === 0) return prev;
        if (prev.ids.length === 0) return { ids, x, y };
        return sameIds(prev.ids, ids) ? prev : { ...prev, ids };
      });
    }, []),
    // The scene drops its own alignment lock on manual input; nothing on the
    // React side needs to react, so this is a no-op.
    onInterrupt: useCallback(() => {}, []),
  });

  // `void`: reloadField swallows and logs its own fetch failures, so the stream
  // callback stays synchronous. Wrapped in useCallback rather than inlined so the
  // identity is stable and the SSE subscription is not torn down each render.
  const onFieldInvalidated = useCallback(() => {
    void reloadField();
  }, [reloadField]);

  const streamStatus = useFactorStream({
    onFactorChanged: feed.patchFactor,
    onFieldInvalidated,
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
        ? (fieldPins.find((p) => p.id === panel.selectedId) ?? null)
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
      {/* Hidden until the field has been applied. The shader's inputs are
          undefined before the first `setFieldPins`, and an unwritten field
          renders as every point at maximum displacement in white — a flash of
          a spiked white ball on every load. Revealing on data rather than on
          mount means the first thing anyone sees is the real planet. */}
      <div className="tc-globe-mount" ref={mountRef} aria-hidden="true" data-ready={settled} />

      <PinPeek
        pins={peekPins}
        x={peek.x}
        y={peek.y}
        onDismiss={closePeek}
        onSelect={(id) => {
          closePeek();
          selectFactor(id, { scrollIntoView: true });
        }}
      />

      {!settled ? (
        <div className="tc-globe-loading" role="status" aria-live="polite">
          <div className="tc-globe-loading__ring" aria-hidden="true" />
          <span className="tc-visually-hidden">Loading the field</span>
        </div>
      ) : null}

      <div className="tc-overlay">
        {/* Touch-only catcher for the edge swipe that opens the feed. It exists
            to sit ABOVE the canvas, so the opening gesture does not also orbit
            the globe. Hidden entirely for fine pointers. */}
        <div className="tc-edge-swipe" aria-hidden="true" />

        <StatusBar streamStatus={streamStatus} />

        <div className="tc-clock-slot">
          <Clock
            factors={clockFactors}
            projections={clockProjections}
            requirements={requirements}
          />
        </div>

        {/* The only instruction on screen. The globe is an unlabelled
            instrument — a reader who does not know the pins are clickable has
            no way to discover the detail panel, and nothing else on screen says
            so. Kept to one grey line: an interface that needs a paragraph of
            instructions has a different problem. */}
        <p className="tc-pin-hint" aria-hidden="true">
          Select a pin to learn more
        </p>

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
              direction={feed.direction}
              onDirectionChange={feed.setDirection}
              search={feed.search}
              onSearchChange={feed.setSearch}
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
