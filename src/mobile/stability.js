// AT-100 5.1 stability model (spec §4, §1.3): body list, centre of pressure,
// support pose / reaction solver, stability states and the deterministic
// tip-over rigid rotation. Pure math, no three.js import: points are written
// into any {x, y, z} object and matrices through Matrix4.set(), so the module
// also runs under plain node (scripts/test-mobile-stability.mjs).
//
// Frames (§0): world three.js (+y up). Carrier frame C: x forward, y left,
// z up, origin on the slew axis at ground level in road stance (frame datum
// 1.30 m above it). The support solver works in C: every support imposes a
// frame-datum height h at its (x, y); the carrier rests on the upper hull of
// those points under the centre of pressure (CoP).
//
// Per 120 Hz step (see HOW TO INTEGRATE in the WP report):
//   fillBodies(bodiesC, {psi, theta, ext, dv, dl, cwKg, deckKg, deckH, deckZ})
//   stab.setCarrier(x, z, yaw)
//   stab.update(dt, stab.bodiesWorld(bodiesC), ropeForceWorld, headWorldUntipped, outriggers.supports(stab.pose, ...))
// The load is NOT a body: the rope force (tension · unit(head → hook)) acts at
// the head, so swing, snatch and slack rope all reach the stability model.

import { AT100, STABILITY, FLOATS } from './config.js';

const G = 9.81;
const DEG = Math.PI / 180;
const RIDE = AT100.carrier.rideHeight; // 1.30 m frame datum above ground on tyres
const B = AT100.bodies;
const BOOM = AT100.boom;
const PIV = AT100.pivot;
const FLOAT_INDEX = Object.fromEntries(FLOATS.map((f, i) => [f.id, i]));

// Render / body pose settles toward the solver plane with a critically damped
// second-order response (ω = 20 rad/s, ≈ 0.25 s): a crane rocking onto a
// diagonal (short jack) or settling onto new supports moves as a rigid body
// instead of teleporting. Reactions are always the instantaneous solution. [E]
const POSE_OMEGA = 20;
const ROCK_EVENT_DEG = 0.05; // solver tilt jump per step that emits a 'rock' (thud) event
const SLAM_MIN_DEG = 0.1; // a recovery below this peak angle is a teeter, not a near tip-over
const ROCK_JUMP_M = 0.005; // rest-plane jump (m at any support, one step) that makes it a dynamic rock
const TIP_LABEL_DEG = 2; // a rock episode past this angle is reported as TIPPING and ends with a 'slam'
const SET_TIME = 0.5; // s a float must carry ≥ 20 kN before it counts as "set" [E]
const STATE_TIME = 0.2; // s a LIFTOFF condition must persist (debounce) [E]
// FLOAT_LIGHT [E] (§4.4, refined): the warning is a tipping precursor, so it looks
// at the support EDGES of the float rectangle, not at single floats: an edge is
// light when its two floats together carry < EDGE_LIGHT_FRAC of their unloaded
// share (the CoP is approaching the opposite hull edge); its set floats are then
// flagged light. A lift over a CORNER unloads the diagonal float alone to ~0 at
// about half the tipping moment (rigid carrier, plane sharing) while both its
// edges stay well loaded — normal for an in-chart lift (M3 at 75 %), not a
// warning. Over the side / rear an edge goes light at ≈ 110–130 % of the chart,
// before the far floats lift. The condition must persist LIGHT_TIME, so a
// lift-off snatch or a swinging load does not count.
const EDGE_LIGHT_FRAC = 0.25;
const EDGE_CLEAR_FRAC = 0.30; // hysteresis: a light edge clears only above this
const LIGHT_TIME = 0.6; // s
const EDGES = [[0, 1], [2, 3], [0, 2], [1, 3]]; // FLOATS FL, FR, RL, RR: front, rear, left, right edge
const QS_ROCK_GAP = 0.3; // s between quasi-static 'rock' (clunk) events
const FALL_STOP_DEG = 88; // cinematic fall after OVERTURNED stops here or when the head hits the ground

// ---------------------------------------------------------------- body list
// Boom telescoping (§1.2 / §2.2, mirrors charts.js sectionExt): outer-first
// round-robin 46 % steps T5..T1, then 92 %, then 100 %. ext[0] = T1 … ext[4] = T5.
export function extForLength(L, out = [0, 0, 0, 0, 0]) {
  const n = BOOM.nTele, step = BOOM.stroke * 0.46, d = L - BOOM.baseLen;
  for (let j = 0; j < n; j++) out[j] = 0;
  if (d <= 0) return out;
  const top = 2 * n * step;
  if (d <= top + 1e-9) {
    const k = d / step, full = Math.floor(k / n), rem = k - full * n;
    for (let j = 0; j < n; j++) out[n - 1 - j] = 0.46 * full + 0.46 * Math.min(1, Math.max(0, rem - j));
    return out;
  }
  const r = (d - top) / (BOOM.stroke * 0.08);
  for (let j = 0; j < n; j++) out[n - 1 - j] = 0.92 + 0.08 * Math.min(1, Math.max(0, r - j));
  return out;
}
export const lengthForExt = (ext) => BOOM.baseLen + BOOM.stroke * (ext[0] + ext[1] + ext[2] + ext[3] + ext[4]);

// Body record indices (fixed order, so callers can read e.g. bodies[BODY.cw]).
export const BODY = { carrier: 0, upper: 1, luffCyl: 2, boom0: 3, head: 9, cw: 10, deck: 11 };
const NBODY = 12;

// Allocate the §1.3 body list once: 12 × {name, m (kg), x, y, z (C, road
// stance), I (kg·m², own inertia about a horizontal axis, used by the tip model)}.
export function makeBodies() {
  const names = ['carrier', 'upper', 'luffCyl', 'boom0', 'boom1', 'boom2', 'boom3', 'boom4', 'boom5', 'head', 'cw', 'deck'];
  return names.map((name) => ({ name, m: 0, x: 0, y: 0, z: 0, I: 0 }));
}

