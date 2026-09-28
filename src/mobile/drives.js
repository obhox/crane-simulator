// AT-100 5.1 crane drives at 120 Hz (spec §3.2–§3.6): torque-limited slew with
// holding brake, free slew and turntable lock pin; cylinder-driven luff; the
// single-cylinder telescope (TeleBoom, boom.js); the hoist winch with drum
// layers, constant-power knee, relief stall and rope bookkeeping; and the
// vertical / lateral boom-deflection oscillators. Pure module (no three.js).
//
// Rope bookkeeping (§3.5): the winch controls S_paid, the rope paid off the
// drum. The fall length (head sheave → hook, the HoistSystem ropeLen target)
// is ℓ = (S_paid − dead(L))/n with dead(L) = L + 1.5 m, so telescoping out by
// ΔL raises the hook by ΔL/n (it can two-block) and telescoping in lowers it.

import { AT100, DRIVES, DEFLECTION } from './config.js';
import { TeleBoom, luffRate } from './boom.js';

const G = 9.81;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const SL = DRIVES.slew, LU = DRIVES.luff, HO = DRIVES.hoist, DR = DRIVES.drum;
const ROPE_TOTAL = AT100.hoist.ropeLen; // 250 m
const THETA_MIN = AT100.luff.minDeg * DEG, THETA_MAX = AT100.luff.maxDeg * DEG;
const NEUTRAL = 0.02;
// Lateral boom mode damping: DEFLECTION.zetaL is the bare structure (2 %); the
// hydraulic slewing gear (motor leakage, brake valves) that the lateral mode
// drives through the turntable adds ≈ 5 % [E] — without it a 52 m boom rang for
// > 40 s after every slew stop.
const ZETA_L = DEFLECTION.zetaL + 0.05;
// Slew speed-up ramp on the commanded speed [E, LICCON-like]: |dω/dt| ≤ ω_max/(3 + L/10)
// (≈ 4 s to 2 rpm at 11.5 m, ≈ 8 s at 52 m). Only speeding up is ramped: slowing
// down / stopping keeps the torque-limited behaviour the zone limiter is sized for.
const slewRampRate = (L) => SL.maxSpeed / (3 + L / 10);
// Tele-out soft stop before the hook limit [E]: the last TELE_SLOW m of boom travel
// before the anti-two-block switch run down to TELE_SLOW_MIN speed.
const TELE_SLOW = 0.6, TELE_SLOW_MIN = 0.25;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, t, r) => (v < t ? Math.min(v + r, t) : Math.max(v - r, t));
// cumulative drum layer capacities (m): 49.1 / 102.2 / 159.2 / 220.2 / 285.1
const LAYER_CUM = DR.layers.reduce((a, c) => (a.push((a[a.length - 1] || 0) + c), a), []);

// ------------------------------------------------------------ helpers (§3.2)
// Rotating-part properties about the slew axis for CW cwKg, boom angle theta,
// section extensions ext[5] (TeleBoom.ext) and boom length L:
//   inertia = 15,900·(0.63² + 2.0²) + 1,600·0.6² + m_cw·(3.18² + 0.69)
//             + Σ sections m_i·(u_i² + (11.3·cosθ)²/12) + head·u_h²      (kg·m²)
//   mu = Σ m_j·u_j (kg·m), for the tilt torque τ_tilt = g·mu·(a·sinψ − b·cosψ)
// Reproduces the §3.2 examples (3.4e6 at 52 m / R 30 with 35 t; 5.1e5 at 11.5 m).
export function rotatingProps(cwKg, theta, ext, L, out = { inertia: 0, mu: 0, mass: 0 }) {
  const b = AT100.bodies, P = AT100.pivot, c = Math.cos(theta);
  let I = b.upper.m * (b.upper.u * b.upper.u + b.upper.rg * b.upper.rg) + b.luffCyl.m * b.luffCyl.u * b.luffCyl.u
    + cwKg * (b.cw.u * b.cw.u + 0.69);
  let mu = b.upper.m * b.upper.u + b.luffCyl.m * b.luffCyl.u + cwKg * b.cw.u;
  let m = b.upper.m + b.luffCyl.m + cwKg;
  const ms = b.boomSection.m, half = (AT100.boom.sectionLen * c) ** 2 / 12;
  let p = 0;
  for (let i = 0; i <= AT100.boom.nTele; i++) {
    if (i > 0) p += AT100.boom.stroke * ext[i - 1];
    const u = P.u + (p + b.boomSection.offset) * c;
    I += ms * (u * u + half);
    mu += ms * u;
    m += ms;
  }
  const uh = P.u + L * c;
  I += b.head.m * uh * uh;
  mu += b.head.m * uh;
  m += b.head.m;
  out.inertia = I; out.mu = mu; out.mass = m;
  return out;
}

