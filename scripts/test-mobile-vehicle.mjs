#!/usr/bin/env node
// WP-DRIVE tests (spec §7, §7.1, §8.1, §9.6): carrier kinematics, drive line,
// kerbs / collisions / fence gate, travel interlock, the P1 route (driven
// end-to-end by a simple pure-pursuit driver) and the streets obstacle API
// (traffic IDM leader, vehicleBoxes, pedestrians). Plain node, exits non-zero on failure.
import assert from 'node:assert/strict';

// minimal DOM stub: the street-life renderers draw canvas textures at build time
const ctx2d = new Proxy(function () {}, { get: (t, k) => (k === 'canvas' ? {} : ctx2d), set: () => true, apply: () => ctx2d });
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) };

const { Vehicle, travelInterlock, programGeometry } = await import('../src/mobile/vehicle.js');
const { routePath, guidance, resetGuidance, approachHold } = await import('../src/mobile/route.js');
const { VEHICLE, ROUTE, SPAWN, P1, CRANE_APPROACH, AT100 } = await import('../src/mobile/config.js');
const { Box, ColliderWorld } = await import('../src/physics/collide.js');

const DT = 1 / 120;
const DEG = Math.PI / 180;
let failures = 0, count = 0;
function test(name, fn) {
  count++;
  try { const info = fn(); console.log(`ok   ${name}${info ? `  (${info})` : ''}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message.split('\n').join('\n     ')}`); }
}
const near = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} not within ${b} ± ${tol}`);
const FAR = { minX: 1e9, maxX: 1e9, minZ: 0, maxZ: 0 }; // "no site" rect
const flat = { heightAt: () => 0 };
const newVeh = (o = {}) => new Vehicle().reset({ x: 0, z: 0, yaw: 0, parkingBrake: false, ...o });
function run(veh, seconds, drive, env = { siteRect: FAR }, each) {
  const evs = [];
  for (let t = 0; t < seconds; t += DT) {
    const ev = veh.update(DT, typeof drive === 'function' ? drive(t) : drive, null, env);
    for (const e of ev) evs.push({ ...e, t });
    if (each && each(t) === false) break;
  }
  return evs;
}
// least-squares (Kasa) circle fit → {cx, cz, r}
function circleFit(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of pts) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
  const M = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, pts.length, sz]];
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) { const f = M[j][i] / M[i][i]; for (let k = i; k < 4; k++) M[j][k] -= f * M[i][k]; }
  const X = [0, 0, 0];
  for (let i = 2; i >= 0; i--) { let s = M[i][3]; for (let k = i + 1; k < 3; k++) s -= M[i][k] * X[k]; X[i] = s / M[i][i]; }
  const cx = X[0] / 2, cz = X[1] / 2;
  return { cx, cz, r: Math.sqrt(X[2] + cx * cx + cz * cz) };
}
// world point of a carrier-frame point (x_c, y_c)
const cw = (veh, xc, yc) => { const c = Math.cos(veh.yaw), s = Math.sin(veh.yaw); return [veh.pos.x + xc * c - yc * s, veh.pos.z - xc * s - yc * c]; };

// ---------------------------------------------------------------- kinematics
for (const [program, R] of [['ROAD', AT100.carrier.turningRadius.road], ['ALL', AT100.carrier.turningRadius.all]]) {
  for (const steer of [1, -1]) {
    test(`${program} outer front-corner turning radius ${R} m (steer ${steer > 0 ? 'right' : 'left'})`, () => {
      const veh = newVeh({ program });
      const pts = [];
      // crawl (5 km/h) at full lock; the outer front corner is on the side away from the turn
      const yc = steer > 0 ? AT100.carrier.width / 2 : -AT100.carrier.width / 2;
      run(veh, 45, { throttle: 1, brake: 0, steer, crawl: true }, { siteRect: FAR }, (t) => { if (t > 4) pts.push(cw(veh, AT100.carrier.frontX, yc)); });
      const f = circleFit(pts);
      near(f.r, R, 0.1, 'radius');
      return `r = ${f.r.toFixed(3)} m at ${veh.kmh.toFixed(1)} km/h`;
    });
  }
}

test('wheel angles match the §7 program table (front inner / axle 5)', () => {
  const veh = newVeh({ program: 'ROAD' });
  run(veh, 4, { throttle: 1, brake: 0, steer: 1, crawl: true });
  const d = (a) => a / DEG;
  // steer right → the right wheels (index 1) are inner
  near(d(-veh.wheelSteerLR[0][1]), 32.1, 0.2, 'ROAD front inner');
  near(d(veh.wheelSteerLR[4][1]), 24.0, 0.4, 'ROAD axle 5 inner');
  const all = newVeh({ program: 'ALL' });
  run(all, 4, { throttle: 1, brake: 0, steer: 1, crawl: true });
  near(d(-all.wheelSteerLR[0][1]), 30.8, 0.2, 'ALL front inner');
  near(d(all.wheelSteerLR[4][1]), 33.7, 0.2, 'ALL axle 5 inner');
  return `ROAD ${d(-veh.wheelSteerLR[0][1]).toFixed(1)}° / ${d(-veh.wheelSteerLR[4][1]).toFixed(1)}°, ALL ${d(-all.wheelSteerLR[0][1]).toFixed(1)}° / ${d(-all.wheelSteerLR[4][1]).toFixed(1)}°`;
});

test('steering rate: lock to lock in 3.0 s', () => {
  const veh = newVeh();
  let tFull = null;
  run(veh, 5, { throttle: 0, brake: 1, steer: -1 });
  assert.equal(veh.steerPos, -1);
  run(veh, 5, { throttle: 0, brake: 1, steer: 1 }, undefined, (t) => { if (tFull === null && veh.steerPos >= 1) tFull = t; });
  near(tFull, 3.0, 0.02, 'lock-to-lock');
  return `${tFull.toFixed(3)} s`;
});

test('ROAD fades to x_ref −0.29 / κ 1/10.6 at 50 km/h; lateral limit 2.5/v²', () => {
  const g = programGeometry('ROAD', 50), g0 = programGeometry('ROAD', 20);
  near(g.xRef, -0.29, 1e-9); near(g.kappaMax, 1 / 10.6, 1e-9); near(g0.xRef, 1.27, 1e-9);
  const veh = newVeh();
  run(veh, 60, (t) => ({ throttle: veh.kmh < 45 ? 1 : 0, brake: 0, steer: t > 50 ? 1 : 0 }));
  const lim = VEHICLE.lateralLimit / (veh.v * veh.v);
  assert.ok(Math.abs(veh.kappa) <= lim + 1e-9, `κ ${veh.kappa} > ${lim}`);
  return `at ${veh.kmh.toFixed(1)} km/h |κ| = ${Math.abs(veh.kappa).toFixed(4)} ≤ ${lim.toFixed(4)}`;
});

test('CRAB: heading fixed, velocity rotated by −steer·15°, governed to 10 km/h', () => {
  const veh = newVeh({ program: 'CRAB' });
  const y0 = veh.yaw;
  const x0 = veh.pos.x, z0 = veh.pos.z;
  run(veh, 20, { throttle: 1, brake: 0, steer: 1 });
  near(veh.yaw, y0, 1e-12, 'yaw');
  const ang = Math.atan2(veh.pos.z - z0, veh.pos.x - x0) / DEG; // steer right → drift to +z (the right side at yaw 0)
  near(ang, 15, 0.3, 'crab angle');
  assert.ok(veh.kmh <= 10.3, `crab speed ${veh.kmh}`);
  return `track ${ang.toFixed(2)}° at ${veh.kmh.toFixed(1)} km/h`;
});

test('ALL program: auto-switch to ROAD above 20 km/h; K refused above the limit', () => {
  const veh = newVeh({ program: 'ALL' });
  const evs = run(veh, 30, { throttle: 1, brake: 0, steer: 0 });
  const sw = evs.find((e) => e.type === 'program' && e.auto);
  assert.ok(sw && sw.program === 'ROAD' && veh.program === 'ROAD', 'no auto switch');
  const ev = veh.update(DT, { throttle: 1, brake: 0, steer: 0 }, ['program'], { siteRect: FAR });
  assert.ok(ev.some((e) => e.type === 'refused'), 'ALL accepted at speed');
  return `switched at ${(veh.v * 3.6).toFixed(0)} km/h now, event at t=${sw.t.toFixed(1)} s`;
});

// ---------------------------------------------------------------- drive line
test('0 → 50 km/h in 25 ± 3 s on asphalt (47 t)', () => {
  const veh = newVeh();
  let t50 = null, t80 = null;
  run(veh, 120, { throttle: 1, brake: 0, steer: 0 }, { siteRect: FAR }, (t) => {
    if (t50 === null && veh.kmh >= 50) t50 = t;
    if (t80 === null && veh.kmh >= 79.5) t80 = t;
    return t80 === null;
  });
  near(t50, 25, 3, '0-50 time');
  assert.ok(t80 !== null && t80 < 90, `0-79.5 ${t80}`);
  return `0-50 ${t50.toFixed(1)} s, 0-79.5 ${t80.toFixed(1)} s (spec ~75 s), top ${veh.kmh.toFixed(1)} km/h ${veh.gearName}`;
});

test('reverse: D↔R only at standstill, max 8 km/h, R1/R2', () => {
  const veh = newVeh();
  run(veh, 3, { throttle: 1, brake: 0, steer: 0 });
  let ev = veh.update(DT, { throttle: 0, brake: 0, steer: 0 }, ['gear'], { siteRect: FAR });
  assert.ok(ev.some((e) => e.type === 'refused') && veh.direction === 1, 'reverse accepted while moving');
  run(veh, 6, { throttle: 0, brake: 1, steer: 0 });
  ev = veh.update(DT, { throttle: 0, brake: 1, steer: 0 }, ['gear'], { siteRect: FAR });
  assert.equal(veh.direction, -1);
  const gears = new Set();
  run(veh, 20, { throttle: 1, brake: 0, steer: 0 }, { siteRect: FAR }, () => { gears.add(veh.gearName); });
  assert.ok(veh.v < 0 && veh.kmh > -8.3 && veh.kmh < -7.5, `reverse speed ${veh.kmh}`);
  assert.ok(gears.has('R1') && gears.has('R2') && veh.reverseAlarm, [...gears].join(','));
  return `${veh.kmh.toFixed(2)} km/h, gears ${[...gears].join(' ')}`;
});

test('crawl limiter 5 km/h, site rolling resistance, brakes 4.5 m/s², parking brake holds', () => {
  const veh = newVeh();
  run(veh, 20, { throttle: 1, brake: 0, steer: 0, crawl: true });
  near(veh.kmh, 5, 0.3, 'crawl');
  run(veh, 20, { throttle: 1, brake: 0, steer: 0 });
  const v0 = veh.v;
  run(veh, 0.5, { throttle: 0, brake: 1, steer: 0 });
  near((v0 - veh.v) / 0.5, 4.5 + 0.3 + 0.1, 0.25, 'decel'); // brake + retarder + resistance
  run(veh, 10, { throttle: 0, brake: 1, steer: 0 });
  veh.update(DT, { throttle: 0, brake: 0, steer: 0 }, ['parkingBrake'], { siteRect: FAR });
  assert.ok(veh.parkingBrake && veh.gearName === 'N');
  const evs = run(veh, 3, { throttle: 1, brake: 0, steer: 0 });
  assert.equal(veh.v, 0, 'moved against the parking brake');
  assert.ok(evs.some((e) => e.type === 'hint'), 'no parking-brake hint');
  return 'ok';
});

test('engine stop / start; no parking-brake release without air', () => {
  const veh = newVeh({ parkingBrake: true });
  veh.update(DT, { throttle: 0, brake: 0, steer: 0 }, ['engine'], {});
  assert.equal(veh.engineRunning, false);
  const ev = veh.update(DT, { throttle: 0, brake: 0, steer: 0 }, ['parkingBrake'], {});
  assert.ok(ev.some((e) => e.type === 'refused') && veh.parkingBrake);
  veh.update(DT, { throttle: 0, brake: 0, steer: 0 }, ['engine'], {});
  run(veh, 2.5, { throttle: 0, brake: 0, steer: 0 });
  assert.equal(veh.engineRunning, true);
  near(veh.rpm, 600, 5, 'idle rpm');
});

// ---------------------------------------------------------------- terrain / kerbs
const kerbAt = (xk) => ({ heightAt: (x) => (x > xk ? 0.15 : 0) });
function kerbRun(kmh) {
  const veh = newVeh({ x: 0, terrain: kerbAt(20) });
  const evs = run(veh, 40, { throttle: veh.kmh < kmh ? 1 : 0, brake: 0, steer: 0 }, { siteRect: FAR, terrain: kerbAt(20) }, () => veh.pos.x < 40);
  return { veh, kerbs: evs.filter((e) => e.type === 'kerb') };
}
test('kerb strike: none at crawl, one soft event per crossing at ~3 m/s, hard above 4 m/s', () => {
  const slow = new Vehicle().reset({ x: 0, z: 0, yaw: 0, parkingBrake: false, terrain: kerbAt(20) });
  let evs = run(slow, 40, { throttle: 1, brake: 0, steer: 0, crawl: true }, { siteRect: FAR, terrain: kerbAt(20) }, () => slow.pos.x < 32);
  assert.equal(evs.filter((e) => e.type === 'kerb').length, 0, 'kerb at 1.4 m/s');
  const mid = new Vehicle().reset({ x: -10, z: 0, yaw: 0, parkingBrake: false, terrain: kerbAt(20) });
  evs = run(mid, 60, () => ({ throttle: mid.v < 3 ? 1 : 0, brake: mid.v > 3.2 ? 0.3 : 0, steer: 0 }), { siteRect: FAR, terrain: kerbAt(20) }, () => mid.pos.x < 32);
  const k1 = evs.filter((e) => e.type === 'kerb');
  assert.equal(k1.length, 1, `soft events ${k1.length}`);
  assert.equal(k1[0].tag, 'soft');
  assert.equal(mid.kpi.kerb, 1);
  const fast = new Vehicle().reset({ x: -40, z: 0, yaw: 0, parkingBrake: false, terrain: kerbAt(20) });
  evs = run(fast, 60, () => ({ throttle: fast.v < 5 ? 1 : 0, brake: 0, steer: 0 }), { siteRect: FAR, terrain: kerbAt(20) }, () => fast.pos.x < 32);
  const k2 = evs.filter((e) => e.type === 'kerb');
  assert.ok(k2.length === 1 && k2[0].tag === 'hard' && fast.kpi.kerbHard === 1, JSON.stringify(k2));
  // pose: on the kerb the carrier sits 0.15 m higher, level
  near(fast.pose.y, 0.15, 0.01, 'pose y'); near(fast.pose.pitch, 0, 1e-3, 'pitch');
  return `soft at ${k1[0].speed.toFixed(1)} m/s, hard at ${k2[0].speed.toFixed(1)} m/s`;
});

test('terrain pose: plane fit through the 10 wheels (roll with the right wheels on a kerb)', () => {
  const t = { heightAt: (x, z) => (z > 0.5 ? 0.15 : 0) }; // right track (+z at yaw 0) up
  const veh = new Vehicle().reset({ x: 0, z: 0, yaw: 0, terrain: t });
  near(veh.pose.roll, -Math.atan(0.15 / (2 * AT100.carrier.tyre.trackY)), 1e-9, 'roll'); // left side down → negative
  near(veh.pose.y, 0.075, 1e-9, 'y');
});

// ---------------------------------------------------------------- collisions
function worldWith(...boxes) { const w = new ColliderWorld(); for (const b of boxes) w.add(b); return w; }
test('collision > 0.5 m/s stops the carrier (KPI −10); slow contact scrapes; low boxes are driven over', () => {
  const wall = new Box(20, 1, 0, 0.5, 1, 5, 0, 'stack');
  const veh = newVeh();
  let evs = run(veh, 20, { throttle: 1, brake: 0, steer: 0 }, { siteRect: FAR, world: worldWith(wall) }, () => veh.pos.x < 30);
  const c = evs.filter((e) => e.type === 'collision');
  assert.equal(c.length, 1, `collisions ${c.length}`);
  assert.equal(veh.kpi.collisions, 1);
  // the 2.0 m wall stops the body (bumper x_c 7.75); the boom-nose box (y 2.4-3.9) passes over it
  const front = veh.pos.x + AT100.carrier.frontX;
  assert.ok(Math.abs(front - 19.5) < 0.05, `bumper stopped at ${front}`);
  // creep into a wall at 0.3 m/s → one scrape, no collision
  const slow = newVeh();
  evs = run(slow, 40, () => ({ throttle: slow.v < 0.3 ? 0.3 : 0, brake: 0, steer: 0 }), { siteRect: FAR, world: worldWith(new Box(20, 1, 0, 0.5, 1, 5, 0, 'stack')) });
  assert.equal(evs.filter((e) => e.type === 'collision').length, 0);
  assert.equal(evs.filter((e) => e.type === 'scrape').length, 1);
  // a 0.3 m kerb stone / pallet is below the 0.35 m obstacle threshold
  const low = newVeh();
  evs = run(low, 20, { throttle: 1, brake: 0, steer: 0, crawl: true }, { siteRect: FAR, world: worldWith(new Box(10, 0.15, 0, 0.5, 0.15, 5, 0, 'stack')) });
  assert.equal(evs.filter((e) => e.type === 'collision' || e.type === 'scrape').length, 0);
  return `stopped with the nose at x = ${front.toFixed(2)}`;
});

test('tail swing: turning at full lock next to a post hits it with the rear corner', () => {
  // ALL program full right lock from rest: the rear-left corner swings out (left = −z at yaw 0)
  const veh = newVeh({ program: 'ALL' });
  // ICR at (2.085, +7.08); the post sits 0.4 m off the left side, 9.7 m from the ICR (inside the 8.46-10.25 m tail sweep)
  const post = new Box(-1.0, 1, -2.1, 0.3, 1, 0.3, 0, 'light');
  const evs = run(veh, 20, { throttle: 1, brake: 0, steer: 1, crawl: true }, { siteRect: FAR, world: worldWith(post) });
  assert.ok(evs.some((e) => e.type === 'scrape' || e.type === 'collision'), 'no contact with the post');
});

test('south fence: continuous collider ignored, gate open (x −34..−26), segments block elsewhere', () => {
  const fence = new Box(2, 1.2, -58, 64, 1.2, 0.1, 0, 'fence');
  // straight north through the gate on x = −30
  const veh = newVeh({ x: -30, z: -75, yaw: -Math.PI / 2 });
  let evs = run(veh, 40, { throttle: 1, brake: 0, steer: 0, crawl: true }, { world: worldWith(fence) }, () => veh.pos.z < -45);
  assert.equal(evs.filter((e) => e.type === 'collision' || e.type === 'scrape').length, 0, 'hit in the gate');
  assert.ok(veh.pos.z >= -45);
  // straight north at x = 0 → the east segment stops it
  const v2 = newVeh({ x: 0, z: -75, yaw: -Math.PI / 2 });
  evs = run(v2, 30, { throttle: 1, brake: 0, steer: 0 }, { world: worldWith(new Box(2, 1.2, -58, 64, 1.2, 0.1, 0, 'fence')) });
  assert.ok(evs.some((e) => e.type === 'collision' && e.tag === 'fence'), 'fence not hit');
  assert.ok(Math.abs(v2.pos.z + AT100.carrier.frontX - -58.1) < 0.05, `bumper stopped at ${v2.pos.z + AT100.carrier.frontX}`);
});

test('own colliders (tag mobile*) and env.ignore are skipped; site speed KPI above 11 km/h', () => {
  const own = new Box(10, 1, 0, 1, 1, 1, 0, 'mobile');
  const ign = new Box(20, 1, 0, 1, 1, 1, 0, 'load');
  const site = { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 };
  const veh = newVeh();
  const evs = run(veh, 20, () => ({ throttle: veh.kmh < 15 ? 1 : 0, brake: 0, steer: 0 }), { siteRect: site, world: worldWith(own, ign), ignore: new Set([ign]), limitKmh: 10 });
  assert.equal(evs.filter((e) => e.type === 'collision' || e.type === 'scrape').length, 0);
  assert.equal(veh.zone, 'site'); assert.equal(veh.limitKmh, 10);
  assert.ok(veh.kpi.speedingTime > 5 && evs.some((e) => e.type === 'speeding'), `speeding ${veh.kpi.speedingTime}`);
  return `speeding ${veh.kpi.speedingTime.toFixed(1)} s`;
});

// ---------------------------------------------------------------- interlock
test('travel interlock (§6.5)', () => {
  const ok = { beams: [0, 0, 0, 0], jacks: [0, 0, 0, 0], pinned: true, slewDeg: 0, luffDeg: 0.5, boomLen: 11.5, stowed: true, cwKg: 0, deckSlabs: [] };
  assert.equal(travelInterlock(ok).ok, true);
  const cases = [
    [{ beams: [0, 0.5, 0, 0] }, 'beams'], [{ jacks: [0, 0, 0.1, 0] }, 'jacks'], [{ pinned: false }, 'pin'], [{ slewDeg: 3 }, 'pin'],
    [{ luffDeg: 5 }, 'rest'], [{ boomLen: 15.2 }, '11.5'], [{ stowed: false }, 'stow'], [{ cwKg: 11500 }, 'counterweight'], [{ deckSlabs: ['A'] }, 'deck'],
  ];
  for (const [over, word] of cases) {
    const r = travelInterlock({ ...ok, ...over });
    assert.ok(!r.ok && r.text.startsWith('TRAVEL INTERLOCK: ') && r.reason.includes(word), `${JSON.stringify(over)} → ${r.text}`);
  }
  assert.equal(travelInterlock({ ...ok, cwKg: 11500, siteTravel: true }).ok, true, 'M6 site-travel exception');
});

// ---------------------------------------------------------------- route
test('route: legs chain, turn radii = 1/κ_max of their program, guidance distance', () => {
  const P = routePath();
  for (const l of P.legs.filter((q) => q.kind === 'turn')) {
    const k = VEHICLE.programs[l.program].kappaMax;
    near(l.radius, 1 / k, 0.03, `leg ${l.index} radius`);
  }
  for (let i = 1; i < P.nVisible; i++) assert.ok(Math.hypot(P.x[i] - P.x[i - 1], P.z[i] - P.z[i - 1]) < 0.6, `gap at ${i}`);
  resetGuidance();
  const g0 = guidance({ x: SPAWN.x, z: SPAWN.z }, SPAWN.yaw);
  near(g0.distance, P.length + VEHICLE.programs.ROAD.xRef, 0.05, 'spawn distance');
  assert.equal(g0.leg, 0);
  resetGuidance();
  const g1 = guidance({ x: P1.x, z: P1.z }, P1.yaw);
  assert.ok(g1.atTarget && g1.distance < 0.01, JSON.stringify(g1));
  return `route ${P.length.toFixed(1)} m, ${P.legs.length} legs`;
});

// The live collider world along the route (snapshot of __sim.world.boxes with
// top > 0.35 m in x −48..72, z −76..2, taken from the running app; the
// mobile's own boxes and loose loads left out). The south fence is the
// continuous perimeter collider (gate included), exactly as in the game.
const SITE_BOXES = [
    ["fence", 2, 1.2, -58, 64, 1.2, 0.1, 0],
    ["gate", -33.546, 1.3, -55.984, 1.925, 1.3, 0.06, -1.3963],
    ["gate", -26.454, 1.3, -55.984, 1.925, 1.3, 0.06, -1.7453],
    ["sign", -24.6, 1.2, -52.5, 0.25, 1.2, 0.25, 0],
    ["sign", -35, 1.2, -44.8, 0.25, 1.2, 0.25, 0],
    ["fence", 0, 1.05, -5.5, 5.5, 1.05, 0.08, 0],
    ["fence", 5.5, 1.05, 0, 5.5, 1.05, 0.08, -1.5708],
    ["fence", -5.5, 1.05, -3.35, 2.15, 1.05, 0.08, 1.5708],
    ["fence", -35.3, 1.05, -52.6, 5, 1.05, 0.08, -1.5708],
    ["cabin", -45.6, 1.3, -44, 1.45, 1.3, 3, 0],
    ["cabin", -45.6, 3.9, -44, 1.45, 1.3, 3, 0],
    ["cabin", -43.4, 1.31, -38.175, 0.5, 1.31, 1.575, 0],
    ["stack", -46.7, 0.7, -15.8, 0.65, 0.7, 2.1, 0],
    ["stack", 40, 0.9, -31, 1.25, 0.9, 2.15, 0],
    ["stack", 30, 0.8, -45, 1.7, 0.8, 0.6, 0],
    ["stack", 30, 0.2, -42.5, 3.1, 0.2, 0.8, 0],
    ["generator", -8, 0.9, -40, 1.6, 0.9, 0.7, 0],
    ["plant", -3.3, 0.9, -41.2, 1.5, 0.9, 0.75, 0],
    ["drum", -5.45, 0.45, -38.8, 0.75, 0.45, 0.4, 0],
    ["washer", -31.7, 0.48, -53.5, 0.1, 0.48, 3.1, 0],
    ["washer", -28.3, 0.48, -53.5, 0.1, 0.48, 3.1, 0],
    ["washer", -26.5, 0.8, -51.7, 0.8, 0.8, 1.5, 0],
    ["barrier", 22, 0.5, -48, 1.25, 0.5, 1.25, 0],
    ["barrier", -20.8, 0.55, -56.9, 3.3, 0.55, 0.3, 0],
    ["sign", -41.6, 0.65, -48.8, 1.3, 0.65, 0.3, 0],
    ["truck", -20, 1.6, -30, 4.4, 1.6, 1.3, 0.35],
    ["truck", 4.813, 0.67, -22.179, 6.25, 0.67, 1.25, -0.15],
    ["truck", 12.13, 1.9, -21.073, 1.1, 1.9, 1.25, -0.15],
    ["light", -42.2, 1, -53.4, 1.3, 1, 1, -0.7629],
    ["light", -41.766, 4.3, -52.985, 0.15, 4.3, 0.15, 0],
    ["light", 62, 1, -44, 1.3, 1, 1, -2.4469],
    ["light", 61.539, 4.3, -43.616, 0.15, 4.3, 0.15, 0],
    ["mast", 0, 22.5, 0, 0.9, 22.5, 0.9, 0],
    ["foundation", 0, 0.3, 0, 3.25, 0.3, 3.25, 0],
];
// The ground around the gate: carriageway y 0 between the kerbs (z −71..−61), footways and lots
// y 0.15 beyond them, site interior y 0, gate crossover (x −34..−26) dropped to 0 (world/terrain.js).
const ROAD_TERRAIN = {
  heightAt(x, z) {
    if (x > -62 && x < 66 && z > -58 && z < 66) return 0;
    if (z < -71) return 0.15;
    if (z > -61) return x > -34 && x < -26 && z < -58 ? 0 : 0.15;
    return 0;
  },
};
function siteWorld() {
  const w = new ColliderWorld();
  for (const [tag, cx, cy, cz, hx, hy, hz, yaw] of SITE_BOXES) w.add(new Box(cx, cy, cz, hx, hy, hz, yaw, tag));
  w.add(new Box(2, 1.2, 66, 64, 1.2, 0.1, 0, 'fence')); w.add(new Box(-62, 1.2, 4, 0.1, 1.2, 62, 0, 'fence')); w.add(new Box(66, 1.2, 4, 0.1, 1.2, 62, 0, 'fence'));
  return w;
}

// A simple driver for the reference point: path-curvature feed-forward
// previewed half a steering transition ahead (the steering needs 1.5 s from
// full lock to straight, so a good driver starts unwinding before the arc
// ends), plus lateral / heading feedback. ALL-wheel steer from just before turn
// 1 to the end of turn 3, ROAD afterwards; crawl through the turns and the gate.
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function pathAt(P, s) {
  let i = Math.max(0, Math.min(P.n - 2, Math.floor(s / 0.5)));
  while (i > 0 && P.s[i] > s) i--;
  while (i < P.n - 2 && P.s[i + 1] < s) i++;
  const t = Math.max(0, Math.min(1, (s - P.s[i]) / Math.max(1e-6, P.s[i + 1] - P.s[i])));
  // heading of the segment i → i+1 blended toward the next segment (continuous along arcs)
  const segYaw = (k) => Math.atan2(-(P.z[k + 1] - P.z[k]), P.x[k + 1] - P.x[k]);
  const y0 = segYaw(i), y1 = i + 2 < P.n ? segYaw(i + 1) : y0;
  const yaw = t < 0.5 ? y0 + wrapA(y0 - segYaw(Math.max(0, i - 1))) * (t - 0.5) * (i > 0 ? 1 : 0) : y0 + wrapA(y1 - y0) * (t - 0.5);
  return { x: P.x[i] + (P.x[i + 1] - P.x[i]) * t, z: P.z[i] + (P.z[i + 1] - P.z[i]) * t, yaw };
}
// exact path curvature from the legs (turn legs: ±1/r, S-curve of leg 0 numerically)
function pathKappa(P, s) {
  const leg = P.legs.find((l) => s >= l.s0 && s < l.s1);
  if (!leg) return 0;
  if (leg.kind === 'turn') return Math.sign(wrapA(pathAt(P, leg.s1 - 0.01).yaw - pathAt(P, leg.s0 + 0.01).yaw)) / leg.radius;
  return wrapA(pathAt(P, s + 0.25).yaw - pathAt(P, s - 0.25).yaw) / 0.5;
}
function driveRoute(world, o = {}) {
  const P = routePath();
  const veh = new Vehicle().reset({ x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, parkingBrake: false });
  resetGuidance();
  const evs = [];
  let maxLat = 0, t = 0, done = false, maxLeg = 0;
  const acts = [];
  const turnKmh = o.turnKmh ?? 3;
  while (t < 500 && !done) {
    const g = guidance(veh.pos, veh.yaw, { xRef: veh.xRef });
    maxLeg = Math.max(maxLeg, g.leg);
    const L = P.legs;
    const want = (maxLeg >= 1 && maxLeg <= 3) || (maxLeg === 0 && L[1].s0 - g.s < 4) || (maxLeg === 4 && g.s < L[4].s0 + 3) ? 'ALL' : 'ROAD';
    acts.length = 0;
    if (veh.program !== want) acts.push('program'); // cycles ROAD → ALL → CRAB → ROAD
    const pv = Math.abs(veh.v) * 0.75 + (o.lead ?? 0.2); // half the steering transition (1.5 s lock to straight) + a little lead
    const kFF = pathKappa(P, g.s + pv);
    const eYaw = wrapA(veh.yaw - pathAt(P, g.s).yaw); // + = rotated left of the path
    // feedback scheduled with speed: ÿ + b·v·ẏ + a·v²·y = 0 with ω_n = 0.8 rad/s, ζ = 0.9
    const ve = Math.max(0.8, Math.abs(veh.v)), ka = (0.8 / ve) ** 2, kb = ((2 * 0.9 * 0.8) / ve) * (o.kb ?? 1);
    const kCmd = kFF + ka * g.lateral - kb * eYaw; // lateral + = right → turn left (κ +)
    const kMax = programGeometry(veh.program, veh.kmh).kappaMax || 1 / 8.09;
    const steer = Math.max(-1, Math.min(1, -kCmd / kMax));
    // speed plan: 25 km/h on the road, 8 km/h on site, crawl near turns and through the gate / wash
    const nt = L[g.leg + 1]?.kind === 'turn' ? L[g.leg + 1] : null;
    const nearTurn = L[g.leg].kind === 'turn' || (nt && nt.s0 - g.s < 10) || (g.s > L[2].s0 && g.s < L[3].s0);
    let vT = g.leg === 0 ? (g.s < 12 ? 20 : 10) / 3.6 : 8 / 3.6; // lane change at 10 km/h
    if (nearTurn) vT = turnKmh / 3.6;
    const last = g.leg === L.length - 1;
    if (last) vT = Math.min(vT, Math.sqrt(2 * 0.5 * Math.max(0, g.distance - 0.03)));
    if (last && (g.distance < 0.03 || g.overshoot)) vT = 0;
    const throttle = veh.v < vT - 0.03 ? Math.min(1, (vT - veh.v) * 2) : 0;
    const brake = vT === 0 ? 1 : veh.v > vT + 0.1 ? Math.min(1, (veh.v - vT) * 1.5) : 0;
    const ev = veh.update(DT, { throttle, brake, steer }, acts, { world, siteRect: { minX: -62, maxX: 66, minZ: -58, maxZ: 66 }, terrain: o.terrain ?? flat, traffic: o.traffic });
    for (const e of ev) evs.push({ ...e, t, x: veh.pos.x, z: veh.pos.z });
    if (g.s > 5 && !last) maxLat = Math.max(maxLat, Math.abs(g.lateral));
    if (o.trace && Math.round(t * 120) % 60 === 0) o.trace(t, g, veh, kFF, eYaw, kCmd);
    t += DT;
    if (vT === 0 && veh.standstill && last) done = true;
    if (o.onFrame && Math.round(t * 120) % 2 === 0) o.onFrame(veh, t);
    if (o.until && o.until(g, veh, t)) done = true;
  }
  return { veh, evs, maxLat, t };
}

test('drive the §8.1 route spawn → P1 (preview driver, live site colliders)', () => {
  const { veh, evs, maxLat, t } = driveRoute(siteWorld(), { terrain: ROAD_TERRAIN });
  const dpos = Math.hypot(veh.pos.x - P1.x, veh.pos.z - P1.z);
  const dyaw = Math.abs(Math.atan2(Math.sin(veh.yaw - P1.yaw), Math.cos(veh.yaw - P1.yaw))) / DEG;
  const col = evs.filter((e) => e.type === 'collision' || e.type === 'trafficCollision');
  const scr = evs.filter((e) => e.type === 'scrape');
  assert.equal(col.length, 0, `collisions: ${JSON.stringify(col.map((e) => [e.tag, e.t.toFixed(1)]))}`);
  assert.ok(dpos <= P1.tolPos && dyaw <= P1.tolYawDeg, `P1 miss: ${dpos.toFixed(2)} m, ${dyaw.toFixed(2)}°`);
  assert.ok(maxLat < ROUTE.width / 2, `left the 3.5 m corridor: ${maxLat.toFixed(2)} m`);
  assert.equal(veh.kpi.kerb + veh.kpi.kerbHard, 0, `kerb strikes ${JSON.stringify(evs.filter((e) => e.type === 'kerb').map((e) => [e.t.toFixed(1), e.x.toFixed(1), e.z.toFixed(1)]))}`);
  return `P1 ${dpos.toFixed(2)} m / ${dyaw.toFixed(2)}° in ${t.toFixed(0)} s, max cross-track ${maxLat.toFixed(2)} m, scrapes ${scr.length}${scr.length ? ` (${scr.map((e) => e.tag).join(',')})` : ''}, kerbs ${veh.kpi.kerb + veh.kpi.kerbHard}`;
});

// ---------------------------------------------------------------- streets API
const THREE = await import('three');
const { buildTraffic } = await import('../src/world/streets/traffic.js');
const { buildPedestrians } = await import('../src/world/streets/pedestrians.js');
const { Signals } = await import('../src/world/streets/signals.js');
const { intersections } = await import('../src/world/layout.js');
const { blocked, inCraneApproach } = await import('../src/world/streets/common.js');

function makeTraffic(quality = 'low') {
  const signals = new Signals(intersections().filter((n) => Math.abs(n.x) <= 400 && Math.abs(n.z) <= 400));
  const crossings = new Map();
  const traffic = buildTraffic(new THREE.Group(), { name: quality, city: 1 }, { pos: new THREE.Vector3(0, 50, 0) }, signals, crossings, null);
  return { signals, traffic, crossings };
}
const snapshot = (tr) => tr.active.map((v) => `${v.type}:${v.s.toFixed(6)}:${v.v.toFixed(6)}`).join('|');

test('CRANE_APPROACH: no parked cars / furniture along the approach (junction kept)', () => {
  const { traffic } = makeTraffic();
  const a = CRANE_APPROACH;
  const inZone = traffic.parked.filter((p) => p.x > a.minX && p.x < a.maxX && p.z > a.minZ && p.z < a.maxZ);
  assert.equal(inZone.length, 0, `${inZone.length} parked cars in the approach`);
  assert.ok(blocked(-60, -70.5) && blocked(-60, -60.5) && inCraneApproach(-25, -71));
  assert.ok(!inCraneApproach(-100 + 9.35, -66 - 5.55), 'junction signal post removed');
  return `${traffic.parked.length} parked cars elsewhere`;
});

test('traffic: setObstacles([]) leaves the IDM traffic bit-identical', () => {
  const A = makeTraffic(), B = makeTraffic();
  B.traffic.setObstacles([]);
  for (let i = 0; i < 600; i++) { A.signals.update(1 / 60); A.traffic.update(1 / 60, 0); B.signals.update(1 / 60); B.traffic.update(1 / 60, 0); }
  assert.equal(snapshot(A.traffic), snapshot(B.traffic));
  return `${A.traffic.active.length} vehicles after 10 s`;
});

test('traffic: an obstacle in the far lane is a stopped leader; oncoming traffic queues, the other lane flows', () => {
  const { signals, traffic } = makeTraffic();
  // the crane in the far lane / kerb strip at the gate (ref z −69.35, heading +x)
  const obstacle = [{ x: -40, z: -69.35, hx: 6.9, hz: 1.375, yaw: 0, vx: 0, vz: 0 }];
  traffic.setObstacles(obstacle);
  traffic.clearArea(obstacle[0]); // placed on the road: nobody may be left inside it
  const o = { ...obstacle[0], c: 1, s: 0 };
  let inside = 0, queued = 0, passedEast = 0;
  const pa = {};
  for (let i = 0; i < 60 * 90; i++) {
    signals.update(1 / 60); traffic.update(1 / 60, 0);
    for (const v of traffic.active) {
      v.lane.at(v.s, pa);
      // front bumper inside the obstacle footprint (+ corridor)?
      const fx = pa.x + pa.hx * v.halfLen, fz = pa.z + pa.hz * v.halfLen;
      if (Math.abs(fx - o.x) < o.hx - 0.2 && Math.abs(fz - o.z) < o.hz + 1.4) inside++;
    }
  }
  for (const v of traffic.active) {
    if (v.lane.kind !== 'road' || v.lane.axis !== 'x' || v.lane.c !== -66) continue;
    v.lane.at(v.s, pa);
    if (v.lane.dir < 0 && pa.x > -34 && pa.x < 0 && v.v < 0.1) queued++; // westbound, waiting east of the crane
    if (v.lane.dir > 0 && pa.x > -34 && v.v > 1) passedEast++;
  }
  assert.equal(inside, 0, 'a vehicle drove into the obstacle');
  assert.ok(queued >= 1, 'no westbound queue');
  const b = traffic.vehicleBoxes(-40, -66, 60, []);
  assert.ok(b.length > 0 && b.every((q) => q.hx > 1 && q.hz > 0.5 && Number.isFinite(q.c) && q.r > 0));
  return `${queued} westbound waiting, ${passedEast} eastbound moving past, ${b.length} boxes within 60 m`;
});

test('traffic: clearArea removes the moving cars under a rectangle (parked cars stay)', () => {
  const { traffic } = makeTraffic();
  const pa = {};
  const v = traffic.active.find((q) => q.lane.kind === 'road');
  v.lane.at(v.s, pa);
  const box = { x: pa.x, z: pa.z, hx: 7, hz: 1.4, yaw: Math.atan2(-pa.hz, pa.hx) };
  const parked = traffic.parked.length, n0 = traffic.active.length;
  const n = traffic.clearArea(box);
  assert.ok(n >= 1 && traffic.active.length === n0 - n && !traffic.active.includes(v) && traffic.parked.length === parked);
  return `${n} removed`;
});

test('traffic: following a moving obstacle keeps a gap instead of stopping dead', () => {
  const { signals, traffic } = makeTraffic();
  // obstacle moving east at 3 m/s in the near (eastbound) lane
  const ob = { x: -60, z: -64.25, hx: 6.9, hz: 1.375, yaw: 0, vx: 3, vz: 0 };
  traffic.setObstacles([ob]);
  const pa = {};
  let minGap = Infinity;
  for (let i = 0; i < 60 * 20; i++) {
    ob.x += 3 / 60;
    signals.update(1 / 60); traffic.update(1 / 60, 0);
    for (const v of traffic.active) {
      if (v.lane.kind !== 'road' || v.lane.c !== -66 || v.lane.axis !== 'x' || v.lane.dir < 0) continue;
      v.lane.at(v.s, pa);
      const gap = ob.x - ob.hx - (pa.x + v.halfLen);
      if (gap > -1 && gap < 60) minGap = Math.min(minGap, gap);
    }
  }
  assert.ok(minGap > 1.0, `min gap ${minGap}`);
  return `min gap ${minGap.toFixed(2)} m`;
});

test('road approach with live traffic: gate hold + obstacle feed, no traffic collision, no deadlock', () => {
  const { signals, traffic } = makeTraffic('ultra');
  for (let i = 0; i < 60 * 20; i++) { signals.update(1 / 60); traffic.update(1 / 60, 0); } // busy road
  const probe = new Vehicle().reset({ x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw });
  const cleared = traffic.clearArea(probe.obstacles()[0]);
  const pa = {};
  let maxQueue = 0, held = 0;
  const { veh, evs, t } = driveRoute(siteWorld(), {
    terrain: ROAD_TERRAIN, traffic,
    onFrame(v) {
      const hold = approachHold(v.pos, v.yaw); // without it the oncoming queue forms in the crane's path (critical collision)
      if (hold) held++;
      traffic.setObstacles(v.obstacles({ extra: hold }));
      signals.update(1 / 60); traffic.update(1 / 60, 0);
      let q = 0;
      for (const c of traffic.active) {
        if (c.lane.kind !== 'road' || c.lane.axis !== 'x' || c.lane.c !== -66 || c.lane.dir > 0) continue;
        c.lane.at(c.s, pa);
        if (pa.x > -26 && pa.x < 40 && c.v < 0.2) q++;
      }
      maxQueue = Math.max(maxQueue, q);
    },
    until: (g, v) => g.leg >= 3 && v.pos.z > -50, // through the gate and the wash
  });
  const bad = evs.filter((e) => e.type === 'trafficCollision' || (e.type === 'scrape' && e.tag === 'traffic') || e.type === 'collision');
  assert.equal(bad.length, 0, JSON.stringify(bad.map((e) => [e.type, e.tag, e.t.toFixed(1), e.x.toFixed(1), e.z.toFixed(1)])));
  assert.ok(veh.pos.z > -50 && t < 120, `stuck at ${veh.pos.x.toFixed(1)}, ${veh.pos.z.toFixed(1)} after ${t.toFixed(0)} s`);
  assert.equal(approachHold(veh.pos, veh.yaw), null, 'hold still active on site');
  return `through the gate in ${t.toFixed(0)} s, ${cleared} car(s) cleared at spawn, westbound queue up to ${maxQueue}, hold active ${(held / 60).toFixed(0)} s`;
});

test('pedestrians: stop 1.5 m short of an obstacle on the footway; unchanged without obstacles', () => {
  const mk = () => {
    const signals = new Signals(intersections().filter((n) => Math.abs(n.x) <= 400 && Math.abs(n.z) <= 400));
    return { signals, peds: buildPedestrians(new THREE.Group(), { name: 'low', city: 1 }, signals, new Map(), { busStops: [], idle: [] }) };
  };
  const A = mk(), B = mk();
  B.peds.setObstacles([]);
  for (let i = 0; i < 300; i++) { A.signals.update(1 / 60); A.peds.update(1 / 60, null); B.signals.update(1 / 60); B.peds.update(1 / 60, null); }
  assert.equal(A.peds.peds.map((p) => `${p.x.toFixed(6)},${p.z.toFixed(6)}`).join('|'), B.peds.peds.map((p) => `${p.x.toFixed(6)},${p.z.toFixed(6)}`).join('|'));
  // the crane across the site-frontage footway at the gate (heading +z through the gate)
  const C = mk();
  const ob = { x: -30, z: -60, hx: 6.9, hz: 1.375, yaw: -Math.PI / 2 };
  C.peds.setObstacles([ob]);
  const o = { x: ob.x, z: ob.z, hx: ob.hx, hz: ob.hz, c: Math.cos(ob.yaw), s: Math.sin(ob.yaw) };
  const dist = (x, z) => { const dx = x - o.x, dz = z - o.z; const lx = Math.abs(dx * o.c - dz * o.s) - o.hx, lz = Math.abs(dx * o.s + dz * o.c) - o.hz; return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)); };
  let entered = 0, waiting = 0;
  for (let i = 0; i < 60 * 120; i++) {
    C.signals.update(1 / 60); C.peds.update(1 / 60, null);
    if (i > 60 * 5) for (const p of C.peds.peds) if (dist(p.x + (p.ox || 0), p.z + (p.oz || 0)) < 0.5) entered++;
  }
  for (const p of C.peds.peds) { const d = dist(p.x + (p.ox || 0), p.z + (p.oz || 0)); if (d < 2.2 && p.gait < 0.2) waiting++; }
  assert.equal(entered, 0, 'pedestrians walked into the obstacle');
  return `${waiting} waiting at the crane`;
});

console.log(`\n${count - failures}/${count} tests passed`);
if (process.env.ROUTE_TRACE) driveRoute(siteWorld(), { terrain: ROAD_TERRAIN, lead: +(process.env.LEAD ?? 0.2), kb: +(process.env.KB ?? 1), trace: (t, g, v, kff, ey, kc) => console.log(t.toFixed(1), g.leg, g.s.toFixed(1), g.lateral.toFixed(2), v.program, v.pos.x.toFixed(2), v.pos.z.toFixed(2), (v.yaw * 180 / Math.PI).toFixed(1), v.steerPos.toFixed(2), v.kmh.toFixed(1), 'kff', kff?.toFixed(3), 'ey', (ey * 180 / Math.PI).toFixed(2), 'kc', kc?.toFixed(3), 'k', v.kappa.toFixed(3)) });
process.exit(failures ? 1 : 0);
