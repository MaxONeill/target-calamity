/**
 * Unit tests for the pure coastline geometry builder. Offline and
 * deterministic — no WebGL, no JSON load; it exercises only the projection +
 * great-circle subdivision math against `buildCoastlineSegments`.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildCoastlineSegments, type LonLat } from './Coastlines.js';

describe('buildCoastlineSegments', () => {
  it('emits one segment pair (6 floats) for a short chord below the split threshold', () => {
    const line: LonLat[] = [
      [0, 0],
      [1, 0], // 1° apart — under MAX_SEGMENT_DEG (2°), no subdivision
    ];
    const out = buildCoastlineSegments([line], 1);
    expect(out.length).toBe(6);
  });

  it('great-circle subdivides a long chord into multiple segments on the sphere', () => {
    const line: LonLat[] = [
      [0, 0],
      [10, 0], // 10° apart → ceil(10/2) = 5 sub-segments → 5 pairs → 30 floats
    ];
    const out = buildCoastlineSegments([line], 1);
    expect(out.length).toBe(30);
    // Every emitted vertex must lie on the unit sphere (radius preserved).
    for (let i = 0; i < out.length; i += 3) {
      const r = Math.hypot(out[i]!, out[i + 1]!, out[i + 2]!);
      expect(r).toBeCloseTo(1, 6);
    }
  });

  it('scales vertices to the requested radius', () => {
    const line: LonLat[] = [
      [0, 0],
      [0.5, 0],
    ];
    const out = buildCoastlineSegments([line], 3.5);
    const r = Math.hypot(out[0]!, out[1]!, out[2]!);
    expect(r).toBeCloseTo(3.5, 6);
  });

  it('projects [lon, lat] consistently with geo.latLonToVector3', () => {
    // First emitted vertex is the projected start point [lon=20, lat=40].
    const out = buildCoastlineSegments([[[20, 40], [20.5, 40]]], 1);
    const start = new THREE.Vector3(out[0]!, out[1]!, out[2]!);
    // Reconstruct lat=40, lon=20 via the same convention geo.latLonToVector3 uses.
    const expected = new THREE.Vector3();
    expected.set(
      Math.cos((40 * Math.PI) / 180) * Math.cos((20 * Math.PI) / 180),
      Math.sin((40 * Math.PI) / 180),
      -Math.cos((40 * Math.PI) / 180) * Math.sin((20 * Math.PI) / 180),
    );
    expect(start.distanceTo(expected)).toBeCloseTo(0, 6);
  });

  it('skips degenerate lines with fewer than two vertices', () => {
    expect(buildCoastlineSegments([[[0, 0]]], 1).length).toBe(0);
    expect(buildCoastlineSegments([[]], 1).length).toBe(0);
  });
});
