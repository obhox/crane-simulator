// AT-100 5.1 outriggers (spec §1.6, §4.2, §4.7, §4.8, §6.4): four
// single-stage hydraulic beams with detents, vertical jacks with floats,
// mats laid by the riggers, auto-level, interlocks, and the support list the
// stability solver rests the carrier on. Pure math (node-testable); world
// obstruction uses the collider boxes (src/physics/collide.js).
//
// Beam position: `y` = float-centre |y_c| (m). The three detents sit at the
// §1.6 bases: 0 % → 1.25, 50 % → 2.50, 100 % → 3.50 m (BASES; the charts and
// the stability reference cases use these). `ext` is the detent-named
// fraction (0 / 0.5 / 1 at the detents, piecewise linear in between), so it
// matches MobileStart.beams. NOTE: §4.2's "y = 1.25 + 2.25·ext" would put the
// 50 % detent at 2.375 m and contradict BASES / §1.6 / the charts; BASES wins.
//
// Order of arrays everywhere: FLOATS (FL, FR, RL, RR). Selection: 0..3 or 4 = all.
//
//   const o = new Outriggers();
//   o.reset(start, groundFn, pose)
//   events = o.update(dt, input.setup, actions, world, groundFn, {pose, floatR, enabled, compositeStock, settle, ignore})
//   sup = o.supports(pose, settle.s, floatR)      // → Stability.update(..., sup)

import { AT100, FLOATS, BASES, AXLES, MATS, MAT_PLACE_TIME, STABILITY, LEVEL, carrierToWorld } from './config.js';
import { Box, obbXZ } from '../physics/collide.js';

const OR = AT100.outriggers;
const J0 = OR.jackJ0; // 0.90 m frame datum → pad bottom, jack retracted
const RIDE = AT100.carrier.rideHeight; // 1.30 m frame datum on tyres
const TRACK = AT100.carrier.tyre.trackY; // ±1.18 m tyre-centre track
const Y0 = BASES[0], Y50 = BASES[50], Y100 = BASES[100];
const DETENT_Y = [Y0, Y50, Y100];
const DETENT_EXT = [0, 0.5, 1];
const CAPTURE = OR.detentCapture; // ±0.02 m
const PASS_HOLD = 0.6; // s the lever must stay held at the 50 % detent before the beam passes it [E]
const DEAD = 0.05; // lever dead band
const JS = OR.jackSpeed;
const PAD_HALF = OR.pad.size / 2;
// Mat footprint half-extents in C (x along the carrier, y along the beam).
// The carried 1.75 × 1.00 m mat lies with its long side along the beam: this
// is what keeps P1's left mats at world x ≤ 61.4 (§8.2: 60.5 + 0.875).
const FOOT = {
  none: { x: PAD_HALF, y: PAD_HALF },
  carried: { x: MATS.carried.size[2] / 2, y: MATS.carried.size[0] / 2 },
  composite: { x: MATS.composite.size[2] / 2, y: MATS.composite.size[0] / 2 },
};
const MAT_CYCLE = ['none', 'carried', 'composite'];
// Obstacles must stand at least this high above the ground to stop a float / mat
// (painted markings, thin plates don't); and reach below the beam top.
const OBST_MIN_H = 0.05, BEAM_TOP_ABOVE_DATUM = 0.35;
const COMPLIANCE_TAU = 0.25; // s, low-pass on the reactions feeding the ground compliance [E]
const SEL_ALL = Object.freeze([0, 1, 2, 3]), SEL_ONE = Object.freeze([[0], [1], [2], [3]].map(Object.freeze));

export const yOfExt = (e) => (e <= 0.5 ? Y0 + (Y50 - Y0) * (e / 0.5) : Y50 + (Y100 - Y50) * ((e - 0.5) / 0.5));
export const extOfY = (y) => (y <= Y50 ? 0.5 * (y - Y0) / (Y50 - Y0) : 0.5 + 0.5 * (y - Y50) / (Y100 - Y50));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sgn = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);

