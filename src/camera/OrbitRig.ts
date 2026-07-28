/**
 * OrbitRig — spherical orbit state (theta, phi, radius) applied to a three.js
 * PerspectiveCamera that always looks at the globe center (0,0,0).
 *
 * The rig is the single owner of manual camera control:
 *   - pointer drag  → orbit (mutate theta/phi)
 *   - mouse wheel   → zoom  (mutate radius)
 *
 * NO KEYBOARD CONTROL, deliberately. WASDQE used to orbit and zoom, bound to
 * `window` because the canvas is not focusable. That is precisely why it had to
 * go: the globe moved while the user typed a claim into the submission form.
 * A window-level key handler cannot reliably tell "typing" from "driving the
 * camera" — guarding on `event.target` being an input is a denylist that breaks
 * again on the next textarea, contenteditable, or focused dialog. Pointer and
 * wheel have no such ambiguity, so camera control is theirs alone.
 *
 * Design notes:
 *   - The orbit pivot is the origin and is NEVER reassigned: the globe
 *     center stays the look-at target, so drag behavior is identical before and
 *     after an automated alignment.
 *   - `phi` (polar angle from +Y) is clamped away from the poles by POLAR_LIMIT
 *     so the look-at basis (up × forward) never collapses.
 *   - Render-on-demand: the rig does not run an unconditional rAF loop, and
 *     since the keyboard loop was removed it runs no internal rAF at all. It
 *     fires `onChange` only when state actually changes.
 *   - Every manipulation begins with `syncFromCamera()`, so if an automated
 *     alignment (src/camera/alignment.ts) left the camera somewhere, manual
 *     control resumes seamlessly from that exact pose regardless of the order in
 *     which the interrupt handler and this rig receive the triggering event.
 *
 * This module uses THREE.Spherical for the spherical↔Cartesian mapping and does
 * NOT touch geography; lat/lon → vector conversion lives solely in
 * src/lib/geo.ts. No trig on any lat/lon identifier appears here.
 */
import * as THREE from 'three';

/**
 * Globe render radius (R). Must match the `IcosahedronGeometry(R, detail)` used
 * by the globe module. The geo helper defaults to R = 1 and the globe is
 * rendered on the unit sphere, so R = 1 here.
 */
export const GLOBE_RADIUS = 1;

/**
 * Near plane bound: `camera.near ≤ 0.05·R`, paired with MIN_ZOOM so the
 * near plane can never enter the mesh. The rig sets this on the camera it drives.
 */
export const CAMERA_NEAR = 0.05 * GLOBE_RADIUS;

/**
 * Minimum orbit distance: `MIN_ZOOM = 1.15·R`, strictly greater than R
 * with margin so the camera cannot reach the globe skin. Automated framing
 * (alignment.ts) and manual zoom share this exact range.
 */
export const MIN_ZOOM = 1.15 * GLOBE_RADIUS;

/** Maximum orbit distance. Shared with automated framing. */
export const MAX_ZOOM = 8 * GLOBE_RADIUS;

/**
 * Polar clamp margin in radians. `phi` is held to [POLAR_LIMIT, π − POLAR_LIMIT]
 * so the pole axis is never exactly parallel to the view direction. This is the
 * single place up-vector degeneracy is resolved for manual control; the
 * alignment module reuses the same limit to hold pre-animation azimuth when a
 * destination lands within POLAR_LIMIT of a pole.
 */
export const POLAR_LIMIT = 1e-3;

/** Immutable orbit pivot — the globe center. Never reassigned. */
const ORBIT_TARGET = new THREE.Vector3(0, 0, 0);

/**
 * What kind of manipulation began. Reported to `onUserInput` so a listener can
 * treat zooming differently from turning the globe: a wheel changes how close
 * the camera is, not where it is pointed, so it has no quarrel with an ambient
 * rotation the way a drag does.
 */
export type ManipulationSource = 'drag' | 'pinch' | 'wheel';

