// Phase-0 contract checks: src/mobile/config.js is self-consistent with the
// spec's derived numbers, and src/machines/machine.js helpers behave.
// Plain node (no three.js needed): `node scripts/test-contracts.mjs`.
import assert from 'node:assert/strict';
import * as C from '../src/mobile/config.js';
import { NULL_INPUT, neutralInput, makeMobileStart, displaySlewDeg } from '../src/machines/machine.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

test('pinned lengths: 11.5 + 3.726·k, last 52.0 (§1.2)', () => {
  assert.equal(C.PINNED_LENGTHS.length, 12);
  for (let k = 0; k <= 10; k++) near(C.PINNED_LENGTHS[k], 11.5 + 3.726 * k, 0.05, `k=${k}`);
  assert.equal(C.PINNED_LENGTHS[11], 52.0);
  assert.equal(C.pinnedLength(3), 22.7);
});

test('P1 float centres = carrier frame floats at full base (§8.2)', () => {
  C.FLOATS.forEach((f, i) => {
    const p = C.carrierToWorld(C.P1, C.P1.yaw, f.x, f.side * C.BASES[100]);
    near(p.x, C.P1.floats[i][0], 1e-9, `${f.id} x`);
    near(p.z, C.P1.floats[i][1], 1e-9, `${f.id} z`);
    const q = C.worldToCarrier(C.P1, C.P1.yaw, p.x, p.z);
    near(q.x, f.x, 1e-9, 'inverse x'); near(q.y, f.side * C.BASES[100], 1e-9, 'inverse y');
  });
  // yaw −π/2: forward = +z, left = +x (toward the east fence)
  const fwd = C.carrierToWorld({ x: 0, z: 0 }, -Math.PI / 2, 1, 0), left = C.carrierToWorld({ x: 0, z: 0 }, -Math.PI / 2, 0, 1);
  near(fwd.z, 1, 1e-12, 'forward +z'); near(left.x, 1, 1e-12, 'left +x');
});

test('route: legs chain, turn radii match the steering programs (§8.1, §7)', () => {
  const legs = C.ROUTE.legs;
  for (let i = 0; i + 1 < legs.length; i++) {
    const a = legs[i].to, b = legs[i + 1].from;
    near(a.x, b.x, 0.06, `leg ${i} → ${i + 1} x`); near(a.z, b.z, 0.06, `leg ${i} → ${i + 1} z`);
  }
  for (const l of legs.filter((x) => x.kind === 'turn')) {
    const R = 1 / C.VEHICLE.programs[l.program].kappaMax;
    near(Math.hypot(l.from.x - l.icr.x, l.from.z - l.icr.z), R, 0.05, `${l.text} start radius`);
    near(Math.hypot(l.to.x - l.icr.x, l.to.z - l.icr.z), R, 0.05, `${l.text} end radius`);
  }
  const last = legs[legs.length - 1].to;
  assert.deepEqual([last.x, last.z], [C.P1.x, C.P1.z]);
});

test('masses: basic crane 46.7 t, road CG x_c ≈ 1.35 (§1.1, §1.3)', () => {
  const B = C.AT100.bodies, bm = C.AT100.boom;
  const boomM = 6 * bm.sectionMassKg + bm.headMassKg;
  near(boomM, bm.massKg, 1e-9, 'boom mass');
  const m = B.carrier.m + B.upper.m + B.luffCyl.m + boomM;
  near(m, C.AT100.carrier.basicMassKg, 1e-9, 'basic mass');
  // boom horizontal (θ = 0), fully retracted: all sections centred 5.65 m from the pivot, head at L
  const mx = B.carrier.m * B.carrier.x + B.upper.m * B.upper.u + B.luffCyl.m * B.luffCyl.u
    + 6 * bm.sectionMassKg * (C.AT100.pivot.u + bm.sectionCgOffset) + bm.headMassKg * (C.AT100.pivot.u + bm.baseLen);
  near(mx / m, C.AT100.carrier.roadCgX, 0.02, 'road CG');
  near(C.AT100.carrier.axleLoadsT.reduce((a, b) => a + b, 0), C.AT100.carrier.roadMassKg / 1000, 0.15, 'axle loads');
});

test('hook blocks, counterweight make-up, mats (§1.4–1.6)', () => {
  assert.deepEqual(C.HOOK_BLOCK_IDS.map((id) => C.HOOK_BLOCKS[id].falls), [1, 3, 7, 10]);
  assert.deepEqual(C.HOOK_BLOCK_IDS.map((id) => C.HOOK_BLOCKS[id].ratedKg), [8800, 26100, 59100, 90200]);
  for (const cw of C.CW_CONFIGS) assert.equal(C.CW_MAKEUP[cw].reduce((a, id) => a + C.CW_SLABS[id].massKg, 0), cw, `CW ${cw}`);
  assert.equal(C.reeveTime('ball', 'hb26'), 45);
  assert.equal(C.reeveTime('hb26', 'hb90'), 90);
  near(C.MATS.carried.area, 1.75 * 1.0, 1e-9, 'carried mat area');
  near(C.MATS.composite.area, 1.8 * 1.8, 1e-9, 'composite mat area');
  assert.deepEqual(C.RMIN.length, 12);
  assert.equal(C.tableLookup(C.TELE_LOAD, 22.7), 12000);
  assert.equal(C.tableLookup(C.TELE_LOAD, 52.0), 3000);
  assert.equal(C.tableLookup(C.WIND_PERM, 37.6), 12.8);
});

test('config is deep-frozen (read-only contract)', () => {
  assert.ok(Object.isFrozen(C.AT100) && Object.isFrozen(C.AT100.carrier.tyre) && Object.isFrozen(C.ROUTE.legs[1].icr));
  assert.throws(() => { C.P1.x = 0; }, TypeError);
  assert.throws(() => { C.PINNED_LENGTHS.push(60); }, TypeError);
});

test('machine.js: inputs, MobileStart, slew display', () => {
  assert.ok(Object.isFrozen(NULL_INPUT) && Object.isFrozen(NULL_INPUT.levers));
  for (const k of ['slew', 'trolley', 'hoist', 'tele', 'luff']) assert.equal(NULL_INPUT.levers[k], 0);
  assert.equal(neutralInput(true).micro, true);
  const s = makeMobileStart('pad', { cwKg: 11500, rcl: { cwKg: 35000 } });
  assert.equal(s.cwKg, 11500); assert.equal(s.rcl.cwKg, 35000); assert.equal(s.rcl.base, 100);
  s.beams[0] = 0.5; // mutable copy, preset untouched
  assert.equal(C.MOBILE_STARTS.pad.beams[0], 1);
  const load = { mass: 1 };
  assert.equal(makeMobileStart('road', { attach: load }).attach, load);
  assert.equal(makeMobileStart('road').ropeLen, null);
  near(displaySlewDeg(-Math.PI / 2), 90, 1e-9, 'over right');
  near(displaySlewDeg(Math.PI / 2), 270, 1e-9, 'over left');
  near(C.slewDisplayDeg(-Math.PI), 180, 1e-9, 'over rear');
});

console.log(`${n} contract checks passed`);
