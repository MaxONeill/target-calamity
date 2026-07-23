/**
 * OrbitRig — spherical orbit state (theta, phi, radius) applied to a three.js
 * PerspectiveCamera that always looks at the globe center (0,0,0).
 *
 * The rig is the single owner of manual camera control:
 *   - pointer drag  → orbit (mutate theta/phi)
 *   - mouse wheel   → zoom  (mutate radius)
 *   - WASDQE keys   → orbit (A/D azimuth, W/S polar) + zoom (Q out / E in)
 *
 * Design notes:
 *   - The orbit pivot is the origin and is NEVER reassigned: the globe
 *     center stays the look-at target, so drag behavior is identical before and
 *     after an automated alignment.
 *   - `phi` (polar angle from +Y) is clamped away from the poles by POLAR_LIMIT
 *     so the look-at basis (up × forward) never collapses.
 *   - Render-on-demand: the rig does not run an unconditional rAF loop.
 *     It fires `onChange` only when state actually changes, and it spins an
 *     internal rAF ONLY while a movement key is held (continuous keyboard orbit).
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

/** Physical key codes for WASDQE camera control. */
const KEY_AZIMUTH_NEG = 'KeyA';
const KEY_AZIMUTH_POS = 'KeyD';
const KEY_POLAR_UP = 'KeyW';
const KEY_POLAR_DOWN = 'KeyS';
const KEY_ZOOM_OUT = 'KeyQ';
const KEY_ZOOM_IN = 'KeyE';

