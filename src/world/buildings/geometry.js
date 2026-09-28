import * as THREE from 'three';

// Merged-geometry builder for the city. Every primitive is written once into
// shared vertex arrays; its triangles go to the LOW-detail index list only
// when `detail === 0`, and always to the HIGH one. The two index lists become
// two BufferGeometries sharing the same attributes (one GPU upload) → a
// THREE.LOD per chunk with near/far versions for almost no extra memory.
//
// Paint (per-primitive surface parameters, see material.js):
//   { layer, style, seed, pack, color:[r,g,b] 0..1,
//     grid:[floorH, bayW, groundH, topV] m, win:[winW, winH, sill] m, gw: groundStyle|flags<<4 }

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const _t = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

// tangent frame rule shared with the shader: T = Y×N (or +X for horizontal faces), B = N×T
function frame(n, t, b) {
  if (Math.abs(n.y) > 0.999) t.copy(X);
  else t.crossVectors(Y, n).normalize();
  b.crossVectors(n, t);
}

export const PLAIN = { layer: 15, style: 0, seed: 0, pack: 0, color: [0.5, 0.5, 0.5], grid: [3, 3, 0, 0], win: [0, 0, 0], gw: 0 };

export class CityGeo {
  constructor(cap = 4096) {
    this.cap = cap;
    this.P = new Float32Array(cap * 3); this.N = new Int8Array(cap * 3); this.UV = new Float32Array(cap * 2);
    this.C = new Uint8ClampedArray(cap * 3); this.M = new Uint8Array(cap * 4); this.G = new Uint16Array(cap * 4); this.W = new Uint16Array(cap * 4);
    this.hi = new IdxList(); this.lo = new IdxList();
    this.nv = 0;
    this.detail = 0; // 0 = structure (both LODs), 1 = near-only detail
    this.ox = 0; this.oz = 0; // chunk origin subtracted from positions
  }

  grow() {
    const cap = this.cap * 2;
    const g = (a, k) => { const b = new a.constructor(cap * k); b.set(a); return b; };
    this.P = g(this.P, 3); this.N = g(this.N, 3); this.UV = g(this.UV, 2);
    this.C = g(this.C, 3); this.M = g(this.M, 4); this.G = g(this.G, 4); this.W = g(this.W, 4);
    this.cap = cap;
  }

  vert(x, y, z, n, u, v, p) {
    if (this.nv >= this.cap) this.grow();
    const i = this.nv;
    const i3 = i * 3, i4 = i * 4;
    this.P[i3] = x - this.ox; this.P[i3 + 1] = y; this.P[i3 + 2] = z - this.oz;
    this.N[i3] = Math.round(n.x * 127); this.N[i3 + 1] = Math.round(n.y * 127); this.N[i3 + 2] = Math.round(n.z * 127);
    this.UV[i * 2] = u; this.UV[i * 2 + 1] = v;
    const c = p.color;
    this.C[i3] = c[0] * 255 + 0.5; this.C[i3 + 1] = c[1] * 255 + 0.5; this.C[i3 + 2] = c[2] * 255 + 0.5;
    this.M[i4] = p.layer; this.M[i4 + 1] = p.style; this.M[i4 + 2] = p.seed; this.M[i4 + 3] = p.pack;
    const g = p.grid, w = p.win;
    this.G[i4] = g[0] * 100 + 0.5; this.G[i4 + 1] = g[1] * 100 + 0.5; this.G[i4 + 2] = g[2] * 100 + 0.5; this.G[i4 + 3] = Math.min(65535, g[3] * 100 + 0.5);
    this.W[i4] = w[0] * 100 + 0.5; this.W[i4 + 1] = w[1] * 100 + 0.5; this.W[i4 + 2] = w[2] * 100 + 0.5; this.W[i4 + 3] = p.gw;
    return this.nv++;
  }

  tri(a, b, c) {
    this.hi.push3(a, b, c);
    if (this.detail === 0) this.lo.push3(a, b, c);
  }

  // Quad from 4 corners (CCW seen from the front) with explicit uvs [[u,v]x4].
  quadUV(a, b, c, d, uvs, p) {
    _e1.subVectors(b, a); _e2.subVectors(d, a);
    _n.crossVectors(_e1, _e2).normalize();
    const i0 = this.vert(a.x, a.y, a.z, _n, uvs[0][0], uvs[0][1], p);
    const i1 = this.vert(b.x, b.y, b.z, _n, uvs[1][0], uvs[1][1], p);
    const i2 = this.vert(c.x, c.y, c.z, _n, uvs[2][0], uvs[2][1], p);
    const i3 = this.vert(d.x, d.y, d.z, _n, uvs[3][0], uvs[3][1], p);
    this.tri(i0, i1, i2);
    this.tri(i0, i2, i3);
  }

  // Quad with uvs from the shared tangent-frame rule (world metres).
  quad(a, b, c, d, p, uo = 0, vo = 0) {
    _e1.subVectors(b, a); _e2.subVectors(d, a);
    _n.crossVectors(_e1, _e2).normalize();
    frame(_n, _t, _b);
    const uv = (q) => [q.x * _t.x + q.y * _t.y + q.z * _t.z - uo, q.x * _b.x + q.y * _b.y + q.z * _b.z - vo];
    this.quadUV(a, b, c, d, [uv(a), uv(b), uv(c), uv(d)], p);
  }

