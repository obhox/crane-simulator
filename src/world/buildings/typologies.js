import * as THREE from 'three';
import { L as LY } from './surfaces.js';
import { STYLE, GROUND, FLAG } from './material.js';
import { NEIGHBOUR_EXCLUDE, insideRect } from '../layout.js';

// Building emitters. A building spec (from planner.js) is an axis-aligned
// footprint with a typology; this module turns it into walls (facade paint
// with real floor/bay grids), roofs (flat w/ parapet + clutter, gable, hip,
// mansard w/ dormers) and details (cornices, string courses, balconies,
// awnings, penthouses, plant screens, crowns). Party walls are computed
// against the other buildings of the lot, so blank fire walls appear exactly
// where a building rises above its neighbour — as in any real street.

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
export const SIDES = ['n', 'e', 's', 'w'];
const OUT = { n: [0, 1], e: [1, 0], s: [0, -1], w: [-1, 0] };
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' };

export function paint(o) {
  return { layer: LY.flat, style: STYLE.PLAIN, seed: 0, pack: 0, color: [0.5, 0.5, 0.5], grid: [3, 3, 0, 0], win: [0, 0, 0], gw: 0, ...o };
}

function sideLine(b, s) {
  switch (s) {
    case 'n': return { ax: b.x0, az: b.z1, bx: b.x1, bz: b.z1, L: b.x1 - b.x0 };
    case 'e': return { ax: b.x1, az: b.z1, bx: b.x1, bz: b.z0, L: b.z1 - b.z0 };
    case 's': return { ax: b.x1, az: b.z0, bx: b.x0, bz: b.z0, L: b.x1 - b.x0 };
    default: return { ax: b.x0, az: b.z0, bx: b.x0, bz: b.z1, L: b.z1 - b.z0 };
  }
}
// point at distance t along side s (walking direction), pushed `o` metres outward
export function sidePt(b, s, t, o = 0) {
  const l = sideLine(b, s);
  const dx = (l.bx - l.ax) / l.L, dz = (l.bz - l.az) / l.L;
  return [l.ax + dx * t + OUT[s][0] * o, l.az + dz * t + OUT[s][1] * o];
}
// axis-aligned rect of a band along side s: t0..t1 along, o0..o1 outward offsets
function sideRect(b, s, t0, t1, o0, o1) {
  const [ax, az] = sidePt(b, s, t0, o0), [bx, bz] = sidePt(b, s, t1, o1);
  return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)];
}

// Intervals of side s covered by touching neighbours (with their wall-top height)
function coverage(b, s, others) {
  const iv = [];
  const E = 0.08;
  for (const o of others) {
    if (o === b || o.base > 0.5) continue;
    let a0, a1, t0, t1;
    if (s === 'n' && Math.abs(o.z0 - b.z1) < E) { a0 = Math.max(b.x0, o.x0); a1 = Math.min(b.x1, o.x1); t0 = a0 - b.x0; t1 = a1 - b.x0; }
    else if (s === 's' && Math.abs(o.z1 - b.z0) < E) { a0 = Math.max(b.x0, o.x0); a1 = Math.min(b.x1, o.x1); t0 = b.x1 - a1; t1 = b.x1 - a0; }
    else if (s === 'e' && Math.abs(o.x0 - b.x1) < E) { a0 = Math.max(b.z0, o.z0); a1 = Math.min(b.z1, o.z1); t0 = b.z1 - a1; t1 = b.z1 - a0; }
    else if (s === 'w' && Math.abs(o.x1 - b.x0) < E) { a0 = Math.max(b.z0, o.z0); a1 = Math.min(b.z1, o.z1); t0 = a0 - b.z0; t1 = a1 - b.z0; }
    else continue;
    if (a1 - a0 > 0.1) iv.push({ t0, t1, h: o.eave });
  }
  return iv;
}
function pieces(L, iv) {
  const bp = new Set([0, L]);
  for (const i of iv) { bp.add(Math.max(0, Math.min(L, i.t0))); bp.add(Math.max(0, Math.min(L, i.t1))); }
  const xs = [...bp].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k < xs.length - 1; k++) {
    const t0 = xs[k], t1 = xs[k + 1];
    if (t1 - t0 < 0.05) continue;
    const m = (t0 + t1) / 2;
    let h = 0;
    for (const i of iv) if (m > i.t0 && m < i.t1) h = Math.max(h, i.h);
    const last = out[out.length - 1];
    if (last && Math.abs(last.h - h) < 1e-3 && Math.abs(last.t1 - t0) < 1e-3) last.t1 = t1;
    else out.push({ t0, t1, h });
  }
  return out;
}

// ------------------------------------------------------------------ facade paints
// A facade definition (b.fac) → paint for a wall of length L. `canyon` (0-15,
// ×6 m) is the distance to the building opposite, used by the shader to
// reflect that building instead of sky in the glazing (see cityCanyon).
function facadePaint(b, f, L, ground, canyon = 0) {
  const n = Math.max(1, Math.round(L / f.bay));
  const bw = L / n;
  let ww = f.ww;
  if (f.style === STYLE.PUNCHED) ww = Math.min(ww, bw - 0.45);
  return paint({
    layer: f.layer, style: f.style, seed: b.seed, pack: f.frame + 8 * f.glass, color: f.color,
    grid: [f.fh ?? b.fh, bw, ground === GROUND.NONE ? b.base : b.base + b.gh, f.topV ?? b.eave],
    win: [ww, f.wh, f.sill], gw: ground | (f.flags << 4) | (canyon << 8),
  });
}

