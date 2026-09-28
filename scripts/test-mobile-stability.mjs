#!/usr/bin/env node
// WP-STAB tests (spec §9.6): §4.3 / §4.9 reference values (±0.1 t, ±0.02 m),
// the §4.6 backward-margin table, tip dynamics τ ≈ 1.5–2.1 s, plus behaviour
// checks for outriggers (§1.6, §4.7, §6.4), ground (§4.8) and ballast (§6.6).
// Plain node, no framework: exits non-zero on the first failed group.
import {
  Stability, solveSupport, hullMargin, makeBodies, fillBodies, headCarrier, extForLength, lengthForExt, tipTimeConstant, BODY,
} from '../src/mobile/stability.js';
import { Outriggers, yOfExt, extOfY } from '../src/mobile/outriggers.js';
import { groundAt, addZone, clearZones, Settlement, pressureKPa } from '../src/mobile/ground.js';
import { Ballast } from '../src/mobile/ballast.js';
import { AXLES, FLOATS, P1, BASES, MATS, CW_DECK, carrierToWorld } from '../src/mobile/config.js';
import { Box, ColliderWorld } from '../src/physics/collide.js';

const G = 9.81, DEG = Math.PI / 180, DT = 1 / 120;
let fails = 0, checks = 0;
const t = (N) => N / 1000 / G; // N → t
function near(name, got, want, tol) {
  checks++;
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${got}, want ${want} ± ${tol}`); }
  else if (process.env.VERBOSE) console.log(`ok   ${name}: ${+got.toFixed(4)} (${want} ± ${tol})`);
}
function ok(name, cond, extra = '') {
  checks++;
  if (!cond) { fails++; console.log(`FAIL ${name} ${extra}`); }
  else if (process.env.VERBOSE) console.log(`ok   ${name}`);
}

// ---------------------------------------------------------------- harness
// Carrier at the origin, yaw 0 (x_c = world x, y_c = −world z). Floats at the
// given half-widths, levelled 0.10 m up (h 1.40); tyres hang 0.10 m clear.
function floatSupports(yL = 3.5, yR = 3.5, h = 1.40) {
  return FLOATS.map((f) => ({ id: f.id, kind: 'float', x: f.x, y: f.side * (f.side > 0 ? yL : yR), h, k: 1, g: 0, e: 0.5 }));
}
function tyreSupports(h = 1.30) {
  return AXLES.flatMap((x, j) => [1, -1].map((s) => ({ id: `T${j + 1}${s > 0 ? 'L' : 'R'}`, kind: 'tyre', x, y: s * 1.18, h, k: 0.3, g: 0 })));
}
const bodies = makeBodies();
// Static pose for a crane (cw kg, boom L, head radius R without deflection, slew ψ) carrying P t on the rope.
function statics({ cw, L, R = null, thetaDeg = null, psi, P = 0, sup, stab = new Stability(), steps = 4 }) {
  const th = thetaDeg !== null ? thetaDeg * DEG : Math.acos((R + 2) / L);
  stab.reset(); stab.setCarrier(0, 0, 0);
  fillBodies(bodies, { psi, theta: th, L, cwKg: cw });
  const hc = headCarrier(psi, th, L), head = { x: 0, y: 0, z: 0 }, F = { x: 0, y: -P * 1000 * G, z: 0 };
  for (let k = 0; k < steps && !stab.tipping; k++) {
    stab.snap();
    const bw = stab.bodiesWorld(bodies);
    stab.carrierPoint(hc.x, hc.y, hc.z, head, false);
    stab.update(DT, bw, F, head, sup);
  }
  return stab;
}
// Static tipping load (t): the smallest P that puts the CoP outside the support hull.
function tipLoad(args) {
  let lo = 0, hi = 150;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2, s = statics({ ...args, P: m, steps: 2 });
    if (s.state === 'TIPPING' || s.margin < 0) hi = m; else lo = m;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------- §4.3 table
{
  const want = { 0: [34.5, 34.5, 12.7, 12.7], 90: [35.3, 5.3, 42.0, 12.0], 135: [20.4, 0.0, 48.1, 26.0], 180: [6.0, 6.0, 41.2, 41.2] };
  for (const d of [0, 90, 135, 180]) {
    const s = statics({ cw: 35000, L: 22.7, R: 20, psi: d * DEG, P: 12.8, sup: [...floatSupports(), ...tyreSupports()] });
    ok(`§4.3 ψ=${d} solved`, s.ok && !s.tipping, s.state);
    want[d].forEach((w, i) => near(`§4.3 ψ=${d} ${FLOATS[i].id} (t)`, t(s.floatR[i]), w, 0.1));
  }
  // the reference API returns the same reactions
  const s = statics({ cw: 35000, L: 22.7, R: 20, psi: 90 * DEG, P: 12.8, sup: floatSupports() });
  const r = solveSupport(floatSupports(), s.cop);
  ok('solveSupport API shape', r.ok && r.plane && Array.isArray(r.active) && r.active.length === 4 && typeof r.R.FL === 'number');
  near('solveSupport FL', t(r.R.FL), 35.3, 0.1);
  near('solveSupport plane z0', r.plane.z0, 1.40, 1e-9);
  ok('solveSupport CoP outside → ok:false', solveSupport(floatSupports(), { W: 1e6, X: 9, Y: 0 }).ok === false);
  near('hullMargin inside', hullMargin(floatSupports(), { X: 0, Y: 0 }), 2.79, 1e-9);
  near('hullMargin outside', hullMargin(floatSupports(), { X: -3.79, Y: 0 }), -1.0, 1e-9);
}

// ---------------------------------------------------------------- §4.9 tipping loads
{
  const fl = floatSupports(); // tipping lines = float lines (tyres clear)
  const front = tipLoad({ cw: 35000, L: 52, R: 30, psi: 0, sup: fl });
  const side = tipLoad({ cw: 35000, L: 52, R: 30, psi: 90 * DEG, sup: fl });
  const rear = tipLoad({ cw: 35000, L: 52, R: 30, psi: 180 * DEG, sup: fl });
  near('§4.9 35t/52m/R30 over front (t)', front, 12.4, 0.1);
  near('§4.9 35t/52m/R30 over side (t)', side, 9.9, 0.1);
  near('§4.9 35t/52m/R30 over rear (t)', rear, 8.8, 0.1);
  // ISO 4305 rating of the worst direction: (P_tip − 0.1F)/1.25, F = m_boom·d/L (§2)
  let md = 0, m = 0;
  fillBodies(bodies, { psi: 0, theta: 0, L: 52, cwKg: 0 });
  for (let i = BODY.boom0; i <= BODY.head; i++) { m += bodies[i].m; md += bodies[i].m * (bodies[i].x + 2.0); }
  const F = md / 52 / 1000;
  near('§4.9 rated 360° (t)', (Math.min(front, side, rear) - 0.1 * F) / 1.25, 6.6, 0.1);
  near('boom mass (t)', m / 1000, 10.1, 1e-9);
  for (const [R, w] of [[22, 7.33], [23, 6.71], [24, 6.15]]) near(`§4.9 11.5t/30.1m/R${R} over rear (t)`, tipLoad({ cw: 11500, L: 30.1, R, psi: Math.PI, sup: fl }), w, 0.02);
  const all = [...fl, ...tyreSupports()];
  const s85 = statics({ cw: 35000, L: 52, R: 30, psi: Math.PI, P: 8.5, sup: all });
  ok('8.5 t over rear stands', !s85.tipping && s85.ok, s85.state);
  near('8.5 t over rear margin (m)', s85.margin, 0.085, 0.02);
  const s95 = statics({ cw: 35000, L: 52, R: 30, psi: Math.PI, P: 9.5, sup: all });
  ok('9.5 t over rear tips', s95.state === 'TIPPING', s95.state);
  ok('9.5 t tip edge = rear floats', s95.edge && s95.edge.ids.includes('RL') && s95.edge.ids.includes('RR'), JSON.stringify(s95.edge?.ids));
  // M6 case, 11.5 t CW, 22.7 m boom, R 13.5 over the left
  near('§4.9 M6 left 50 % (t)', tipLoad({ cw: 11500, L: 22.7, R: 13.5, psi: 90 * DEG, sup: floatSupports(2.5, 3.5) }), 13.2, 0.1);
  near('§4.9 M6 left 0 % (t)', tipLoad({ cw: 11500, L: 22.7, R: 13.5, psi: 90 * DEG, sup: floatSupports(1.25, 3.5) }), 5.9, 0.1);
  near('§4.9 M6 both 100 % (t)', tipLoad({ cw: 11500, L: 22.7, R: 13.5, psi: 90 * DEG, sup: fl }), 20.4, 0.1);
  // worst float reactions over a full slew
  const worst = (P, thetaDeg, R) => {
    let f = 0, r = 0;
    for (let d = 0; d < 360; d++) {
      const s = statics({ cw: 35000, L: 11.5, R, thetaDeg, psi: d * DEG, P, sup: fl, steps: 2 });
      f = Math.max(f, s.floatR[0], s.floatR[1]); r = Math.max(r, s.floatR[2], s.floatR[3]);
    }
    return [t(f), t(r)];
  };
  const [wf, wr] = worst(82.6, null, 3);
  near('§4.9 worst front float 82.6 t @ 3 m (t)', wf, 46.4, 0.1);
  near('§4.9 worst rear float 82.6 t @ 3 m (t)', wr, 61.6, 0.1);
  const [uf, ur] = worst(0, 82, null); // unloaded: boom luffed up (backward-stability pose)
  near('§4.9 unloaded 35 t worst front float (t)', uf, 31.1, 0.1);
  near('§4.9 unloaded 35 t worst rear float (t)', ur, 36.2, 0.1);
}

// ---------------------------------------------------------------- §4.6 backward stability
{
  const worstMargin = (cw, sup) => {
    let m = Infinity;
    for (let d = 0; d < 360; d++) {
      const s = statics({ cw, L: 11.5, thetaDeg: 82, psi: d * DEG, sup, steps: 1 });
      m = Math.min(m, hullMargin(sup, s.copUnloaded));
    }
    return m;
  };
  near('§4.6 100 % 35 t', worstMargin(35000, floatSupports(3.5, 3.5)), 1.58, 0.02);
  near('§4.6 50 % 35 t', worstMargin(35000, floatSupports(2.5, 2.5)), 0.86, 0.02);
  const f0 = floatSupports(1.25, 1.25);
  near('§4.6 0 % 0 t', worstMargin(0, f0), 0.76, 0.02);
  near('§4.6 0 % 11.5 t', worstMargin(11500, f0), 0.23, 0.02);
  near('§4.6 0 % 23.5 t (tips backward)', worstMargin(23500, f0), -0.14, 0.02);
  near('§4.6 0 % 35 t (tips backward)', worstMargin(35000, f0), -0.39, 0.02);
  near('§4.6 tyres 0 t', worstMargin(0, tyreSupports()), 0.69, 0.02);
  near('§4.6 tyres 11.5 t', worstMargin(11500, tyreSupports()), 0.16, 0.02);
  const s = statics({ cw: 35000, L: 11.5, thetaDeg: 82, psi: 90 * DEG, sup: f0 });
  ok('§4.6 0 % 35 t unloaded → TIPPING', s.state === 'TIPPING', s.state);
  // asymmetric trap: left 0 %, right 100 %, 35 t, 22.7 m @ R 8, CW over the 0 % side (boom right, ψ = −90°)
  const trap = statics({ cw: 35000, L: 22.7, R: 8, psi: -90 * DEG, sup: floatSupports(1.25, 3.5) });
  near('§4.6 asymmetric trap margin (m)', trap.margin, 0.04, 0.02);
}

// ---------------------------------------------------------------- §4.7 tilt costs capacity
{
  // 52 m, 35 t, R 30 over the left side; carrier rolled toward the load by 1° / 3°
  const side = (deg) => {
    const b = -Math.tan(deg * DEG), sup = floatSupports().map((s) => ({ ...s, h: 1.40 + b * s.y }));
    return tipLoad({ cw: 35000, L: 52, R: 30, psi: 90 * DEG, sup });
  };
  const p0 = side(0), p1 = side(1), p3 = side(3);
  near('§4.7 1° tilt loss (%)', 100 * (1 - p1 / p0), 6, 2);
  near('§4.7 3° tilt loss (%)', 100 * (1 - p3 / p0), 16, 2);
  const s = statics({ cw: 35000, L: 52, R: 30, psi: 90 * DEG, P: 5, sup: floatSupports().map((q) => ({ ...q, h: 1.40 - Math.tan(1 * DEG) * q.y })) });
  near('§4.7 inclinometer reads 1.0°', s.tiltDeg, 1.0, 0.01);
  near('§4.7 roll sign (left side down = negative)', s.tilt.roll / DEG, -1.0, 0.01);
}

// ---------------------------------------------------------------- §4.5 tip dynamics
{
  const sup = [...floatSupports(), ...tyreSupports()];
  const s = statics({ cw: 35000, L: 52, R: 30, psi: Math.PI, P: 9.0, sup, steps: 1 });
  ok('9.0 t over rear starts TIPPING', s.state === 'TIPPING' && s.events.some((e) => e.type === 'tipStart'), s.state);
  const th = Math.acos(32 / 52), hc = headCarrier(Math.PI, th, 52), head = s.carrierPoint(hc.x, hc.y, hc.z, {}, false);
  const bw = s.bodiesWorld(bodies);
  // §4.5 "I_e ≈ 36,500 t·m²" counts the 9 t load as a point mass at the head; the EOM's I_e is
  // bodies only (the load acts through the rope force), so compare like with like.
  const E = s.edge, rx = head.x - E.p0.x, ry = head.y - E.p0.y, rz = head.z - E.p0.z, al = rx * E.e.x + ry * E.e.y + rz * E.e.z;
  near('§4.5 I_e bodies + load point mass (t·m²)', (E.Ie + 9000 * (rx * rx + ry * ry + rz * rz - al * al)) / 1000, 36500, 36500 * 0.1);
  near('§4.5 I_e bodies only (t·m²)', E.Ie / 1000, 14200, 700);
  const tau = tipTimeConstant(s, bw, 9000 * G, head, 9000);
  ok(`§4.5 τ = ${tau.toFixed(2)} s in 1.5–2.1 (load rope-coupled)`, tau >= 1.5 && tau <= 2.1);
  const tauRigid = tipTimeConstant(s, bw, 9000 * G, head);
  ok(`§4.5 τ constant rope force = ${tauRigid.toFixed(2)} s (faster bound)`, tauRigid > 1.1 && tauRigid < tau);
  // keep the load hanging (rope force constant): it goes over
  const F = { x: 0, y: -9000 * G, z: 0 };
  let tOver = null;
  for (let k = 1; k < 120 * 30 && tOver === null; k++) {
    s.update(DT, s.bodiesWorld(bodies), F, head, sup);
    if (s.state === 'OVERTURNED') tOver = k * DT;
  }
  ok(`§4.5 overturns with the load hanging (t = ${tOver?.toFixed(1)} s)`, tOver !== null && tOver > 2 && tOver < 20);
  ok('§4.5 root transform tilted', (() => { const m = { e: null, set(...a) { this.e = a; return this; } }; s.rootTransform(m); return Math.abs(m.e[5]) < 0.99; })());
  for (let k = 0; k < 120 * 10 && !s.resting; k++) s.update(DT, s.bodiesWorld(bodies), F, head, sup);
  ok('§4.5 overturned machine comes to rest', s.resting && s.phi > 30 * DEG, `${(s.phi / DEG).toFixed(1)}°`);
  ok('OVERTURNED: no stale stability margin (HUD —)', Number.isNaN(s.margin), `${s.margin}`);

  // recovery: tip starts, the load lands once φ > 1° (rope slack) → falls back, slam
  const r = statics({ cw: 35000, L: 52, R: 30, psi: Math.PI, P: 9.0, sup, steps: 1 });
  const ev = [];
  let landedAt = null;
  for (let k = 0; k < 120 * 20; k++) {
    if (landedAt === null && r.phi > 1 * DEG) landedAt = k;
    r.update(DT, r.bodiesWorld(bodies), landedAt === null ? F : { x: 0, y: 0, z: 0 }, head, sup);
    ev.push(...r.events);
    if (landedAt !== null && r.state !== 'TIPPING') break;
  }
  const slam = ev.find((e) => e.type === 'slam');
  ok('§4.5 load lands → slam back to STABLE', !!slam && slam.speed > 0 && r.state !== 'TIPPING' && r.state !== 'OVERTURNED', `${r.state} ${JSON.stringify(ev.map((e) => e.type))}`);
}

// ---------------------------------------------------------------- rocking (short jack, front tyres)
{
  // RR jack 5 cm short: slewing a load around rocks the carrier across the diagonal (≈ 0.4°), no tip
  const sup = [...floatSupports(), ...tyreSupports()];
  sup[3].h -= 0.05;
  const s = new Stability(); s.setCarrier(0, 0, 0);
  const L = 22.7, th = Math.acos(22 / L), head = {}, F = { x: 0, y: -8000 * G, z: 0 };
  const types = new Set(); let maxTilt = 0, minTilt = 9;
  for (let d = 0; d <= 360; d += 0.25) {
    fillBodies(bodies, { psi: d * DEG, theta: th, L, cwKg: 35000 });
    const hc = headCarrier(d * DEG, th, L);
    s.carrierPoint(hc.x, hc.y, hc.z, head, false);
    for (let k = 0; k < 6; k++) { s.update(DT, s.bodiesWorld(bodies), F, head, sup); s.events.forEach((e) => types.add(e.type)); }
    if (!s.edge) { maxTilt = Math.max(maxTilt, s.tiltDeg); minTilt = Math.min(minTilt, s.tiltDeg); }
  }
  ok('short jack: rocks across the diagonal', types.has('rockStart') && types.has('rock'), [...types].join(','));
  ok('short jack: never TIPPING', !types.has('tipStart') && s.state !== 'OVERTURNED');
  // §4.3 "about 0.4°" per axis: 5 cm over the 7.0 m base = 0.41° roll, over 7.37 m = 0.39° pitch → 0.56° total
  near('short jack: rocked tilt (max, total)', maxTilt, Math.hypot(Math.atan(0.05 / 7), Math.atan(0.05 / 7.37)) / DEG, 0.03);
  near('short jack: level on the good diagonal (min)', minTilt, 0, 0.03);

  // Over the front the front tyres (x 5.60) lie outside the float line (4.58):
  // the carrier pitches forward about the front floats and lands on them.
  const s2 = new Stability(); s2.setCarrier(0, 0, 0);
  const all = [...floatSupports(), ...tyreSupports()];
  const RF = 8, thF = Math.acos((RF + 2) / 11.5);
  fillBodies(bodies, { psi: 0, theta: thF, L: 11.5, cwKg: 0 });
  const hc = headCarrier(0, thF, 11.5), hd = {};
  s2.carrierPoint(hc.x, hc.y, hc.z, hd, false);
  s2.update(DT, s2.bodiesWorld(bodies), { x: 0, y: -15000 * G, z: 0 }, hd, all); // settle
  const pf = tipLoad({ cw: 0, L: 11.5, R: RF, psi: 0, sup: floatSupports() });
  const evs = [];
  let landed = null;
  for (let k = 0; k < 120 * 15 && !landed; k++) {
    const P = Math.min(pf * 1.03, 15 + k * 0.05); // hoist a little past the float-line tipping load
    fillBodies(bodies, { psi: 0, theta: thF, L: 11.5, cwKg: 0 });
    s2.carrierPoint(hc.x, hc.y, hc.z, hd, false);
    s2.update(DT, s2.bodiesWorld(bodies), { x: 0, y: -P * 1000 * G, z: 0 }, hd, all);
    for (const e of s2.events) { evs.push(e.type); if (e.landed) landed = e; }
  }
  void pf;
  ok('front: rock onto the front tyres (landed)', !!landed && evs.includes('rockStart'), evs.join(','));
  near('front: pitched nose-down ≈ 5.5° on the tyres', s2.tilt.pitch / DEG, -5.5, 0.6);
  ok('front: near tip-over reported as slam', landed?.type === 'slam');
}

// ---------------------------------------------------------------- ground (§4.8)
{
  ok('P1 hardcore 400', groundAt(57, -12).allowKPa === 400 && groundAt(57, -12).kind === 'hardcore');
  ok('site fill 200', groundAt(0, 30).allowKPa === 200);
  ok('road asphalt 200', groundAt(-82, -66).allowKPa === 200 && groundAt(-82, -66).kind === 'asphalt');
  ok('sidewalk / lot 100', groundAt(-82, -59.5).allowKPa === 100);
  near('ult = 2.5 × allow', groundAt(57, -12).ultKPa, 1000, 1e-9);
  const z = addZone({ minX: 40, maxX: 45, minZ: -30, maxZ: -20 }, { kind: 'soft', allowKPa: 80 });
  ok('job zone wins', groundAt(42, -25).allowKPa === 80 && groundAt(42, -25).ultKPa === 200);
  addZone({ x: 0, z: 0, hx: 2, hz: 1, yaw: Math.PI / 2 }, { kind: 'rot', allowKPa: 50 });
  ok('oriented zone', groundAt(0, 1.8).allowKPa === 50 && groundAt(1.8, 0).allowKPa !== 50);
  clearZones();
  ok('clearZones', groundAt(42, -25).allowKPa === 200);
  void z;
  const R = 61.6 * 1000 * G;
  near('p on carried mat (kPa)', pressureKPa(R, MATS.carried.area), 345, 1);
  near('p on composite mat (kPa)', pressureKPa(R, MATS.composite.area), 186, 1);
  near('p on bare pad (kPa)', pressureKPa(R, MATS.none.area), 2497, 5);
  const st = new Settlement(), pos = [{ x: 0, z: 30 }, { x: 0, z: 30 }, { x: 0, z: 30 }, { x: 0, z: 30 }];
  st.update(1.0, [R, 0, 0, 0], [1.75, 1.75, 1.75, 1.75], pos); // 345 kPa on 200 kPa fill
  near('settle rate 0.004·(p/allow − 1)', st.s[0], 0.004 * (345.3 / 200 - 1), 1e-4);
  const ev = [];
  for (let k = 0; k < 240; k++) ev.push(...st.update(DT, [R, 0, 0, 0], [0.242, 1.75, 1.75, 1.75], pos));
  ok('bare pad punch-through', ev.some((e) => e.type === 'punch') && ev.some((e) => e.type === 'punchCritical'));
  near('punch-through stops at 0.40 m', st.s[0], 0.40, 1e-9);
  ok('settle KPI events 20 / 50 mm', ev.some((e) => e.type === 'settle' && e.mm === 20) && ev.some((e) => e.type === 'settle' && e.mm === 50));
  // below ultimate the float consolidates to a finite settlement instead of sinking forever:
  // bare pad on P1 hardcore (400 kPa), 713 kPa → s∞ = 0.05·(713/400 − 1) ≈ 39 mm
  const s3 = new Settlement(), p1 = [0, 1, 2, 3].map(() => ({ x: 57, z: -11 })), Rb = 713 * 0.242 * 1000;
  for (let k = 0; k < 20 * 120; k++) s3.update(DT, [Rb, Rb, Rb, Rb], [0.242, 0.242, 0.242, 0.242], p1);
  const s20 = s3.s[0];
  for (let k = 0; k < 280 * 120; k++) s3.update(DT, [Rb, Rb, Rb, Rb], [0.242, 0.242, 0.242, 0.242], p1);
  ok('settles, then stabilises (no punch-through below ultimate)', !s3.punched && s20 > 0.02 && s3.s[0] - s20 < 0.02, `${s20} → ${s3.s[0]}`);
  near('settlement levels off at s∞ (m)', s3.s[0], 0.05 * (713 / 400 - 1), 1e-4);
}

// ---------------------------------------------------------------- FLOAT_LIGHT (§4.4)
{
  // An in-chart lift over a CORNER unloads the diagonal float alone (the §4.3 ψ = 135° case: FR 0.0 t
  // at 100 % of the chart) — not a tipping precursor. Over the side an EDGE goes light before tipping.
  // floats set unloaded first (as in play), then the load goes on the hook
  const sup = floatSupports(), run = (psi, P) => {
    const th = Math.acos((20 + 2) / 22.7), st = new Stability(), hd = { x: 0, y: 0, z: 0 };
    st.setCarrier(0, 0, 0);
    fillBodies(bodies, { psi: psi * DEG, theta: th, L: 22.7, cwKg: 35000 });
    const hc = headCarrier(psi * DEG, th, 22.7);
    for (let k = 0; k < 300 && !st.tipping; k++) {
      const F = { x: 0, y: k < 120 ? 0 : -P * 1000 * G, z: 0 }, bw = st.bodiesWorld(bodies);
      st.carrierPoint(hc.x, hc.y, hc.z, hd, false);
      st.update(DT, bw, F, hd, sup);
    }
    return st;
  };
  const corner = run(135, 12.8);
  ok('corner lift at 100 %: diagonal float ~0 t', t(corner.floatR[1]) < 0.5, `${t(corner.floatR[1])}`);
  ok('corner lift at 100 %: no OUTRIGGER LIGHT', corner.state === 'STABLE' && !corner.floatLight.some(Boolean), `${corner.state} ${corner.floatLight}`);
  const tipSide = tipLoad({ cw: 35000, L: 22.7, R: 20, psi: 90 * DEG, sup });
  const side = run(90, 0.92 * tipSide);
  ok('side lift near tipping: far edge light', side.state === 'FLOAT_LIGHT' && side.floatLight[1] && side.floatLight[3] && !side.floatLight[0], `${side.state} ${side.floatLight} edge ${side.edgeReserve}`);
  const sideOk = run(90, 12.8);
  ok('side lift at 100 %: no OUTRIGGER LIGHT', !sideOk.floatLight.some(Boolean), `edge ${sideOk.edgeReserve}`);
}

// ---------------------------------------------------------------- outriggers
{
  const pose = { x: P1.x, z: P1.z, yaw: P1.yaw };
  const flat = () => 0;
  const o = new Outriggers();
  o.reset({ beams: [0, 0, 0, 0], jacksSet: false, mats: ['none', 'none', 'none', 'none'] }, flat, pose);
  near('ext ↔ y at 50 %', yOfExt(0.5), BASES[50], 1e-12);
  near('extOfY(3.5)', extOfY(3.5), 1, 1e-12);
  ok('road stance: all beams at 0 %', o.detentMin() === 0 && o.allAtDetent);
  // extend FL: stops at the 50 % detent, hold 0.6 s to pass, end at 100 %
  o.select(0);
  const evs = [];
  let tStop = null, tEnd = null;
  for (let k = 1; k <= 120 * 20; k++) {
    evs.push(...o.update(DT, { beam: 1, jack: 0 }, null, null, flat, { pose }));
    if (tStop === null && o.beams[0].pausedAt !== null) tStop = k * DT;
    if (tEnd === null && o.beams[0].y >= 3.5) tEnd = k * DT;
  }
  near('beam 0 → 50 % at 0.20 m/s (s)', tStop, 1.25 / 0.20, 0.02);
  near('beam 0 → 100 % incl. 0.6 s detent hold (s)', tEnd, 2.25 / 0.20 + 0.6, 0.03);
  ok('detent + end events', evs.some((e) => e.type === 'detent') && evs.some((e) => e.type === 'beamEnd'));
  ok('other beams untouched', o.beams[1].y === 1.25 && o.beams[0].detent === 1);
  near('FL float world x at 100 % (P1)', (() => { o.supports(pose, null, null, flat); return o.floatWorld[0].x; })(), P1.floats[0][0], 1e-9);
  near('FL float world z at 100 % (P1)', o.floatWorld[0].z, P1.floats[0][1], 1e-9);
  // interlock: loaded float locks its beam
  o.update(DT, { beam: -1, jack: 0 }, null, null, flat, { pose, floatR: [6e3, 0, 0, 0] });
  ok('beam-under-load interlock', o.beams[0].locked && o.beams[0].y === 3.5 && o.message === 'RETRACT JACK FIRST');
  // engine / parking brake
  o.update(DT, { beam: -1, jack: 0 }, null, null, flat, { pose, enabled: false });
  ok('disabled without engine + parking brake', o.beams[0].y === 3.5);

  // M6 barriers block the left beams at 100 % → stops at the pad edge (> 50 %), counts as 50 %
  const world = new ColliderWorld();
  for (const z of [-16.5, -13.5, -10.5, -7.5]) world.add(new Box(60.9, 0.5, z, 0.5, 0.5, 1.5, 0, 'barrier'));
  const o2 = new Outriggers();
  o2.reset({ beams: [0, 0, 0, 0] }, flat, pose);
  o2.select(4);
  const ev2 = [];
  for (let k = 0; k < 120 * 20; k++) ev2.push(...o2.update(DT, { beam: 1, jack: 0 }, null, world, flat, { pose }));
  ok('M6: left beams obstructed', o2.beams[0].obstructed && o2.beams[2].obstructed && ev2.some((e) => e.type === 'obstructed'));
  near('M6: left float stops at the barrier (y)', o2.beams[0].y, 60.4 - 0.275 - P1.x, 0.004);
  ok('M6: right beams reach 100 %', o2.beams[1].detent === 1 && o2.beams[3].detent === 1);
  ok('M6: detentMin = 50, off-detent flagged', o2.detentMin() === 50 && !o2.allAtDetent);
  // retract left to the 50 % detent: obstruction clears, then lay carried mats
  o2.select(0);
  for (let k = 0; k < 120 * 3.3; k++) o2.update(DT, { beam: -1, jack: 0 }, null, world, flat, { pose }); // 3.1 s to the detent, < 0.6 s hold
  o2.update(DT, { beam: 0, jack: 0 }, null, world, flat, { pose });
  ok('M6: left front back at 50 %', o2.beams[0].detent === 0.5 && !o2.beams[0].obstructed, `${o2.beams[0].y}`);

  // mats + auto-level on flat ground (§4.7): e* = z* − G − 0.90 with z* = 1.30 + 0.10
  const open = new ColliderWorld();
  const o3 = new Outriggers();
  o3.reset({ beams: [1, 1, 1, 1], mats: ['none', 'none', 'none', 'none'] }, flat, pose);
  o3.select(4);
  const r0 = o3.update(DT, { beam: 0, jack: 0 }, ['mat'], open, flat, { pose });
  ok('mat placement started (4 s riggers)', o3.matPending.every((m) => m === 'carried'), JSON.stringify(r0));
  const r1 = o3.cycleMat(null, flat, pose);
  ok('mat busy while riggers work', !r1.ok);
  let placed = 0;
  for (let k = 0; k < 120 * 4 + 2; k++) placed += o3.update(DT, { beam: 0, jack: 0 }, null, open, flat, { pose }).filter((e) => e.type === 'matPlaced').length;
  ok('4 carried mats placed', placed === 4 && o3.matsAll && o3.mats[0] === 'carried');
  const stab = new Stability(); stab.setCarrier(pose.x, pose.z, pose.yaw);
  fillBodies(bodies, { psi: 0, theta: 55 * DEG, L: 22.7, cwKg: 35000 });
  let lvl = null, tLevel = 0;
  const evLog = [];
  for (let k = 0; k < 120 * 30 && !lvl; k++) {
    const e = o3.update(DT, { beam: 0, jack: 0, autoLevel: true }, null, open, flat, { pose: stab.pose, floatR: stab.floatR });
    const sup = o3.supports(stab.pose, null, stab.floatR, flat);
    stab.update(DT, stab.bodiesWorld(bodies), null, null, sup);
    evLog.push(...stab.events.map((q) => q.type));
    if (e.some((q) => q.type === 'levelDone')) { lvl = true; tLevel = k * DT; }
  }
  near('auto-level e* on carried mats (m)', o3.jacks[0].e, 1.40 - 0.12 - 0.90, 5e-4);
  ok(`auto-level done (${tLevel.toFixed(1)} s)`, lvl && tLevel > 5 && tLevel < 12);
  for (let k = 0; k < 60; k++) { const sup = o3.supports(stab.pose, null, stab.floatR, flat); stab.update(DT, stab.bodiesWorld(bodies), null, null, sup); }
  ok('levelled: floats set, tyres clear, STABLE', o3.floatsSet && o3.tyresClear && stab.state === 'STABLE' && !stab.tyresActive, `${o3.floatsSet} ${o3.tyresClear} ${stab.state}`);
  ok('levelled: |tilt| ≤ 0.3°', stab.tiltDeg <= 0.3, `${stab.tiltDeg}`);
  // frame datum 1.40 m (tyres 0.10 clear) less the ground compliance R/k_g (≈ 1 cm)
  near('levelled: frame datum ≈ 1.40 m − compliance', stab.pose.z0, 1.40 - (stab.floatR.reduce((a, b) => a + b, 0) / 4) / 20e6, 0.002);
  ok('levelled: no spurious lift-off / light events during touchdown', !evLog.includes('liftoff') && !evLog.includes('floatLight'), evLog.join(','));
  // mats in the M6 world: the left carried mat (to x 61.375) would sit on the barrier
  const oM = new Outriggers();
  oM.reset({ beams: [1, 1, 1, 1] }, flat, pose);
  oM.select(0);
  ok('mat obstructed by the M6 barrier', !oM.cycleMat(world, flat, pose).ok && oM.message === 'MAT OBSTRUCTED');
  ok('all floats latched as set', stab.floatSet.every(Boolean));
  const mr = o3.cycleMat(null, flat, stab.pose);
  ok('mat change refused with the float down', !mr.ok && /raise/.test(mr.reason));
  // level range: one float over a 0.5 m hole
  const hole = (x, z) => (Math.hypot(x - P1.floats[3][0], z - P1.floats[3][1]) < 1 ? -0.5 : 0);
  const o4 = new Outriggers();
  o4.reset({ beams: [1, 1, 1, 1] }, hole, pose);
  const e4 = o4.update(DT, { beam: 0, jack: 0, autoLevel: true }, null, null, hole, { pose });
  ok('LEVEL RANGE EXCEEDED over a hole', e4.some((e) => e.type === 'levelRange') && /cribbing/.test(o4.message));
  // settlement lowers a float → the carrier tilts (support height follows)
  const settle = [0, 0, 0.05, 0];
  for (let k = 0; k < 120; k++) { const sup = o3.supports(stab.pose, settle, stab.floatR, flat); stab.update(DT, stab.bodiesWorld(bodies), null, null, sup); }
  ok('settlement tilts the carrier', stab.tiltDeg > 0.2, `${stab.tiltDeg}`);
  // reset from the pad preset: set and level at once
  const o5 = new Outriggers();
  o5.reset({ beams: [1, 1, 1, 1], jacksSet: true, levelled: true, mats: ['carried', 'carried', 'carried', 'carried'] }, flat, pose);
  near('pad preset jack e', o5.jacks[2].e, 0.38, 1e-9);
  ok('pad preset levelState done', o5.levelState === 'done');
}

// ---------------------------------------------------------------- ballast (§6.6)
{
  const pose = { x: P1.x, z: P1.z, yaw: P1.yaw, z0: 1.40 };
  const b = new Ballast();
  b.reset(23500, []);
  ok('reset 23.5 t = A + B', b.superKg === 23500 && b.superSlabs.join('') === 'AB');
  const deck = carrierToWorld(pose, pose.yaw, CW_DECK.x, CW_DECK.y);
  const slab = (type, dx = 0, dyaw = 0, bottom = 1.40 - 1.30 + CW_DECK.topZ) => ({ type, pos: { x: deck.x + dx, y: bottom + 0.235, z: deck.z }, yaw: pose.yaw + Math.PI / 2 + dyaw, half: { y: 0.235 } });
  ok('slab C on the deck absorbs', b.canAbsorb(slab('cwC'), pose), b.lastReason);
  ok('off the deck zone refused', !b.canAbsorb(slab('cwC', 0.2), pose));
  ok('yaw out by 5° refused', !b.canAbsorb(slab('cwC', 0, 5 * DEG), pose));
  ok('turned 180° accepted', b.canAbsorb(slab('cwC', 0, Math.PI), pose));
  ok('slab A already fitted refused', !b.canAbsorb(slab('cwA'), pose));
  ok('not a slab refused', !b.canAbsorb({ ...slab('cwC'), type: 'testBlock5' }, pose));
  b.absorb(slab('cwC'));
  ok('deck stack 11.5 t', b.deckKg === 11500 && b.deckH === 0.47 && b.update(DT, false, true).some((e) => e.type === 'absorbed'));
  ok('raise needs the pin', !b.startRaise(false).ok && b.lastReason === 'TURNTABLE NOT PINNED');
  ok('raise starts pinned', b.startRaise(true).ok && b.busy);
  for (let k = 0; k < 120 * 10; k++) b.update(DT, false, true);
  near('no progress without holding B', b.progress, 0, 1e-12);
  let raised = null;
  for (let k = 0; k < 120 * 46 && !raised; k++) raised = b.update(DT, true, true).find((e) => e.type === 'raised');
  ok('raised to 35 t in 45 s', raised && raised.kg === 35000 && b.superKg === 35000 && b.deckKg === 0);
  ok('lower needs a clear deck / pin', !b.startLower(false).ok);
  ok('lower (demob) starts', b.toggle(true).ok && b.direction === -1);
  let lowered = null;
  for (let k = 0; k < 120 * 46 && !lowered; k++) lowered = b.update(DT, true, true).find((e) => e.type === 'lowered');
  ok('lowered onto the deck', lowered && b.superKg === 0 && b.deckKg === 35000 && b.deckStack.length === 3);
  const top = b.takeTop();
  ok('takeTop hands back slab C', top && top.id === 'C' && top.loadType === 'cwC' && b.deckKg === 23500);
  // invalid combination: A on the super, C on the deck → 23.0 t is not a CW config
  const c = new Ballast(); c.reset(11500, ['C']);
  ok('A + C not a valid CW config', !c.startRaise(true).ok && c.lastReason === 'CW COMBINATION NOT VALID');
  const q = new Ballast(); q.quick = true; q.reset(11500, ['B']);
  ok('quick ballast instant', q.startRaise(true).ok && q.superKg === 23500);
  const qe = q.update(DT, false, true);
  ok('quick ballast penalty 120 s', qe.some((e) => e.type === 'quick' && e.penalty === 120) && qe.some((e) => e.type === 'raised'));
  // deck slabs are carrier bodies
  fillBodies(bodies, { psi: 0, theta: 0.5, L: 11.5, cwKg: 11500, deckKg: 12000, deckH: 0.49 });
  near('deck slab body z', bodies[BODY.deck].z, CW_DECK.topZ + 0.245, 1e-12);
  near('deck slab body mass', bodies[BODY.deck].m, 12000, 1e-12);
}

// ---------------------------------------------------------------- body model sanity
{
  near('extForLength(52) sums to 5', extForLength(52).reduce((a, b) => a + b, 0), 5, 1e-9);
  near('lengthForExt(extForLength(30.1))', lengthForExt(extForLength(30.1)), 30.1, 1e-9);
  fillBodies(bodies, { psi: 0, theta: 0, L: 11.5, cwKg: 0 });
  let m = 0; for (const b of bodies) m += b.m;
  near('basic crane mass 46.7 t (no CW)', m / 1000, 46.7, 1e-9);
  const s = new Stability(); s.setCarrier(10, 5, -Math.PI / 2);
  const p = s.carrierPoint(1, 2, 1.30, {}, false);
  near('carrierPoint yaw −π/2: x', p.x, 10 + 2, 1e-12);
  near('carrierPoint yaw −π/2: z', p.z, 5 + 1, 1e-12);
  near('carrierPoint datum height', p.y, 1.30, 1e-12);
}

console.log(`${checks - fails}/${checks} stability checks passed`);
process.exit(fails ? 1 : 0);