const _w = { x: 0, z: 0 };
const _probe = new Box(0, 0, 0, 0.3, 1, 0.3, 0, 'probe');

export class Outriggers {
  constructor() {
    // beams[i]: y (m), ext (0..1, detent-named), target (detent 0|0.5|1 it is heading to / sits at, or null),
    // detent (0|0.5|1 when within ±2 cm of one, else null), obstructed, locked (float loaded), v (m/s)
    this.beams = FLOATS.map(() => ({ y: Y0, ext: 0, target: 0, detent: 0, obstructed: false, locked: false, v: 0, pausedAt: null, pauseDir: 0, holdT: 0 }));
    // jacks[i]: e (m, 0..max), max (stroke: front 0.65, rear 0.70), v (m/s)
    this.jacks = FLOATS.map((f) => ({ e: 0, max: f.x > 0 ? OR.jackStroke.front : OR.jackStroke.rear, v: 0 }));
    this.mats = ['none', 'none', 'none', 'none'];
    this.matPending = [null, null, null, null]; // kind being laid / removed by the riggers
    this.matT = [0, 0, 0, 0]; // s left
    this.matY = [Y0, Y0, Y0, Y0]; // beam y the mat was laid at
    this.selected = 4; // 0..3 = FL, FR, RL, RR; 4 = all
    this.autoLevel = false; // G held this step
    this.levelState = 'idle'; // 'idle' | 'running' | 'done' | 'range' | 'blocked'
    this.levelTarget = [0, 0, 0, 0];
    this.message = null; // HUD line for the last blocked request (null = none)
    this.events = [];
    // derived by supports(pose)
    this.floatContact = [false, false, false, false];
    this.floatWorld = FLOATS.map(() => ({ x: 0, y: 0, z: 0 })); // pad centre on the ground (world)
    this.areas = [OR.pad.area, OR.pad.area, OR.pad.area, OR.pad.area]; // bearing area m² (for Settlement)
    this.tyresClear = false; // no tyre in contact (§4.4 TYRES NOT CLEAR otherwise)
    this.floatsSet = false; // all four floats in contact with a jack extended
    this.beamSpeed = 0; this.jackSpeed = 0; // |m/s| max this step (audio)
    this._sup = [
      ...FLOATS.map((f, i) => ({ id: f.id, i, kind: 'float', x: f.x, y: 0, h: 0, k: STABILITY.floatK, g: 0, e: 0 })),
      ...AXLES.flatMap((x, j) => [+1, -1].map((side) => ({ id: `T${j + 1}${side > 0 ? 'L' : 'R'}`, i: -1, kind: 'tyre', x, y: side * TRACK, h: RIDE, k: STABILITY.tyreK, g: 0, e: 0 }))),
    ];
    this._compositeStock = 0;
    this.Rf = [0, 0, 0, 0]; // low-passed float reactions for the ground compliance (N)
  }

  // ------------------------------------------------------------ queries
  get allAtDetent() { return this.beams.every((b) => b.detent !== null); }
  // beam positions in % (100 | 50 | 0), null when between detents
  beamsPct() { return this.beams.map((b) => (b.detent === null ? null : Math.round(b.detent * 100))); }
  // Smallest actual base in % (100 | 50 | 0) for the RCL "SUPPORT ≠ CONFIG" check
  // and job setup steps. A beam between detents counts as the detent below it
  // (the charts only exist at the detents); use allAtDetent for the off-detent warning.
  detentMin() {
    let m = 1;
    for (const b of this.beams) {
      let d = 0;
      for (let k = 2; k >= 0; k--) if (b.y >= DETENT_Y[k] - CAPTURE) { d = DETENT_EXT[k]; break; }
      if (d < m) m = d;
    }
    return Math.round(m * 100);
  }
  // effective bearing mat under float i
  matAt(i) { return this.mats[i]; }
  get matsAll() { return this.mats.every((m) => m !== 'none'); }
  selectedList() { return this.selected >= 4 ? SEL_ALL : SEL_ONE[this.selected]; }