// Slew torque from carrier tilt (plane z = z0 + a·x_c + b·y_c): + increases ψ.
export const tiltTorque = (mu, a, b, psi) => G * mu * (a * Math.sin(psi) - b * Math.cos(psi));

// Rope force at the head (world): F = tension·n, n = unit head → hook.
//   tauRope  = ((head − axis) × F)·axisUp   (slew torque, + increases ψ)
//   fPerp    = F·d, d = h·sinθ − up·cosθ    (luff plane, + bends the boom down) — δv source (§3.6)
//   fSide    = F·left                       (+ toward the boom's left) — δl source
//   fAxial   = F·(h·cosθ + up·sinθ)
//   outOfPlaneDeg = rope angle out of the luff plane (SIDE PULL > 3° with the load grounded)
// boomAz = yaw + ψ (three.js rotation.y of the boom plane; h = (cos, 0, −sin)).
// axisUp: tilted slew-axis unit vector (default world up).
const UP = { x: 0, y: 1, z: 0 };
export function ropeLoads(head, hook, tension, axis, boomAz, theta, axisUp = UP, out = {}) {
  let nx = hook.x - head.x, ny = hook.y - head.y, nz = hook.z - head.z;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const Fx = tension * nx, Fy = tension * ny, Fz = tension * nz;
  const sx = head.x - axis.x, sy = head.y - (axis.y ?? head.y), sz = head.z - axis.z;
  // s × F
  const tx = sy * Fz - sz * Fy, ty = sz * Fx - sx * Fz, tz = sx * Fy - sy * Fx;
  out.tauRope = tx * axisUp.x + ty * axisUp.y + tz * axisUp.z;
  const hx = Math.cos(boomAz), hz = -Math.sin(boomAz), ct = Math.cos(theta), st = Math.sin(theta);
  out.fPerp = Fx * hx * st - Fy * ct + Fz * hz * st;
  const lx = -Math.sin(boomAz), lz = -Math.cos(boomAz); // left = up × h
  out.fSide = Fx * lx + Fz * lz;
  out.fAxial = (Fx * hx + Fz * hz) * ct + Fy * st;
  out.outOfPlaneDeg = Math.asin(clamp(Math.abs(nx * lx + nz * lz), 0, 1)) / DEG;
  return out;
}

// Deflection natural frequencies (rad/s): ω = sqrt(3·EI/(L³·0.24·m_boom)) (§3.6).
// The spec gives the vertical form; the lateral mode uses the same form with EIl.
export const deflectionOmega = (L, EI) => Math.sqrt((3 * EI) / (L * L * L * DEFLECTION.modalMass * AT100.boom.massKg));

export class MobileDrives {
  /** @param {{boom?:TeleBoom, k?:number}} [opts] */
  constructor(opts = {}) {
    this.boom = opts.boom || new TeleBoom(opts.k ?? 0);
    // slew (ψ + = toward the left; lever + right drives ψ negative)
    this.psi = 0; this.psiDot = 0; this.psiDDot = 0;
    this.slewTarget = 0; // ramped commanded slew speed (rad/s)
    this.freeSlew = false;
    this.pinned = false; // turntable lock pin
    this.brakeSlew = true;
    this.slewSlipping = false;
    this.slewTorque = 0;
    // luff
    this.theta = 0; this.thetaDot = 0; this.vCyl = 0;
    // hoist
    this.falls = 1;
    this.blockHeight = 1.0;
    this.sPaid = ROPE_TOTAL - 100;
    this.hookVel = 0; // m/s, + = hook up (winch-driven)
    this.lineVel = 0; // m/s at the drum, + = hoisting in
    this.fLine = 0; // N per fall
    this.lineSpeedMax = 0;
    this.layer = 1;
    this.relief = false; // line pull above 1.1 × 88 kN: hoist-up stalls
    this.reliefActive = false; // relief AND lever pushed up (squeal)
    this.twoBlock = false;
    this.lowerLimit = false;
    // deflection
    this.dv = 0; this.dvDot = 0; this.dl = 0; this.dlDot = 0;
    this.dvStatic = 0; this.dlStatic = 0;
    // commands actually applied (after perms / micro), for HUD / audio
    this.applied = { slew: 0, luff: 0, tele: 0, hoist: 0 };
    this.brakeEvents = []; // 'slew' when the holding brake engages (clunk) — read after update()
    this.events = []; // 'luffStop' | 'upperLimit' | 'lowerLimit' | 'relief' | 'unpinned' | 'pinning' | 'pinned' | 'pin' | 'unpin'
  }

