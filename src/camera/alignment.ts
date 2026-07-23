/**
 * alignment.ts — automated orbital alignment.
 *
 *  Step Three /  instruct "Execute a
 * Spherical Linear Interpolation (Slerp) on the camera's quaternion orientation."
 * We do NOT slerp orientation. Slerping between two look-at quaternions takes the
 * shortest arc in SO(3), which mixes TWIST about the view axis into the path: the
 * horizon tilts (rolls) mid-flight and rights itself at the endpoints, so the
 * artifact is invisible in any start/end screenshot. The spec's Step Three also
 * never applies Step Two's position, so as written the pin never actually comes
 * to face the camera.
 *
 * Instead we animate POSITION on the fixed-radius orbit sphere and let
 * orientation fall out for free:
 *   - Framing direction  n     = normalize(pinPos)   (the pin's outward normal)
 *   - Target distance     D     = clamp(camera distance now, MIN_ZOOM, MAX_ZOOM)
 *                                 sampled at selection time (preserves the user's
 *                                 current zoom across a selection).
 *   - Over a 750ms cubic ease-in-out, geodesically slerp the DIRECTION
 *     (dir0 → n) on the unit sphere and separately ease the RADIUS (D0 → D).
 *   - Each frame: camera.position = dir(t)·radius(t); camera.up = (0,1,0);
 *     camera.lookAt(0,0,0). world-up stays vertical every frame → zero roll by
 *     construction. Easing only reshapes timing; it does not remove roll from a
 *     quaternion slerp, which is why we interpolate position, not orientation.
 *
 * The orbit pivot stays (0,0,0) and is never reassigned. lat/lon → vector goes
 * exclusively through src/lib/geo.ts; no trig on geography here.
 *
 * Pole handling: three.js already guards NaN in lookAt/Spherical, so no
 * extra clamp is needed for the math to stay finite. The one thing the library
 * cannot decide is the destination AZIMUTH when the pin sits on the pole axis
 * (n ≈ ±Y) — it is degenerate there. We hold the camera's PRE-ANIMATION azimuth
 * in that case rather than deriving an arbitrary one from the destination, so the
 * flight path across the pole is not visually random.
 */
import * as THREE from 'three';
import { latLonToVector3 } from '../lib/geo';
import { OrbitRig, POLAR_LIMIT } from './OrbitRig';

/** Alignment flight duration, milliseconds. */
export const ALIGN_DURATION_MS = 750;

/**
 * Below this dot-product angle (radians) two directions are treated as parallel
 * and slerp degrades to normalized lerp for numerical stability.
 */
const SLERP_PARALLEL_EPS = 1e-6;

/**
 * Above (π − this) radians two directions are treated as antipodal: the
 * great-circle between them is undefined (infinitely many), so we rotate about a
 * stable perpendicular axis instead.
 */
const ANTIPODAL_EPS = 1e-5;

/** Outcome of an alignment run. */
export type AlignmentOutcome = 'completed' | 'interrupted';

export interface AlignmentOptions {
  /**
   * Called each animated frame (and once on settle) so the host can render on
   * demand. Defaults to the rig's own change notification if omitted.
   */
  onFrame?: () => void;
  /** Flight duration override, milliseconds. Defaults to {@link ALIGN_DURATION_MS}. */
  durationMs?: number;
}

/** Cubic ease-in-out over t ∈ [0,1]. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Geodesic (great-circle) interpolation of two UNIT direction vectors — the
 * position-space slerp that replaces the spec's orientation slerp.
 * `a` and `b` must be normalized; `out` receives a normalized result.
 */
