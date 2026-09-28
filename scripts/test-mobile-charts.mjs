// WP-PHYS: load charts (spec §2) and boom geometry / telescope (§3.1, §3.3, §3.4).
// Plain node: `node scripts/test-mobile-charts.mjs`.
import assert from 'node:assert/strict';
import * as C from '../src/mobile/charts.js';
import * as B from '../src/mobile/boom.js';
import { AT100, PINNED_LENGTHS, RMIN, HOOK_BLOCKS } from '../src/mobile/config.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const DEG = Math.PI / 180;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };
const cell = (table, L, R) => table.find((r) => r[0] === R)[1][C.LENGTHS.indexOf(L)];
const OR = (base, cwKg, block = 'hb90') => ({ mode: 'outriggers', base, cwKg, block, confirmed: true });

// ------------------------------------------------------------------ charts
test('LENGTHS = config PINNED_LENGTHS; STAB = config bodies (§1.3)', () => {
  assert.deepEqual(C.LENGTHS, [...PINNED_LENGTHS]);
  const b = AT100.bodies, S = C.STAB;
  near(S.carrier.m * 1000, b.carrier.m, 1e-6, 'carrier m'); near(S.carrier.x, b.carrier.x, 0, 'carrier x');
  near(S.upper.m * 1000, b.upper.m, 1e-6, 'upper m'); near(S.upper.u, b.upper.u, 0, 'upper u');
  near(S.luffCyl.m * 1000, b.luffCyl.m, 1e-6, 'luff cyl'); near(S.cw.u, b.cw.u, 0, 'cw u'); near(S.cw.z, b.cw.z, 0, 'cw z');
  near(S.pivot.u, AT100.pivot.u, 0, 'pivot u'); near(S.pivot.z, AT100.pivot.z, 0, 'pivot z');
  near(S.boom.secMass[0] * 1000, b.boomSection.m, 1e-6, 'section m'); near(S.boom.headMass * 1000, b.head.m, 1e-6, 'head m');
});

test('buildChart reproduces every §2.1 literal cell for cell (§2.2)', () => {
  const cases = [['B100_CW35000', 35000, 3.5], ['B100_CW11500', 11500, 3.5], ['B50_CW35000', 35000, 2.5], ['B50_CW11500', 11500, 2.5], ['B0_CW0', 0, 1.25]];
  let cells = 0;
  for (const [key, cw, hw] of cases) {
    const lit = C[key], gen = C.buildChart(C.STRUCT, cw, hw);
    for (const [R, row] of gen) {
      const lr = lit.find((r) => r[0] === R);
      row.forEach((v, i) => { cells++; assert.equal(lr ? lr[1][i] : null, v, `${key} L ${C.LENGTHS[i]} R ${R}`); });
    }
  }
  assert.deepEqual(C.buildTyresChart(0), C.TYRES_CW0, 'TYRES_CW0 (tyre rectangle ±1.18 × axles 1–5, 1.33P + 0.1F, 4.5°)');
  assert.ok(cells >= 1680);
});

test('generated charts: §2.1 spot values and job design numbers (§8.4)', () => {
  assert.equal(cell(C.B100_CW23500, 22.7, 14), 18600);
  assert.equal(cell(C.B100_CW23500, 45.0, 36), 3200);
  assert.equal(cell(C.B100_CW23500, 33.9, 28), 5600);
  // The spec lists "30.1@24 = 7500" but its own verified generator gives 7200 there; 7500 is the
  // 33.9 m cell at R 24 (the generator is authoritative: it reproduces all 1,440 literal cells).
  assert.equal(cell(C.B100_CW23500, 30.1, 24), 7200);
  assert.equal(cell(C.B100_CW23500, 33.9, 24), 7500);
  assert.equal(cell(C.B100_CW0, 22.7, 12), 11300);
  assert.equal(cell(C.B100_CW0, 11.5, 8), 21800);
  assert.equal(cell(C.B100_CW0, 52.0, 16), 4500);
  // M2: 45 m @ 36 m → 4.8 t with 35 t CW, 3.2 t with 23.5 t
  near(C.chartCapacity(OR(100, 35000), 45.0, 36, 9), 4800, 0.5, 'M2 35 t');
  near(C.chartCapacity(OR(100, 23500), 45.0, 36, 9), 3200, 0.5, 'M2 23.5 t');
  // M3: 22.7 m @ 15.6 m → 11.4 t with 11.5 t CW; M4: 33.9 m @ 28.9 → 5.3 t; M6: B50 11.5 t 22.7 @ 13.5 → 10.3 t
  near(C.chartCapacity(OR(100, 11500), 22.7, 15.6, 3), 11420, 0.5, 'M3 11.5 t');
  near(C.chartCapacity(OR(100, 23500), 33.9, 28.9, 6), 5285, 0.5, 'M4');
  near(C.chartCapacity(OR(50, 11500), 22.7, 13.5, 3), 10300, 0.5, 'M6');
  // M5 trap: the wrong 35 t config reads 9.7 t at 30.1 m / R 24
  assert.equal(C.chartCapacity(OR(100, 35000), 30.1, 24, 5), 9700);
});

