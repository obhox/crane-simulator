import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROAD, X_ROADS, Z_ROADS, SITE_BLOCK } from '../layout.js';
import { SITE } from '../../config.js';
import { CRANE_APPROACH } from '../../mobile/config.js';

// Shared helpers for the street-life modules (vehicles, furniture, trees,
// pedestrians). Everything here is build-time only except the camera probe.

export const ROAD_Y = 0; // carriageway surface (terrain contract)
export const CURB_Y = ROAD.curbHeight; // sidewalk top
export const HALF_ROAD = ROAD.width / 2; // carriageway half width (curb line)
export const OUTER = ROAD.width / 2 + ROAD.sidewalk; // sidewalk outer edge from the road centre line
export const STOP_LINE = OUTER + 1.0; // stop line distance from the intersection centre
export const LANE = ROAD.laneWidth / 2; // lane centre offset from the road centre (right-hand traffic)

// Keep-out areas for street furniture / parked cars / idle pedestrians.
// The site gate apron (trucks swing in over the frontage sidewalk) and the
// site itself.
export const GATE = { minX: -40, maxX: -20, minZ: -72, maxZ: -56 };
export function siteBlocked(x, z, pad = 0) {
  const f = SITE.fence;
  if (x > f.minX - pad && x < f.maxX + pad && z > f.minZ - pad && z < f.maxZ + pad) return true;
  if (x > GATE.minX - pad && x < GATE.maxX + pad && z > GATE.minZ - pad && z < GATE.maxZ + pad) return true;
  return false;
}

// Mobile-crane approach (spec §7.1): no parked cars or furniture on either
// kerb of the road at z −66 between the junction at x −100 and the gate, so
// the AT-100 can swing through the far lane and kerb strip. The junction
// itself keeps its signal posts, name signs and corner bollards: points within
// JUNCTION_KEEP of a junction centre are exempt (the posts stand 9.35 m from
// the centre; the crane never drives there).
const JUNCTION_KEEP = 10.5;
const APPROACH_NODES = [];
for (const x of Z_ROADS) for (const z of X_ROADS) {
  const a = CRANE_APPROACH;
  if (x > a.minX - JUNCTION_KEEP && x < a.maxX + JUNCTION_KEEP && z > a.minZ - JUNCTION_KEEP && z < a.maxZ + JUNCTION_KEEP) APPROACH_NODES.push({ x, z });
}
export function inCraneApproach(x, z, pad = 0) {
  const a = CRANE_APPROACH;
  if (!(x > a.minX - pad && x < a.maxX + pad && z > a.minZ - pad && z < a.maxZ + pad)) return false;
  for (const n of APPROACH_NODES) if (Math.abs(x - n.x) < JUNCTION_KEEP && Math.abs(z - n.z) < JUNCTION_KEEP) return false;
  return true;
}
export function blocked(x, z, pad = 0) {
  return siteBlocked(x, z, pad) || inCraneApproach(x, z, pad);
}

// ------------------------------------------------------------------ obstacles
// Moving obstacles fed by the host every frame (spec §7.1, the mobile crane):
// yawed rectangles {x, z, hx, hz, yaw, vx?, vz?} in three.js yaw (local +x =
// (cos yaw, −sin yaw)). prepObstacles copies them into `pool` with the
// cos/sin/bounding radius precomputed and returns the count (no allocation
// once the pool has grown).
export function prepObstacles(list, pool) {
  let n = 0;
  if (!list) return 0;
  for (const o of list) {
    if (!o || !(o.hx > 0) || !(o.hz > 0)) continue;
    const p = pool[n] || (pool[n] = { x: 0, z: 0, hx: 0, hz: 0, c: 1, s: 0, r: 0, vx: 0, vz: 0 });
    p.x = o.x ?? o.cx; p.z = o.z ?? o.cz; p.hx = o.hx; p.hz = o.hz;
    const yaw = o.yaw || 0;
    p.c = Math.cos(yaw); p.s = Math.sin(yaw);
    p.r = Math.hypot(o.hx, o.hz);
    p.vx = o.vx || 0; p.vz = o.vz || 0;
    n++;
  }
  return n;
}
// distance from a point to a prepared obstacle rectangle (0 inside)
export function obstacleDist(o, x, z) {
  const dx = x - o.x, dz = z - o.z;
  const lx = Math.abs(dx * o.c - dz * o.s) - o.hx, lz = Math.abs(dx * o.s + dz * o.c) - o.hz;
  return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
}

export const sortedX = [...Z_ROADS].sort((a, b) => a - b); // x of the roads running along z
export const sortedZ = [...X_ROADS].sort((a, b) => a - b); // z of the roads running along x
export { SITE_BLOCK };

