import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Box } from '../../physics/collide.js';
import { model, modelInfo } from '../assets.js';

// Shared building blocks for the construction site:
//  - geometry helpers whose UVs are in METRES, so every tiling PBR set keeps
//    its real-world scale no matter how big the piece is (a 30 m slab and a
//    0.4 m column show the same aggregate size);
//  - MeshBatch: merges thousands of static pieces into one mesh per material
//    (optionally with baked vertex colours, so one "painted steel" material
//    covers every paint colour on site → very few draw calls);
//  - InstBatch: InstancedMesh builder for repeated identical parts;
//  - shader patches (world-space weathering / grime / wind) composed onto
//    MeshStandardMaterials via onBeforeCompile.

const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _d = new THREE.Vector3();
const _Y = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

// TRS matrix. Rotation order YXZ: roll (z), then pitch (x), then yaw (y).
export function trs(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'YXZ');
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sx, sy, sz));
}

// Matrix that maps a unit cylinder/box (height 1 along +y, centred) onto the
// segment a→b with cross-section scale r (radius for cylinders).
export function seg(ax, ay, az, bx, by, bz, r = 1, rz = r, out = new THREE.Matrix4()) {
  _d.set(bx - ax, by - ay, bz - az);
  const len = _d.length() || 1e-6;
  _q.setFromUnitVectors(_Y, _d.multiplyScalar(1 / len));
  return out.compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(r, len, rz));
}

// ------------------------------------------------------------------ geometry
// Box with UVs in metres (face order +x -x +y -y +z -z).
export function box(w, h, d, uo = 0, vo = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * dims[f][0] + uo, uv.getY(k) * dims[f][1] + vo);
    }
  }
  return g;
}

// Cylinder along +y, UVs in metres (u around the circumference, v along).
export function cyl(rt, rb, h, seg = 10, open = false) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
  const uv = g.attributes.uv;
  const circ = Math.PI * (rt + rb);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
  return g;
}

// Plane in XY facing +z, UVs in metres.
export function plane(w, h, sx = 1, sy = 1) {
  const g = new THREE.PlaneGeometry(w, h, sx, sy);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * h);
  return g;
}

// Side profile (x,y pairs) extruded along z by `depth`, centred on z = 0.
// UVs come from three's world UV generator (metres).
export function prism(pts, depth) {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  return g;
}

// Lathe around +y from (radius, y) pairs.
export function lathe(pts, segments = 16) {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, uv.getY(i));
  return g;
}

export const xf = (g, m) => { g.applyMatrix4(m); return g; };

// Give a geometry a constant vertex-colour attribute (needed when a
// vertexColors material is used by an InstancedMesh / hand-merged part).
export function colored(g, c = WHITE) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

// Linear colour from an sRGB hex (what vertex colours need).
export const col = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);

// ------------------------------------------------------------------ batches
// Static geometry merged per material. `base` lets a builder work in a
// vehicle's local frame and still land in the site-wide merge.
export class MeshBatch {
  constructor() {
    this.lists = new Map();
    this.base = null;
  }

  add(material, geo, matrix = null, color = null) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    let m = matrix;
    if (this.base) m = matrix ? _m.multiplyMatrices(this.base, matrix) : this.base;
    if (m) g.applyMatrix4(m);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (material.vertexColors) {
      const c = color || WHITE;
      const n = g.attributes.position.count;
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    g.clearGroups();
    let list = this.lists.get(material);
    if (!list) this.lists.set(material, (list = []));
    list.push(g);
    return this;
  }

  // run fn with all adds transformed by matrix m (nestable)
  within(m, fn) {
    const prev = this.base;
    this.base = prev ? new THREE.Matrix4().multiplyMatrices(prev, m) : m.clone();
    try { fn(); } finally { this.base = prev; }
  }

  build(parent) {
    const out = [];
    for (const [mat, list] of this.lists) {
      if (!list.length) continue;
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = mat.userData.cast !== false;
      mesh.receiveShadow = true;
      mesh.name = 'site:' + (mat.name || 'mat');
      if (mat.userData.renderOrder) mesh.renderOrder = mat.userData.renderOrder;
      parent.add(mesh);
      out.push(mesh);
    }
    this.lists.clear();
    return out;
  }
}