// Street faces look across road + footways (~18 m); other faces across the
// courtyard / slab spacing to the nearest building of the lot, else open (90 m).
export function canyonCode(b, s, all) {
  const [ox, oz] = OUT[s];
  if (b.street[s]) {
    // across the road from the open construction site there is no street wall
    const l = sideLine(b, s);
    const mx = (l.ax + l.bx) / 2 + ox * 24, mz = (l.az + l.bz) / 2 + oz * 24;
    return insideRect(NEIGHBOUR_EXCLUDE, mx, mz) ? 15 : 3;
  }
  let best = 1e9;
  for (const o of all) {
    if (o === b || o.base > 0.5) continue;
    let d;
    if (ox === 0) {
      if (o.x1 <= b.x0 + 0.5 || o.x0 >= b.x1 - 0.5) continue;
      d = oz > 0 ? o.z0 - b.z1 : b.z0 - o.z1;
    } else {
      if (o.z1 <= b.z0 + 0.5 || o.z0 >= b.z1 - 0.5) continue;
      d = ox > 0 ? o.x0 - b.x1 : b.x0 - o.x1;
    }
    if (d > 0.5 && d < best) best = d;
  }
  return Math.max(2, Math.min(15, Math.round(best / 6)));
}
function blankPaint(b) {
  const f = b.fac;
  return paint({ layer: b.partyLayer ?? f.layer, style: STYLE.BLANK, seed: b.seed, color: b.partyColor ?? f.color.map((c) => c * 0.88), grid: [3, 3, 0, 0] });
}

// ------------------------------------------------------------------ walls
function emitWalls(g, b, all) {
  const top = b.wallTop;
  for (const s of SIDES) {
    const l = sideLine(b, s);
    const pcs = pieces(l.L, coverage(b, s, all));
    const street = b.street[s];
    for (const p of pcs) {
      const [ax, az] = sidePt(b, s, p.t0), [bx, bz] = sidePt(b, s, p.t1);
      if (p.h >= top - 0.01) continue;
      if (p.h > 0.01) {
        g.wall(ax, az, bx, bz, Math.max(p.h, b.base), top, blankPaint(b), p.t0);
        continue;
      }
      const f = street ? b.fac : (b.back || b.fac);
      const ground = street ? (b.shops[s] ? GROUND.SHOP : b.lobby ? GROUND.LOBBY : b.groundStyle ?? GROUND.BASE) : (b.gh > b.fh + 0.3 ? GROUND.PLAIN : GROUND.NONE);
      const pt = facadePaint(b, f, l.L, ground, canyonCode(b, s, all));
      if (b.crown > 0) {
        g.wall(ax, az, bx, bz, b.base, top - b.crown, pt, p.t0);
        g.wall(ax, az, bx, bz, top - b.crown, top, b.crownPaint, p.t0);
      } else {
        g.wall(ax, az, bx, bz, b.base, top, pt, p.t0);
      }
    }
  }
}

// ------------------------------------------------------------------ roofs
function roofQuad(g, x0, z0, x1, z1, y, p) {
  if (x1 - x0 < 0.05 || z1 - z0 < 0.05) return;
  g.quad(V3(x0, y, z1), V3(x1, y, z1), V3(x1, y, z0), V3(x0, y, z0), p);
}

// flat roof inside a parapet ring (outer faces are the facade walls)
function flatRoof(g, b, x0, z0, x1, z1, y, parH, roofP, parP, copeP) {
  const t = 0.28;
  roofQuad(g, x0 + t, z0 + t, x1 - t, z1 - t, y, roofP);
  if (parH <= 0.01) return;
  const yt = y + parH;
  // inner parapet faces
  g.wall(x1 - t, z1 - t, x0 + t, z1 - t, y, yt, parP);
  g.wall(x0 + t, z0 + t, x1 - t, z0 + t, y, yt, parP);
  g.wall(x1 - t, z0 + t, x1 - t, z1 - t, y, yt, parP);
  g.wall(x0 + t, z1 - t, x0 + t, z0 + t, y, yt, parP);
  // coping: top of the parapet ring, slightly proud of the wall
  const o = 0.04;
  roofQuad(g, x0 - o, z1 - t, x1 + o, z1 + o, yt, copeP);
  roofQuad(g, x0 - o, z0 - o, x1 + o, z0 + t, yt, copeP);
  roofQuad(g, x0 - o, z0 + t, x0 + t, z1 - t, yt, copeP);
  roofQuad(g, x1 - t, z0 + t, x1 + o, z1 - t, yt, copeP);
  // coping drip edge
  const d = 0.07;
  g.wall(x0 - o, z1 + o, x1 + o, z1 + o, yt - d, yt, copeP);
  g.wall(x1 + o, z0 - o, x0 - o, z0 - o, yt - d, yt, copeP);
  g.wall(x1 + o, z1 + o, x1 + o, z0 - o, yt - d, yt, copeP);
  g.wall(x0 - o, z0 - o, x0 - o, z1 + o, yt - d, yt, copeP);
}

