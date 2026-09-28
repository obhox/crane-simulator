// AT-100 5.1 rated capacity limiter (RCL / LMI), spec §5. Pure module.
//
// What it monitors: gross hook load from the load cell (HoistSystem
// tensionFiltered/g, block and rigging included), radius incl. deflection,
// boom length and pin state, angle, head wind, and the CONFIGURED set-up.
// What it does NOT monitor, by design as on real cranes [S12]: whether the
// configured counterweight is actually fitted (the Blanchardstown case [S19]),
// how many falls are actually reeved (only the winch relief protects), mats
// and ground. Support ≠ config, tilt, wind and tyres-not-clear are monitored
// but only WARN — they never cut a motion.
//
// Usage (once per 120 Hz step, before MobileDrives.update):
//   rcl.update(dt, snap); drives.update(dt, levers, rcl.perm, ctx)
// snap = {
//   grossKg, R (m, head radius incl. deflection), L (m), pinnedK (0..11 | null = between pins),
//   thetaG (rad, gravity-referenced boom angle), luffDeg (frame-relative θ in deg, for the luff stops),
//   headPos {x,y,z} (head sheave, world), hookPos {x,y,z}, loadPos {x,y,z} | null, loadExt (m, half extent in z),
//   loadAttached, loadGrounded, hookGrounded, twoBlock (ℓ at the hook limit), drumRope (m) | lowerLimit,
//   beamsActual [4 × detent 0|50|100|null (off detent) or {detent}], floatsSet (all 4 floats carrying),
//   floatsInContact (count), tyresActive (any tyre carrying), floats [{light, lifted}] | floatLight, floatLifted,
//   tiltDeg (max |pitch|,|roll|), wind (head anemometer 3-s gust, m/s), loadMassKg, loadFaceArea (m²),
//   levers {slew, tele, luff, hoist}, power, eStop, mode ('CRANE' | ...), turntablePinned,
//   zoneLimiter (road-zone setting, default on), axis {x, z} (slew axis, world), yaw, psi, psiDot, inertia,
//   sidePullDeg (ropeLoads().outOfPlaneDeg), relief (winch relief active), t (sim time, for the snapshot)
// }

import { RCL_T, RCL_COLOURS, TOWER_ZONE, HOOK_BLOCKS, DRIVES, AT100 } from './config.js';
import { SITE } from '../config.js';
import { lookup, permitted, telescopableLoad, windPermLoad } from './charts.js';

const DEG = Math.PI / 180;
const NEUTRAL = 0.05; // same as Input.anyLeverOffNeutral
const THETA_MAX_DEG = AT100.luff.maxDeg, THETA_MIN_DEG = AT100.luff.minDeg;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const PERM_KEYS = ['hoistUp', 'lower', 'luffUp', 'luffDown', 'teleOut', 'teleIn', 'slewL', 'slewR'];
// warnings that count as "mismatch" time (setup KPI, §8.5); wind has its own KPI
const MISMATCH = ['SUPPORT_CONFIG', 'TILT', 'TYRES_NOT_CLEAR'];
// warnings with the audible short horn every 5 s (§8.9)
const SHORT_HORN = ['SUPPORT_CONFIG', 'TILT', 'WIND'];

export const DEFAULT_CONFIG = Object.freeze({ mode: 'outriggers', base: 100, cwKg: 0, block: 'ball', confirmed: false });

// Short code, e.g. "OR B100 CW35.0 n1 BALL" / "TY CW0.0 n1 BALL"
export function shortCode(cfg) {
  if (!cfg) return '—';
  const b = HOOK_BLOCKS[cfg.block];
  const cw = `CW${(cfg.cwKg / 1000).toFixed(1)}`;
  return `${cfg.mode === 'tyres' ? 'TY' : `OR B${cfg.base}`} ${cw} n${b ? b.falls : '?'} ${String(cfg.block).toUpperCase()}`;
}
export const sameConfig = (a, b) => !!a && !!b && a.mode === b.mode && (a.mode === 'tyres' || a.base === b.base) && a.cwKg === b.cwKg && a.block === b.block;