// Road-side geometry. An "edge" is one side of one road between two junction
// corners (sidewalk + curb lane). axis 'x' roads run along x at z = c; side
// ±1 selects the half at c ± offset. Params a..b run along the axis.
export const EXTENT = { min: -470, max: 470 };
export function blockEdges(maxDist = 360) {
  const out = [];
  const add = (axis, c, cuts) => {
    for (const side of [1, -1]) {
      for (let i = -1; i < cuts.length; i++) {
        const a = i < 0 ? EXTENT.min : cuts[i] + OUTER;
        const b = i + 1 >= cuts.length ? EXTENT.max : cuts[i + 1] - OUTER;
        if (b - a < 8) continue;
        // closest distance of the segment to the origin
        const t = Math.max(a, Math.min(b, 0));
        const d = Math.hypot(t, c + side * (HALF_ROAD + 1.75));
        if (d > maxDist) continue;
        out.push({ axis, c, side, a, b, len: b - a, junctionA: i >= 0, junctionB: i + 1 < cuts.length });
      }
    }
  };
  for (const c of sortedZ) add('x', c, sortedX);
  for (const c of sortedX) add('z', c, sortedZ);
  return out;
}
// world [x, z] of param t at lateral offset o (metres from the road centre line, towards `side`)
export function edgePoint(e, t, o) {
  return e.axis === 'x' ? [t, e.c + e.side * o] : [e.c + e.side * o, t];
}
// yaw (rotation about +y) that turns local +x into the edge direction, and
// local +z towards the road centre (i.e. objects "face" the carriageway)
export function edgeYaw(e) {
  // local +x → along the axis; local +z → -side normal (towards the road)
  if (e.axis === 'x') return e.side > 0 ? Math.PI : 0;
  return e.side > 0 ? -Math.PI / 2 : Math.PI / 2;
}

// Bus stops (lane direction dir along the axis; the stop is on the right-hand curb).
export const BUS_STOPS = [
  { axis: 'x', c: -66, dir: -1, at: 40 }, // opposite the site
  { axis: 'x', c: -66, dir: 1, at: 162 },
  { axis: 'z', c: -100, dir: 1, at: 12 },
  { axis: 'z', c: 110, dir: -1, at: 38 },
  { axis: 'x', c: 104, dir: -1, at: -30 },
  { axis: 'x', c: -176, dir: 1, at: 20 },
];
for (const s of BUS_STOPS) s.side = s.axis === 'x' ? s.dir : -s.dir;
export function nearBusStop(axis, c, side, t, pad = 16) {
  return BUS_STOPS.some((s) => s.axis === axis && s.c === c && s.side === side && Math.abs(s.at - t) < pad);
}

// ------------------------------------------------------------------ matrices
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

// ------------------------------------------------------------------ geometry
// Merge many primitives into one non-indexed geometry, stamping constant
// per-part vertex attributes (colour, material parameters, bone ids …).
// `values` may be an object or a function(centroid, normal) → object that is
// evaluated per triangle (used to paint glass / trim by face orientation).
export class GeoBuilder {
  constructor(extra = { color: 3 }) {
    this.extra = extra;
    this.parts = [];
  }

  add(geo, matrix = null, values = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv' && !(k in this.extra)) g.deleteAttribute(k);
    }
    const perFace = typeof values === 'function';
    const pos = g.attributes.position, nor = g.attributes.normal;
    const c = new THREE.Vector3(), nn = new THREE.Vector3(), t = new THREE.Vector3();
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const arrays = {};
    for (const [name, size] of Object.entries(this.extra)) arrays[name] = new Float32Array(n * size);
    for (let f = 0; f < n; f += 3) {
      let vals = values;
      if (perFace) {
        // classify by the geometric face normal (smoothed vertex normals
        // would make material borders ragged along bevels)
        va.fromBufferAttribute(pos, f);
        vb.fromBufferAttribute(pos, f + 1);
        vc.fromBufferAttribute(pos, f + 2);
        c.copy(va).add(vb).add(vc).multiplyScalar(1 / 3);
        nn.subVectors(vc, vb).cross(t.subVectors(va, vb));
        if (nn.lengthSq() < 1e-14) {
          nn.set(0, 0, 0);
          for (let k = 0; k < 3; k++) nn.add(t.fromBufferAttribute(nor, f + k));
        }
        nn.normalize();
        vals = values(c, nn, f / 3); // third arg: triangle index (for index-based classification)
      }
      for (const [name, size] of Object.entries(this.extra)) {
        const v = vals[name] ?? (name === 'color' ? [1, 1, 1] : 0);
        const a = arrays[name];
        for (let k = 0; k < 3; k++) {
          if (size === 1) a[f + k] = typeof v === 'number' ? v : v[0];
          else for (let j = 0; j < size; j++) a[(f + k) * size + j] = typeof v === 'number' ? v : (v[j] ?? 0);
        }
      }
    }
    for (const [name, size] of Object.entries(this.extra)) g.setAttribute(name, new THREE.BufferAttribute(arrays[name], size));
    this.parts.push(g);
    return g;
  }

  get empty() { return this.parts.length === 0; }

  build() {
    const g = mergeGeometries(this.parts, false);
    this.parts = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ------------------------------------------------------------------ instancing
// An InstancedMesh is frustum-culled as ONE unit — in the main view and in
// every shadow cascade — so a city-wide prop mesh is always drawn whole, three
// times over, into the shadow maps. Static props are therefore split:
//  · instances within `shadowR` of the site go into up to four quadrant
//    meshes (tight bounding spheres, cast shadows),
//  · everything further out goes into one mesh that casts no shadow (a 30 cm
//    bin's shadow 200 m away is sub-texel in the far cascade anyway).
// That keeps draw calls at ≤ 5 per prop type while the shadow passes only see
// the props around the site. Returns the created meshes.
export function instancedProps(root, geo, material, matrices, { name = 'props', cast = true, receive = true, shadowR = 150, depthMaterial = null } = {}) {
  const out = [];
  if (!matrices.length) return out;
  const groups = cast && shadowR > 0 ? [[], [], [], [], []] : [[], [], [], [], matrices.slice()];
  if (groups[4].length === 0) {
    const e = new THREE.Vector3();
    for (const m of matrices) {
      e.setFromMatrixPosition(m);
      if (Math.hypot(e.x, e.z) > shadowR) groups[4].push(m);
      else groups[(e.x < 0 ? 0 : 1) + (e.z < 0 ? 0 : 2)].push(m);
    }
  }
  groups.forEach((list, k) => {
    if (!list.length) return;
    const im = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = cast && k < 4;
    im.receiveShadow = receive;
    if (depthMaterial) im.customDepthMaterial = depthMaterial;
    im.computeBoundingSphere();
    im.name = `streets.${name}${k < 4 ? `.q${k}` : ''}`;
    root.add(im);
    out.push(im);
  });
  return out;
}

// Box with UVs scaled to world metres (so tiled PBR textures keep their size).
export function worldBox(sx, sy, sz, tile = 1) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const uv = g.attributes.uv;
  // faces: +x -x +y -y +z -z; u/v extents per face
  const ext = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * ext[f][0] / tile, uv.getY(i) * ext[f][1] / tile);
    }
  }
  return g;
}

