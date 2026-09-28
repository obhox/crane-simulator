#!/usr/bin/env node
// WP-JOBS tests (plain node): mobile job helpers, M1–M6 definitions against
// the §8.4 design numbers, job props (colliders / placements) and a JobRunner
// run of M1 and M5 against a scripted fake mobile machine, plus the tower
// JobRunner path. `node scripts/test-mobile-jobs.mjs`
import assert from 'node:assert/strict';

// ---- minimal DOM canvas stub so the canvas-texture builders run in node
const ctx2d = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'measureText') return (s) => ({ width: String(s).length * 10 });
    if (k === 'getImageData' || k === 'createImageData') return (a, b, w, h) => { const W = w ?? a, H = h ?? b; return { width: W, height: H, data: new Uint8ClampedArray(Math.max(1, W * H * 4)) }; };
    if (k === 'canvas') return {};
    return () => {};
  },
  set(t, k, v) { t[k] = v; return true; },
});
globalThis.document = { createElement: () => ({ width: 1, height: 1, getContext: () => ctx2d, style: {} }) };

const THREE = await import('three');
const { ColliderWorld } = await import('../src/physics/collide.js');
const { LOAD_DEFS } = await import('../src/loads.js');
const { P1, carrierToWorld, CW_DECK } = await import('../src/mobile/config.js');
const MJ = await import('../src/mobile/jobs.js');
const { buildProp, neighbourRoof, bindGround } = await import('../src/mobile/jobProps.js');
const { JobRunner, JOBS } = await import('../src/jobs.js');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok  ${name}`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const R = (x, z) => Math.hypot(x - P1.x, z - P1.z);

// ------------------------------------------------------------ helpers
test('detentOf: fractions, travel fractions and metres', () => {
  assert.equal(MJ.detentOf(1), 100); assert.equal(MJ.detentOf(0.5), 50); assert.equal(MJ.detentOf(0), 0);
  assert.equal(MJ.detentOf(1.25 / 2.25), 50); assert.equal(MJ.detentOf(0.3), null);
  assert.equal(MJ.detentOf(3.5), 100); assert.equal(MJ.detentOf(2.5), 50); assert.equal(MJ.detentOf(3.0), null);
});

test('classifyConfig: M5 trap, M6 base, exact, conservative', () => {
  const act = { mode: 'outriggers', base: 100, cwKg: 11500, block: 'ball' };
  assert.equal(MJ.classifyConfig({ mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' }, act), 'unconservative');
  assert.equal(MJ.classifyConfig({ mode: 'outriggers', base: 100, cwKg: 11500, block: 'ball' }, { ...act, base: 50 }), 'unconservative');
  assert.equal(MJ.classifyConfig({ mode: 'outriggers', base: 100, cwKg: 11500, block: 'ball' }, act), 'exact');
  assert.equal(MJ.classifyConfig({ mode: 'outriggers', base: 50, cwKg: 0, block: 'ball' }, act), 'conservative');
  assert.equal(MJ.classifyConfig({ mode: 'outriggers', base: 0, cwKg: 0, block: 'ball' }, { mode: 'tyres', base: 0, cwKg: 0 }), 'unconservative');
  assert.equal(MJ.classifyConfig({ mode: 'tyres', base: 0, cwKg: 0, block: 'ball' }, act), 'conservative');
  assert.equal(MJ.rclCode({ mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' }), 'OR B100 CW35.0 n1 BALL');
});

// scripted fake of the mobile machine (only the fields the jobs read)
function fakeMobile() {
  const m = {
    id: 'mobile', counters: { twoBlockCount: 0, lmiTrips: 0 }, hoistSpeed: 0,
    hoist: { load: null, loadGrounded: true, hook: new THREE.Vector3(), swingAngle: 0 },
    kpi: { collisions: 0, scrapes: 0, kerb: 0, kerbHard: 0, trafficCollisions: 0, sidePulls: 0, boomContacts: 0, floatLight: 0, liftoffs: 0, slams: 0, punchThrough: 0, bypass: 0, overturned: false },
    s: null,
    reset(st) {
      this.start = st;
      this.s = {
        mode: st.mode, pos: { ...st.pos }, yaw: st.yaw, speedKmh: 0, parkingBrake: true, beams: [...st.beams], floatsSet: st.jacksSet,
        tyresClear: st.jacksSet, mats: [...st.mats], tilt: { pitch: st.levelled ? 0.05 : 0.8, roll: 0 }, cwKg: st.cwKg, deckSlabs: [],
        block: st.block, reeving: false, boomLen: [11.5, 15.2, 19.0, 22.7, 26.4, 30.1, 33.9, 37.6, 41.3, 45.0, 48.8, 52.0][st.boomK], pinned: true,
        rcl: { config: { ...st.rcl }, state: 'ok', warnings: [] }, warnings: [], settlement: [0, 0, 0, 0],
      };
    },
    hudState() { return { slewRpm: this.slewRpm || 0, ratio: this.ratio || 0, lmiState: 'ok', mobile: { ...this.s } }; },
    signallerGeometry() { return { cx: this.s.pos.x, cz: this.s.pos.z, radialOut: 'Boom down', radialIn: 'Boom up' }; },
  };
  return m;
}

test('readMobile: preferred hudState names', () => {
  const m = fakeMobile();
  m.reset(MJ.resolveStart({ preset: 'pad' }));
  const v = MJ.readMobile(m);
  assert.deepEqual(v.detents, [100, 100, 100, 100]);
  assert.equal(v.floatsSet, true); assert.equal(v.cwKg, 35000); assert.equal(v.block, 'ball');
  near(v.levelDeg, 0.05, 1e-9, 'level'); assert.equal(v.rcl.confirmed, false);
  m.s.rcl.config.confirmed = true;
  assert.equal(MJ.configMatches(MJ.readMobile(m)), true);
  m.s.beams[2] = 0.5; // RL at 50 %: config B100 no longer matches
  assert.equal(MJ.configMatches(MJ.readMobile(m)), false);
});

test('readMobile: Phase-1 module fallbacks (outriggers objects, radians tilt, rcl object)', () => {
  const m = {
    hudState: () => ({ mobile: { mode: 'SETUP' } }), pos: { x: 57, z: -12 }, yaw: P1.yaw,
    vehicle: { v: 0, parkingBrake: true, kpi: { kerb: 2, kerbHard: 1, collisions: 0, scrapes: 3, speedingTime: 4 } },
    outriggers: { beams: [{ ext: 1, detent: true }, { ext: 1 }, { ext: 1.25 / 2.25 }, { ext: 0.3, detent: null }], mats: [{ id: 'carried' }, 'carried', 'none', 'composite'], floatsSet: true, tyresClear: false },
    stability: { tilt: { pitch: 0.01, roll: -0.002 }, state: 'STABLE' },
    rcl: { config: { mode: 'outriggers', base: 50, cwKg: 0, block: 'ball', confirmed: true }, state: 'warn', warnings: new Set(['SUPPORT']), counters: { bypassUsed: 0, mismatchTime: 7 } },
    ballast: { superKg: 11500, deckStack: [{ def: { slab: 'B' } }] },
  };
  const v = MJ.readMobile(m);
  assert.deepEqual(v.detents, [100, 100, 50, null]);
  assert.deepEqual(v.mats, ['carried', 'carried', 'none', 'composite']);
  near(v.levelDeg, 0.573, 0.001, 'tilt rad→deg');
  assert.ok(v.warnings.has('support')); assert.equal(v.rclState, 'warn');
  assert.deepEqual(v.deckSlabs, ['B']); assert.equal(v.cwKg, 11500);
  const c = MJ.mobileCounters(m);
  assert.equal(c.kerb, 2); assert.equal(c.scrapes, 3); assert.equal(c.speedingTime, 4); assert.equal(c.mismatchTime, 7);
  const list = MJ.setupChecklist(v, { beams: [0.5, 1, 0.5, 1], mats: true, levelDeg: 0.3, tyresClear: true });
  assert.deepEqual(list.map((i) => i.ok), [true, true, true, false, false, true, false, false]);
});

test('setupKpis: deductions and checklist', () => {
  const snap = {
    detents: [100, null, 100, 100], mats: ['carried', 'none', 'carried', 'carried'], floatsSet: true, tyresClear: false, levelDeg: 0.45,
    rcl: { mode: 'outriggers', base: 100, cwKg: 35000, block: 'hb26', confirmed: true },
    actual: { mode: 'outriggers', base: 50, cwKg: 11500, block: 'ball', onDetents: false },
  };
  const r = MJ.setupKpis(snap, 12);
  const pts = Object.fromEntries(r.items.map((i) => [i.label, i.pts]));
  assert.equal(pts['Outrigger beams at a detent'], -10);
  assert.equal(pts['Mats under the floats'], -5);
  assert.equal(pts['Tyres clear of the ground'], -10);
  assert.equal(pts['Crane level'], -5);
  assert.equal(pts['RCL configuration vs crane'], -30);
  assert.equal(pts['Reeving entered in the RCL'], -10);
  assert.equal(pts['Support ≠ config warning'], -10);
  assert.equal(r.criticalRisk, true);
  assert.equal(r.checklist.length, r.items.length);
});

// ------------------------------------------------------------ loads (§8.4 table)
test('load table', () => {
  const spec = {
    testBlock5: [5000, [1.6, 1.25, 1.0], 1.6, 20], hvac: [3000, [4.2, 2.1, 2.2], 3.2, 9.0], generator: [11500, [6.0, 2.6, 2.3], 3.4, 13],
    precast: [4200, [4.0, 2.1, 0.2], 2.4, 11], steelBundle: [6000, [8.0, 0.6, 1.0], 3.6, 17], transformer: [7500, [2.4, 2.2, 1.6], 2.0, 14],
    cwA: [11500, [2.6, 0.47, 1.25], 1.8, 20], cwB: [12000, [2.6, 0.49, 1.25], 1.8, 20], cwC: [11500, [2.6, 0.47, 1.25], 1.8, 20],
  };
  for (const [k, [mass, size, sling, wl]] of Object.entries(spec)) {
    const d = LOAD_DEFS[k];
    assert.equal(d.mass, mass, k); assert.deepEqual(d.size, size, k); assert.equal(d.sling, sling, k); assert.equal(d.windLimit, wl, k);
  }
  assert.equal(LOAD_DEFS.hvac.cd, 1.2);
  assert.deepEqual(LOAD_DEFS.generator.points, [[-2.7, -1.0], [2.7, -1.0], [2.7, 1.0], [-2.7, 1.0]]);
  assert.equal(LOAD_DEFS.cwB.slab, 'B');
});

// ------------------------------------------------------------ props
test('props: ballast truck slot C, barriers, roof parcel from planCity()', () => {
  const bt = buildProp('ballastTruck', { x: 50, z: -12, yaw: Math.PI / 2 });
  const c = bt.info.slot('C');
  near(c.x, 50, 1e-9, 'slot C x'); near(c.z, -8.5, 1e-9, 'slot C z'); assert.equal(c.y, 1.4);
  const bed = bt.colliders.find((b) => Math.abs(b.top - 1.4) < 1e-9);
  assert.ok(bed, 'bed collider top 1.40');
  const bar = buildProp('cableBarriers', { x: 60.9, z: 0 });
  assert.deepEqual(bar.colliders.map((b) => [b.cx, b.cy, b.cz, b.hx, b.hy, b.hz]), [-16.5, -13.5, -10.5, -7.5].map((z) => [60.9, 0.5, z, 0.5, 0.5, 1.5]));
  const pc = neighbourRoof();
  assert.equal(pc.fallback, false);
  near(pc.roofY, 16.4, 0.1, 'roof'); near(pc.x0, 87.5, 0.1, 'x0'); near(pc.z0, -19.9, 0.1, 'z0');
  const roof = buildProp('neighbourRoof', {}); // no scene → no plant scan → spec curb (93, −13)
  near(roof.info.curb.x, 93, 1e-9, 'curb x'); near(roof.info.curb.y, pc.roofY + 0.3, 1e-9, 'curb top');
  assert.ok(roof.colliders.filter((b) => b.tag === 'parapet').every((b) => Math.abs(b.top - (pc.roofY + 0.9)) < 1e-6));
  // arriving truck: starts 26 m back, ends on its mark, carries its load
  const at = buildProp('ballastTruck', { x: 50, z: -12, yaw: -Math.PI / 2, arrive: 16, from: 26 });
  near(at.z, -38, 1e-9, 'arrival start');
  const load = { pos: new THREE.Vector3(at.info.slot('B').x, 1.4 + 0.245, at.info.slot('B').z), yaw: 0, sync() {} };
  at.carry(load);
  for (let i = 0; i < 20 * 60; i++) at.update(1 / 60);
  near(at.z, -12, 1e-6, 'arrived'); near(load.pos.z, -13.1, 1e-6, 'slab rides along');
});

// ------------------------------------------------------------ JobRunner
function fakeSim(machine) {
  const log = [];
  const scene = new THREE.Scene();
  const sim = {
    scene, world: new ColliderWorld(), site: null, settings: {}, guidance: false, machine, loads: [],
    wind: { mean: 2, gustiness: 0.5, ramp: null, anemometer: 2, setMean(v) { this.mean = v; } },
    audio: { chime() {} },
    signaller: { enabled: false, reset() {}, update(dt, g) { sim.lastGeom = g; } },
    hud: { toast: (t, k) => log.push([k, t]), progress() {}, jobStep: (t, i) => log.push(['step', i, t]), showResults: (r) => { sim.results = r; }, jobChecklist: (l) => { sim.checklist = l; } },
    spawnLoad(type, x, z, yaw = 0, baseY = 0) {
      const d = LOAD_DEFS[type];
      const l = { type, def: d, mass: d.mass, yaw, attached: false, half: new THREE.Vector3(d.size[0] / 2, d.size[1] / 2, d.size[2] / 2), pos: new THREE.Vector3(x, baseY + d.size[1] / 2, z), mesh: { parent: scene }, sync() {} };
      sim.loads.push(l);
      return l;
    },
    clearLoads() { sim.loads.length = 0; },
    resetCrane: (o) => machine.reset(o),
  };
  sim.log = log;
  return sim;
}
const stepN = (J, sim, secs, lev = {}) => { for (let i = 0; i < secs * 60; i++) J.update(1 / 60, { slew: 0, hoist: 0, tele: 0, luff: 0, ...lev }, false); };

test('M1 end to end on a scripted machine (drive → setup → config → attach → deliver)', () => {
  const m = fakeMobile();
  const sim = fakeSim(m);
  const J = new JobRunner(sim);
  const def = JOBS.find((j) => j.id === 'm1');
  J.start(def);
  assert.equal(m.start.mode, 'ROAD'); near(m.start.pos.x, -82, 1e-9, 'spawn');
  assert.equal(J.step.kind, 'drive');
  // arrive off the mark → warned, not complete
  Object.assign(m.s, { pos: { x: 57.8, z: -12 }, yaw: P1.yaw, speedKmh: 0, parkingBrake: true });
  stepN(J, sim, 0.2);
  assert.equal(J.step.kind, 'drive');
  m.s.pos = { x: 57.2, z: -11.9 };
  stepN(J, sim, 0.1);
  assert.equal(J.step.kind, 'setup');
  // SETUP → CRANE without mats: incomplete
  Object.assign(m.s, { mode: 'SETUP', beams: [1, 1, 1, 1], floatsSet: true, tyresClear: true, tilt: { pitch: 0.1, roll: -0.2 } });
  stepN(J, sim, 0.1);
  assert.ok(sim.checklist && sim.checklist.some((i) => !i.ok));
  m.s.mode = 'CRANE';
  stepN(J, sim, 0.1);
  assert.equal(J.step.kind, 'setup');
  assert.ok(sim.log.some(([k, t]) => k === 'warn' && /Set-up incomplete/.test(t)));
  m.s.mats = ['carried', 'carried', 'carried', 'carried'];
  stepN(J, sim, 0.1);
  assert.equal(J.step.kind, 'config');
  m.s.rcl.config = { mode: 'outriggers', base: 100, cwKg: 0, block: 'ball', confirmed: true };
  stepN(J, sim, 0.1);
  assert.equal(J.step.kind, 'attach');
  const tb = J.step.load;
  near(R(tb.pos.x, tb.pos.z), 10.3, 0.05, 'M1 pick R');
  tb.attached = true; m.hoist.load = tb;
  stepN(J, sim, 0.1);
  assert.equal(J.step.kind, 'deliver');
  near(R(J.step.target.x, J.step.target.z), 11.7, 0.05, 'M1 drop R');
  assert.equal(sim.lastGeom.radialOut, 'Boom down');
  // lift off (first-lift snapshot), test lift, land, release
  m.hoist.loadGrounded = false; tb.pos.y += 0.3;
  stepN(J, sim, 2.5);
  assert.ok(J.firstLift, 'first lift snapshot');
  assert.equal(J.kpi.testLifts, 1);
  tb.pos.set(48.6, tb.half.y, -20.05); m.hoist.loadGrounded = true; tb.attached = false; m.hoist.load = null;
  J.onRelease(tb);
  assert.ok(J.done, 'job finished');
  const r = sim.results;
  assert.ok(r && Array.isArray(r.checklist) && r.checklist.every((c) => c.ok), 'setup checklist all ✓');
  assert.ok(r.items.some((i) => i.label === 'Pad position'));
  assert.equal(r.failed, null);
});

test('M5 trap: wrong RCL at first lift → CRITICAL RISK; t = 90 s truck; overturn → F', () => {
  const m = fakeMobile();
  const sim = fakeSim(m);
  const J = new JobRunner(sim);
  J.start(JOBS.find((j) => j.id === 'm5'));
  assert.equal(m.start.cwKg, 11500); assert.equal(m.start.rcl.cwKg, 35000);
  const sb = J.step.load;
  near(R(sb.pos.x, sb.pos.z), 13.6, 0.05, 'M5 pick R');
  m.s.rcl.config.confirmed = true;
  sb.attached = true; m.hoist.load = sb;
  stepN(J, sim, 0.1);
  m.hoist.loadGrounded = false;
  stepN(J, sim, 0.1);
  assert.equal(J.firstLift.rcl.cwKg, 35000);
  const t = J.step.target;
  near(R(t.x, t.z), 24, 0.05, 'M5 drop R');
  assert.equal(sim.loads.filter((l) => l.type === 'cwB').length, 0);
  stepN(J, sim, 91);
  assert.equal(sim.loads.filter((l) => l.type === 'cwB').length, 1, 'ballast truck with cwB arrived');
  m.s.mode = 'OVERTURNED';
  stepN(J, sim, 7);
  assert.ok(J.done);
  assert.equal(sim.results.grade, 'F'); assert.ok(sim.results.score <= 59);
  assert.equal(sim.results.failed, 'Crane overturned');
  assert.equal(sim.results.criticalRisk, true);
});

test('M2/M3/M4/M6 geometry vs §8.4 (radii, targets, starts)', () => {
  const run = (id) => { const m = fakeMobile(); const sim = fakeSim(m); const J = new JobRunner(sim); J.start(JOBS.find((j) => j.id === id)); return { m, sim, J }; };
  { // M2
    const { m, J } = run('m2');
    assert.equal(m.start.cwKg, 23500); assert.equal(m.start.block, 'hb26'); assert.equal(m.start.boomK, 0);
    const kinds = J.steps.map((s) => s.kind);
    assert.deepEqual(kinds, ['attach', 'deck', 'ballast', 'config', 'boom', 'attach', 'deliver']);
    const cw = J.steps[0].load;
    near(cw.pos.x, 50, 1e-6, 'cwC x'); near(cw.pos.z, -8.5, 1e-6, 'cwC z'); near(cw.pos.y - cw.half.y, 1.4, 1e-6, 'cwC on bed 1.40');
    const hv = J.steps[5].load;
    const rp = R(hv.pos.x, hv.pos.z);
    // Phase 2: R ≈ 20 m keeps the 45 m head top (≈ 43.7 m) under the 44.2 m tower-zone ceiling
    assert.ok(rp >= 19.7 && rp < 20.3, `HVAC pick R ${rp}`);
    near(J.steps[6].clearY, 19.5, 0.1, 'M2 clearY');
    // deck target from the carrier pose
    const deck = carrierToWorld(P1, P1.yaw, CW_DECK.x, CW_DECK.y);
    J.stepIndex = 0; J.nextStep();
    near(J.step.target.x, deck.x, 1e-6, 'deck x'); near(J.step.target.z, deck.z, 1e-6, 'deck z');
  }
  { // M3
    const { m, J } = run('m3');
    assert.equal(m.start.block, 'ball'); assert.equal(J.steps[0].kind, 'reeve'); assert.equal(J.steps[0].block, 'hb26');
    const g = J.steps[2].load;
    near(R(g.pos.x, g.pos.z), 15.6, 0.05, 'M3 pick R'); near(g.pos.y - g.half.y, 0.9, 1e-6, 'low-loader bed 0.9');
    const t = J.steps[3].target;
    near(R(t.x, t.z), 13.2, 0.05, 'M3 drop R'); assert.equal(t.y, 0.3); assert.equal(J.steps[3].tol, 0.3); assert.equal(J.steps[3].yawTol, 5);
  }
  { // M4
    const { sim, J } = run('m4');
    assert.equal(sim.wind.mean, 5); assert.equal(sim.wind.gustiness, 0.7);
    const del = J.steps.filter((s) => s.kind === 'deliver');
    assert.equal(del.length, 3);
    del.forEach((s, i) => { near(s.target.x, 50 + 0.5 * i, 1e-9, 'slot x'); assert.equal(s.target.z, -40); assert.equal(s.tol, 0.25); assert.equal(s.yawTol, 4); });
    near(R(50, -40), 28.9, 0.05, 'M4 rack R');
    for (const p of J.steps.filter((s) => s.kind === 'attach').map((s) => s.load)) near(R(p.pos.x, p.pos.z), 18.4, 0.9, 'M4 pick R'); // Phase 2: panels 0.4 m aft, clear of the tractor collider
  }
  { // M6
    const { m, J } = run('m6');
    assert.equal(m.start.mode, 'ROAD'); assert.equal(m.start.cwKg, 11500); assert.equal(m.start.siteTravel, true);
    near(m.start.pos.x, P1.x, 1e-9, 'M6 at P1');
    assert.deepEqual(J.steps[0].require.beams, [0.5, 1, 0.5, 1]);
    const tf = J.steps[3].load;
    near(R(tf.pos.x, tf.pos.z), 11, 0.05, 'M6 pick R');
    const t = J.steps[4].target;
    near(R(t.x, t.z), 13.5, 0.05, 'M6 drop R'); assert.equal(t.y, 0.6); assert.equal(J.steps[4].clearY, 3.5);
  }
});

test('ground zones bound through bindGround()', () => {
  const zones = [];
  bindGround({ addZone: (r, p) => zones.push([r, p]), clearZones: () => { zones.length = 0; } });
  const m = fakeMobile(); const sim = fakeSim(m); const J = new JobRunner(sim);
  J.start(JOBS.find((j) => j.id === 'm6'));
  assert.equal(zones.length, 1); assert.equal(zones[0][1].allowKPa, 100);
  J.stop();
  assert.equal(zones.length, 0);
  bindGround(null);
});

test('tower job path unchanged (lc2 attach → deliver with legacy counters)', () => {
  const tower = {
    id: 'tower', counters: { twoBlockCount: 3, lmiTrips: 1 }, hoistSpeed: 0,
    hoist: { load: null, loadGrounded: true, hook: new THREE.Vector3(), swingAngle: 0 },
    reset(o) { this.o = o; }, signallerGeometry: () => ({ cx: 0, cz: 0, radialOut: 'Trolley out', radialIn: 'Trolley in' }),
  };
  const sim = fakeSim(tower);
  const J = new JobRunner(sim);
  J.start(JOBS.find((j) => j.id === 'lc2'));
  assert.equal(JOBS.find((j) => j.id === 'lc2').machine, 'tower');
  const tw = J.step.load;
  tw.attached = true; tower.hoist.load = tw;
  J.update(1 / 60, { slew: 0, trolley: 0, hoist: 0 }, false);
  assert.equal(J.step.kind, 'deliver');
  tower.counters.lmiTrips = 2;
  tw.pos.set(-14, tw.half.y, 36); tw.attached = false; tower.hoist.load = null;
  J.update(1 / 60, { slew: 0, trolley: 0, hoist: 0 }, false);
  J.onRelease(tw);
  assert.ok(J.done);
  const r = sim.results;
  assert.equal(r.checklist, undefined);
  assert.deepEqual(r.items.map((i) => i.label).slice(0, 7), ['Execution time', 'Max load sway', 'Collisions', 'Rough landings', 'Upper limit (anti two-block) trips', 'LMI cut-outs', 'Horn before first motion']);
  assert.equal(r.items.find((i) => i.label === 'LMI cut-outs').pts, -10);
});

console.log(`\n${n} tests passed`);