const MOVEMENT_KEYS: ReadonlySet<string> = new Set([
  KEY_AZIMUTH_NEG,
  KEY_AZIMUTH_POS,
  KEY_POLAR_UP,
  KEY_POLAR_DOWN,
  KEY_ZOOM_OUT,
  KEY_ZOOM_IN,
]);

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
  /** Keyboard orbit rate, radians per second. */
  keyOrbitSpeed?: number;
  /** Keyboard zoom rate, fraction of distance per second. */
  keyZoomSpeed?: number;
  /** Wheel zoom sensitivity, fraction per wheel-delta unit. */
  wheelZoomSpeed?: number;
  /** Called after any state change so the host can render on demand. */
  onChange?: () => void;
  /**
   * Called at the very start of a manual manipulation (pointer down / wheel /
   * first movement keypress). Useful as a hook, though the interrupt handler in
   * src/camera/interrupt.ts attaches its own independent listeners.
   */
  onUserInput?: () => void;
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
  readonly #keyOrbitSpeed: number;
  readonly #keyZoomSpeed: number;
  readonly #wheelZoomSpeed: number;
  readonly #onChange: (() => void) | undefined;
  readonly #onUserInput: (() => void) | undefined;

  /** Spherical state. `phi` measured from +Y, per THREE.Spherical. */
  readonly #spherical = new THREE.Spherical();

  #enabled = true;

  // Pointer-drag state.
  #dragging = false;
  #activePointerId: number | null = null;
  #lastPointerX = 0;
  #lastPointerY = 0;

  // Held movement keys and the internal keyboard-orbit rAF.
  readonly #heldKeys = new Set<string>();
  #keyRafId: number | null = null;
  #keyLastTime = 0;

  #disposed = false;

  constructor(camera: THREE.PerspectiveCamera, options: OrbitRigOptions) {
    this.camera = camera;
    this.#dom = options.domElement;
    this.#radius = options.radius ?? GLOBE_RADIUS;
    this.#minDistance = options.minDistance ?? MIN_ZOOM;
    this.#maxDistance = options.maxDistance ?? MAX_ZOOM;
    this.#rotateSpeed = options.rotateSpeed ?? 0.005;
    this.#keyOrbitSpeed = options.keyOrbitSpeed ?? 1.2;
    this.#keyZoomSpeed = options.keyZoomSpeed ?? 1.4;
    this.#wheelZoomSpeed = options.wheelZoomSpeed ?? 0.0015;
    this.#onChange = options.onChange;
    this.#onUserInput = options.onUserInput;

    // : pin the near plane so the mesh can never clip when fully zoomed.
    if (this.camera.near > CAMERA_NEAR) {
      this.camera.near = CAMERA_NEAR;
      this.camera.updateProjectionMatrix();
    }

    // Seed spherical state, clamped into the valid ranges.
    const theta = options.initial?.theta ?? 0;
    const phi = options.initial?.phi ?? Math.PI / 2;
    const distance = options.initial?.distance ?? this.#minDistance * 2.2;
    this.#spherical.set(
      this.#clampDistance(distance),
      this.#clampPhi(phi),
      theta,
    );
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
      this.#heldKeys.clear();
      this.#stopKeyLoop();
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
  setDistance(distance: number): void {
    this.#spherical.radius = this.#clampDistance(distance);
    this.apply();
    this.#emitChange();
  }

  /** Remove all listeners and stop the internal keyboard loop. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#removeListeners();
    this.#endDrag();
    this.#heldKeys.clear();
    this.#stopKeyLoop();
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
  #beginInteraction(): void {
    this.syncFromCamera();
    this.#onUserInput?.();
  }

  // --- Internal: listener wiring -----------------------------------------

  #addListeners(): void {
    this.#dom.addEventListener('pointerdown', this.#onPointerDown);
    this.#dom.addEventListener('wheel', this.#onWheel, { passive: false });
    // Key events are global: the canvas is not guaranteed to be focusable.
    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onWindowBlur);
  }

  #removeListeners(): void {
    this.#dom.removeEventListener('pointerdown', this.#onPointerDown);
    this.#dom.removeEventListener('wheel', this.#onWheel);
    window.removeEventListener('pointermove', this.#onPointerMove);
    window.removeEventListener('pointerup', this.#onPointerUp);
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onWindowBlur);
  }

  // --- Internal: pointer drag --------------------------------------------

  readonly #onPointerDown = (event: PointerEvent): void => {
    if (!this.#enabled || this.#dragging) return;
    if (event.button !== 0) return; // primary button only

    this.#dragging = true;
    this.#activePointerId = event.pointerId;
    this.#lastPointerX = event.clientX;
    this.#lastPointerY = event.clientY;

    this.#beginInteraction();

    window.addEventListener('pointermove', this.#onPointerMove);
    window.addEventListener('pointerup', this.#onPointerUp);
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
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

  readonly #onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.#activePointerId) return;
    this.#endDrag();
  };

  #endDrag(): void {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#activePointerId = null;
    window.removeEventListener('pointermove', this.#onPointerMove);
    window.removeEventListener('pointerup', this.#onPointerUp);
  }

  // --- Internal: wheel zoom ----------------------------------------------

  readonly #onWheel = (event: WheelEvent): void => {
    if (!this.#enabled) return;
    event.preventDefault();
    this.#beginInteraction();

    // Positive deltaY (scroll down) zooms out; multiplicative for smooth feel.
    const factor = Math.exp(event.deltaY * this.#wheelZoomSpeed);
    this.#spherical.radius = this.#clampDistance(this.#spherical.radius * factor);

    this.apply();
    this.#emitChange();
  };

  // --- Internal: keyboard orbit (continuous while held) ------------------

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (!this.#enabled) return;
    if (!MOVEMENT_KEYS.has(event.code)) return;
    if (event.repeat) return; // rAF drives continuous motion, not key-repeat

    const wasIdle = this.#heldKeys.size === 0;
    this.#heldKeys.add(event.code);
    if (wasIdle) {
      this.#beginInteraction();
      this.#startKeyLoop();
    }
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    if (!MOVEMENT_KEYS.has(event.code)) return;
    this.#heldKeys.delete(event.code);
    if (this.#heldKeys.size === 0) this.#stopKeyLoop();
  };

  readonly #onWindowBlur = (): void => {
    // Losing focus drops all held keys so motion doesn't "stick".
    if (this.#heldKeys.size === 0) return;
    this.#heldKeys.clear();
    this.#stopKeyLoop();
  };

  #startKeyLoop(): void {
    if (this.#keyRafId !== null) return;
    this.#keyLastTime = performance.now();
    this.#keyRafId = requestAnimationFrame(this.#keyTick);
  }

  #stopKeyLoop(): void {
    if (this.#keyRafId === null) return;
    cancelAnimationFrame(this.#keyRafId);
    this.#keyRafId = null;
  }

  readonly #keyTick = (now: number): void => {
    if (this.#heldKeys.size === 0) {
      this.#keyRafId = null;
      return;
    }

    const dt = Math.min((now - this.#keyLastTime) / 1000, 0.1); // clamp long gaps
    this.#keyLastTime = now;

    let changed = false;

    if (this.#heldKeys.has(KEY_AZIMUTH_NEG)) {
      this.#spherical.theta -= this.#keyOrbitSpeed * dt;
      changed = true;
    }
    if (this.#heldKeys.has(KEY_AZIMUTH_POS)) {
      this.#spherical.theta += this.#keyOrbitSpeed * dt;
      changed = true;
    }
    if (this.#heldKeys.has(KEY_POLAR_UP)) {
      this.#spherical.phi = this.#clampPhi(this.#spherical.phi - this.#keyOrbitSpeed * dt);
      changed = true;
    }
    if (this.#heldKeys.has(KEY_POLAR_DOWN)) {
      this.#spherical.phi = this.#clampPhi(this.#spherical.phi + this.#keyOrbitSpeed * dt);
      changed = true;
    }
    if (this.#heldKeys.has(KEY_ZOOM_OUT)) {
      this.#spherical.radius = this.#clampDistance(
        this.#spherical.radius * (1 + this.#keyZoomSpeed * dt),
      );
      changed = true;
    }
    if (this.#heldKeys.has(KEY_ZOOM_IN)) {
      this.#spherical.radius = this.#clampDistance(
        this.#spherical.radius * (1 - this.#keyZoomSpeed * dt),
      );
      changed = true;
    }

    if (changed) {
      this.apply();
      this.#emitChange();
    }

    this.#keyRafId = requestAnimationFrame(this.#keyTick);
  };
}
