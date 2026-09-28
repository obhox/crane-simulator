// AT-100 5.1 mobile-crane jobs M1–M6 (spec §8.4) and the pure logic the
// JobRunner (src/jobs.js) uses for them: reading the machine state, the setup
// checklist, RCL-config classification and the §8.5 KPI rules. No three.js
// here, so it runs in plain node (scripts/test-mobile-jobs.mjs).
//
// What the JobRunner reads from the mobile machine (preferred names first;
// the fallbacks cover the Phase-1 module instances and the Phase-0 stub):
//   hudState().mobile = {
//     mode 'ROAD'|'SETUP'|'CRANE'|'TIPPING'|'OVERTURNED', pos {x,z} (slew axis), yaw,
//     speedKmh (or v m/s), parkingBrake,
//     beams [4] (0|0.5|1 detent fractions, or {ext, detent}), beamDetents? [4] (0|50|100|null),
//     floatsSet, tyresClear, mats [4] ('none'|'carried'|'composite'), tilt {pitch, roll} in DEGREES (or levelDeg),
//     cwKg (on the superstructure), deckSlabs ['A'…], ballast {progress 0..1}?,
//     block, reeving (bool or {progress}), boomLen, pinned,
//     rcl {config {mode, base, cwKg, block, confirmed}, state, warnings []},
//     warnings ['support'|'tilt'|'wind'|'tyres'|'floatLight'] (array, Set or {name:bool}),
//     stability {state, margin}, settlement [4] (m) }
//   machine.kpi = monotonic counters (§8.5), see mobileCounters().
//   hudState() common fields used: slewRpm, ratio, lmiState.

import { P1, SLEW_REC_RPM, SPEED_LIMITS, tableLookup } from './config.js';
import { makeMobileStart } from '../machines/machine.js';

const FLOAT_NAMES = ['FL', 'FR', 'RL', 'RR'];
const SITE_FENCE = { minX: -62, maxX: 66, minZ: -58, maxZ: 66 };

// ------------------------------------------------------------ KPI rules (§8.5)
export const MOBILE_KPI = {
  drive: { collision: 10, scrape: 2, scrapeMax: 10, kerb: 3, kerbHard: 8, speedPerS: 1, speedMax: 15 },
  setup: { beamOffDetent: 10, missingMat: 5, level1: 5, level2: 15, levelOk: 0.3, levelWarn: 0.57, tyres: 10, floats: 10, conservative: 5, unconservative: 30, reeving: 10, mismatch: 10, mismatchS: 5 },
  op: { slewPer2s: 1, slewMax: 10, slewLoadRatio: 0.25, sidePull: 5, sidePullMax: 15, boomContact: 15, floatLight: 5, floatLightMax: 15, liftoff: 15, slam: 25, settle1: 0.02, settle1Pts: 5, settle2: 0.05, settle2Pts: 15, bypass: 30, warnInfoS: 30 },
  critical: { punchThrough: 0.3 },
};

// ------------------------------------------------------------ state adapter
const num = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const first = (...a) => { for (const v of a) if (v !== undefined && v !== null) return v; return undefined; };

// beam value → detent percent (100|50|0) or null when between detents.
// Accepts detent fractions (0/0.5/1 as in MobileStart), travel fractions
// (1.25 + 2.25·ext: 50 % at ext 0.556) and float |y| in metres (1.25/2.5/3.5).
export function detentOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v > 1.05) { // metres
    for (const [p, y] of [[0, 1.25], [50, 2.5], [100, 3.5]]) if (Math.abs(v - y) <= 0.03) return p;
    return null;
  }
  for (const [p, e] of [[0, 0], [50, 0.5], [100, 1], [50, 1.25 / 2.25]]) if (Math.abs(v - e) <= 0.012) return p;
  return null;
}

function beamDetent(b, explicit) {
  if (typeof explicit === 'number') return explicit <= 1.001 ? Math.round(explicit * 100) : explicit;
  if (explicit === null || explicit === false) return null;
  if (typeof b === 'number') return detentOf(b);
  if (b && typeof b === 'object') {
    if (typeof b.detent === 'number') return b.detent <= 1.001 ? Math.round(b.detent * 100) : b.detent;
    if ('detent' in b && b.detent !== true && b.detent !== undefined) return null;
    return detentOf(first(b.ext, b.pct !== undefined ? b.pct / 100 : undefined, b.y));
  }
  return null;
}

