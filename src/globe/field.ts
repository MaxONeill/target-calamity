/**
 * CPU accumulation field — the reference implementation of the chromatic
 * shading model, and the unit-test target.
 *
 * Accumulation runs once per data change here on the CPU and is baked into an
 * equirectangular texture (see bakeField.ts) the shader samples in O(1). The
 * GLSL never accumulates, so there is no per-fragment factor loop, no
 * MAX_FACTORS cap, and no shader recompile when the factor count changes.
 *
 * Two fields are computed rather than one scalar, because a single scalar makes
 * "no data" indistinguishable from "contested equilibrium" — both decay to
 * zero. Color is gated on evidence density so the two stay distinct:
 *
 *   w_i(p) = S_i / max(d(p,x_i), eps)^k         for d <= d_max, else 0   (k = 2.0)
 *   W(p)   = Σ_i w_i(p)                          evidence density  (>= 0)
 *   P(p)   = Σ_i E_i·w_i(p) / W(p)               net polarity ∈ [minEᵢ, maxEᵢ]
 *                                                (undefined / unused where W = 0)
 *
 * `d_max` derives from an angular cutoff θ_max (default 15°). `eps` cancels
 * between P's numerator and denominator, so P → Eᵢ as p → x_i regardless of eps.
 *
 * Distance is ANGULAR separation via the dot product of unit vectors, not a
 * Euclidean chord: the cutoff test is a single `dot >= cos(θ_max)`, and the
 * falloff uses the chord `d = sqrt(2 − 2·dot)`, which is monotone in the angle
 * and avoids `acos`/`length()` entirely.
 *
 * every texel→direction mapping is derived by CALLING
 * `latLonToVector3` (via {@link getDirectionGrid}) — never by hand-writing trig
 * on a lat/lon identifier. This guarantees the baked field is the exact inverse
 * of the pin placement, so the heatmap can never end up rotated or mirrored
 * relative to the pins.
 *
 * Pure and framework-light: the only three.js dependency is `Vector3`
 * (allocation-free via scratch reuse), so the whole module is unit-testable in
 * node under vitest.
 */
import * as THREE from 'three';
import { latLonToVector3 } from '../lib/geo.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Equirectangular bake width. */
export const FIELD_WIDTH = 2048;
/** Equirectangular bake height. */
export const FIELD_HEIGHT = 1024;

/**
 * Kernel parameters. `k = 2.0` and the ε clamp are fixed by; θ_max is
 * 's compact-support cutoff (15° default). `eps` is a chord-distance clamp
 * on the unit sphere (chord ∈ [0, 2]); at eps = 0.05 a single factor's peak
 * density is S/eps² = 400·S, matching the audit's worked example.
 */
export interface FieldParams {
  /** Angular support radius in degrees (, default 15). */
  thetaMaxDeg: number;
  /** Chord-distance clamp on the unit sphere (v3.2 ε, default 0.05). */
  eps: number;
  /** Falloff exponent (v3.2 k, default 2.0). */
  k: number;
}

/**
 * PIN COLOR ATTENUATION ( tuning): the chromatic Calamity/Humanity signal
 * is deliberately CONTAINED to a tight halo around each factor so the new
 * green-land / blue-ocean geography reads as the base and the pin color is a
 * localized signal rather than a broad wash bleeding across the globe.
 *   - `thetaMaxDeg` 15 → 8: smaller angular support = tighter halo.
 *   - `k` 2.0 → 2.5: steeper inverse-distance falloff = faster fade from the pin.
 * (The blend also caps the field's tint over geography — see FIELD_STRENGTH_CAP
 * in shaders.ts.) All three are tunable knobs; dial here + there to taste.
 */
export const DEFAULT_FIELD_PARAMS: FieldParams = {
  thetaMaxDeg: 8,
  eps: 0.05,
  k: 2.5,
};

/** Minimal shape the field consumes — a subset of both `Factor` and `FieldPin`. */
export interface FieldInputPin {
  lat: number;
  lon: number;
  /** Signed impact ∈ [-1, 1] (Eᵢ). Negative = Calamity, positive = Humanity. */
  effect: number;
  /** Weight ∈ [0, 1] (Sᵢ). */
  significance: number;
}

/** A pin resolved to its unit-sphere position — the kernel's actual input. */
export interface FieldPinVec {
  unit: THREE.Vector3;
  effect: number;
  significance: number;
}

/**
 * A baked field. `polarity` (P) and `density` (W) are row-major equirectangular
 * grids of `width × height` texels. Texel (x, y) is centered at
 * `lon = -180 + (x+0.5)/width·360`, `lat = -90 + (y+0.5)/height·180` — row 0 is
 * the south pole, the last row the north pole (see {@link texelToLatLon}). The
 * fragment shader must decode a fragment direction to this exact `(u, v)`.
 */