// detent of one beam from the snapshot (detent label, {detent}, or a 0/0.5/1 MobileStart-style number)
function detentOf(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v.detent ?? null;
  if (v === 0 || v === 50 || v === 100) return v;
  if (Math.abs(v - 1) < 0.01) return 100;
  if (Math.abs(v - 0.5) < 0.01) return 50;
  if (Math.abs(v) < 0.01) return 0;
  return null;
}

export class RCL {
  constructor(cfg = DEFAULT_CONFIG) {
    this.config = { ...DEFAULT_CONFIG, ...cfg };
    this.state = 'off'; // 'off' | 'noconfig' | 'blue' | 'ok' | 'warn' | 'stop'
    this.ratio = 0; // gross / cap (Infinity beyond the chart)
    this.capKg = 0;
    this.grossKg = 0;
    this.netKg = 0;
    this.info = null; // charts.lookup() result + wind / tele info (HUD)
    this.perm = Object.fromEntries(PERM_KEYS.map((k) => [k, 0]));
    this.warnings = new Set(); // SUPPORT_CONFIG TILT WIND TYRES_NOT_CLEAR FLOAT_LIGHT LIFTED SIDE_PULL HOIST_OVERLOAD TELE_NOT_PINNED RECONFIRM BYPASS
    this.stops = new Set(); // POWER NO_CONFIG NOT_PERMITTED LMB BLOCK RANGE RMIN TOWER_ZONE ROAD_ZONE TELE_LOAD HOOK_LIMIT LOWER_LIMIT LUFF_MAX LUFF_MIN PINNED
    this.counters = {
      lmiTrips: 0, twoBlockCount: 0, warnTime: 0, bypassUsed: 0, configChanges: 0,
      mismatchTime: 0, mismatchWarnTime: 0, warnTimes: {}, firstLiftSnapshot: null,
    };
    this.events = []; // 'lmiTrip' | 'upperLimit' | 'configChanged' | 'mismatch' | 'bypass' | 'stopReleased' (cleared each update)
    this.stopLatched = false;
    this.stopTime = 0;
    this.hornMuted = false;
    this.mismatchMuted = false;
    this.bypass = false;
    this.bypassTime = 0;
    this.reconfirmReason = '';
    this.alarm = { beep: false, horn: false, shortHorn: false };
    this.zone = { tower: false, towerScale: 1, road: false, roadDist: 99 };
    this.tyresOnly = false;
    this._beepT = 0;
    this._shortT = 0;
    this._prevTwoBlock = false;
    this._prevGrounded = true;
    this._prevWarn = new Set();
    this._powered = false;
  }

  get shortCode() { return shortCode(this.config); }
  get colour() { return RCL_COLOURS[this.state === 'stop' ? 'stop' : this.state === 'warn' ? 'warn' : this.state === 'blue' ? 'blue' : 'ok']; }
  get confirmed() { return !!this.config.confirmed; }
  get permitted() { return permitted(this.config); }

  // Set the pre-filled config without the gate (job start / reset; may be wrong on purpose, e.g. M5).
  // powered = the crane power is already on (no power-on edge, so a confirmed config stays confirmed).
  reset(cfg = this.config, powered = false) {
    this.config = { ...DEFAULT_CONFIG, ...cfg };
    this._powered = !!powered;
    this.stopLatched = false; this.stopTime = 0; this.hornMuted = false; this.mismatchMuted = false;
    this.bypass = false; this.bypassTime = 0; this.reconfirmReason = '';
    this.warnings.clear(); this.stops.clear(); this.events.length = 0;
    this._prevTwoBlock = false; this._prevGrounded = true; this._prevWarn.clear();
  }
  resetCounters() {
    Object.assign(this.counters, { lmiTrips: 0, twoBlockCount: 0, warnTime: 0, bypassUsed: 0, configChanges: 0, mismatchTime: 0, mismatchWarnTime: 0, warnTimes: {}, firstLiftSnapshot: null });
  }