  // --------------------------------------------------------------- state
  get L() { return this.boom.length; }
  get hoistSpeed() { return this.hookVel; }
  get ropeLenMin() { return AT100.hoist.hookLimit + this.blockHeight; } // hook-block top ≥ 2.0 m under the sheave
  get drumRope() { return ROPE_TOTAL - this.sPaid; }
  static dead(L) { return L + HO.deadExtra; }
  // fall length ℓ (sheave → hook) = (S_paid − dead(L))/n
  fallLength(L = this.L, n = this.falls) { return (this.sPaid - MobileDrives.dead(L)) / n; }
  // longest fall with 3 wraps left on the drum (lowering limit)
  ropeLenMax(L = this.L, n = this.falls) { return (ROPE_TOTAL - HO.minDrumRope - MobileDrives.dead(L)) / n; }
  // set S_paid for a given fall length (reset / reeving change keeps the hook where it is)
  setFallLength(len, L = this.L, n = this.falls) {
    this.sPaid = clamp(len * n + MobileDrives.dead(L), 0, ROPE_TOTAL - HO.minDrumRope);
    return this.fallLength(L, n);
  }
  // re-reeve: falls/block change with the hook at the same height when rope allows
  setReeving(falls, blockHeight, keepLen = this.fallLength()) {
    this.falls = falls;
    this.blockHeight = blockHeight;
    this.hookVel = 0;
    return this.setFallLength(Math.max(keepLen, this.ropeLenMin), this.L, falls);
  }

  /**
   * Reset to a static pose.
   * @param {{psi?:number, theta?:number, boomK?:number, ropeLen?:number|null, falls?:number, blockHeight?:number}} s
   */
  reset(s = {}) {
    if (s.boomK !== undefined) this.boom.setPinned(s.boomK);
    this.psi = s.psi ?? 0; this.psiDot = 0; this.psiDDot = 0; this.slewTarget = 0;
    this.theta = clamp(s.theta ?? 0, THETA_MIN, THETA_MAX); this.thetaDot = 0; this.vCyl = 0;
    this.falls = s.falls ?? this.falls;
    this.blockHeight = s.blockHeight ?? this.blockHeight;
    this.hookVel = 0; this.lineVel = 0;
    this.setFallLength(s.ropeLen ?? this.ropeLenMin + 1);
    this.dv = this.dvDot = this.dl = this.dlDot = 0;
    this.freeSlew = false; this.pinned = !!s.pinned; this.brakeSlew = true; this.slewSlipping = false;
    this.relief = this.reliefActive = false;
    this.brakeEvents.length = 0; this.events.length = 0;
  }

  // Turntable lock pin (§3.2): engages only with |ψ| < 0.5° and ψ̇ = 0 (brake set).
  setTurntablePin(on) {
    if (!on) {
      if (this.pinned) this.events.push('unpin');
      this.pinned = false;
      return { ok: true };
    }
    if (this.pinned) return { ok: true };
    const wrapped = this.psi - Math.round(this.psi / TAU) * TAU;
    if (Math.abs(wrapped) >= SL.pinMaxDeg * DEG) return { ok: false, reason: 'SLEW TO 0° TO PIN' };
    if (this.psiDot !== 0) return { ok: false, reason: 'STOP SLEWING TO PIN' };
    // the tapered pin centres the superstructure in its socket
    this.psi = Math.round(this.psi / TAU) * TAU;
    this.pinned = true;
    this.freeSlew = false;
    this.events.push('pin');
    return { ok: true };
  }
  setFreeSlew(on) {
    if (on && this.pinned) return { ok: false, reason: 'TURNTABLE PINNED' };
    this.freeSlew = !!on;
    return { ok: true };
  }