const _ext = [0, 0, 0, 0, 0];
// Fill the body list in the carrier frame C (road-stance heights).
// st = {psi, theta (rad, frame-relative), ext[5] | L, dv, dl (head deflection,
// m; §3.6), cwKg (on the superstructure), deckKg, deckH (slab stack height on
// the deck), deckZ? (override of the deck-stack CG height, e.g. while the
// ballast cylinders raise it)}. Returns the boom length L.
export function fillBodies(list, st) {
  const psi = st.psi || 0, th = st.theta || 0;
  const ext = st.ext || extForLength(st.L ?? BOOM.baseLen, _ext);
  const L = lengthForExt(ext);
  const cp = Math.cos(psi), sp = Math.sin(psi), ct = Math.cos(th), s_t = Math.sin(th);
  const dv = st.dv || 0, dl = st.dl || 0;
  const put = (i, m, x, y, z, I = 0) => { const b = list[i]; b.m = m; b.x = x; b.y = y; b.z = z; b.I = I; };
  // superstructure point (u along the boom plane, v left, z) → C
  const rot = (i, m, u, v, z, I = 0) => put(i, m, u * cp - v * sp, u * sp + v * cp, z, I);
  const c = B.carrier;
  put(BODY.carrier, c.m, c.x, c.y, c.z);
  rot(BODY.upper, B.upper.m, B.upper.u, 0, B.upper.z);
  rot(BODY.luffCyl, B.luffCyl.m, B.luffCyl.u, 0, B.luffCyl.z);
  // Boom sections: centre at pivot + (p_i + 5.65) along the axis, p_i = 8.1·Σ_{k≤i} e_k.
  // Deflection bends the axis like a tip-loaded cantilever: δ(s) = δ_tip·ξ²(3 − ξ)/2.
  // Own inertia: the spec's m_boom·L²/12 rod term is shared out per section.
  const Irod = L * L / 12;
  let p = 0;
  for (let i = 0; i <= BOOM.nTele; i++) {
    if (i > 0) p += BOOM.stroke * ext[i - 1];
    const s = Math.min(L, p + B.boomSection.offset), xi = s / L, sh = xi * xi * (3 - xi) / 2;
    rot(BODY.boom0 + i, B.boomSection.m, PIV.u + s * ct + dv * sh * s_t, dl * sh, PIV.z + s * s_t - dv * sh * ct, B.boomSection.m * Irod);
  }
  rot(BODY.head, B.head.m, PIV.u + L * ct + dv * s_t, dl, PIV.z + L * s_t - dv * ct, B.head.m * Irod);
  rot(BODY.cw, st.cwKg || 0, B.cw.u, 0, B.cw.z);
  const dk = B.deckSlabs, dh = st.deckH || 0;
  put(BODY.deck, st.deckKg || 0, dk.x, dk.y, st.deckZ ?? dk.z + dh / 2);
  return L;
}

// Head sheave in C (road stance, §3.1 without the lift term): {x, y, z}.
export function headCarrier(psi, theta, L, dv = 0, dl = 0, out = { x: 0, y: 0, z: 0 }) {
  const u = PIV.u + L * Math.cos(theta) + dv * Math.sin(theta);
  const cp = Math.cos(psi), sp = Math.sin(psi);
  out.x = u * cp - dl * sp; out.y = u * sp + dl * cp;
  out.z = PIV.z + L * Math.sin(theta) - dv * Math.cos(theta);
  return out;
}

// ------------------------------------------------------------ support solver
// Scratch (module level, reused: the solver is re-entrant only per call).
const MAXS = 32;
const _act = new Int32Array(MAXS);
const _Rv = new Float64Array(MAXS);
const _idx = new Int32Array(MAXS);
const _hull = new Int32Array(MAXS * 2);
const _S = new Float64Array(12);

// 3×3 Gauss-Jordan with partial pivoting on [S | rhs] (row-major 3×4 in _S).
function solve3(out) {
  const M = _S;
  for (let c = 0; c < 3; c++) {
    let p = c, mv = Math.abs(M[c * 4 + c]);
    for (let r = c + 1; r < 3; r++) { const v = Math.abs(M[r * 4 + c]); if (v > mv) { mv = v; p = r; } }
    if (mv < 1e-12) return false;
    if (p !== c) for (let k = 0; k < 4; k++) { const t = M[c * 4 + k]; M[c * 4 + k] = M[p * 4 + k]; M[p * 4 + k] = t; }
    const d = M[c * 4 + c];
    for (let k = 0; k < 4; k++) M[c * 4 + k] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r * 4 + c];
      if (f !== 0) for (let k = 0; k < 4; k++) M[r * 4 + k] -= f * M[c * 4 + k];
    }
  }
  out[0] = M[3]; out[1] = M[7]; out[2] = M[11];
  return true;
}

const _c3 = [0, 0, 0];
// Core of the §4.3 reference solver, allocation-free. sup = [{x, y, h, k}],
// res = {ok, z0, a, b, nAct}; active indices in _act[0..nAct), reactions (N)
// per support index in _Rv. Returns res.ok. prev = last plane (optional): when
// the CoP sits exactly on a facet boundary two resting planes tie; keep the one
// closest to the current pose (continuity) instead of the first one found.
function solveCore(sup, W, X, Y, eps, res, prev = null) {
  const n = Math.min(sup.length, MAXS);
  let found = false, bz = 0, bz0 = 0, ba = 0, bb = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const p = sup[i], q = sup[j], r = sup[k];
    const ux = q.x - p.x, uy = q.y - p.y, uz = q.h - p.h, vx = r.x - p.x, vy = r.y - p.y, vz = r.h - p.h;
    const nz = ux * vy - uy * vx; if (Math.abs(nz) < 1e-9) continue;
    const a = -(uy * vz - uz * vy) / nz, b = -(uz * vx - ux * vz) / nz, z0 = p.h - a * p.x - b * p.y;
    let ok = true;
    for (let m = 0; m < n; m++) { const s = sup[m]; if (s.h > z0 + a * s.x + b * s.y + eps) { ok = false; break; } }
    if (!ok) continue;
    const d = (q.y - r.y) * (p.x - r.x) + (r.x - q.x) * (p.y - r.y);
    const l1 = ((q.y - r.y) * (X - r.x) + (r.x - q.x) * (Y - r.y)) / d;
    const l2 = ((r.y - p.y) * (X - r.x) + (p.x - r.x) * (Y - r.y)) / d;
    if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue; // CoP must be inside this facet
    const zc = z0 + a * X + b * Y;
    if (!found || zc < bz - 1e-7) { found = true; bz = zc; bz0 = z0; ba = a; bb = b; } // lowest resting plane
    else if (prev && zc < bz + 1e-7 && Math.abs(a - prev.a) + Math.abs(b - prev.b) < Math.abs(ba - prev.a) + Math.abs(bb - prev.b)) { bz = Math.min(bz, zc); bz0 = z0; ba = a; bb = b; }
  }
  res.ok = false; res.nAct = 0;
  if (!found) return false; // CoP outside all support facets → TIPPING
  res.z0 = bz0; res.a = ba; res.b = bb;
  let na = 0;
  for (let m = 0; m < n; m++) { const s = sup[m]; _Rv[m] = 0; if (bz0 + ba * s.x + bb * s.y - s.h < eps) _act[na++] = m; }
  for (;;) { // equal-strain (plane) sharing with stiffness weights, drop tensile supports
    _S.fill(0);
    for (let t = 0; t < na; t++) {
      const s = sup[_act[t]], k = s.k;
      _S[0] += k; _S[1] += k * s.x; _S[2] += k * s.y;
      _S[5] += k * s.x * s.x; _S[6] += k * s.x * s.y; _S[10] += k * s.y * s.y;
    }
    _S[4] = _S[1]; _S[8] = _S[2]; _S[9] = _S[6];
    _S[3] = W; _S[7] = W * X; _S[11] = W * Y;
    if (!solve3(_c3)) return false; // collinear contact set
    let mi = -1, mv = 0;
    for (let t = 0; t < na; t++) {
      const s = sup[_act[t]], v = s.k * (_c3[0] + _c3[1] * s.x + _c3[2] * s.y);
      _Rv[_act[t]] = v;
      if (v < mv) { mv = v; mi = t; }
    }
    if (mi < 0) { res.ok = true; res.nAct = na; return true; }
    _Rv[_act[mi]] = 0;
    for (let t = mi; t < na - 1; t++) _act[t] = _act[t + 1];
    na--;
    if (na < 3) return false;
  }
}