  // ------------------------------------------------------------ actions
  select(i) { this.selected = clamp(i | 0, 0, 4); }

  // X: cycle the mat under the selected float(s): none → carried → composite (if the job provides stock) → none.
  // Needs the beam at a detent and the float out of contact; the riggers take 4 s.
  cycleMat(world = null, groundFn = null, pose = null) {
    let res = { ok: true, reason: null };
    for (const i of this.selectedList()) {
      const r = this._cycleOne(i, world, groundFn, pose);
      if (!r.ok) res = r;
    }
    if (!res.ok) this.message = res.reason;
    return res;
  }

  _cycleOne(i, world, groundFn, pose) {
    const b = this.beams[i];
    if (this.matPending[i]) return { ok: false, reason: 'MAT: riggers busy' };
    if (b.detent === null) return { ok: false, reason: 'MAT: beam not at a detent' };
    if (this.floatContact[i]) return { ok: false, reason: 'MAT: raise the float first' };
    const used = this.mats.filter((m, k) => k !== i && m === 'composite').length + this.matPending.filter((m, k) => k !== i && m === 'composite').length;
    let k = MAT_CYCLE.indexOf(this.mats[i]);
    let next = null;
    for (let t = 1; t <= 3; t++) {
      const cand = MAT_CYCLE[(k + t) % 3];
      if (cand === 'composite' && used >= this._compositeStock) continue;
      next = cand; break;
    }
    if (!next || next === this.mats[i]) return { ok: false, reason: 'MAT: no other mat available' };
    // the pad must clear the new mat's top (pad bottom = datum − 0.90 − e)
    const f = FLOATS[i];
    carrierToWorld(pose || { x: 0, z: 0 }, pose?.yaw || 0, f.x, f.side * b.y, _w);
    const gnd = groundFn ? groundFn(_w.x, _w.z) : 0;
    const datum = pose && pose.z0 !== undefined ? pose.z0 + pose.a * f.x + pose.b * f.side * b.y : gnd + RIDE;
    if (datum - J0 - this.jacks[i].e - gnd - MATS[next].thickness < 0.01) return { ok: false, reason: 'MAT: raise the float first' };
    if (next !== 'none' && world && pose && this._blocked(i, b.y, FOOT[next], world, groundFn, pose)) return { ok: false, reason: 'MAT OBSTRUCTED' };
    this.matPending[i] = next;
    this.matT[i] = MAT_PLACE_TIME;
    return { ok: true, reason: null };
  }

  // ------------------------------------------------------------ reset
  /**
   * @param {import('../machines/machine.js').MobileStart} start  beams, jacksSet, mats, levelled
   * @param {(x:number,z:number)=>number} groundFn  terrain height
   * @param {{x,z,yaw}} pose  carrier slew-axis point and yaw
   */
  reset(start, groundFn = () => 0, pose = { x: 0, z: 0, yaw: 0 }) {
    this._groundFn = groundFn;
    for (let i = 0; i < 4; i++) {
      const b = this.beams[i], v = start?.beams?.[i] ?? 0;
      b.y = yOfExt(v >= 0.99 ? 1 : v >= 0.49 ? 0.5 : 0);
      b.v = 0; b.obstructed = false; b.locked = false; b.pausedAt = null; b.holdT = 0;
      this.mats[i] = MATS[start?.mats?.[i]] ? start.mats[i] : 'none';
      this.matPending[i] = null; this.matT[i] = 0; this.matY[i] = b.y;
      this.jacks[i].e = 0; this.jacks[i].v = 0;
      this.Rf[i] = 0;
    }
    this._derive();
    this.levelState = 'idle';
    this.message = null;
    if (start?.jacksSet) {
      // floats set: jacks at the §4.7 auto-level extension (level, tyres 0.10 m clear)
      const t = this._levelTargets(groundFn, pose, null);
      for (let i = 0; i < 4; i++) this.jacks[i].e = Math.min(this.jacks[i].max, t[i]);
      this.levelState = start.levelled ? 'done' : 'idle';
    }
    this.supports(pose, null, null, groundFn);
  }

