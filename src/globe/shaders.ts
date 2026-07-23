/**
 * GLSL ES 3.00 shaders for the globe, plus the shared color model.
 *
 * Written for WebGL2 via a three.js `ShaderMaterial` with
 * `glslVersion: THREE.GLSL3`, which prepends `#version 300 es` and the standard
 * three.js uniforms; this module declares its own varyings and fragment output.
 *
 * The fragment shader does not loop over factors. It samples the pre-baked
 * two-channel field texture (R = net polarity P, G = evidence density W) and
 * applies the three-state color model, gating hue on W so that absence of data
 * and contested equilibrium — which both sit at P ≈ 0 — never render alike:
 *   W < W_min            → INERT GREY  (off-ramp unlit baseline ~#3A3A42)
 *   W >= W_min           → hue = ramp(P), crimson(−1)–purple(0)–blue(+1),
 *                          saturation = smoothstep(W_min, W_full, W)
 * so genuine contested equilibrium is vivid purple and absence-of-data is grey.
 */
import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Color model (shared with PinLayer)                                         */
/* -------------------------------------------------------------------------- */

/** Ramp anchor: pure Calamity (P = −1). Luminous crimson. */
export const COLOR_CRIMSON: [number, number, number] = [0.85, 0.16, 0.28];
/** Ramp midpoint (P = 0): deep purple — contested equilibrium (only behind the W gate). */
export const COLOR_PURPLE: [number, number, number] = [0.42, 0.17, 0.55];
/** Ramp anchor: pure Humanity (P = +1). Electric blue. */
export const COLOR_BLUE: [number, number, number] = [0.18, 0.62, 0.98];
/** Off-ramp baseline for W < W_min: inert grey ≈ #3A3A42 (absence of data, not a finding). */
export const COLOR_INERT_GREY: [number, number, number] = [0.227, 0.227, 0.259];

/**
 *  geographic base colors. Ocean is a deep, desaturated blue (#123a63) —
 * deliberately darker/greyer than the field's Humanity blue (#2e9ef7) so a blue
 * ocean can never be mistaken for a strong-Humanity reading. Land is a muted
 * green (#2f6b3a) that reads as terrain under the cyan coastline lines.
 */
export const COLOR_OCEAN: [number, number, number] = [0.071, 0.227, 0.388];
export const COLOR_LAND: [number, number, number] = [0.184, 0.42, 0.227];

/**
 *  elevation ramp — high ground. A muted, desaturated brown for exposed
 * rock/soil above the vegetated lowlands, sitting between {@link COLOR_LAND} and
 * {@link COLOR_ICE} on the green→brown→white climb.
 */
export const COLOR_MOUNTAIN: [number, number, number] = [0.42, 0.33, 0.22];

/**
 *  elevation-ramp thresholds, in units of the ELEVATION FRACTION
 * `e = (|position| − R) / R` — i.e. how far a displaced vertex sits above the
 * base sphere, as a fraction of the globe radius. Land is shaded
 * green → brown over [BROWN_START, BROWN_FULL] and then brown → ice over
 * [SNOW_START, SNOW_FULL].
 *
 * CALIBRATION IS TIED TO {@link DEFAULT_EXAGGERATION} (120) — GlobeMesh maps
 * `offset = (meters / EARTH_RADIUS_M) · exaggeration · R`, so with a grid max of
 * ~6379 m the fraction spans ~0 → ~0.12. Change the exaggeration and these four
 * numbers must be rescaled by the same factor or the whole planet goes white
 * (or stays green). Ocean is unaffected: displacement is floored at sea level,
 * so e = 0 there and the ocean color is chosen by the land mask regardless.
 */
export const ELEV_BROWN_START = 0.012;
export const ELEV_BROWN_FULL = 0.03;
export const ELEV_SNOW_START = 0.032;
export const ELEV_SNOW_FULL = 0.07;

/**
 *  polar ice. Land fades to near-white toward the poles over a snow line
 * (|sin lat| from SNOW_START → SNOW_FULL ≈ lat 55° → 68°), so polar landmasses —
 * Antarctica, Greenland, the Arctic fringe — read as ice/snow rather than green.
 * Tunable: lower SNOW_START to push the snow line toward the equator.
 */
export const COLOR_ICE: [number, number, number] = [0.9, 0.93, 0.97];
export const SNOW_START = 0.82; // |sin lat| ≈ 55°
export const SNOW_FULL = 0.93; // |sin lat| ≈ 68°