export interface OrbitRigOptions {
  /** Element that receives pointer/wheel listeners (typically the canvas). */
  domElement: HTMLElement;
  /** Globe radius R. Defaults to {@link GLOBE_RADIUS}. */
  radius?: number;
  /** Minimum orbit distance. Defaults to {@link MIN_ZOOM}. */
  minDistance?: number;
  /** Maximum orbit distance. Defaults to {@link MAX_ZOOM}. */
  maxDistance?: number;
  /** Initial spherical state. Missing fields fall back to a sensible framing. */
  initial?: { theta?: number; phi?: number; distance?: number };
  /** Orbit sensitivity for pointer drag, radians per pixel. */
  rotateSpeed?: number;
  /** Wheel zoom sensitivity, fraction per wheel-delta unit. */
  wheelZoomSpeed?: number;
  /** Called after any state change so the host can render on demand. */
  onChange?: () => void;
  /**
   * Called at the very start of a manual manipulation, with what kind it is.
   * Useful as a hook, though the interrupt handler in src/camera/interrupt.ts
   * attaches its own independent listeners — and that one DOES fire on the
   * wheel, because a zoom should still drop an in-flight alignment lock even
   * though it leaves the ambient rotation alone.
   */
  onUserInput?: (source: ManipulationSource) => void;
}

/** Read-only view of the rig's spherical state. */
export interface OrbitState {
  readonly theta: number;
  readonly phi: number;
  readonly distance: number;
}

export class OrbitRig {
  readonly camera: THREE.PerspectiveCamera;

  readonly #dom: HTMLElement;
  readonly #radius: number;
  readonly #minDistance: number;
  readonly #maxDistance: number;
  readonly #rotateSpeed: number;
  readonly #wheelZoomSpeed: number;
  readonly #onChange: (() => void) | undefined;
  readonly #onUserInput: ((source: ManipulationSource) => void) | undefined;

  /** Spherical state. `phi` measured from +Y, per THREE.Spherical. */
  readonly #spherical = new THREE.Spherical();

  #enabled = true;

  // Pointer-drag state.
  #dragging = false;
  #activePointerId: number | null = null;
  #lastPointerX = 0;
  #lastPointerY = 0;

  /**
   * Every pointer currently down on the canvas, by id. One → orbit drag; two →
   * pinch zoom. Touch needs the full set because a second finger must suspend
   * the drag rather than be ignored, and lifting back to one must resume it
   * from the surviving finger's position instead of jumping.
   */
  readonly #pointers = new Map<number, { x: number; y: number }>();

  /** Distance between the two pinch pointers on the previous move, in px. */
  #pinchLastDistance = 0;

  #disposed = false;

  constructor(camera: THREE.PerspectiveCamera, options: OrbitRigOptions) {
    this.camera = camera;
    this.#dom = options.domElement;
    this.#radius = options.radius ?? GLOBE_RADIUS;
    this.#minDistance = options.minDistance ?? MIN_ZOOM;
    this.#maxDistance = options.maxDistance ?? MAX_ZOOM;
    this.#rotateSpeed = options.rotateSpeed ?? 0.005;
    this.#wheelZoomSpeed = options.wheelZoomSpeed ?? 0.0015;
    this.#onChange = options.onChange;
    this.#onUserInput = options.onUserInput;

    // Pin the near plane so the mesh can never clip when fully zoomed.
    if (this.camera.near > CAMERA_NEAR) {
      this.camera.near = CAMERA_NEAR;
      this.camera.updateProjectionMatrix();
    }

    // Seed spherical state, clamped into the valid ranges.
    const theta = options.initial?.theta ?? 0;
    const phi = options.initial?.phi ?? Math.PI / 2;
    const distance = options.initial?.distance ?? this.#minDistance * 2.2;
    this.#spherical.set(this.#clampDistance(distance), this.#clampPhi(phi), theta);
    this.#spherical.makeSafe();

    this.#addListeners();
    this.apply();
  }

  // --- Public accessors ---------------------------------------------------

  get radius(): number {
    return this.#radius;
  }

  get minDistance(): number {
    return this.#minDistance;
  }