const WARN_ALIAS = {
  support: 'support', supportmismatch: 'support', 'support≠config': 'support', mismatch: 'support', supportconfig: 'support',
  tilt: 'tilt', level: 'tilt', wind: 'wind', tyres: 'tyres', tyresnotclear: 'tyres', floatlight: 'floatLight', float_light: 'floatLight', outriggerlight: 'floatLight',
};
function addWarnings(set, w) {
  if (!w) return;
  const add = (k) => { const a = WARN_ALIAS[String(k).toLowerCase().replace(/[\s_-]/g, '')] || WARN_ALIAS[String(k).toLowerCase()]; if (a) set.add(a); };
  if (w instanceof Set || Array.isArray(w)) for (const k of w) add(typeof k === 'object' ? k.id || k.kind || k.type : k);
  else if (typeof w === 'object') for (const [k, on] of Object.entries(w)) if (on) add(k);
}

function matId(m) {
  if (!m) return 'none';
  if (typeof m === 'string') return m;
  return m.id || m.kind || m.type || (m.placed ? 'carried' : 'none');
}

/**
 * Normalised view of the mobile machine for the jobs (one hudState() call).
 * @returns {object} see the file header; null fields = not reported by the machine
 */
export function readMobile(machine) {
  const hs = machine.hudState ? machine.hudState() : {};
  const hm = hs.mobile || {};
  const veh = machine.vehicle || {};
  const out = machine.outriggers || {};
  const rclObj = machine.rcl || {};
  const stab = machine.stability || {};
  const bal = machine.ballast || {};

  const pos = first(hm.pos, machine.pos, veh.pos) || { x: 0, z: 0 };
  const yaw = num(first(hm.yaw, machine.yaw, veh.yaw), 0);
  const speedKmh = num(hm.speedKmh, null) ?? (num(first(hm.v, veh.v), 0) * 3.6);
  const parkingBrake = first(hm.parkingBrake, veh.parkingBrake, true) !== false;

  const beamsRaw = first(hm.beams, out.beams, machine.beams) || [];
  const expl = hm.beamDetents || [];
  const beams = [], detents = [];
  for (let i = 0; i < 4; i++) {
    const b = beamsRaw[i];
    beams.push(typeof b === 'number' ? b : num(b?.ext, null));
    detents.push(beamDetent(b, expl[i]));
  }
  const mats = (first(hm.mats, out.mats) || []).slice(0, 4).map(matId);
  while (mats.length < 4) mats.push('none');
  const floatsSet = !!first(hm.floatsSet, out.floatsSet, machine.jacksSet, hm.jacksSet);
  const tyresClear = !!first(hm.tyresClear, out.tyresClear, floatsSet);

  let levelDeg = num(hm.levelDeg, null), tilt = null;
  if (hm.tilt && typeof hm.tilt === 'object') tilt = { pitch: num(hm.tilt.pitch, 0), roll: num(hm.tilt.roll, 0) };
  else if (hm.tiltDeg && typeof hm.tiltDeg === 'object') tilt = { pitch: num(hm.tiltDeg.pitch, 0), roll: num(hm.tiltDeg.roll, 0) };
  else if (stab.tilt && typeof stab.tilt === 'object') tilt = { pitch: num(stab.tilt.pitch, 0) * 180 / Math.PI, roll: num(stab.tilt.roll, 0) * 180 / Math.PI };
  if (levelDeg === null && tilt) levelDeg = Math.max(Math.abs(tilt.pitch), Math.abs(tilt.roll));

  const cwKg = num(first(hm.cwKg, bal.superKg, machine.cwKg), 0);
  const deckRaw = first(hm.deckSlabs, bal.deckStack) || [];
  const deckSlabs = deckRaw.map((d) => (typeof d === 'string' ? d : d?.def?.slab || d?.slab || d?.id || String(d?.type || '').replace(/^cw/, '')));
  const ballastProgress = num(first(hm.ballast?.progress, hm.ballastProgress, bal.progress), null);

  const block = first(hm.block, machine.block) || 'ball';
  const reevingRaw = first(hm.reeving, machine.reeving);
  const reeving = !!(reevingRaw && (typeof reevingRaw !== 'object' || reevingRaw.active !== false));
  const reeveProgress = num(reevingRaw && typeof reevingRaw === 'object' ? reevingRaw.progress : null, null);

  const rclHud = hm.rcl && typeof hm.rcl === 'object' ? hm.rcl : {};
  let cfg = first(rclHud.config, hm.rclConfig, rclObj.config);
  if (!cfg && rclHud.mode) cfg = rclHud;
  const rcl = cfg ? {
    mode: cfg.mode || 'outriggers', base: num(cfg.base, 100), cwKg: num(cfg.cwKg, 0), block: cfg.block || 'ball',
    confirmed: !!first(cfg.confirmed, rclHud.confirmed, rclObj.confirmed),
  } : null;
  const rclState = first(rclHud.state, typeof hm.rcl === 'string' ? hm.rcl : undefined, rclObj.state, hs.lmiState) || 'ok';

  const warnings = new Set();
  addWarnings(warnings, hm.warnings);
  addWarnings(warnings, rclHud.warnings);
  addWarnings(warnings, rclObj.warnings);

  const boomLen = num(first(hm.boomLen, hm.L, machine.boom?.length, machine.boomLen), 0);
  const pinned = first(hm.pinned, hm.telePhase ? hm.telePhase === 'pinned' : undefined, machine.boom?.phase ? machine.boom.phase === 'pinned' : undefined, true) !== false;
  const mode = first(hm.mode, machine.mode) || 'CRANE';
  const stabilityState = first(hm.stability?.state, hm.stabilityState, stab.state) || null;
  const settleRaw = first(hm.settlement, Array.isArray(hm.floats) ? hm.floats.map((f) => f?.settlement) : undefined, machine.settlement?.s) || [];
  const settlement = [0, 1, 2, 3].map((i) => num(settleRaw[i], 0));

  return {
    hs, hm, mode, pos: { x: pos.x, z: pos.z }, yaw, speedKmh, parkingBrake,
    beams, detents, mats, floatsSet, tyresClear, tilt, levelDeg,
    cwKg, deckSlabs, ballastProgress, block, reeving, reeveProgress,
    rcl, rclState, warnings, boomLen, pinned, stabilityState, settlement,
    frameLift: num(hm.frameLift, 0.1),
    slewRpm: num(hs.slewRpm, 0), ratio: num(hs.ratio, 0),
  };
}