test('chartKey and CHARTS (§2.3.1)', () => {
  assert.equal(C.chartKey(OR(100, 35000)), 'B100_CW35000');
  assert.equal(C.chartKey({ mode: 'tyres', base: 0, cwKg: 0, block: 'ball' }), 'TYRES_CW0');
  for (const b of [100, 50]) for (const cw of [0, 11500, 23500, 35000]) assert.ok(C.CHARTS[`B${b}_CW${cw}`], `B${b}_CW${cw}`);
  assert.ok(C.CHARTS.B0_CW0 && C.CHARTS.TYRES_CW0);
  assert.equal(C.CHARTS.B0_CW11500, undefined);
});

test('permitted() reproduces the §2.3.2 table from the body model', () => {
  const share = { 100: [41.4, 32.2, 25.8, 21.4], 50: [40.2, 29.5, 22.2, 17.1] };
  for (const base of [100, 50]) [0, 11500, 23500, 35000].forEach((cw, i) => {
    const p = C.permitted(OR(base, cw, 'ball'));
    assert.ok(p.ok, `B${base} CW${cw}`);
    near(p.share * 100, share[base][i], 0.05, `share B${base} CW${cw}`);
  });
  const b0 = C.permitted(OR(0, 0, 'ball'));
  assert.ok(b0.ok); near(b0.share * 100, 30.3, 0.05, 'share B0 CW0');
  const b0a = C.permitted(OR(0, 11500, 'ball'));
  assert.ok(!b0a.ok); near(b0a.share * 100, 9.1, 0.05, 'share B0 CW11.5');
  for (const cw of [23500, 35000]) { const p = C.permitted(OR(0, cw, 'ball')); assert.ok(!p.ok && /tips backward/.test(p.reason), `B0 CW${cw}: ${p.reason}`); }
  const t0 = C.permitted({ mode: 'tyres', base: 0, cwKg: 0, block: 'ball' });
  assert.ok(t0.ok); near(t0.tipDeg, 10.6, 0.05, 'tyres 0 t tipping angle');
  const t1 = C.permitted({ mode: 'tyres', base: 0, cwKg: 11500, block: 'ball' });
  assert.ok(!t1.ok); near(t1.tipDeg, 2.6, 0.05, 'tyres 11.5 t tipping angle');
  assert.ok(!C.permitted(OR(100, 20000)).ok, 'CW must match a chart exactly');
  assert.ok(!C.permitted(OR(75, 35000)).ok, 'unknown base');
});

test('capacity(): radius interpolation, Rmin / Rmax, block cap (§2.3.4–5)', () => {
  const cfg = OR(100, 35000);
  // linear between valued rows: 22.7 m, R 13 → between 25,600 (12) and 21,000 (14)
  near(C.capacity(cfg, 22.7, 13, 3), 23300, 1e-6, 'interp');
  near(C.capacity(cfg, 22.7, 3.0, 3), 60600, 1e-6, 'R < Rmin → first value');
  assert.equal(C.capacity(cfg, 22.7, 20.01, 3), 0, 'R > Rmax → 0');
  assert.equal(C.capacity(cfg, 22.7, 20, 3), 12800);
  assert.equal(C.capacity({ ...cfg, block: 'ball' }, 22.7, 10, 3), HOOK_BLOCKS.ball.ratedKg, 'ball caps at 8.8 t');
  assert.equal(C.capacity({ ...cfg, block: 'hb26' }, 22.7, 8, 3), 26100, 'hb26 caps at 26.1 t');
  assert.equal(C.capacity(OR(0, 11500), 11.5, 5, 0), 0, 'non-permitted config → 0');
  // tyres: only L ≤ 19.0 m
  const ty = { mode: 'tyres', base: 0, cwKg: 0, block: 'hb26' };
  assert.equal(C.capacity(ty, 15.2, 5, 1), 8100);
  assert.equal(C.capacity(ty, 22.7, 5, 3), 0);
  // rminFor / rmaxFor
  PINNED_LENGTHS.forEach((L, k) => assert.equal(C.rminFor(L), RMIN[k], `Rmin ${L}`));
  assert.equal(C.rminFor(C.PIN_GEOM[3]), 4, 'geometric pinned length 22.678 → k 3');
  assert.equal(C.rmaxFor(cfg, 22.7), 20);
  assert.equal(C.rmaxFor(cfg, 52.0), 50);
  assert.equal(C.rmaxFor(OR(0, 0), 52.0), 0, 'B0_CW0 has no 52 m column');
  assert.equal(C.rmaxFor(OR(100, 11500), 45.0), 42);
});

