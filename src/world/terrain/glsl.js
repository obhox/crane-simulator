import * as THREE from 'three';
import { noiseField } from '../textures.js';

// Shared GLSL for the ground shaders (site, streets, lots, far field).
//
// Everything is evaluated in WORLD space (xz, metres), so textures never
// stretch and neighbouring meshes line up without UV bookkeeping.
//
// Anti-tiling: "hex tiling" (Mikkelsen 2022, "Practical Real-Time Hex-Tiling"):
// the plane is covered by a triangle grid; each grid vertex samples the texture
// with its own random offset + rotation and the three samples are blended with
// sharpened barycentric weights. From the crane cab (45 m up) a 2 m gravel
// tile would otherwise print a very obvious lattice across the whole site.
//
// Procedural patterns (lane lines, zebras, roofs …) are BOX-FILTERED against
// the pixel footprint (fwidth) so they fade to their average colour instead of
// shimmering when seen 300 m away at grazing angles.

export const GLSL_COMMON = /* glsl */ `
varying vec3 vGW;
uniform sampler2D tNoise; // 4 independent tileable value-noise fields (RGBA), 256 px
uniform float uTime;

float g_sat(float x) { return clamp(x, 0.0, 1.0); }
float g_lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float g_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 g_hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// noise texture lookups (p in metres / scale); channels: r broad, g medium, b fine, a finest
vec4 g_noise(vec2 p) { return texture2D(tNoise, p); }
float g_fbm(vec2 p) {
  return texture2D(tNoise, p).r * 0.5 + texture2D(tNoise, p * 2.13 + 0.37).g * 0.3 + texture2D(tNoise, p * 4.37 + 0.71).b * 0.2;
}

// ---- box-filtered primitives -------------------------------------------
// coverage of the band |d| < hw, filtered with footprint fw (world units)
float g_band(float d, float hw, float fw) {
  fw = max(fw, 1e-4);
  return g_sat((d + hw) / fw + 0.5) - g_sat((d - hw) / fw + 0.5);
}
// 1 inside (d<0), 0 outside, filtered edge
float g_fill(float d, float fw) { return g_sat(0.5 - d / max(fw, 1e-4)); }
// periodic pulse train: 'on' for the first 'duty' metres of every 'period', filtered
float g_integ(float x, float period, float duty) {
  return floor(x / period) * duty + min(mod(x, period), duty);
}
float g_dash(float x, float period, float duty, float fw) {
  fw = max(fw, 1e-4);
  return (g_integ(x + fw * 0.5, period, duty) - g_integ(x - fw * 0.5, period, duty)) / fw;
}
// signed distance to an axis-aligned rectangle (centre c, half size h)
float g_sdBox(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float g_sdRoundBox(vec2 p, vec2 c, vec2 h, float r) {
  vec2 d = abs(p - c) - h + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// ---- hex tiling ---------------------------------------------------------
struct HexT { vec3 w; vec2 o1; vec2 o2; vec2 o3; vec2 r1; vec2 r2; vec2 r3; };
vec2 g_rot(vec2 r, vec2 v) { return vec2(r.x * v.x - r.y * v.y, r.y * v.x + r.x * v.y); }
vec2 g_irot(vec2 r, vec2 v) { return vec2(r.x * v.x + r.y * v.y, -r.y * v.x + r.x * v.y); }
vec2 g_vtxRot(vec2 v, float amt) { float a = (g_hash12(v * 1.37 + 11.3) - 0.5) * 6.2831853 * amt; return vec2(cos(a), sin(a)); }
HexT g_hexSetup(vec2 st, float rotAmt) {
  st *= 3.4641016;
  vec2 sk = mat2(1.0, -0.57735027, 0.0, 1.15470054) * st;
  vec2 base = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z);
  float s2 = 2.0 * s - 1.0;
  vec3 w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  vec2 v1 = base + vec2(s, s);
  vec2 v2 = base + vec2(s, 1.0 - s);
  vec2 v3 = base + vec2(1.0 - s, s);
  HexT h;
  w = pow(max(w, 0.0), vec3(5.0));
  h.w = w / (w.x + w.y + w.z);
  h.o1 = g_hash22(v1) * 7.31; h.o2 = g_hash22(v2) * 7.31; h.o3 = g_hash22(v3) * 7.31;
  h.r1 = g_vtxRot(v1, rotAmt); h.r2 = g_vtxRot(v2, rotAmt); h.r3 = g_vtxRot(v3, rotAmt);
  return h;
}
#ifdef TERRAIN_LOW
  // phones: one plain sample (the rotated second octave of the macro noise hides most repetition)
  vec4 g_hexTex(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h) { return textureGrad(t, uv, dx, dy); }
  vec3 g_hexNrm(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h) { return textureGrad(t, uv, dx, dy).xyz * 2.0 - 1.0; }
#else
  vec4 g_hexTex(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h) {
    vec4 a = textureGrad(t, g_rot(h.r1, uv) + h.o1, g_rot(h.r1, dx), g_rot(h.r1, dy));
    vec4 b = textureGrad(t, g_rot(h.r2, uv) + h.o2, g_rot(h.r2, dx), g_rot(h.r2, dy));
    vec4 c = textureGrad(t, g_rot(h.r3, uv) + h.o3, g_rot(h.r3, dx), g_rot(h.r3, dy));
    return a * h.w.x + b * h.w.y + c * h.w.z;
  }
  // tangent-space normal (xy rotated back into world uv space), not normalised
  vec3 g_hexNrm(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h) {
    vec3 a = textureGrad(t, g_rot(h.r1, uv) + h.o1, g_rot(h.r1, dx), g_rot(h.r1, dy)).xyz * 2.0 - 1.0;
    vec3 b = textureGrad(t, g_rot(h.r2, uv) + h.o2, g_rot(h.r2, dx), g_rot(h.r2, dy)).xyz * 2.0 - 1.0;
    vec3 c = textureGrad(t, g_rot(h.r3, uv) + h.o3, g_rot(h.r3, dx), g_rot(h.r3, dy)).xyz * 2.0 - 1.0;
    a.xy = g_irot(h.r1, a.xy); b.xy = g_irot(h.r2, b.xy); c.xy = g_irot(h.r3, c.xy);
    return a * h.w.x + b * h.w.y + c * h.w.z;
  }
#endif
// Grid-aligned hex tiling for patterned textures (pavers, slabs): no rotation,
// and each vertex's offset is snapped to whole slabs (1/snap of a repeat), so
// joints stay continuous while which slab lands where is randomised.
#ifdef TERRAIN_LOW
  vec4 g_hexGrid(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h, vec2 snap) { return textureGrad(t, uv, dx, dy); }
  vec3 g_hexGridN(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h, vec2 snap) { return textureGrad(t, uv, dx, dy).xyz * 2.0 - 1.0; }
#else
  vec4 g_hexGrid(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h, vec2 snap) {
    return textureGrad(t, uv + floor(h.o1 * snap) / snap, dx, dy) * h.w.x
         + textureGrad(t, uv + floor(h.o2 * snap) / snap, dx, dy) * h.w.y
         + textureGrad(t, uv + floor(h.o3 * snap) / snap, dx, dy) * h.w.z;
  }
  vec3 g_hexGridN(sampler2D t, vec2 uv, vec2 dx, vec2 dy, HexT h, vec2 snap) {
    return g_hexGrid(t, uv, dx, dy, h, snap).xyz * 2.0 - 1.0;
  }
#endif
// plain (grid-aligned) sampling for patterned textures (pavers, slabs) that must not rotate
vec3 g_nrm(sampler2D t, vec2 uv, vec2 dx, vec2 dy) { return textureGrad(t, uv, dx, dy).xyz * 2.0 - 1.0; }
// optional emissive contribution (far-field street lamps at night)
vec3 gEmissive = vec3(0.0);
// uv convention: u = x / tile, v = -z / tile  →  tangent +x, bitangent -z
vec3 g_tsToWorld(vec3 n) { return vec3(n.x, n.z, -n.y); }
`;