/**
 * Monotonic KPI counters of the mobile machine (§8.5). The JobRunner diffs
 * them against the job start. Time-type values that are null are integrated
 * by the JobRunner itself from readMobile().
 *   machine.kpi = { collisions, scrapes, kerb (soft strikes), kerbHard, speedingTime (s > 11 km/h on site),
 *     trafficCollisions, sidePulls, boomContacts, floatLight (FLOAT_LIGHT entries), liftoffs, slams,
 *     maxSettlement (m), punchThrough (count), bypass (count), overturned (bool), rclWarnTime (s), mismatchTime (s),
 *     timePenalty (s, e.g. +120 per quick-ballast operation) }
 */
export function mobileCounters(m) {
  const k = m.kpi || {}, v = m.vehicle?.kpi || {}, rc = m.rcl?.counters || {};
  const n = (...a) => { for (const x of a) if (typeof x === 'number' && Number.isFinite(x)) return x; if (a.includes(true)) return 1; return 0; };
  const t = (...a) => { for (const x of a) if (typeof x === 'number' && Number.isFinite(x)) return x; return null; };
  return {
    collisions: n(k.collisions, v.collisions), scrapes: n(k.scrapes, v.scrapes),
    kerb: n(k.kerb, v.kerb), kerbHard: n(k.kerbHard, v.kerbHard),
    speedingTime: t(k.speedingTime, v.speedingTime),
    trafficCollisions: n(k.trafficCollisions, v.trafficCollisions),
    sidePulls: n(k.sidePulls), boomContacts: n(k.boomContacts), floatLight: n(k.floatLight),
    liftoffs: n(k.liftoffs), slams: n(k.slams),
    maxSettlement: t(k.maxSettlement), punchThrough: n(k.punchThrough),
    bypass: n(k.bypass, rc.bypassUsed),
    overturned: !!k.overturned,
    warnTime: t(k.rclWarnTime, rc.warnTime), mismatchTime: t(k.mismatchTime, rc.mismatchTime),
    timePenalty: n(k.timePenalty), // s added to the job time (quickBallast training option, §6.6)
  };
}

// ------------------------------------------------------------ configuration
const floorDetent = (b) => (typeof b !== 'number' ? 0 : b >= 0.99 ? 100 : b >= 0.49 ? 50 : 0);

/** What the crane really is: {mode, base, cwKg, block} (base = smallest beam, §2.3.2). */
export function actualConfig(v) {
  const mode = v.floatsSet ? 'outriggers' : 'tyres';
  let base = null;
  if (v.detents.every((d) => d !== null)) base = Math.min(...v.detents);
  else base = Math.min(...v.beams.map(floorDetent)); // off-detent beams count as the detent below
  return { mode, base, cwKg: v.cwKg, block: v.block, onDetents: v.detents.every((d) => d !== null) };
}

/**
 * 'exact' | 'conservative' | 'unconservative' | 'none'. Unconservative =
 * configured support, base or counterweight greater than reality (§8.5); the
 * block is judged separately (reeving mismatch).
 */
