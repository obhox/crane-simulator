#!/usr/bin/env node
// WP0-INT Phase 2: the assembled MobileMachine (src/mobile/mobileMachine.js)
// run headless (canvas stubbed): model + drives + RCL + stability +
// outriggers + ballast + vehicle stepped in the §9.4 order. Checks the
// couplings, not the module internals (those have their own tests):
//   pad start level / set up · power + RCL · slew / luff / telescope / hoist
//   road trim at P1 → SETUP → beams, mats, auto-level → CRANE → release hook
//   M5 trap tips near R 23.8 over the rear; lowering recovers (slam), a short
//   rope overturns · ballast slab absorbed on the deck and raised to 35 t
//   · re-reeving · travel interlock · RCL cut-out KPI only with a load
// Plain node, no framework: exits non-zero on the first failed group.

// ---- canvas / DOM stubs (model decals, cab screen)
const noop = () => {};
const ctx2d = new Proxy({}, {
  get: (t, k) => {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop: noop });
    if (k === 'getImageData' || k === 'createImageData') return (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    return t[k] ?? noop;
  },
  set: (t, k, v) => { t[k] = v; return true; },
});
globalThis.document ??= { createElement: () => ({ width: 1, height: 1, getContext: () => ctx2d, style: {} }) };
globalThis.window ??= globalThis;

const { createCraneMaterials } = await import('../src/crane/model.js');
const { ColliderWorld, Box } = await import('../src/physics/collide.js');
const { Wind } = await import('../src/physics/wind.js');
const { Load } = await import('../src/loads.js');
const { MOBILE_SETTINGS, P1 } = await import('../src/mobile/config.js');
const { MobileMachine } = await import('../src/mobile/mobileMachine.js');
const { makeMobileStart } = await import('../src/machines/machine.js');