test('capacity() between pins: min(col lo, col hi, T_tel) (§2.3.3)', () => {
  const cfg = OR(100, 35000);
  const L = 24.0; // between 22.7 (k 3) and 26.4 (k 4)
  assert.deepEqual(C.columnFor(L), { lo: 3, hi: 4, exact: false });
  assert.deepEqual(C.columnFor(22.678), { lo: 3, hi: 3, exact: true });
  assert.deepEqual(C.columnFor(50.0), { lo: 10, hi: 11, exact: false });
  // R 6: col 3 = 52.5 t, col 4 = 46.0 t, T_tel(24) = 8 t
  assert.equal(C.capacity(cfg, L, 6, null), 8000);
  // R 20: col 3 12.8, col 4 12.5 → 12.5 > 8 → 8
  assert.equal(C.chartCapacity(cfg, L, 20, null), 8000);
  // R 22: col 3 has no value (0), col 4 10.9 → 0 (outside the lower column)
  assert.equal(C.capacity(cfg, L, 22, null), 0);
  const lk = C.lookup(cfg, L, 6, null);
  assert.equal(lk.governedBy, 'tele'); assert.equal(lk.pinned, false);
  const lk2 = C.lookup(OR(100, 11500), 30.1, 20, 5);
  assert.equal(lk2.governedBy, 'chart'); assert.ok(lk2.stability, '30.1 @ 20 with 11.5 t is stability-governed');
  const lk3 = C.lookup(OR(100, 35000), 22.7, 5, 3);
  assert.ok(!lk3.stability, 'short radius 35 t is structural');
  assert.equal(C.lookup({ ...cfg, block: 'ball' }, 22.7, 10, 3).governedBy, 'block');
});

test('telescopable load, permissible wind, slew recommendation (§2.3.8–9, §3.2)', () => {
  assert.equal(C.telescopableLoad(22.7), 12000); assert.equal(C.telescopableLoad(30.1), 8000);
  assert.equal(C.telescopableLoad(45.0), 5000); assert.equal(C.telescopableLoad(48.8), 3000);
  assert.equal(C.windPerm(11.5), 14.3); assert.equal(C.windPerm(37.6), 12.8); assert.equal(C.windPerm(45), 11.1); assert.equal(C.windPerm(52), 9.0);
  // [S16] large-area load: hvac 3 t, face 4.2 × 2.2 m → ≈ 9 m/s at short booms
  near(C.windPermLoad(22.7, 3000, 4.2 * 2.2), 8.93, 0.01, 'hvac');
  assert.equal(C.windPermLoad(22.7, 20000, 2), 14.3, 'dense load keeps v_perm');
  assert.equal(C.slewRecRpm(11.5), 0.8); assert.equal(C.slewRecRpm(22.7), 0.5); assert.equal(C.slewRecRpm(52), 0.3);
  assert.equal(C.chartColumn(OR(100, 35000), 11).length, 21);
});

// ------------------------------------------------------------------- boom
test('luff cylinder geometry and rates (§3.3)', () => {
  near(B.cylLen(0), 2.287, 0.001, 'c(0)');
  near(B.cylLen(82 * DEG), 7.510, 0.001, 'c(82)');
  near(B.luffRate(0, 0.132) / DEG, 2.4, 0.1, 'θ̇ at 0°');
  near(B.luffRate(20 * DEG, 0.132) / DEG, 1.9, 0.05, 'θ̇ at 20°');
  near(B.luffRate(45 * DEG, 0.132) / DEG, 1.95, 0.08, 'θ̇ at 45°');
  near(B.luffRate(82 * DEG, 0.132) / DEG, 2.6, 0.05, 'θ̇ at 82°');
  let th = 0, t = 0;
  while (th < 82 * DEG) { th += B.luffRate(th, 0.132) / 120; t += 1 / 120; }
  near(t, 40, 1, '0 → 82° unloaded');
});

test('head position and radius helpers (§3.1)', () => {
  const h = B.headLocal(22.7, 0, 0, 0, 0);
  near(h.u, 20.7, 1e-9, 'u at 0°'); near(h.z, 3.71, 1e-9, 'z at 0°');
  const th = B.thetaForRadius(52, 30);
  near(B.radiusFor(52, th), 30, 1e-9, 'inverse');
  const d = B.headLocal(52, th, 1.0, 0.2, 0.1);
  near(d.u - B.headLocal(52, th).u, Math.sin(th), 1e-9, 'δv moves the head out by δv·sinθ');
  near(d.z, 3.71 + 52 * Math.sin(th) - Math.cos(th) + 0.1, 1e-9, 'z with δv and lift');
  assert.equal(d.y, 0.2);
  const s = B.boomSamples(22.7, 0.5, 0, 0, 0);
  assert.equal(s.length, 24); near(s[0].r, 0.55, 1e-9, 'pivot radius'); near(s[23].r, 0.35, 1e-9, 'head radius');
  near(s[23].u, B.headLocal(22.7, 0.5).u, 1e-9, 'last sample = head');
});