export function classifyConfig(cfg, act) {
  if (!cfg) return 'none';
  const rank = { tyres: 0, outriggers: 1 };
  if ((rank[cfg.mode] ?? 1) > (rank[act.mode] ?? 0)) return 'unconservative';
  if (cfg.cwKg > act.cwKg + 1) return 'unconservative';
  if (cfg.mode === 'outriggers' && act.mode === 'outriggers' && cfg.base > act.base) return 'unconservative';
  const exact = cfg.mode === act.mode && Math.abs(cfg.cwKg - act.cwKg) <= 1 && (cfg.mode === 'tyres' || cfg.base === act.base);
  return exact ? 'exact' : 'conservative';
}

/** Short RCL code, e.g. "OR B100 CW35.0 n1 BALL" (§5). */
export function rclCode(cfg, falls = null) {
  if (!cfg) return '—';
  const n = falls ?? { ball: 1, hb26: 3, hb60: 7, hb90: 10 }[cfg.block] ?? 1;
  return `${cfg.mode === 'tyres' ? 'TY' : `OR B${cfg.base}`} CW${(cfg.cwKg / 1000).toFixed(1)} n${n} ${String(cfg.block).toUpperCase()}`;
}

/** Does the confirmed RCL config equal reality (config step, match 'actual')? */
export function configMatches(v) {
  if (!v.rcl || !v.rcl.confirmed) return false;
  const act = actualConfig(v);
  return classifyConfig(v.rcl, act) === 'exact' && v.rcl.block === act.block && (act.mode === 'tyres' || act.onDetents);
}

// ------------------------------------------------------------ setup checks
const fmtDeg = (d) => (d === null || d === undefined ? 'n/a' : `${d.toFixed(1)}°`);

/** Live checklist for a 'setup' step: [{id, label, ok}] */
export function setupChecklist(v, req = {}) {
  const items = [];
  const beams = req.beams || [1, 1, 1, 1];
  beams.forEach((min, i) => {
    const d = v.detents[i], need = Math.round(min * 100);
    items.push({ id: 'beam' + i, label: `${FLOAT_NAMES[i]} beam ${need} %${d === null ? ' — off detent' : d < need ? ` — at ${d} %` : ''}`, ok: d !== null && d >= need });
  });
  if (req.mats) {
    const miss = v.mats.map((m, i) => (m && m !== 'none' ? null : FLOAT_NAMES[i])).filter(Boolean);
    items.push({ id: 'mats', label: `Mats under all floats${miss.length ? ` — missing ${miss.join(', ')}` : ''}`, ok: !miss.length });
  }
  items.push({ id: 'floats', label: 'All floats set and carrying', ok: v.floatsSet });
  if (req.tyresClear) items.push({ id: 'tyres', label: 'Tyres clear of the ground', ok: v.tyresClear });
  if (req.levelDeg !== undefined && req.levelDeg !== null) {
    items.push({ id: 'level', label: `Level ≤ ${req.levelDeg.toFixed(1)}° (${fmtDeg(v.levelDeg)})`, ok: v.levelDeg === null || v.levelDeg <= req.levelDeg + 1e-6 });
  }
  return items;
}

/** Setup snapshot (first lift-off, or setup-step completion). */
export function snapshotSetup(v, t = 0) {
  return {
    t, mode: v.mode, beams: [...v.beams], detents: [...v.detents], mats: [...v.mats], floatsSet: v.floatsSet,
    tyresClear: v.tyresClear, levelDeg: v.levelDeg, rcl: v.rcl ? { ...v.rcl } : null, actual: actualConfig(v),
  };
}

/**
 * Setup KPI rows + checklist from a snapshot (§8.5).
 * @returns {{items:{label,value,pts,note?}[], checklist:{label,ok}[], criticalRisk:boolean}}
 */