  get maxDistance(): number {
    return this.#maxDistance;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(value: boolean) {
    this.#enabled = value;
    if (!value) {
      this.#endDrag();
    }
  }

  /** Snapshot of the current spherical orbit state. */
  get state(): OrbitState {
    return {
      theta: this.#spherical.theta,
      phi: this.#spherical.phi,
      distance: this.#spherical.radius,
    };
  }

  // --- Camera application -------------------------------------------------

  /**
   * Write the current spherical state onto the camera. Always keeps world-up
   * vertical and looks at the origin, so the horizon never rolls.
   */
  apply(): void {
    this.camera.position.setFromSpherical(this.#spherical);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(ORBIT_TARGET);
    this.camera.updateMatrixWorld();
  }

  /**
   * Recompute spherical state from the camera's current world position. Call
   * this after an automated alignment (or any external write to the camera) so
   * subsequent manual control resumes from exactly where the camera sits. The
   * distance is re-clamped into the orbit range; phi is clamped off the poles.
   */
  syncFromCamera(): void {
    this.#spherical.setFromVector3(this.camera.position);
    this.#spherical.radius = this.#clampDistance(this.#spherical.radius);
    this.#spherical.phi = this.#clampPhi(this.#spherical.phi);
    this.#spherical.makeSafe();
  }

  /** Programmatically set the orbit distance (clamped) and re-apply. */
  /**
   * Advance the azimuth by `deltaTheta` radians. The one mutator that is NOT a
   * user gesture — the ambient rotation drives the globe through it.
   *
   * Deliberately does not call `syncFromCamera()` the way a manual manipulation
   * does: that exists so a gesture picks up wherever an alignment flight left
   * the camera, and re-syncing on every ambient frame would fight an in-flight
   * alignment instead of yielding to it. The caller pauses rotation while
   * anything else is driving.
   */
  orbitBy(deltaTheta: number): void {
    if (!this.#enabled || deltaTheta === 0) return;
    this.#spherical.theta += deltaTheta;
    this.apply();
    this.#emitChange();
  }

  setDistance(distance: number): void {
    this.#spherical.radius = this.#clampDistance(distance);
    this.apply();
    this.#emitChange();
  }

  /** Remove all listeners. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeListeners();
    this.#endDrag();
  }

  // --- Internal: clamping -------------------------------------------------

  #clampPhi(phi: number): number {
    return THREE.MathUtils.clamp(phi, POLAR_LIMIT, Math.PI - POLAR_LIMIT);
  }

  #clampDistance(distance: number): number {
    return THREE.MathUtils.clamp(distance, this.#minDistance, this.#maxDistance);
  }

  #emitChange(): void {
    this.#onChange?.();
  }

  /**
   * Called at the start of every fresh manipulation. Re-syncs from the camera so
   * an in-flight or just-cancelled alignment hands off seamlessly, and notifies
   * the user-input hook.
   */
  #beginInteraction(source: ManipulationSource): void {
    this.syncFromCamera();
    this.#onUserInput?.(source);
  }

  // --- Internal: listener wiring -----------------------------------------

  #addListeners(): void {
    this.#dom.addEventListener('pointerdown', this.#onPointerDown);
    this.#dom.addEventListener('wheel', this.#onWheel, { passive: false });
  }

