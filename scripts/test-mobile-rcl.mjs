// WP-PHYS: RCL / LMI (spec §5), crane drives (§3.2–§3.6) and the
// backward-compatible HoistSystem options (§3.5). Plain node:
// `node scripts/test-mobile-rcl.mjs`.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RCL, shortCode } from '../src/mobile/rcl.js';
import { MobileDrives, rotatingProps, ropeLoads, tiltTorque, deflectionOmega } from '../src/mobile/drives.js';
import { thetaForRadius, headLocal } from '../src/mobile/boom.js';
import { HoistSystem } from '../src/physics/rope.js';
import { CRANE } from '../src/config.js';
import { HOOK_BLOCKS, DRIVES } from '../src/mobile/config.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const DEG = Math.PI / 180, G = 9.81, dt = 1 / 120;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };
const ALL = ['hoistUp', 'lower', 'luffUp', 'luffDown', 'teleOut', 'teleIn', 'slewL', 'slewR'];
const permOf = (r) => Object.fromEntries(ALL.map((k) => [k, r.perm[k]]));
const expectPerm = (r, want, msg) => { for (const [k, v] of Object.entries(want)) near(r.perm[k], v, 1e-9, `${msg} perm.${k}`); };

// A crane at P1 (axis (57, −12), yaw −π/2) with 22.7 m boom, 35 t CW, full base.
function snapAt(over = {}) {
  const L = over.L ?? 22.678, R = over.R ?? 12, psi = over.psi ?? 0, yaw = -Math.PI / 2;
  const th = thetaForRadius(L, R), h = headLocal(L, th, 0, 0, 0.1);
  const az = yaw + psi, axis = { x: 57, z: -12 };
  const head = { x: axis.x + h.u * Math.cos(az), y: h.z, z: axis.z - h.u * Math.sin(az) };
  return {
    grossKg: 250, R, L, pinnedK: 3, thetaG: th, luffDeg: th / DEG, headPos: head, hookPos: { ...head, y: head.y - 10 }, loadPos: null,
    loadAttached: false, loadGrounded: false, hookGrounded: false, twoBlock: false, drumRope: 150,
    beamsActual: [100, 100, 100, 100], floatsSet: true, floatsInContact: 4, tyresActive: false, tiltDeg: 0.1, wind: 3,
    levers: { slew: 0, tele: 0, luff: 0, hoist: 0 }, power: true, eStop: false, mode: 'CRANE', turntablePinned: false,
    axis, yaw, psi, psiDot: 0, inertia: 1e6, ...over,
  };
}
const CFG = { mode: 'outriggers', base: 100, cwKg: 35000, block: 'hb26', confirmed: true };
function armed(cfg = CFG) { const r = new RCL(cfg); r.reset(cfg, true); return r; }