export function setupKpis(snap, mismatchTime = 0) {
  const K = MOBILE_KPI.setup, items = [], checklist = [];
  const act = snap.actual;
  const onOutriggers = act.mode === 'outriggers';
  const add = (label, value, pts, ok, note) => { items.push({ label, value, pts, note }); checklist.push({ label, ok }); };
  if (onOutriggers) {
    const off = snap.detents.map((d, i) => (d === null ? FLOAT_NAMES[i] : null)).filter(Boolean);
    add('Outrigger beams at a detent', off.length ? `${off.join(', ')} between detents` : snap.detents.map((d) => `${d}`).join(' / ') + ' %', -K.beamOffDetent * off.length, !off.length);
    const miss = snap.mats.map((m, i) => (m && m !== 'none' ? null : FLOAT_NAMES[i])).filter(Boolean);
    add('Mats under the floats', miss.length ? `missing ${miss.join(', ')}` : snap.mats.join(' / '), -K.missingMat * miss.length, !miss.length);
    add('All floats set', snap.floatsSet ? 'Yes' : 'No', snap.floatsSet ? 0 : -K.floats, snap.floatsSet);
    add('Tyres clear of the ground', snap.tyresClear ? 'Yes' : 'No', snap.tyresClear ? 0 : -K.tyres, snap.tyresClear);
  }
  const lv = snap.levelDeg;
  const lvPts = lv === null ? 0 : lv > K.levelWarn ? -K.level2 : lv > K.levelOk ? -K.level1 : 0;
  add('Crane level', lv === null ? 'n/a' : `${lv.toFixed(2)}°`, lvPts, lvPts === 0);
  let criticalRisk = false;
  if (snap.rcl) {
    const cls = classifyConfig(snap.rcl, act);
    const pts = cls === 'exact' ? 0 : cls === 'conservative' ? -K.conservative : -K.unconservative;
    criticalRisk = cls === 'unconservative';
    const actual = rclCode({ mode: act.mode, base: act.base, cwKg: act.cwKg, block: act.block });
    add('RCL configuration vs crane', cls === 'exact' ? rclCode(snap.rcl) : `${rclCode(snap.rcl)} (actual ${actual})`, pts, cls === 'exact',
      cls === 'unconservative' ? 'CRITICAL RISK' : cls === 'conservative' ? 'conservative' : undefined);
    const reeveOk = snap.rcl.block === act.block;
    add('Reeving entered in the RCL', reeveOk ? String(act.block).toUpperCase() : `${String(snap.rcl.block).toUpperCase()} entered, ${String(act.block).toUpperCase()} reeved`, reeveOk ? 0 : -K.reeving, reeveOk);
  }
  const mm = mismatchTime > K.mismatchS;
  add('Support ≠ config warning', `${Math.round(mismatchTime)} s`, mm ? -K.mismatch : 0, !mm);
  return { items, checklist, criticalRisk };
}

// recommended max slew speed under load [S15] (§3.2)
export const recommendedSlewRpm = (L) => tableLookup(SLEW_REC_RPM, L);

export const insideSite = (p) => p.x > SITE_FENCE.minX && p.x < SITE_FENCE.maxX && p.z > SITE_FENCE.minZ && p.z < SITE_FENCE.maxZ;
export const SITE_KPI_KMH = SPEED_LIMITS.siteKpiKmh;

// ------------------------------------------------------------ job helpers
/** MobileStart for a job def: def.start = {preset, ...overrides} (§9.1). */
export function resolveStart(start) {
  if (!start) return null;
  if (typeof start === 'function') return start;
  const { preset = 'pad', ...over } = start;
  return makeMobileStart(preset, over);
}

const R = Math.PI / 2;
const pad = (o) => ({ preset: 'pad', ...o }); // at P1, set up, carried mats, level, RCL pre-filled (unconfirmed)

// Precast panels on the A-frame trailer (trailer-local frame: x forward, z across).
// PANEL_X: 0.4 m toward the trailer's rear. Centred, the 4 m panels' front ends
// reached 0.1 m into the tractor chassis collider, and a load that starts inside
// a collider is shot out when it is hooked on (M4 and free play).
const PANEL_X = -0.4;
const PANEL_SLOTS_M4 = [-0.45, 0.72, 0.45];
const PANEL_SLOTS_FREE = [-0.45, 0.45];

