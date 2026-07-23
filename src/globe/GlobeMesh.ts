/**
 * The wireframe globe. Owns the icosphere
 * geometry, the field `ShaderMaterial`, and the `FieldBaker`, and exposes a
 * render-on-demand signal so the app can avoid an unconditional rAF loop.
 *
 * `IcosahedronGeometry(R, detail)`, not `SphereGeometry`.
 * A UV sphere crowds vertices at the poles — uneven wireframe density and
 * non-uniform field sampling. The icosphere distributes near-uniformly.
 *
 * the material samples a baked two-field texture
 * instead of looping over factors per fragment. `update()` rebakes that texture;
 * the fragment shader stays O(1) with no MAX_FACTORS cap.
 *
 * the globe reports when it actually needs a redraw
 * (`onNeedsRender`) rather than assuming the app repaints every frame. Between
 * data changes the field is static, so nothing here forces a repaint.
 *
 * `update()` takes the `/api/field` pin set only. It
 * must be called on receipt of a new field response, never on camera motion or
 * feed pagination — the field is camera-invariant by construction.
 *
 * : the fragment shader now renders a geographic base (ocean/land) from a
 * land-mask texture and blends the field on top; GlobeMesh wires the mask.
 *
 * : the icosphere is DISPLACED on the CPU by real elevation. Each vertex
 * is offset outward along its unit normal by `max(0, meters)/EARTH_RADIUS ·
 * exaggeration · radius` — ocean/bathymetry (meters ≤ 0) stays FLAT at the base
 * radius, only land rises. Displacement can be (re)applied after construction
 * once the real elevation grid loads; before that a land-relief sampler keeps
 * continents in relief offline. The wireframe overlay and vertex normals are
 * rebuilt from the displaced positions.
 */
import * as THREE from 'three';
import { FieldBaker } from './bakeField.js';
import { DEFAULT_FIELD_PARAMS, type FieldInputPin, type FieldParams } from './field.js';
import { vector3ToLatLon } from '../lib/geo.js';
import {
  createGlobeUniforms,
  fragmentShader,
  lineFragmentShader,
  vertexShader,
  LINE_BOOST,
  type GlobeUniforms,
} from './shaders.js';

/** Mean Earth radius in meters — the denominator for the meters→radius fraction. */
export const EARTH_RADIUS_M = 6_371_000;
/**
 * Default vertical exaggeration. Real relief is ~0.1% of Earth's radius,
 * invisible on a globe — at 30× a 6 km peak rose only ~2.3% of the radius (barely
 * readable). 120× lifts the highest terrain ~11% so continents show clear relief.
 * Tunable knob: raise for more dramatic mountains, lower for a subtler surface.
 */
export const DEFAULT_EXAGGERATION = 120;

/** An elevation source for the mesh displacement. */
export interface GlobeElevation {
  /**
   * Elevation in METERS at a geographic point. May return negative
   * (bathymetry) values — they are floored to 0 (sea level) before displacement,
   * so only land rises.
   */
  sampleMeters(latDeg: number, lonDeg: number): number;
  /** Vertical exaggeration multiplier (default {@link DEFAULT_EXAGGERATION}). */
  exaggeration?: number;
  /** Earth radius in meters for the meters→radius-fraction map (default {@link EARTH_RADIUS_M}). */
  earthRadiusM?: number;
}

export interface GlobeMeshOptions {
  /** Globe radius R.  ties the orbit rig's MIN_ZOOM = 1.15·R to this. */
  radius?: number;
  /** Icosphere subdivision level. Higher = finer wireframe. */
  detail?: number;
  /** Kernel parameters for the bake. */
  fieldParams?: FieldParams;
  /** Land-mask texture for the  geographic base coloring. */
  landMaskTexture?: THREE.Texture;
  /** Elevation source for the  displacement (optional; land-relief fallback otherwise). */
  elevation?: GlobeElevation;
}

export class GlobeMesh {
  readonly radius: number;