  // ------------------------------------------------------------ step
  /**
   * @param {number} dt
   * @param {{beam:number, jack:number, autoLevel?:boolean}} setup   input.setup (+ extend / + float down)
   * @param {string[]|null} actions  queued discrete actions this step: 'sel0'..'sel3', 'selAll', 'mat'
   * @param {import('../physics/collide.js').ColliderWorld|null} world
   * @param {(x:number,z:number)=>number} groundFn  terrain height (terrain.heightAt)
   * @param {{pose:{x,z,yaw,z0?,a?,b?}, floatR?:number[], enabled?:boolean, compositeStock?:number,
   *          settle?:number[], ignore?:Set}} env
   *   enabled = carrier engine running && parking brake on && mode SETUP (§6.4)
   * @returns {object[]} events: 'detent', 'beamEnd', 'jackEnd', 'obstructed', 'beamLocked', 'matPlaced',
   *   'matRemoved', 'touchdown' {i, speed}, 'levelDone', 'levelRange', 'blocked' {reason}
   */
  update(dt, setup, actions, world, groundFn, env = {}) {
    const ev = this.events;
    ev.length = 0;
    const pose = env.pose || { x: 0, z: 0, yaw: 0 };
    const floatR = env.floatR || null;
    if (groundFn) this._groundFn = groundFn;
    const enabled = env.enabled !== false;
    this._compositeStock = env.compositeStock ?? this._compositeStock;
    this.message = null;
    if (actions) for (const a of actions) {
      if (a === 'selAll') this.select(4);
      else if (/^sel[0-3]$/.test(a)) this.select(+a[3]);
      else if (a === 'mat') { const r = this.cycleMat(world, groundFn, pose); if (!r.ok) ev.push({ type: 'blocked', reason: r.reason }); }
    }
    // riggers laying / removing mats
    for (let i = 0; i < 4; i++) {
      if (!this.matPending[i]) continue;
      this.matT[i] -= dt;
      if (this.matT[i] <= 0) {
        const kind = this.matPending[i];
        this.mats[i] = kind; this.matY[i] = this.beams[i].y;
        this.matPending[i] = null; this.matT[i] = 0;
        ev.push({ type: kind === 'none' ? 'matRemoved' : 'matPlaced', i, kind });
      }
    }
    const beamCmd = setup?.beam || 0, jackCmd = setup?.jack || 0;
    this.autoLevel = !!setup?.autoLevel;
    this.beamSpeed = 0; this.jackSpeed = 0;
    const sel = this.selectedList();
    // beams
    for (let i = 0; i < 4; i++) {
      const on = sel.includes(i);
      this._beamStep(i, on ? beamCmd : 0, dt, enabled, floatR, world, groundFn, pose, env.ignore, ev);
    }
    // jacks: auto-level (held) overrides the manual jack lever
    if (this.autoLevel) this._autoLevel(dt, enabled, floatR, groundFn, pose, env.settle, ev);
    else {
      if (this.levelState === 'running' || this.levelState === 'blocked') this.levelState = 'idle';
      for (let i = 0; i < 4; i++) this._jackStep(i, sel.includes(i) ? jackCmd : 0, dt, enabled, floatR, ev);
    }
    if (!enabled && (Math.abs(beamCmd) > DEAD || Math.abs(jackCmd) > DEAD || this.autoLevel)) {
      this.message = 'SETUP: engine running and parking brake on';
    }
    this._derive();
    return ev;
  }

