/**
 * Every factor pin rendered as one `InstancedMesh` — a single draw call
 * whatever the factor count — scaled by significance and colored by effect.
 *
 * Hit-testing is GPU picking: per-instance IDs render to an offscreen target
 * and one pixel is read back, which stays O(1) in the factor count where
 * raycasting every pin would not.
 *
 * Pins share the field's ramp, so a pin and the region it charges read as the
 * same hue. Positions come from `latLonToVector3`, the one sanctioned lat/lon
 * conversion — no trigonometry on coordinates happens here.
 */
import * as THREE from 'three';
import { latLonToVector3 } from '../lib/geo.js';
import { DEFAULT_FIELD_PARAMS } from './field.js';
import { rampColorMaterial } from './shaders.js';

/** Minimal pin shape — satisfied structurally by both `Factor` and `FieldPin`. */
export interface PinInput {
  id: string;
  lat: number;
  lon: number;
  effect: number;
  significance: number;
  /**
   * How the coordinates were arrived at. A representative pin is drawn
   * THINNER — see REPRESENTATIVE_THICKNESS. Thickness is the only free
   * channel: length already encodes significance and hue encodes effect, so
   * marking placement confidence on either would corrupt a reading the globe
   * already makes.
   */
  locationKind?: 'measured' | 'representative';
}

/**
 * Thickness multiplier for a point we chose rather than one a source measured.
 *
 * Visible without being loud. The pin must not read as measured evidence, but
 * it is still a real factor at a real magnitude, so it stays the same length
 * and colour and only loses substance.
 */
const REPRESENTATIVE_THICKNESS = 0.45;

export interface PinLayerOptions {
  /** Globe radius; pins sit just above it. Match GlobeMesh's radius. */
  radius?: number;
  /** Spike THICKNESS (pyramid base half-width) as a fraction of radius. */
  baseSize?: number;
}

/**
 * Spike LENGTH as a fraction of radius, before significance scaling. The
 * per-instance length is `radius · PIN_LENGTH_FRAC · (0.35 + significance)` so a
 * more significant factor reads as a longer, more prominent spike.
 */
const PIN_LENGTH_FRAC = 0.18;

/** Geometry local +Y — the pyramid axis mapped to the radial (outward) normal. */
const LOCAL_UP = /* @__PURE__ */ new THREE.Vector3(0, 1, 0);

const PICK_VERTEX = /* glsl */ `
in vec3 aPickColor;
out vec3 vPick;

void main() {
  vPick = aPickColor;
  #ifdef USE_INSTANCING
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #endif
}
`;

const PICK_FRAGMENT = /* glsl */ `
precision highp float;
in vec3 vPick;
layout(location = 0) out vec4 fragColor;

void main() {
  fragColor = vec4(vPick, 1.0);
}
`;

/**
 * Cosine of the horizon angle for a camera at `distance` from the centre of a
 * sphere of radius `radius`.
 *
 * A surface point is on the visible near side when its direction, dotted with
 * the camera's direction, exceeds this. Everything below it is around the back
 * of the globe.
 */
/**
 * How far past the geometric horizon a pin still counts as visible.
 *
 * Pins stand off the surface, so one just around the limb still shows its tip.
 * Small enough that the far hemisphere stays excluded.
 */
const HORIZON_BIAS = 0.04;

export function horizonCos(radius: number, distance: number): number {
  if (distance <= radius) return -1; // inside the sphere: nothing is occluded
  return radius / distance;
}

/**
 * Decode a square region of the GPU pick buffer into distinct factor ids,
 * nearest to the centre first.
 *
 * Pure and exported because the ranking is easy to get wrong and has no visual
 * tell: a pin covering many pixels must be ranked by its CLOSEST one, not by
 * whichever pixel the scan happened to reach first, or a large near-miss
 * outranks a small direct hit. The peek still lists the right pins either way —
 * just in the wrong order, which looks fine and is wrong.
 *
 * ROW ORIENTATION DOES NOT MATTER HERE, which is worth stating because
 * `readRenderTargetPixels` returns rows bottom-up and the instinct is to flip
 * them. The region is exactly centred (`sidePx === half * 2 + 1`) and `dy` is
 * only ever used squared, so flipping maps `dy → −dy` and leaves every distance
 * identical. A flip was written first, and removed once a test proved it could
 * not change the output.
 *
 * @param sidePx side length of the square, in device px
 * @param half   centre offset — the pointer sits at (half, half)
 */