  // Crane power on: the config dialog opens pre-filled with the last config; OK / ENTER confirms.
  // update() calls this on the rising edge of snap.power (calling it again is harmless).
  powerOn() { this.config.confirmed = false; }
  // Engine stop / power off: the emergency bypass resets [S12].
  powerOff() { if (this.bypass) this.setBypass(false); }

  // Reconfiguration gate [S14]: utilisation < 20 % AND hook load ≤ 0.5 t. The
  // load is taken NET of the configured block: with the gross the 700 kg hb90
  // could never be reconfigured, and the LICCON rule refers to the hook load.
  canReconfigure() {
    // beyond the chart (boom on its rest at R 9.5 m, cap 0 → ratio ∞) with an empty hook the
    // utilisation is undefined, not high: configuring there is the normal first step (Phase 2)
    const offChart = !(this.capKg > 0) && this.netKg <= RCL_T.reconfigKg;
    if (this.ratio >= RCL_T.reconfigRatio && !offChart) return { ok: false, reason: `UTILISATION ${Math.round(Math.min(this.ratio, 9.99) * 100)} % ≥ 20 %` };
    if (this.netKg > RCL_T.reconfigKg) return { ok: false, reason: `HOOK LOAD ${(this.netKg / 1000).toFixed(1)} t > 0.5 t` };
    return { ok: true };
  }

  // Select a config (the dialog). Leaves it unconfirmed; confirm() arms it.
  configure(cfg) {
    const next = { ...this.config, ...cfg, confirmed: false };
    const p = permitted(next);
    if (!p.ok) return { ok: false, reason: p.reason || 'CONFIG NOT PERMITTED' };
    const changed = !sameConfig(next, this.config);
    if (changed) {
      const g = this.canReconfigure();
      if (!g.ok) return { ok: false, reason: `RECONFIGURATION BLOCKED: ${g.reason}` };
    }
    this.config = next;
    if (changed) { this.counters.configChanges++; this.events.push('configChanged'); }
    return { ok: true, changed };
  }
  confirm() {
    const p = permitted(this.config);
    if (!p.ok) return { ok: false, reason: p.reason || 'CONFIG NOT PERMITTED' };
    this.config.confirmed = true;
    this.reconfirmReason = '';
    return { ok: true };
  }
  // e.g. after re-reeving: 'REEVING CHANGED — CONFIRM CONFIG'
  requireConfirm(reason = 'CONFIRM CONFIG') {
    this.config.confirmed = false;
    this.reconfirmReason = reason;
  }

  // M: mute the STOP horn (only after 5 s; re-arms on a new STOP) and the mismatch audible.
  mute() {
    let ok = false;
    if (this.state === 'stop' && this.stopTime >= RCL_T.hornMuteAfter) { this.hornMuted = true; ok = true; }
    if (this.warnings.size) { this.mismatchMuted = true; ok = true; }
    return ok ? { ok: true } : { ok: false, reason: this.state === 'stop' ? 'HORN MUTE AFTER 5 s' : 'NOTHING TO MUTE' };
  }

  // EN 13000 emergency bypass (Ctrl+Shift+B, setting allowBypass) [S12]: 0.15× on all
  // motions, RCL ignored, hook limit and mechanical limits still active; resets
  // after 30 min sim time or engine stop; KPI critical.
  setBypass(on, allowed = true) {
    if (on) {
      if (!allowed) return { ok: false, reason: 'BYPASS NOT ALLOWED (settings)' };
      if (!this.bypass) { this.bypass = true; this.bypassTime = 0; this.counters.bypassUsed++; this.events.push('bypass'); }
      return { ok: true };
    }
    this.bypass = false;
    this.bypassTime = 0;
    return { ok: true };
  }

