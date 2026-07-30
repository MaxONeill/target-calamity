import * as THREE from 'three';
import type { GlobalFactor } from '../../shared/types.js';
import { rampColorMaterial } from './shaders.js';

/** Ring radius as a multiple of the globe radius. */
const RING_RADIUS = 1.42;
/** Radial thickness of the widest possible arc, as a multiple of globe radius. */
const MAX_THICKNESS = 0.075;
/** Thickness floor, so a near-zero-significance factor is still clickable. */
const MIN_THICKNESS = 0.018;
/** Preferred gap between adjacent arcs, in radians. */
const ARC_GAP = 0.035;

/**
 * Ceiling on the share of the ring the gaps may claim in total.
 *
 * A fixed gap does not survive a growing set. `ARC_GAP * n` reaches the whole
 * circle at 179 factors and passes it at 180 — the usable angle goes NEGATIVE,
 * and arcs laid out from a negative budget wrap back over the start of the
 * ring. The live set is already at 74, where gaps take 41% of the circumference
 * and the arcs are competing for what is left, so this is not a distant
 * hypothetical: it is why the smallest arc is a sliver.
 *
 * Capping the total shrinks the gap as the ring fills, which keeps the budget
 * positive at any count and hands the recovered angle back to the arcs.
 */
const MAX_GAP_FRACTION = 0.35;
/** Radial segments per arc. Enough that the curve reads as smooth. */
const ARC_SEGMENTS = 48;

/**
 * Angular floor for an arc, in radians — the tap target.
 *
 * Width encodes influence, and below this it stops doing so. That is a real
 * cost and it is taken deliberately: with the live set, the lightest factor
 * ("Three reviews completed", influence 0.03 against a total of 32.5) swept
 * 0.0034 rad, which is about one pixel of a 500px globe. An arc nobody can hit
 * communicates nothing at all, so a width that slightly overstates it is the
 * lesser inaccuracy. `MIN_THICKNESS` above already makes exactly this trade in
 * the radial direction and for exactly this reason.
 *
 * What survives: ORDER is untouched, and every arc above the floor stays
 * proportional to every other one above it. What is lost: an arc at the floor
 * is no longer readable as a magnitude, only as "below the floor".
 */
const MIN_ARC_SWEEP = 0.045;

/**
 * Ceiling on how much of the ring the floors may claim, as a fraction of the
 * angle each arc would get if all were equal.
 *
 * Without it the floor is unbounded in aggregate: at 74 global factors a flat
 * 0.045 rad reserves 3.33 of the 3.69 usable radians and proportionality is
 * gone — every arc becomes the floor plus a rounding error. Capping the floor
 * at half the equal share means a crowded ring degrades toward equal-width
 * arcs rather than lying about them, and an uncrowded one gets the full target.
 */
const MAX_FLOOR_FRACTION = 0.5;

/**
 * Per-state visuals. Selected takes precedence over highlighted.
 *
 * `thicken` grows the arc's radial thickness about its own mid-radius, which
 * only ADDS coverage on both edges — a pointer already over the arc stays over
 * it. Scaling the mesh instead would translate the annulus radially (it scales
 * about the globe centre, far outside the arc) and slide the arc out from under
 * the pointer, causing hover to oscillate.
 */
const STATE_STYLE = {
  base: { opacity: 0.72, thicken: 1, whiten: 0 },
  highlighted: { opacity: 0.9, thicken: 1.7, whiten: 0.28 },
  selected: { opacity: 1, thicken: 2.3, whiten: 0.45 },
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
  /** Geometry parameters, so thickness can be regrown about the mid-radius. */
  midRadius: number;
  halfThickness: number;
  startAngle: number;
  endAngle: number;
  /** The thickness multiplier currently baked into the geometry. */
  appliedThicken: number;
}

/**
 * A factor's weight on the field: |effect| * significance.
 *
 * The same product the field query ranks by and the accumulation kernel uses as
 * its numerator. Kept identical on purpose — a ring ordered by one measure and
 * a globe baked from another would disagree about which factors matter.
 */
export function fieldInfluence(factor: { effect: number; significance: number }): number {
  return Math.abs(factor.effect) * Math.max(factor.significance, 0);
}

/**
 * Placeless factors in descending field influence.
 *
 * Order and arc width used to disagree: arcs were laid out in the order they
 * arrived (influence-ranked by the field query) but sized by SIGNIFICANCE alone.
 * A high-significance, low-effect factor therefore got a wide arc placed late,
 * so widths did not descend and the ring read as unsorted even though it was
 * ordered. Sorting here rather than trusting the caller also keeps the ring
 * self-consistent whatever order it is handed.
 */
