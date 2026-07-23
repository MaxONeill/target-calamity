/**
 * App — the composition root. Wires the three.js instrument (globe + pins +
 * orbit rig + alignment) to the React UI (Clock, Sidebar, Explainer) and to the
 * two API data paths.
 *
 * TWO STRICTLY SEPARATE DATA PATHS:
 *   1. The SIDEBAR FEED fetches `GET /api/factors` with cursor pagination and a
 *      sort toggle. It drives the sidebar list and the pending/verified badges,
 *      and nothing on the GPU.
 *   2. The SHADER FIELD fetches `GET /api/field` ONCE (and again only when the
 *      SSE stream signals a factor changed). Its pin set is handed to the field
 *      baker and the instanced pin layer. This call site is invoked from exactly
 *      two places — the initial load and the SSE `factor` handler — and NEVER
 *      from a camera move, scroll, sort toggle, or selection. That separation is
 *      what keeps the heatmap a function of the data alone, so two clients on the
 *      same `fieldEpoch` render the same planet.
 *
 * RENDER-ON-DEMAND: there is no unconditional rAF loop. A single
 * coalesced `requestRender()` repaints once per animation frame, and it is
 * called only when something actually changes — the rig on user input, the
 * alignment on each of its animated frames, the globe/pins on a rebake, and the
 * window on resize. Between those the canvas is static.
 *
 * SELECTION → ALIGNMENT: selecting a factor (card click, keyboard, or a
 * GPU-picked pin) flies the camera to face it over 750ms by interpolating
 * POSITION, not orientation. Any manual camera input drops the lock instantly
 * via the capture-phase interrupt guard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Factor, FieldPin, SortMode } from '../shared/types.js';
import { FeedResponseSchema, FieldResponseSchema, FactorSchema } from '../shared/schema.js';
import { GlobeMesh, EARTH_RADIUS_M, DEFAULT_EXAGGERATION } from './globe/GlobeMesh.js';
import { Coastlines } from './globe/Coastlines.js';
import { createLandMask } from './globe/landMask.js';
import { loadElevationGrid, sampleElevation } from './globe/elevation.js';
import { PinLayer } from './globe/PinLayer.js';
import { OrbitRig, GLOBE_RADIUS, MIN_ZOOM, MAX_ZOOM } from './camera/OrbitRig.js';
import { OrbitAlignment } from './camera/alignment.js';
import { attachInterrupt } from './camera/interrupt.js';
import { Sidebar } from './ui/Sidebar.js';
import { Clock } from './ui/Clock.js';
import { FactorDetails } from './ui/FactorDetails.js';
import { SubmitFactor } from './ui/SubmitFactor.js';
import type { ClockFactorInput, TippingPoint as ClockTippingPoint } from './ui/clockModel.js';

/**
 * Project a field pin onto the Clock's input shape. The zod-inferred
 * `FieldPin.tippingPoint` uses `.optional()` (each field typed `T | undefined`),
 * whereas the Clock's hand-written `ClockFactorInput`/`TippingPoint` use `?: T`
 * / `| null`. Under exactOptionalPropertyTypes those are nominally distinct even
 * though they mean the same thing, so we rebuild a clean tipping point carrying
 * only the fields that are actually present — no cast, no `undefined` leaking in.
 */
function toClockFactor(pin: FieldPin): ClockFactorInput {
  const tp = pin.tippingPoint;
  let tippingPoint: ClockTippingPoint | null = null;
  if (tp) {
    const built: {
      centralYear: number;
      earliestYear?: number;
      latestYear?: number;
      label?: string;
    } = { centralYear: tp.centralYear };
    if (tp.earliestYear !== undefined) built.earliestYear = tp.earliestYear;
    if (tp.latestYear !== undefined) built.latestYear = tp.latestYear;
    if (tp.label !== undefined) built.label = tp.label;
    tippingPoint = built;
  }
  return { effect: pin.effect, significance: pin.significance, tippingPoint };
}

/** Movement (in CSS px) below which a pointer down→up counts as a click, not a drag. */
const CLICK_SLOP_PX = 5;

/** Connection state of the live SSE delta stream, surfaced in the header. */
type StreamStatus = 'connecting' | 'live' | 'seed' | 'closed';

/* -------------------------------------------------------------------------- */
/* The three.js scene, encapsulated so the React component only holds a handle */
/* -------------------------------------------------------------------------- */