  update(dt, snap) {
    this.events.length = 0;
    const cfg = this.config;
    const S = snap || {};
    const lev = S.levers || {};
    const neutral = Math.abs(lev.slew || 0) <= NEUTRAL && Math.abs(lev.tele || 0) <= NEUTRAL
      && Math.abs(lev.luff || 0) <= NEUTRAL && Math.abs(lev.hoist || 0) <= NEUTRAL;
    // crane power switched on (P, incl. after an e-stop reset) → the config must be confirmed again;
    // a mode change (SETUP → CRANE) is not a power cycle
    const powerSw = S.power !== false && !S.eStop;
    if (powerSw && !this._powered) this.powerOn();
    else if (!powerSw && this._powered) this.powerOff();
    this._powered = powerSw;
    const powered = powerSw && (S.mode ?? 'CRANE') === 'CRANE';

    // ------------------------------------------------ measured quantities
    const gross = Math.max(0, S.grossKg || 0);
    const block = HOOK_BLOCKS[cfg.block] || HOOK_BLOCKS.ball;
    const L = S.L ?? AT100.boom.baseLen, R = S.R ?? 0;
    const pinnedK = S.pinnedK ?? null;
    const lk = lookup(cfg, L, R, pinnedK);
    const teleKg = telescopableLoad(L);
    const vPerm = windPermLoad(L, S.loadMassKg || 0, S.loadFaceArea || 0);
    this.grossKg = gross;
    this.netKg = Math.max(0, gross - block.massKg);
    this.capKg = lk.capKg;
    this.ratio = lk.capKg > 0 ? gross / lk.capKg : Infinity;
    const beyondRange = lk.capKg <= 0 || (lk.rmax > 0 && R > lk.rmax + 1e-9);
    this.info = { ...lk, shortCode: this.shortCode, teleKg, windPerm: vPerm, unpinned: pinnedK === null, block: cfg.block };
    const suspended = S.suspended ?? (S.loadAttached ? !S.loadGrounded : !S.hookGrounded);

    // --------------------------------------------- STOP latch with hysteresis
    const armed = powered && cfg.confirmed && !this.bypass;
    // Empty hook outside the working range (e.g. the boom on its rest at R 9.5 m, cap 0): a
    // working-range limit (RANGE caps luff-down / tele-out below), not an overload. It must not
    // latch an LMB STOP, or the operator luffing up off the rest would be stopped the moment the
    // head enters the chart (Phase-2 integration).
    const rangeEmpty = beyondRange && this.netKg <= RCL_T.reconfigKg;
    if (armed) {
      if (this.stopLatched && rangeEmpty && !S.loadAttached) this.stopLatched = false;
      if (!this.stopLatched && this.ratio >= RCL_T.stop && !(rangeEmpty && !S.loadAttached)) {
        this.stopLatched = true; this.stopTime = 0; this.hornMuted = false;
        this.counters.lmiTrips++; this.events.push('lmiTrip');
      } else if (this.stopLatched && this.ratio < RCL_T.release && neutral) {
        // STOP releases only below 98 % AND with all levers neutral [S9]
        this.stopLatched = false; this.events.push('stopReleased');
      }
    } else if (!powered) this.stopLatched = false;
    if (this.stopLatched) this.stopTime += dt;

    // ------------------------------------------------------------- state
    if (!powered) this.state = 'off';
    else if (!cfg.confirmed) this.state = 'noconfig';
    else if (this.stopLatched || (rangeEmpty && !S.loadAttached)) this.state = 'stop';
    else if (this.ratio >= RCL_T.warn) this.state = 'warn';
    else if (this.ratio < RCL_T.blueRatio || gross < RCL_T.blueKg) this.state = 'blue';
    else this.state = 'ok';
    if (this.state === 'warn') this.counters.warnTime += dt;

    // ------------------------------------------------- permission matrix
    const p = this.perm, stops = this.stops;
    stops.clear();
    const cap = (k, v) => { if (v < p[k]) p[k] = v; };
    const capAll = (v) => { for (const k of PERM_KEYS) cap(k, v); };
    for (const k of PERM_KEYS) p[k] = 1;
    const overTele = gross > teleKg;

    if (!powered) { capAll(0); stops.add('POWER'); }
    else if (this.bypass) {
      capAll(RCL_T.bypassScale);
    } else {
      if (!cfg.confirmed) {
        // 'noconfig': only lower and tele-in (tele-in still needs gross ≤ T_tel)
        for (const k of ['hoistUp', 'luffUp', 'luffDown', 'teleOut', 'slewL', 'slewR']) cap(k, 0);
        stops.add('NO_CONFIG');
      }
      if (!lk.ok) {
        cap('hoistUp', 0); cap('luffDown', 0); cap('teleOut', 0);
        stops.add('NOT_PERMITTED');
      }
      if (this.stopLatched) {
        cap('hoistUp', 0); cap('luffDown', 0); cap('teleOut', 0);
        // luff-up reduces the radius, but lifting a grounded load by luffing is not permitted [S9];
        // beyond Rmax luff-up is the way back into the chart
        if (!suspended && !beyondRange) cap('luffUp', 0);
        stops.add('LMB');
      }
      if (gross > block.ratedKg) stops.add('BLOCK');
      // beyond the working range nothing may be lifted (the RCL cannot know what hangs there)
      if (beyondRange) { cap('hoistUp', 0); cap('luffDown', 0); cap('teleOut', 0); stops.add('RANGE'); }
      if (R < lk.rmin - 1e-9) { cap('luffUp', 0); stops.add('RMIN'); }
      if (overTele) { cap('teleOut', 0); cap('teleIn', 0); stops.add('TELE_LOAD'); }
      this.workingRange(S, L, R);
    }
    if (powered) {
      // mechanical limits: also active in bypass
      if (S.twoBlock) { cap('hoistUp', 0); cap('luffDown', 0); cap('teleOut', 0); stops.add('HOOK_LIMIT'); }
      const lowLimit = S.lowerLimit ?? (S.drumRope !== undefined && S.drumRope <= DRIVES.hoist.minDrumRope + 0.02);
      if (lowLimit) { cap('lower', 0); stops.add('LOWER_LIMIT'); }
      const luffDeg = S.luffDeg ?? (S.thetaG ?? 0) / DEG;
      if (luffDeg >= THETA_MAX_DEG - 1e-3) { cap('luffUp', 0); stops.add('LUFF_MAX'); }
      if (luffDeg <= THETA_MIN_DEG + 1e-3) { cap('luffDown', 0); stops.add('LUFF_MIN'); }
      if (S.turntablePinned) { cap('slewL', 0); cap('slewR', 0); stops.add('PINNED'); }
    }

    // ---------------------------------------------- counters and warnings
    const top = !!S.twoBlock;
    if (top && !this._prevTwoBlock && ((lev.hoist || 0) > NEUTRAL || (lev.tele || 0) > NEUTRAL)) {
      this.counters.twoBlockCount++; this.events.push('upperLimit');
    }
    this._prevTwoBlock = top;
    if (this.bypass) {
      this.bypassTime += dt;
      if (this.bypassTime >= RCL_T.bypassMaxS) this.setBypass(false);
    }
    this.updateWarnings(dt, S, vPerm, suspended);

    // first lift-off (the load goes from grounded to suspended for the first time)
    if (S.loadAttached) {
      if (this._prevGrounded && !S.loadGrounded && !this.counters.firstLiftSnapshot) {
        this.counters.firstLiftSnapshot = {
          t: S.t ?? null, config: { ...cfg }, shortCode: this.shortCode, grossKg: gross, R, L, pinnedK, ratio: this.ratio,
          warnings: [...this.warnings], beams: (S.beamsActual || []).map(detentOf), tiltDeg: S.tiltDeg ?? 0,
          floatsSet: S.floatsSet ?? null, tyresActive: !!S.tyresActive, bypass: this.bypass,
        };
      }
      this._prevGrounded = !!S.loadGrounded;
    } else this._prevGrounded = true;

    // ------------------------------------------------------------ alarms
    this._beepT = this.state === 'warn' ? (this._beepT + dt) % (RCL_T.beepOn + RCL_T.beepOff) : 0;
    this.alarm.beep = this.state === 'warn' && this._beepT < RCL_T.beepOn;
    this.alarm.horn = this.state === 'stop' && this.stopLatched && !this.hornMuted;
    this.alarm.shortHorn = false;
    if (powered && !this.mismatchMuted && SHORT_HORN.some((w) => this.warnings.has(w))) {
      this._shortT -= dt;
      if (this._shortT <= 0) { this.alarm.shortHorn = true; this._shortT = 5; }
    } else this._shortT = 0;
  }