// Local frame for pitched roofs: a = along the ridge, c = across. axis 'x' → a=x, c=z.
function mapper(axis) {
  return axis === 'x' ? (a, y, c) => V3(a, y, c) : (a, y, c) => V3(c, y, a);
}
// Gable (hip=false) or hip roof over [a0,a1]×[c0,c1] at eave height H.
function pitchedRoof(g, axis, a0, a1, c0, c1, H, pitch, oh, roofP, gableP, hip, fasciaP) {
  const M = mapper(axis);
  const flip = axis === 'z'; // swapping x/z mirrors the winding
  const q = (p0, p1, p2, p3, p) => (flip ? g.quad(p3, p2, p1, p0, p) : g.quad(p0, p1, p2, p3, p));
  const t3 = (p0, p1, p2, p) => (flip ? g.triangle(p2, p1, p0, p) : g.triangle(p0, p1, p2, p));
  const tp = Math.tan(pitch);
  const hc = (c1 - c0) / 2, cm = (c0 + c1) / 2;
  const rise = hc * tp;
  const eY = H - oh * tp;
  const ea0 = hip ? a0 - oh : a0, ea1 = hip ? a1 + oh : a1;
  let r0 = hip ? a0 + hc : a0, r1 = hip ? a1 - hc : a1;
  if (r0 > r1) r0 = r1 = (a0 + a1) / 2;
  const ry = H + rise;
  q(M(ea0, eY, c1 + oh), M(ea1, eY, c1 + oh), M(r1, ry, cm), M(r0, ry, cm), roofP);
  q(M(ea1, eY, c0 - oh), M(ea0, eY, c0 - oh), M(r0, ry, cm), M(r1, ry, cm), roofP);
  if (hip) {
    t3(M(ea1, eY, c1 + oh), M(ea1, eY, c0 - oh), M(r1, ry, cm), roofP);
    t3(M(ea0, eY, c0 - oh), M(ea0, eY, c1 + oh), M(r0, ry, cm), roofP);
  } else {
    t3(M(a1, H, c1), M(a1, H, c0), M(a1, ry, cm), gableP);
    t3(M(a0, H, c0), M(a0, H, c1), M(a0, ry, cm), gableP);
  }
  // fascia boards along the eaves (reads as the gutter line from the street)
  if (fasciaP) {
    const fy = 0.18;
    q(M(ea1, eY - fy, c1 + oh), M(ea0, eY - fy, c1 + oh), M(ea0, eY, c1 + oh), M(ea1, eY, c1 + oh), fasciaP);
    q(M(ea0, eY - fy, c0 - oh), M(ea1, eY - fy, c0 - oh), M(ea1, eY, c0 - oh), M(ea0, eY, c0 - oh), fasciaP);
    // soffits (seen from the street looking up)
    q(M(ea0, eY - fy, c1 + oh), M(ea1, eY - fy, c1 + oh), M(ea1, eY - fy, c1), M(ea0, eY - fy, c1), fasciaP);
    q(M(ea1, eY - fy, c0 - oh), M(ea0, eY - fy, c0 - oh), M(ea0, eY - fy, c0), M(ea1, eY - fy, c0), fasciaP);
  }
  return ry;
}

// Mansard: steep lower slopes (inset only on exposed sides) + flat zinc top.
function mansard(g, b, H, hm, slopeP, topP, party) {
  const ins = {};
  for (const s of SIDES) ins[s] = party[s] ? 0 : hm / Math.tan(THREE.MathUtils.degToRad(72));
  const x0 = b.x0, x1 = b.x1, z0 = b.z0, z1 = b.z1;
  const tx0 = x0 + ins.w, tx1 = x1 - ins.e, tz0 = z0 + ins.s, tz1 = z1 - ins.n;
  const yt = H + hm;
  const faceP = (s) => (party[s] ? b.partyPaint : slopeP);
  g.quad(V3(x0, H, z1), V3(x1, H, z1), V3(tx1, yt, tz1), V3(tx0, yt, tz1), faceP('n'));
  g.quad(V3(x1, H, z0), V3(x0, H, z0), V3(tx0, yt, tz0), V3(tx1, yt, tz0), faceP('s'));
  g.quad(V3(x1, H, z1), V3(x1, H, z0), V3(tx1, yt, tz0), V3(tx1, yt, tz1), faceP('e'));
  g.quad(V3(x0, H, z0), V3(x0, H, z1), V3(tx0, yt, tz1), V3(tx0, yt, tz0), faceP('w'));
  roofQuad(g, tx0, tz0, tx1, tz1, yt, topP);
  return { tx0, tx1, tz0, tz1, yt, ins };
}

// ------------------------------------------------------------------ small parts
const ZINC = (seed, c = [0.62, 0.64, 0.66]) => paint({ layer: LY.zinc, seed, color: c });
const FLATP = (c, seed = 0) => paint({ layer: LY.flat, seed, color: c });

function occupied(occ, r) {
  for (const o of occ) if (r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1]) return true;
  return false;
}
function place(occ, r, rect, w, d, margin = 0.6, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const x = rect[0] + margin + r() * Math.max(0, rect[2] - rect[0] - w - 2 * margin);
    const z = rect[1] + margin + r() * Math.max(0, rect[3] - rect[1] - d - 2 * margin);
    const c = [x, z, x + w, z + d];
    if (c[2] > rect[2] - margin + 1e-3 || c[3] > rect[3] - margin + 1e-3) continue;
    if (!occupied(occ, [c[0] - 0.4, c[1] - 0.4, c[2] + 0.4, c[3] + 0.4])) { occ.push(c); return c; }
  }
  return null;
}