// Repeated identical parts → one InstancedMesh.
export class InstBatch {
  constructor(geo, mat, { cast = true, name = '' } = {}) {
    this.geo = geo;
    this.mat = mat;
    this.cast = cast;
    this.name = name;
    this.ms = [];
    this.cs = [];
  }
  add(m, color = null) {
    this.ms.push(m.clone());
    if (color) this.cs[this.ms.length - 1] = color;
    return this;
  }
  get count() { return this.ms.length; }
  build(parent) {
    if (!this.ms.length) return null;
    const im = new THREE.InstancedMesh(this.geo, this.mat, this.ms.length);
    this.ms.forEach((m, i) => im.setMatrixAt(i, m));
    if (this.cs.length) this.ms.forEach((_, i) => im.setColorAt(i, this.cs[i] || WHITE));
    im.castShadow = this.cast;
    im.receiveShadow = true;
    im.name = 'site:' + this.name;
    im.computeBoundingSphere();
    parent.add(im);
    return im;
  }
}

// CC0 glTF model placed many times → one InstancedMesh per sub-mesh.
// Placement matrices put the model's base centre at their origin.
export function modelInstances(name, placements, parent, { part, cast = true } = {}) {
  if (!placements.length) return [];
  const src = part !== undefined ? model(name, { part }) : model(name);
  if (!src) return [];
  const info = modelInfo(name);
  src.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(src);
  const centre = part !== undefined ? new THREE.Matrix4()
    : new THREE.Matrix4().makeTranslation(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  void info;
  const out = [];
  src.traverse((o) => {
    if (!o.isMesh) return;
    const local = new THREE.Matrix4().multiplyMatrices(centre, o.matrixWorld);
    const im = new THREE.InstancedMesh(o.geometry, o.material, placements.length);
    placements.forEach((p, i) => im.setMatrixAt(i, _m.multiplyMatrices(p, local)));
    im.castShadow = cast;
    im.receiveShadow = true;
    im.name = 'site:' + name;
    im.computeBoundingSphere();
    parent.add(im);
    out.push(im);
  });
  return out;
}

// ------------------------------------------------------------------ colliders
// Collider in a yawed local frame (three.js rotation.y convention, as Box).
export function solid(world, ox, oz, yaw, lx, ly, lz, hx, hy, hz, tag) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return world.add(new Box(ox + lx * c + lz * s, ly, oz - lx * s + lz * c, hx, hy, hz, yaw, tag));
}

// world-space point of a local offset in a yawed frame
export function local(ox, oz, yaw, lx, lz) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [ox + lx * c + lz * s, oz - lx * s + lz * c];
}

// ------------------------------------------------------------------ shader patches
// Common GLSL: world position/normal varyings + cheap value noise.
const COMMON_V = `
varying vec3 vSiteWP;
varying vec3 vSiteWN;
`;
const COMMON_F = `
varying vec3 vSiteWP;
varying vec3 vSiteWN;
float sHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) { return sNoise(p) * 0.5 + sNoise(p * 2.07 + 13.1) * 0.3 + sNoise(p * 4.3 + 7.7) * 0.2; }
`;
const WORLD_V = `
{
  vec4 sWp = vec4(transformed, 1.0);
  vec3 sWn = objectNormal;
  #ifdef USE_INSTANCING
    sWp = instanceMatrix * sWp;
    sWn = mat3(instanceMatrix) * sWn;
  #endif
  sWp = modelMatrix * sWp;
  vSiteWP = sWp.xyz;
  vSiteWN = normalize(mat3(modelMatrix) * sWn);
}
`;

// Compose named patches on a material. Each patch: { uniforms, vertex (after
// begin_vertex, can move `transformed`), color (after color_fragment, so it
// sees map × vertex/instance colour; edits diffuseColor, may set sWet/sGrime/
// sIAO/sIIn), rough (after roughnessmap_fragment), emissive (after
// emissivemap_fragment), light (after aomap_fragment: scales reflectedLight) }.
export function patch(mat, key, p) {
  const list = (mat.userData.patches ||= []);
  list.push({ key, ...p });
  mat.onBeforeCompile = (sh) => {
    for (const q of list) Object.assign(sh.uniforms, q.uniforms || {});
    const vtx = list.map((q) => q.vertex || '').join('\n');
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + COMMON_V + list.map((q) => q.vdecl || '').join('\n'))
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vtx)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + WORLD_V);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + COMMON_F + list.map((q) => q.fdecl || '').join('\n'))
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat sWet = 0.0; float sGrime = 0.0; float sIAO = 1.0; float sIIn = 0.0;\n' + list.map((q) => q.color || '').join('\n'))
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + list.map((q) => q.rough || '').join('\n'))
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + list.map((q) => q.emissive || '').join('\n'))
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + list.map((q) => q.light || '').join('\n'));
    mat.userData.shader = sh;
  };
  const keyStr = list.map((q) => q.key).join('+');
  mat.customProgramCacheKey = () => 'site:' + keyStr;
  return mat;
}

