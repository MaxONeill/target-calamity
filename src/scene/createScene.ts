import * as THREE from 'three';
import { GlobeMesh } from '../globe/GlobeMesh.js';
import { Coastlines } from '../globe/Coastlines.js';
import { createLandMask } from '../globe/landMask.js';
import { PinLayer } from '../globe/PinLayer.js';
import { OrbitRig, GLOBE_RADIUS, MIN_ZOOM, MAX_ZOOM } from '../camera/OrbitRig.js';
import { OrbitAlignment } from '../camera/alignment.js';
import { attachInterrupt } from '../camera/interrupt.js';
import { attachPicking } from './attachPicking.js';
import { applyRealTerrain, landReliefSampler } from './terrain.js';
import type { SceneCallbacks, SceneHandle } from './types.js';

/**
 * Icosphere subdivision. three.js scales faces as 20·detail², so detail 100 is
 * roughly 204k faces — a one-time build and a static wireframe.
 */
const GLOBE_DETAIL = 100;

/** Hairline offset keeping coastlines out of z-fighting without floating them. */
const COASTLINE_LIFT = 1.001;

/**
 * Builds the three.js instrument and returns the handle React drives it through.
 *
 * The scene repaints on demand only: `requestRender` coalesces to one frame, and
 * is called when something actually changes rather than from a standing
 * animation loop, so an idle page costs nothing.
 */
export function createScene(
  container: HTMLDivElement,
  callbacks: SceneCallbacks,
): SceneHandle {
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

  scene.add(globe.object3D);
  scene.add(pins.object3D);
  scene.add(coastlines.object3D);

  let frameHandle: number | null = null;
  const renderFrame = (): void => {
    frameHandle = null;
    globe.syncCamera(camera);
    renderer.render(scene, camera);
  };
  const requestRender = (): void => {
    if (frameHandle === null) frameHandle = requestAnimationFrame(renderFrame);
  };

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

  const detachPicking = attachPicking({
    canvas,
    renderer,
    camera,
    pins,
    globeRadius: GLOBE_RADIUS,
    onPick: callbacks.onPickFactor,
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

  let disposed = false;
  void applyRealTerrain(globe, landMask, () => disposed, requestRender);

  return {
    setFieldPins(pinSet): void {
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
      disposed = true;
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      resizeObserver.disconnect();
      detachPicking();
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
      // renderer.dispose() frees GL resources but leaves the context live. A
      // StrictMode remount or hot reload would otherwise exhaust the browser's
      // small pool of simultaneous WebGL contexts.
      renderer.forceContextLoss();
      if (canvas.parentNode === container) container.removeChild(canvas);
    },
  };
}