// HVAC / condenser: casing + fan deck on top
function hvac(g, x0, z0, x1, z1, y, h, seed, col) {
  const side = paint({ layer: LY.panel, seed, color: col });
  const top = paint({ layer: LY.panel, style: STYLE.FAN, seed, color: col, grid: [Math.min(x1 - x0, z1 - z0) * 0.36, Math.min(x1 - x0, z1 - z0), 0, 0] });
  g.box(x0, y, z0, x1, y + h, z1, side, top, 'nestwt');
}

// Rooftop clutter on a flat roof rect at height y. Realistic mix by typology.
function roofClutter(g, b, rect, y, r, dens, lights) {
  const occ = (b.roofHoles || []).map((h) => h.slice()); // tower footprints / masts above this roof
  const w = rect[2] - rect[0], d = rect[3] - rect[1];
  const area = w * d;
  if (w < 4 || d < 4) return;
  const seed = b.seed;
  g.detail = 0;
  // lift overrun + stair access in the building's own wall material
  if (b.floors >= 5 && area > 80) {
    const c = place(occ, r, rect, 2.4 + r() * 0.8, 2.6 + r() * 1.2, 1.2);
    if (c) {
      const hh = 2.6 + r() * 0.8;
      const wp = paint({ layer: b.fac.layer === LY.brick || b.fac.layer === LY.brick_old ? b.fac.layer : LY.concrete, seed, color: b.fac.layer === LY.plaster ? b.fac.color : [0.75, 0.75, 0.73] });
      g.box(c[0], y, c[1], c[2], y + hh, c[3], wp, paint({ layer: LY.membrane, seed, color: [0.5, 0.5, 0.52] }), 'nestwt');
      if (lights && b.eave > 45) lights.push([(c[0] + c[2]) / 2, y + hh + 0.3, (c[1] + c[3]) / 2]);
    }
  }
  g.detail = 1;
  if (area > 60 && r() < 0.85) {
    const c = place(occ, r, rect, 1.3, 2.0, 1.0);
    if (c) g.box(c[0], y, c[1], c[2], y + 2.3, c[3], paint({ layer: LY.panel, seed, color: [0.45, 0.46, 0.47] }), paint({ layer: LY.membrane, seed, color: [0.5, 0.5, 0.5] }), 'nestwt');
  }
  // plant: condensers / AHUs (offices get big ones)
  const office = b.kind === 'office' || b.kind === 'tower' || b.kind === 'podium' || b.kind === 'shed';
  const nH = Math.round(Math.min(14, area / (office ? 45 : 110)) * dens * (0.5 + r()));
  for (let i = 0; i < nH; i++) {
    const big = office && r() < 0.5;
    const cw = big ? 2.2 + r() * 2.5 : 0.9 + r() * 1.1, cd = big ? 1.6 + r() * 1.2 : 0.8 + r() * 0.8;
    const c = place(occ, r, rect, cw, cd, 0.9);
    if (!c) continue;
    const col = [[0.78, 0.79, 0.8], [0.62, 0.64, 0.66], [0.85, 0.84, 0.8], [0.5, 0.52, 0.55]][Math.floor(r() * 4)];
    hvac(g, c[0], c[1], c[2], c[3], y, big ? 1.4 + r() * 0.8 : 0.7 + r() * 0.6, seed + i, col);
  }
  // vent stacks / soil pipes
  const nV = Math.round((2 + area / 120) * dens);
  for (let i = 0; i < nV; i++) {
    const c = place(occ, r, rect, 0.5, 0.5, 0.8, 4);
    if (c) g.cyl((c[0] + c[2]) / 2, y, (c[1] + c[3]) / 2, 0.08 + r() * 0.15, 0.5 + r() * 1.1, 6, ZINC(seed));
  }
  // skylights / roof hatches
  if (r() < 0.6) {
    const n = 1 + Math.floor(r() * 3 * dens);
    for (let i = 0; i < n; i++) {
      const c = place(occ, r, rect, 1.2 + r() * 1.5, 1.2 + r() * 2.5, 1.0, 4);
      if (c) g.box(c[0], y, c[1], c[2], y + 0.45, c[3], FLATP([0.75, 0.75, 0.74], seed), paint({ layer: LY.flat, style: STYLE.GLASS, seed, color: [0.3, 0.33, 0.35] }), 'nestwt');
    }
  }
  // photovoltaic array (tilted towards the sun side, +z here), rows 2 modules deep
  if (!b.noSolar && r() < (b.kind === 'modern' || b.kind === 'shed' ? 0.65 : 0.3)) {
    const rw = Math.min(w - 3, 4 + r() * 14), rows = Math.max(1, Math.floor(Math.min(d - 3, 3 + r() * 12) / 3.2));
    const c = place(occ, r, rect, rw, rows * 3.2, 1.2, 6);
    if (c) {
      const tilt = THREE.MathUtils.degToRad(15 + r() * 15);
      const sp = paint({ layer: LY.flat, style: STYLE.SOLAR, seed, color: [0.2, 0.2, 0.25] });
      for (let k = 0; k < rows; k++) {
        const z0 = c[1] + k * 3.2, depth = 2.0;
        const yl = y + 0.35, yh = yl + depth * Math.sin(tilt), z1 = z0 + depth * Math.cos(tilt);
        // module plane rises towards -z → faces +z (sun side)
        g.quad(V3(c[0], yh, z0), V3(c[2], yh, z0), V3(c[2], yl, z1), V3(c[0], yl, z1), sp);
        g.quad(V3(c[2], yh, z0), V3(c[0], yh, z0), V3(c[0], y, z0), V3(c[2], y, z0), FLATP([0.3, 0.3, 0.3]));
      }
    }
  }
  // water tank (older blocks) / antennas / dishes
  if ((b.kind === 'postwar' || b.kind === 'classic') && r() < 0.25) {
    const c = place(occ, r, rect, 3, 3, 1.2, 4);
    if (c) {
      const cx = (c[0] + c[2]) / 2, cz = (c[1] + c[3]) / 2;
      g.box(c[0] + 0.3, y, c[1] + 0.3, c[2] - 0.3, y + 1.2, c[3] - 0.3, FLATP([0.25, 0.22, 0.2]), FLATP([0.25, 0.22, 0.2]), 'nestwt');
      g.cyl(cx, y + 1.2, cz, 1.35, 2.4, 12, paint({ layer: LY.wood, seed, color: [0.7, 0.6, 0.5] }));
    }
  }
  const nA = r() < 0.5 ? 1 + Math.floor(r() * 2) : 0;
  for (let i = 0; i < nA; i++) {
    const c = place(occ, r, rect, 0.6, 0.6, 1.0, 4);
    if (!c) continue;
    const hA = 2 + r() * (b.eave > 40 ? 8 : 4);
    g.box(c[0] + 0.25, y, c[1] + 0.25, c[0] + 0.33, y + hA, c[1] + 0.33, FLATP([0.25, 0.25, 0.26]), FLATP([0.25, 0.25, 0.26]), 'nestwt');
    if (r() < 0.6) g.box(c[0] - 0.4, y + hA * 0.8, c[1] + 0.27, c[0] + 0.9, y + hA * 0.8 + 0.04, c[1] + 0.31, FLATP([0.3, 0.3, 0.3]), FLATP([0.3, 0.3, 0.3]), 'nestwt');
    if (lights && b.eave > 45) lights.push([c[0] + 0.29, y + hA + 0.15, c[1] + 0.29]);
  }
  if (b.kind !== 'office' && b.kind !== 'tower' && r() < 0.5) {
    const c = place(occ, r, rect, 0.9, 0.9, 0.5, 4);
    if (c) g.cyl((c[0] + c[2]) / 2, y + 0.4, (c[1] + c[3]) / 2, 0.38, 0.08, 10, FLATP([0.8, 0.8, 0.8]));
  }
  g.detail = 0;
}

