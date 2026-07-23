import type { GlobeMesh } from '../globe/GlobeMesh.js';
import { EARTH_RADIUS_M, DEFAULT_EXAGGERATION } from '../globe/GlobeMesh.js';
import { loadElevationGrid, sampleElevation } from '../globe/elevation.js';
import type { LandMask } from '../globe/landMask.js';

/**
 * Height in metres given to land before the real elevation grid arrives, so
 * continents still read in relief. Ocean stays at the same sea-level floor the
 * real grid uses.
 */
export const LAND_RELIEF_M = 2500;

/** The fallback sampler: flat ocean, land raised a constant. */
export function landReliefSampler(landMask: LandMask): (lat: number, lon: number) => number {
  return (lat, lon) => (landMask.sampleLand(lat, lon) > 0.5 ? LAND_RELIEF_M : 0);
}

/**
 * Fire-and-forget upgrade from the land-relief fallback to real terrain.
 *
 * Resolves to nothing if the grid has not been baked (`npm run fetch:elevation`)
 * or the scene tore down first — the fallback simply stays.
 *
 * Displacement is gated by the land mask because the elevation grid is coarse
 * (~1.5° cells) and bilinear sampling bleeds land height offshore; the much finer
 * mask decides what is land, so relief and the painted coastline cannot disagree.
 */
export async function applyRealTerrain(
  globe: GlobeMesh,
  landMask: LandMask,
  isCancelled: () => boolean,
  onApplied: () => void,
): Promise<void> {
  const grid = await loadElevationGrid();
  if (isCancelled() || !grid) return;

  globe.setElevation({
    sampleMeters: (lat, lon) =>
      landMask.sampleLand(lat, lon) > 0.5 ? sampleElevation(grid, lat, lon) : 0,
    exaggeration: DEFAULT_EXAGGERATION,
    earthRadiusM: EARTH_RADIUS_M,
  });
  onApplied();
}
