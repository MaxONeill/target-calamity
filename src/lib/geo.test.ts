/**
 * Tests for the ONE sanctioned lat/lon ⇄ Cartesian conversion.
 *
 * The bug this file exists to catch: the spec wrote `cos(lat)` with no unit
 * conversion, and lat/lon are stored in DEGREES while trig takes RADIANS.
 * Crucially, an unconverted implementation STILL satisfies |v| = R, so a
 * radius-preservation check passes under the bug and is NOT coverage. The
 * load-bearing regression guard here is the London↔Tokyo great-circle angle,
 * which a degrees-in-radians implementation gets grossly wrong (≈148° vs the
 * true ≈86°). See .
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  D2R,
  R2D,
  degToRad,
  radToDeg,
  latLonToVector3,
  vector3ToLatLon,
} from './geo.js';

/** Independent great-circle central angle (spherical law of cosines), degrees. */
function greatCircleDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const c =
    Math.sin(p1) * Math.sin(p2) +
    Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}

describe('angle constants and scalar helpers', () => {
  it('D2R and R2D are exact reciprocals of the degree/radian factor', () => {
    expect(D2R).toBeCloseTo(Math.PI / 180, 15);
    expect(R2D).toBeCloseTo(180 / Math.PI, 12);
    expect(D2R * R2D).toBeCloseTo(1, 15);
  });

  it('degToRad / radToDeg round-trip and hit known anchors', () => {
    expect(degToRad(180)).toBeCloseTo(Math.PI, 15);
    expect(degToRad(90)).toBeCloseTo(Math.PI / 2, 15);
    expect(radToDeg(Math.PI)).toBeCloseTo(180, 12);
    for (const deg of [-135, -1, 0, 37.5, 90, 179.999]) {
      expect(radToDeg(degToRad(deg))).toBeCloseTo(deg, 12);
    }
  });
});

describe('latLonToVector3 — known reference vectors (ADR-25 sign convention)', () => {
  const cases: Array<[number, number, [number, number, number]]> = [
    // (lat 0, lon 0) → +X
    [0, 0, [1, 0, 0]],
    // north pole → +Y
    [90, 0, [0, 1, 0]],
    // south pole → −Y
    [-90, 0, [0, -1, 0]],
    // east (lon +90) → −Z  (the deliberate −Z-is-East convention)
    [0, 90, [0, 0, -1]],
    // west (lon −90) → +Z
    [0, -90, [0, 0, 1]],
    // (lon 180) → −X
    [0, 180, [-1, 0, 0]],
  ];

  for (const [lat, lon, expected] of cases) {
    it(`(${lat}, ${lon}) maps to (${expected.join(', ')})`, () => {
      const v = latLonToVector3(lat, lon, 1);
      expect(v.x).toBeCloseTo(expected[0], 12);
      expect(v.y).toBeCloseTo(expected[1], 12);
      expect(v.z).toBeCloseTo(expected[2], 12);
    });
  }

  it('north pole latitude is +Y regardless of the (meaningless) longitude', () => {
    for (const lon of [-180, -37, 0, 88, 180]) {
      const v = latLonToVector3(90, lon, 1);
      expect(v.y).toBeCloseTo(1, 12);
      expect(Math.hypot(v.x, v.z)).toBeLessThan(1e-9);
    }
  });
});