// ------------------------------------------------------------------ details
function cornice(g, b, s, y, proj, h, p, t0 = 0, t1 = null) {
  const l = sideLine(b, s);
  const e = t1 ?? l.L;
  const [x0, z0, x1, z1] = sideRect(b, s, t0, e, 0, proj);
  const faces = { n: 'newtb', s: 'sewtb', e: 'enstb', w: 'wnstb' }[s];
  g.box(x0, y, z0, x1, y + h, z1, p, p, faces);
}

function balconies(g, b, s, r, kindB) {
  const f = b.fac;
  const l = sideLine(b, s);
  const n = Math.max(1, Math.round(l.L / f.bay));
  const bw = l.L / n;
  const depth = kindB === 'postwar' ? 1.3 : 1.2 + r() * 0.5;
  const pattern = Math.floor(r() * 3); // 0 every bay, 1 every other, 2 pairs
  const slabP = paint({ layer: LY.concrete, seed: b.seed, color: [0.82, 0.82, 0.8] });
  const frontType = kindB === 'postwar' ? 0 : Math.floor(r() * 3); // 0 solid, 1 glass, 2 metal panel
  const frontP = frontType === 0 ? paint({ layer: b.fac.layer === LY.plaster ? LY.plaster : LY.concrete, seed: b.seed, color: frontType === 0 && r() < 0.4 ? [0.85, 0.5, 0.35] : f.color })
    : frontType === 1 ? paint({ layer: LY.flat, style: STYLE.GLASS, seed: b.seed, color: [0.55, 0.62, 0.62] })
    : paint({ layer: LY.panel, seed: b.seed, color: [[0.1, 0.1, 0.11], [0.85, 0.85, 0.83], [0.35, 0.36, 0.37]][Math.floor(r() * 3)] });
  const firstFloor = b.base + b.gh;
  const floors = b.upFloors;
  for (let k = 0; k < n; k++) {
    if (pattern === 1 && k % 2) continue;
    if (pattern === 2 && k % 3 === 2) continue;
    const t0 = k * bw + 0.25, t1 = (k + 1) * bw - 0.25;
    for (let i = 0; i < floors; i++) {
      const y = firstFloor + i * b.fh;
      const [x0, z0, x1, z1] = sideRect(b, s, t0, t1, 0, depth);
      const faces = { n: 'newtb', s: 'sewtb', e: 'enstb', w: 'wnstb' }[s];
      g.box(x0, y - 0.2, z0, x1, y, z1, slabP, slabP, faces);
      // balustrade: front + two cheeks
      const [fx0, fz0, fx1, fz1] = sideRect(b, s, t0, t1, depth - 0.06, depth);
      g.box(fx0, y, fz0, fx1, y + 1.05, fz1, frontP, frontP, faces.replace('b', ''));
      if (pattern !== 0) {
        // side cheeks (only the two faces perpendicular to the facade)
        const cf = s === 'n' || s === 's' ? 'ew' : 'ns';
        const [ax0, az0, ax1, az1] = sideRect(b, s, t0, t0 + 0.05, 0, depth - 0.06);
        const [bx0, bz0, bx1, bz1] = sideRect(b, s, t1 - 0.05, t1, 0, depth - 0.06);
        g.box(ax0, y, az0, ax1, y + 1.05, az1, frontP, frontP, cf);
        g.box(bx0, y, bz0, bx1, y + 1.05, bz1, frontP, frontP, cf);
      }
    }
  }
}