const DEG = Math.PI / 180, DT = 1 / 120, G = 9.81;
let fails = 0;
const results = [];
function test(name, fn) {
  try { const r = fn(); results.push(`PASS ${name}${r ? ` — ${r}` : ''}`); }
  catch (e) { fails++; results.push(`FAIL ${name}: ${e.message}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };

const mats = createCraneMaterials();
function setup(start, o = {}) {
  const toasts = [];
  const loads = [];
  const ctx = {
    scene: { add: noop, remove: noop, children: [] }, world: new ColliderWorld(), wind: new Wind(), loads, toasts,
    terrain: { heightAt: () => 0 }, streets: null, site: null,
    audio: { clunk: noop, impact: noop, chime: noop },
    hud: { toast: (t, k) => toasts.push([k, t]), openConfigDialog: noop, openReevingDialog: noop, openBallastPanel: noop },
    settings: { ...MOBILE_SETTINGS, zoneLimiter: true, ...(o.settings || {}) }, craneMats: mats, onImpact: noop, jobs: null,
  };
  ctx.wind.setMean(0); ctx.wind.gustiness = 0;
  // the model / hook block call scene.add + removeFromParent: a real THREE scene is not needed
  ctx.scene = new (globalThis.__THREE.Scene)();
  ctx.spawnLoad = (type, x, z, yaw = 0, baseY = 0) => { const l = new Load(type, x, z, yaw, baseY); ctx.world.add(l.box); loads.push(l); return l; };
  ctx.removeLoad = (l) => { ctx.world.remove(l.box); const i = loads.indexOf(l); if (i >= 0) loads.splice(i, 1); };
  const m = new MobileMachine(ctx);
  for (const b of m.colliders) ctx.world.add(b);
  if (start) m.reset(start);
  const inp = {
    levers: { slew: 0, trolley: 0, hoist: 0, tele: 0, luff: 0 }, drive: { throttle: 0, brake: 0, steer: 0, crawl: false },
    setup: { beam: 0, jack: 0, autoLevel: false, ballast: false }, micro: false, tag: 0, horn: false, timeWarp: false, anyLeverOffNeutral: false,
  };
  const api = { toast: (t, k) => toasts.push([k, t]), input: inp, hud: ctx.hud, settings: ctx.settings };
  const run = (s, until) => { const n = Math.round(s / DT); for (let i = 0; i < n; i++) { m.step(DT, inp); ctx.wind.update(DT); if (until && until()) return i * DT; } return s; };
  const power = (cfg) => { m.handleAction('power', api); if (cfg) { assert(m.rcl.configure(cfg).ok, 'configure'); assert(m.rcl.confirm().ok, 'confirm'); } run(0.2); };
  // operator-like lever control of slew / luff to targets
  const goto = (psi, theta, maxS = 120) => {
    const d = m.drives, wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    for (let i = 0; i < maxS / DT; i++) {
      const ep = psi === null ? 0 : wrap(d.psi - psi), et = theta === null ? 0 : theta - d.theta;
      inp.levers.slew = psi === null || Math.abs(ep) < 0.004 ? 0 : Math.max(-1, Math.min(1, ep * 4 + d.psiDot * 1.5));
      inp.levers.luff = theta === null || Math.abs(et) < 0.002 ? 0 : Math.max(-1, Math.min(1, et * 8));
      m.step(DT, inp); ctx.wind.update(DT);
      if (Math.abs(ep) < 0.004 && Math.abs(et) < 0.002 && Math.abs(d.psiDot) < 1e-3) break;
    }
    inp.levers.slew = inp.levers.luff = 0;
  };
  const hang = (type) => {
    const l = ctx.spawnLoad(type, m.hoist.hook.x, m.hoist.hook.z, 0, 0);
    l.pos.set(m.hoist.hook.x, m.hoist.hook.y - l.hangLength, m.hoist.hook.z); l.sync();
    m.hoist.attach(l);
    return l;
  };
  return { m, ctx, inp, api, run, power, goto, hang, toasts };
}
globalThis.__THREE = await import('three');

// ---------------------------------------------------------------- tests
test('pad start: set up level on P1, floats set, tyres clear, RCL off until power', () => {
  const { m } = setup();
  assert(m.mode === 'CRANE', `mode ${m.mode}`);
  assert(Math.hypot(m.vehicle.pos.x - P1.x, m.vehicle.pos.z - P1.z) < 1e-6, 'not on P1');
  assert(m.outr.floatsSet && m.outr.tyresClear, 'floats / tyres');
  assert(m.stab.tiltDeg < 0.3, `tilt ${m.stab.tiltDeg}`);
  assert(m.stab.state === 'STABLE', m.stab.state);
  const tot = m.stab.floatR.reduce((a, b) => a + b, 0) / G / 1000;
  assert(Math.abs(tot - (46.7 + 35 + 0.25)) < 1.5, `float sum ${tot.toFixed(1)} t`);
  const R = m.R, want = -2 + 22.68 * Math.cos(55 * DEG);
  assert(Math.abs(R - want) < 0.08, `R ${R} vs ${want}`);
  return `floats ${m.stab.floatR.map((x) => (x / G / 1000).toFixed(1)).join('/')} t, R ${R.toFixed(2)} m`;
});

test('power, RCL confirm, slew 2 rpm, luff ≈ 2°/s, telescope pin cycle, hoist', () => {
  const { m, inp, run, power } = setup();
  run(0.5);
  assert(m.rcl.state === 'off', `rcl ${m.rcl.state}`);
  power({ mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' });
  assert(m.rcl.state === 'blue', `rcl ${m.rcl.state}`);
  inp.levers.slew = 1; run(10); const rate = -m.drives.psiDot * 60 / (2 * Math.PI); inp.levers.slew = 0; run(4);
  assert(Math.abs(rate - 2) < 0.05, `slew ${rate} rpm`);
  const th0 = m.drives.theta; inp.levers.luff = -1; run(5); inp.levers.luff = 0; run(1);
  const luff = (th0 - m.drives.theta) / DEG / 5;
  assert(luff > 1.5 && luff < 2.6, `luff ${luff} °/s`);
  inp.levers.hoist = -1; run(4); inp.levers.hoist = 0; run(1);
  const L0 = m.drives.L; inp.levers.tele = 1; const tt = run(60, () => m.drives.boom.k === 4); inp.levers.tele = 0; run(2);
  assert(m.drives.boom.k === 4 && Math.abs(m.drives.L - (L0 + 3.726)) < 0.01, `tele k ${m.drives.boom.k} L ${m.drives.L}`);
  return `slew ${rate.toFixed(2)} rpm, luff ${luff.toFixed(2)} °/s, L ${L0.toFixed(2)} → ${m.drives.L.toFixed(2)} m in ${tt.toFixed(1)} s (stroke + 4 s pin)`;
});

test('road trim at P1 → SETUP → beams 100 %, mats, auto-level → CRANE → release hook', () => {
  const { m, inp, api, run, power, toasts } = setup(makeMobileStart('road', { pos: { x: P1.x, z: P1.z }, yaw: P1.yaw }));
  assert(m.mode === 'ROAD' && m.stowed && m.drives.pinned, 'road trim');
  m.handleAction('toSetup', api); run(0.3);
  assert(m.mode === 'SETUP', 'setup');
  m.handleAction('selectAll', api);
  inp.setup.beam = 1; run(13); inp.setup.beam = 0; run(0.2);
  assert(m.outr.beams.every((b) => b.detent === 1), 'beams 100 %');
  m.handleAction('mat', api); run(4.5);
  inp.setup.autoLevel = true; const tl = run(30, () => m.outr.levelState === 'done'); inp.setup.autoLevel = false; run(1);
  assert(m.outr.floatsSet && m.outr.tyresClear && m.stab.tiltDeg < 0.3, 'levelled');
  // travel interlock: cannot go back to ROAD with the beams out
  m.handleAction('toRoad', api);
  assert(m.mode === 'SETUP' && /TRAVEL INTERLOCK/.test(toasts.at(-1)[1]), 'travel interlock');
  m.handleAction('toCrane', api);
  power({ mode: 'outriggers', base: 100, cwKg: 0, block: 'ball' });
  assert(m.rcl.warnings.size === 0, `warnings ${[...m.rcl.warnings]}`);
  m.handleAction('hook', api); run(5);
  assert(!m.stowed && m.hoist.hook.distanceTo(m.hoist.sheave) > 2.5, 'hook released');
  return `auto-level ${tl.toFixed(1)} s, tilt ${m.stab.tiltDeg.toFixed(3)}°, jacks ${m.outr.jacks.map((j) => j.e.toFixed(2)).join('/')} m`;
});

// M5: 11.5 t fitted, RCL told 35 t (wrong), 30.1 m boom, 6.25 t gross luffed out over the rear
function m5(rope) {
  const s = setup(makeMobileStart('pad', { cwKg: 11500, rcl: { mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' }, boomK: 5, luffDeg: 60, slewDeg: 180, ropeLen: rope }));
  s.power({ mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' });
  s.hang('steelBundle'); s.run(4);
  s.inp.levers.luff = -0.3;
  let tipR = null;
  for (let i = 0; i < 120 * 90 && !tipR; i++) { s.m.step(DT, s.inp); s.ctx.wind.update(DT); if (s.m.mode === 'TIPPING') tipR = s.m.R; }
  s.inp.levers.luff = 0;
  return { ...s, tipR };
}
test('M5 trap: wrong RCL config stays green, the crane tips near R 23.8 over the rear; a short rope overturns', () => {
  const { m, run, tipR } = m5(4);
  assert(tipR && Math.abs(tipR - 23.8) < 0.5, `tip at R ${tipR}`);
  const shown = m.rcl.ratio;
  assert(m.rcl.state !== 'stop' && shown < 0.8, `RCL ${m.rcl.state} ${shown}`);
  run(12);
  assert(m.mode === 'OVERTURNED' && m.kpi.overturned, `mode ${m.mode}`);
  return `TIPPING at R ${tipR.toFixed(2)} m (RCL showed ${(shown * 100).toFixed(0)} % on its wrong 35 t chart), overturned`;
});
test('M5 trap with a long rope: the load lands, lowering recovers with a slam', () => {
  const { m, inp, run, tipR } = m5(14);
  assert(tipR && Math.abs(tipR - 23.8) < 0.5, `tip at R ${tipR}`);
  run(6);
  assert(m.mode === 'TIPPING', `leaning on its landed load: ${m.mode}`);
  inp.levers.hoist = -0.5; run(10); inp.levers.hoist = 0; run(2);
  assert(m.mode === 'CRANE' && m.stab.state === 'STABLE' && m.kpi.slams === 1, `mode ${m.mode} ${m.stab.state} slams ${m.kpi.slams}`);
  return `tip at R ${tipR.toFixed(2)} m, recovered, slams ${m.kpi.slams}`;
});

test('ballast: slab C landed on the deck is absorbed; pinned + hold B raises 23.5 → 35 t', () => {
  const s = setup(makeMobileStart('pad', { cwKg: 23500, rcl: { mode: 'outriggers', base: 100, cwKg: 23500, block: 'hb26' }, block: 'hb26', boomK: 0, luffDeg: 63, slewDeg: 180, ropeLen: 4 }));
  const { m, inp, api, run, power, goto, hang } = s;
  power({ mode: 'outriggers', base: 100, cwKg: 23500, block: 'hb26' });
  run(1);
  goto(Math.PI, Math.acos((3.18 + 2) / m.drives.L)); run(3);
  const slab = hang('cwC');
  slab.yaw = m.vehicle.yaw + Math.PI / 2;
  for (let k = 0; k < 30; k++) { run(0.5); m.hoist.loadVel.multiplyScalar(0.3); m.hoist.hookVel.multiplyScalar(0.3); slab.yaw = m.vehicle.yaw + Math.PI / 2; slab.yawVel = 0; }
  inp.levers.hoist = -0.3; run(30, () => m.hoist.loadGrounded); run(2, () => m.hoist.slingTension < slab.mass * G * 0.1); inp.levers.hoist = 0; run(0.3);
  const bottom = slab.pos.y - slab.half.y, deckTop = m.stab.pose.z0 - 1.3 + 1.85;
  assert(Math.abs(bottom - deckTop) < 0.05, `slab rests at ${bottom.toFixed(3)} (deck ${deckTop.toFixed(3)})`);
  const l = m.hoist.detach();
  assert(m.onRelease(l), `not absorbed: ${m.ballast.lastReason}`);
  assert(m.ballast.deckStack.length === 1 && !s.ctx.loads.includes(l), 'deck stack');
  inp.levers.hoist = 0.5; run(2); inp.levers.hoist = 0;
  goto(0, null); run(2);
  m.handleAction('pin', api);
  assert(m.drives.pinned, 'pinned');
  m.handleAction('toSetup', api);
  inp.setup.ballast = true; run(47); inp.setup.ballast = false; run(0.2);
  assert(m.ballast.superKg === 35000, `super ${m.ballast.superKg}`);
  assert(m.stab.state === 'STABLE', m.stab.state);
  return `slab bottom ${bottom.toFixed(3)} m on the deck, superstructure CW ${m.ballast.superKg / 1000} t`;
});

test('re-reeving: grounded ball → hb60 after 90 s, RCL asks for confirmation', () => {
  const { m, inp, run, power } = setup(makeMobileStart('pad', { cwKg: 35000, rcl: { mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' }, luffDeg: 60 }));
  power({ mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' });
  inp.levers.hoist = -1; run(20, () => m.hoist.hookGrounded); inp.levers.hoist = -0.2; run(1); inp.levers.hoist = 0; run(1);
  assert(m.hoist.hookGrounded, 'hook grounded');
  assert(m.startReeve('hb60').ok, 'start');
  run(89);
  assert(m.block === 'ball' && m.reeving, 'still reeving');
  run(2);
  assert(m.block === 'hb60' && m.hoist.falls === 7 && m.drives.falls === 7 && m.hoist.hookMass === 500, 'reeved');
  assert(!m.rcl.config.confirmed && m.rcl.warnings.has('RECONFIRM'), 'reconfirm');
  return 'hb60, 7 falls';
});

test('RCL cut-out KPI counts overload STOPs with a load, not the empty-hook range STOP on the boom rest', () => {
  const { m, api, run, power } = setup(makeMobileStart('road', { pos: { x: P1.x, z: P1.z }, yaw: P1.yaw }));
  m.handleAction('toSetup', api); m.handleAction('toCrane', api);
  power({ mode: 'outriggers', base: 100, cwKg: 0, block: 'ball' });
  run(1);
  assert(m.rcl.state === 'stop' && m.counters.lmiTrips === 0, `${m.rcl.state} trips ${m.counters.lmiTrips}`);
  return 'range STOP at R 9.5 m, 0 trips';
});

test('hudState / audioState: fields the HUD and the jobs read', () => {
  const { m, run, power } = setup();
  power({ mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball' });
  run(0.5);
  const hs = m.hudState(), mb = hs.mobile;
  for (const k of ['mode', 'pos', 'road', 'setup', 'ballast', 'rcl', 'boom', 'wind', 'hoist', 'chart', 'zone', 'tilt', 'beams', 'beamDetents', 'mats', 'cwKg', 'deckSlabs', 'block', 'boomLen', 'pinned', 'warnings', 'settlement']) assert(mb[k] !== undefined, `mobile.${k}`);
  assert(mb.chart.cells.length > 5, 'chart column');
  assert(mb.rcl.code === 'OR B100 CW35.0 n1 BALL', mb.rcl.code);
  const au = m.audioState('cab', { active: true });
  assert(au.engine.which === 'both' && Array.isArray(au.events), 'audio');
  return `${Object.keys(mb).length} mobile HUD fields, chart ${mb.chart.key}`;
});

for (const r of results) console.log(r);
if (fails) { console.log(`\n${fails} failed`); process.exit(1); }
