/**
 * Coastline landmass overlay (ADR-39). Renders the world's coastlines as thin
 * glowing great-circle vector lines hugging the wireframe globe, so the viewer
 * can read WHERE things are on the otherwise featureless icosphere.
 *
 * Data: `world-atlas`'s `land-110m.json` — a small, low-detail TopoJSON of all
 * land. `topojson-client`'s `mesh()` collapses it into a single GeoJSON
 * MultiLineString of every coastline arc (shared borders de-duplicated), which
 * we project and pack into ONE `THREE.LineSegments` (one geometry, one draw
 * call). 110m is the default; a finer set can be swapped in via `detail`.
 *
 * Projection routes through geo.ts's `latLonToVector3` (ADR-25 bans lat/lon trig
 * anywhere else). Long chords between sparse coastline vertices would cut through
 * the sphere, so each segment is subdivided by great-circle interpolation (slerp
 * of the endpoint unit vectors) whenever its endpoints span more than ~2° of arc.
 * The result is lifted to `radius * 1.002` — just above the wireframe surface —
 * to avoid z-fighting, while `depthTest` lets the solid globe occlude the far
 * side so the back of the Earth does not bleed through.
 *
 * Mirrors GlobeMesh's conventions: `object3D` getter, `setVisible`, idempotent
 * `dispose()`. Static once built — it never changes, so (unlike GlobeMesh) it
 * exposes no `onNeedsRender`; the app paints it once.
 */
import * as THREE from 'three';
import { mesh } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import type { MultiLineString } from 'geojson';
import landTopo110m from 'world-atlas/land-110m.json';
import { latLonToVector3 } from '../lib/geo.js';

/** A single coastline vertex as GeoJSON stores it: [longitude, latitude]. */
export type LonLat = readonly [number, number];

export interface CoastlinesOptions {
  /** Globe radius R (match GlobeMesh's radius). */
  radius: number;
  /** Line colour. Muted glowing cyan/teal reads as "coastline". */
  color?: THREE.ColorRepresentation;
  /** Line opacity (0–1). */
  opacity?: number;
  /**
   * TopoJSON detail set. Only the bundled 110m set is wired by default; the
   * option exists so a finer set can be swapped in without an API change.
   */
  detail?: '110m';
  /**
   * Above-surface lift factor (ADR-42). Defaults to {@link SURFACE_LIFT}. When
   * the globe is displaced by elevation, coastal land rises, so callers pass a
   * slightly larger lift to keep the lines from sinking under raised terrain.
   */
  lift?: number;
}

/** Above-surface lift factor: sits the lines just off the wireframe (no z-fight). */
const SURFACE_LIFT = 1.002;
/** Max arc (degrees) a single chord may span before it is great-circle subdivided. */
const MAX_SEGMENT_DEG = 2;

/**
 * Pure geometry builder (offline, deterministic — unit-testable without WebGL).
 *
 * Projects every coastline vertex to a point on the sphere of radius `radius`
 * and emits a flat `[x,y,z, x,y,z, …]` array of SEGMENT PAIRS suitable for
 * `THREE.LineSegments`. Any chord whose endpoints are more than `maxSegDeg`
 * apart is subdivided into great-circle-interpolated sub-points (slerp of the
 * endpoint unit vectors) so the line hugs the surface instead of chording
 * through it.
 *
 * @param lines   coastline strings, each an ordered list of [lon, lat] vertices
 * @param radius  target sphere radius (the lines are lifted to this value)
 * @param maxSegDeg maximum arc a single emitted segment may span, in degrees
 */
export function buildCoastlineSegments(
  lines: readonly (readonly LonLat[])[],
  radius: number,
  maxSegDeg: number = MAX_SEGMENT_DEG,
): Float32Array {
  const positions: number[] = [];
  // Reused scratch unit vectors (radius 1) for the two chord endpoints.
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();

  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const start = line[i];
      const end = line[i + 1];
      if (!start || !end) continue;
      const [lon0, lat0] = start;
      const [lon1, lat1] = end;

      // Unit-sphere endpoints (radius 1) so the angle-between is a pure arc.
      latLonToVector3(lat0, lon0, 1, a);
      latLonToVector3(lat1, lon1, 1, b);

      const arcDeg = THREE.MathUtils.radToDeg(a.angleTo(b));
      const steps = Math.max(1, Math.ceil(arcDeg / maxSegDeg));

      // Walk the great-circle from a → b in `steps` sub-segments, emitting each
      // consecutive pair. Endpoints are scaled from unit to the lifted radius.
      let prevX = a.x * radius;
      let prevY = a.y * radius;
      let prevZ = a.z * radius;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        // slerp of unit vectors keeps the interpolant ON the sphere.
        p.copy(a).lerp(b, t).normalize();
        const cx = p.x * radius;
        const cy = p.y * radius;
        const cz = p.z * radius;
        positions.push(prevX, prevY, prevZ, cx, cy, cz);
        prevX = cx;
        prevY = cy;
        prevZ = cz;
      }
    }
  }

  return new Float32Array(positions);
}

export class Coastlines {
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;
  private readonly lines: THREE.LineSegments;
  private disposed = false;

  constructor(options: CoastlinesOptions) {
    const radius = options.radius * (options.lift ?? SURFACE_LIFT);
    const color = options.color ?? 0x5fd0d8;
    const opacity = options.opacity ?? 0.55;

    // TopoJSON → GeoJSON MultiLineString of all coastline arcs.
    const topology = landTopo110m as unknown as Topology<{ land: GeometryCollection }>;
    const geo = mesh(topology, topology.objects.land) as MultiLineString;

    const positions = buildCoastlineSegments(
      geo.coordinates as unknown as readonly (readonly LonLat[])[],
      radius,
    );

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    this.material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      // Do not write depth (thin overlay), but DO test it so the opaque globe
      // occludes the far-side coastlines (the back of the Earth stays hidden).
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.name = 'coastlines';
    // Render after the globe so the globe's depth buffer is populated first.
    this.lines.renderOrder = 1;
  }

  /** The scene object to add. */
  get object3D(): THREE.Object3D {
    return this.lines;
  }

  /** Show or hide the overlay. Cheap — flips the object's visibility flag. */
  setVisible(visible: boolean): void {
    this.lines.visible = visible;
  }

  /** Release GPU resources (geometry + material). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
  }
}