const AWNING_COLS = [[0.1, 0.25, 0.14], [0.35, 0.05, 0.06], [0.06, 0.09, 0.2], [0.05, 0.05, 0.05], [0.75, 0.7, 0.6], [0.6, 0.18, 0.06], [0.2, 0.35, 0.35]];
function awnings(g, b, s, r) {
  const f = b.fac;
  const l = sideLine(b, s);
  const nb = Math.max(1, Math.round(l.L / f.bay));
  const bw = l.L / nb;
  const shopW = Math.max(bw * 2, 5);
  const nShop = Math.floor(l.L / shopW);
  const gh = b.gh;
  for (let i = 0; i < nShop; i++) {
    if (r() > 0.45) continue;
    const t0 = i * shopW + 0.55, t1 = (i + 1) * shopW - 0.55;
    const ytop = b.base + gh - 1.22, ybot = ytop - 0.55, proj = 1.3;
    const col = AWNING_COLS[Math.floor(r() * AWNING_COLS.length)];
    const p = paint({ layer: LY.flat, style: STYLE.AWNING, seed: b.seed, pack: r() < 0.4 ? 1 : 0, color: col });
    const [ax, az] = sidePt(b, s, t0, 0), [bx, bz] = sidePt(b, s, t1, 0);
    const [cx, cz] = sidePt(b, s, t1, proj), [dx, dz] = sidePt(b, s, t0, proj);
    // sloping canvas (top) + underside + valance
    g.quad(V3(dx, ybot, dz), V3(cx, ybot, cz), V3(bx, ytop, bz), V3(ax, ytop, az), p);
    g.quad(V3(ax, ytop - 0.02, az), V3(bx, ytop - 0.02, bz), V3(cx, ybot - 0.02, cz), V3(dx, ybot - 0.02, dz), p);
    g.wall(dx, dz, cx, cz, ybot - 0.28, ybot, p);
  }
}