  triangle(a, b, c, p) {
    _e1.subVectors(b, a); _e2.subVectors(c, a);
    _n.crossVectors(_e1, _e2).normalize();
    frame(_n, _t, _b);
    const uv = (q) => [q.x * _t.x + q.y * _t.y + q.z * _t.z, q.x * _b.x + q.y * _b.y + q.z * _b.z];
    const ia = this.vert(a.x, a.y, a.z, _n, ...uv(a), p);
    const ib = this.vert(b.x, b.y, b.z, _n, ...uv(b), p);
    const ic = this.vert(c.x, c.y, c.z, _n, ...uv(c), p);
    this.tri(ia, ib, ic);
  }

  // Vertical wall from (ax,az) to (bx,bz), y0..y1. The outward normal is
  // T×Y with T = B-A, so walk footprints N: x0→x1 @z1, E: z1→z0 @x1,
  // S: x1→x0 @z0, W: z0→z1 @x0. v = world height (floor grid stays aligned),
  // u = u0 + distance from A.
  wall(ax, az, bx, bz, y0, y1, p, u0 = 0) {
    if (y1 - y0 < 1e-3) return;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 1e-3) return;
    const a = new THREE.Vector3(ax, y0, az), b = new THREE.Vector3(bx, y0, bz);
    const c = new THREE.Vector3(bx, y1, bz), d = new THREE.Vector3(ax, y1, az);
    this.quadUV(a, b, c, d, [[u0, y0], [u0 + L, y0], [u0 + L, y1], [u0, y1]], p);
  }

  // Axis-aligned box. faces: string of n,e,s,w,t,b (default all but bottom).
  // pSide/pTop allow different paints for walls and the top.
  box(x0, y0, z0, x1, y1, z1, pSide, pTop = pSide, faces = 'nestw', uvAbs = false) {
    const vb = uvAbs ? 0 : y0;
    const w = (ax, az, bx, bz) => {
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-4 || y1 - y0 < 1e-4) return;
      const a = new THREE.Vector3(ax, y0, az), b = new THREE.Vector3(bx, y0, bz);
      const c = new THREE.Vector3(bx, y1, bz), d = new THREE.Vector3(ax, y1, az);
      this.quadUV(a, b, c, d, [[0, y0 - vb], [L, y0 - vb], [L, y1 - vb], [0, y1 - vb]], pSide);
    };
    if (faces.includes('n')) w(x0, z1, x1, z1);
    if (faces.includes('e')) w(x1, z1, x1, z0);
    if (faces.includes('s')) w(x1, z0, x0, z0);
    if (faces.includes('w')) w(x0, z0, x0, z1);
    if (faces.includes('t') && x1 - x0 > 1e-4 && z1 - z0 > 1e-4) {
      this.quad(new THREE.Vector3(x0, y1, z1), new THREE.Vector3(x1, y1, z1), new THREE.Vector3(x1, y1, z0), new THREE.Vector3(x0, y1, z0), pTop);
    }
    if (faces.includes('b') && x1 - x0 > 1e-4 && z1 - z0 > 1e-4) {
      this.quad(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y0, z0), new THREE.Vector3(x1, y0, z1), new THREE.Vector3(x0, y0, z1), pTop);
    }
  }

  // Vertical cylinder (smooth sides), optional top cap.
  cyl(cx, y0, cz, r, h, seg, p, cap = true) {
    const base = this.nv;
    const n = new THREE.Vector3();
    const circ = 2 * Math.PI * r;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      n.set(ca, 0, -sa);
      this.vert(cx + ca * r, y0, cz - sa * r, n, (i / seg) * circ, 0, p);
      this.vert(cx + ca * r, y0 + h, cz - sa * r, n, (i / seg) * circ, h, p);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.tri(a, a + 2, a + 3);
      this.tri(a, a + 3, a + 1);
    }
    if (cap) {
      const up = new THREE.Vector3(0, 1, 0);
      const c = this.vert(cx, y0 + h, cz, up, cx, -cz, p);
      const ring = [];
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const x = cx + Math.cos(a) * r, z = cz - Math.sin(a) * r;
        ring.push(this.vert(x, y0 + h, z, up, x, -z, p));
      }
      for (let i = 0; i < seg; i++) this.tri(c, ring[i], ring[i + 1]);
    }
  }

  get triangles() { return this.hi.n / 3; }

  // → { hi: BufferGeometry, lo: BufferGeometry|null } sharing attributes
  build() {
    if (!this.nv) return null;
    const n = this.nv;
    const attrs = {
      position: new THREE.BufferAttribute(this.P.slice(0, n * 3), 3),
      normal: new THREE.BufferAttribute(this.N.slice(0, n * 3), 3, true),
      uv: new THREE.BufferAttribute(this.UV.slice(0, n * 2), 2),
      color: new THREE.BufferAttribute(this.C.slice(0, n * 3), 3, true),
      aMat: new THREE.BufferAttribute(this.M.slice(0, n * 4), 4, false),
      aGrid: new THREE.BufferAttribute(this.G.slice(0, n * 4), 4, false),
      aWin: new THREE.BufferAttribute(this.W.slice(0, n * 4), 4, false),
    };
    const big = n > 65535;
    const mk = (idx) => {
      const g = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(attrs)) g.setAttribute(k, a);
      g.setIndex(new THREE.BufferAttribute(idx.typed(big), 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
    };
    const hi = mk(this.hi);
    const lo = this.lo.n && this.lo.n < this.hi.n ? mk(this.lo) : null;
    this.P = this.N = this.UV = this.C = this.M = this.G = this.W = this.hi = this.lo = null;
    return { hi, lo };
  }
}

class IdxList {
  constructor() { this.a = new Uint32Array(8192); this.n = 0; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
  typed(big) { return big ? this.a.slice(0, this.n) : new Uint16Array(this.a.subarray(0, this.n)); }
}
