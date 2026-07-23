/**
 * Field texture baker (ADR-1, ADR-3, ADR-26). Turns the `/api/field` pin set
 * into an equirectangular `DataTexture` the globe fragment shader samples.
 *
 * SPEC DEVIATION (ADR-1): replaces the spec's per-fragment factor loop with a
 * once-per-data-change CPU bake (field.ts) written into a 2048×1024 texture.
 *
 * SPEC DEVIATION (ADR-3): two channels — R = net polarity P ∈ [-1, 1],
 * G = evidence density W ≥ 0 — so the shader can gate color on evidence rather
 * than collapsing "no data" and "equilibrium" into one purple.
 *
 * SPEC DEVIATION (ADR-26): the ONLY input is the `/api/field` response, which
 * carries no camera and no cursor. `bake()` must be called solely on receipt of
 * a new field response — never from an OrbitControls change handler, the render
 * loop, or a pagination reducer. That negative rule is what keeps the heatmap
 * camera-invariant and screenshots reproducible.
 *
 * Format: RG16F half-float. Half-float is linear-filterable in core WebGL2 (no
 * OES_texture_float_linear needed), and the two data channels fit exactly. The
 * texture is allocated ONCE and its backing store rewritten in place on rebake,
 * so no per-update GPU reallocation occurs.
 */
import * as THREE from 'three';
import {
  bakeFieldData,
  DEFAULT_FIELD_PARAMS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  type BakedField,
  type FieldInputPin,
  type FieldParams,
} from './field.js';

/**
 * Owns the field `DataTexture` for the lifetime of the globe. Allocated once;
 * `bake()` rewrites the backing `Uint16Array` and flags `needsUpdate`.
 */
export class FieldBaker {
  readonly texture: THREE.DataTexture;
  // Explicit ArrayBuffer backing: TS 5.7 typed arrays are generic over the
  // buffer, and three's DataTexture rejects the `ArrayBufferLike` default (it
  // admits SharedArrayBuffer). Pinning to ArrayBuffer keeps the constructor happy.
  private readonly data: Uint16Array<ArrayBuffer>;
  private readonly params: FieldParams;

  constructor(params: FieldParams = DEFAULT_FIELD_PARAMS) {
    this.params = params;
    // RG16F: 2 half-float channels (P, W) per texel.
    this.data = new Uint16Array(FIELD_WIDTH * FIELD_HEIGHT * 2);
    const texture = new THREE.DataTexture(
      this.data,
      FIELD_WIDTH,
      FIELD_HEIGHT,
      THREE.RGFormat,
      THREE.HalfFloatType,
    );
    // Linear filtering across the mesh; longitude wraps at the antimeridian seam,
    // latitude clamps at the poles. Data is linear (not sRGB), so no color space.
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false; // row 0 of `data` is the south pole; the shader agrees.
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.texture = texture;
  }

  /**
   * Rebake the field from a new pin set (the `/api/field` response, ADR-26).
   * Pins with a non-finite value are skipped defensively — a single NaN would
   * otherwise poison the whole field (audit finding 9). Returns the CPU
   * {@link BakedField} for tests/inspection.
   */
  bake(pins: readonly FieldInputPin[]): BakedField {
    const clean = pins.filter(
      (p) =>
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Number.isFinite(p.effect) &&
        Number.isFinite(p.significance),
    );
    const field = bakeFieldData(clean, this.params, FIELD_WIDTH, FIELD_HEIGHT);
    encodeToHalfFloat(field, this.data);
    this.texture.needsUpdate = true;
    return field;
  }

  /** Release GPU resources. Idempotent. */
  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * Encode a {@link BakedField} into an interleaved RG half-float buffer:
 * `[P0, W0, P1, W1, …]`. Exported for direct/unit use.
 */
export function encodeToHalfFloat(field: BakedField, out: Uint16Array): void {
  const { polarity, density } = field;
  const n = polarity.length;
  for (let i = 0; i < n; i++) {
    out[i * 2] = THREE.DataUtils.toHalfFloat(polarity[i]!);
    out[i * 2 + 1] = THREE.DataUtils.toHalfFloat(density[i]!);
  }
}
