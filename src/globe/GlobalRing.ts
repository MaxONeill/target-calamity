import * as THREE from 'three';
import type { GlobalFactor } from '../../shared/types.js';
import { rampColor } from './shaders.js';

/** Ring radius as a multiple of the globe radius. */
const RING_RADIUS = 1.42;
/** Radial thickness of the widest possible arc, as a multiple of globe radius. */
const MAX_THICKNESS = 0.075;
/** Thickness floor, so a near-zero-significance factor is still clickable. */
const MIN_THICKNESS = 0.018;
/** Gap between adjacent arcs, in radians. */
const ARC_GAP = 0.035;
/** Radial segments per arc. Enough that the curve reads as smooth. */
const ARC_SEGMENTS = 48;

export interface GlobalRingOptions {
  radius: number;
}

interface ArcRecord {
  factorId: string;
  startAngle: number;
  endAngle: number;
  mesh: THREE.Mesh;
}

/**
 * Renders placeless factors as a ring of arcs encircling the globe.
 *
 * A factor with no location cannot honestly be drawn at a point on the surface,
 * but it still carries charge. Each arc's angular width is proportional to its
 * significance and its color follows the same effect ramp as the pins, so the
 * ring reads as one global band whose heaviest members are the largest targets.
 *
 * The ring lies in the equatorial plane and does not rotate with the camera, so
 * an arc's position is stable across a session.
 */
export class GlobalRing {
  readonly object3D: THREE.Group;

  readonly #globeRadius: number;
  #arcs: ArcRecord[] = [];
  #listeners = new Set<() => void>();

  constructor(options: GlobalRingOptions) {
    this.#globeRadius = options.radius;
    this.object3D = new THREE.Group();
    this.object3D.renderOrder = 2;
  }

  /** Subscribes to redraw requests. Returns an unsubscribe function. */
  onNeedsRender(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  update(factors: readonly GlobalFactor[]): void {
    this.#disposeArcs();

    if (factors.length > 0) {
      const totalSignificance = factors.reduce((sum, f) => sum + Math.max(f.significance, 0), 0);
      const usableAngle = Math.PI * 2 - ARC_GAP * factors.length;

      let cursor = 0;
      for (const factor of factors) {
        // Equal shares when every significance is zero, so the ring never
        // collapses to nothing and stays clickable.
        const share =
          totalSignificance > 0
            ? Math.max(factor.significance, 0) / totalSignificance
            : 1 / factors.length;
        const sweep = usableAngle * share;

        this.#arcs.push(this.#buildArc(factor, cursor, cursor + sweep));
        cursor += sweep + ARC_GAP;
      }
    }

    for (const arc of this.#arcs) this.object3D.add(arc.mesh);
    this.#notify();
  }

  /**
   * Resolves a ray to a factor id.
   *
   * @returns the id of the arc under the ray, or null when it misses the ring.
   */
  pick(raycaster: THREE.Raycaster): string | null {
    const meshes = this.#arcs.map((a) => a.mesh);
    if (meshes.length === 0) return null;

    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;

    return this.#arcs.find((a) => a.mesh === hit.object)?.factorId ?? null;
  }

  setVisible(visible: boolean): void {
    this.object3D.visible = visible;
    this.#notify();
  }

  dispose(): void {
    this.#disposeArcs();
    this.#listeners.clear();
  }

  #buildArc(factor: GlobalFactor, startAngle: number, endAngle: number): ArcRecord {
    const thickness =
      MIN_THICKNESS + (MAX_THICKNESS - MIN_THICKNESS) * clamp01(factor.significance);
    const inner = this.#globeRadius * RING_RADIUS;
    const outer = inner + this.#globeRadius * thickness;

    const geometry = new THREE.RingGeometry(
      inner,
      outer,
      ARC_SEGMENTS,
      1,
      startAngle,
      endAngle - startAngle,
    );
    // RingGeometry is built in the XY plane; lay it flat into the equatorial one.
    geometry.rotateX(-Math.PI / 2);

    const material = new THREE.MeshBasicMaterial({
      color: rampColor(factor.effect),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;

    return { factorId: factor.id, startAngle, endAngle, mesh };
  }

  #disposeArcs(): void {
    for (const arc of this.#arcs) {
      this.object3D.remove(arc.mesh);
      arc.mesh.geometry.dispose();
      (arc.mesh.material as THREE.Material).dispose();
    }
    this.#arcs = [];
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