// Linear tint that brings a scan's mean albedo (MANIFEST) to `target`, with an
// optional hue bias. Scans come at wildly different exposures; ground albedos
// must be physically plausible (asphalt ~0.1, soil ~0.12, concrete ~0.25-0.35)
// or the tone-mapped image looks either chalky or muddy under the HDRI sun.
export function albedoTint(meta, target, hue = [1, 1, 1]) {
  const a = meta?.albedo || [0.2, 0.2, 0.2];
  const l = 0.2126 * a[0] * hue[0] + 0.7152 * a[1] * hue[1] + 0.0722 * a[2] * hue[2];
  const k = target / Math.max(1e-4, l);
  return new THREE.Vector3(hue[0] * k, hue[1] * k, hue[2] * k);
}

// Shared 256² RGBA tileable noise texture.
let noiseTex = null;
export function terrainNoise() {
  if (noiseTex) return noiseTex;
  const N = 256;
  const f = [noiseField(N, 4, 5, 501), noiseField(N, 8, 5, 502), noiseField(N, 16, 4, 503), noiseField(N, 32, 3, 504)];
  // stretch each field to use the full 0..1 range (value noise clusters around 0.5)
  for (const a of f) {
    let lo = 1, hi = 0;
    for (let i = 0; i < a.length; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / (hi - lo);
  }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(f[c][i] * 255);
  noiseTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.magFilter = THREE.LinearFilter;
  noiseTex.minFilter = THREE.LinearMipmapLinearFilter;
  noiseTex.generateMipmaps = true;
  noiseTex.needsUpdate = true;
  noiseTex.name = 'terrain_noise';
  return noiseTex;
}

// Patch a MeshStandardMaterial so a world-space shader function drives its
// surface. `surface` is GLSL that must define:
//   void groundSurface(vec3 p, vec2 dpx, vec2 dpy, out vec3 albedo, out float rough,
//                      out float metal, out vec3 nW, out float ao)
// (p = world position, dpx/dpy = screen derivatives of p.xz). Lighting, shadows,
// IBL and fog stay three.js' own, so the ground reacts to the sun/HDRI/time of
// day exactly like every other object.
export function groundMaterial({ name, uniforms = {}, defines = {}, surface, key, params = {} }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, ...params });
  mat.name = name;
  mat.defines = { ...defines };
  const allUniforms = { tNoise: { value: terrainNoise() }, uTime: { value: 0 }, ...uniforms };
  mat.userData.uniforms = allUniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, allUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_COMMON}\n${surface}`)
      .replace('#include <map_fragment>', /* glsl */ `
        vec3 gAlbedo; float gRough; float gMetal; vec3 gNW; float gAO;
        {
          vec2 dpx = dFdx(vGW.xz), dpy = dFdy(vGW.xz);
          groundSurface(vGW, dpx, dpy, gAlbedo, gRough, gMetal, gNW, gAO);
        }
        diffuseColor.rgb *= gAlbedo;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(gRough, 0.03, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gNW, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += gEmissive;')
      .replace('#include <aomap_fragment>', /* glsl */ `
        reflectedLight.indirectDiffuse *= gAO;
        #if defined( USE_ENVMAP )
          reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), gAO, material.roughness);
        #endif`);
  };
  mat.customProgramCacheKey = () => 'ground:' + (key || name) + ':' + JSON.stringify(mat.defines);
  return mat;
}