// Cast-in-place concrete ageing, all in world space so every storey, column
// and slab edge is different without extra textures:
//  - pour-to-pour tone blotches; lower storeys older/dirtier
//  - run-off streaks hanging below every slab edge (strongest right under the
//    edge, fading down the storey) and splash-back at each floor
//  - plywood sheet joints printed into soffits
//  - dark glossy wet patches on decks (curing water / rain)
export function weatherConcrete(mat, { storey = 3.2, streak = 0.5, wet = 1 } = {}) {
  return patch(mat, 'conc', {
    uniforms: { uStorey: { value: storey }, uStreak: { value: streak }, uWet: { value: wet } },
    fdecl: 'uniform float uStorey; uniform float uStreak; uniform float uWet;',
    color: `
{
  vec3 N = normalize(vSiteWN);
  float up = smoothstep(0.5, 0.9, N.y);
  float dn = smoothstep(0.5, 0.9, -N.y);
  float sd = clamp(1.0 - up - dn, 0.0, 1.0);
  float blot = sFbm(vSiteWP.xz * 0.09 + vSiteWP.y * 0.13);
  float tone = mix(0.84, 1.1, blot);
  vec2 sg = abs(fract(vSiteWP.xz / vec2(2.44, 1.22)) - 0.5);
  float joint = smoothstep(0.49, 0.497, max(sg.x, sg.y));
  tone *= 1.0 - dn * (0.1 + joint * 0.3);
  float al = dot(vSiteWP.xz, vec2(-N.z, N.x));
  float lv = vSiteWP.y / uStorey;
  float below = (ceil(lv) - lv) * uStorey;
  float above = (lv - floor(lv)) * uStorey;
  float st = sNoise(vec2(al * 6.0, vSiteWP.y * 0.4)) * sNoise(vec2(al * 21.0, vSiteWP.y * 0.8) + 5.0);
  st = smoothstep(0.12, 0.5, st) * exp(-below * 0.5);
  float splash = exp(-above * 4.0) * (0.55 + 0.45 * sNoise(vec2(al * 3.0, 1.7)));
  tone *= 1.0 - sd * (st * uStreak + splash * 0.22);
  // damp patches: soft-edged and only slightly darker (hard, dark blobs read
  // as cloud shadows from the cab); the wettest cores get a gloss
  float wf = sFbm(vSiteWP.xz * 0.19 + 11.0);
  float wet = smoothstep(0.6, 0.74, wf) * up * uWet;
  float dust = sFbm(vSiteWP.xz * 0.6 + 3.0) * up;
  // large-scale mottling of a power-floated slab (pours on different days,
  // curing-compound overspray, boot traffic) so the deck is not one flat grey
  float mott = sFbm(vSiteWP.xz * 0.045 + 27.0);
  tone *= mix(1.0, mix(0.86, 1.07, mott), up);
  tone *= 1.0 - wet * 0.17;
  tone *= 1.0 + dust * 0.08;
  sWet = wet * smoothstep(0.66, 0.78, wf);
  tone *= mix(0.86, 1.0, clamp(vSiteWP.y / 16.0, 0.0, 1.0));
  diffuseColor.rgb *= tone;
}`,
    rough: 'roughnessFactor = mix(roughnessFactor, 0.28, sWet);',
  });
}

// Fake GI for the open concrete frame. Surfaces deep inside a floor plate
// only see a thin slot of sky between two slabs, so in reality their ambient
// light falls off within a few metres of the façade and the middle of each
// storey reads dark from outside (the look of every frame photo). Without GI
// three.js lights them like the outside. This scales the INDIRECT light (IBL +
// hemisphere) by distance from the nearest façade; direct sun is left to the
// shadow map. At night the same mask carries the warm glow of the festoon
// lighting strung under each slab. World space, so one shared uniform set
// covers slabs, columns, props, forms and masonry, and anything outside the
// footprint or on the open top deck is untouched.
export function interiorUniforms({ minX, maxX, minZ, maxZ, top }) {
  return {
    uIB: { value: new THREE.Vector4(minX, maxX, minZ, maxZ) },
    uITop: { value: top }, uIDepth: { value: 2.4 }, uIFloor: { value: 0.22 },
    uIFest: { value: 0 }, uIFloorH: { value: 3.2 },
  };
}
export function interiorShade(mat, U) {
  return patch(mat, 'iao', {
    uniforms: U,
    fdecl: 'uniform vec4 uIB; uniform float uITop; uniform float uIDepth; uniform float uIFloor; uniform float uIFest; uniform float uIFloorH;',
    color: `
{
  float dx = min(vSiteWP.x - uIB.x, uIB.y - vSiteWP.x);
  float dz = min(vSiteWP.z - uIB.z, uIB.w - vSiteWP.z);
  float d = min(dx, dz);
  sIIn = smoothstep(-0.05, 0.4, d) * (1.0 - smoothstep(uITop - 0.08, uITop + 0.04, vSiteWP.y)) * step(0.05, vSiteWP.y);
  // a little extra darkness in the slab/column re-entrant corners
  float h = fract(vSiteWP.y / uIFloorH) * uIFloorH;
  float corner = 1.0 - 0.25 * exp(-h * 3.0) - 0.2 * exp(-(uIFloorH - 0.25 - h) * 4.0);
  sIAO = mix(1.0, mix(uIFloor, 1.0, exp(-max(d, 0.0) / uIDepth)) * corner, sIIn);
}`,
    emissive: `
{
  // festoon lamps every few metres under each soffit (warm 2700 K), strongest
  // on the soffit and upper columns just above the lamp line
  float h = fract(vSiteWP.y / uIFloorH) * uIFloorH;
  float nearLamp = 0.45 + 0.55 * smoothstep(0.8, 2.6, h);
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.74, 0.48) * uIFest * sIIn * nearLamp;
}`,
    light: 'reflectedLight.indirectDiffuse *= sIAO; reflectedLight.indirectSpecular *= sIAO;',
  });
}