// -------------------------------------------------------------------- RCL
test('short code, power-on confirmation, mode gating (§5)', () => {
  assert.equal(shortCode({ mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' }), 'OR B100 CW35.0 n1 BALL');
  assert.equal(shortCode({ mode: 'tyres', base: 0, cwKg: 0, block: 'hb26' }), 'TY CW0.0 n3 HB26');
  const r = new RCL({ ...CFG, confirmed: true });
  r.update(dt, snapAt()); // power-on edge: the dialog must be confirmed again
  assert.equal(r.state, 'noconfig');
  expectPerm(r, { hoistUp: 0, lower: 1, luffUp: 0, luffDown: 0, teleOut: 0, teleIn: 1, slewL: 0, slewR: 0 }, 'noconfig');
  assert.ok(r.stops.has('NO_CONFIG'));
  r.confirm(); r.update(dt, snapAt());
  assert.equal(r.state, 'blue'); assert.deepEqual(permOf(r), Object.fromEntries(ALL.map((k) => [k, 1])));
  r.update(dt, snapAt({ mode: 'SETUP' }));
  assert.equal(r.state, 'off'); ALL.forEach((k) => assert.equal(r.perm[k], 0, `SETUP ${k}`));
  r.update(dt, snapAt()); assert.equal(r.state, 'blue', 'a mode change is not a power cycle');
  r.update(dt, snapAt({ eStop: true })); ALL.forEach((k) => assert.equal(r.perm[k], 0, `e-stop ${k}`));
  r.update(dt, snapAt()); assert.equal(r.state, 'noconfig', 'e-stop reset powers on again → confirm');
});

test('states and colours: blue / ok / warn / stop (§5)', () => {
  const r = armed();
  // 22.7 m @ 12 m, 35 t: chart 25.6 t, hb26 26.1 t → cap 25.6 t
  r.update(dt, snapAt({ grossKg: 4000 })); assert.equal(r.state, 'blue'); near(r.capKg, 25600, 1e-6, 'cap');
  r.update(dt, snapAt({ grossKg: 12000 })); assert.equal(r.state, 'ok');
  r.update(dt, snapAt({ grossKg: 24000 })); assert.equal(r.state, 'warn'); assert.ok(r.alarm.beep);
  r.update(dt, snapAt({ grossKg: 25700 })); assert.equal(r.state, 'stop'); assert.ok(r.alarm.horn);
  assert.equal(r.colour, '#ff3030');
});

test('STOP permissions and hysteresis with the neutral requirement (§5, [S9])', () => {
  const r = armed();
  const hang = { grossKg: 26000, loadAttached: true, loadGrounded: false };
  r.update(dt, snapAt({ ...hang, levers: { hoist: 1 } }));
  assert.equal(r.state, 'stop'); assert.equal(r.counters.lmiTrips, 1); assert.deepEqual(r.events, ['lmiTrip']);
  // tele-in is 1* in STOP: 0 here because 26 t > T_tel(22.7) = 12 t
  expectPerm(r, { hoistUp: 0, lower: 1, luffUp: 1, luffDown: 0, teleOut: 0, teleIn: 0, slewL: 1, slewR: 1 }, 'STOP suspended');
  r.update(dt, snapAt({ ...hang, loadGrounded: true }));
  expectPerm(r, { luffUp: 0 }, 'STOP grounded: no lifting by luffing');
  // 0.99 does not release; 0.97 with a lever deflected does not release; neutral releases
  r.update(dt, snapAt({ ...hang, grossKg: 25600 * 0.99 })); assert.equal(r.state, 'stop');
  r.update(dt, snapAt({ ...hang, grossKg: 25600 * 0.97, levers: { luff: 0.5 } })); assert.equal(r.state, 'stop');
  r.update(dt, snapAt({ ...hang, grossKg: 25600 * 0.97 })); assert.equal(r.state, 'warn');
  assert.equal(r.counters.lmiTrips, 1);
  r.update(dt, snapAt({ ...hang, grossKg: 25700 })); assert.equal(r.counters.lmiTrips, 2, 'new trip counted');
  // beyond Rmax (capacity 0 → STOP): luff-up is the way back even with the hook grounded
  const b = armed();
  b.update(dt, snapAt({ R: 20.5, hookGrounded: true }));
  assert.equal(b.state, 'stop'); assert.ok(b.stops.has('RANGE'));
  expectPerm(b, { hoistUp: 0, lower: 1, luffUp: 1, luffDown: 0, teleOut: 0, teleIn: 1 }, 'R > Rmax');
  // block rating: 27 t on hb26 → STOP + BLOCK
  const c = armed();
  c.update(dt, snapAt({ R: 6, grossKg: 27000, loadAttached: true })); assert.equal(c.state, 'stop'); assert.ok(c.stops.has('BLOCK'));
  // horn mute only after 5 s
  assert.equal(c.mute().ok, false);
  for (let i = 0; i < 5.1 * 120; i++) c.update(dt, snapAt({ R: 6, grossKg: 27000, loadAttached: true }));
  assert.ok(c.mute().ok); c.update(dt, snapAt({ R: 6, grossKg: 27000, loadAttached: true })); assert.equal(c.alarm.horn, false);
});

test('permission matrix: limits, working range, tele load, pin (§5)', () => {
  const r = armed();
  r.update(dt, snapAt({ twoBlock: true, levers: { hoist: 1 } }));
  expectPerm(r, { hoistUp: 0, lower: 1, luffUp: 1, luffDown: 0, teleOut: 0, teleIn: 1, slewL: 1 }, 'hook limit');
  assert.equal(r.counters.twoBlockCount, 1); assert.ok(r.events.includes('upperLimit'));
  r.update(dt, snapAt({ twoBlock: true, levers: { hoist: 1 } })); assert.equal(r.counters.twoBlockCount, 1, 'edge only');
  r.update(dt, snapAt({ drumRope: 4.9 })); expectPerm(r, { lower: 0, hoistUp: 1 }, 'lowering limit');
  r.update(dt, snapAt({ R: 3.9 })); expectPerm(r, { luffUp: 0, luffDown: 1 }, 'R < Rmin (4 m at 22.7)'); assert.ok(r.stops.has('RMIN'));
  r.update(dt, snapAt({ luffDeg: 82 })); expectPerm(r, { luffUp: 0 }, 'luff stop 82°');
  r.update(dt, snapAt({ luffDeg: -1 })); expectPerm(r, { luffDown: 0 }, 'luff stop −1°');
  r.update(dt, snapAt({ R: 6, grossKg: 13000 })); expectPerm(r, { teleOut: 0, teleIn: 0, hoistUp: 1 }, 'gross > T_tel(22.7) = 12 t');
  r.update(dt, snapAt({ turntablePinned: true })); expectPerm(r, { slewL: 0, slewR: 0, luffUp: 1 }, 'turntable pinned');
  // between pins: T_tel caps the capacity, TELE_NOT_PINNED warning
  r.update(dt, snapAt({ L: 24, pinnedK: null, R: 8, grossKg: 7000 }));
  near(r.capKg, 8000, 1e-6, 'unpinned cap = T_tel'); assert.ok(r.warnings.has('TELE_NOT_PINNED'));
  // not-permitted config (only possible as a pre-fill): refuse to confirm, block the unsafe motions
  const np = new RCL(); np.reset({ mode: 'outriggers', base: 0, cwKg: 11500, block: 'ball', confirmed: true }, true);
  np.update(dt, snapAt());
  expectPerm(np, { hoistUp: 0, lower: 1, luffDown: 0, teleOut: 0, teleIn: 1 }, 'not permitted');
  assert.ok(np.stops.has('NOT_PERMITTED')); assert.equal(np.confirm().ok, false);
});

test('reconfiguration gate: < 20 % AND ≤ 0.5 t hook load (§5, [S14])', () => {
  const r = armed();
  r.update(dt, snapAt({ grossKg: 6000 })); // 23 %
  let res = r.configure({ cwKg: 23500 }); assert.equal(res.ok, false); assert.match(res.reason, /UTILISATION/);
  r.update(dt, snapAt({ R: 6, grossKg: 1500 })); // 1500/26100 = 6 % but 1.05 t net
  res = r.configure({ cwKg: 23500 }); assert.equal(res.ok, false); assert.match(res.reason, /HOOK LOAD/);
  r.update(dt, snapAt({ R: 6, grossKg: 900 })); // 0.45 t net with hb26
  res = r.configure({ cwKg: 23500 }); assert.ok(res.ok && res.changed); assert.equal(r.confirmed, false);
  assert.equal(r.counters.configChanges, 1); assert.ok(r.events.includes('configChanged'));
  assert.equal(r.configure({ base: 0, cwKg: 35000 }).ok, false, 'not permitted refused');
  assert.ok(r.confirm().ok); assert.equal(r.shortCode, 'OR B100 CW23.5 n3 HB26');
  // hb90 (0.7 t) unloaded can still be reconfigured (net rule)
  const h = armed({ ...CFG, block: 'hb90' });
  h.update(dt, snapAt({ R: 6, grossKg: 700 })); assert.ok(h.configure({ cwKg: 23500 }).ok);
  // re-reeving flags a reconfirm
  h.confirm(); h.requireConfirm('REEVING CHANGED — CONFIRM CONFIG'); h.update(dt, snapAt({ R: 6, grossKg: 700 }));
  assert.equal(h.state, 'noconfig'); assert.ok(h.warnings.has('RECONFIRM'));
});

test('tower-crane zone: 44.2 m ceiling within 63 m of the mast (§5.1)', () => {
  const r = armed();
  const base = snapAt();
  const at = (x, z, y, o = {}) => ({ ...base, headPos: { x, y, z }, ...o });
  r.update(dt, at(40, 0, 40)); assert.equal(r.zone.tower, true); near(r.perm.luffUp, 1, 1e-9, 'well below');
  r.update(dt, at(40, 0, 42.6)); near(r.perm.luffUp, 0.5, 1e-9, 'head top 43.2 → 0.5'); near(r.perm.teleOut, 0.5, 1e-9, 'tele out');
  r.update(dt, at(40, 0, 44)); near(r.perm.luffUp, 0, 1e-9, 'at the ceiling'); assert.ok(r.stops.has('TOWER_ZONE'));
  near(r.perm.luffDown, 1, 1e-9, 'luff down stays');
  r.update(dt, at(70, 0, 50)); near(r.perm.luffUp, 1, 1e-9, 'outside 63 m: no ceiling');
  // slew lookahead: head above the ceiling just outside the zone; the slew direction that brings it
  // within 63 m (2° lookahead) is blocked, the other one is free
  const ax = { x: 57, z: -12 }, R0 = 20;
  let found = 0;
  for (let deg = 0; deg < 360; deg += 0.5) {
    const a = deg * DEG, hx = ax.x + R0 * Math.cos(a), hz = ax.z - R0 * Math.sin(a), d0 = Math.hypot(hx, hz);
    if (d0 < 63.05 || d0 > 63.3) continue;
    const dl = Math.hypot(ax.x + R0 * Math.cos(a + 2 * DEG), ax.z - R0 * Math.sin(a + 2 * DEG)); // after slewing left 2°
    const dr = Math.hypot(ax.x + R0 * Math.cos(a - 2 * DEG), ax.z - R0 * Math.sin(a - 2 * DEG));
    r.update(dt, at(hx, hz, 50, { axis: ax }));
    assert.equal(r.perm.slewL, dl < 63 ? 0 : 1, `slewL at ${deg}°`); assert.equal(r.perm.slewR, dr < 63 ? 0 : 1, `slewR at ${deg}°`);
    r.update(dt, at(hx, hz, 40, { axis: ax })); assert.equal(r.perm.slewL + r.perm.slewR, 2, 'below the ceiling: free');
    found++;
  }
  assert.ok(found >= 2, 'lookahead cases exercised');
  // luff-up pulls the head toward the axis (58.2 m from the mast): above the ceiling it must not
  // carry the head into the zone
  let luffCases = 0;
  const th = base.thetaG, Lb = base.L, dR = -Lb * Math.sin(th) * DEG;
  for (let deg = 0; deg < 360; deg += 0.5) {
    const a = deg * DEG, hx = ax.x + R0 * Math.cos(a), hz = ax.z - R0 * Math.sin(a), d0 = Math.hypot(hx, hz);
    if (d0 < 63.02 || d0 > 63.2) continue;
    const inside = Math.hypot(hx + Math.cos(a) * dR, hz - Math.sin(a) * dR) < 63;
    r.update(dt, at(hx, hz, 50, { axis: ax }));
    assert.equal(r.perm.luffUp, inside ? 0 : 1, `luffUp lookahead at ${deg}°`);
    if (inside) luffCases++;
  }
  assert.ok(luffCases >= 1, 'luff-up lookahead exercised');
});

test('road zone: head / hook / load stay at z ≥ −55 (§5.1, tower Safety logic)', () => {
  const r = armed();
  const ax = { x: 0, z: -40 };
  // boom pointing −z (toward the road) from an axis at z −40: head at z −52 (R 12)
  const s = snapAt({ axis: ax, headPos: { x: 0, y: 15, z: -52 }, hookPos: { x: 0, y: 5, z: -52 }, psi: 0 });
  r.update(dt, s);
  assert.ok(r.perm.luffDown < 1 && r.perm.teleOut < 1, 'radius out toward the road is slowed');
  near(r.perm.luffUp, 1, 1e-9, 'luff up (away) free');
  r.update(dt, { ...s, headPos: { x: 0, y: 15, z: -55.5 }, hookPos: { x: 0, y: 5, z: -55.5 } });
  near(r.perm.luffDown, 0, 1e-9, 'in the zone: blocked'); assert.ok(r.stops.has('ROAD_ZONE'));
  r.update(dt, { ...s, zoneLimiter: false }); near(r.perm.luffDown, 1, 1e-9, 'setting off');
  // slew: head at +x of the axis: slewing left (ψ+, rotation.y +) moves it by dz = −hx·dψ < 0, toward the road
  const e = { ...s, headPos: { x: 12, y: 15, z: -54 }, hookPos: { x: 12, y: 5, z: -54 } };
  r.update(dt, e); assert.ok(r.perm.slewL < 1 && r.perm.slewR === 1, `slew left toward the road slowed (${r.perm.slewL}, ${r.perm.slewR})`);
});

test('monitored mismatches warn but never block; mismatch time, audible, mute (§5)', () => {
  const r = armed();
  r.update(dt, snapAt({ beamsActual: [100, 100, 50, 100] }));
  assert.ok(r.warnings.has('SUPPORT_CONFIG')); assert.deepEqual(permOf(r), Object.fromEntries(ALL.map((k) => [k, 1])), 'never blocking');
  assert.ok(r.events.includes('mismatch')); assert.ok(r.alarm.shortHorn, 'short horn on onset');
  r.update(dt, snapAt({ beamsActual: [1, 1, null, 1] })); assert.ok(r.warnings.has('SUPPORT_CONFIG'), 'off detent');
  r.update(dt, snapAt({ beamsActual: [1, 1, 1, 1] })); assert.ok(!r.warnings.has('SUPPORT_CONFIG'), 'MobileStart-style 0/0.5/1 accepted');
  r.update(dt, snapAt({ tiltDeg: 0.6 })); assert.ok(r.warnings.has('TILT'));
  r.update(dt, snapAt({ wind: 14.5 })); assert.ok(r.warnings.has('WIND'), 'v_perm(22.7) = 14.3');
  r.update(dt, snapAt({ tyresActive: true })); assert.ok(r.warnings.has('TYRES_NOT_CLEAR'));
  r.update(dt, snapAt({ floats: [{ light: true }, {}, {}, {}] })); assert.ok(r.warnings.has('FLOAT_LIGHT'));
  r.update(dt, snapAt({ loadAttached: true, loadGrounded: true, sidePullDeg: 5 })); assert.ok(r.warnings.has('SIDE_PULL'));
  const t0 = r.counters.mismatchTime;
  for (let i = 0; i < 600; i++) r.update(dt, snapAt({ tiltDeg: 0.8 }));
  near(r.counters.mismatchTime - t0, 5, 0.02, 'mismatch time');
  assert.ok(r.mute().ok); r.update(dt, snapAt({ tiltDeg: 0.8 })); assert.equal(r.alarm.shortHorn, false);
  // the 35 t config with only 50 % beams, and tyres config with floats down
  const ty = armed({ mode: 'tyres', base: 0, cwKg: 0, block: 'ball', confirmed: true });
  ty.update(dt, snapAt({ L: 15.226, pinnedK: 1, R: 5, floatsInContact: 2 })); assert.ok(ty.warnings.has('SUPPORT_CONFIG'));
  near(ty.capKg, 8100, 1e-6, 'tyres 15.2 @ 5');
});

test('emergency bypass: 0.15×, RCL ignored, hook limit kept, 30 min reset (§5, [S12])', () => {
  const r = armed();
  assert.equal(r.setBypass(true, false).ok, false, 'needs the allowBypass setting');
  assert.ok(r.setBypass(true, true).ok); assert.equal(r.counters.bypassUsed, 1);
  r.update(dt, snapAt({ grossKg: 40000, loadAttached: true }));
  ALL.forEach((k) => near(r.perm[k], 0.15, 1e-9, `bypass ${k}`));
  assert.equal(r.counters.lmiTrips, 0, 'no trip while bypassed'); assert.ok(r.warnings.has('BYPASS'));
  r.update(dt, snapAt({ grossKg: 40000, twoBlock: true })); near(r.perm.hoistUp, 0, 1e-9, 'hook limit still active');
  for (let i = 0; i < 30 * 60 * 10; i++) r.update(0.1, snapAt());
  assert.equal(r.bypass, false, 'auto reset after 30 min');
  r.setBypass(true, true); r.update(dt, snapAt({ power: false })); assert.equal(r.bypass, false, 'engine stop resets');
});

test('first lift-off snapshot (§5.2, setup KPIs §8.5)', () => {
  const r = armed();
  r.update(dt, snapAt({ grossKg: 3000, loadAttached: true, loadGrounded: true }));
  assert.equal(r.counters.firstLiftSnapshot, null);
  r.update(dt, snapAt({ grossKg: 5250, loadAttached: true, loadGrounded: false, t: 42, tiltDeg: 0.2 }));
  const s = r.counters.firstLiftSnapshot;
  assert.ok(s && s.t === 42 && s.shortCode === 'OR B100 CW35.0 n3 HB26' && s.beams.join() === '100,100,100,100');
  r.update(dt, snapAt({ grossKg: 5250, loadAttached: true, loadGrounded: true }));
  r.update(dt, snapAt({ grossKg: 5250, loadAttached: true, loadGrounded: false, t: 60 }));
  assert.equal(r.counters.firstLiftSnapshot.t, 42, 'only the first');
});

// ------------------------------------------------------------------ drives
test('slew inertia and tilt torque (§3.2)', () => {
  const th52 = thetaForRadius(52, 30);
  near(rotatingProps(35000, th52, [1, 1, 1, 1, 1], 52).inertia, 3.4e6, 0.05e6, '52 m @ R 30, 35 t');
  near(rotatingProps(35000, thetaForRadius(11.5, 5), [0, 0, 0, 0, 0], 11.5).inertia, 5.1e5, 0.1e5, '11.5 m, 35 t');
  const p = rotatingProps(35000, 0.5, [0, 0, 0, 0, 0], 11.5);
  assert.ok(p.mu < 0, 'CW side dominates unloaded'); near(p.mass, 15900 + 1600 + 35000 + 6 * 1625 + 350, 1e-6, 'rotating mass');
  near(tiltTorque(p.mu, 0.01, 0, Math.PI / 2), G * p.mu * 0.01, 1e-9, 'tilt torque');
});

test('slew drive: speed control, 0.8·τ_max release, holding brake, pin, free slew (§3.2)', () => {
  const d = new MobileDrives({ k: 11 });
  d.reset({ theta: thetaForRadius(52, 30), ropeLen: 20, falls: 1, blockHeight: 1.0 });
  const I = 3.4e6, perm = { slewL: 1, slewR: 1 };
  const ctx = { powered: true, inertia: I, extTorque: 0, tension: 2452 };
  for (let i = 0; i < 20 * 120; i++) d.update(dt, { slew: -1 }, perm, ctx);
  near(d.psiDot, DRIVES.slew.maxSpeed, 0.002, 'lever left → ψ̇ + at 2 rpm'); near(d.slewRpm, -2, 0.02, 'display rpm');
  let t = 0, clunk = false;
  while (d.psiDot !== 0 && t < 20) { d.update(dt, { slew: 0 }, perm, ctx); t += dt; if (d.brakeEvents.includes('slew')) clunk = true; }
  // 0.8·τ_max braking plus the 1.5e5·ψ̇ viscous friction: t = (I/c)·ln(1 + c·ω/τ)
  const c = DRIVES.slew.viscous, tau = 0.8 * DRIVES.slew.torqueMax;
  near(t, (I / c) * Math.log(1 + (c * DRIVES.slew.maxSpeed) / tau), 0.05, 'stop time at 0.8·τ_max'); assert.ok(clunk, 'brake clunk');
  // holding brake resists 300 kN·m, slips above 350 kN·m
  d.update(dt, { slew: 0 }, perm, { ...ctx, extTorque: 3.0e5 }); assert.equal(d.psiDot, 0);
  d.update(dt, { slew: 0 }, perm, { ...ctx, extTorque: 4.0e5 }); assert.ok(d.slewSlipping && d.psiDot > 0, 'brake slips');
  // turntable pin
  const e = new MobileDrives({ k: 0 });
  e.reset({ psi: 2 * DEG, theta: 0 });
  assert.equal(e.setTurntablePin(true).ok, false, 'not at 0°');
  e.reset({ psi: 0.3 * DEG + 2 * Math.PI, theta: 0 });
  assert.ok(e.setTurntablePin(true).ok); near(e.psi, 2 * Math.PI, 1e-12, 'pin centres ψ');
  e.update(dt, { slew: 1 }, perm, ctx); assert.equal(e.psiDot, 0, 'pinned: no slew');
  assert.equal(e.setFreeSlew(true).ok, false, 'no free slew while pinned');
  e.setTurntablePin(false); assert.ok(e.setFreeSlew(true).ok);
  for (let i = 0; i < 120; i++) e.update(dt, { slew: 0 }, perm, { ...ctx, inertia: 5e5, extTorque: 5e4 });
  assert.ok(e.psiDot > 0.05 && !e.brakeSlew, 'free slew follows the external torque');
  // perm scales the lever
  const f = new MobileDrives({ k: 0 }); f.reset({ theta: 0.5 });
  for (let i = 0; i < 600; i++) f.update(dt, { slew: 1 }, { slewL: 1, slewR: 0.5 }, { ...ctx, inertia: 5e5 });
  near(f.psiDot, -0.5 * DRIVES.slew.maxSpeed, 0.002, 'slewR perm 0.5');
});

test('luff drive: load factors, ramps, end damping (§3.3)', () => {
  const d = new MobileDrives({ k: 3 });
  d.reset({ theta: 30 * DEG, ropeLen: 10, falls: 1, blockHeight: 1 });
  const perm = { luffUp: 1, luffDown: 1 }, run = (lev, util, s = 2) => { for (let i = 0; i < s * 120; i++) d.update(dt, { luff: lev }, perm, { util, tension: 2452 }); return d.vCyl; };
  near(run(1, 0), 0.132, 1e-9, 'up unloaded');
  near(run(1, 1.0), 0.132 * 0.5, 1e-9, 'up at 100 %');
  near(run(1, 1.2), 0.132 * 0.4, 1e-9, 'up clamp 0.40');
  near(run(-1, 1.0), -0.132 * 0.7, 1e-9, 'down at 100 %');
  near(run(-1, 0.1, 1), -0.132 * 0.97, 1e-9, 'down at 10 %');
  run(0, 0, 1); assert.equal(d.vCyl, 0);
  // end damping: near 82° the speed drops to ≥ 15 %
  d.reset({ theta: 81.5 * DEG, ropeLen: 10 });
  run(1, 0, 0.5); assert.ok(d.vCyl <= 0.132 * 0.17 + 1e-9, `damped near the stop (${d.vCyl})`);
  run(1, 0, 20); near(d.theta, 82 * DEG, 1e-12, 'stops at 82°');
  // perm 0 blocks
  const e = new MobileDrives({ k: 3 }); e.reset({ theta: 0.5 });
  for (let i = 0; i < 120; i++) e.update(dt, { luff: 1 }, { luffUp: 0 }, {});
  assert.equal(e.theta, 0.5);
});

test('hoist: rope bookkeeping, tele coupling, drum layers, knee, relief, limits (§3.5)', () => {
  const d = new MobileDrives({ k: 3 });
  const hb = HOOK_BLOCKS.hb26;
  d.reset({ theta: 0.9, ropeLen: 12, falls: hb.falls, blockHeight: hb.height });
  near(d.fallLength(), 12, 1e-9, 'ℓ'); near(d.sPaid, 12 * 3 + 22.678 + 1.5, 1e-9, 'S_paid = nℓ + L + 1.5');
  near(d.ropeLenMin, 3.6, 1e-12, 'hook limit 2.0 + block height');
  // telescope one step out: the hook rises by ΔL/n
  const all = { hoistUp: 1, lower: 1, luffUp: 1, luffDown: 1, teleOut: 1, teleIn: 1, slewL: 1, slewR: 1 };
  while (d.boom.phase !== 'pinning') d.update(dt, { tele: 1 }, all, { tension: 5000 });
  near(d.fallLength(), 12 - 3.726 / 3, 1e-9, 'tele out raises the hook by ΔL/n');
  // drum layers and the constant-power knee
  const h = new MobileDrives({ k: 0 });
  h.reset({ theta: 0.5, ropeLen: 5, falls: 1, blockHeight: 1 });
  h.update(dt, {}, all, { tension: 2452 });
  assert.equal(h.layer, 5); near(h.lineSpeedMax * 60, 130, 1e-9, 'top layer unloaded: 130 m/min');
  h.update(dt, {}, all, { tension: 88e3 }); near(h.lineSpeedMax * 60, 65, 1e-9, 'knee: 88 kN → 65 m/min');
  h.sPaid = 200; h.update(dt, {}, all, { tension: 2452 });
  assert.equal(h.layer, 2); near(h.lineSpeedMax * 60, 130 * (0.5 + 3 * 0.021) / 0.689, 1e-9, 'layer 2');
  // hook speed = line speed / n, accel 0.6 m/s²
  const s = new MobileDrives({ k: 0 });
  s.reset({ theta: 0.5, ropeLen: 30, falls: 3, blockHeight: 1.6 });
  for (let i = 0; i < 120 * 3; i++) s.update(dt, { hoist: -1 }, all, { tension: 3 * 5000 });
  near(-s.hookVel, s.lineSpeedMax / 3, 1e-9, 'hook speed v_line/n'); near(s.lineVel, s.hookVel * 3, 1e-12, 'line = n × hook');
  // relief: 11 t on 1 fall = 108 kN > 96.8 kN → hoist-up stalls
  const r = new MobileDrives({ k: 0 });
  r.reset({ theta: 0.5, ropeLen: 10, falls: 1, blockHeight: 1 });
  for (let i = 0; i < 120; i++) r.update(dt, { hoist: 1 }, all, { tension: 11000 * G });
  assert.ok(r.relief && r.reliefActive); assert.equal(r.hookVel, 0); near(r.fallLength(), 10, 1e-9, 'no hoisting');
  // hook limit (with the 3 m slow zone) and the lowering limit (3 wraps)
  const u = new MobileDrives({ k: 0 });
  u.reset({ theta: 0.5, ropeLen: 8, falls: 1, blockHeight: 1 });
  let events = [];
  for (let i = 0; i < 120 * 20; i++) { u.update(dt, { hoist: 1 }, all, { tension: 2452 }); events.push(...u.events); }
  near(u.fallLength(), 3.0, 1e-9, 'stopped at the hook limit'); assert.ok(u.twoBlock && events.includes('upperLimit'));
  u.update(dt, { tele: 1 }, all, { tension: 2452 }); assert.equal(u.boom.phase, 'pinned', 'no tele-out at the hook limit (mechanical)');
  const w = new MobileDrives({ k: 0 });
  w.reset({ theta: 0.5, ropeLen: 225, falls: 1, blockHeight: 1 });
  for (let i = 0; i < 120 * 30; i++) w.update(dt, { hoist: -1 }, all, { tension: 2452 });
  near(w.drumRope, 4.9, 1e-9, '3 wraps stay on the drum'); assert.ok(w.lowerLimit);
  // slack rope: pay-out stops once the hook rests and the rope is 2.5 m slack
  const k = new MobileDrives({ k: 0 });
  k.reset({ theta: 0.5, ropeLen: 20, falls: 1, blockHeight: 1 });
  k.update(dt, { hoist: -1 }, all, { tension: 0, hookGrounded: true, ropeDist: 17 });
  assert.equal(k.hookVel, 0);
});

test('boom deflection: calibration, period, lateral slew coupling (§3.6)', () => {
  // 6 t at R 30 m on the 52 m boom → 1.0 m static tip deflection
  const th = thetaForRadius(52, 30), F = 6000 * G;
  const d = new MobileDrives({ k: 11 });
  d.reset({ theta: th, ropeLen: 20, falls: 1, blockHeight: 1 });
  const loads = ropeLoads({ x: 30, y: 45, z: 0 }, { x: 30, y: 25, z: 0 }, F, { x: 0, z: 0 }, 0, th);
  near(loads.fPerp, F * Math.cos(th), 1e-6, 'F⊥ of a hanging load'); near(loads.fSide, 0, 1e-9, 'no side load');
  let peak = 0;
  for (let i = 0; i < 120 * 30; i++) { d.update(dt, {}, {}, { tension: F, fPerp: loads.fPerp, fSide: 0 }); peak = Math.max(peak, d.dv); }
  near(d.dvStatic, 1.0, 0.01, 'static'); near(d.dv, d.dvStatic, 0.05, 'settles'); assert.ok(peak > 1.5, 'dynamic overshoot on sudden load');
  near((2 * Math.PI) / deflectionOmega(52, 1.7e9), 1.6, 0.05, 'vertical period at 52 m');
  const e = new MobileDrives({ k: 3 }); e.reset({ theta: thetaForRadius(22.678, 20), ropeLen: 10 });
  for (let i = 0; i < 120 * 30; i++) e.update(dt, {}, {}, { tension: 12800 * G, fPerp: 12800 * G * Math.cos(e.theta) });
  near(e.dv, 0.28, 0.01, '12.8 t @ 20 m on 22.7 m');
  // side pull: a rope pulling toward the boom's left deflects the head left
  const s = ropeLoads({ x: 20, y: 30, z: 0 }, { x: 20, y: 10, z: -5 }, 1e4, { x: 0, z: 0 }, 0, 0.9);
  assert.ok(s.fSide > 0 && s.outOfPlaneDeg > 10, 'left (−z at azimuth 0) is + side');
  assert.ok(s.tauRope > 0, 'pull to the left slews ψ +');
  // slewing acceleration makes the boom lag (lateral)
  const g = new MobileDrives({ k: 11 }); g.reset({ theta: th, ropeLen: 20 });
  for (let i = 0; i < 60; i++) g.update(dt, { slew: -1 }, { slewL: 1 }, { inertia: 3.4e6, tension: 2452 });
  assert.ok(g.dl < 0, `accelerating left → head lags right (${g.dl})`);
});

// ----------------------------------------------------------- HoistSystem
test('HoistSystem options are backward compatible; setHookBlock (§3.5)', () => {
  const world = { boxes: [], resolve: () => ({ support: false, lateral: false, ceiling: false }) };
  const wind = { velocityAt: (h, o) => { o.x = 0; o.z = 0; return o; }, t: 0, gustiness: 0 };
  const t = new HoistSystem(world, wind);
  assert.equal(t.hookMass, CRANE.hookMass); assert.equal(t.ropeEA, CRANE.ropeEA); assert.equal(t.hookBoxOffset, 0.45);
  assert.deepEqual([t.hookBox.hx, t.hookBox.hy, t.hookBox.hz], [0.26, 0.5, 0.26]);
  t.falls = 2; t.ropeLen = 20; t.radius = 30;
  assert.equal(t.ropeStiffness, (2 * 2 * CRANE.ropeEA) / (2 * 20 + 30 + 22), 'tower formula unchanged');
  let L = 22.7;
  const b = HOOK_BLOCKS.hb26;
  const m = new HoistSystem(world, wind, { hookMass: b.massKg, ropeEA: 2.0e7, deadLength: () => L + 1.5, hookHalf: b.half });
  m.falls = 3; m.ropeLen = 12;
  near(m.ropeStiffness, (9 * 2.0e7) / (3 * 12 + 24.2), 1e-6, 'mobile dead length');
  L = 52; near(m.ropeStiffness, (9 * 2.0e7) / (36 + 53.5), 1e-6, 'dead length follows L');
  near(m.hookBoxOffset, 0.75, 1e-12, 'box offset from half'); assert.equal(m.stowed, false);
  const h90 = HOOK_BLOCKS.hb90;
  assert.ok(m.setHookBlock({ mass: h90.massKg, half: h90.half }));
  assert.equal(m.hookMass, 700); near(m.hookBox.hy, 1.1, 1e-12, 'half y'); near(m.hookBoxOffset, 1.05, 1e-12, 'offset');
  m.load = { mass: 1000 }; assert.equal(m.setHookBlock({ mass: 250 }), false, 'refused with a load attached');
  // a hanging hook settles at mass·g (smoke test of step() with the options)
  m.load = null; m.setHookBlock({ mass: 250, half: HOOK_BLOCKS.ball.half }); m.falls = 1; m.ropeLen = 10;
  const sheave = new THREE.Vector3(0, 30, 0);
  m.reset(sheave);
  for (let i = 0; i < 240; i++) m.step(dt, 6, sheave, 10);
  near(m.tensionFiltered, 250 * G, 250 * G * 0.05, 'tension ≈ hook weight');
});

console.log(`${n} tests passed`);