export function orderByInfluence<T extends { id: string; effect: number; significance: number }>(
  factors: readonly T[],
): T[] {
  return [...factors].sort((a, b) => {
    const delta = fieldInfluence(b) - fieldInfluence(a);
    // Stable tiebreak on id, for the same reason the field query has one:
    // without it two equal-influence factors can swap between renders.
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

/**
 * Gap to use between arcs when there are `count` of them. Shrinks below
 * {@link ARC_GAP} once the gaps would otherwise claim more than
 * {@link MAX_GAP_FRACTION} of the ring.
 */
export function arcGap(count: number): number {
  if (count <= 0) return ARC_GAP;
  return Math.min(ARC_GAP, (Math.PI * 2 * MAX_GAP_FRACTION) / count);
}

/**
 * Angular width for each arc, in the order given, summing to `usableAngle`.
 *
 * Proportional to influence, with {@link MIN_ARC_SWEEP} as a floor so the
 * lightest factor is still a tap target. The floor is reserved for every arc
 * first and the REMAINDER is shared out by influence, which keeps the result
 * summing to the budget exactly — scaling proportional widths and then clamping
 * the small ones would overflow the ring by however much the clamping added.
 *
 * @param usableAngle total angle available to arcs, gaps already subtracted
 */
export function arcSweeps(
  factors: readonly { effect: number; significance: number }[],
  usableAngle: number,
): number[] {
  const n = factors.length;
  if (n === 0) return [];
  if (usableAngle <= 0) return factors.map(() => 0);

  const equalShare = usableAngle / n;
  // Never reserve more than the cap: on a crowded ring the floor degrades
  // toward equal widths instead of exceeding the angle that exists.
  const floor = Math.min(MIN_ARC_SWEEP, equalShare * MAX_FLOOR_FRACTION);
  const remainder = usableAngle - floor * n;

  const total = factors.reduce((sum, f) => sum + fieldInfluence(f), 0);
  return factors.map((f) => {
    // Equal shares when every influence is zero, so the ring never collapses.
    const share = total > 0 ? fieldInfluence(f) / total : 1 / n;
    return floor + remainder * share;
  });
}

/**
 * Renders placeless factors as a ring of arcs encircling the globe.
 *
 * A factor with no location cannot honestly be drawn at a point on the surface,
 * but it still carries charge. Arcs run clockwise in descending FIELD INFLUENCE
 * — |effect| * significance, the measure the field bake and the feed also rank
 * by — and each arc's angular width is proportional to that same number above the
 * tap-target floor (see {@link MIN_ARC_SWEEP}), so the
 * ring reads as one global band whose heaviest members are both first and the
 * largest targets. Colour follows the same effect ramp as the pins.
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
      const ordered = orderByInfluence(factors);
      const gap = arcGap(ordered.length);
      const usableAngle = Math.PI * 2 - gap * ordered.length;
      const sweeps = arcSweeps(ordered, usableAngle);

      let cursor = 0;
      ordered.forEach((factor, i) => {
        const sweep = sweeps[i] ?? 0;
        const arc = this.#buildArc(factor, cursor, cursor + sweep);
        this.#arcs.push(arc);
        this.object3D.add(arc.mesh);
        cursor += sweep + gap;
      });
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
    const halfThickness = (this.#globeRadius * thickness) / 2;
    const midRadius = inner + halfThickness;

    // Linear, for the same reason as the pins — see rampColorMaterial.
    const baseColor = rampColorMaterial(factor.effect).clone();
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

    const mesh = new THREE.Mesh(
      this.#makeGeometry(midRadius, halfThickness, startAngle, endAngle, STATE_STYLE.base.thicken),
      material,
    );
    mesh.renderOrder = 3;

    return {
      factorId: factor.id,
      baseColor,
      material,
      mesh,
      midRadius,
      halfThickness,
      startAngle,
      endAngle,
      appliedThicken: STATE_STYLE.base.thicken,
    };
  }

  /**
   * Builds an arc annulus grown symmetrically about its mid-radius. Built in the
   * local XY plane (normal +Z); the group is billboarded onto the camera, so
   * this plane ends up facing the viewer.
   */
  #makeGeometry(
    midRadius: number,
    halfThickness: number,
    startAngle: number,
    endAngle: number,
    thicken: number,
  ): THREE.RingGeometry {
    const grown = halfThickness * thicken;
    return new THREE.RingGeometry(
      midRadius - grown,
      midRadius + grown,
      ARC_SEGMENTS,
      1,
      startAngle,
      endAngle - startAngle,
    );
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

      // Rebuild only when the thickness actually changed. The pointer stays over
      // the arc because growth adds coverage on both radial edges.
      if (style.thicken !== arc.appliedThicken) {
        arc.mesh.geometry.dispose();
        arc.mesh.geometry = this.#makeGeometry(
          arc.midRadius,
          arc.halfThickness,
          arc.startAngle,
          arc.endAngle,
          style.thicken,
        );
        arc.appliedThicken = style.thicken;
      }
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