test('TeleBoom: sequence, pinned lengths, pin events and timing (§3.4)', () => {
  assert.equal(B.SEQ.length, 15);
  assert.deepEqual(B.SEQ.slice(0, 5).map((s) => s.section), [4, 3, 2, 1, 0], '46 % T5..T1 first');
  for (let k = 0; k <= 11; k++) {
    const b = new B.TeleBoom(k);
    near(b.length, k < 11 ? 11.5 + 3.726 * k : 52.0, 1e-9, `k ${k} length`);
    near(b.length, PINNED_LENGTHS[k], 0.05, `k ${k} chart label`);
    assert.equal(b.k, k);
    // same section extensions as the chart generator's sectionExt
    C.sectionExt(b.length).forEach((e, i) => near(b.ext[i], e, 1e-9, `k ${k} ext ${i}`));
  }
  // one step out: unpinned while moving, 4 s pin with L frozen, then k + 1
  const b = new B.TeleBoom(3), dt = 1 / 120;
  let t = 0;
  b.update(dt, 1); assert.equal(b.phase, 'moving'); assert.equal(b.k, null); assert.equal(b.activeSection, 1, 'T2 is next at 46 %');
  while (b.phase === 'moving') { b.update(dt, 1); t += dt; }
  near(t, 3.726 / 0.13, 0.4, 'stroke time 3.726 m at 0.13 m/s');
  const Lp = b.length;
  for (let i = 0; i < 120 * 2; i++) b.update(dt, 0); // released during pinning: the pin still completes
  assert.equal(b.phase, 'pinning'); assert.equal(b.length, Lp, 'L frozen while pinning');
  for (let i = 0; i < 120 * 2.1; i++) b.update(dt, 0);
  assert.equal(b.phase, 'pinned'); assert.equal(b.k, 4);
  // mid-stroke release: held by the cylinder (unpinned), then reverse back to the old pin
  const c = new B.TeleBoom(5);
  for (let i = 0; i < 240; i++) c.update(dt, 1);
  for (let i = 0; i < 120; i++) c.update(dt, 0);
  assert.equal(c.phase, 'moving'); assert.equal(c.k, null);
  const held = c.length;
  for (let i = 0; i < 60; i++) c.update(dt, 0);
  assert.equal(c.length, held, 'held by the cylinder');
  while (c.phase === 'moving') c.update(dt, -1);
  assert.equal(c.phase, 'pinning');
  while (c.phase === 'pinning') c.update(dt, 0);
  assert.equal(c.k, 5); near(c.length, 30.13, 1e-9, 'back at 30.13 m');
  // perms: teleOut 0 blocks extension, teleIn still retracts
  const d = new B.TeleBoom(2);
  d.update(dt, 1, { teleOut: 0, teleIn: 1 }); assert.equal(d.phase, 'pinned');
  d.update(dt, -1, { teleOut: 0, teleIn: 1 }); assert.equal(d.phase, 'moving');
  // full extension: 40.5 m at 0.13 m/s plus 15 pin events of 4 s (+ ramps)
  const e = new B.TeleBoom(0);
  t = 0;
  while (!e.atMax && t < 1000) { e.update(dt, 1); t += dt; }
  near(t, 40.5 / 0.13 + 15 * 4, 3, '11.5 → 52 m');
  assert.equal(e.k, 11); near(e.length, 52, 1e-9, 'full');
  // uncharted pinned position between k 10 and 11 → k null
  const f = new B.TeleBoom(10);
  while (f.seqPos < 11) f.update(dt, 1);
  assert.equal(f.phase, 'pinned'); assert.equal(f.k, null, '100/92/92/92/92 is pinned but not charted');
});

test('boomContact against collider boxes (§3.7)', () => {
  const box = { cx: 10, cy: 5, cz: 0, hx: 1, hy: 5, hz: 1, c: 1, s: 0, enabled: true, tag: 'wall' };
  const world = { boxes: [box] };
  assert.equal(B.boomContact(world, [{ x: 11.4, y: 3, z: 0, r: 0.5 }]).tag, 'wall');
  assert.equal(B.boomContact(world, [{ x: 11.6, y: 3, z: 0, r: 0.5 }]), null);
  assert.equal(B.boomContact(world, [{ x: 10, y: 10.4, z: 0, r: 0.5 }]).tag, 'wall', 'y range inflated by r');
  assert.equal(B.boomContact(world, [{ x: 10, y: 3, z: 0, r: 0.5 }], new Set([box])), null, 'ignored');
});

console.log(`${n} tests passed`);