// ------------------------------------------------------------------ main emitter
export function emitBuilding(g, b, all, r, dens, lights) {
  if (b.noLights) lights = null; // lower tiers of a stepped tower: lights go on the top only
  g.detail = 0;
  emitWalls(g, b, all);
  const H = b.eave;
  const f = b.fac;
  const roofCol = b.roofColor ?? [0.55, 0.55, 0.56];
  const copeP = paint({ layer: b.kind === 'classic' ? LY.stone : LY.zinc, seed: b.seed, color: b.kind === 'classic' ? [0.8, 0.78, 0.72] : [0.7, 0.71, 0.72] });
  const party = {};
  for (const s of SIDES) party[s] = !b.street[s] && pieces(sideLine(b, s).L, coverage(b, s, all)).some((p) => p.h > 1);
  b.partyPaint = blankPaint(b);

  // street-side cornices / string courses (classic)
  if (b.kind === 'classic') {
    g.detail = 0;
    const cp = paint({ layer: LY.stone, seed: b.seed, color: [0.86, 0.83, 0.76] });
    for (const s of SIDES) {
      if (!b.street[s]) continue;
      cornice(g, b, s, H - 0.55, 0.55, 0.5, cp);
      g.detail = 1;
      cornice(g, b, s, H - 0.85, 0.2, 0.18, cp);
      if (b.gh > 0) cornice(g, b, s, b.base + b.gh - 0.05, 0.14, 0.28, cp);
      g.detail = 0;
    }
  }

  // roof
  if (b.roof === 'flat') {
    const parH = b.wallTop - H;
    const roofP = paint({ layer: b.roofLayer ?? LY.membrane, seed: b.seed, color: roofCol });
    const parP = b.crownType === 'screen' ? b.crownPaint : paint({ layer: f.layer === LY.plaster ? LY.plaster : LY.concrete, seed: b.seed, color: [0.7, 0.7, 0.69] });
    if (b.mast) {
      // telecom mast off-centre on the roof (kept clear of the plant)
      const mx = b.x0 + (b.x1 - b.x0) * (0.3 + r() * 0.4), mz = b.z0 + (b.z1 - b.z0) * (0.3 + r() * 0.4);
      b.roofHoles = [...(b.roofHoles || []), [mx - 2, mz - 2, mx + 2, mz + 2]];
      mastAt(g, b, mx, mz, H, lights);
    }
    if (b.penthouse) {
      // recessed top storey: terrace in front (street side), roof above
      const ps = b.penthouseSide;
      const set = 2.6;
      const px0 = b.x0 + (ps === 'w' ? set : 0.8), px1 = b.x1 - (ps === 'e' ? set : 0.8);
      const pz0 = b.z0 + (ps === 's' ? set : 0.8), pz1 = b.z1 - (ps === 'n' ? set : 0.8);
      const deckP = paint({ layer: LY.wood, seed: b.seed, color: [0.85, 0.75, 0.62] });
      flatRoof(g, b, b.x0, b.z0, b.x1, b.z1, H, parH, deckP, parP, copeP);
      const ph = b.fh;
      const pb = { ...b, x0: px0, x1: px1, z0: pz0, z1: pz1, base: H, eave: H + ph, wallTop: H + ph + 0.5, crown: 0, street: { n: true, e: true, s: true, w: true }, shops: {}, gh: 0, lobby: false };
      const pf = { ...b.fac, style: STYLE.PUNCHED, bay: b.fac.bay, ww: Math.min(2.4, b.fac.bay - 0.5), wh: 2.35, sill: 0.1, topV: H + ph };
      pb.fac = pf; pb.back = pf;
      for (const s of SIDES) {
        const l = sideLine(pb, s);
        const [ax, az] = sidePt(pb, s, 0), [bx, bz] = sidePt(pb, s, l.L);
        g.wall(ax, az, bx, bz, H, pb.wallTop, facadePaint(pb, pf, l.L, GROUND.NONE, b.street[s] ? 3 : 10));
      }
      flatRoof(g, pb, px0, pz0, px1, pz1, H + ph, 0.5, paint({ layer: LY.gravel, seed: b.seed, color: [0.8, 0.8, 0.8] }), parP, copeP);
      roofClutter(g, { ...b, floors: b.floors + 1 }, [px0 + 0.3, pz0 + 0.3, px1 - 0.3, pz1 - 0.3], H + ph, r, dens, lights);
    } else {
      flatRoof(g, b, b.x0, b.z0, b.x1, b.z1, H, parH, roofP, parP, copeP);
      if (b.plantScreen) {
        // louvred plant enclosure (offices / towers)
        const w = b.x1 - b.x0, d = b.z1 - b.z0;
        const ex0 = b.x0 + w * (0.2 + r() * 0.1), ex1 = b.x1 - w * (0.2 + r() * 0.1);
        const ez0 = b.z0 + d * (0.2 + r() * 0.1), ez1 = b.z1 - d * (0.2 + r() * 0.1);
        const eh = 3.2 + r() * 1.5;
        const lp = paint({ layer: LY.panel, style: STYLE.LOUVRE, seed: b.seed, color: b.screenColor ?? [0.55, 0.56, 0.58] });
        const tp = paint({ layer: LY.panel, style: STYLE.FAN, seed: b.seed, color: [0.5, 0.5, 0.52], grid: [0.85, 2.4, 0, 0] });
        g.box(ex0, H, ez0, ex1, H + eh, ez1, lp, tp, 'nestwt');
        const rest = [b.x0 + 0.5, b.z0 + 0.5, b.x1 - 0.5, b.z1 - 0.5];
        roofClutter(g, { ...b, floors: 0 }, rest, H, r, dens * 0.4, lights);
        if (lights && H > 45) for (const [x, z] of [[ex0, ez0], [ex1, ez1], [ex0, ez1], [ex1, ez0]]) lights.push([x, H + eh + 0.2, z]);
      } else {
        roofClutter(g, b, [b.x0 + 0.3, b.z0 + 0.3, b.x1 - 0.3, b.z1 - 0.3], H, r, dens, lights);
      }
    }
    if (lights && H > 45) for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z1], [b.x0, b.z1], [b.x1, b.z0]]) lights.push([x, b.wallTop + 0.15, z]);
  } else if (b.roof === 'mansard') {
    const slopeP = paint({ layer: LY.rooftile, seed: b.seed, color: [0.3, 0.31, 0.34] });
    const topP = paint({ layer: LY.seam, seed: b.seed, color: [0.55, 0.57, 0.6] });
    const hm = 3.3;
    const m = mansard(g, b, H, hm, slopeP, topP, party);
    // dormers aligned with the window bays
    g.detail = 1;
    for (const s of SIDES) {
      if (party[s] || m.ins[s] <= 0) continue;
      const l = sideLine(b, s);
      const nb = Math.max(1, Math.round(l.L / f.bay)), bw = l.L / nb;
      const dp = paint({ layer: LY.plaster, style: STYLE.PUNCHED, seed: b.seed, pack: f.frame, color: [0.85, 0.83, 0.78], grid: [2.3, 1.4, H + 0.3, H + 2.4], win: [0.85, 1.35, 0.3], gw: 0 });
      for (let k = 0; k < nb; k++) {
        if (k === 0 || k === nb - 1) continue;
        dormer(g, b, s, (k + 0.5) * bw, 0.7, 2.2, 0.35, H + 0.3, H + 2.4, dp, ZINC(b.seed, [0.5, 0.52, 0.55]), ZINC(b.seed, [0.5, 0.52, 0.55]));
      }
    }
    g.detail = 1;
    chimneys(g, b, r, m.yt, [m.tx0, m.tz0, m.tx1, m.tz1]);
    g.detail = 0;
  } else {
    // gable / hip, ridge parallel to the main street frontage
    const ms = b.mainSide;
    const axis = ms === 'n' || ms === 's' ? 'x' : 'z';
    const pitch = THREE.MathUtils.degToRad(b.pitch ?? 38);
    const tileCol = b.tileColor ?? [0.62, 0.28, 0.17];
    const roofP = paint({ layer: b.roofLayer ?? LY.rooftile, seed: b.seed, color: tileCol });
    const fasciaP = FLATP([0.12, 0.1, 0.09]);
    const hip = b.roof === 'hip';
    const [a0, a1, c0, c1] = axis === 'x' ? [b.x0, b.x1, b.z0, b.z1] : [b.z0, b.z1, b.x0, b.x1];
    const ry = pitchedRoof(g, axis, a0, a1, c0, c1, H, pitch, 0.35, roofP, b.partyPaint, hip, fasciaP);
    // dormers on the street slope, roof windows on the back
    g.detail = 1;
    if (b.dormers) {
      const l = sideLine(b, ms);
      const nb = Math.max(1, Math.round(l.L / f.bay)), bw = l.L / nb;
      const dp = paint({ layer: f.layer, style: STYLE.PUNCHED, seed: b.seed, pack: f.frame, color: f.color, grid: [2.1, 1.5, H + 0.25, H + 2.2], win: [0.9, 1.2, 0.35], gw: 0 });
      for (let k = 1; k < nb - 1; k += 2) {
        dormer(g, b, ms, (k + 0.5) * bw, 0.75, 2.8, 0.6, H + 0.25, H + 2.2, dp, paint({ layer: f.layer, seed: b.seed, color: f.color }), roofP);
      }
    }
    chimneys(g, b, r, ry, [b.x0 + 1, b.z0 + 1, b.x1 - 1, b.z1 - 1]);
    g.detail = 0;
  }

  // balconies, awnings
  g.detail = 1;
  if (b.balconies) {
    for (const s of SIDES) {
      const want = b.balconies === 'both' || (b.balconies === 'street' ? b.street[s] : !b.street[s] && !party[s]);
      if (!want) continue;
      const cov = pieces(sideLine(b, s).L, coverage(b, s, all));
      if (cov.some((p) => p.h > 1)) continue;
      balconies(g, b, s, r, b.kind);
    }
  }
  for (const s of SIDES) if (b.street[s] && b.shops[s]) awnings(g, b, s, r);
  g.detail = 0;
}