  #removeListeners(): void {
    this.#dom.removeEventListener('pointerdown', this.#onPointerDown);
    this.#dom.removeEventListener('wheel', this.#onWheel);
    window.removeEventListener('pointermove', this.#onPointerMove);
    window.removeEventListener('pointerup', this.#onPointerUp);
  }

  // --- Internal: pointer drag --------------------------------------------

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (!this.#enabled) return;
    // Primary button only for mouse/pen. Touch reports button 0 for every
    // contact, so additional fingers pass this and reach the pinch branch.
    if (event.button !== 0) return;
    if (this.#pointers.has(event.pointerId)) return;

    this.#pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.#pointers.size === 1) {
      this.#dragging = true;
      this.#activePointerId = event.pointerId;
      this.#lastPointerX = event.clientX;
      this.#lastPointerY = event.clientY;
      this.#beginInteraction('drag');
      window.addEventListener('pointermove', this.#onPointerMove);
      window.addEventListener('pointerup', this.#onPointerUp);
      window.addEventListener('pointercancel', this.#onPointerUp);
    } else if (this.#pointers.size === 2) {
      // Second finger: stop orbiting and start pinching. Orbiting off one of
      // two moving contacts spins the globe while the user is only zooming.
      this.#dragging = false;
      this.#activePointerId = null;
      this.#pinchLastDistance = this.#pointerDistance();
      this.#beginInteraction('pinch');
    }
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    const tracked = this.#pointers.get(event.pointerId);
    if (!tracked) return;
    tracked.x = event.clientX;
    tracked.y = event.clientY;

    if (this.#pointers.size >= 2) {
      this.#pinchMove();
      return;
    }

    if (!this.#dragging || event.pointerId !== this.#activePointerId) return;

    const dx = event.clientX - this.#lastPointerX;
    const dy = event.clientY - this.#lastPointerY;
    this.#lastPointerX = event.clientX;
    this.#lastPointerY = event.clientY;

    if (dx === 0 && dy === 0) return;

    // Drag-right → orbit east; drag-down → tilt toward the north pole.
    this.#spherical.theta -= dx * this.#rotateSpeed;
    this.#spherical.phi = this.#clampPhi(this.#spherical.phi - dy * this.#rotateSpeed);

    this.apply();
    this.#emitChange();
  };

  /** Separation between the first two live pointers, in CSS pixels. */
  #pointerDistance(): number {
    const [a, b] = [...this.#pointers.values()];
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * Pinch zoom. The radius scales by the INVERSE of the fingers' separation
   * ratio, so spreading (separation grows) shortens the orbit distance and the
   * globe comes toward you — matching the direct-manipulation expectation.
   */
  #pinchMove(): void {
    const distance = this.#pointerDistance();
    // A degenerate separation would divide by ~0 and fling the camera.
    if (distance <= 0 || this.#pinchLastDistance <= 0) {
      this.#pinchLastDistance = distance;
      return;
    }

    const ratio = this.#pinchLastDistance / distance;
    this.#pinchLastDistance = distance;
    if (ratio === 1) return;

    this.#spherical.radius = this.#clampDistance(this.#spherical.radius * ratio);
    this.apply();
    this.#emitChange();
  }

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (!this.#pointers.delete(event.pointerId)) return;

    if (this.#pointers.size === 1) {
      // Dropped from pinch back to one finger. Resume orbiting from the
      // survivor's CURRENT position; seeding from the lifted finger's last
      // coordinates would jump the globe by the gap between them.
      const [id] = [...this.#pointers.keys()];
      const survivor = id === undefined ? undefined : this.#pointers.get(id);
      if (id !== undefined && survivor) {
        this.#dragging = true;
        this.#activePointerId = id;
        this.#lastPointerX = survivor.x;
        this.#lastPointerY = survivor.y;
        this.#beginInteraction('drag');
      }
      return;
    }

    if (this.#pointers.size === 0) this.#endDrag();
  };

  #endDrag(): void {
    this.#pointers.clear();
    this.#pinchLastDistance = 0;
    this.#dragging = false;
    this.#activePointerId = null;
    window.removeEventListener('pointermove', this.#onPointerMove);
    window.removeEventListener('pointerup', this.#onPointerUp);
    window.removeEventListener('pointercancel', this.#onPointerUp);
  }

  // --- Internal: wheel zoom ----------------------------------------------

  readonly #onWheel = (event: WheelEvent): void => {
    if (!this.#enabled) return;
    event.preventDefault();
    this.#beginInteraction('wheel');

    // Positive deltaY (scroll down) zooms out; multiplicative for smooth feel.
    const factor = Math.exp(event.deltaY * this.#wheelZoomSpeed);
    this.#spherical.radius = this.#clampDistance(this.#spherical.radius * factor);

    this.apply();
    this.#emitChange();
  };
}
