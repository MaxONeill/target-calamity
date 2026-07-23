/**
 * Shared geographic ⇄ geometric math for the globe AND the camera rig.
 *
 * SPEC DEVIATION (ADR-25): spec §5 Step One / v3.2 §1 write `cos(lat)`,
 * `sin(lon)` etc. with no stated units. lat/lon are stored in DEGREES (WGS84),
 * but JS `Math.cos/sin` and GLSL `cos/sin` take RADIANS. Passing degrees in
 * produces coordinates that still satisfy |v| = R — so the bug is invisible to
 * an on-sphere sanity check — while placing every pin in the wrong place
 * (London lands ~19.5° of arc from truth). This module is the ONE sanctioned
 * place trig touches geography: it converts degrees → radians inline, and every
 * call site (pin instance matrices per ADR-7, the camera framing target per
 * ADR-27, and the field baker's xᵢ set per ADR-1) must route through it. Raw
 * `Math.cos`/`Math.sin` on any lat/lon identifier is banned elsewhere.
 *
 * Coordinate convention (three.js: right-handed, Y-up):
 *   φ = lat · π/180   (latitude, radians)
 *   λ = lon · π/180   (longitude, radians)
 *   x =  R · cos φ · cos λ
 *   y =  R · sin φ
 *   z = −R · cos φ · sin λ
 * so (lat 0, lon 0) → +X, the north pole (lat 90) → +Y, and east (lon +90) → −Z.
 * The −Z-is-East sign is a deliberate spec convention, not a bug to "fix" here;
 * anything consuming these vectors (including the equirectangular field baker,
 * which must use the exact inverse) inherits it.
 */
import * as THREE from 'three';

/** Degrees → radians multiplier. */
export const D2R = Math.PI / 180;
/** Radians → degrees multiplier. */
export const R2D = 180 / Math.PI;

/** Convert an angle in degrees to radians. */
export function degToRad(deg: number): number {
  return deg * D2R;
}

/** Convert an angle in radians to degrees. */
export function radToDeg(rad: number): number {
  return rad * R2D;
}

/**
 * Convert geographic coordinates (degrees) to a 3D Cartesian point on a sphere
 * of radius `radius`. Writes into `out` when provided (to avoid per-frame /
 * per-pin allocation) and returns it.
 *
 * @param latDeg latitude in degrees, [-90, 90]
 * @param lonDeg longitude in degrees, [-180, 180]
 * @param radius sphere radius (defaults to the unit sphere, R = 1)
 * @param out    optional target vector to write into
 */
export function latLonToVector3(
  latDeg: number,
  lonDeg: number,
  radius = 1,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const phi = latDeg * D2R;
  const theta = lonDeg * D2R;
  const cosPhi = Math.cos(phi);
  return out.set(
    radius * cosPhi * Math.cos(theta),
    radius * Math.sin(phi),
    -radius * cosPhi * Math.sin(theta),
  );
}

/**
 * Inverse of {@link latLonToVector3}: decode a Cartesian point (any radius) back
 * to [latDeg, lonDeg] in degrees. Longitude is undefined exactly at the poles
 * (where the point is ±Y and the x/z components vanish); `atan2(0, 0)` yields 0
 * there, which is a stable, arbitrary choice — callers that care about polar
 * azimuth must handle it upstream (see ADR-27's degenerate-azimuth note).
 */
export function vector3ToLatLon(v: THREE.Vector3): [number, number] {
  // Normalize so the result is radius-independent; asin needs a unit y.
  const n = v.clone().normalize();
  const lat = Math.asin(THREE.MathUtils.clamp(n.y, -1, 1)) * R2D;
  const lon = Math.atan2(-n.z, n.x) * R2D;
  return [lat, lon];
}