interface SceneHandle {
  setFieldPins(pins: readonly FieldPin[]): void;
  alignToLatLon(lat: number, lon: number): void;
  /** Toggle the coastline landmass overlay. */
  setLandVisible(visible: boolean): void;
  dispose(): void;
}

interface SceneCallbacks {
  /** A pin was GPU-picked. Receives the factor id under the pointer. */
  onPickFactor(id: string): void;
  /** Manual camera input dropped an in-flight alignment lock. */
  onInterrupt(): void;
}

function createScene(container: HTMLDivElement, callbacks: SceneCallbacks): SceneHandle {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x08080b, 1);

  const width = container.clientWidth || window.innerWidth;
  const height = container.clientHeight || window.innerHeight;
  renderer.setSize(width, height, false);
  const canvas = renderer.domElement;
  canvas.classList.add('tc-globe-canvas');
  container.appendChild(canvas);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.05 * GLOBE_RADIUS, 100);

  // Land mask raster: drives the shader's ocean-blue/land-green base and
  // the CPU land-relief displacement fallback. Built once from world-atlas 110m.
  const landMask = createLandMask();

  // Land-relief FALLBACK sampler: until the real elevation grid loads
  // (or offline, when it never does), raise land a small constant above the flat
  // ocean so continents still show in relief. Ocean (landFrac 0) stays at 0 m —
  // the same sea-level floor the real grid uses.
  const LAND_RELIEF_M = 2500;
  const globe = new GlobeMesh({
    radius: GLOBE_RADIUS,
    // Icosphere subdivision. three.js scales faces as 20·detail² (linear
    // resolution ∝ detail): detail 100 ≈ 204k faces / 612k position verts —
    // high-res but viable. One-time build + displace + a static wireframe; drop
    // it if the load-time build or the wireframe draw feels sluggish.
    detail: 100,
    landMaskTexture: landMask.texture,
    elevation: {
      sampleMeters: (lat, lon) => (landMask.sampleLand(lat, lon) > 0.5 ? LAND_RELIEF_M : 0),
    },
  });
  const pins = new PinLayer({ radius: GLOBE_RADIUS });
  // Coastline landmass overlay. Static — built once, never rebaked, so
  // (unlike globe/pins) it has no onNeedsRender subscription; one paint below.
  // Lift is a HAIRLINE z-fighting offset only: at 1.02 the lines floated
  // a visible 2% above the surface. 1.001 keeps them reading as ON the globe.
  const coastlines = new Coastlines({ radius: GLOBE_RADIUS, lift: 1.001 });
  scene.add(globe.object3D);
  scene.add(pins.object3D);
  scene.add(coastlines.object3D);

  /* --- render-on-demand coalescer -------------------------------- */
  let frameHandle: number | null = null;
  const renderFrame = (): void => {
    frameHandle = null;
    globe.syncCamera(camera);
    renderer.render(scene, camera);
  };
  const requestRender = (): void => {
    if (frameHandle === null) frameHandle = requestAnimationFrame(renderFrame);
  };

  /* --- camera control ----------------------------------------------------- */
  const rig = new OrbitRig(camera, {
    domElement: canvas,
    radius: GLOBE_RADIUS,
    minDistance: MIN_ZOOM,
    maxDistance: MAX_ZOOM,
    initial: { theta: Math.PI * 0.25, phi: Math.PI * 0.42, distance: MIN_ZOOM * 2.4 },
    onChange: requestRender,
  });
  const alignment = new OrbitAlignment(camera, rig);
  const interruptGuard = attachInterrupt(alignment, {
    target: canvas,
    onInterrupt: callbacks.onInterrupt,
  });

  const unsubGlobe = globe.onNeedsRender(requestRender);
  const unsubPins = pins.onNeedsRender(requestRender);

  /* --- pin picking (click, not drag) -------------------------------------- */
  // Reused for the field-halo fallback: a click that misses every pin pyramid
  // still selects the factor whose painted halo covers the clicked surface point.
  const raycaster = new THREE.Raycaster();
  const globeSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), GLOBE_RADIUS);
  const tmpHit = new THREE.Vector3();
  const tmpNdc = new THREE.Vector2();

  let downX = 0;
  let downY = 0;
  let downValid = false;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      downValid = false;
      return;
    }
    downX = event.clientX;
    downY = event.clientY;
    downValid = true;
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!downValid || event.button !== 0) return;
    downValid = false;
    const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
    if (moved > CLICK_SLOP_PX) return; // a drag, not a selection
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let id = pins.pick(renderer, camera, x, y);
    if (id === null) {
      // No pin pyramid hit — did the click land on a factor's painted halo?
      // Raycast the globe sphere for the surface direction, then select the pin
      // whose halo covers it (closest pin wins where halos overlap).
      tmpNdc.set((x / rect.width) * 2 - 1, -((y / rect.height) * 2 - 1));
      raycaster.setFromCamera(tmpNdc, camera);
      if (raycaster.ray.intersectSphere(globeSphere, tmpHit)) {
        id = pins.pickHalo(tmpHit.normalize());
      }
    }
    // Picking briefly rebinds the pin material/render target; repaint the scene.
    requestRender();
    if (id !== null) callbacks.onPickFactor(id);
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);

  /* --- resize ------------------------------------------------------------- */
  const onResize = (): void => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(container);

  // First paint (pure-geography globe until the field arrives). Also lands the
  // static coastline overlay, which never requests a redraw of its own.
  requestRender();

  // Real elevation displacement: fire-and-forget. The globe is already
  // showing the land-relief fallback; if the operator has baked the grid
  // (`npm run fetch:elevation`, needs network) we swap in real terrain. Returns
  // null offline / 404 → keep the fallback. Guarded against teardown.
  let sceneDisposed = false;
  void loadElevationGrid().then((grid) => {
    if (sceneDisposed || !grid) return;
    globe.setElevation({
      // Gate the displacement by the LAND MASK. The elevation grid is coarse
      // (240×120 ≈ 1.5°/166 km cells), so bilinear sampling bleeds land height
      // up to ~half a cell offshore — producing bumps in water that the much
      // finer mask (2048×1024, from the same 110m vectors as the coastline
      // lines) correctly paints blue. Gating makes relief ⊂ green land exactly,
      // so bumps and paint can never disagree.
      sampleMeters: (lat, lon) =>
        landMask.sampleLand(lat, lon) > 0.5 ? sampleElevation(grid, lat, lon) : 0,
      exaggeration: DEFAULT_EXAGGERATION,
      earthRadiusM: EARTH_RADIUS_M,
    });
    requestRender();
  });

  return {
    setFieldPins(pinSet): void {
      // : the ONLY place shader input is rewritten. Never called from
      // camera/scroll/sort/selection paths.
      globe.update(pinSet);
      pins.update(pinSet);
    },
    alignToLatLon(lat, lon): void {
      void alignment.alignToLatLon(lat, lon, { onFrame: requestRender });
    },
    setLandVisible(visible): void {
      coastlines.setVisible(visible);
      requestRender();
    },
    dispose(): void {
      sceneDisposed = true;
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      interruptGuard.dispose();
      unsubGlobe();
      unsubPins();
      alignment.cancel();
      rig.dispose();
      globe.dispose();
      pins.dispose();
      coastlines.dispose();
      landMask.dispose();
      renderer.dispose();
      // Release the WebGL context on teardown. renderer.dispose() frees GL
      // resources but leaves the context itself live; without this the browser
      // holds the context (and its backing GPU memory) until it is eventually
      // reclaimed, and a StrictMode remount / hot reload can exhaust the small
      // pool of simultaneous WebGL contexts. forceContextLoss() drops it now.
      renderer.forceContextLoss();
      if (canvas.parentNode === container) container.removeChild(canvas);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function App(): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneHandle | null>(null);

  // Sidebar feed state (data path 1).
  const [feedFactors, setFeedFactors] = useState<Factor[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // Shader field state (data path 2) — camera-invariant.
  const [fieldPins, setFieldPins] = useState<FieldPin[]>([]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Right-edge slideout open state. Closed by default so the globe is
  // the full-bleed hero; the FEED tab / a pin selection opens it.
  const [panelOpen, setPanelOpen] = useState(false);
  // Anonymous submission form. A THIRD mutually-exclusive occupant of
  // the same slideout, taking precedence over both feed and detail while open.
  // Kept as its own flag (rather than folded into selectedId) so closing it
  // returns the panel to exactly the state it was in before.
  const [submitOpen, setSubmitOpen] = useState(false);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting');
  const [following, setFollowing] = useState(false);
  // Coastline landmass overlay visibility. Default ON.
  const [landVisible, setLandVisible] = useState(true);

  /* ----- coordinate lookup for alignment (id → lat/lon) ------------------- */
  // Built from BOTH data paths so a pin picked from the field set can be aligned
  // even before its card has paged into the feed.
  const coordsRef = useRef<Map<string, { lat: number; lon: number }>>(new Map());
  useEffect(() => {
    const map = new Map<string, { lat: number; lon: number }>();
    for (const p of fieldPins) map.set(p.id, { lat: p.lat, lon: p.lon });
    for (const f of feedFactors) map.set(f.id, { lat: f.lat, lon: f.lon });
    coordsRef.current = map;
  }, [fieldPins, feedFactors]);

  /* ----- scene lifecycle -------------------------------------------------- */
  // Latest pick handler, referenced by the (once-created) scene via a ref so the
  // canvas listener always calls current React state setters.
  const selectRef = useRef<(id: string, opts?: { scroll?: boolean }) => void>(() => {});

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const handle = createScene(mount, {
      onPickFactor: (id) => selectRef.current(id, { scroll: true }),
      onInterrupt: () => setFollowing(false),
    });
    sceneRef.current = handle;
    return () => {
      handle.dispose();
      sceneRef.current = null;
    };
  }, []);

  /* ----- data path 2: field → GPU -------------------------------- */
  // Hand the field set to the shader baker whenever it changes. This effect and
  // the SSE-driven refetch below are the only writers of shader input.
  useEffect(() => {
    sceneRef.current?.setFieldPins(fieldPins);
  }, [fieldPins]);

  // Push the coastline overlay toggle to the scene whenever it changes.
  useEffect(() => {
    sceneRef.current?.setLandVisible(landVisible);
  }, [landVisible]);

  const loadField = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/field');
      if (!res.ok) throw new Error(`field ${res.status}`);
      const json: unknown = await res.json();
      const parsed = FieldResponseSchema.parse(json);
      setFieldPins(parsed.pins);
    } catch (err) {
      // A field fetch failure leaves the globe inert grey — the correct "no
      // data" state — rather than crashing the instrument.
      console.error('[field] fetch failed:', err);
    }
  }, []);

  useEffect(() => {
    void loadField();
  }, [loadField]);

  /* ----- data path 1: sidebar feed --------------------------------------- */
  // A generation token guards against out-of-order responses when the sort mode
  // flips mid-flight (the older request must not clobber the newer list).
  const feedGenRef = useRef(0);

  const fetchFeedPage = useCallback(
    async (mode: SortMode, cursor: string | null, gen: number): Promise<void> => {
      setFeedLoading(true);
      try {
        const params = new URLSearchParams({ sortMode: mode });
        if (cursor) params.set('cursor', cursor);
        const res = await fetch(`/api/factors?${params.toString()}`);
        if (!res.ok) throw new Error(`factors ${res.status}`);
        const json: unknown = await res.json();
        const parsed = FeedResponseSchema.parse(json);
        if (gen !== feedGenRef.current) return; // superseded by a newer request
        setFeedFactors((prev) => (cursor ? [...prev, ...parsed.factors] : parsed.factors));
        setNextCursor(parsed.nextCursor);
      } catch (err) {
        if (gen === feedGenRef.current) console.error('[feed] fetch failed:', err);
      } finally {
        if (gen === feedGenRef.current) {
          setFeedLoading(false);
          setHasLoadedOnce(true);
        }
      }
    },
    [],
  );

  // First page + reset whenever the sort mode changes (: a sort toggle is a
  // new result set, so the cursor is discarded and we restart from page one).
  useEffect(() => {
    const gen = ++feedGenRef.current;
    setFeedFactors([]);
    setNextCursor(null);
    setHasLoadedOnce(false);
    void fetchFeedPage(sortMode, null, gen);
  }, [sortMode, fetchFeedPage]);

  const handleLoadMore = useCallback(() => {
    if (feedLoading || nextCursor === null) return;
    void fetchFeedPage(sortMode, nextCursor, feedGenRef.current);
  }, [feedLoading, nextCursor, sortMode, fetchFeedPage]);

  /* ----- SSE live stream ---------------------------------------- */
  useEffect(() => {
    const source = new EventSource('/api/stream');
    let fieldRefetch: number | null = null;

    const scheduleFieldRefetch = (): void => {
      // Coalesce a burst of deltas into a single field refetch. This is the
      // second (and only other) writer of shader input — invalidation-driven,
      // never camera-driven.
      if (fieldRefetch !== null) return;
      fieldRefetch = window.setTimeout(() => {
        fieldRefetch = null;
        void loadField();
      }, 250);
    };

    source.addEventListener('ready', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { mode?: string };
        setStreamStatus(data.mode === 'db' ? 'live' : 'seed');
      } catch {
        setStreamStatus('live');
      }
    });

    source.addEventListener('factor', (event) => {
      // Patch the cached card in place (: escalations reach the sidebar
      // out-of-band, not through the immutable-keyset backfill feed) …
      try {
        const delta: unknown = JSON.parse((event as MessageEvent).data);
        const parsed = FactorSchema.safeParse(delta);
        if (parsed.success) {
          const updated = parsed.data;
          setFeedFactors((prev) => {
            const idx = prev.findIndex((f) => f.id === updated.id);
            if (idx === -1) return prev;
            const copy = prev.slice();
            copy[idx] = updated;
            return copy;
          });
        }
      } catch {
        // A non-JSON or partial delta still means "something changed" — fall
        // through to the field refetch, which reconciles from the source.
      }
      // … and invalidate the shader field so the heatmap reflects the change.
      scheduleFieldRefetch();
    });

    source.onerror = () => {
      // EventSource auto-reconnects; reflect the transient drop in the header.
      setStreamStatus((s) => (s === 'live' || s === 'seed' ? s : 'closed'));
    };

    return () => {
      if (fieldRefetch !== null) window.clearTimeout(fieldRefetch);
      source.close();
    };
  }, [loadField]);

  /* ----- selection → camera alignment --------------------------- */
  const selectFactor = useCallback((id: string, opts?: { scroll?: boolean }) => {
    setSelectedId(id);
    // Any selection — pin pick or feed card — auto-opens the slideout in detail
    // mode. selectedId !== null makes the panel render FactorDetails.
    setPanelOpen(true);
    // A selection is a request to look at THAT factor, so it dismisses the
    // submission form rather than being silently hidden behind it.
    setSubmitOpen(false);
    const coords = coordsRef.current.get(id);
    if (coords) {
      sceneRef.current?.alignToLatLon(coords.lat, coords.lon);
      setFollowing(true);
    }
    if (opts?.scroll) {
      // Bring the (possibly off-screen) card into view when the selection came
      // from a pin click rather than the list itself.
      window.requestAnimationFrame(() => {
        document.getElementById(`tc-factor-${id}`)?.scrollIntoView({ block: 'nearest' });
      });
    }
  }, []);
  // Keep the ref the scene calls pointed at the latest closure.
  useEffect(() => {
    selectRef.current = selectFactor;
  }, [selectFactor]);

  const handleSelect = useCallback(
    (id: string) => {
      selectFactor(id);
    },
    [selectFactor],
  );

  // Escape closes the slideout when it is in FEED mode. In DETAIL mode
  // FactorDetails owns Escape (it stops propagation and returns to feed), so the
  // sequence is: Escape once → feed, Escape again → closed.
  // While the submission form is open it owns Escape (closing it returns to
  // whatever the panel was showing before), so the layering becomes:
  // Escape → close submit → close detail → close panel ( on top of ).
  useEffect(() => {
    if (!panelOpen) return;
    if (!submitOpen && selectedId !== null) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (submitOpen) setSubmitOpen(false);
      else setPanelOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [panelOpen, selectedId, submitOpen]);

  /* ----- derived ---------------------------------------------------------- */
  const hasMore = nextCursor !== null;

  // The selected factor's FULL record (citations live in the feed set). When the
  // selection is a globe pin whose card has not paged in yet, fall back to the
  // lean field pin so the detail panel can still show metrics + a "loading" note
  // rather than nothing.
  const selectedFactor = useMemo(
    () => (selectedId ? feedFactors.find((f) => f.id === selectedId) ?? null : null),
    [selectedId, feedFactors],
  );
  const selectedPin = useMemo(
    () =>
      selectedId && !selectedFactor
        ? fieldPins.find((p) => p.id === selectedId) ?? null
        : null,
    [selectedId, selectedFactor, fieldPins],
  );

  // The Clock reads the FIELD set, now carrying tipping points.
  // Projected onto the Clock's input shape (see toClockFactor). Memoised so the
  // model only re-derives when the pin set actually changes.
  const clockFactors = useMemo<ClockFactorInput[]>(
    () => fieldPins.map(toClockFactor),
    [fieldPins],
  );

  const streamLabel = useMemo<Record<StreamStatus, string>>(
    () => ({ connecting: 'CONNECTING', live: 'LIVE', seed: 'SEED', closed: 'RECONNECTING' }),
    [],
  );

  return (
    <div className="tc-app">
      <div className="tc-globe-mount" ref={mountRef} aria-hidden="true" />

      <div className="tc-overlay">
        <header className="tc-topbar">
          <div className="tc-brand">
            <span className="tc-brand-mark">◎</span>
            <span className="tc-brand-name">TARGET: CALAMITY</span>
          </div>
          <div className="tc-status">
            <span
              className={`tc-status-dot tc-status-dot--${streamStatus}`}
              aria-hidden="true"
            />
            <span className="tc-status-label">STREAM: {streamLabel[streamStatus]}</span>
            <span className="tc-status-sep">·</span>
            <span className="tc-status-label">
              FIELD: {fieldPins.length} PINS
            </span>
            <span className="tc-status-sep">·</span>
            <button
              type="button"
              className="tc-status-toggle"
              aria-pressed={landVisible}
              onClick={() => setLandVisible((v) => !v)}
              title="Toggle coastline landmass overlay"
            >
              LAND: {landVisible ? 'ON' : 'OFF'}
            </button>
            <span className="tc-status-sep">·</span>
            {/* Anonymous submission (ADR-45). Opens the slideout onto the form
                without disturbing the feed/detail state behind it. */}
            <button
              type="button"
              className="tc-status-submit"
              aria-expanded={submitOpen}
              aria-controls="tc-slideout"
              onClick={() => {
                setSubmitOpen(true);
                setPanelOpen(true);
              }}
              title="Propose a factor (one per day, no account needed)"
            >
              Submit
            </button>
            {following ? (
              <>
                <span className="tc-status-sep">·</span>
                <span className="tc-status-label tc-status-label--follow">TRACKING</span>
              </>
            ) : null}
          </div>
        </header>

        <div className="tc-clock-slot">
          <Clock factors={clockFactors} />
        </div>

        <footer className="tc-hint">
          <span>DRAG or WASDQE to orbit · WHEEL to zoom · CLICK a pin or card to align</span>
        </footer>

        {/* Right-edge FEED tab — opens the slideout when it is closed (ADR-40). */}
        <button
          type="button"
          className="tc-feed-tab"
          aria-expanded={panelOpen}
          aria-controls="tc-slideout"
          hidden={panelOpen}
          onClick={() => setPanelOpen(true)}
        >
          <span className="tc-feed-tab__label">FEED</span>
        </button>

        {/* Single right-anchored slideout: shows the factor FEED (Sidebar) XOR
            the node DETAIL (FactorDetails), never both — mutually exclusive on
            selectedId (ADR-40). Slides over the full-bleed globe. */}
        <section
          id="tc-slideout"
          className={`tc-slideout${panelOpen ? ' tc-slideout--open' : ''}`}
          aria-label={
            submitOpen
              ? 'Submit a factor'
              : selectedId !== null
                ? 'Factor detail'
                : 'Factor feed'
          }
          aria-hidden={!panelOpen}
        >
          <button
            type="button"
            className="tc-slideout__collapse"
            onClick={() => setPanelOpen(false)}
            aria-label="Collapse panel"
            tabIndex={panelOpen ? 0 : -1}
          >
            ›
          </button>

          <div className="tc-slideout__body">
            {submitOpen ? (
              <SubmitFactor onClose={() => setSubmitOpen(false)} />
            ) : selectedId !== null ? (
              <FactorDetails
                factor={selectedFactor}
                pin={selectedPin}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <Sidebar
                factors={feedFactors}
                selectedId={selectedId}
                onSelect={handleSelect}
                sortMode={sortMode}
                onSortModeChange={setSortMode}
                onLoadMore={handleLoadMore}
                hasMore={hasMore}
                loading={feedLoading || !hasLoadedOnce}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