// §4.3 reference API: supports [{id, x, y, h, k}] (C frame; h = frame height the
// support imposes), load {W, X, Y} (N, CoP in C). Returns
// {ok, plane:{z0, a, b}, active:[ids], R:{id: N}} (allocates; use Stability in the loop).
export function solveSupport(supports, load, eps = STABILITY.planeEps) {
  const res = { ok: false, z0: 0, a: 0, b: 0, nAct: 0 };
  if (!solveCore(supports, load.W, load.X, load.Y, eps, res)) return { ok: false };
  const R = {}, active = [];
  supports.forEach((s, i) => { R[s.id] = _Rv[i]; });
  for (let t = 0; t < res.nAct; t++) active.push(supports[_act[t]].id);
  return { ok: true, plane: { z0: res.z0, a: res.a, b: res.b }, active, R };
}

// ------------------------------------------------------------ convex hull
// Andrew's monotone chain on pts[idx[0..n)] (objects with x, y). Writes the
// CCW hull (collinear points dropped) into _hull and returns its size.
function hullOf(pts, idx, n) {
  // insertion sort by x, then y (n ≤ 32)
  for (let i = 1; i < n; i++) {
    const v = idx[i], px = pts[v].x, py = pts[v].y;
    let j = i - 1;
    while (j >= 0 && (pts[idx[j]].x > px || (pts[idx[j]].x === px && pts[idx[j]].y > py))) { idx[j + 1] = idx[j]; j--; }
    idx[j + 1] = v;
  }
  const cross = (o, a, b) => (pts[a].x - pts[o].x) * (pts[b].y - pts[o].y) - (pts[a].y - pts[o].y) * (pts[b].x - pts[o].x);
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k >= 2 && cross(_hull[k - 2], _hull[k - 1], idx[i]) <= 1e-12) k--;
    _hull[k++] = idx[i];
  }
  for (let i = n - 2, t = k + 1; i >= 0; i--) {
    while (k >= t && cross(_hull[k - 2], _hull[k - 1], idx[i]) <= 1e-12) k--;
    _hull[k++] = idx[i];
  }
  return n < 2 ? n : k - 1;
}

function segDist(px, py, x1, y1, x2, y2) {
  const ex = x2 - x1, ey = y2 - y1, l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((px - x1) * ex + (py - y1) * ey) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - x1 - t * ex, py - y1 - t * ey);
}

// Signed distance (m) of (X, Y) to the convex hull of pts[idx[0..n)]; > 0 inside.
function marginOf(pts, idx, n, X, Y) {
  const h = hullOf(pts, idx, n);
  if (h === 0) return -Infinity;
  if (h === 1) return -Math.hypot(X - pts[_hull[0]].x, Y - pts[_hull[0]].y);
  if (h === 2) return -segDist(X, Y, pts[_hull[0]].x, pts[_hull[0]].y, pts[_hull[1]].x, pts[_hull[1]].y);
  let inside = Infinity, outside = Infinity, isIn = true;
  for (let i = 0; i < h; i++) {
    const p = pts[_hull[i]], q = pts[_hull[(i + 1) % h]];
    const ex = q.x - p.x, ey = q.y - p.y, len = Math.hypot(ex, ey);
    const sd = (ex * (Y - p.y) - ey * (X - p.x)) / len; // left of a CCW edge = inside
    if (sd < 0) isIn = false;
    if (sd < inside) inside = sd;
    const dd = segDist(X, Y, p.x, p.y, q.x, q.y);
    if (dd < outside) outside = dd;
  }
  return isIn ? inside : -outside;
}

// Hull edge the point lies furthest beyond: returns hull-slot index i (edge
// _hull[i] → _hull[i+1]) and writes the outside distance into _edgeD[0].
const _edgeD = new Float64Array(1);
function furthestEdge(pts, h, X, Y) {
  let best = -1, bd = -Infinity;
  for (let i = 0; i < h; i++) {
    const p = pts[_hull[i]], q = pts[_hull[(i + 1) % h]];
    const ex = q.x - p.x, ey = q.y - p.y, len = Math.hypot(ex, ey);
    const out = (ey * (X - p.x) - ex * (Y - p.y)) / len; // right of a CCW edge = outside
    if (out > bd) { bd = out; best = i; }
  }
  _edgeD[0] = bd;
  return best;
}

// §4.3: margin = signed distance of the CoP to the convex hull of the given
// supports (> 0 inside). act = [{x, y}], load = {X, Y}.
export function hullMargin(act, load) {
  const n = Math.min(act.length, MAXS);
  for (let i = 0; i < n; i++) _idx[i] = i;
  return marginOf(act, _idx, n, load.X, load.Y);
}

// ------------------------------------------------------------ rigid transforms
// Carrier rotation R = Ry(yaw)·Rz(pitch)·Rx(roll) (Euler 'YZX', §0), row-major 3×3.
function carrierRot(yaw, pitch, roll, m) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  const a00 = cp, a01 = -sp * cr, a02 = sp * sr, a10 = sp, a11 = cp * cr, a12 = -cp * sr, a20 = 0, a21 = sr, a22 = cr;
  m[0] = cy * a00 + sy * a20; m[1] = cy * a01 + sy * a21; m[2] = cy * a02 + sy * a22;
  m[3] = a10; m[4] = a11; m[5] = a12;
  m[6] = -sy * a00 + cy * a20; m[7] = -sy * a01 + cy * a21; m[8] = -sy * a02 + cy * a22;
}
// Rotation by φ about unit axis e (Rodrigues), row-major 3×3.
function axisRot(ex, ey, ez, phi, m) {
  const c = Math.cos(phi), s = Math.sin(phi), t = 1 - c;
  m[0] = c + t * ex * ex; m[1] = t * ex * ey - s * ez; m[2] = t * ex * ez + s * ey;
  m[3] = t * ex * ey + s * ez; m[4] = c + t * ey * ey; m[5] = t * ey * ez - s * ex;
  m[6] = t * ex * ez - s * ey; m[7] = t * ey * ez + s * ex; m[8] = c + t * ez * ez;
}

// ----------------------------------------------------------------- Stability
export const STATES = ['STABLE', 'FLOAT_LIGHT', 'LIFTOFF', 'TIPPING', 'OVERTURNED'];