  _beamStep(i, cmd, dt, enabled, floatR, world, groundFn, pose, ignore, ev) {
    const b = this.beams[i];
    b.locked = false;
    if (Math.abs(cmd) < DEAD || !enabled) {
      b.v = 0; b.pausedAt = null; b.holdT = 0;
      for (const yd of DETENT_Y) if (Math.abs(b.y - yd) <= CAPTURE) b.y = yd; // detent capture
      return;
    }
    if (floatR && floatR[i] > STABILITY.beamLockN) { // §6.4 beam-under-load interlock
      if (b.v !== 0 || !b._lockMsg) ev.push({ type: 'beamLocked', i });
      b._lockMsg = true; b.locked = true; b.v = 0;
      this.message = 'RETRACT JACK FIRST';
      return;
    }
    b._lockMsg = false;
    if (this.matPending[i]) { b.v = 0; this.message = 'MAT: riggers working at the float'; return; }
    const dir = sgn(cmd);
    if (b.pausedAt !== null) { // resting at the 50 % detent: keep holding to pass it
      if (dir === b.pauseDir) {
        b.holdT += dt;
        if (b.holdT < PASS_HOLD) { b.v = 0; return; }
      }
      b.pausedAt = null; b.holdT = 0;
    }
    const y = b.y;
    let y1 = clamp(y + cmd * OR.beamSpeed * dt, Y0, Y100);
    // stop at the interior detent when moving onto it (a beam sitting on it moves off freely)
    if ((Y50 - y) * dir > 1e-6 && (Y50 - y1) * dir <= 1e-6) {
      y1 = Y50; b.pausedAt = Y50; b.pauseDir = dir; b.holdT = 0;
      ev.push({ type: 'detent', i, pct: 50 });
    }
    if (y1 > y && world && this._blocked(i, y1, FOOT.none, world, groundFn, pose, ignore)) {
      if (!b.obstructed) ev.push({ type: 'obstructed', i });
      b.obstructed = true; b.v = 0;
      this.message = 'OBSTRUCTED';
      return;
    }
    if (y1 < y) b.obstructed = false;
    if (y1 !== y && this.mats[i] !== 'none' && Math.abs(y1 - this.matY[i]) > 1e-4) {
      // the riggers pick the mat up when the beam moves; re-lay it at the new detent
      ev.push({ type: 'matRemoved', i, kind: this.mats[i] });
      this.mats[i] = 'none';
    }
    if (y1 !== y && (y1 === Y0 || y1 === Y100)) ev.push({ type: 'beamEnd', i, pct: y1 === Y0 ? 0 : 100 });
    b.v = (y1 - y) / dt;
    b.y = y1;
    this.beamSpeed = Math.max(this.beamSpeed, Math.abs(b.v));
  }

  _jackStep(i, cmd, dt, enabled, floatR, ev) {
    const j = this.jacks[i];
    if (Math.abs(cmd) < DEAD || !enabled) { j.v = 0; return; }
    if (this.matPending[i] && cmd > 0) { j.v = 0; this.message = 'MAT: riggers working at the float'; return; }
    this._driveJack(i, cmd > 0 ? j.max : 0, Math.abs(cmd), dt, floatR, ev);
  }

  // move jack i toward target e at |cmd| × speed (extend slower under load)
  _driveJack(i, target, scale, dt, floatR, ev) {
    const j = this.jacks[i];
    const loaded = floatR && floatR[i] > STABILITY.beamLockN;
    const sp = (target > j.e ? (loaded ? JS.extendLoaded : JS.extendFree) : JS.retract) * scale;
    const d = target - j.e, step = sp * dt;
    const e1 = Math.abs(d) <= step ? target : j.e + Math.sign(d) * step;
    if (e1 !== j.e && (e1 >= j.max || e1 <= 0) && (e1 === target)) ev.push({ type: 'jackEnd', i, end: e1 <= 0 ? 'in' : 'out' });
    j.v = (e1 - j.e) / dt;
    j.e = clamp(e1, 0, j.max);
    this.jackSpeed = Math.max(this.jackSpeed, Math.abs(j.v));
  }

