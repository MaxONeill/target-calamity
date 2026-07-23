/**
 * Regression tests for orbital alignment roll (ADR-27).
 *
 * The load-bearing guarantee: aligning the camera by interpolating POSITION on
 * the orbit sphere (and re-levelling with `lookAt` + world-up every frame) keeps
 * the horizon flat for the WHOLE flight — not just at t=0 and t=1, where roll is
 * always 0 regardless of method. A quaternion slerp between the two look-at
 * orientations would inject roll that peaks mid-flight and vanishes at the ends,
 * so a start/end screenshot can never catch it. These tests sample MID-FLIGHT.
 *
 * `driveToMidFlight` runs the REAL `OrbitAlignment` tick (via a minimal fake rig
 * and stubbed rAF/`performance.now`), so if someone reintroduces quaternion-slerp
 * orientation into `#tick`, the camera's actual right-vector tilts and the
 * zero-roll assertion fails. The final test also shows a quaternion slerp of the
 * same endpoints DOES roll, proving the assertion discriminates rather than
 * passing vacuously.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latLonToVector3 } from '../lib/geo';
import { GLOBE_RADIUS, MIN_ZOOM, MAX_ZOOM } from './OrbitRig';
import type { OrbitRig } from './OrbitRig';
import { OrbitAlignment, slerpDirection, easeInOutCubic } from './alignment';

// London → Sydney: a genuinely diagonal great circle (both lat and lon differ
// strongly), the worst case for mid-flight roll.
const LONDON = latLonToVector3(51.5, -0.13, GLOBE_RADIUS);
const SYDNEY = latLonToVector3(-33.87, 151.21, GLOBE_RADIUS);

/** Camera "right" (local +X) in world space — its `.y` is the roll signature. */
function cameraRight(camera: THREE.Camera): THREE.Vector3 {
  return new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
}

/**
 * A stand-in for OrbitRig that needs no DOM (the real rig attaches window
 * listeners in its constructor, which do not exist under the node test env).
 */
function fakeRig(): OrbitRig {
  return {
    radius: GLOBE_RADIUS,
    minDistance: MIN_ZOOM,
    maxDistance: MAX_ZOOM,
    syncFromCamera(): void {},
  } as unknown as OrbitRig;
}

/**
 * Start a real alignment flight from `startPos` toward `pinPos` and advance the
 * REAL tick to the given fraction of the flight, returning the camera at that
 * instant. Stubs rAF + performance.now so the flight is deterministic.
 */
function driveToMidFlight(
  startPos: THREE.Vector3,
  pinPos: THREE.Vector3,
  fraction: number,
): { camera: THREE.PerspectiveCamera; align: OrbitAlignment } {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.up.set(0, 1, 0);
  camera.position.copy(startPos);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const align = new OrbitAlignment(camera, fakeRig());

  let capturedFrame: FrameRequestCallback | null = null;
  const base = 10_000;
  vi.spyOn(performance, 'now').mockReturnValue(base);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    capturedFrame = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (): void => {});

  const duration = 750;
  void align.alignTo(pinPos, { durationMs: duration });

  // Fire the first scheduled frame at t = fraction of the flight.
  expect(capturedFrame).not.toBeNull();
  (capturedFrame as unknown as FrameRequestCallback)(base + duration * fraction);

  return { camera, align };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('slerpDirection (position-space interpolation, ADR-27)', () => {
  it('returns a unit vector at the geodesic midpoint, equidistant from both ends', () => {
    const a = LONDON.clone().normalize();
    const b = SYDNEY.clone().normalize();
    const mid = slerpDirection(a, b, 0.5, new THREE.Vector3());
    expect(mid.length()).toBeCloseTo(1, 12);
    // Equidistant in angle from each endpoint (great-circle midpoint).
    expect(mid.angleTo(a)).toBeCloseTo(mid.angleTo(b), 10);
  });
});

describe('mid-flight camera roll (ADR-27 regression)', () => {
  it('holds the horizon flat at t=0.5 of a London→Sydney alignment (real tick)', () => {
    const { camera, align } = driveToMidFlight(LONDON, SYDNEY, 0.5);
    const right = cameraRight(camera);
    // Zero roll ⇒ camera right-vector is horizontal (perpendicular to world-up).
    expect(Math.abs(right.y)).toBeLessThan(1e-9);
    align.cancel();
  });

  it('holds the horizon flat across several mid-flight samples, not just t=0.5', () => {
    for (const f of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const { camera, align } = driveToMidFlight(LONDON, SYDNEY, f);
      expect(Math.abs(cameraRight(camera).y)).toBeLessThan(1e-9);
      align.cancel();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('confirms the flight actually moved the camera to a mid-path pose', () => {
    const { camera, align } = driveToMidFlight(LONDON, SYDNEY, 0.5);
    const dir = camera.position.clone().normalize();
    const a = LONDON.clone().normalize();
    const b = SYDNEY.clone().normalize();
    // Strictly between the endpoints: closer to each than they are to each other.
    expect(dir.angleTo(a)).toBeGreaterThan(0.1);
    expect(dir.angleTo(b)).toBeGreaterThan(0.1);
    align.cancel();
  });

  it('DISCRIMINATES: a quaternion slerp of the same endpoints DOES roll mid-flight', () => {
    // This is precisely the artifact ADR-27 rejects. If the zero-roll assertions
    // above ever pass because lookAt is trivially level, this proves they are not
    // vacuous: the naive orientation-slerp produces a clearly tilted horizon.
    const camA = new THREE.PerspectiveCamera();
    camA.up.set(0, 1, 0);
    camA.position.copy(LONDON);
    camA.lookAt(0, 0, 0);
    camA.updateMatrixWorld();
    const q0 = camA.quaternion.clone();

    const camB = new THREE.PerspectiveCamera();
    camB.up.set(0, 1, 0);
    camB.position.copy(SYDNEY);
    camB.lookAt(0, 0, 0);
    camB.updateMatrixWorld();
    const q1 = camB.quaternion.clone();

    const qMid = q0.clone().slerp(q1, easeInOutCubic(0.5));
    const rightQ = new THREE.Vector3(1, 0, 0).applyQuaternion(qMid);
    expect(Math.abs(rightQ.y)).toBeGreaterThan(0.05); // visibly rolled
  });
});
