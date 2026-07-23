/**
 * Unit tests for the pure elevation helpers. Offline and deterministic
 * — no network, no WebGL: exercises the base64 Int16 decode, the lat/lon → grid
 * mapping, and the bilinear sampler against a tiny hand-built grid.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeBase64Int16,
  decodeElevationGrid,
  latLonToGridFrac,
  sampleElevation,
  type ElevationGrid,
} from './elevation.js';

/** Encode an Int16Array to base64 the same way the fetch script does. */
function encode(int16: Int16Array): string {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).toString('base64');
}

describe('decodeBase64Int16', () => {
  it('round-trips an Int16Array including the int16 extremes', () => {
    const original = new Int16Array([0, 1, -2, 300, -32768, 32767]);
    const decoded = decodeBase64Int16(encode(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});

describe('decodeElevationGrid', () => {
  it('decodes a well-formed file into a typed grid', () => {
    const data = new Int16Array([10, 20, 30, 40]);
    const grid = decodeElevationGrid({
      width: 2,
      height: 2,
      min: 10,
      max: 40,
      data: encode(data),
    });
    expect(grid).not.toBeNull();
    expect(grid!.width).toBe(2);
    expect(Array.from(grid!.data)).toEqual([10, 20, 30, 40]);
  });

  it('rejects a truncated payload (fewer samples than width·height)', () => {
    const grid = decodeElevationGrid({
      width: 4,
      height: 4,
      min: 0,
      max: 0,
      data: encode(new Int16Array([1, 2])),
    });
    expect(grid).toBeNull();
  });
});

describe('latLonToGridFrac', () => {
  const grid = { width: 3, height: 2 }; // lon nodes: -180,0,180 ; lat nodes: 90,-90

  it('maps the north-pole/prime-meridian point to the middle-top node', () => {
    const [gx, gy] = latLonToGridFrac(grid, 90, 0);
    expect(gx).toBeCloseTo(1, 9); // lon 0 → middle column
    expect(gy).toBeCloseTo(0, 9); // lat 90 → top row
  });

  it('wraps longitude past the antimeridian and clamps latitude to the poles', () => {
    const [gx, gy] = latLonToGridFrac(grid, 100, 190); // lat clamps to 90, lon wraps to -170
    expect(gy).toBeCloseTo(0, 9);
    expect(gx).toBeCloseTo(((10) / 360) * 2, 6); // (-170+180)/360 · (w-1)
  });
});

describe('sampleElevation (bilinear)', () => {
  // 3×2 grid. Rows: y0 = lat +90, y1 = lat −90. Cols: x0 lon −180, x1 lon 0, x2 lon +180.
  const grid: ElevationGrid = {
    width: 3,
    height: 2,
    min: 0,
    max: 100,
    data: new Int16Array([0, 100, 0, 40, 60, 40]),
  };

  it('returns the exact node value at a grid node', () => {
    // lat 90, lon 0 → node (1,0) → data[1] = 100.
    expect(sampleElevation(grid, 90, 0)).toBeCloseTo(100, 6);
    // lat -90, lon -180 → node (0,1) → data[3] = 40.
    expect(sampleElevation(grid, -90, -180)).toBeCloseTo(40, 6);
  });

  it('interpolates horizontally between two nodes', () => {
    // lat 90, lon -90 → gx 0.5 between data[0]=0 and data[1]=100 → 50.
    expect(sampleElevation(grid, 90, -90)).toBeCloseTo(50, 6);
  });

  it('interpolates vertically between the poles', () => {
    // lon 0 (gx=1), lat 0 → gy 0.5 between data[1]=100 (top) and data[4]=60 (bottom) → 80.
    expect(sampleElevation(grid, 0, 0)).toBeCloseTo(80, 6);
  });
});