export class Stability {
  constructor() {
    this.x = 0; this.z = 0; this.yaw = 0; // carrier slew-axis point (world) and yaw φ
    // physics pose for other modules (outriggers.supports, RCL tilt): solver plane
    this.pose = { x: 0, z: 0, yaw: 0, z0: RIDE, a: 0, b: 0 };
    this.plane = { z0: RIDE, a: 0, b: 0 }; // instantaneous solver plane (C)
    this._rp = { z0: RIDE, a: 0, b: 0, vz: 0, va: 0, vb: 0 }; // settled (render / body) plane
    this._snap = true;
    this._R = new Float64Array(9); // carrier rotation (settled plane)
    this._T = new Float64Array(9); // tip rotation
    this._bw = null; // world body list (bodiesWorld)
    this._res = { ok: false, z0: 0, a: 0, b: 0, nAct: 0 };
    this.reset();
  }

  reset() {
    this.state = 'STABLE';
    this.ok = true;
    this.margin = 0; this.marginUnloaded = 0; this.util = 0;
    this.R = {}; // id → N
    this.floatR = [0, 0, 0, 0]; // N, FLOATS order FL, FR, RL, RR
    this.floatContact = [false, false, false, false];
    this.floatSet = [false, false, false, false]; // latched "set" (§4.4)
    this.floatLight = [false, false, false, false];
    this.floatLifted = [false, false, false, false];
    this.floatShare = [0, 0, 0, 0]; // N, unloaded (no rope force) plane-sharing reaction of each set float
    this._litEdge = -1;
    this.edgeReserve = NaN; // smallest (R_a + R_b)/(share_a + share_b) over the float-rectangle edges
    this._wasLift = [false, false, false, false];
    this._floatE = [0, 0, 0, 0];
    this._setT = [0, 0, 0, 0]; this._liftT = [0, 0, 0, 0]; this._lightT = [0, 0, 0, 0];
    this.tyresActive = false;
    this.tyreLoadN = 0;
    this.contact = new Uint8Array(MAXS); // per support index (last supports list)
    this.cop = { W: 0, X: 0, Y: 0 }; // N, C
    this.copUnloaded = { W: 0, X: 0, Y: 0 };
    this.tilt = { pitch: 0, roll: 0 }; // rad (actual, incl. tip rotation)
    this.tiltDeg = 0; // total inclination, deg
    this.zRef = 0; // mean contact height (world y) of the supports
    this.phi = 0; this.phiDot = 0; this.phiMax = 0;
    this.edge = null; // {p0:{x,y,z}, e:{x,y,z}, n:{x,y,z}, ids:[a, b], Ie, arm}
    this.resting = false; // OVERTURNED and the cinematic fall has ended
    this.degenerate = false;
    this.events = [];
    this._snap = true;
    this._rockT = 0;
    this._updateRot();
  }

  // Carrier yaw-plane pose (vehicle / MobileStart); call before update().
  setCarrier(x, z, yaw) {
    this.x = this.pose.x = x; this.z = this.pose.z = z; this.yaw = this.pose.yaw = yaw;
    this._updateRot();
  }

  // Impose a plane directly (ROAD: the vehicle's wheel-plane fit, §7), snapping the settled pose.
  setPlane(z0, a, b) {
    const p = this.plane, r = this._rp;
    p.z0 = r.z0 = this.pose.z0 = z0; p.a = r.a = this.pose.a = a; p.b = r.b = this.pose.b = b;
    r.vz = r.va = r.vb = 0;
    this._updateRot();
  }

  get tipping() { return this.state === 'TIPPING' || this.state === 'OVERTURNED'; }

  _updateRot() {
    const r = this._rp;
    carrierRot(this.yaw, Math.atan(r.a), Math.atan(r.b), this._R);
  }

  // C point (road-stance coords) → world, through the settled carrier pose;
  // tipped = also apply the tip-over rotation (what you see / the sheave target).
  carrierPoint(xc, yc, zc, out, tipped = true) {
    const R = this._R, lx = xc, ly = zc - RIDE, lz = -yc;
    let wx = this.x + R[0] * lx + R[1] * ly + R[2] * lz;
    let wy = this._rp.z0 + R[3] * lx + R[4] * ly + R[5] * lz;
    let wz = this.z + R[6] * lx + R[7] * ly + R[8] * lz;
    if (tipped && this.edge && this.phi !== 0) {
      const T = this._T, p = this.edge.p0, dx = wx - p.x, dy = wy - p.y, dz = wz - p.z;
      wx = p.x + T[0] * dx + T[1] * dy + T[2] * dz;
      wy = p.y + T[3] * dx + T[4] * dy + T[5] * dz;
      wz = p.z + T[6] * dx + T[7] * dy + T[8] * dz;
    }
    out.x = wx; out.y = wy; out.z = wz;
    return out;
  }

  // Tip rotation applied to a world point (e.g. a head computed without it).
  applyTip(out) {
    if (!this.edge || this.phi === 0) return out;
    const T = this._T, p = this.edge.p0, dx = out.x - p.x, dy = out.y - p.y, dz = out.z - p.z;
    out.x = p.x + T[0] * dx + T[1] * dy + T[2] * dz;
    out.y = p.y + T[3] * dx + T[4] * dy + T[5] * dz;
    out.z = p.z + T[6] * dx + T[7] * dy + T[8] * dz;
    return out;
  }

  // Body list in C → world (un-tipped carrier pose), reused array.
  bodiesWorld(bodiesC) {
    if (!this._bw || this._bw.length !== bodiesC.length) this._bw = bodiesC.map((b) => ({ name: b.name, m: 0, x: 0, y: 0, z: 0, I: 0 }));
    for (let i = 0; i < bodiesC.length; i++) {
      const b = bodiesC[i], w = this._bw[i];
      this.carrierPoint(b.x, b.y, b.z, w, false);
      w.m = b.m; w.I = b.I;
    }
    return this._bw;
  }