export interface BakedField {
  width: number;
  height: number;
  /** Net polarity P ∈ [-1, 1] per texel; 0 where W = 0 (unused behind the gate). */
  polarity: Float32Array;
  /** Evidence density W >= 0 per texel. */
  density: Float32Array;
}

/* -------------------------------------------------------------------------- */
/* Equirectangular texel geometry                                             */
/* -------------------------------------------------------------------------- */

/**
 * Texel center → geographic coordinates (degrees). The exact convention the
 * baked texture and the fragment shader both agree on.
 */
export function texelToLatLon(
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number] {
  const lon = -180 + ((x + 0.5) / width) * 360;
  const lat = -90 + ((y + 0.5) / height) * 180;
  return [lat, lon];
}

/**
 * Direction-grid cache. The texel→unit-vector map depends only on resolution
 * (never on the pins), so it is computed once via `latLonToVector3` and
 * reused across every bake. Stored as flat XYZ triples in row-major order.
 */
interface DirectionGrid {
  width: number;
  height: number;
  /** Length `width·height·3`, laid out `[x0,y0,z0, x1,y1,z1, …]`. */
  xyz: Float32Array;
}

let directionGridCache: DirectionGrid | null = null;

/**
 * Memoized grid of texel unit-direction vectors, derived by calling
 * `latLonToVector3` on each texel center ( — no hand-written trig). The
 * result is the exact inverse of the pin placement, so W's argmax texel always
 * decodes back to the injected pin's lat/lon.
 */
export function getDirectionGrid(
  width = FIELD_WIDTH,
  height = FIELD_HEIGHT,
): DirectionGrid {
  const cached = directionGridCache;
  if (cached && cached.width === width && cached.height === height) {
    return cached;
  }
  const xyz = new Float32Array(width * height * 3);
  const scratch = new THREE.Vector3();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [lat, lon] = texelToLatLon(x, y, width, height);
      latLonToVector3(lat, lon, 1, scratch);
      const base = (y * width + x) * 3;
      xyz[base] = scratch.x;
      xyz[base + 1] = scratch.y;
      xyz[base + 2] = scratch.z;
    }
  }
  const grid: DirectionGrid = { width, height, xyz };
  directionGridCache = grid;
  return grid;
}

/* -------------------------------------------------------------------------- */
/* Kernel — reference (per-point) form                                        */
/* -------------------------------------------------------------------------- */

/** Resolve raw input pins to unit-vector form ( conversion). */
export function toPinVecs(pins: readonly FieldInputPin[]): FieldPinVec[] {
  return pins.map((p) => ({
    unit: latLonToVector3(p.lat, p.lon, 1),
    effect: p.effect,
    significance: p.significance,
  }));
}

/**
 * Reference kernel evaluated at a single unit direction — the ground truth the
 * baked grid must reproduce texel-for-texel. Returns the two fields (W, P);
 * `P = 0` when `W = 0` (no pin in support), which the color gate treats as grey.
 *
 * @param dir   a UNIT direction on the sphere
 * @param pins  pins in unit-vector form (see {@link toPinVecs})
 */
export function accumulateAt(
  dir: THREE.Vector3,
  pins: readonly FieldPinVec[],
  params: FieldParams = DEFAULT_FIELD_PARAMS,
): { W: number; P: number } {
  const cosThetaMax = Math.cos(params.thetaMaxDeg * (Math.PI / 180));
  const eps = params.eps;
  const k = params.k;
  let W = 0;
  let num = 0;
  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    if (pin === undefined) continue;
    const u = pin.unit;
    const dot = dir.x * u.x + dir.y * u.y + dir.z * u.z;
    if (dot < cosThetaMax) continue;
    // Chord on the unit sphere: d² = 2 − 2·dot. Clamp ≥ 0 for FP noise.
    const chord = Math.sqrt(Math.max(0, 2 - 2 * dot));
    const dEff = Math.max(chord, eps);
    const w = pin.significance / Math.pow(dEff, k);
    W += w;
    num += pin.effect * w;
  }
  return { W, P: W > 0 ? num / W : 0 };
}

/* -------------------------------------------------------------------------- */
/* Bake — scatter form (production)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Bake the full equirectangular field. Uses a per-pin scatter: each pin only
 * touches texels inside its θ_max cap (a lat/lon bounding box, widened by
 * `1/cos(lat)` toward the poles), so cost is O(pins · cap-area) rather than
 * O(pins · texels). The `dot >= cos θ_max` test inside the box rejects the
 * corners the box over-covers, so over-inclusion is a perf cost only, never a
 * correctness one. Identical results to {@link accumulateAt} at every texel.
 */