describe('latLonToVector3 — radius handling', () => {
  it('preserves radius R for arbitrary coordinates (necessary, NOT sufficient)', () => {
    for (const R of [1, 2.5, 100]) {
      for (const [lat, lon] of [
        [0, 0],
        [51.5, -0.13],
        [-33.87, 151.21],
        [12, -170],
        [-64.2, 44.9],
      ] as Array<[number, number]>) {
        const v = latLonToVector3(lat, lon, R);
        expect(v.length()).toBeCloseTo(R, 9);
      }
    }
  });

  it('scales linearly with R (direction is R-independent)', () => {
    const a = latLonToVector3(20, 47, 1);
    const b = latLonToVector3(20, 47, 3);
    expect(b.x).toBeCloseTo(a.x * 3, 12);
    expect(b.y).toBeCloseTo(a.y * 3, 12);
    expect(b.z).toBeCloseTo(a.z * 3, 12);
  });

  it('defaults to the unit sphere (R = 1)', () => {
    const v = latLonToVector3(42, 42);
    expect(v.length()).toBeCloseTo(1, 12);
  });

  it('writes into the provided out vector and returns the same instance', () => {
    const out = new THREE.Vector3();
    const ret = latLonToVector3(10, 20, 2, out);
    expect(ret).toBe(out);
    expect(out.length()).toBeCloseTo(2, 9);
  });
});

describe('latLonToVector3 — degrees are actually converted (the ADR-25 bug guard)', () => {
  // This is the test a `|v| = R` assertion cannot substitute for: it fails
  // loudly if the implementation forgets the π/180 conversion.
  it('London↔Tokyo separation is the true great-circle angle (~86°), not ~148°', () => {
    const london = latLonToVector3(51.5, -0.13, 1);
    const tokyo = latLonToVector3(35.68, 139.69, 1);
    const angleDeg = Math.acos(
      Math.max(-1, Math.min(1, london.dot(tokyo))),
    ) * R2D;

    const expected = greatCircleDeg(51.5, -0.13, 35.68, 139.69);
    expect(expected).toBeGreaterThan(85);
    expect(expected).toBeLessThan(87);

    // Correct implementation matches the independent great-circle formula
    // exactly; the unconverted (degrees-as-radians) bug yields ≈148° and fails.
    expect(angleDeg).toBeCloseTo(expected, 6);
    // Extra explicit floor so the intent is legible: nowhere near the buggy value.
    expect(Math.abs(angleDeg - 148)).toBeGreaterThan(50);
  });

  it('a 1° latitude step moves a pin ~1° of arc (not ~57°, the aliasing signature)', () => {
    const a = latLonToVector3(10, 30, 1);
    const b = latLonToVector3(11, 30, 1);
    const arcDeg = Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * R2D;
    expect(arcDeg).toBeCloseTo(1, 4);
  });
});

describe('vector3ToLatLon — inverse of latLonToVector3', () => {
  it('decodes the reference vectors back to their lat/lon', () => {
    expect(vector3ToLatLon(new THREE.Vector3(1, 0, 0))).toEqual([
      expect.closeTo(0, 9),
      expect.closeTo(0, 9),
    ]);
    const [nlat] = vector3ToLatLon(new THREE.Vector3(0, 1, 0));
    expect(nlat).toBeCloseTo(90, 9);
    const east = vector3ToLatLon(new THREE.Vector3(0, 0, -1));
    expect(east[0]).toBeCloseTo(0, 9);
    expect(east[1]).toBeCloseTo(90, 9);
  });

  it('round-trips over a lat/lon grid within 1e-9 (poles excluded — lon undefined there)', () => {
    for (let lat = -85; lat <= 85; lat += 17) {
      for (let lon = -175; lon <= 175; lon += 35) {
        const [rlat, rlon] = vector3ToLatLon(latLonToVector3(lat, lon, 1));
        expect(rlat).toBeCloseTo(lat, 9);
        expect(rlon).toBeCloseTo(lon, 9);
      }
    }
  });

  it('is radius-independent (normalizes internally)', () => {
    const [lat, lon] = vector3ToLatLon(latLonToVector3(23, 88, 42));
    expect(lat).toBeCloseTo(23, 9);
    expect(lon).toBeCloseTo(88, 9);
  });

  it('latitude stays in [-90, 90] even for a slightly over-unit y (clamp guard)', () => {
    const [lat] = vector3ToLatLon(new THREE.Vector3(0, 1.0000001, 0));
    expect(lat).toBeLessThanOrEqual(90);
    expect(lat).toBeCloseTo(90, 6);
  });
});
