/**
 * Unit tests for the CPU field kernel (field.ts is the  test target). These
 * assert the two-field, three-state model and the  baker↔pin
 * inverse — including the acceptance test that a single Calamity factor paints a
 * red patch with grey everywhere else and ZERO purple.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { latLonToVector3 } from '../lib/geo.js';
import { W_MIN } from './shaders.js';
import {
  DEFAULT_FIELD_PARAMS,
  accumulateAt,
  bakeFieldData,
  getDirectionGrid,
  texelToLatLon,
  toPinVecs,
  type FieldInputPin,
} from './field.js';

const CALAMITY: FieldInputPin = { lat: 0, lon: 0, effect: -1, significance: 1 };

describe('kernel (accumulateAt)', () => {
  it('yields P → effect and W > 0 at the pin, regardless of eps (eps cancels in P)', () => {
    const pins = toPinVecs([CALAMITY]);
    const dir = latLonToVector3(0, 0, 1);
    const a = accumulateAt(dir, pins, { ...DEFAULT_FIELD_PARAMS, eps: 0.05 });
    const b = accumulateAt(dir, pins, { ...DEFAULT_FIELD_PARAMS, eps: 0.2 });
    expect(a.W).toBeGreaterThan(0);
    expect(a.P).toBeCloseTo(-1, 6);
    expect(b.P).toBeCloseTo(-1, 6); // P independent of eps
  });

  it('returns W = 0 (grey) outside the angular support', () => {
    const pins = toPinVecs([CALAMITY]);
    const far = latLonToVector3(0, 90, 1); // 90° away, well past θ_max = 15°
    const r = accumulateAt(far, pins);
    expect(r.W).toBe(0);
    expect(r.P).toBe(0);
  });

  it('normalizes two opposing pins to a contested (P ≈ 0), high-W purple state', () => {
    const pins = toPinVecs([
      { lat: 0, lon: 0, effect: -1, significance: 1 },
      { lat: 0, lon: 0, effect: 1, significance: 1 },
    ]);
    const dir = latLonToVector3(0, 0, 1);
    const r = accumulateAt(dir, pins);
    expect(r.W).toBeGreaterThan(W_MIN);
    expect(Math.abs(r.P)).toBeLessThan(1e-9); // balanced → purple
  });
});

describe('direction grid ( inverse)', () => {
  it('matches latLonToVector3 at every texel center', () => {
    const w = 16;
    const h = 8;
    const grid = getDirectionGrid(w, h);
    const scratch = new THREE.Vector3();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [lat, lon] = texelToLatLon(x, y, w, h);
        latLonToVector3(lat, lon, 1, scratch);
        const base = (y * w + x) * 3;
        expect(grid.xyz[base]).toBeCloseTo(scratch.x, 6);
        expect(grid.xyz[base + 1]).toBeCloseTo(scratch.y, 6);
        expect(grid.xyz[base + 2]).toBeCloseTo(scratch.z, 6);
      }
    }
  });
});

describe('bake (acceptance: one Calamity factor at (0,0))', () => {
  const w = 256;
  const h = 128;
  const field = bakeFieldData([CALAMITY], DEFAULT_FIELD_PARAMS, w, h);

  it("argmax-W texel decodes back to an OFF-ORIGIN pin's lat/lon", () => {
    // An off-origin pin is what actually catches a mirrored/rotated/V-flipped
    // bake — a flip would move the argmax by tens of degrees. Tolerance covers
    // the eps-clamp plateau (chord ≤ eps ⇒ angle ≤ ~2.86°) plus one texel.
    const off = bakeFieldData(
      [{ lat: 30, lon: 45, effect: -1, significance: 1 }],
      DEFAULT_FIELD_PARAMS,
      w,
      h,
    );
    let best = -1;
    let bestIdx = 0;
    for (let i = 0; i < off.density.length; i++) {
      const wv = off.density[i]!;
      if (wv > best) {
        best = wv;
        bestIdx = i;
      }
    }
    const [lat, lon] = texelToLatLon(bestIdx % w, Math.floor(bestIdx / w), w, h);
    expect(Math.abs(lat - 30)).toBeLessThan(3.5);
    expect(Math.abs(lon - 45)).toBeLessThan(3.5);
  });

  it('paints a red patch (P ≈ -1 where lit) and ZERO purple', () => {
    let litCount = 0;
    for (let i = 0; i < field.density.length; i++) {
      if (field.density[i]! >= W_MIN) {
        litCount++;
        // Single pin → P equals its effect exactly wherever there is evidence.
        // No texel is ever near 0, so purple is unreachable.
        expect(field.polarity[i]!).toBeLessThan(-0.9);
      }
    }
    expect(litCount).toBeGreaterThan(0); // there IS a red patch
  });

  it('leaves the far side inert grey (W < W_min)', () => {
    // Antipode texel (lon ≈ 180, lat ≈ 0).
    const grid = bakeFieldData([CALAMITY], DEFAULT_FIELD_PARAMS, w, h);
    const y = Math.floor(h / 2);
    const x = w - 1;
    const idx = y * w + x;
    expect(grid.density[idx]!).toBeLessThan(W_MIN);
  });

  it('agrees with the per-point reference kernel at a sampled texel', () => {
    const pins = toPinVecs([CALAMITY]);
    const x = 4;
    const y = 60;
    const [lat, lon] = texelToLatLon(x, y, w, h);
    const dir = latLonToVector3(lat, lon, 1);
    const ref = accumulateAt(dir, pins);
    const idx = y * w + x;
    expect(field.density[idx]!).toBeCloseTo(ref.W, 4);
    expect(field.polarity[idx]!).toBeCloseTo(ref.P, 4);
  });
});

describe('bake (high-latitude column double-count guard, review finding #7)', () => {
  // A pin at lat 70.2 makes the widest row's longitude half-span ≈ 179.3° — just
  // under the `fullLon` cutoff — so the requested column span (≈ 259 cols on a
  // 256-wide grid) EXCEEDS the texture width and exercises the clamp branch. Before
  // the clamp, the wrap `x = ((xi % width) + width) % width` revisited columns and
  // could add a pin's weight to a texel TWICE. The reference kernel visits each
  // direction once, so any double-count shows up as baked W > reference W.
  const w = 256;
  const h = 128;
  const NEAR_POLE: FieldInputPin = { lat: 70.2, lon: 25, effect: -1, significance: 1 };
  const field = bakeFieldData([NEAR_POLE], DEFAULT_FIELD_PARAMS, w, h);
  const pins = toPinVecs([NEAR_POLE]);

  it('bakes each lit texel exactly once — baked W ≈ reference (never ~2×)', () => {
    // Relative tolerance separates the two effects cleanly: the Float32
    // direction-grid vs Float64 reference gap is ~1e-6 relative, whereas a
    // double-counted column reads ~2× the reference (relative error ≈ 1.0).
    let interiorChecked = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [lat, lon] = texelToLatLon(x, y, w, h);
        const ref = accumulateAt(latLonToVector3(lat, lon, 1), pins);
        const idx = y * w + x;
        if (ref.W > 0.5) {
          // Clearly-lit interior texel (skips the ±1-texel cap boundary, where
          // Float32/Float64 dot rounding legitimately flips inclusion).
          const relErr = Math.abs(field.density[idx]! - ref.W) / ref.W;
          expect(relErr).toBeLessThan(5e-3);
          expect(field.polarity[idx]!).toBeCloseTo(ref.P, 3); // single pin ⇒ P = −1
          interiorChecked++;
        }
      }
    }
    expect(interiorChecked).toBeGreaterThan(0); // the pin actually lights a patch
  });

  it('never doubles a texel at the widest (near-pole) row', () => {
    // The row nearest the pole is where the over-wide column span would have
    // wrapped and revisited a texel. Baked density must not exceed the reference
    // by more than the Float32 gap — a double-count would be ≈ 2× ref.
    const y = h - 1;
    for (let x = 0; x < w; x++) {
      const [lat, lon] = texelToLatLon(x, y, w, h);
      const ref = accumulateAt(latLonToVector3(lat, lon, 1), pins);
      const idx = y * w + x;
      expect(field.density[idx]!).toBeLessThanOrEqual(ref.W * 1.01 + 1e-4);
    }
  });
});