export function slerpDirection(
  a: THREE.Vector3,
  b: THREE.Vector3,
  t: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  const omega = Math.acos(dot);

  if (omega < SLERP_PARALLEL_EPS) {
    // Nearly identical directions: lerp + normalize is stable and roll-free.
    return out.copy(a).lerp(b, t).normalize();
  }

  if (omega > Math.PI - ANTIPODAL_EPS) {
    // Antipodal: the great circle is undefined. Rotate `a` by t·π about a stable
    // axis perpendicular to it, so the path is deterministic. Orientation is
    // re-levelled by lookAt each frame regardless of which plane we pick.
    const axis = _antipodalAxis(a);
    return out.copy(a).applyAxisAngle(axis, t * Math.PI).normalize();
  }

  const sinOmega = Math.sin(omega);
  const w1 = Math.sin((1 - t) * omega) / sinOmega;
  const w2 = Math.sin(t * omega) / sinOmega;
  return out
    .copy(a)
    .multiplyScalar(w1)
    .addScaledVector(b, w2)
    .normalize();
}

const _axisScratch = new THREE.Vector3();
function _antipodalAxis(a: THREE.Vector3): THREE.Vector3 {
  // Prefer world-Y as the rotation axis basis; if `a` is (near) parallel to Y,
  // fall back to world-X so the cross product is non-degenerate.
  _axisScratch.set(0, 1, 0);
  if (Math.abs(a.dot(_axisScratch)) > 0.999) _axisScratch.set(1, 0, 0);
  return _axisScratch.cross(a).normalize();
}

/**
 * OrbitAlignment — runs a single automated flight at a time against one camera +
 * rig. It owns the requestAnimationFrame loop and a GENERATION TOKEN counter
 * (not a boolean) so that a stale rAF callback from a superseded or cancelled run
 * cannot keep writing to the camera. Every start and every cancel bumps the
 * generation; each scheduled frame captures its own generation and no-ops if it
 * no longer matches (see src/camera/interrupt.ts, which drives cancel()).
 */
export class OrbitAlignment {
  readonly #camera: THREE.PerspectiveCamera;
  readonly #rig: OrbitRig;

  /** Monotonic token. The in-flight run is the one whose captured gen === this. */
  #generation = 0;
  #rafId: number | null = null;

  /** Resolver + settled flag for the currently running flight, if any. */
  #settle: ((outcome: AlignmentOutcome) => void) | null = null;

  // Per-run interpolation state.
  readonly #dir0 = new THREE.Vector3();
  readonly #dir1 = new THREE.Vector3();
  readonly #dirT = new THREE.Vector3();
  #radius0 = 0;
  #radius1 = 0;
  #startTime = 0;
  #duration = ALIGN_DURATION_MS;
  #onFrame: (() => void) | null = null;

  constructor(camera: THREE.PerspectiveCamera, rig: OrbitRig) {
    this.#camera = camera;
    this.#rig = rig;
  }

  /** True while a flight is in progress. */
  get isAnimating(): boolean {
    return this.#rafId !== null;
  }

  /**
   * Current generation token. Exposed so the interrupt handler can reason about
   * race-safety; callers should use {@link cancel} rather than mutating it.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Align the camera to a factor's geographic coordinates. lat/lon → surface
   * vector routes through src/lib/geo.ts at the rig's globe radius.
   */
  alignToLatLon(latDeg: number, lonDeg: number, options: AlignmentOptions = {}): Promise<AlignmentOutcome> {
    const pinPos = latLonToVector3(latDeg, lonDeg, this.#rig.radius);
    return this.alignTo(pinPos, options);
  }

  /**
   * Align the camera so the given surface point faces the camera plane. `pinPos`
   * is a point on (or scaled to) the globe surface; only its direction matters.
   */
  alignTo(pinPos: THREE.Vector3, options: AlignmentOptions = {}): Promise<AlignmentOutcome> {
    // Bumping the generation supersedes any in-flight run: its next frame no-ops
    // and its promise resolves 'interrupted'.
    this.#supersede();

    const myGen = ++this.#generation;
    this.#duration = options.durationMs ?? ALIGN_DURATION_MS;
    this.#onFrame = options.onFrame ?? null;

    // --- Step Two: framing direction + target distance (sampled now) --------
    this.#dir1.copy(pinPos).normalize();
    this.#dir0.copy(this.#camera.position).normalize();
    this.#radius0 = this.#camera.position.length();
    // D = clamp(current distance, MIN_ZOOM, MAX_ZOOM) — preserves user zoom,
    // shares the rig's range so manual and automated framing agree.
    this.#radius1 = THREE.MathUtils.clamp(
      this.#radius0,
      this.#rig.minDistance,
      this.#rig.maxDistance,
    );

    // Degenerate destination azimuth: when the pin is on the pole axis
    // (n within POLAR_LIMIT of ±Y), the great circle's endpoint azimuth is
    // undefined. Rebuild dir1 holding the PRE-ANIMATION azimuth and nudging the
    // polar angle just off the pole, so the path is deterministic, not arbitrary.
    this.#resolveDegenerateDestination();

    this.#startTime = performance.now();

    return new Promise<AlignmentOutcome>((resolve) => {
      this.#settle = resolve;
      this.#rafId = requestAnimationFrame((now) => this.#tick(now, myGen));
    });
  }