export function bakeFieldData(
  pins: readonly FieldInputPin[],
  params: FieldParams = DEFAULT_FIELD_PARAMS,
  width = FIELD_WIDTH,
  height = FIELD_HEIGHT,
): BakedField {
  const grid = getDirectionGrid(width, height);
  const dirs = grid.xyz;
  const texelCount = width * height;

  const density = new Float32Array(texelCount); // W = Σ w_i
  const numerator = new Float32Array(texelCount); // Σ E_i·w_i

  const thetaMaxRad = params.thetaMaxDeg * (Math.PI / 180);
  const cosThetaMax = Math.cos(thetaMaxRad);
  const eps = params.eps;
  const k = params.k;
  const D2R = Math.PI / 180;

  const u = new THREE.Vector3();

  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    if (pin === undefined) continue;
    latLonToVector3(pin.lat, pin.lon, 1, u);
    const ux = u.x;
    const uy = u.y;
    const uz = u.z;
    const effect = pin.effect;
    const sig = pin.significance;

    // Latitude band: [lat0 − θ_max, lat0 + θ_max], clamped to the poles.
    const latMin = Math.max(-90, pin.lat - params.thetaMaxDeg);
    const latMax = Math.min(90, pin.lat + params.thetaMaxDeg);
    const rowStart = clampInt(
      Math.floor(((latMin + 90) / 180) * height),
      0,
      height - 1,
    );
    const rowEnd = clampInt(
      Math.ceil(((latMax + 90) / 180) * height),
      0,
      height - 1,
    );

    // Longitude band widens toward the poles as 1/cos(lat). If the cap reaches a
    // pole (or the band would exceed 180°), scan every column — the dot cutoff
    // still discards texels outside the true cap.
    const worstLatRad = Math.min(89.9, Math.abs(pin.lat) + params.thetaMaxDeg) * D2R;
    const cosWorst = Math.cos(worstLatRad);
    const fullLon =
      Math.abs(pin.lat) + params.thetaMaxDeg >= 89.9 ||
      cosWorst <= 1e-4 ||
      params.thetaMaxDeg / cosWorst >= 180;
    const lonHalfSpan = fullLon ? 180 : params.thetaMaxDeg / cosWorst;

    let colStart: number;
    let colEnd: number;
    if (fullLon) {
      colStart = 0;
      colEnd = width - 1;
    } else {
      // Fractional column of the pin's longitude, then ± the half-span in texels.
      const centerCol = ((pin.lon + 180) / 360) * width - 0.5;
      const halfCols = (lonHalfSpan / 360) * width + 1;
      colStart = Math.floor(centerCol - halfCols);
      colEnd = Math.ceil(centerCol + halfCols);
      // High-latitude double-count guard (review finding #7): the 1/cos(lat)
      // widening plus the ±1 texel padding can make the requested span cover as
      // many (or more) columns than the texture is wide, even when `fullLon` did
      // not trip. The wrap `x = ((xi % width) + width) % width` would then revisit
      // the same texel column and add its weight to density/numerator TWICE. Cap
      // the span at a single full wrap so every column is scanned exactly once;
      // the `dot >= cos θ_max` test inside the loop still rejects columns outside
      // the true cap, so this is correctness-preserving, not just a perf clamp.
      if (colEnd - colStart + 1 >= width) {
        colStart = 0;
        colEnd = width - 1;
      }
    }

    for (let y = rowStart; y <= rowEnd; y++) {
      const rowBase = y * width;
      for (let xi = colStart; xi <= colEnd; xi++) {
        // Wrap longitude columns across the antimeridian seam.
        const x = ((xi % width) + width) % width;
        const idx = rowBase + x;
        const dBase = idx * 3;
        const dot = ux * dirs[dBase]! + uy * dirs[dBase + 1]! + uz * dirs[dBase + 2]!;
        if (dot < cosThetaMax) continue;
        const chord = Math.sqrt(Math.max(0, 2 - 2 * dot));
        const dEff = Math.max(chord, eps);
        const w = sig / Math.pow(dEff, k);
        density[idx] = density[idx]! + w;
        numerator[idx] = numerator[idx]! + effect * w;
      }
    }
  }

  // P = Σ E_i·w_i / W, undefined→0 where W = 0 (grey behind the gate).
  const polarity = new Float32Array(texelCount);
  for (let idx = 0; idx < texelCount; idx++) {
    const wSum = density[idx]!;
    polarity[idx] = wSum > 0 ? numerator[idx]! / wSum : 0;
  }

  return { width, height, polarity, density };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
