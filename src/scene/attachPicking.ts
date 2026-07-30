import * as THREE from 'three';
import type { PinLayer } from '../globe/PinLayer.js';
import type { GlobalRing } from '../globe/GlobalRing.js';

/** Movement in CSS px below which a pointer down→up counts as a click, not a drag. */
const CLICK_SLOP_PX = 5;

/**
 * Radius in CSS px searched for overlapping pins.
 *
 * Wide enough that a cluster too tight to click apart is caught whole, narrow
 * enough that the peek is about what the cursor is actually on rather than a
 * regional summary. Pins are a few px across, so this covers roughly the
 * neighbouring two or three.
 */
const PEEK_RADIUS_PX = 9;

export interface PickingOptions {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  pins: PinLayer;
  ring: GlobalRing;
  globeRadius: number;
  onPick: (id: string) => void;
  /** Reports the factor under the pointer as it moves. Null when over nothing. */
  onHover: (id: string | null) => void;
  /** Reports every pin under/near the pointer, nearest first, for the peek. */
  onHoverPins: (ids: readonly string[], clientX: number, clientY: number) => void;
  /** Picking rebinds the pin material, so the scene must repaint afterwards. */
  requestRender: () => void;
}

/**
 * Wires click-to-select and hover on the canvas.
 *
 * Both resolve a pointer position to a factor the same way: the pin geometry
 * first (exact), then the ring arcs, then the pin whose painted halo covers the
 * clicked surface point. Hover is coalesced to one pick per animation frame, so
 * dragging the pointer never issues more than one GPU read-back per frame.
 *
 * @returns a teardown function removing the listeners.
 */
export function attachPicking(options: PickingOptions): () => void {
  const {
    canvas,
    renderer,
    camera,
    pins,
    ring,
    globeRadius,
    onPick,
    onHover,
    onHoverPins,
    requestRender,
  } = options;

  const raycaster = new THREE.Raycaster();
  const globeSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), globeRadius);
  const surfaceHit = new THREE.Vector3();
  const ndc = new THREE.Vector2();

  /** Resolves canvas-local CSS pixels to a factor id, or null. */
  const pickAt = (x: number, y: number, rectW: number, rectH: number): string | null => {
    const id = pins.pick(renderer, camera, x, y);
    if (id !== null) return id;

    ndc.set((x / rectW) * 2 - 1, -((y / rectH) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);

    // The ring sits outside the globe, so it is tested before the halo: a click
    // landing on an arc is unambiguous, where a halo hit is a fallback guess.
    const ringId = ring.pick(raycaster);
    if (ringId !== null) return ringId;

    if (raycaster.ray.intersectSphere(globeSphere, surfaceHit)) {
      return pins.pickHalo(surfaceHit.normalize());
    }
    return null;
  };

  /* ------------------------------- selection ------------------------------- */
  let downX = 0;
  let downY = 0;
  let downValid = false;

  // Live contacts, so a pinch cannot land as a tap. A second finger arrives
  // with its own clientX/Y; without this the gesture would re-seed downX/downY
  // and release within CLICK_SLOP_PX of it, selecting whatever was underneath.
  const active = new Set<number>();

  const onPointerDown = (event: PointerEvent): void => {
    active.add(event.pointerId);
    if (active.size > 1) {
      downValid = false;
      return;
    }
    downValid = event.button === 0;
    if (!downValid) return;
    downX = event.clientX;
    downY = event.clientY;
  };

  const onPointerCancel = (event: PointerEvent): void => {
    active.delete(event.pointerId);
    downValid = false;
  };

  const onPointerUp = (event: PointerEvent): void => {
    active.delete(event.pointerId);
    if (!downValid || event.button !== 0) return;
    downValid = false;
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > CLICK_SLOP_PX) return;

    const rect = canvas.getBoundingClientRect();
    const id = pickAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);

    requestRender();
    if (id !== null) onPick(id);
  };

  /* --------------------------------- hover --------------------------------- */
  let hoverId: string | null = null;
  let peekIds: readonly string[] = [];
  const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  let pendingHover: { x: number; y: number } | null = null;
  let hoverFrame: number | null = null;

  const resolveHover = (): void => {
    hoverFrame = null;
    if (pendingHover === null) return;
    const { x: clientX, y: clientY } = pendingHover;
    pendingHover = null;

    const rect = canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    /*
     * TWO SOURCES, because a pin claims two different things.
     *
     *   1. its MARKER — the spike, resolved from the ID buffer over a small
     *      neighbourhood, which catches pins too close together to click apart;
     *   2. its HALO — the area of surface its field tints, which is the pin's
     *      actual footprint on the globe and is very much larger.
     *
     * Listing only the markers answers a narrower question than the surface is
     * posing: where two halos overlap, the reader is looking at a blended patch
     * produced by both factors, and both belong in the peek even though only one
     * spike (or neither) is under the cursor.
     *
     * Markers come first because they are exact; halo hits follow in order of
     * angular closeness. `nearbySet` keeps a pin from appearing twice when it
     * qualifies on both counts.
     */
    const markers = pins.pickAll(renderer, camera, localX, localY, PEEK_RADIUS_PX);

    let halos: readonly string[] = [];
    ndc.set((localX / rect.width) * 2 - 1, -((localY / rect.height) * 2 - 1));
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectSphere(globeSphere, surfaceHit)) {
      halos = pins.pickHaloAll(surfaceHit.normalize());
    }

    const seen = new Set(markers);
    const nearby = [...markers, ...halos.filter((id) => !seen.has(id))];

    // Emphasis still follows the exact hit — a marker if there is one, otherwise
    // whatever `pickAt` resolves, which includes the ring arcs the peek ignores.
    const next = markers[0] ?? pickAt(localX, localY, rect.width, rect.height);

    if (next !== hoverId) {
      hoverId = next;
      onHover(next);
    }
    /*
     * EMITTED ONLY WHEN THE SET CHANGES, so the peek anchors where it appeared
     * instead of tracking the pointer.
     *
     * A cursor-following peek is unusable the moment it lists more than one row:
     * moving toward the second row moves the panel by the same amount, so the
     * first row is the only one that can ever be reached. The position reported
     * here is where the group was FOUND; the pointer is then free to leave it
     * and travel to the panel.
     */
    if (!sameIds(nearby, peekIds)) {
      peekIds = nearby;
      onHoverPins(nearby, clientX, clientY);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    pendingHover = { x: event.clientX, y: event.clientY };
    hoverFrame ??= requestAnimationFrame(resolveHover);
  };

  const onPointerLeave = (): void => {
    pendingHover = null;
    if (hoverId !== null) {
      hoverId = null;
      onHover(null);
    }
    if (peekIds.length > 0) {
      peekIds = [];
      onHoverPins([], 0, 0);
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  return () => {
    if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
  };
}