  /**
   * Drop lock immediately ( Step Four). Race-safe: bumps the generation so
   * any already-scheduled frame from the running flight no-ops, cancels the rAF,
   * syncs the rig to the camera's current pose so manual control resumes cleanly,
   * and resolves the in-flight promise 'interrupted'. Safe to call when idle.
   */
  cancel(): void {
    if (this.#rafId === null && this.#settle === null) return;
    this.#generation++; // invalidate any in-flight frame token
    this.#stopRaf();
    this.#rig.syncFromCamera();
    this.#resolve('interrupted');
  }

  // --- Internal -----------------------------------------------------------

  /** Supersede a running flight (used when a new alignment starts). */
  #supersede(): void {
    if (this.#rafId === null && this.#settle === null) return;
    this.#stopRaf();
    this.#resolve('interrupted');
  }

  #stopRaf(): void {
    if (this.#rafId === null) return;
    cancelAnimationFrame(this.#rafId);
    this.#rafId = null;
  }

  #resolve(outcome: AlignmentOutcome): void {
    const settle = this.#settle;
    this.#settle = null;
    settle?.(outcome);
  }

  #resolveDegenerateDestination(): void {
    const destSph = new THREE.Spherical().setFromVector3(this.#dir1);
    const nearPole =
      destSph.phi < POLAR_LIMIT || destSph.phi > Math.PI - POLAR_LIMIT;
    if (!nearPole) return;

    // Hold the camera's current azimuth; clamp polar angle just off the pole.
    const startSph = new THREE.Spherical().setFromVector3(this.#camera.position);
    destSph.theta = startSph.theta;
    destSph.phi = THREE.MathUtils.clamp(
      destSph.phi,
      POLAR_LIMIT,
      Math.PI - POLAR_LIMIT,
    );
    destSph.radius = 1;
    this.#dir1.setFromSpherical(destSph).normalize();
  }

  #tick(now: number, myGen: number): void {
    // Race guard: a cancel()/supersede that ran between scheduling and firing
    // this frame will have advanced the generation. Do nothing if we are stale.
    if (myGen !== this.#generation) return;

    const elapsed = now - this.#startTime;
    const raw = this.#duration <= 0 ? 1 : elapsed / this.#duration;
    const t = THREE.MathUtils.clamp(raw, 0, 1);
    const e = easeInOutCubic(t);

    // Geodesic direction + eased radius, recomposed into a position each frame.
    slerpDirection(this.#dir0, this.#dir1, e, this.#dirT);
    const radius = THREE.MathUtils.lerp(this.#radius0, this.#radius1, e);

    this.#camera.position.copy(this.#dirT).multiplyScalar(radius);
    this.#camera.up.set(0, 1, 0);
    this.#camera.lookAt(0, 0, 0);
    this.#camera.updateMatrixWorld();

    this.#onFrame?.();

    if (t >= 1) {
      // Landed. Sync the rig to the final pose so manual control continues from
      // here, then resolve.
      this.#rafId = null;
      this.#rig.syncFromCamera();
      this.#resolve('completed');
      return;
    }

    this.#rafId = requestAnimationFrame((next) => this.#tick(next, myGen));
  }
}