  // Matrix for the machine root group whose local frame is C in three.js axes
  // (origin: slew axis at road-stance ground level, +X fwd, +Y up, +Z right):
  // T(p0)·R(e, φ)·T(−p0)·T_carrier. Works with THREE.Matrix4 (set, row-major).
  rootTransform(out) {
    const R = this._R;
    let m = R, tx = this.x - R[1] * RIDE, ty = this._rp.z0 - R[4] * RIDE, tz = this.z - R[7] * RIDE;
    if (this.edge && this.phi !== 0) {
      const T = this._T, p = this.edge.p0, M = _M9;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] = T[r * 3] * R[c] + T[r * 3 + 1] * R[3 + c] + T[r * 3 + 2] * R[6 + c];
      const dx = tx - p.x, dy = ty - p.y, dz = tz - p.z;
      tx = p.x + T[0] * dx + T[1] * dy + T[2] * dz;
      ty = p.y + T[3] * dx + T[4] * dy + T[5] * dz;
      tz = p.z + T[6] * dx + T[7] * dy + T[8] * dz;
      m = M;
    }
    out.set(m[0], m[1], m[2], tx, m[3], m[4], m[5], ty, m[6], m[7], m[8], tz, 0, 0, 0, 1);
    return out;
  }

  // World point → carrier (x_c, y_c) along the carrier's own up axis (the
  // jack direction) through the settled pose; used for the CoP so tilt moves
  // CGs relative to the floats by ≈ z·tan(tilt) (§4.7).
  _toCarrier(wx, wy, wz, out) {
    const R = this._R, dx = wx - this.x, dy = wy - this._rp.z0, dz = wz - this.z;
    // local = Rᵀ·d; then slide along local up to the point's own height is irrelevant for (x, y)
    out.X = R[0] * dx + R[3] * dy + R[6] * dz;
    out.Y = -(R[2] * dx + R[5] * dy + R[8] * dz);
    return out;
  }

  // CoP (§4.1) of bodies (+ optional rope force F at head, world) in C.
  _cop(bodies, F, head, out) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let W = 0, Xl = 0, Yl = 0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]; if (!(b.m > 0)) continue;
      const w = b.m * G, dx = b.x - this.x, dz = b.z - this.z;
      W += w; Xl += w * (dx * c - dz * s); Yl += w * (-dx * s - dz * c);
    }
    if (F && head) {
      const w = -F.y, dx = head.x - this.x, dz = head.z - this.z, zh = head.y - this.zRef;
      const hx = F.x * c - F.z * s, hy = -F.x * s - F.z * c; // horizontal rope force in C
      W += w; Xl += w * (dx * c - dz * s) + hx * zh; Yl += w * (-dx * s - dz * c) + hy * zh;
    }
    out.W = W;
    if (W <= 0) { out.X = 0; out.Y = 0; return out; }
    // level-frame ground point of the resultant → carrier coords (jack axes)
    const X = Xl / W, Y = Yl / W;
    this._toCarrier(this.x + X * c - Y * s, this.zRef, this.z - X * s - Y * c, out);
    return out;
  }

  /**
   * One 120 Hz step.
   * @param {number} dt
   * @param {{m,x,y,z,I}[]} bodiesWorld   world body list, un-tipped pose (bodiesWorld())
   * @param {{x,y,z}|null} ropeForceWorld  force of the rope on the head (N), tension·unit(head→hook)
   * @param {{x,y,z}|null} headWorld       head sheave, un-tipped pose (carrierPoint(..., false))
   * @param {{id,x,y,h,k,g?,kind?,e?}[]} supports  C frame (outriggers.supports())
   * @param {{x,z,yaw}} [carrier]          optional carrier pose (else setCarrier())
   */
  update(dt, bodiesWorld, ropeForceWorld, headWorld, supports, carrier = null) {
    if (carrier) this.setCarrier(carrier.x, carrier.z, carrier.yaw);
    this.events.length = 0;
    if (this.state === 'OVERTURNED') { this._fall(dt, bodiesWorld); return; }
    const n = Math.min(supports.length, MAXS);
    // reference height for horizontal-force levers: mean contact height of the supports carrying
    if (!this.edge) {
      let gs = 0, gn = 0;
      for (let i = 0; i < n; i++) { const s = supports[i]; if (s.g !== undefined && (this.contact[i] || this._snap)) { gs += s.g; gn++; } }
      if (gn) this.zRef = gs / gn;
    }
    this._updateRot();
    this._cop(bodiesWorld, ropeForceWorld, headWorld, this.cop);
    this._cop(bodiesWorld, null, null, this.copUnloaded);
    if (this.edge) { this._tip(dt, bodiesWorld, ropeForceWorld, headWorld, supports); return; }

    const res = this._res, cop = this.cop;
    const ok = solveCore(supports, cop.W, cop.X, cop.Y, STABILITY.planeEps, res, this._snap ? null : this.plane);
    if (!ok) {
      // §4.4 TIPPING: the CoP is beyond every support facet → rotate about the
      // edge of the hull of ALL supports that the CoP lies furthest beyond
      for (let i = 0; i < n; i++) _idx[i] = i;
      const h = hullOf(supports, _idx, n);
      const ei = h >= 3 ? furthestEdge(supports, h, cop.X, cop.Y) : -1;
      if (ei >= 0 && _edgeD[0] > 1e-6) {
        this._startTip(supports, h, ei, bodiesWorld, 'tip');
        this._tip(dt, bodiesWorld, ropeForceWorld, headWorld, supports);
        return;
      }
      this.degenerate = true; // e.g. collinear contacts with the CoP inside: hold the last pose
      this.ok = false;
      return;
    }
    // Rest plane jumped (it would teleport the carrier) because the CoP left the
    // hull of the supports it stood on: a short jack rocking onto the other
    // diagonal, or the carrier sitting forward onto its front tyres. The
    // machine gets there as a rigid rotation about that contact edge (same
    // dynamics as §4.5) and lands on the new support. [D]
    if (!this._snap && this._rockCheck(supports, n, res, bodiesWorld)) {
      this._tip(dt, bodiesWorld, ropeForceWorld, headWorld, supports);
      return;
    }
    this.ok = true; this.degenerate = false;
    const P = this.plane;
    const jump = Math.abs(Math.atan(res.a) - Math.atan(P.a)) + Math.abs(Math.atan(res.b) - Math.atan(P.b));
    P.z0 = res.z0; P.a = res.a; P.b = res.b;
    this.pose.z0 = res.z0; this.pose.a = res.a; this.pose.b = res.b;
    this._rockT += dt;
    if (!this._snap && jump > ROCK_EVENT_DEG * DEG && this._rockT >= QS_ROCK_GAP) { this.events.push({ type: 'rock', deg: jump / DEG, speed: 0 }); this._rockT = 0; }
    this._settle(dt);

    // reactions, contacts, tyres
    const Rm = this.R;
    let tyreN = 0, tyresActive = false;
    for (let i = 0; i < n; i++) {
      const s = supports[i], gap = res.z0 + res.a * s.x + res.b * s.y - s.h;
      this.contact[i] = gap < STABILITY.planeEps ? 1 : 0;
      Rm[s.id] = _Rv[i];
      const fi = FLOAT_INDEX[s.id];
      if (fi !== undefined) {
        this.floatR[fi] = _Rv[i];
        this.floatContact[fi] = gap < STABILITY.planeEps;
        this.floatLifted[fi] = gap > STABILITY.liftoffEps;
        // "set" latch: a float that has carried ≥ 20 kN for SET_TIME stays set until its jack is
        // retracted (the 3 mm solver band makes touchdown flicker; don't latch on a flicker)
        const e = s.e ?? 0;
        this._setT[fi] = _Rv[i] >= STABILITY.floatLightN ? this._setT[fi] + dt : 0;
        if (e < this._floatE[fi] - 5e-4 || e < 1e-3) { this.floatSet[fi] = false; this._setT[fi] = 0; }
        else if (this._setT[fi] >= SET_TIME) this.floatSet[fi] = true;
        this._floatE[fi] = e;
      } else {
        tyreN += _Rv[i];
        if (gap < STABILITY.planeEps) tyresActive = true;
      }
    }
    this.tyreLoadN = tyreN; this.tyresActive = tyresActive;

    // margin over the supports within 5 cm of the plane (§4.3)
    this.margin = marginOf(supports, _idx, this._hullSet(supports, n, res), cop.X, cop.Y);
    this.marginUnloaded = marginOf(supports, _idx, this._hullSet(supports, n, res), this.copUnloaded.X, this.copUnloaded.Y);
    this.util = this.marginUnloaded > 1e-6 ? Math.max(0, 1 - this.margin / this.marginUnloaded) : 1;

    // states (§4.4), each condition must persist STATE_TIME / LIGHT_TIME (s) before it counts
    let lifted = false, light = false, anyLoaded = false;
    for (let fi = 0; fi < 4; fi++) if (this.floatR[fi] >= STABILITY.floatLightN) anyLoaded = true;
    this._floatShares(supports, n);
    const le = this._lightEdge(), ea = le >= 0 ? EDGES[le][0] : -1, eb = le >= 0 ? EDGES[le][1] : -1;
    for (let fi = 0; fi < 4; fi++) {
      const set = this.floatSet[fi];
      const isLift = set && this.floatLifted[fi];
      const isLight = set && !this.floatLifted[fi] && anyLoaded && (fi === ea || fi === eb);
      this._liftT[fi] = isLift ? this._liftT[fi] + dt : 0;
      this._lightT[fi] = isLight ? this._lightT[fi] + dt : 0;
      const lift = this._liftT[fi] >= STATE_TIME || (isLift && this._wasLift[fi]);
      const lt = this._lightT[fi] >= LIGHT_TIME || (isLight && this.floatLight[fi]);
      if (lift && !this._wasLift[fi]) this.events.push({ type: 'liftoff', id: FLOATS[fi].id });
      if (lt && !this.floatLight[fi]) this.events.push({ type: 'floatLight', id: FLOATS[fi].id });
      this._wasLift[fi] = lift; this.floatLight[fi] = lt;
      lifted ||= lift; light ||= lt;
    }
    this.state = lifted ? 'LIFTOFF' : light ? 'FLOAT_LIGHT' : 'STABLE';
    this._tiltOut();
  }

  // Unloaded share of each set float (N): equal-strain plane sharing of the crane
  // without the rope force (copUnloaded) over the set floats; W/4 when < 3 are set.
  // Reference for the FLOAT_LIGHT edge test. Uses the solver scratch after the solve.
  _floatShares(supports, n) {
    const sh = this.floatShare, cu = this.copUnloaded, W = cu.W;
    for (let fi = 0; fi < 4; fi++) sh[fi] = W / 4;
    const M = _S;
    M.fill(0);
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const s = supports[i], fi = FLOAT_INDEX[s.id];
      if (fi === undefined || !this.floatSet[fi]) continue;
      const k = s.k ?? 1;
      M[0] += k; M[1] += k * s.x; M[2] += k * s.y; M[5] += k * s.x * s.x; M[6] += k * s.x * s.y; M[10] += k * s.y * s.y;
      cnt++;
    }
    if (cnt < 3) return;
    M[4] = M[1]; M[8] = M[2]; M[9] = M[6];
    M[3] = W; M[7] = W * cu.X; M[11] = W * cu.Y;
    if (!solve3(_c3)) return;
    for (let i = 0; i < n; i++) {
      const s = supports[i], fi = FLOAT_INDEX[s.id];
      if (fi === undefined || !this.floatSet[fi]) continue;
      sh[fi] = Math.max(0, (s.k ?? 1) * (_c3[0] + _c3[1] * s.x + _c3[2] * s.y));
    }
  }

  // Weakest support edge (index into EDGES) whose two set floats carry < EDGE_LIGHT_FRAC
  // of their unloaded share, or −1. this.edgeReserve = the smallest edge fraction (info).
  _lightEdge() {
    let best = -1, bf = Infinity;
    for (let e = 0; e < 4; e++) {
      const a = EDGES[e][0], b = EDGES[e][1];
      if (!this.floatSet[a] || !this.floatSet[b]) continue;
      const sh = this.floatShare[a] + this.floatShare[b];
      if (!(sh > 0)) continue;
      const f = (this.floatR[a] + this.floatR[b]) / sh;
      if (f < bf) { bf = f; best = e; }
    }
    this.edgeReserve = best >= 0 ? bf : NaN;
    const lit = best >= 0 && bf < (best === this._litEdge ? EDGE_CLEAR_FRAC : EDGE_LIGHT_FRAC);
    this._litEdge = lit ? best : -1;
    return this._litEdge;
  }

  // supports within hullTol of the plane → _idx; returns the count
  // (hullOf sorts _idx in place, so rebuild it before every marginOf)
  _hullSet(supports, n, pl) {
    let m = 0;
    for (let i = 0; i < n; i++) { const s = supports[i]; if (pl.z0 + pl.a * s.x + pl.b * s.y - s.h < STABILITY.hullTol) _idx[m++] = i; }
    return m;
  }

  _rockCheck(supports, n, res, bodies) {
    const P = this.plane;
    let dh = 0;
    for (let i = 0; i < n; i++) {
      const s = supports[i], d = Math.abs(res.z0 + res.a * s.x + res.b * s.y - (P.z0 + P.a * s.x + P.b * s.y));
      if (d > dh) dh = d;
    }
    if (dh < ROCK_JUMP_M) return false;
    let m = 0;
    for (let i = 0; i < n; i++) if (this.contact[i]) _idx[m++] = i;
    if (m < 3) return false;
    const h = hullOf(supports, _idx, m);
    if (h < 3) return false;
    const ei = furthestEdge(supports, h, this.cop.X, this.cop.Y);
    if (ei < 0 || _edgeD[0] <= 1e-9) return false;
    this._startTip(supports, h, ei, bodies, 'rock');
    return true;
  }

  // settled plane follows the solver plane (critically damped, ω = POSE_OMEGA)
  _settle(dt) {
    const r = this._rp, p = this.plane;
    if (this._snap || !(dt > 0)) { r.z0 = p.z0; r.a = p.a; r.b = p.b; r.vz = r.va = r.vb = 0; this._snap = false; }
    else {
      const w = POSE_OMEGA, k = w * w, c = 2 * w;
      r.vz += (k * (p.z0 - r.z0) - c * r.vz) * dt; r.z0 += r.vz * dt;
      r.va += (k * (p.a - r.a) - c * r.va) * dt; r.a += r.va * dt;
      r.vb += (k * (p.b - r.b) - c * r.vb) * dt; r.b += r.vb * dt;
    }
    this._updateRot();
  }

  // Snap the settled pose to the solver on the next update (reset / teleport).
  snap() { this._snap = true; }

  _tiltOut() {
    // actual carrier attitude (settled plane ∘ tip rotation): pitch from the
    // forward axis, roll from the left axis (= −local Z), total tilt from the up axis
    const R = this._R;
    let fy = R[3], ly = -R[5], uy = R[4];
    if (this.edge && this.phi !== 0) {
      const T = this._T;
      fy = T[3] * R[0] + T[4] * R[3] + T[5] * R[6];
      ly = -(T[3] * R[2] + T[4] * R[5] + T[5] * R[8]);
      uy = T[3] * R[1] + T[4] * R[4] + T[5] * R[7];
    }
    this.tilt.pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
    this.tilt.roll = Math.asin(Math.max(-1, Math.min(1, ly)));
    this.tiltDeg = Math.acos(Math.max(-1, Math.min(1, uy))) / DEG;
  }

  // ---------------------------------------------------------- tip-over (§4.5)
  // kind 'tip' = §4.5 TIPPING (CoP beyond all supports); 'rock' = rigid
  // rotation onto another support (ends when that support touches down).
  _startTip(supports, h, ei, bodies, kind) {
    const a = supports[_hull[ei]], b = supports[_hull[(ei + 1) % h]];
    const pa = this._contactWorld(a, { x: 0, y: 0, z: 0 }), pb = this._contactWorld(b, _p1);
    let ex = pb.x - pa.x, ey = pb.y - pa.y, ez = pb.z - pa.z;
    const el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el;
    // outward horizontal normal from the CCW hull edge (C: right of a→b)
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const ncx = (b.y - a.y), ncy = -(b.x - a.x), nl = Math.hypot(ncx, ncy);
    const nwx = (ncx * c - ncy * s) / nl, nwz = (-ncx * s - ncy * c) / nl;
    // orient e so that e × up points outward (then +φ tips outward)
    if (-ez * nwx + ex * nwz < 0) { ex = -ex; ey = -ey; ez = -ez; }
    // n = normalize(e × up), w = n × e (≈ up)
    let nx = -ez, nz = ex; const nn = Math.hypot(nx, nz); nx /= nn; nz /= nn;
    const wx = -nz * ey, wy = nz * ex - nx * ez, wz = nx * ey;
    const p0 = pa;
    // I_e = Σ m r⊥² + own terms (m_boom·L²/12 via the boom records), evaluated once
    let Ie = 0;
    for (const bd of bodies) {
      if (!(bd.m > 0)) continue;
      const dx = bd.x - p0.x, dy = bd.y - p0.y, dz = bd.z - p0.z, al = dx * ex + dy * ey + dz * ez;
      Ie += bd.m * (dx * dx + dy * dy + dz * dz - al * al) + (bd.I || 0);
    }
    // far support (slam speed, far-float-height terminal check) and the
    // supports outside this edge (a 'rock' lands on one of them)
    let arm = 0, far = -1, no = 0;
    const outside = this._outside || (this._outside = new Int32Array(MAXS));
    for (let i = 0; i < supports.length && i < MAXS; i++) {
      const pw = this._contactWorld(supports[i], _p1), d = -((pw.x - p0.x) * nx + (pw.z - p0.z) * nz); // inward distance
      if (d > arm) { arm = d; far = i; }
      if (d < -1e-3) outside[no++] = i;
    }
    const farW = far >= 0 ? this._contactWorld(supports[far], { x: 0, y: 0, z: 0 }) : { x: p0.x, y: p0.y, z: p0.z };
    this.edge = { kind, p0, e: { x: ex, y: ey, z: ez }, n: { x: nx, y: 0, z: nz }, w: { x: wx, y: wy, z: wz }, ids: [a.id, b.id], Ie, arm, far: farW, nOutside: no };
    this.phi = 0; this.phiDot = 0; this.phiMax = 0;
    axisRot(ex, ey, ez, 0, this._T);
    this.state = kind === 'tip' ? 'TIPPING' : 'LIFTOFF';
    this.ok = kind !== 'tip';
    this.events.push({ type: kind === 'tip' ? 'tipStart' : 'rockStart', ids: [a.id, b.id], beyond: _edgeD[0] });
  }

  _contactWorld(s, out) {
    // support contact point: on the jack / wheel axis through (x, y) at contact height g
    const R = this._R, g = s.g ?? this.zRef;
    const ly = Math.abs(R[4]) > 1e-9 ? (g - this._rp.z0 - R[3] * s.x + R[5] * s.y) / R[4] : 0;
    out.x = this.x + R[0] * s.x + R[1] * ly - R[2] * s.y;
    out.y = g;
    out.z = this.z + R[6] * s.x + R[7] * ly - R[8] * s.y;
    return out;
  }

  // gravity + rope torque about the edge at the current φ
  _torque(bodies, F, head) {
    const E = this.edge, p = E.p0, e = E.e, n = E.n, w = E.w, cph = Math.cos(this.phi), sph = Math.sin(this.phi);
    let M = 0;
    for (const b of bodies) {
      if (!(b.m > 0)) continue;
      const dx = b.x - p.x, dy = b.y - p.y, dz = b.z - p.z;
      const d0 = dx * n.x + dz * n.z, h = dx * w.x + dy * w.y + dz * w.z;
      M += b.m * (d0 * cph + h * sph); // d_i(φ) = d0·cosφ + h·sinφ
    }
    let tq = G * M;
    if (F && head) { // ((p_head(φ) − p0) × F_rope)·e
      const T = this._T, dx = head.x - p.x, dy = head.y - p.y, dz = head.z - p.z;
      const rx = T[0] * dx + T[1] * dy + T[2] * dz, ry = T[3] * dx + T[4] * dy + T[5] * dz, rz = T[6] * dx + T[7] * dy + T[8] * dz;
      tq += (ry * F.z - rz * F.y) * e.x + (rz * F.x - rx * F.z) * e.y + (rx * F.y - ry * F.x) * e.z;
    }
    return tq;
  }

  _tip(dt, bodies, F, head, supports) {
    const E = this.edge;
    axisRot(E.e.x, E.e.y, E.e.z, this.phi, this._T);
    const tq = this._torque(bodies, F, head) - STABILITY.tipDamping * E.Ie * this.phiDot;
    this.phiDot += (tq / E.Ie) * dt; // semi-implicit Euler at 120 Hz
    this.phi += this.phiDot * dt;
    if (this.phi > this.phiMax) this.phiMax = this.phi;
    // reactions: everything on the two edge supports
    for (const k in this.R) this.R[k] = 0;
    for (let fi = 0; fi < 4; fi++) { this.floatR[fi] = 0; this.floatContact[fi] = false; this.floatLifted[fi] = true; this.floatLight[fi] = false; }
    this.tyresActive = false;
    for (let i = 0; i < supports.length && i < MAXS; i++) {
      const s = supports[i], fi = FLOAT_INDEX[s.id], on = s.id === E.ids[0] || s.id === E.ids[1];
      this.contact[i] = on ? 1 : 0;
      if (!on) continue;
      this.R[s.id] = this.cop.W / 2;
      if (fi !== undefined) { this.floatR[fi] = this.cop.W / 2; this.floatContact[fi] = true; this.floatLifted[fi] = false; } else this.tyresActive = true;
    }
    this.margin = -_edgeDist(this, this.cop);
    const big = this.phiMax > TIP_LABEL_DEG * DEG;
    if (E.kind === 'rock') this.state = big ? 'TIPPING' : 'LIFTOFF';
    if (this.phi <= 0 && this.phiDot < 0) { // recovery: falls back onto its supports
      const speed = -this.phiDot * E.arm, peak = this.phiMax;
      this._endTip(E.kind === 'tip' ? (peak > SLAM_MIN_DEG * DEG ? 'slam' : 'teeter') : big ? 'slam' : 'rock', speed, false, supports);
      return;
    }
    axisRot(E.e.x, E.e.y, E.e.z, this.phi, this._T);
    // a support outside the edge touches down (rock onto the other diagonal / the tyres)
    const out = this._outside;
    for (let k = 0; k < E.nOutside; k++) {
      const s = supports[out[k]];
      if (!s) continue;
      const y = this.carrierPoint(s.x, s.y, RIDE, _p1, true).y;
      if (y <= s.h + STABILITY.planeEps) {
        const pw = this._contactWorld(s, _p1), arm = (pw.x - E.p0.x) * E.n.x + (pw.z - E.p0.z) * E.n.z;
        this._endTip(big ? 'slam' : 'rock', Math.abs(this.phiDot) * arm, true, supports, out[k]);
        return;
      }
    }
    this._tiltOut();
    // terminal conditions (§4.5)
    const hy = head ? this._tipY(head) - this.zRef : Infinity;
    const farRise = this._tipY(E.far) - E.far.y;
    if (this.phi >= STABILITY.overturnDeg * DEG || hy <= STABILITY.headMin || farRise > STABILITY.farFloatMax) {
      this.state = 'OVERTURNED'; this.ok = false;
      // no support polygon any more: the margin readout is undefined (HUD '—'), not the last
      // (possibly positive, e.g. after the load landed mid-fall) CoP distance to the edge
      this.margin = NaN; this.marginUnloaded = NaN; this.util = 1;
      this.events.push({ type: 'overturned', phiDeg: this.phi / DEG, reason: this.phi >= STABILITY.overturnDeg * DEG ? 'angle' : hy <= STABILITY.headMin ? 'head' : 'float' });
      this._head = head ? { x: head.x, y: head.y, z: head.z } : null;
    }
  }

  // End a tip / rock episode. landed = it came to rest on a new support (the
  // rotated attitude becomes the settled plane); else it fell back (φ → 0).
  _endTip(type, speed, landed, supports, landedIdx = -1) {
    const E = this.edge;
    if (landed) {
      const q0 = this.carrierPoint(0, 0, RIDE, _q0, true), yx = this.carrierPoint(1, 0, RIDE, _q1, true).y, yy = this.carrierPoint(0, 1, RIDE, _q2, true).y;
      const sa = Math.max(-0.99, Math.min(0.99, yx - q0.y)), sb = Math.max(-0.99, Math.min(0.99, yy - q0.y));
      const r = this._rp, P = this.plane;
      r.z0 = P.z0 = q0.y; r.a = P.a = sa / Math.sqrt(1 - sa * sa); r.b = P.b = sb / Math.sqrt(1 - sb * sb);
      r.vz = r.va = r.vb = 0;
      this.pose.z0 = P.z0; this.pose.a = P.a; this.pose.b = P.b;
      if (landedIdx >= 0) this.contact[landedIdx] = 1;
    }
    this.phi = 0; this.phiDot = 0;
    axisRot(E.e.x, E.e.y, E.e.z, 0, this._T);
    this.edge = null;
    this.state = landed ? 'LIFTOFF' : 'STABLE'; this.ok = true;
    this._updateRot();
    this.events.push({ type, speed, peakDeg: this.phiMax / DEG, landed, ids: E.ids });
    this._tiltOut();
    void supports;
  }

  _tipY(p) {
    const T = this._T, q = this.edge.p0, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
    return q.y + T[3] * dx + T[4] * dy + T[5] * dz;
  }

  // after OVERTURNED: the machine keeps falling under gravity (no rope) until
  // the head reaches the ground or it lies on its side, then freezes.
  _fall(dt, bodies) {
    this.margin = NaN; this.marginUnloaded = NaN; this.util = 1;
    if (this.resting || !this.edge) return;
    const E = this.edge;
    axisRot(E.e.x, E.e.y, E.e.z, this.phi, this._T);
    const tq = this._torque(bodies, null, null);
    this.phiDot += (Math.max(tq, 0) / E.Ie) * dt;
    this.phi += this.phiDot * dt;
    axisRot(E.e.x, E.e.y, E.e.z, this.phi, this._T);
    const hy = this._head ? this._tipY(this._head) - this.zRef : Infinity;
    if (this.phi >= FALL_STOP_DEG * DEG || hy <= 0.3) {
      this.resting = true; this.phiDot = 0;
      this.events.push({ type: 'crash', phiDeg: this.phi / DEG });
    }
    this._tiltOut();
  }
}

