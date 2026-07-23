/**
 * Land mask raster (ADR-41). Rasterizes the `world-atlas` 110m LAND polygons
 * onto an offscreen equirectangular canvas (land = white, ocean = black) and
 * wraps it as a `THREE.CanvasTexture` for the globe fragment shader's geographic
 * base coloring. The SAME 110m source feeds `Coastlines.ts`, so the green land
 * fill sits exactly under the cyan coastline lines (same projection, same seam).
 *
 * Projection convention (must match the shader's uField/uLandMask sampling):
 *   x = (lon + 180) / 360 · W        lon −180 → x 0, lon +180 → x W
 *   y = (90 − lat) / 180 · H         lat  +90 → y 0 (top), lat −90 → y H
 * The `CanvasTexture` keeps three's default `flipY = true`, so texture v = 1
 * samples the canvas TOP row (lat +90) — i.e. uv.v = lat/π + 0.5 lines up with
 * how the field texture (row 0 = south pole, flipY = false) is sampled. Net:
 * a fragment at latitude φ reads the same latitude in both textures.
 *
 * This module touches the DOM (`document.createElement('canvas')`) and so is not
 * unit-tested; it is constructed only inside the browser scene. It also exposes a
 * CPU `sampleLand(lat, lon)` (reads the raster back via `getImageData`) so the
 * land-relief displacement FALLBACK (ADR-42) can raise continents without a GPU
 * readback.
 *
 * ADR-25: no lat/lon trig happens here — equirectangular rasterization is linear
 * in lon/lat, not trigonometric, so it does not fall under the trig ban.
 */
import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { Feature, FeatureCollection, Geometry, Polygon, MultiPolygon } from 'geojson';
import landTopo110m from 'world-atlas/land-110m.json';

export interface LandMask {
  /** Equirectangular land raster (land = white) for the shader `uLandMask`. */
  texture: THREE.CanvasTexture;
  /** CPU land fraction at a geographic point: 1 = land, 0 = ocean. */
  sampleLand(latDeg: number, lonDeg: number): number;
  /** Release the texture (and drop the CPU raster). Idempotent. */
  dispose(): void;
}

export interface LandMaskOptions {
  /** Raster width in texels (equirectangular). Default 2048. */
  width?: number;
  /** Raster height in texels. Default 1024. */
  height?: number;
}

/** Project a [lon, lat] ring to canvas pixel coordinates and stroke a path. */
function traceRing(
  ctx: CanvasRenderingContext2D,
  ring: readonly (readonly number[])[],
  width: number,
  height: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < ring.length; i++) {
    const pt = ring[i]!;
    const lon = pt[0]!;
    const lat = pt[1]!;
    const x = ((lon + 180) / 360) * width;
    const y = ((90 - lat) / 180) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Project a [lon, lat] ring to canvas pixels, UNWRAPPING longitude for
 * continuity: when consecutive points jump more than 180° (crossing the ±180°
 * antimeridian) we accumulate a ∓360° offset so the ring stays a continuous path
 * instead of streaking straight across the canvas. The result may extend beyond
 * [0, width]; the caller redraws it at ±width offsets so the overflow wraps to
 * the far edge. Without this the merged Afro-Eurasia land polygon (which crosses
 * the seam at the Bering Strait, ~65°N) drew a full-width horizontal band.
 */
function ringToPixels(
  ring: readonly (readonly number[])[],
  width: number,
  height: number,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let offset = 0;
  let prevLon: number | null = null;
  for (const pt of ring) {
    const lon = pt[0]!;
    if (prevLon !== null) {
      const d = lon - prevLon;
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    prevLon = lon;
    const x = ((lon + offset + 180) / 360) * width;
    const y = ((90 - pt[1]!) / 180) * height;
    pts.push([x, y]);
  }
  return pts;
}

/** Fill one GeoJSON polygon (outer ring + holes) using even-odd — holes carve out. */
function fillPolygon(
  ctx: CanvasRenderingContext2D,
  polygon: Polygon['coordinates'],
  width: number,
  height: number,
): void {
  const rings = polygon.map((r) => ringToPixels(r, width, height));
  // Draw the polygon and its ±width copies so a seam-crossing (unwrapped) ring
  // wraps to the far edge instead of streaking across. Non-crossing polygons'
  // copies fall entirely off-canvas and are clipped — no effect.
  for (const dx of [-width, 0, width]) {
    ctx.beginPath();
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = ring[i]!;
        if (i === 0) ctx.moveTo(x + dx, y);
        else ctx.lineTo(x + dx, y);
      }
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}

/**
 * Build the land mask. Rasterizes every land polygon with antimeridian handling
 * (see {@link ringToPixels} / {@link fillPolygon}): the merged Afro-Eurasia land
 * polygon crosses the ±180° seam at the Bering Strait, so a naive fill streaked a
 * full-width band through Canada/Alaska/Russia — unwrapping + ±width copies fix it.
 */
export function createLandMask(options: LandMaskOptions = {}): LandMask {
  const width = options.width ?? 2048;
  const height = options.height ?? 1024;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('landMask: 2D canvas context unavailable');

  // Ocean = black background, land = white fill.
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';

  const topology = landTopo110m as unknown as Topology<{ land: GeometryCollection }>;
  const geo = feature(topology, topology.objects.land) as
    | Feature<Geometry>
    | FeatureCollection<Geometry>;

  const geometries: Geometry[] =
    geo.type === 'FeatureCollection'
      ? geo.features.map((f) => f.geometry)
      : [geo.geometry];

  for (const g of geometries) {
    if (g.type === 'Polygon') {
      fillPolygon(ctx, (g as Polygon).coordinates, width, height);
    } else if (g.type === 'MultiPolygon') {
      for (const poly of (g as MultiPolygon).coordinates) {
        fillPolygon(ctx, poly, width, height);
      }
    }
  }
  void traceRing; // retained for future stroked-outline debugging; not on the hot path.

  // Snapshot the raster ONCE for CPU land sampling (fallback relief, ADR-42).
  let image: ImageData | null = ctx.getImageData(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  return {
    texture,
    sampleLand(latDeg: number, lonDeg: number): number {
      if (!image) return 0;
      // Wrap lon into [-180, 180), clamp lat, then nearest-texel lookup.
      let lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
      const lat = latDeg > 90 ? 90 : latDeg < -90 ? -90 : latDeg;
      const x = Math.min(width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * width)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * height)));
      const r = image.data[(y * width + x) * 4] ?? 0;
      return r > 127 ? 1 : 0;
    },
    dispose(): void {
      image = null;
      texture.dispose();
    },
  };
}
