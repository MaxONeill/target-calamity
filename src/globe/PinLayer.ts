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
import { rampColor } from './shaders.js';

/** Minimal pin shape — satisfied structurally by both `Factor` and `FieldPin`. */
export interface PinInput {
  id: string;
  lat: number;
  lon: number;
  effect: number;
  significance: number;
}

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
  /** Per-pin unit surface direction, parallel to factorIds — for halo hit-testing. */
  private haloVecs: THREE.Vector3[] = [];
  private disposed = false;

  // Offscreen picking resources (allocated lazily on first pick).
  private pickTarget: THREE.WebGLRenderTarget | null = null;
  private readonly pickBuffer = new Uint8Array(4);
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
    this.factorIds = clean.map((p) => p.id);
    this.haloVecs = new Array(n);

    for (let i = 0; i < n; i++) {
      const pin = clean[i]!;
      // Long thin INVERTED PYRAMID: the geometry's apex sits at local
      // origin and the square base extends along +Y. We seat the APEX on the
      // surface point and orient +Y along the OUTWARD radial normal, so the apex
      // points inward (at the globe centre) and the base widens outward — a
      // slender spike marking the point ( conversion for the surface point).
      //
      // The apex seats on the BASE radius: ocean pins touch sea level; where the
      // terrain is raised the apex tip may sit just under the displaced
      // land, but the long body still stands proud and reads clearly. (Sampling
      // the displaced surface per pin is deliberately skipped to keep the layer
      // independent of the async elevation grid — documented simplification.)
      latLonToVector3(pin.lat, pin.lon, this.radius, this.tmpPos);
      this.tmpVec.copy(this.tmpPos).normalize();
      this.haloVecs[i] = this.tmpVec.clone(); // unit surface direction for halo picks
      this.tmpQuat.setFromUnitVectors(LOCAL_UP, this.tmpVec);
      const thickness = this.baseSize * this.radius;
      const length = this.radius * PIN_LENGTH_FRAC * (0.35 + pin.significance);
      // Non-uniform: thin in X/Z (base half-width), long in Y (spike length).
      this.tmpScale.set(thickness, length, thickness);
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(i, this.tmpMatrix);

      // Hue by effect sign, shared with the field ramp.
      rampColor(pin.effect, this.tmpColor);
      mesh.setColorAt(i, this.tmpColor);

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

  /**
   * GPU pick. Renders per-instance IDs to a 1×1 offscreen target at the pointer
   * and reads the pixel back. `x`/`y` are CSS pixels from the canvas top-left.
   * Returns the factor id under the pointer, or null.
   */
  pick(renderer: THREE.WebGLRenderer, camera: THREE.Camera, x: number, y: number): string | null {
    const mesh = this.mesh;
    if (this.disposed || mesh === null || mesh.count === 0) return null;

    if (this.pickTarget === null) {
      this.pickTarget = new THREE.WebGLRenderTarget(1, 1, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: true,
      });
    }

    renderer.getDrawingBufferSize(this.drawSize);
    const dpr = renderer.getPixelRatio();
    const px = Math.floor(x * dpr);
    const py = Math.floor(y * dpr);
    if (px < 0 || py < 0 || px >= this.drawSize.x || py >= this.drawSize.y) {
      return null;
    }

    // Render only the pointer pixel via a 1×1 view offset (three's origin is
    // top-left, matching CSS pointer coordinates).
    const persp = camera as THREE.PerspectiveCamera;
    persp.setViewOffset(this.drawSize.x, this.drawSize.y, px, py, 1, 1);

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(this.tmpColor).clone();
    const prevAlpha = renderer.getClearAlpha();

    mesh.material = this.pickMaterial;
    renderer.setRenderTarget(this.pickTarget);
    renderer.setClearColor(0x000000, 1); // id 0 = background / no hit
    renderer.clear();
    // Render the InstancedMesh alone (it sits at world origin under the group).
    renderer.render(mesh, camera);

    renderer.readRenderTargetPixels(this.pickTarget, 0, 0, 1, 1, this.pickBuffer);

    // Restore renderer + camera state.
    mesh.material = this.displayMaterial;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    persp.clearViewOffset();

    const b = this.pickBuffer;
    const id = b[0]! + (b[1]! << 8) + (b[2]! << 16);
    if (id === 0) return null;
    const index = id - 1;
    return this.factorIds[index] ?? null;
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
    if (this.disposed) return null;
    const cosMax = Math.cos((DEFAULT_FIELD_PARAMS.thetaMaxDeg * Math.PI) / 180);
    let bestDot = cosMax; // must be at least this close to count as inside a halo
    let bestIdx = -1;
    for (let i = 0; i < this.haloVecs.length; i++) {
      const dot = dir.dot(this.haloVecs[i]!);
      if (dot > bestDot) {
        bestDot = dot;
        bestIdx = i;
      }
    }
    return bestIdx >= 0 ? this.factorIds[bestIdx] ?? null : null;
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