const _M9 = new Float64Array(9);
const _p1 = { x: 0, y: 0, z: 0 };
const _q0 = { x: 0, y: 0, z: 0 }, _q1 = { x: 0, y: 0, z: 0 }, _q2 = { x: 0, y: 0, z: 0 };
function _edgeDist(st, cop) {
  // CoP distance beyond the current tipping edge (C), for the margin readout
  if (!st.edge) return 0;
  const E = st.edge, c = Math.cos(st.yaw), s = Math.sin(st.yaw);
  const px = st.x + cop.X * c - cop.Y * s, pz = st.z - cop.X * s - cop.Y * c;
  return (px - E.p0.x) * E.n.x + (pz - E.p0.z) * E.n.z;
}

// Time constant of the linearised tip-over (§4.5 check): τ = sqrt(I / (g·Σ m h)).
// ropeN (N, vertical) acts at the head; loadKg adds the suspended load's
// rope-coupled inertia: the rope transmits the head's VERTICAL motion to the
// load (not the horizontal one, it swings), so it adds m·d_h² with d_h the
// head's horizontal lever beyond the edge. In play the HoistSystem supplies
// this coupling through the rope tension; the EOM itself keeps the §4.5 form.
export function tipTimeConstant(stab, bodies, ropeN = 0, head = null, loadKg = 0) {
  const E = stab.edge; if (!E) return NaN;
  let mh = 0, I = E.Ie;
  for (const b of bodies) if (b.m > 0) mh += b.m * ((b.x - E.p0.x) * E.w.x + (b.y - E.p0.y) * E.w.y + (b.z - E.p0.z) * E.w.z);
  if (head && ropeN) mh += (ropeN / G) * ((head.x - E.p0.x) * E.w.x + (head.y - E.p0.y) * E.w.y + (head.z - E.p0.z) * E.w.z);
  if (head && loadKg) { const dh = (head.x - E.p0.x) * E.n.x + (head.z - E.p0.z) * E.n.z; I += loadKg * dh * dh; }
  return Math.sqrt(I / (G * mh));
}
