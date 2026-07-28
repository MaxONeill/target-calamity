import * as THREE from 'three';
import { GlobeMesh } from '../globe/GlobeMesh.js';
import { Coastlines } from '../globe/Coastlines.js';
import { createLandMask } from '../globe/landMask.js';
import { PinLayer } from '../globe/PinLayer.js';
import { GlobalRing } from '../globe/GlobalRing.js';
import { OrbitRig, GLOBE_RADIUS, MIN_ZOOM, MAX_ZOOM } from '../camera/OrbitRig.js';
import { OrbitAlignment } from '../camera/alignment.js';
import { attachInterrupt } from '../camera/interrupt.js';
import { attachPicking } from './attachPicking.js';
import { applyRealTerrain, landReliefSampler } from './terrain.js';
import { latLonToVector3 } from '../lib/geo.js';
import { viewerLocation } from '../lib/viewerLocation.js';
import type { SceneCallbacks, SceneHandle } from './types.js';

/**
 * Icosphere subdivision. three.js scales faces as 20·detail², so detail 100 is
 * roughly 204k faces — a one-time build and a static wireframe.
 */
const GLOBE_DETAIL = 100;

/**
 * Above-surface lift for the coastline lines. A vertex at height H metres sits
 * at radius·(1 + H·exaggeration/EARTH_RADIUS), so at exaggeration 120 a lift of
 * 1.001 only clears land below ~53 m — coastal relief above that pokes through
 * the outline. 1.006 clears ~320 m of coastal terrain while staying close enough
 * to the surface that the lines still read as sitting on it.
 */
const COASTLINE_LIFT = 1.007;

/**
 * Ambient rotation rate, radians per second. One revolution in ~4 minutes:
 * fast enough to read as alive, slow enough that it is not competing with the
 * reader for attention while they look at a pin.
 */
const AUTO_ROTATE_RATE = (Math.PI * 2) / 240;

/**
 * How long after the last manual input before ambient rotation resumes. Long
 * enough that letting go to read something does not immediately start the globe
 * drifting under the cursor.
 */
const AUTO_ROTATE_RESUME_MS = 3000;

/**
 * Builds the three.js instrument and returns the handle React drives it through.
 *
 * The scene repaints on demand only: `requestRender` coalesces to one frame, and
 * is called when something actually changes rather than from a standing
 * animation loop, so an idle page costs nothing.
 */