  // §5.1 working-range limiter: tower-crane zone (ceiling) and road zone.
  workingRange(S, L, R) {
    const p = this.perm, stops = this.stops;
    const cap = (k, v) => { if (v < p[k]) p[k] = v; };
    const head = S.headPos, axis = S.axis;
    this.zone.tower = false; this.zone.towerScale = 1; this.zone.road = false; this.zone.roadDist = 99;
    if (!head) return;
    const th = S.thetaG ?? 0, sT = Math.sin(th), cT = Math.cos(th);
    const Z = TOWER_ZONE;
    const inZone = (x, z) => Math.hypot(x - Z.cx, z - Z.cz) < Z.r;
    const violates = (x, z, top) => inZone(x, z) && top > Z.ceiling;
    const headTop = head.y + Z.headTopAboveSheave;
    const hx = axis ? head.x - axis.x : 0, hz = axis ? head.z - axis.z : 0, hR = Math.hypot(hx, hz) || 1e-9;
    const ux = hx / hR, uz = hz / hR; // horizontal radial unit (head direction from the axis)

    // tower zone: inside 63 m of the mast the head top stays ≤ 44.2 m
    if (inZone(head.x, head.z)) {
      this.zone.tower = true;
      const s = clamp((Z.ceiling - headTop) / Z.band, 0, 1);
      this.zone.towerScale = s;
      cap('luffUp', s);
      if (th > 0) cap('teleOut', s); // telescoping raises the head only above horizontal
      if (s < 1) stops.add('TOWER_ZONE');
    }
    if (axis) {
      // slew toward the zone above the ceiling: 2° lookahead
      const la = Z.slewLookaheadDeg * DEG, c = Math.cos(la), s = Math.sin(la);
      if (!inZone(head.x, head.z) && headTop > Z.ceiling) {
        // rotation.y by +la (slew left) / −la (slew right) about the axis
        if (inZone(axis.x + hx * c + hz * s, axis.z - hx * s + hz * c)) { cap('slewL', 0); stops.add('TOWER_ZONE'); }
        if (inZone(axis.x + hx * c - hz * s, axis.z + hx * s + hz * c)) { cap('slewR', 0); stops.add('TOWER_ZONE'); }
      }
      // radial motions carrying the head horizontally INTO the zone while above the ceiling
      // (lookahead 1° luff / 0.3 m tele); inside the zone the continuous ceiling scaling governs
      if (!inZone(head.x, head.z)) {
        const dth = 1 * DEG, dL = 0.3;
        const look = (key, dR, dH) => {
          if (violates(head.x + ux * dR, head.z + uz * dR, headTop + dH)) { cap(key, 0); stops.add('TOWER_ZONE'); }
        };
        look('luffUp', -L * sT * dth, L * cT * dth);
        look('luffDown', L * sT * dth, -L * cT * dth);
        look('teleOut', cT * dL, sT * dL);
        look('teleIn', -cT * dL, -sT * dL);
      }
    }

    // road zone: head, hook and load stay at z ≥ SITE.zoneLimitZ (tower Safety logic)
    if (S.zoneLimiter === false || !axis) return;
    const zLimit = SITE.zoneLimitZ;
    const hook = S.hookPos || head, load = S.loadPos;
    const minZ = Math.min(head.z, hook.z, load ? load.z - (S.loadExt || 0) : Infinity);
    const d = minZ - zLimit;
    this.zone.roadDist = d;
    // slow-down band sized from the slew stopping distance (0.8·τ_max deceleration)
    const I = S.inertia > 0 ? S.inertia : 2e6;
    const aSlew = (DRIVES.slew.releaseDecel * DRIVES.slew.torqueMax) / I;
    const slow = 4 + 1.5 * ((R * (S.psiDot || 0) ** 2) / (2 * aSlew));
    const k = clamp(d / slow, 0, 1);
    // head z = axis.z + R·uz. Slew left (ψ+): dz/dψ = −R·ux ... from rotation.y: dz = −hx·dψ
    const dzLeft = -hx, dzRight = hx;
    const dzOut = uz; // radius increase (luff down, tele out) moves the head by uz per m
    const toward = (dz) => dz < -1e-6;
    const scale = (key, dz) => { if (toward(dz)) cap(key, d <= 0 ? 0 : k); };
    scale('slewL', dzLeft); scale('slewR', dzRight);
    scale('luffDown', dzOut); scale('luffUp', -dzOut);
    scale('teleOut', dzOut * cT); scale('teleIn', -dzOut * cT);
    if (d < slow && (toward(dzLeft) || toward(dzRight) || toward(dzOut) || toward(-dzOut))) { this.zone.road = true; stops.add('ROAD_ZONE'); }
  }