// Mud / road grime creeping up from the ground: tinted, rough, noisy edge,
// plus spatter dots above the solid band (wheel throw on trucks, rain
// splash on hoardings and cabins).
export function grime(mat, { height = 0.8, color = 0x4a3a28, amount = 0.85, base = 0, scale = 1.3, spatter = 1 } = {}) {
  const c = new THREE.Color(color);
  return patch(mat, 'grime', {
    uniforms: {
      uGrH: { value: height }, uGrC: { value: c }, uGrA: { value: amount }, uGrB: { value: base },
      uGrS: { value: scale }, uGrP: { value: spatter },
    },
    fdecl: 'uniform float uGrH; uniform vec3 uGrC; uniform float uGrA; uniform float uGrB; uniform float uGrS; uniform float uGrP;',
    color: `
{
  float h = vSiteWP.y - uGrB;
  float n = sFbm(vSiteWP.xz * uGrS + vSiteWP.y * 1.7 + vec2(vSiteWP.y * 0.3, 0.0));
  float g = clamp(1.0 - h / uGrH + (n - 0.5) * 1.1, 0.0, 1.0);
  float sp = step(0.8, sNoise(vSiteWP.xz * 17.0 + vec2(vSiteWP.y * 23.0))) * clamp(1.0 - h / (uGrH * 2.2), 0.0, 1.0) * uGrP;
  g = max(smoothstep(0.1, 0.9, g), sp * 0.8) * uGrA * step(-0.05, h);
  diffuseColor.rgb = mix(diffuseColor.rgb, uGrC * (0.65 + 0.7 * n), g);
  sGrime = g;
}`,
    rough: 'roughnessFactor = mix(roughnessFactor, 0.96, sGrime);',
  });
}

// Debris netting / sheeting flapping between scaffold ties (vertex shader).
export function windFlutter(mat, { amp = 0.05, bay = 2.5, lift = 2, offset = 0, axis = 'z' } = {}) {
  const u = { uTime: { value: 0 }, uAmp: { value: amp }, uBay: { value: bay }, uLift: { value: lift }, uOff: { value: offset } };
  patch(mat, 'wind' + axis, {
    uniforms: u,
    vdecl: 'uniform float uTime; uniform float uAmp; uniform float uBay; uniform float uLift; uniform float uOff;',
    vertex: `
{
  float along = ${axis === 'z' ? 'position.x' : 'position.z'};
  float fx = fract((along - uOff) / uBay);
  float fy = fract(position.y / uLift);
  float pin = sin(3.14159 * fx) * sin(3.14159 * fy);
  float w = sin(uTime * 1.9 + along * 0.7 + position.y * 0.45) * 0.6 + sin(uTime * 3.7 + along * 1.9) * 0.4;
  transformed.${axis} += uAmp * pin * w;
}`,
  });
  return u;
}

// Hi-vis fabric is fluorescent: it returns more visible light than falls on
// it. Adds a daylight-scaled emission proportional to the (instance) colour.
export function fluorescent(mat, amount = 0.25) {
  const u = { uFluoro: { value: amount } };
  patch(mat, 'fluoro', {
    uniforms: u,
    fdecl: 'uniform float uFluoro;',
    emissive: 'totalEmissiveRadiance += diffuseColor.rgb * uFluoro;',
  });
  return u;
}