// ------------------------------------------------------------ the jobs (§8.4)
export const MOBILE_JOBS = [
  {
    id: 'm1', machine: 'mobile', title: 'Mobilise & Set Up', module: 'AT-100 · Mobilisation and set-up',
    brief: 'Drive the AT-100 in road trim (0 t counterweight, hook ball stowed) from the public road through the site gate to crane pad P1, following the chevrons at walking pace on site. Set up on full base with mats under every float, level to 0.3°, enter the RCL configuration, then prove the set-up with a 5 t test lift.',
    par: 540, wind: 3,
    start: { preset: 'road' },
    setup: (J) => {
      const tb = J.spawn('testBlock5', 47.5, -8.0, 0, 0);
      return [
        { kind: 'drive', target: { x: P1.x, z: P1.z, yaw: P1.yaw }, tol: { pos: P1.tolPos, yawDeg: P1.tolYawDeg }, text: 'Drive to pad P1 and stop on the X (±0.5 m, ±5°), parking brake on. Site speed limit 10 km/h; use all-wheel steer for the gate.' },
        { kind: 'setup', require: { beams: [1, 1, 1, 1], mats: true, levelDeg: 0.3, tyresClear: true }, text: 'SETUP (Enter): extend all beams to 100 %, mats under every float, lower the jacks until the tyres are clear, level to ±0.3°, then Enter to the cab.' },
        { kind: 'config', match: 'actual', text: 'Power up (P) and enter the RCL configuration that matches the crane (L): outriggers, base 100 %, CW 0 t, hook ball — confirm it.' },
        { kind: 'attach', load: tb, text: 'Release the hook ball from the bumper (R), telescope as needed and hook on the 5 t test block (R 10.3 m).' },
        { kind: 'deliver', load: tb, target: J.place(48.5, -20.0), tol: 0.5, clearY: 2.5, text: 'Test lift (5–60 cm, hold 2 s), then land the block on the marked spot at R 11.7 m (22.7 m boom).' },
      ];
    },
  },
  {
    id: 'm2', machine: 'mobile', title: 'Rooftop Plant', module: 'AT-100 · Self-ballasting and long boom',
    brief: 'A 3 t HVAC unit goes onto the neighbouring roof, 32 m away over the hoarding. With 23.5 t of counterweight the lift would run at about 85 % of the chart — too close to the limit for a bulky, wind-catching unit — so first take slab C off the ballast truck, land it on the carrier deck and raise it into the counterweight frame (35 t, about 60 %). Reconfigure the RCL, telescope to 45 m and set the unit on its curb between the parapet and the lift overrun.',
    par: 900, wind: 3,
    // the 26 t block is reeved for the ballasting: the hook ball (8.8 t) cannot lift an 11.5 t slab
    start: pad({ cwKg: 23500, rcl: { mode: 'outriggers', base: 100, cwKg: 23500, block: 'hb26', confirmed: false }, block: 'hb26', boomK: 0, luffDeg: 60, slewDeg: 0, ropeLen: 6 }),
    setup: (J) => {
      const bt = J.prop('ballastTruck', { x: 50.0, z: -12.0, yaw: R });
      const s = bt.info.slot('C');
      const cwC = J.spawn('cwC', s.x, s.z, 0, s.y);
      // truck parked so the unit sits at R ≈ 20 m: the 45 m head (top 43.7 m) stays under the
      // tower-crane zone ceiling (44.2 m) with margin for boom deflection and the frame lift
      const ft = J.prop('flatTruck', { x: 42.9, z: -27.8, yaw: R, color: 0x2f6db3 });
      const at = ft.info.at(-1.675);
      const hvac = J.spawn('hvac', at.x, at.z, R, at.y);
      const roof = J.prop('neighbourRoof', {});
      const c = roof.info.curb;
      return [
        { kind: 'attach', load: cwC, text: 'Rig counterweight slab C (11.5 t) on the ballast truck: lower the 26 t block and hook on (R).' },
        { kind: 'deck', load: cwC, text: 'Boom over the rear: land slab C on the carrier deck (±0.15 m, ±3°) and release it.' },
        { kind: 'ballast', cwKg: 35000, text: 'Slew to 0° and pin the turntable (T), then Enter for the outrigger remote (SETUP) and hold B: the ballasting cylinders lift the stack into the frame (35.0 t).' },
        { kind: 'config', match: 'actual', text: 'Unpin (T) and enter the new configuration in the RCL (L): OR B100 CW35.0 with the 26 t block — confirm.' },
        { kind: 'boom', length: 45.0, text: 'Telescope to 45.0 m (pinned) before rigging — extend first, then load. A shorter boom leaves the unit almost no clearance over the parapet.' },
        { kind: 'attach', load: hvac, text: 'Hook on the HVAC unit on the delivery truck. Inside the tower-crane zone the head is capped at 44.2 m: luff out to R ≈ 20 m before slewing over the truck.' },
        { kind: 'deliver', load: hvac, target: { x: c.x, y: c.y, z: c.z, yaw: c.yaw }, tol: 0.4, yawTol: 5, clearY: roof.info.parapetTop + 2.2, text: 'Test lift, then fly the unit over the parapet and land it square on the roof curb (±0.4 m, ±5°).' },
      ];
    },
  },
  {
    id: 'm3', machine: 'mobile', title: 'Generator Set', module: 'AT-100 · Reeving and heavy lift',
    brief: 'An 11.5 t standby generator comes in on a low-loader. The hook ball is rated 8.8 t, so ground the hook, have the riggers reeve the 26 t block (3 falls) and enter the new reeving in the RCL. Then lift the set off the low-loader and land it square on its plinth. With the 23.5 t counterweight the lift runs at about 75 % of the chart.',
    par: 600, wind: 2.5,
    start: pad({ cwKg: 23500, rcl: { mode: 'outriggers', base: 100, cwKg: 23500, block: 'ball', confirmed: false }, block: 'ball', boomK: 3, luffDeg: 55, slewDeg: 0, ropeLen: 12 }),
    setup: (J) => {
      J.prop('lowLoader', { x: 46.0, z: -24.5, yaw: R });
      const gen = J.spawn('generator', 46.0, -23.0, R, 0.9);
      const pl = J.prop('generatorPlinth', { x: 46.5, z: -4.0, yaw: 0, top: 0.3 });
      return [
        { kind: 'reeve', block: 'hb26', text: 'Land the hook ball on the ground and open the reeving dialog (O): reeve the 26 t block (3 falls). The riggers need about 45 s.' },
        { kind: 'config', match: 'actual', text: 'Enter the new reeving in the RCL (L) — OR B100 CW23.5 n3 HB26 — and confirm.' },
        { kind: 'attach', load: gen, text: 'Hook on the generator on the low-loader (R 15.6 m, rear right).' },
        { kind: 'deliver', load: gen, target: { x: 46.5, y: pl.info.top, z: -4.0, yaw: 0 }, tol: 0.3, yawTol: 5, clearY: 3.5, text: 'Test lift, then land the set square on the plinth (±0.3 m, ±5°) — use the tag line (Q/E) while it is low.' },
      ];
    },
  },
  {
    id: 'm4', machine: 'mobile', title: 'Precast Delivery', module: 'AT-100 · Repetitive lifts in wind',
    brief: 'Three 4.2 t precast wall panels stand on an A-frame trailer. Place them one by one into the storage rack at R 29 m over the rear. The 22.7 m boom cannot reach: telescope to at least 33.9 m first. Wind 5 m/s with gusts: keep the slewing gentle under load (0.3 rpm on this boom) and steer the panels with the tag lines while they are low.',
    par: 780, wind: 5, gust: 0.7,
    start: pad({ cwKg: 23500, rcl: { mode: 'outriggers', base: 100, cwKg: 23500, block: 'ball', confirmed: false }, block: 'ball', boomK: 3, luffDeg: 55, slewDeg: 0, ropeLen: 12 }),
    setup: (J) => {
      // A-frame (vertical inloader rack): two panels on one side of the spine, one on the other;
      // outer panel of the pair first; any remaining panel may be picked next (anyOf)
      const tr = J.prop('aFrameTrailer', { x: 44.0, z: -25.0, yaw: -R, slots: PANEL_SLOTS_M4, panelX: PANEL_X, panelLen: 4.0 });
      const y = tr.info.bedY;
      const panels = PANEL_SLOTS_M4.map((lz) => { const w = tr.toWorld(PANEL_X, lz); return J.spawn('precast', w.x, w.z, R, y); });
      J.prop('precastRack', { x: 50.5, z: -40.0, yaw: 0, slots: [-0.5, 0, 0.5], len: 4.0 });
      // the 22.7 m start boom reaches 20 m: telescope before rigging, or the first panel has to go back down
      const steps = [{ kind: 'boom', length: 33.9, text: 'Telescope to 33.9 m (pinned) before rigging — the rack is at R 29 m, out of reach of the 22.7 m boom.' }];
      panels.forEach((p, i) => {
        steps.push({ kind: 'attach', load: p, anyOf: panels, text: `Panel ${i + 1}/3: hook on the next panel on the A-frame (both anchors).` });
        steps.push({ kind: 'deliver', load: p, target: { x: 50.0 + 0.5 * i, y: 0.1, z: -40.0, yaw: R }, tol: 0.25, yawTol: 4, clearY: 4.5, text: `Panel ${i + 1}/3: land it upright in rack slot ${i + 1} (±0.25 m, ±4°). Wind limit 11 m/s.` });
      });
      return steps;
    },
  },
  {
    id: 'm5', machine: 'mobile', title: 'Ballast Check', module: 'AT-100 · Configuration discipline',
    brief: 'You take over the crane from the previous shift. A 6 t steel bundle must go to lay-down C, 24 m away over the rear. Check the crane before you trust the RCL: what is really on the superstructure, and what does the configuration say? A ballast truck is on its way.',
    par: 780, wind: 3,
    start: pad({ cwKg: 11500, rcl: { mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball', confirmed: false }, block: 'ball', boomK: 5, luffDeg: 60, slewDeg: 0, ropeLen: 14 }),
    events: [{
      t: 90,
      run: (J) => {
        const tr = J.prop('ballastTruck', { x: 50.0, z: -12.0, yaw: -R, arrive: 16, from: 26 });
        const s = tr.info.slot('B');
        tr.carry(J.spawn('cwB', s.x, s.z, 0, s.y));
        J.toast('Site radio: the ballast truck with slab B (12.0 t) is arriving at the pad.', 'info');
      },
    }],
    setup: (J) => {
      const tr = J.prop('semiFlat', { x: 46.0, z: -20.0, yaw: -R });
      const sb = J.spawn('steelBundle', 46.0, -20.0, R, tr.info.bedY);
      J.prop('laydown', { x: 57.0, z: -36.0, w: 3.4, d: 9.0, label: 'layC', bearers: [[0, -3.0, 1.6], [0, 0, 1.6], [0, 3.0, 1.6]] });
      return [
        { kind: 'attach', load: sb, text: 'Hook on the steel bundle on the trailer (R 13.6 m).' },
        { kind: 'deliver', load: sb, target: { x: 57.0, y: 0.1, z: -36.0, yaw: null, markerYaw: R }, tol: 0.6, clearY: 2.8, text: 'Test lift, then land the bundle on the bearers in lay-down C (R 24 m, over the rear).' },
      ];
    },
  },
  {
    id: 'm6', machine: 'mobile', title: 'Substation Transformer', module: 'AT-100 · Restricted outrigger base',
    brief: 'The crane stands on P1 in road stance with 11.5 t counterweight fitted. Concrete barriers protect live cables along the east side, so the left beams can only go to 50 %. Set up on the short base, tell the RCL what you really have, telescope to 22.7 m and lift the 7.5 t transformer over the hoarding onto the neighbour\'s substation plinth.',
    par: 720, wind: 2.5,
    start: { preset: 'road', pos: { x: P1.x, z: P1.z }, yaw: P1.yaw, cwKg: 11500, rcl: { mode: 'outriggers', base: 100, cwKg: 11500, block: 'ball', confirmed: false }, siteTravel: true },
    setup: (J) => {
      J.prop('cableBarriers', { x: 60.9, z: 0, yaw: 0, zs: [-16.5, -13.5, -10.5, -7.5] });
      J.zone({ minX: 61.6, maxX: 66.0, minZ: -19.5, maxZ: -2.5 }, { kind: 'backfill', allowKPa: 100, label: 'Backfilled cable trench' });
      const ft = J.prop('flatTruck', { x: 46.0, z: -13.675, yaw: R, color: 0xe9e9e4 });
      const at = ft.info.at(-1.675);
      const tf = J.spawn('transformer', at.x, at.z, R, at.y);
      const pl = J.prop('substationPlinth', { x: 70.5, z: -12.0, yaw: 0, base: 0.15, top: 0.6 });
      return [
        { kind: 'setup', require: { beams: [0.5, 1, 0.5, 1], mats: true, levelDeg: 0.3, tyresClear: true }, text: 'SETUP: left beams (FL, RL) to 50 % — the barriers block 100 % — right beams to 100 %, mats, level ±0.3°, tyres clear, then Enter.' },
        { kind: 'config', match: 'actual', text: 'Enter what the crane really has in the RCL (L): OR B50 CW11.5, hook ball — the smallest beam sets the chart. Confirm.' },
        { kind: 'boom', length: 22.7, text: 'Telescope to 22.7 m (pinned).' },
        { kind: 'attach', load: tf, text: 'Release the hook ball (R) and hook on the transformer on the truck (R 11 m, right side).' },
        { kind: 'deliver', load: tf, target: { x: 70.5, y: pl.info.top, z: -12.0, yaw: null }, tol: 0.3, clearY: 3.5, text: 'Test lift, slew over the rear and land the transformer on the substation plinth beyond the hoarding (R 13.5 m, left).' },
      ];
    },
  },
];

/**
 * §8.10 free-play extras near P1 (props + loads, owned by the JobRunner so a
 * job start clears them): test block, precast × 2 on an A-frame trailer, the
 * generator on the low-loader, and — for the 'road' start — the ballast truck
 * with slabs A, B and C.
 */
export function spawnMobileFreePlay(J, { mobileStart = 'pad' } = {}) {
  J.spawn('testBlock5', 47.5, -8.0, 0, 0);
  const af = J.prop('aFrameTrailer', { x: 36.5, z: -26.5, yaw: -R, slots: PANEL_SLOTS_FREE, panelX: PANEL_X, panelLen: 4.0 });
  for (const lz of PANEL_SLOTS_FREE) { const w = af.toWorld(PANEL_X, lz); J.spawn('precast', w.x, w.z, R, af.info.bedY); }
  J.prop('lowLoader', { x: 46.0, z: -24.5, yaw: R });
  J.spawn('generator', 46.0, -23.0, R, 0.9);
  if (mobileStart === 'road') {
    const bt = J.prop('ballastTruck', { x: 50.0, z: -12.0, yaw: R });
    for (const id of ['A', 'B', 'C']) { const s = bt.info.slot(id); J.spawn('cw' + id, s.x, s.z, 0, s.y); }
  }
}

