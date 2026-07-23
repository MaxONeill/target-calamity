/**
 * Runtime elevation grid (ADR-42). Loads the coarse equirectangular elevation
 * grid baked by `scripts/fetch-elevation.mjs` (Open-Meteo, meters) from
 * `/elevation-grid.json`, decodes its base64 Int16 payload back to a typed
 * array, and bilinearly samples it at any lat/lon so GlobeMesh can displace the
 * icosphere by real terrain.
 *
 * Degrades gracefully: `loadElevationGrid()` returns `null` on 404 (grid not yet
 * baked — the operator must run `npm run fetch:elevation` once, which needs
 * network) or on any parse error, so the globe falls back to the land-relief
 * displacement and never crashes.
 *
 * Grid layout (must match the fetch script): row-major `width × height`, with
 *   lon = −180 + (ix / (width − 1)) · 360      ix 0 → −180, width−1 → +180
 *   lat =  90 − (iy / (height − 1)) · 180      iy 0 →  +90 (north), H−1 → −90
 * i.e. row 0 is the NORTH pole. Values are meters (sea level = 0), clamped to
 * int16 range at bake time.
 *
 * Caching (both layers): the decoded grid is memoized module-side, so a second
 * GlobeMesh construction (StrictMode remount / hot reload) reuses the same typed
 * array without re-fetching or re-decoding; the browser HTTP-caches the static
 * JSON on top of that. Pure helpers here are unit-tested offline (no network).
 */

/** A decoded elevation grid. `data` is row-major meters, length `width·height`. */
export interface ElevationGrid {
  width: number;
  height: number;
  /** Minimum meters in the grid (informational). */
  min: number;
  /** Maximum meters in the grid (informational). */
  max: number;
  /** Row-major elevation in meters, length `width · height`. */
  data: Int16Array;
}

/** The compact on-disk shape written by `scripts/fetch-elevation.mjs`. */
export interface ElevationGridFile {
  width: number;
  height: number;
  min: number;
  max: number;
  /** base64 of an Int16Array (little-endian) of `width · height` meters. */
  data: string;
}

/**
 * Decode a base64 string into an `Int16Array` (little-endian). Pure; works in
 * both the browser and Node (`atob` is global in both). Exported for unit tests.
 */
export function decodeBase64Int16(b64: string): Int16Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  // A trailing odd byte cannot form an Int16; floor to whole samples.
  const samples = bytes.byteLength >> 1;
  return new Int16Array(bytes.buffer, 0, samples);
}

/** Validate + decode a parsed grid file into an {@link ElevationGrid}. Pure. */
export function decodeElevationGrid(file: ElevationGridFile): ElevationGrid | null {
  if (
    !Number.isFinite(file.width) ||
    !Number.isFinite(file.height) ||
    file.width <= 0 ||
    file.height <= 0 ||
    typeof file.data !== 'string'
  ) {
    return null;
  }
  const data = decodeBase64Int16(file.data);
  if (data.length < file.width * file.height) return null;
  return { width: file.width, height: file.height, min: file.min, max: file.max, data };
}

/** Clamp a value into an inclusive integer range. */
function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Continuous grid coordinates for a geographic point. Longitude wraps into
 * [−180, 180); latitude clamps to the poles. Exported for unit tests.
 *
 * @returns `[gx, gy]` in grid-index space (may be fractional; gx wraps).
 */
export function latLonToGridFrac(
  grid: Pick<ElevationGrid, 'width' | 'height'>,
  latDeg: number,
  lonDeg: number,
): [number, number] {
  const lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  const lat = latDeg > 90 ? 90 : latDeg < -90 ? -90 : latDeg;
  const gx = ((lon + 180) / 360) * (grid.width - 1);
  const gy = ((90 - lat) / 180) * (grid.height - 1);
  return [gx, gy];
}

function at(grid: ElevationGrid, ix: number, iy: number): number {
  const x = clampInt(ix, 0, grid.width - 1);
  const y = clampInt(iy, 0, grid.height - 1);
  return grid.data[y * grid.width + x] ?? 0;
}

/**
 * Bilinearly sample the elevation grid at a geographic point, in meters.
 * Deterministic and pure — unit-tested offline.
 */
export function sampleElevation(grid: ElevationGrid, latDeg: number, lonDeg: number): number {
  const [gx, gy] = latLonToGridFrac(grid, latDeg, lonDeg);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = gx - x0;
  const ty = gy - y0;
  const v00 = at(grid, x0, y0);
  const v10 = at(grid, x0 + 1, y0);
  const v01 = at(grid, x0, y0 + 1);
  const v11 = at(grid, x0 + 1, y0 + 1);
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

/** Module-level cache so re-mounts reuse the decoded grid (no re-fetch/-decode). */
let cached: ElevationGrid | null | undefined;
let inFlight: Promise<ElevationGrid | null> | null = null;

/**
 * Fetch + decode `/elevation-grid.json`. Returns `null` when the grid is absent
 * (404) or malformed, so the caller can fall back to land-relief. Memoized: the
 * network round-trip and decode happen at most once per page.
 */
export async function loadElevationGrid(): Promise<ElevationGrid | null> {
  if (cached !== undefined) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // 'default' (not 'force-cache') so a 404 cached from a pre-bake page load
      // can't pin the grid as "absent" — the module-level memo already prevents
      // re-fetching within a session.
      const res = await fetch('/elevation-grid.json', { cache: 'default' });
      if (!res.ok) {
        cached = null;
        return null;
      }
      const json = (await res.json()) as ElevationGridFile;
      cached = decodeElevationGrid(json);
      return cached;
    } catch {
      cached = null;
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test-only: reset the module cache. */
export function __resetElevationCache(): void {
  cached = undefined;
  inFlight = null;
}