export function decodePickRegion(
  buffer: Uint8Array,
  sidePx: number,
  half: number,
  factorIds: readonly string[],
): string[] {
  const best = new Map<string, number>();
  for (let row = 0; row < sidePx; row++) {
    const dy = row - half;
    for (let col = 0; col < sidePx; col++) {
      const o = (row * sidePx + col) * 4;
      const id = buffer[o]! + (buffer[o + 1]! << 8) + (buffer[o + 2]! << 16);
      if (id === 0) continue;
      const factorId = factorIds[id - 1];
      if (factorId === undefined) continue;
      const dx = col - half;
      const d2 = dx * dx + dy * dy;
      const prev = best.get(factorId);
      if (prev === undefined || d2 < prev) best.set(factorId, d2);
    }
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export class PinLayer {
  private readonly radius: number;
  private readonly baseSize: number;
  private readonly container = new THREE.Group();
  private readonly displayMaterial: THREE.MeshBasicMaterial;
  private readonly pickMaterial: THREE.ShaderMaterial;
  private readonly listeners = new Set<() => void>();

  private mesh: THREE.InstancedMesh | null = null;
  private geometry: THREE.ConeGeometry | null = null;
  private pickAttr: THREE.InstancedBufferAttribute | null = null;
  private capacity = 0;
  private factorIds: string[] = [];
  /** The displayed pin set, parallel to factorIds — re-read when state changes. */
  private pins: PinInput[] = [];
  private indexById = new Map<string, number>();
  private highlightedId: string | null = null;
  private selectedId: string | null = null;
  /** Per-pin unit surface direction, parallel to factorIds — for halo hit-testing. */
  private haloVecs: THREE.Vector3[] = [];
  private readonly tmpVec2 = new THREE.Vector3();
  private disposed = false;

  private readonly white = /* @__PURE__ */ new THREE.Color(1, 1, 1);

  // Offscreen picking resources (allocated lazily on first pick).
  private pickTarget: THREE.WebGLRenderTarget | null = null;
  private pickBuffer = new Uint8Array(4);
  /** Side length the pick target is currently sized for. */
  private pickTargetSide = 1;
  private readonly drawSize = new THREE.Vector2();

  // Scratch — reused to avoid per-instance / per-pick allocation.
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();

  constructor(options: PinLayerOptions = {}) {
    this.radius = options.radius ?? 1;
    this.baseSize = options.baseSize ?? 0.015;
    this.container.name = 'pin-layer';

    this.displayMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff, // instanceColor carries the hue and multiplies this.
      toneMapped: false,
      // The spike fades along its axis: opaque at the apex (the surface point),
      // transparent toward the wide outer base — the color attenuates as the
      // pyramid expands. depthWrite off so the faded tail doesn't occlude; the
      // opaque globe still depth-tests away far-side pins.
      transparent: true,
      depthWrite: false,
    });
    // Inject an axis alpha gradient: local `position.y` runs 0 (apex, at the
    // surface) → 1 (base, outward). alpha = (1 - y)^k keeps the tip solid and
    // fades the expanding base. instanceColor (the effect hue) is untouched.
    this.displayMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'varying float vPinAxis;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vPinAxis = position.y;',
        );
      shader.fragmentShader =
        'varying float vPinAxis;\n' +
        shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\n  gl_FragColor.a *= pow(1.0 - clamp(vPinAxis, 0.0, 1.0), 1.4);',
        );
    };
    this.pickMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PICK_VERTEX,
      fragmentShader: PICK_FRAGMENT,
    });
  }

  /** The scene object to add (stable across data updates). */
  get object3D(): THREE.Object3D {
    return this.container;
  }

  /** Number of currently displayed pins. */
  get count(): number {
    return this.factorIds.length;
  }

  /**
   * Rebuild the instanced pins from a factor/pin set. Grows GPU capacity only
   * when the count exceeds it; otherwise the existing buffers are rewritten in
   * place. Non-finite rows are skipped (defense in depth against poison values).
   */
  update(pins: readonly PinInput[]): void {
    if (this.disposed) return;

    const clean = pins.filter(
      (p) =>
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lon) &&
        Number.isFinite(p.effect) &&
        Number.isFinite(p.significance),
    );
    const n = clean.length;

    if (n > this.capacity || this.mesh === null) {
      this.rebuild(Math.max(n, 1));
    }

    const mesh = this.mesh;
    const pickAttr = this.pickAttr;
    if (mesh === null || pickAttr === null) return;

    const pickArray = pickAttr.array as Float32Array;
    this.pins = clean.slice();
    this.factorIds = clean.map((p) => p.id);
    this.indexById = new Map(clean.map((p, i) => [p.id, i]));
    this.haloVecs = new Array(n);

    for (let i = 0; i < n; i++) {
      this.writeInstance(mesh, i);

      // Encode instance id = i + 1 into RGB (0 is reserved for "no hit").
      const id = i + 1;
      pickArray[i * 3] = (id & 0xff) / 255;
      pickArray[i * 3 + 1] = ((id >> 8) & 0xff) / 255;
      pickArray[i * 3 + 2] = ((id >> 16) & 0xff) / 255;
    }

    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    pickAttr.needsUpdate = true;
    mesh.visible = n > 0;

    this.emitNeedsRender();
  }

  /** Marks one pin as hover-highlighted, or clears it with null. */
  setHighlighted(id: string | null): void {
    if (id === this.highlightedId) return;
    const previous = this.highlightedId;
    this.highlightedId = id;
    this.restyle(previous, id);
  }

  /** Marks one pin as selected, or clears it with null. */
  setSelected(id: string | null): void {
    if (id === this.selectedId) return;
    const previous = this.selectedId;
    this.selectedId = id;
    this.restyle(previous, id);
  }

  /** Rewrites only the instances whose state changed, then requests a redraw. */
  private restyle(...ids: (string | null)[]): void {
    const mesh = this.mesh;
    if (mesh === null) return;

    let touched = false;
    for (const id of ids) {
      if (id === null) continue;
      const index = this.indexById.get(id);
      if (index === undefined) continue;
      this.writeInstance(mesh, index);
      touched = true;
    }
    if (!touched) return;

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.emitNeedsRender();
  }

  /**
   * Writes one instance's transform and color, factoring in its hover/selected
   * state. A highlighted or selected pin grows and brightens; selected wins over
   * highlighted. The apex stays seated on the surface — only the outward length
   * and base width scale — so an emphasized pin reads as a taller spike from the
   * same point rather than a marker that has drifted off it.
   */
  private writeInstance(mesh: THREE.InstancedMesh, i: number): void {
    const pin = this.pins[i]!;
    const emphasis = this.emphasisOf(pin.id);

    // Long thin INVERTED PYRAMID: the geometry's apex sits at local origin and
    // the square base extends along +Y. Seat the APEX on the surface point and
    // orient +Y along the OUTWARD radial normal, so the apex points inward and
    // the base widens outward — a slender spike marking the point.
    //
    // The apex seats on the BASE radius: ocean pins touch sea level; where the
    // terrain is raised the apex tip may sit just under the displaced land, but
    // the long body still stands proud. (Per-pin sampling of the displaced
    // surface is deliberately skipped to keep the layer independent of the async
    // elevation grid.)
    latLonToVector3(pin.lat, pin.lon, this.radius, this.tmpPos);
    this.tmpVec.copy(this.tmpPos).normalize();
    this.haloVecs[i] = this.tmpVec.clone(); // unit surface direction for halo picks
    this.tmpQuat.setFromUnitVectors(LOCAL_UP, this.tmpVec);

    const placementMul = pin.locationKind === 'representative' ? REPRESENTATIVE_THICKNESS : 1;
    const thickness = this.baseSize * this.radius * emphasis.thickMul * placementMul;
    const length = this.radius * PIN_LENGTH_FRAC * (0.35 + pin.significance) * emphasis.lengthMul;
    // Non-uniform: thin in X/Z (base half-width), long in Y (spike length).
    this.tmpScale.set(thickness, length, thickness);
    this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
    mesh.setMatrixAt(i, this.tmpMatrix);

    // Hue by effect sign, shared with the field ramp; brightened when emphasized.
    // `rampColorMaterial`, not `rampColor` — a material colour has to be linear
    // or three.js's output encoding renders it ~50% lighter than authored.
    rampColorMaterial(pin.effect, this.tmpColor);
    if (emphasis.whiten > 0) this.tmpColor.lerp(this.white, emphasis.whiten);
    mesh.setColorAt(i, this.tmpColor);
  }

  private emphasisOf(id: string): { lengthMul: number; thickMul: number; whiten: number } {
    if (id === this.selectedId) return { lengthMul: 1.35, thickMul: 1.5, whiten: 0.45 };
    if (id === this.highlightedId) return { lengthMul: 1.18, thickMul: 1.28, whiten: 0.28 };
    return { lengthMul: 1, thickMul: 1, whiten: 0 };
  }

  /**
   * GPU pick. Renders per-instance IDs to a small offscreen target at the
   * pointer and reads it back. `x`/`y` are CSS pixels from the canvas top-left.
   * Returns the factor id under the pointer, or null.
   */
  pick(renderer: THREE.WebGLRenderer, camera: THREE.Camera, x: number, y: number): string | null {
    return this.pickAll(renderer, camera, x, y, 0)[0] ?? null;
  }

  /**
   * Every distinct factor whose pin paints within `radius` CSS px of the
   * pointer, nearest first.
   *
   * WHY A NEIGHBOURHOOD RATHER THAN A RAY. Pins are thin spikes and they cluster
   * — a single pixel resolves whichever one happens to be frontmost, so an
   * overlapping group is unselectable except by luck, and the reader has no way
   * to know the others are there. Reading a square of the ID buffer answers the
   * question actually being asked: what is under the cursor, all of it.
   *
   * A CPU raycast was the alternative and is worse here. An infinitely thin ray
   * only finds pins it geometrically pierces, so two spikes a pixel apart —
   * visually overlapping, which is exactly the reported case — would still
   * return one hit.
   *
   * Cost is one render and one readback either way; only the rectangle grows.
   * Ordering is by distance from the centre, so the frontmost thing under the
   * exact pointer stays first and `pick()` is just this with radius 0.
   */
  pickAll(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    x: number,
    y: number,
    radius: number,
  ): string[] {
    const mesh = this.mesh;
    if (this.disposed || mesh === null || mesh.count === 0) return [];

    this.pickTarget ??= new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: true,
    });

    renderer.getDrawingBufferSize(this.drawSize);
    const dpr = renderer.getPixelRatio();
    // The rectangle is in DEVICE pixels, so a CSS-px radius covers the same
    // apparent area on a retina display as on a plain one.
    const half = Math.max(0, Math.round(radius * dpr));
    const sidePx = half * 2 + 1;
    const px = Math.floor(x * dpr) - half;
    const py = Math.floor(y * dpr) - half;
    if (px + sidePx <= 0 || py + sidePx <= 0 || px >= this.drawSize.x || py >= this.drawSize.y) {
      return [];
    }

    if (this.pickTargetSide !== sidePx) {
      this.pickTarget.dispose();
      this.pickTarget = new THREE.WebGLRenderTarget(sidePx, sidePx, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: true,
      });
      this.pickTargetSide = sidePx;
    }
    const needed = sidePx * sidePx * 4;
    if (this.pickBuffer.length < needed) this.pickBuffer = new Uint8Array(needed);

    // Render only the pointer neighbourhood via a view offset (three's origin is
    // top-left, matching CSS pointer coordinates).
    const persp = camera as THREE.PerspectiveCamera;
    persp.setViewOffset(this.drawSize.x, this.drawSize.y, px, py, sidePx, sidePx);

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(this.tmpColor).clone();
    const prevAlpha = renderer.getClearAlpha();

    mesh.material = this.pickMaterial;
    renderer.setRenderTarget(this.pickTarget);
    renderer.setClearColor(0x000000, 1); // id 0 = background / no hit
    renderer.clear();
    // Render the InstancedMesh alone (it sits at world origin under the group).
    renderer.render(mesh, camera);

    renderer.readRenderTargetPixels(this.pickTarget, 0, 0, sidePx, sidePx, this.pickBuffer);

    // Restore renderer + camera state.
    mesh.material = this.displayMaterial;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    persp.clearViewOffset();

    /*
     * DISCARD ANYTHING AROUND THE BACK. The pass above renders the pin mesh
     * ALONE — no globe — so nothing occludes the far hemisphere and a pin on the
     * other side of the planet paints into the ID buffer exactly like a near
     * one. With a single-pixel pick that was mostly hidden, because a near pin
     * usually won the depth test; reading a neighbourhood surfaced it, and the
     * peek started listing factors from the opposite side of the world.
     *
     * Rendering the globe as a depth occluder would also work and would be more
     * exact for terrain, but it means threading the globe mesh into the pick
     * call. The sphere's horizon is analytic, so a dot product settles it.
     */
    const camPos = this.tmpVec.setFromMatrixPosition(camera.matrixWorld);
    const camDist = camPos.length();
    const visibleIds = new Set<string>();
    if (camDist > 0) {
      const camDir = this.tmpVec2.copy(camPos).divideScalar(camDist);
      // Biased slightly past the horizon: a pin STANDS OFF the surface, so one
      // just beyond the limb still shows its tip and should stay pickable.
      const limit = horizonCos(this.radius, camDist) - HORIZON_BIAS;
      for (let i = 0; i < this.haloVecs.length; i++) {
        const surface = this.haloVecs[i];
        const id = this.factorIds[i];
        if (surface === undefined || id === undefined) continue;
        if (surface.dot(camDir) <= limit) continue;
        visibleIds.add(id);
      }
    }

    return decodePickRegion(this.pickBuffer, sidePx, half, this.factorIds).filter((id) =>
      visibleIds.has(id),
    );
  }

  /**
   * Halo hit-test: given a unit surface direction (from raycasting the globe),
   * return the factor whose painted field halo covers that point — so clicking
   * the painted color selects the same factor as clicking its pin. Only pins
   * within the field's angular support (θ_max) count as "covering" the point;
   * where two halos OVERLAP the CLOSEST pin wins (largest dot = smallest angle).
   * Returns null on bare geography (outside every halo).
   */
  pickHalo(dir: THREE.Vector3): string | null {
    return this.pickHaloAll(dir)[0] ?? null;
  }

  /**
   * EVERY factor whose painted halo covers a surface direction, closest first.
   *
   * The peek needs this as well as the geometry hits, because a pin's claim on
   * the globe is not its spike — it is the area of surface its field tints. Two
   * pins can sit far enough apart that no pixel of their markers overlaps while
   * their halos overlap heavily, and the reader looking at that blended patch is
   * looking at both factors. Reporting only the spikes would answer a narrower
   * question than the one the surface is visibly posing.
   *
   * Same angular support as the field bake (θ_max), so what this reports is
   * exactly what is painted — not an approximation of it.
   */
  pickHaloAll(dir: THREE.Vector3): string[] {
    if (this.disposed) return [];
    const cosMax = Math.cos((DEFAULT_FIELD_PARAMS.thetaMaxDeg * Math.PI) / 180);
    const hits: { id: string; dot: number }[] = [];
    for (let i = 0; i < this.haloVecs.length; i++) {
      const dot = dir.dot(this.haloVecs[i]!);
      // Larger dot = smaller angle = closer to the pin at the halo's centre.
      if (dot <= cosMax) continue;
      const id = this.factorIds[i];
      if (id === undefined) continue;
      hits.push({ id, dot });
    }
    return hits.sort((a, b) => b.dot - a.dot).map((h) => h.id);
  }

  /** Subscribe to redraw requests. Returns an unsubscribe function. */
  onNeedsRender(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private emitNeedsRender(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * (Re)allocate the InstancedMesh and its per-instance attributes at a new
   * capacity. The marker is a 4-sided pyramid (square cone) baked so its APEX is
   * at the local origin and the base sits at local +Y = 1: `ConeGeometry(1, 1, 4)`
   * has its apex at +Y and base at −Y, so we flip it about X (apex → −Y) and lift
   * it by ½ (apex → 0, base → +1). Each instance then orients local +Y along the
   * outward radial and scales it thin-and-long, giving an apex-down spike. The
   * SAME geometry backs the pick pass (aPickColor attribute), so picking matches.
   */
  private rebuild(capacity: number): void {
    // Tear down the previous mesh (geometry/attributes belong to it).
    if (this.mesh !== null) {
      this.container.remove(this.mesh);
      this.mesh.dispose();
    }
    this.geometry?.dispose();

    const geometry = new THREE.ConeGeometry(1, 1, 4);
    geometry.rotateX(Math.PI); // apex +Y → −Y
    geometry.translate(0, 0.5, 0); // apex → origin, base → +Y = 1
    const pickArray = new Float32Array(capacity * 3);
    const pickAttr = new THREE.InstancedBufferAttribute(pickArray, 3);
    pickAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aPickColor', pickAttr);

    const mesh = new THREE.InstancedMesh(geometry, this.displayMaterial, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // pins are small; skip per-instance cull cost.
    mesh.name = 'pins';
    // Materialize instanceColor now so USE_INSTANCING_COLOR is set from frame one.
    mesh.setColorAt(0, this.tmpColor.setRGB(1, 1, 1));

    this.container.add(mesh);
    this.mesh = mesh;
    this.geometry = geometry;
    this.pickAttr = pickAttr;
    this.capacity = capacity;
  }

  /** Release all GPU resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    if (this.mesh !== null) {
      this.container.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    this.displayMaterial.dispose();
    this.pickMaterial.dispose();
    this.pickTarget?.dispose();
    this.pickTarget = null;
  }
}