// Tapered cylinder whose UVs are in metres (u around the circumference).
export function worldCylinder(r0, r1, h, seg = 12, tile = 1, open = false) {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, open);
  const uv = g.attributes.uv;
  const circ = Math.PI * (r0 + r1);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ / tile, uv.getY(i) * h / tile);
  return g;
}

// ------------------------------------------------------------------ shaders
// Minimal onBeforeCompile patcher: replaces `#include <chunk>` with code
// (use '$' inside the code to re-insert the original include).
export function patchShader(material, key, { uniforms = {}, vertexPars = '', vertex = {}, fragmentPars = '', fragment = {} }) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${vertexPars}`);
    for (const [chunk, code] of Object.entries(vertex)) {
      shader.vertexShader = shader.vertexShader.replace(`#include <${chunk}>`, code.replace('$', `#include <${chunk}>`));
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${fragmentPars}`);
    for (const [chunk, code] of Object.entries(fragment)) {
      shader.fragmentShader = shader.fragmentShader.replace(`#include <${chunk}>`, code.replace('$', `#include <${chunk}>`));
    }
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => (prevKey ? prevKey() : '') + key;
  return material;
}

// ------------------------------------------------------------------ camera
// update(dt, night) is not given the camera, so an invisible, never-culled
// mesh records the first camera rendered after each update (= the main view;
// the hook-camera PIP renders later in the frame and is ignored).
export function cameraProbe(root) {
  const probe = { pos: new THREE.Vector3(2, 47, 3), dir: new THREE.Vector3(1, -0.3, 0), stale: true, camera: null };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.renderOrder = -1e6;
  mesh.name = 'streets.cameraProbe';
  mesh.onBeforeRender = (r, s, cam) => {
    if (!probe.stale) return;
    probe.pos.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(probe.dir);
    probe.camera = cam;
    probe.stale = false;
  };
  root.add(mesh);
  return probe;
}

// ------------------------------------------------------------------ canvas
export function canvasTexture(w, h, draw, { srgb = true, repeat = false, mips = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = mips;
  return t;
}

// Soft radial falloff used by glows / light pools / contact shadows.
let _radial = null;
export function radialTexture() {
  if (_radial) return _radial;
  _radial = canvasTexture(128, 128, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = Math.pow(1 - t, 2.2);
      g.addColorStop(t, `rgba(255,255,255,${a.toFixed(3)})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  }, { srgb: false });
  return _radial;
}

// Linear-space colour from sRGB hex (instance colours are linear).
export const lin = (hex) => new THREE.Color(hex);

export function pick(r, arr) { return arr[Math.floor(r() * arr.length) % arr.length]; }
export function weighted(r, items) { // items: [[value, weight], …]
  let tot = 0;
  for (const it of items) tot += it[1];
  let x = r() * tot;
  for (const it of items) { x -= it[1]; if (x <= 0) return it[0]; }
  return items[items.length - 1][0];
}