/**
 *  cap on how far the field can tint over the geographic base (0..1).
 * Lowered 0.85 → 0.6 as part of the pin-color attenuation: even where coverage
 * W is high, the pin color only TINTS the geography rather than fully replacing
 * it, so a green/blue Earth stays visible under a contained pin halo. The W gate
 * still keeps no-data areas as pure geography. Tunable knob.
 */
export const FIELD_STRENGTH_CAP = 0.6;

/**
 * Radial attenuation window. The field kernel `W ∝ 1/dᵏ` (k=2.5, eps=0.05)
 * has a huge dynamic range — across one 8° halo `W` runs ~120 at the rim to ~1600
 * at the pin — so a `smoothstep(W_MIN, W_FULL, W)` saturates and the halo reads as
 * a flat disc. Instead the tint is mapped in LOG space between these two densities
 * so the color fades smoothly from the pin centre out to the rim — it attenuates
 * as it expands. Tunable knobs:
 *   - raise `HALO_RIM` to pull the fade tighter to the pin (rim goes fainter);
 *   - lower it to let color carry further out to the rim;
 *   - `HALO_PEAK` is the density at which the tint reaches full strength (centre).
 */
export const HALO_RIM = 100;
export const HALO_PEAK = 1200;

/**
 * Evidence-gate uniforms. Units of Σ S/d²; re-tune if the effect or
 * significance domains change. `W_MIN` is the grey↔colored threshold; `W_FULL`
 * the density at which saturation reaches 1.
 */
export const W_MIN = 0.05;
export const W_FULL = 1.0;

/**
 * The ±0.5 ramp thresholds from : |P| ≥ RAMP_EDGE saturates to a pure
 * endpoint; between 0 and RAMP_EDGE it blends from purple.
 */
export const RAMP_EDGE = 0.5;

function toColor(rgb: readonly [number, number, number]): THREE.Color {
  return new THREE.Color(rgb[0], rgb[1], rgb[2]);
}

/** three.js `Color` builders for JS-side consumers (pins, legends). */
export const COLORS = {
  crimson: () => toColor(COLOR_CRIMSON),
  purple: () => toColor(COLOR_PURPLE),
  blue: () => toColor(COLOR_BLUE),
  inertGrey: () => toColor(COLOR_INERT_GREY),
};

/**
 * CPU-side twin of the GLSL `ramp()` — crimson(−1)–purple(0)–blue(+1) with the
 * ±0.5 saturation edge. Used to color pins by their own `effect` so a pin and
 * the field it sits in read as the same hue ( pins share 's ramp).
 */
