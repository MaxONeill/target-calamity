import * as THREE from 'three';

/**
 * Procedural starfield — the backdrop the globe sits in.
 *
 * A flat black clear colour made the globe read as a render on a page rather
 * than an object in space, and gave the eye nothing to place the planet against.
 * This is deliberately faint: it is depth cueing, not scenery, and the whole
 * point of the recolour it accompanies is that nothing should out-shine the
 * data.
 *
 * NO TEXTURE, NO GEOMETRY PER STAR. Stars are generated in the fragment shader
 * by hashing the view direction into cells, so there is no image to load, no
 * point cloud to allocate, and the field is stable and identical on every
 * client. A `THREE.Points` cloud would have needed thousands of vertices and a
 * seeded RNG to stay deterministic; this is one sphere and a hash.
 *
 * NO ANIMATION, deliberately. The scene is render-on-demand — there is no
 * standing rAF anywhere except the ambient rotation, which cancels itself when
 * paused. A twinkle would mean a permanent animation loop for decoration, so
 * these stars are fixed and only move because the camera does.
 *
 * Depth: written first, never tested, never writing. The sphere is inside the
 * camera's far plane and everything else draws over it.
 */

/** Sphere radius. Comfortably inside the camera far plane (100) and far outside MAX_ZOOM (8). */
const SKY_RADIUS = 60;

/**
 * Cells per axis of the hash grid. Higher = more, smaller stars. At 240 the
 * field reads as sparse pinpoints rather than noise.
 */
const STAR_DENSITY = 240;

/** Fraction of cells that actually contain a star. */
const STAR_THRESHOLD = 0.965;

/** Peak star brightness. Low on purpose — see the module note. */
const STAR_BRIGHTNESS = 0.55;

const vertexShader = /* glsl */ `
out vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
in vec3 vDir;
out vec4 fragColor;

uniform float uDensity;
uniform float uThreshold;
uniform float uBrightness;

/* Deterministic 3D hash. No texture, no seed, identical on every client. */
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 dir = normalize(vDir);

  /*
   * Cell the direction, then place at most one star per cell. Sampling the
   * neighbourhood would let stars straddle cell borders, but at this density
   * the seams are invisible and one lookup keeps the shader cheap.
   */
  vec3 cell = floor(dir * uDensity);
  float h = hash13(cell);
  if (h < uThreshold) discard;

  /* Where in its cell the star sits, so they are not on a visible lattice. */
  vec3 jitter = vec3(hash13(cell + 1.0), hash13(cell + 2.0), hash13(cell + 3.0));
  vec3 starDir = normalize((cell + jitter) / uDensity);

  /* Angular falloff gives a soft point instead of a hard cell-sized square. */
  float d = distance(dir, starDir) * uDensity;
  float point = 1.0 - smoothstep(0.0, 0.9, d);
  if (point <= 0.0) discard;

  /*
   * Magnitude varies so the field has depth rather than reading as uniform
   * speckle. Cubed, so most stars are faint and only a few are bright.
   */
  float mag = hash13(cell + 7.0);
  float intensity = point * uBrightness * mag * mag * mag;

  /*
   * A slight blue/warm spread. Kept very close to white: saturated stars would
   * compete with the ramp, and this palette reserves colour for data.
   */
  float temp = hash13(cell + 11.0);
  vec3 tint = mix(vec3(1.0, 0.94, 0.88), vec3(0.82, 0.88, 1.0), temp);

  fragColor = vec4(tint * intensity, 1.0);
}
`;

export class Starfield {
  readonly object3D: THREE.Object3D;

  readonly #geometry: THREE.SphereGeometry;
  readonly #material: THREE.ShaderMaterial;
  #disposed = false;

  constructor() {
    // Low segment count: the sphere is only a canvas for the shader, and every
    // fragment recomputes its direction anyway.
    this.#geometry = new THREE.SphereGeometry(SKY_RADIUS, 24, 16);
    this.#material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uDensity: { value: STAR_DENSITY },
        uThreshold: { value: STAR_THRESHOLD },
        uBrightness: { value: STAR_BRIGHTNESS },
      },
      side: THREE.BackSide,
      // Never occlude anything, never be occluded: it is the backdrop.
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(this.#geometry, this.#material);
    mesh.name = 'starfield';
    // Drawn before everything else; the globe and pins paint over it.
    mesh.renderOrder = -1;
    // The sphere is far outside any frustum test three.js would do cheaply, and
    // it is always meant to be visible.
    mesh.frustumCulled = false;
    this.object3D = mesh;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#geometry.dispose();
    this.#material.dispose();
  }
}