  /**
   * One 120 Hz step.
   * @param {number} dt
   * @param {{slew:number, tele:number, luff:number, hoist:number}} levers  slew +right, tele +out, luff +up, hoist +up
   * @param {{hoistUp:number, lower:number, luffUp:number, luffDown:number, teleOut:number, teleIn:number, slewL:number, slewR:number}} perm  RCL perms
   * @param {object} ctx
   *   powered      crane power on, no e-stop, mode CRANE (else: brakes hold, cylinders stop)
   *   eStop        e-stop (3× faster stop ramps)
   *   micro        micromove (10 % on every motion)
   *   inertia      slew inertia kg·m² (rotatingProps().inertia)
   *   extTorque    τ_rope + τ_tilt (+ τ_wind) in N·m, + increases ψ; the drive adds the −1.5e5·ψ̇ viscous term itself
   *   tension      HoistSystem.tensionFiltered (N, all falls) — line pull, speed knee, relief (or gross kg)
   *   tensionRaw   HoistSystem.tension (N) — optional, for the deflection source when fPerp is not given
   *   falls        reeved falls n
   *   util         RCL utilisation (luff speed factors)
   *   blockHeight  reeved block height (m) — hook limit
   *   fPerp, fSide rope force components (ropeLoads) for the deflection oscillators (N)
   *   hookGrounded, ropeDist   slack-rope stop: pay-out stops once the hook rests and the rope is 2.5 m slack
   */
  update(dt, levers, perm, ctx = {}) {
    this.brakeEvents.length = 0;
    this.events.length = 0;
    const powered = ctx.powered ?? true, eStop = !!ctx.eStop;
    const micro = ctx.micro ? SL.micro : 1;
    const stopMul = eStop ? 3 : 1;
    if (ctx.falls) this.falls = ctx.falls;
    if (ctx.blockHeight !== undefined) this.blockHeight = ctx.blockHeight;
    const n = this.falls;
    const pm = perm || {};
    const lev = levers || {};

    // ------------------------------------------------------ telescope (§3.4)
    const L0 = this.L;
    let tele = powered ? (lev.tele || 0) * micro : 0;
    // mechanical anti-two-block switch: no tele-out at the hook limit (also in bypass); tele-out
    // raises the hook by ΔL/n, so the last TELE_SLOW m of boom travel before it are slowed
    if (tele > 0) {
      const toLimitL = (this.fallLength(L0, n) - this.ropeLenMin - 0.02) * n; // boom travel left
      tele = toLimitL <= 0 ? 0 : Math.min(tele, clamp(toLimitL / TELE_SLOW, TELE_SLOW_MIN, 1)); // caps the speed; a slow lever passes
    }
    this.boom.update(dt, tele, pm);
    for (const e of this.boom.events) this.events.push(e);
    this.applied.tele = this.boom.cmd;
    const L = this.L;

    // ---------------------------------------------------------- slew (§3.2)
    const I = ctx.inertia > 0 ? ctx.inertia : 1e6;
    const ext = (ctx.extTorque || 0) - SL.viscous * this.psiDot;
    let lever = powered && !this.freeSlew && !this.pinned ? (lev.slew || 0) : 0;
    lever *= lever > 0 ? (pm.slewR ?? 1) : (pm.slewL ?? 1);
    this.applied.slew = lever;
    const target = -lever * SL.maxSpeed * micro; // lever right → clockwise from above → ψ decreasing
    const prevRate = this.psiDot;
    let drive = 0;
    this.slewSlipping = false;
    if (this.pinned) {
      // locked by the turntable pin: rigid
      drive = 0;
      this.brakeSlew = true;
      this.psiDot = 0;
    } else if (this.freeSlew && !eStop) {
      // slewing gear free: brake and drive released (weathervanes, follows side pull)
      this.brakeSlew = false;
    } else if (!powered) {
      // spring-applied holding brake
      this.brakeSlew = true;
      const need = -I * this.psiDot / dt - ext;
      drive = clamp(need, -SL.holdBrake, SL.holdBrake);
      if (Math.abs(need) > SL.holdBrake) this.slewSlipping = true;
    } else if (Math.abs(lever) < NEUTRAL) {
      if (Math.abs(this.psiDot) < SL.stopRate) {
        if (!this.brakeSlew) this.brakeEvents.push('slew');
        this.brakeSlew = true;
        const need = -I * this.psiDot / dt - ext;
        drive = clamp(need, -SL.holdBrake, SL.holdBrake);
        if (Math.abs(need) > SL.holdBrake) this.slewSlipping = true;
      } else {
        // lever released: decelerate with 0.8·τ_max (no overshoot through zero)
        const lim = SL.releaseDecel * SL.torqueMax;
        drive = clamp(-I * this.psiDot / dt - ext, -lim, lim);
      }
    } else {
      this.brakeSlew = false;
      // commanded speed with the speed-up ramp (from the actual speed when it is already turning
      // that way); slowing down and reversing through zero are not ramped
      let rt = this.slewTarget;
      if (rt * target <= 0) rt = 0;
      if (this.psiDot * target > 0 && Math.abs(this.psiDot) > Math.abs(rt)) rt = this.psiDot;
      if (Math.abs(target) <= Math.abs(rt)) rt = target;
      else rt += Math.sign(target) * Math.min(Math.abs(target) - Math.abs(rt), slewRampRate(L) * dt);
      this.slewTarget = rt;
      // speed-controlled hydraulic drive with torque limit (compensates external torques)
      const need = (I * (rt - this.psiDot)) / SL.response - ext;
      drive = clamp(need, -SL.torqueMax, SL.torqueMax);
    }
    if (Math.abs(lever) < NEUTRAL || this.pinned || this.freeSlew || !powered) this.slewTarget = this.psiDot;
    this.slewTorque = drive;
    if (!this.pinned) {
      this.psiDot += ((drive + ext) / I) * dt;
      if (this.brakeSlew && !this.slewSlipping && Math.abs(lever) < NEUTRAL && Math.abs(this.psiDot) < SL.stopRate) this.psiDot = 0;
      this.psi += this.psiDot * dt;
    }
    this.psiDDot = (this.psiDot - prevRate) / dt;

    // ---------------------------------------------------------- luff (§3.3)
    let luff = powered ? (lev.luff || 0) : 0;
    luff *= luff > 0 ? (pm.luffUp ?? 1) : (pm.luffDown ?? 1);
    const util = Math.max(0, ctx.util || 0);
    const f = luff > 0
      ? clamp(LU.upLoad.a - LU.upLoad.b * util, LU.upLoad.min, LU.upLoad.max) // slower up under load
      : clamp(LU.downLoad.a - LU.downLoad.b * util, LU.downLoad.min, LU.downLoad.max);
    let vT = luff * f * LU.cylSpeed * micro;
    // end damping within 3° of the stops
    const toTop = (THETA_MAX - this.theta) / DEG, toBot = (this.theta - THETA_MIN) / DEG;
    if (vT > 0) vT *= Math.max(LU.endDampMin, Math.min(1, toTop / LU.endDampDeg));
    if (vT < 0) vT *= Math.max(LU.endDampMin, Math.min(1, toBot / LU.endDampDeg));
    this.applied.luff = luff;
    this.vCyl = approach(this.vCyl, vT, LU.cylAccel * stopMul * dt);
    this.thetaDot = luffRate(this.theta, this.vCyl);
    this.theta += this.thetaDot * dt;
    if (this.theta >= THETA_MAX) {
      if (this.vCyl > 0 && Math.abs(luff) > 0.05) this.events.push('luffStop');
      this.theta = THETA_MAX; if (this.vCyl > 0) this.vCyl = 0; this.thetaDot = Math.min(0, this.thetaDot);
    } else if (this.theta <= THETA_MIN) {
      if (this.vCyl < 0 && Math.abs(luff) > 0.05) this.events.push('luffStop');
      this.theta = THETA_MIN; if (this.vCyl < 0) this.vCyl = 0; this.thetaDot = Math.max(0, this.thetaDot);
    }

    // --------------------------------------------------------- hoist (§3.5)
    const D = this.drumRope;
    let layer = LAYER_CUM.length;
    for (let i = 0; i < LAYER_CUM.length; i++) if (D <= LAYER_CUM[i]) { layer = i + 1; break; }
    this.layer = Math.max(1, layer);
    const pd = DR.barrel + (2 * this.layer - 1) * AT100.hoist.ropeDia; // pitch diameter of the current layer
    const T = ctx.tension ?? (ctx.gross !== undefined ? ctx.gross * G : 0);
    this.fLine = Math.max(0, T) / n;
    this.lineSpeedMax = HO.lineSpeed * (pd / HO.pdRef) * Math.min(1, HO.kneeN / Math.max(this.fLine, 1));
    const hookMax = this.lineSpeedMax / n;
    let hc = powered ? (lev.hoist || 0) : 0;
    hc *= hc > 0 ? (pm.hoistUp ?? 1) : (pm.lower ?? 1);
    // winch relief: above 1.1 × 88 kN line pull the hoist-up stalls (only protection against wrong reeving)
    const wasRelief = this.relief;
    this.relief = this.fLine > HO.reliefN;
    this.reliefActive = this.relief && (lev.hoist || 0) > 0.05 && powered;
    if (this.relief && !wasRelief) this.events.push('relief');
    if (this.relief && hc > 0) hc = 0;
    // limit slow zones (same pattern as the tower)
    let len = this.fallLength(L, n);
    const toHookLimit = len - this.ropeLenMin;
    if (hc > 0) hc *= clamp(toHookLimit / HO.slowZone, 0.12, 1);
    if (hc < 0) hc *= clamp((D - HO.minDrumRope) / 2, 0.1, 1);
    this.applied.hoist = hc;
    const hTarget = hc * hookMax * micro;
    const accel = Math.abs(hTarget) > Math.abs(this.hookVel) && Math.sign(hTarget) === Math.sign(this.hookVel || hTarget) ? HO.hookAccel : HO.hookDecel;
    this.hookVel = approach(this.hookVel, hTarget, accel * stopMul * dt);
    // slack rope: stop paying out once the hook rests and the rope is well slack
    if (this.hookVel < 0 && ctx.hookGrounded && ctx.ropeDist !== undefined && len > ctx.ropeDist + 2.5) this.hookVel = 0;
    this.lineVel = this.hookVel * n;
    this.sPaid -= this.lineVel * dt; // hoisting up: dS_paid/dt = −v_line
    len = this.fallLength(L, n);
    const wasTop = this.twoBlock;
    if (len <= this.ropeLenMin && this.hookVel > 0) {
      this.setFallLength(this.ropeLenMin, L, n);
      this.hookVel = 0; this.lineVel = 0;
    }
    if (this.drumRope < HO.minDrumRope && this.hookVel < 0) {
      this.sPaid = ROPE_TOTAL - HO.minDrumRope;
      this.hookVel = 0; this.lineVel = 0;
    }
    this.twoBlock = this.fallLength(L, n) <= this.ropeLenMin + 0.02;
    // 'upperLimit' = hoisted into the hook limit (a tele-out stop there is a normal limiter action)
    if (this.twoBlock && !wasTop && (lev.hoist || 0) > 0.05) this.events.push('upperLimit');
    const wasLow = this.lowerLimit;
    this.lowerLimit = this.drumRope <= HO.minDrumRope + 0.02;
    if (this.lowerLimit && !wasLow && (lev.hoist || 0) < -0.05) this.events.push('lowerLimit');

    // --------------------------------------------------- deflection (§3.6)
    const L3 = L * L * L;
    const fPerp = ctx.fPerp ?? (ctx.tensionRaw ?? T) * Math.cos(this.theta);
    const fSide = ctx.fSide ?? 0;
    this.dvStatic = (fPerp * L3) / (3 * DEFLECTION.EIv);
    this.dlStatic = (fSide * L3) / (3 * DEFLECTION.EIl);
    const wv = deflectionOmega(L, DEFLECTION.EIv), wl = deflectionOmega(L, DEFLECTION.EIl);
    // semi-implicit Euler (ω·dt ≤ 0.31 at 11.5 m: stable)
    this.dvDot += (wv * wv * (this.dvStatic - this.dv) - 2 * DEFLECTION.zetaV * wv * this.dvDot) * dt;
    this.dv += this.dvDot * dt;
    const [vMin, vMax] = DEFLECTION.clampV;
    if (this.dv < vMin || this.dv > vMax) { this.dv = clamp(this.dv, vMin, vMax); this.dvDot = 0; }
    this.dlDot += (wl * wl * (this.dlStatic - this.dl) - 2 * ZETA_L * wl * this.dlDot - DEFLECTION.slewCoupling * this.psiDDot * L) * dt;
    this.dl += this.dlDot * dt;
    if (Math.abs(this.dl) > DEFLECTION.clampL) { this.dl = clamp(this.dl, -DEFLECTION.clampL, DEFLECTION.clampL); this.dlDot = 0; }
  }

  // Slew speed in rpm (display: + = clockwise / right, like the tower HUD)
  get slewRpm() { return (-this.psiDot * 60) / TAU; }
}