export function rampColor(p: number, out: THREE.Color = new THREE.Color()): THREE.Color {
  const purple = COLOR_PURPLE;
  if (p < 0) {
    const t = Math.min(-p / RAMP_EDGE, 1);
    return out.setRGB(
      lerp(purple[0], COLOR_CRIMSON[0], t),
      lerp(purple[1], COLOR_CRIMSON[1], t),
      lerp(purple[2], COLOR_CRIMSON[2], t),
    );
  }
  const t = Math.min(p / RAMP_EDGE, 1);
  return out.setRGB(
    lerp(purple[0], COLOR_BLUE[0], t),
    lerp(purple[1], COLOR_BLUE[1], t),
    lerp(purple[2], COLOR_BLUE[2], t),
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* -------------------------------------------------------------------------- */
/* GLSL ES 3.00                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Vertex shader. Passes the object-space unit direction (the globe is centered
 * at the origin, so `normalize(position)` IS the surface direction) and the
 * world-space position (for the view-facing depth cue). No lat/lon ever enters
 * GLSL: the field is sampled by direction, not by geographic angle.
 *
 * The globe's vertices are CPU-displaced by elevation, so a vertex's
 * RADIAL LENGTH already encodes its height. `vElev = (|position| − R) / R` hands
 * that to the fragment stage as the elevation fraction driving the
 * green→brown→white land ramp — no extra attribute or texture needed. This same
 * vertex shader feeds BOTH the face and the wireframe line materials, so the
 * wire etch gets the identical ramp.
 */
export const vertexShader = /* glsl */ `
uniform float uRadius;

out vec3 vDir;
out vec3 vWorldPos;
out float vElev;

void main() {
  vDir = normalize(position);
  vElev = (length(position) - uRadius) / max(uRadius, 1e-6);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Emphasis boost for the wireframe overlay. The wire lines reuse the
 * SAME geo+field color as the faces, multiplied by this so they read as a bolder
 * version of whatever the underlying face shows (blue over ocean, green over
 * land, tinting toward the field color where there is coverage). Tunable knob.
 */
export const LINE_BOOST = 1.45;

/**
 * Shared GLSL chunk. Holds the uniform block, the crimson–purple–blue
 * `ramp()`, the geographic-base + field BLEND `geoFieldColor(dir)`, and the
 * view-facing `depthCue()`. Both the FACE fragment shader and the WIREFRAME line
 * fragment shader `#include` this so they compute the exact same color from the
 * same (u, v) — the lines are literally a boosted copy of the face color.
 */
const geoFieldChunk = /* glsl */ `
precision highp float;

uniform sampler2D uField;   // R = net polarity P, G = evidence density W
uniform sampler2D uLandMask; // R = land fraction (1 = land, 0 = ocean)
uniform float uWMin;
uniform float uWFull;
uniform float uRampEdge;
uniform float uFieldCap;    //  cap on field tint over the geographic base
uniform vec3 uCrimson;
uniform vec3 uPurple;
uniform vec3 uBlue;
uniform vec3 uOceanColor;   //  geographic base — ocean
uniform vec3 uLandColor;    //  geographic base — land (low ground)
uniform vec3 uMountainColor; //  elevation ramp — high ground (brown)
uniform vec3 uCameraPos;    // world-space camera position for the depth cue

const float PI = 3.141592653589793;
const vec3 ICE = vec3(${COLOR_ICE.map((c) => c.toFixed(3)).join(', ')}); //  polar snow/ice

// crimson(P=-1) — purple(P=0) — electric blue(P=+1), saturating at |P| = uRampEdge.
vec3 ramp(float p) {
  if (p < 0.0) {
    return mix(uPurple, uCrimson, clamp(-p / uRampEdge, 0.0, 1.0));
  }
  return mix(uPurple, uBlue, clamp(p / uRampEdge, 0.0, 1.0));
}

//  geographic base + chromatic field blend at a surface direction (before
// the depth cue). Direction → equirectangular (u, v): inverse of field.ts
// texelToLatLon / geo.ts vector3ToLatLon (lon = atan2(-z, x), lat = asin(y)),
// then u = (lon+π)/2π, v = (lat+π/2)/π — the baker's row-0-is-south layout, and
// the same convention the land mask is drawn in, so land lines up with coasts.
vec3 geoFieldColor(vec3 dir, float e) {
  float lon = atan(-dir.z, dir.x);
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);

  vec2 field = texture(uField, uv).rg;
  float P = field.r;
  float W = field.g;

  float landFrac = texture(uLandMask, uv).r;

  //  ELEVATION RAMP: e is the displaced vertex's height above the base
  // sphere as a fraction of the radius. Low land is green, mid elevations fade to
  // muted brown, peaks go to snow/ice — so relief reads as terrain rather than a
  // uniformly green shell. Thresholds are calibrated against DEFAULT_EXAGGERATION.
  vec3 landCol = mix(
    uLandColor,
    uMountainColor,
    smoothstep(${ELEV_BROWN_START.toFixed(4)}, ${ELEV_BROWN_FULL.toFixed(4)}, e)
  );
  landCol = mix(
    landCol,
    ICE,
    smoothstep(${ELEV_SNOW_START.toFixed(4)}, ${ELEV_SNOW_FULL.toFixed(4)}, e)
  );

  // Polar ice, applied AFTER the elevation ramp: land fades to WHITE
  // toward the poles over a snow line, so polar landmasses (Antarctica,
  // Greenland, the Arctic fringe) read as ice regardless of how low they sit.
  float snow = smoothstep(${SNOW_START.toFixed(3)}, ${SNOW_FULL.toFixed(3)}, abs(dir.y));
  landCol = mix(landCol, ICE, snow);
  vec3 geoBase = mix(uOceanColor, landCol, clamp(landFrac, 0.0, 1.0));

  // Equirect POLE fix: at |lat|→90° the longitude collapses to a point, so the
  // near-pole texture band (which has real land/ocean variation) smears into a
  // warped ring across the cap. Over a tight polar cap, fade the geographic base
  // to each pole's true character — N = Arctic Ocean, S = Antarctic ICE — keyed
  // off the real up axis (dir.y = sin lat), so the caps read as clean discs. The
  // field tint below still applies, so a polar factor's halo still shows.
  float polar = smoothstep(0.972, 0.9997, abs(dir.y)); // ~lat 76.5°→88.6°
  geoBase = mix(geoBase, dir.y > 0.0 ? uOceanColor : ICE, polar);

  vec3 fieldColor = ramp(P);
  // Radial attenuation: W ∝ 1/dᵏ spans ~120 (rim) to ~1600 (pin) across
  // one halo, so a plain smoothstep(W) saturates into a flat disc. Map W in LOG
  // space between the rim and peak densities so the tint fades smoothly from the
  // pin centre outward — it attenuates as it expands. Below uWMin there is no
  // factor in support, so the surface stays pure geography (the true no-data gate).
  float lw = log(max(W, 1e-6));
  float t = clamp((lw - log(${HALO_RIM.toFixed(1)})) / (log(${HALO_PEAK.toFixed(1)}) - log(${HALO_RIM.toFixed(1)})), 0.0, 1.0);
  float fieldStrength = smoothstep(0.0, 1.0, t) * uFieldCap * step(uWMin, W);
  return mix(geoBase, fieldColor, fieldStrength);
}

// View-facing depth cue: dim the far side of the globe so the near hemisphere
// reads clearly. Not lighting — the data hue is preserved.
float depthCue(vec3 dir, vec3 worldPos) {
  vec3 viewDir = normalize(uCameraPos - worldPos);
  float facing = dot(dir, viewDir);
  return mix(0.28, 1.0, smoothstep(-0.35, 0.25, facing));
}
`;

/**
 * FACE fragment shader. Renders the geographic base with the
 * chromatic field blended on top, then applies the depth cue. Opaque.
 */
export const fragmentShader = /* glsl */ `
${geoFieldChunk}

in vec3 vDir;
in vec3 vWorldPos;
in float vElev;

layout(location = 0) out vec4 fragColor;

void main() {
  vec3 dir = normalize(vDir);
  vec3 color = geoFieldColor(dir, vElev);
  color *= depthCue(dir, vWorldPos);
  fragColor = vec4(color, 1.0);
}
`;

/**
 * WIREFRAME line fragment shader. Same geo+field color as the faces,
 * multiplied by uLineBoost and clamped so the mesh etch is a BOLDER version of
 * the underlying surface color (blue over ocean, green over land, field-tinted
 * where covered). Depth-cued the same way so it dims on the far side.
 */
export const lineFragmentShader = /* glsl */ `
${geoFieldChunk}

uniform float uLineBoost;

in vec3 vDir;
in vec3 vWorldPos;
in float vElev;

layout(location = 0) out vec4 fragColor;

void main() {
  vec3 dir = normalize(vDir);
  vec3 color = clamp(geoFieldColor(dir, vElev) * uLineBoost, 0.0, 1.0);
  color *= depthCue(dir, vWorldPos);
  fragColor = vec4(color, 1.0);
}
`;

/**
 * Uniform descriptor for the globe `ShaderMaterial`. Values are wired in
 * GlobeMesh; the field texture starts null and is set on the first bake.
 */
export interface GlobeUniforms {
  uField: { value: THREE.Texture | null };
  uLandMask: { value: THREE.Texture | null };
  uWMin: { value: number };
  uWFull: { value: number };
  uRampEdge: { value: number };
  uFieldCap: { value: number };
  uCrimson: { value: THREE.Vector3 };
  uPurple: { value: THREE.Vector3 };
  uBlue: { value: THREE.Vector3 };
  uGrey: { value: THREE.Vector3 };
  uOceanColor: { value: THREE.Vector3 };
  uLandColor: { value: THREE.Vector3 };
  uMountainColor: { value: THREE.Vector3 };
  /** Base globe radius R — denominator of the  elevation fraction. */
  uRadius: { value: number };
  uCameraPos: { value: THREE.Vector3 };
}

/** Build the default uniform block for the globe material. */
export function createGlobeUniforms(): GlobeUniforms {
  return {
    uField: { value: null },
    uLandMask: { value: null },
    uWMin: { value: W_MIN },
    uWFull: { value: W_FULL },
    uRampEdge: { value: RAMP_EDGE },
    uFieldCap: { value: FIELD_STRENGTH_CAP },
    uCrimson: { value: new THREE.Vector3(...COLOR_CRIMSON) },
    uPurple: { value: new THREE.Vector3(...COLOR_PURPLE) },
    uBlue: { value: new THREE.Vector3(...COLOR_BLUE) },
    uGrey: { value: new THREE.Vector3(...COLOR_INERT_GREY) },
    uOceanColor: { value: new THREE.Vector3(...COLOR_OCEAN) },
    uLandColor: { value: new THREE.Vector3(...COLOR_LAND) },
    uMountainColor: { value: new THREE.Vector3(...COLOR_MOUNTAIN) },
    uRadius: { value: 1 },
    uCameraPos: { value: new THREE.Vector3() },
  };
}