  // G_i = ground under the float + mat thickness − settlement (§4.2)
  _floatG(i, groundFn, pose, settle) {
    const f = FLOATS[i];
    carrierToWorld(pose, pose.yaw, f.x, f.side * this.beams[i].y, _w);
    return (groundFn ? groundFn(_w.x, _w.z) : 0) + MATS[this.mats[i]].thickness - (settle ? settle[i] : 0);
  }

  // §4.7: z* = max(max axle ground + 1.30 + 0.10, max G_i + 0.90 + 0.02); e_i* = z* − G_i − 0.90
  _levelTargets(groundFn, pose, settle) {
    let ga = -Infinity;
    for (const x of AXLES) for (const side of [1, -1]) {
      carrierToWorld(pose, pose.yaw, x, side * TRACK, _w);
      ga = Math.max(ga, groundFn ? groundFn(_w.x, _w.z) : 0);
    }
    let gm = -Infinity;
    const G = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) { G[i] = this._floatG(i, groundFn, pose, settle); gm = Math.max(gm, G[i]); }
    const z = Math.max(ga + RIDE + LEVEL.axleClear, gm + J0 + LEVEL.floatClear);
    for (let i = 0; i < 4; i++) this.levelTarget[i] = z - G[i] - J0;
    this.levelZ = z;
    return this.levelTarget;
  }

  _autoLevel(dt, enabled, floatR, groundFn, pose, settle, ev) {
    if (!enabled) { this.levelState = 'blocked'; return; }
    if (!this.allAtDetent) { this.levelState = 'blocked'; this.message = 'AUTO-LEVEL: beams not at a detent'; return; }
    if (this.matPending.some(Boolean)) { this.levelState = 'blocked'; this.message = 'AUTO-LEVEL: riggers placing mats'; return; }
    const t = this._levelTargets(groundFn, pose, settle);
    let range = false, done = true;
    for (let i = 0; i < 4; i++) {
      let e = t[i];
      if (e > this.jacks[i].max + 1e-6) { range = true; e = this.jacks[i].max; }
      this._driveJack(i, Math.max(0, e), 1, dt, floatR, ev);
      if (Math.abs(this.jacks[i].e - Math.max(0, e)) > 5e-4) done = false;
    }
    if (range) {
      if (this.levelState !== 'range') ev.push({ type: 'levelRange' });
      this.levelState = 'range';
      this.message = 'LEVEL RANGE EXCEEDED — use cribbing';
    } else if (done) {
      if (this.levelState !== 'done') ev.push({ type: 'levelDone' });
      this.levelState = 'done';
    } else this.levelState = 'running';
  }

  // float (or mat) footprint at beam position y against the world boxes
  _blocked(i, y, foot, world, groundFn, pose, ignore = null) {
    const f = FLOATS[i];
    carrierToWorld(pose, pose.yaw, f.x, f.side * y, _w);
    const gnd = groundFn ? groundFn(_w.x, _w.z) : 0;
    const top = (pose.z0 ?? RIDE) + BEAM_TOP_ABOVE_DATUM;
    _probe.set(_w.x, gnd + 1, _w.z, foot.x, 1, foot.y, pose.yaw);
    for (const bx of world.boxes) {
      if (!bx.enabled || bx.tag === 'mobile' || bx.tag === 'hook' || (ignore && ignore.has(bx))) continue;
      if (bx.load && bx.load.attached) continue;
      if (bx.cy + bx.hy < gnd + OBST_MIN_H || bx.cy - bx.hy > top) continue;
      if (obbXZ(_probe, bx)) return true;
    }
    return false;
  }

  _derive() {
    for (const b of this.beams) {
      b.ext = extOfY(b.y);
      b.detent = null;
      for (let k = 0; k < 3; k++) if (Math.abs(b.y - DETENT_Y[k]) <= CAPTURE) b.detent = DETENT_EXT[k];
      if (b.v > 1e-6) b.target = DETENT_EXT[DETENT_Y.findIndex((yd) => yd > b.y + CAPTURE)] ?? 1;
      else if (b.v < -1e-6) { let t = 0; for (let k = 0; k < 3; k++) if (DETENT_Y[k] < b.y - CAPTURE) t = DETENT_EXT[k]; b.target = t; }
      else b.target = b.detent;
    }
  }

  // ------------------------------------------------------------ supports
  /**
   * Support list for Stability.update (§4.2), C frame, reused objects:
   *   floats FL, FR, RL, RR: x = ±front/rear line, y = ±beam, h = G + 0.90 + e (− R_prev/k_g), k = 1
   *   tyres T1L … T5R: x = axle, y = ±1.18, h = ground + 1.30 (suspension locked outside ROAD), k = 0.3
   * g = contact height (world). Also updates floatWorld, areas, floatContact, tyresClear, floatsSet
   * (contacts judged against pose.z0/a/b, the Stability solver plane).
   * @param {{x,z,yaw,z0?,a?,b?}} pose
   * @param {number[]|null} settle   Settlement.s (m) per float
   * @param {number[]|null} floatR   last float reactions (N) → optional ground compliance, k_g = 20 MN/m.
   *   Fed back through a 0.25 s low-pass: the raw one-step-lag loop limit-cycles between the two
   *   diagonals (each step's reactions tip the next step's heights); the filtered loop settles on the
   *   coplanar equal-strain fixed point. [E]
   * @param {(x,z)=>number} [groundFn]  terrain height (defaults to the one passed to the last update/reset)
   * @param {number} [dt]  step (s) for the compliance filter
   */
  supports(pose, settle = null, floatR = null, groundFn = null, dt = 1 / 120) {
    const gf = groundFn || this._groundFn || (() => 0);
    if (groundFn) this._groundFn = groundFn;
    const sup = this._sup;
    const hasPlane = pose.z0 !== undefined;
    if (floatR) { const a = 1 - Math.exp(-dt / COMPLIANCE_TAU); for (let i = 0; i < 4; i++) this.Rf[i] += (Math.max(0, floatR[i]) - this.Rf[i]) * a; }
    let allSet = true, clear = true;
    for (let i = 0; i < 4; i++) {
      const s = sup[i], f = FLOATS[i], y = f.side * this.beams[i].y;
      carrierToWorld(pose, pose.yaw, f.x, y, _w);
      const gnd = gf(_w.x, _w.z);
      const comp = floatR ? this.Rf[i] / STABILITY.groundK : 0;
      const G = gnd + MATS[this.mats[i]].thickness - (settle ? settle[i] : 0) - comp;
      s.y = y; s.g = G; s.e = this.jacks[i].e; s.h = G + J0 + s.e;
      const fw = this.floatWorld[i]; fw.x = _w.x; fw.y = G; fw.z = _w.z;
      this.areas[i] = MATS[this.mats[i]].area;
      const contact = hasPlane ? pose.z0 + pose.a * s.x + pose.b * s.y - s.h < STABILITY.planeEps : false;
      if (contact && !this.floatContact[i] && this.jacks[i].v > 0) this.events.push({ type: 'touchdown', i, speed: this.jacks[i].v });
      this.floatContact[i] = contact;
      if (!contact || s.e <= 0) allSet = false;
    }
    for (let t = 4; t < sup.length; t++) {
      const s = sup[t];
      carrierToWorld(pose, pose.yaw, s.x, s.y, _w);
      s.g = gf(_w.x, _w.z); s.h = s.g + RIDE;
      if (hasPlane && pose.z0 + pose.a * s.x + pose.b * s.y - s.h < STABILITY.planeEps) clear = false;
    }
    this.floatsSet = hasPlane && allSet;
    this.tyresClear = hasPlane && clear;
    return sup;
  }

  // Pad bottom (world y) of float i for rendering, given the carrier datum
  // height at that float (world): datum − 0.90 − e.
  padBottom(i, datumY) { return datumY - J0 - this.jacks[i].e; }
}
