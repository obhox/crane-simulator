import * as THREE from 'three';
import { ROAD, X_ROADS, Z_ROADS } from '../layout.js';

// Geometry of the street grid (roads at y = 0, blocks raised to kerb height).
//
// The world is cut into cells by the road centre lines (plus the edge of the
// detailed region D). Each cell holds one "block": the raised area between
// kerbs (sidewalk ring + lot). Blocks get rounded kerb returns at every corner
// that faces an intersection. Nothing overlaps: carriageways, blocks and the
// far-field frame tile the plane, so there is no coplanar z-fighting even at
// 500 m with a 0.05 m near plane.

export const KERB_R = 3; // kerb return radius: tight urban corner so the crossings (5.9-8.9 m from the junction centre, see streets/common.js) meet a straight kerb
export const TOP = ROAD.curbHeight; // 0.15

export function gridSpec(site) {
  const xs = [...Z_ROADS].sort((a, b) => a - b); // road centre x (roads running along z)
  const zs = [...X_ROADS].sort((a, b) => a - b); // road centre z (roads running along x)
  const hw = ROAD.width / 2, SW = ROAD.sidewalk;
  const E = hw + SW; // D ends at the back of the outermost sidewalks
  const D = { minX: xs[0] - E, maxX: xs[xs.length - 1] + E, minZ: zs[0] - E, maxZ: zs[zs.length - 1] + E };
  const BX = [{ v: D.minX, road: false }, ...xs.map((v) => ({ v, road: true })), { v: D.maxX, road: false }];
  const BZ = [{ v: D.minZ, road: false }, ...zs.map((v) => ({ v, road: true })), { v: D.maxZ, road: false }];
  const fe = site.fence;
  const gate = { minX: -34, maxX: -26 }; // vehicle crossover through the south footway
  const blocks = [];
  for (let i = 0; i < BX.length - 1; i++) {
    for (let j = 0; j < BZ.length - 1; j++) {
      const b = {
        i, j,
        minX: BX[i].v + (BX[i].road ? hw : 0), maxX: BX[i + 1].v - (BX[i + 1].road ? hw : 0),
        minZ: BZ[j].v + (BZ[j].road ? hw : 0), maxZ: BZ[j + 1].v - (BZ[j + 1].road ? hw : 0),
        // corner radii: [minX/minZ, maxX/minZ, maxX/maxZ, minX/maxZ]
        r: [
          BX[i].road && BZ[j].road ? KERB_R : 0, BX[i + 1].road && BZ[j].road ? KERB_R : 0,
          BX[i + 1].road && BZ[j + 1].road ? KERB_R : 0, BX[i].road && BZ[j + 1].road ? KERB_R : 0,
        ],
        edge: [!BZ[j].road, !BX[i + 1].road, !BZ[j + 1].road, !BX[i].road], // sides on the D boundary (S,E,N,W)
      };
      b.site = b.minX < fe.minX && b.maxX > fe.maxX && b.minZ < fe.minZ && b.maxZ > fe.maxZ;
      blocks.push(b);
    }
  }
  return { xs, zs, hw, SW, E, D, BX, BZ, blocks, fence: fe, gate };
}

// Outline of a block, counter-clockwise (x right, z up). Each point carries a
// flag telling whether the edge that STARTS at it is a kerb (true) or a plain
// skirt (D boundary). The site block is a "C": the fence rectangle and the
// gate crossover are cut out as one simple polygon.
function blockOutline(b, spec, seg = 8) {
  const pts = [];
  const arc = (cx, cz, a0, kerb) => {
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (k / seg) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * KERB_R, z: cz + Math.sin(a) * KERB_R, kerb });
    }
  };
  const [r0, r1, r2, r3] = b.r;
  const [eS, eE, eN, eW] = b.edge;
  // south edge (+x)
  if (r0) pts.push({ x: b.minX + r0, z: b.minZ, kerb: !eS }); else pts.push({ x: b.minX, z: b.minZ, kerb: !eS });
  if (b.site) {
    const fe = spec.fence, g = spec.gate;
    pts.push({ x: g.minX, z: b.minZ, kerb: true }, { x: g.minX, z: fe.minZ, kerb: true });
    pts.push({ x: fe.minX, z: fe.minZ, kerb: true }, { x: fe.minX, z: fe.maxZ, kerb: true });
    pts.push({ x: fe.maxX, z: fe.maxZ, kerb: true }, { x: fe.maxX, z: fe.minZ, kerb: true });
    pts.push({ x: g.maxX, z: fe.minZ, kerb: true }, { x: g.maxX, z: b.minZ, kerb: !eS });
  }
  if (r1) arc(b.maxX - r1, b.minZ + r1, -Math.PI / 2, true); else pts.push({ x: b.maxX, z: b.minZ, kerb: !eE });
  // east edge (+z)
  if (r2) arc(b.maxX - r2, b.maxZ - r2, 0, true); else pts.push({ x: b.maxX, z: b.maxZ, kerb: !eN });
  // north edge (-x)
  if (r3) arc(b.minX + r3, b.maxZ - r3, Math.PI / 2, true); else pts.push({ x: b.minX, z: b.maxZ, kerb: !eW });
  // west edge (-z)
  if (r0) arc(b.minX + r0, b.minZ + r0, Math.PI, true);
  // de-duplicate coincident points (arc ends meet edge starts)
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.z - p.z) < 1e-6) { q.kerb = q.kerb && p.kerb; continue; }
    out.push(p);
  }
  const f = out[0], l = out[out.length - 1];
  if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.z - l.z) < 1e-6) out.pop();
  return out;
}

class GeoBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; }
  get n() { return this.pos.length / 3; }
  vert(x, y, z, nx = 0, ny = 1, nz = 0, u = 0, v = 0) {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(u, v);
    return this.n - 1;
  }
  // triangle guaranteed to face +y
  triUp(a, b, c) {
    const P = this.pos;
    const cross = (P[b * 3 + 2] - P[a * 3 + 2]) * (P[c * 3] - P[a * 3]) - (P[b * 3] - P[a * 3]) * (P[c * 3 + 2] - P[a * 3 + 2]);
    if (cross >= 0) this.idx.push(a, b, c); else this.idx.push(a, c, b);
  }
  quadXZ(x0, z0, x1, z1, y) {
    const a = this.vert(x0, y, z0), b = this.vert(x1, y, z0), c = this.vert(x1, y, z1), d = this.vert(x0, y, z1);
    this.triUp(a, b, c); this.triUp(a, c, d);
  }
  build(withUv = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (withUv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Carriageways (y = 0): straight segments, junction boxes, the fillets behind
// the kerb returns and the site gate crossover.
export function buildRoadGeometry(spec) {
  const { xs, zs, hw, BX, BZ, blocks, gate, fence } = spec;
  const G = new GeoBuilder();
  for (const zc of zs) {
    for (let k = 0; k < BX.length - 1; k++) {
      const x0 = BX[k].v + (BX[k].road ? hw : 0), x1 = BX[k + 1].v - (BX[k + 1].road ? hw : 0);
      if (x1 > x0) G.quadXZ(x0, zc - hw, x1, zc + hw, 0);
    }
  }
  for (const xc of xs) {
    for (let k = 0; k < BZ.length - 1; k++) {
      const z0 = BZ[k].v + (BZ[k].road ? hw : 0), z1 = BZ[k + 1].v - (BZ[k + 1].road ? hw : 0);
      if (z1 > z0) G.quadXZ(xc - hw, z0, xc + hw, z1, 0);
    }
  }
  for (const xc of xs) for (const zc of zs) G.quadXZ(xc - hw, zc - hw, xc + hw, zc + hw, 0);
  // fillets between the square block corner and the kerb return
  const seg = 8;
  for (const b of blocks) {
    const corners = [
      [b.minX, b.minZ, b.minX + b.r[0], b.minZ + b.r[0], Math.PI, b.r[0]],
      [b.maxX, b.minZ, b.maxX - b.r[1], b.minZ + b.r[1], -Math.PI / 2, b.r[1]],
      [b.maxX, b.maxZ, b.maxX - b.r[2], b.maxZ - b.r[2], 0, b.r[2]],
      [b.minX, b.maxZ, b.minX + b.r[3], b.maxZ - b.r[3], Math.PI / 2, b.r[3]],
    ];
    for (const [cx, cz, ox, oz, a0, r] of corners) {
      if (!r) continue;
      const c = G.vert(cx, 0, cz);
      let prev = null;
      for (let k = 0; k <= seg; k++) {
        const a = a0 + (k / seg) * (Math.PI / 2);
        const v = G.vert(ox + Math.cos(a) * r, 0, oz + Math.sin(a) * r);
        if (prev !== null) G.triUp(c, prev, v);
        prev = v;
      }
    }
  }
  // site gate crossover (dropped footway)
  const sb = blocks.find((b) => b.site);
  if (sb) G.quadXZ(gate.minX, sb.minZ, gate.maxX, fence.minZ, 0);
  return G.build();
}

// Block tops (y = TOP): sidewalks + lots, one triangulated polygon per block.
export function buildBlockGeometry(spec) {
  const G = new GeoBuilder();
  const outlines = [];
  for (const b of spec.blocks) {
    const ol = blockOutline(b, spec);
    outlines.push(ol);
    const contour = ol.map((p) => new THREE.Vector2(p.x, p.z));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = G.n;
    for (const p of ol) G.vert(p.x, TOP, p.z);
    for (const [a, c, d] of tris) G.triUp(base + a, base + c, base + d);
  }
  return { geometry: G.build(), outlines };
}

// Kerb faces: a 25 mm chamfer + slightly battered 165 mm face around every
// block outline (u = metres along the kerb for the stone joints, v = metres
// down the profile). Outward = right-hand side of the CCW outline.
export function buildKerbGeometry(outlines) {
  const G = new GeoBuilder();
  // profile: [outward offset, y]
  const prof = [[0, TOP], [0.025, TOP - 0.025], [0.035, -0.04]];
  const profV = [0, 0.035, 0.2];
  for (const ol of outlines) {
    const n = ol.length;
    // edge normals
    const en = [];
    for (let i = 0; i < n; i++) {
      const a = ol[i], b = ol[(i + 1) % n];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      en.push([dz / l, -dx / l, l]);
    }
    // per-vertex miter directions
    const miter = [];
    for (let i = 0; i < n; i++) {
      const e0 = en[(i - 1 + n) % n], e1 = en[i];
      let mx = e0[0] + e1[0], mz = e0[1] + e1[1];
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const cos = Math.max(0.3, mx * e1[0] + mz * e1[1]);
      miter.push([mx / cos, mz / cos, e0[0] * e1[0] + e0[1] * e1[1] > 0.8]); // smooth if < ~37°
    }
    let s = 0;
    for (let i = 0; i < n; i++) {
      const a = ol[i], b = ol[(i + 1) % n];
      const [nx, nz, len] = en[i];
      const ma = miter[i], mb = miter[(i + 1) % n];
      // smooth normals across gentle bends (arcs), crisp at real corners
      const na = ma[2] ? norm2(ma[0], ma[1]) : [nx, nz];
      const nb = mb[2] ? norm2(mb[0], mb[1]) : [nx, nz];
      for (let k = 0; k < prof.length - 1; k++) {
        const [o0, y0] = prof[k], [o1, y1] = prof[k + 1];
        // segment normal in the (outward, up) plane
        const so = y0 - y1, sy = o1 - o0, sl = Math.hypot(so, sy);
        const po = so / sl, py = sy / sl;
        const v0 = G.vert(a.x + ma[0] * o0, y0, a.z + ma[1] * o0, na[0] * po, py, na[1] * po, s, profV[k]);
        const v1 = G.vert(b.x + mb[0] * o0, y0, b.z + mb[1] * o0, nb[0] * po, py, nb[1] * po, s + len, profV[k]);
        const v2 = G.vert(b.x + mb[0] * o1, y1, b.z + mb[1] * o1, nb[0] * po, py, nb[1] * po, s + len, profV[k + 1]);
        const v3 = G.vert(a.x + ma[0] * o1, y1, a.z + ma[1] * o1, na[0] * po, py, na[1] * po, s, profV[k + 1]);
        // outward-facing winding
        G.idx.push(v0, v2, v3, v0, v1, v2);
      }
      s += len;
    }
  }
  return G.build(true);
}
const norm2 = (x, z) => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };

// Far field: the plane beyond D, as a frame of four quads. It sits 2 cm low
// and tucks 0.3 m under D's edge so there is never a crack at the seam.
// S = 4900 keeps the corners (6.9 km) inside the 7 km camera far plane, and
// from the cab the plane's edge sits only ~0.5° below the true horizon, where
// the sky's own below-horizon haze takes over.
export function buildFarGeometry(spec, S = 4900) {
  const { D } = spec;
  const G = new GeoBuilder();
  const y = -0.02, o = 0.3;
  G.quadXZ(-S, -S, S, D.minZ + o, y);
  G.quadXZ(-S, D.maxZ - o, S, S, y);
  G.quadXZ(-S, D.minZ + o, D.minX + o, D.maxZ - o, y);
  G.quadXZ(D.maxX - o, D.minZ + o, S, D.maxZ - o, y);
  return G.build();
}