  updateWarnings(dt, S, vPerm, suspended) {
    const w = this.warnings, cfg = this.config;
    w.clear();
    // SUPPORT ≠ CONFIG: smallest actual beam detent < configured base, any beam off detent,
    // floats not set on an outrigger config, or floats in contact on a tyres config
    if (cfg.mode === 'outriggers') {
      const det = (S.beamsActual || []).map(detentOf);
      const offDetent = det.some((d) => d === null);
      const minDet = det.length ? Math.min(...det.map((d) => (d === null ? -1 : d))) : cfg.base;
      if (det.length && (offDetent || minDet < cfg.base)) w.add('SUPPORT_CONFIG');
      if (S.floatsSet === false) w.add('SUPPORT_CONFIG');
      if (S.tyresActive) w.add('TYRES_NOT_CLEAR');
    } else if ((S.floatsInContact || 0) > 0) w.add('SUPPORT_CONFIG');
    if ((S.tiltDeg || 0) > RCL_T.tiltWarnDeg) w.add('TILT');
    if ((S.wind || 0) > vPerm) w.add('WIND');
    const floats = S.floats || [];
    if (S.floatLight || floats.some((f) => f && f.light)) w.add('FLOAT_LIGHT');
    if (S.floatLifted || floats.some((f) => f && f.lifted)) w.add('LIFTED');
    if (S.loadAttached && !suspended && (S.sidePullDeg || 0) > RCL_T.sidePullDeg) w.add('SIDE_PULL');
    if (S.relief) w.add('HOIST_OVERLOAD');
    if ((S.pinnedK ?? null) === null) w.add('TELE_NOT_PINNED');
    if (this.reconfirmReason && !cfg.confirmed) w.add('RECONFIRM');
    if (this.bypass) w.add('BYPASS');

    // counters / events: time per warning, mismatch time, onset events
    const c = this.counters;
    let mismatch = false, fresh = false;
    for (const k of w) {
      c.warnTimes[k] = (c.warnTimes[k] || 0) + dt;
      if (MISMATCH.includes(k)) mismatch = true;
      if (!this._prevWarn.has(k) && (MISMATCH.includes(k) || k === 'WIND')) fresh = true;
    }
    if (mismatch) { c.mismatchTime += dt; c.mismatchWarnTime = c.mismatchTime; }
    if (fresh) { this.events.push('mismatch'); this.mismatchMuted = false; } // a new event re-arms the audible
    this._prevWarn.clear();
    for (const k of w) this._prevWarn.add(k);
  }
}