// Telecom / broadcast mast: tapered steel shaft, antenna platform with panel
// antennas and dishes, aircraft warning lamp on top.
function mastAt(g, b, x, z, y, lights) {
  const h = b.mast;
  const steel = ZINC(b.seed, [0.72, 0.72, 0.7]);
  const red = FLATP([0.62, 0.12, 0.08]);
  g.detail = 0;
  g.box(x - 1.2, y, z - 1.2, x + 1.2, y + 0.6, z + 1.2, FLATP([0.55, 0.55, 0.54]), FLATP([0.55, 0.55, 0.54]), 'nestwt');
  g.box(x - 0.4, y + 0.6, z - 0.4, x + 0.4, y + h * 0.55, z + 0.4, steel, steel, 'nestw');
  g.box(x - 0.25, y + h * 0.55, z - 0.25, x + 0.25, y + h * 0.85, z + 0.25, steel, steel, 'nestw');
  // red/white banding on the top section (aviation marking)
  for (let k = 0; k < 3; k++) {
    const y0 = y + h * (0.85 + k * 0.05);
    g.box(x - 0.16, y0, z - 0.16, x + 0.16, y0 + h * 0.05, z + 0.16, k % 2 ? steel : red, k % 2 ? steel : red, 'nestw');
  }
  g.detail = 1;
  const py = y + h * 0.5;
  g.box(x - 1.5, py, z - 1.5, x + 1.5, py + 0.12, z + 1.5, steel, steel, 'nestwtb');
  for (const [dx, dz] of [[1.3, 0], [-1.3, 0], [0, 1.3], [0, -1.3]]) {
    g.box(x + dx - 0.18, py + 0.3, z + dz - 0.18, x + dx + 0.18, py + 2.6, z + dz + 0.18, FLATP([0.85, 0.85, 0.83]), FLATP([0.85, 0.85, 0.83]), 'nestwt');
  }
  g.cyl(x + 0.9, py + 3.2, z + 0.9, 0.45, 0.12, 10, FLATP([0.85, 0.85, 0.83]));
  g.detail = 0;
  if (lights) lights.push([x, y + h + 0.3, z]);
}

// Box dormer set into a roof slope: cheeks + roof, with a real window grid on the front.
function dormer(g, b, s, tc, hw, dIn, dOut, y0, y1, frontP, sideP, topP) {
  const [x0, z0, x1, z1] = sideRect(b, s, tc - hw, tc + hw, -dIn, -dOut);
  g.box(x0, y0, z0, x1, y1, z1, sideP, topP, s === 'n' || s === 's' ? 'ewt' : 'nst', true);
  const [ax, az] = sidePt(b, s, tc - hw, -dOut), [bx, bz] = sidePt(b, s, tc + hw, -dOut);
  g.wall(ax, az, bx, bz, y0, y1, frontP, tc - hw);
}

function chimneys(g, b, r, ridgeY, rect) {
  if (!b.chimneys) return;
  const p = paint({ layer: LY.brick_old, seed: b.seed, color: [0.8, 0.7, 0.65] });
  const cap = FLATP([0.25, 0.24, 0.23]);
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const x = rect[0] + r() * (rect[2] - rect[0] - 1.2), z = rect[1] + r() * (rect[3] - rect[1] - 0.6);
    const top = ridgeY + 0.6 + r() * 0.8;
    g.box(x, ridgeY - 3.5, z, x + 1.1, top, z + 0.55, p, cap, 'nestwt');
    g.box(x - 0.06, top, z - 0.06, x + 1.16, top + 0.1, z + 0.61, cap, cap, 'nestwt');
    for (let k = 0; k < 3; k++) g.cyl(x + 0.2 + k * 0.35, top + 0.1, z + 0.28, 0.08, 0.35, 6, paint({ layer: LY.flat, seed: b.seed, color: [0.55, 0.32, 0.2] }), false);
  }
}

export { OPP };
