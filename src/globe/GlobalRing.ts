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

/** Per-state visuals. Selected takes precedence over highlighted. */
const STATE_STYLE = {
  base: { opacity: 0.72, scale: 1, whiten: 0 },
  highlighted: { opacity: 0.9, scale: 1.03, whiten: 0.28 },
  selected: { opacity: 1, scale: 1.06, whiten: 0.45 },
} as const;

type ArcState = keyof typeof STATE_STYLE;

export interface GlobalRingOptions {
  radius: number;
}

interface ArcRecord {
  factorId: string;
  baseColor: THREE.Color;
  material: THREE.MeshBasicMaterial;
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
 * The ring is billboarded: {@link faceCamera} orients it into the screen plane
 * each frame, so it always reads as a full circle around the globe regardless of
 * the camera angle, and an arc's on-screen angle stays stable as the user orbits.
 */
export class GlobalRing {
  readonly object3D: THREE.Group;

  readonly #globeRadius: number;
  #arcs: ArcRecord[] = [];
  #listeners = new Set<() => void>();
  #highlightedId: string | null = null;
  #selectedId: string | null = null;

  readonly #white = new THREE.Color(1, 1, 1);

  constructor(options: GlobalRingOptions) {
    this.#globeRadius = options.radius;
    this.object3D = new THREE.Group();
    this.object3D.renderOrder = 3;
  }

  /** Subscribes to redraw requests. Returns an unsubscribe function. */
  onNeedsRender(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Orients the ring into the camera's screen plane. Called every rendered
   * frame, so the ring is always a face-on circle. Cheap enough to run
   * unconditionally: it copies one quaternion.
   */
  faceCamera(camera: THREE.Camera): void {
    this.object3D.quaternion.copy(camera.quaternion);
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

        const arc = this.#buildArc(factor, cursor, cursor + sweep);
        this.#arcs.push(arc);
        this.object3D.add(arc.mesh);
        cursor += sweep + ARC_GAP;
      }
    }

    // A rebuild drops the meshes the ids pointed at; re-apply so a selection that
    // survives a data refresh keeps its state.
    this.#refreshStates();
    this.#notify();
  }

  /** Marks one arc as hover-highlighted, or clears it with null. */
  setHighlighted(id: string | null): void {
    if (id === this.#highlightedId) return;
    this.#highlightedId = id;
    this.#refreshStates();
    this.#notify();
  }

  /** Marks one arc as selected, or clears it with null. */
  setSelected(id: string | null): void {
    if (id === this.#selectedId) return;
    this.#selectedId = id;
    this.#refreshStates();
    this.#notify();
  }

  /**
   * Resolves a ray to a factor id.
   *
   * @returns the id of the arc under the ray, or null when it misses the ring.
   */
  pick(raycaster: THREE.Raycaster): string | null {
    if (this.#arcs.length === 0) return null;
    // The billboard orientation is set at render time; make the world matrices
    // current so a pick between frames still hits the right arc.
    this.object3D.updateMatrixWorld(true);

    const hit = raycaster.intersectObjects(
      this.#arcs.map((a) => a.mesh),
      false,
    )[0];
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

    // Built in the local XY plane (normal +Z). The group is billboarded onto the
    // camera, so this plane ends up facing the viewer.
    const geometry = new THREE.RingGeometry(
      inner,
      outer,
      ARC_SEGMENTS,
      1,
      startAngle,
      endAngle - startAngle,
    );

    const baseColor = rampColor(factor.effect).clone();
    const material = new THREE.MeshBasicMaterial({
      color: baseColor.clone(),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: STATE_STYLE.base.opacity,
      // The ring never overlaps the globe on screen (its radius exceeds the
      // globe's), so it can draw on top without depth-testing against terrain.
      depthTest: false,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 3;

    return { factorId: factor.id, baseColor, material, mesh };
  }

  #stateOf(id: string): ArcState {
    if (id === this.#selectedId) return 'selected';
    if (id === this.#highlightedId) return 'highlighted';
    return 'base';
  }

  #refreshStates(): void {
    for (const arc of this.#arcs) {
      const style = STATE_STYLE[this.#stateOf(arc.factorId)];
      arc.material.opacity = style.opacity;
      arc.material.color.copy(arc.baseColor).lerp(this.#white, style.whiten);
      arc.mesh.scale.setScalar(style.scale);
    }
  }

  #disposeArcs(): void {
    for (const arc of this.#arcs) {
      this.object3D.remove(arc.mesh);
      arc.mesh.geometry.dispose();
      arc.material.dispose();
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