  private readonly geometry: THREE.IcosahedronGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: GlobeUniforms;
  private readonly mesh: THREE.Mesh;
  private wireGeometry: THREE.WireframeGeometry;
  private readonly wireMaterial: THREE.ShaderMaterial;
  private readonly wire: THREE.LineSegments;
  private readonly baker: FieldBaker;
  /** Undisplaced (base-sphere) vertex positions — the origin for every re-displace. */
  private readonly basePositions: Float32Array;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(options: GlobeMeshOptions = {}) {
    this.radius = options.radius ?? 1;
    const detail = options.detail ?? 6;
    const params = options.fieldParams ?? DEFAULT_FIELD_PARAMS;

    this.baker = new FieldBaker(params);
    this.uniforms = createGlobeUniforms();
    this.uniforms.uField.value = this.baker.texture;
    // : the base radius is the denominator of the vertex shader's
    // elevation fraction `(|position| − R) / R`, which drives the land ramp.
    this.uniforms.uRadius.value = this.radius;
    if (options.landMaskTexture) this.uniforms.uLandMask.value = options.landMaskTexture;

    this.geometry = new THREE.IcosahedronGeometry(this.radius, detail);
    // Snapshot the pristine sphere positions so displacement always starts fresh.
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.basePositions = new Float32Array(posAttr.array as ArrayLike<number>);

    this.material = new THREE.ShaderMaterial({
      // GLSL3/WebGL2: dynamic-bound-free, and gives us `texture()` +
      // explicit fragment output.
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader,
      fragmentShader,
      // Shade the FACES with the geographic base + chromatic field. A
      // solid surface also writes continuous depth, which cleanly occludes the
      // far-side coastlines.
      wireframe: false,
      transparent: false,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'globe-field';

    // Wireframe overlay: the etch reuses the SAME geo+field color as the
    // faces (shared uniform objects, so field/mask/camera updates propagate) via
    // a ShaderMaterial, boosted by LINE_BOOST so the structure reads as a BOLDER
    // version of the underlying surface — blue lines over ocean, green over land,
    // tinting toward the Calamity/Humanity color where the field has coverage.
    // Drawn after the faces, no depth write so it doesn't fight the field;
    // depthTest keeps the far side occluded.
    this.wireGeometry = new THREE.WireframeGeometry(this.geometry);
    this.wireMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      // Spread shares the SAME IUniform value objects as the face material.
      uniforms: {
        ...(this.uniforms as unknown as Record<string, THREE.IUniform>),
        uLineBoost: { value: LINE_BOOST },
      },
      vertexShader,
      fragmentShader: lineFragmentShader,
      transparent: false,
      depthWrite: false,
      depthTest: true,
    });
    this.wire = new THREE.LineSegments(this.wireGeometry, this.wireMaterial);
    this.wire.name = 'globe-wire';
    this.wire.renderOrder = 1;
    this.mesh.add(this.wire);

    // Apply the initial displacement (fallback or real) if one was supplied.
    if (options.elevation) this.displace(options.elevation);
    // The field texture is empty until the first bake — the whole globe reads as
    // pure geography (W = 0 everywhere), which is the correct "no data yet" state.
  }

  /** The scene object to add. */
  get object3D(): THREE.Object3D {
    return this.mesh;
  }

  /**
   * Rebake the chromatic field from a new `/api/field` pin set and
   * request a redraw. This is the ONLY method that mutates shader field input.
   */
  update(pins: readonly FieldInputPin[]): void {
    if (this.disposed) return;
    this.baker.bake(pins);
    this.emitNeedsRender();
  }

  /**
   * (Re)displace the icosphere from an elevation source. Called at
   * construction with the land-relief fallback, then again once the real grid
   * loads. Rebuilds the wireframe overlay + vertex normals and requests a redraw.
   */
  setElevation(elevation: GlobeElevation): void {
    if (this.disposed) return;
    this.displace(elevation);
    this.emitNeedsRender();
  }

  /** Displace every vertex outward by its floored elevation. Rebuilds wire + normals. */
  private displace(elevation: GlobeElevation): void {
    const exaggeration = elevation.exaggeration ?? DEFAULT_EXAGGERATION;
    const earthRadiusM = elevation.earthRadiusM ?? EARTH_RADIUS_M;
    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const base = this.basePositions;
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      const bx = base[i * 3]!;
      const by = base[i * 3 + 1]!;
      const bz = base[i * 3 + 2]!;
      v.set(bx, by, bz);
      const len = v.length() || 1;
      const [lat, lon] = vector3ToLatLon(v);
      let meters = elevation.sampleMeters(lat, lon);
      if (!Number.isFinite(meters)) meters = 0;
      // FLOOR AT SEA LEVEL: ocean/bathymetry sits flat at the base radius; only
      // land rises. Same rule governs the land-relief fallback (land up, ocean 0).
      meters = Math.max(0, meters);
      const offset = (meters / earthRadiusM) * exaggeration * this.radius;
      const scale = (len + offset) / len;
      posAttr.setXYZ(i, bx * scale, by * scale, bz * scale);
    }
    posAttr.needsUpdate = true;
    this.geometry.computeVertexNormals();

    // Rebuild the wireframe overlay from the displaced positions so the etch
    // follows the terrain rather than the pristine sphere.
    const nextWire = new THREE.WireframeGeometry(this.geometry);
    this.wire.geometry = nextWire;
    this.wireGeometry.dispose();
    this.wireGeometry = nextWire;
  }

  /**
   * Sync the camera position uniform used by the fragment depth cue. Call once
   * per render, before drawing. Does NOT itself request a redraw — camera
   * motion is already driven by whoever moves the camera (e.g. OrbitControls).
   */
  syncCamera(camera: THREE.Camera): void {
    this.uniforms.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
  }

  /**
   * Subscribe to redraw requests ( render-on-demand). Returns an
   * unsubscribe function. The globe fires this when its field is rebaked.
   */
  onNeedsRender(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  private emitNeedsRender(): void {
    for (const cb of this.listeners) cb();
  }

  /** Release GPU resources (geometry, material, field texture). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.geometry.dispose();
    this.material.dispose();
    this.wireGeometry.dispose();
    this.wireMaterial.dispose();
    this.baker.dispose();
  }
}