export function createScene(container: HTMLDivElement, callbacks: SceneCallbacks): SceneHandle {
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

  const landMask = createLandMask();
  const globe = new GlobeMesh({
    radius: GLOBE_RADIUS,
    detail: GLOBE_DETAIL,
    landMaskTexture: landMask.texture,
    elevation: { sampleMeters: landReliefSampler(landMask) },
  });
  const pins = new PinLayer({ radius: GLOBE_RADIUS });
  const coastlines = new Coastlines({ radius: GLOBE_RADIUS, lift: COASTLINE_LIFT });
  const ring = new GlobalRing({ radius: GLOBE_RADIUS });

  scene.add(globe.object3D);
  scene.add(pins.object3D);
  scene.add(coastlines.object3D);
  scene.add(ring.object3D);

  let frameHandle: number | null = null;
  const renderFrame = (): void => {
    frameHandle = null;
    globe.syncCamera(camera);
    ring.faceCamera(camera);
    renderer.render(scene, camera);
  };
  const requestRender = (): void => {
    frameHandle ??= requestAnimationFrame(renderFrame);
  };

  /* ---------------------------------------------------------------------- *
   * Ambient rotation                                                        *
   * ---------------------------------------------------------------------- *
   *
   * THE ONE STANDING rAF IN THE APP, and it only stands while it is actually
   * rotating. Render-on-demand is the rule everywhere else and it still holds
   * when this is paused: the loop cancels itself rather than idling, so a
   * reader looking at a selected pin costs no frames at all.
   *
   * It yields to everything. Manual input defers it (see `onUserInput` on the
   * rig, which fires on drag and wheel alike), a selected factor suspends it
   * outright — the camera has been flown somewhere deliberate and drifting off
   * it would undo the alignment the click just performed — and it never runs
   * before the field has loaded, so the globe is not spinning behind a spinner.
   */
  let disposed = false;
  let rotating = false;
  let rotateHandle: number | null = null;
  let rotateLastTime = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionHolds = false;
  let fieldReady = false;

  const rotateTick = (now: number): void => {
    if (!rotating) {
      rotateHandle = null;
      return;
    }
    // Clamped: a backgrounded tab resumes with a huge delta, which would snap
    // the globe round instead of continuing from where it was.
    const dt = Math.min((now - rotateLastTime) / 1000, 0.1);
    rotateLastTime = now;
    rig.orbitBy(AUTO_ROTATE_RATE * dt);
    rotateHandle = requestAnimationFrame(rotateTick);
  };

  const startAutoRotate = (): void => {
    if (rotating || selectionHolds || !fieldReady || disposed) return;
    rotating = true;
    rotateLastTime = performance.now();
    rotateHandle ??= requestAnimationFrame(rotateTick);
  };

  const stopAutoRotate = (): void => {
    rotating = false;
    if (rotateHandle !== null) {
      cancelAnimationFrame(rotateHandle);
      rotateHandle = null;
    }
  };

  /** Pause now, and resume once the reader has been still for a moment. */
  const deferAutoRotate = (): void => {
    stopAutoRotate();
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      startAutoRotate();
    }, AUTO_ROTATE_RESUME_MS);
  };

  /*
   * Open with the viewer's own part of the world facing them, rather than a
   * fixed angle that lands most readers on an ocean.
   *
   * The lat/lon -> direction conversion goes through `latLonToVector3` and
   * nothing else: hand-rolled trig on a coordinate is how the globe ends up
   * mirrored relative to its own pins, and it passes a |v| = R check while
   * doing it. Spherical only reads the resulting VECTOR, which is generic
   * geometry rather than geography.
   */
  const home = viewerLocation();
  const homeSpherical = new THREE.Spherical().setFromVector3(
    latLonToVector3(home.lat, home.lon, GLOBE_RADIUS),
  );

  const rig = new OrbitRig(camera, {
    domElement: canvas,
    radius: GLOBE_RADIUS,
    minDistance: MIN_ZOOM,
    maxDistance: MAX_ZOOM,
    initial: {
      theta: homeSpherical.theta,
      phi: homeSpherical.phi,
      distance: MIN_ZOOM * 2.4,
    },
    onChange: requestRender,
    // Only TURNING the globe pauses the drift. A wheel zoom changes how close
    // the camera is, not where it points, so the two are not competing for the
    // same axis — pausing on zoom just made the globe stop for no visible
    // reason. Pinch is a two-finger gesture on the globe itself and its first
    // contact has already deferred as a drag, which is the right outcome.
    onUserInput: (source) => {
      if (source === 'drag') deferAutoRotate();
    },
  });
  const alignment = new OrbitAlignment(camera, rig);
  const interruptGuard = attachInterrupt(alignment, {
    target: canvas,
    onInterrupt: callbacks.onInterrupt,
  });

  const unsubGlobe = globe.onNeedsRender(requestRender);
  const unsubPins = pins.onNeedsRender(requestRender);
  const unsubRing = ring.onNeedsRender(requestRender);

  const detachPicking = attachPicking({
    canvas,
    renderer,
    camera,
    pins,
    ring,
    globeRadius: GLOBE_RADIUS,
    onPick: callbacks.onPickFactor,
    onHover: callbacks.onHoverFactor,
    requestRender,
  });

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

  // First paint: plain geography until the field arrives. Also lands the static
  // coastline overlay, which never requests a redraw of its own.
  requestRender();

  void applyRealTerrain(globe, landMask, () => disposed, requestRender);

  return {
    setFieldPins(pinSet): void {
      globe.update(pinSet);
      pins.update(pinSet);
    },

    /**
     * The field has been applied at least once — the globe is showing data
     * rather than an unwritten shader, so it is safe to reveal and to rotate.
     * React owns the decision because only it knows the fetch resolved; an
     * empty pin set is a legitimate answer, not a signal that nothing arrived.
     */
    setFieldReady(ready): void {
      fieldReady = ready;
      if (ready) startAutoRotate();
      else stopAutoRotate();
    },

    setGlobalFactors(factors): void {
      ring.update(factors);
      globe.setGlobalAggregate(factors);
    },

    setHighlighted(id): void {
      // Routed to both layers; each ignores an id it does not own.
      pins.setHighlighted(id);
      ring.setHighlighted(id);
    },

    setSelected(id): void {
      pins.setSelected(id);
      ring.setSelected(id);
      // A selection holds the camera where the alignment put it. Resuming the
      // drift would slowly undo the framing the click just asked for.
      selectionHolds = id !== null;
      if (selectionHolds) {
        stopAutoRotate();
        if (resumeTimer !== null) {
          clearTimeout(resumeTimer);
          resumeTimer = null;
        }
      } else {
        deferAutoRotate();
      }
    },

    alignToLatLon(lat, lon): void {
      void alignment.alignToLatLon(lat, lon, { onFrame: requestRender });
    },

    setLandVisible(visible): void {
      coastlines.setVisible(visible);
      requestRender();
    },

    dispose(): void {
      disposed = true;
      stopAutoRotate();
      if (resumeTimer !== null) clearTimeout(resumeTimer);
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      resizeObserver.disconnect();
      detachPicking();
      interruptGuard.dispose();
      unsubGlobe();
      unsubPins();
      unsubRing();
      alignment.cancel();
      rig.dispose();
      globe.dispose();
      pins.dispose();
      coastlines.dispose();
      ring.dispose();
      landMask.dispose();
      renderer.dispose();
      // renderer.dispose() frees GL resources but leaves the context live. A
      // StrictMode remount or hot reload would otherwise exhaust the browser's
      // small pool of simultaneous WebGL contexts.
      renderer.forceContextLoss();
      if (canvas.parentNode === container) container.removeChild(canvas);
    },
  };
}
