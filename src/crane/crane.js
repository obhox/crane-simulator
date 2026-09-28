import * as THREE from 'three';
import { CRANE, REEVING, SLEW_MODES, G, AIR_DENSITY } from '../config.js';
import { clamp, approach } from '../util/math.js';

// Crane mechanics: VFD drives (slew, trolley, hoist) with realistic ramps,
// torque-limited slewing against inertia + rope + wind torques, and
// structural dynamics (jib vertical deflection and lateral vibration).

const _w = { x: 0, z: 0 };

export class CraneSim {
  constructor(wind) {
    this.wind = wind;
    this.slew = 0.35; // θ (rad), rotation about +y
    this.slewRate = 0; // dθ/dt
    this.slewAccel = 0;
    this.trolley = 18;
    this.trolleyVel = 0;
    this.ropeLen = 20;
    this.hoistVel = 0; // + = hook going up (rope shortening)
    this.falls = 2;
    this.slewMode = 1; // index into SLEW_MODES
    this.micromove = false;
    this.freeSlew = false;
    this.power = false;
    this.brakeSlew = true;
    this.brakeEvents = []; // for audio (clunks)
    // structure
    this.pitch = 0; this.pitchVel = 0;
    this.lat = 0; this.latVel = 0;
    // telemetry
    this.slewTorque = 0;
    this.windTorque = 0;
    this.ropeTorque = 0;
    this.hoistBandSpeed = 1;
    this.hoistBand = 0;
    this.slewSlipping = false;
  }

  get reeving() { return REEVING[this.falls]; }
  get ropeLenMin() { return CRANE.hookUpperClearance + CRANE.hookBlockHeight; }
  get ropeLenMax() { return CRANE.mastTop + CRANE.jibBottomY - CRANE.sheaveDrop + 1.0; }

  // world position of the trolley sheave (rope exit) → out
  sheavePosition(out, r = this.trolley) {
    const px = r - CRANE.jibRootX;
    const py = -CRANE.sheaveDrop;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    let x = px * cp + py * sp;
    const y = -px * sp + py * cp;
    const cb = Math.cos(this.lat), sb = Math.sin(this.lat);
    let z = -x * sb;
    x = x * cb;
    x += CRANE.jibRootX;
    const yy = y + CRANE.jibBottomY + CRANE.mastTop;
    const ct = Math.cos(this.slew), st = Math.sin(this.slew);
    out.set(x * ct + z * st, yy, -x * st + z * ct);
    return out;
  }

  // jib horizontal unit axis
  jibAxis(out) {
    return out.set(Math.cos(this.slew), 0, -Math.sin(this.slew));
  }

  windTorqueOnJib() {
    this.wind.velocityAt(CRANE.mastTop + 3, _w);
    const ux = Math.cos(this.slew), uz = -Math.sin(this.slew);
    const along = _w.x * ux + _w.z * uz;
    const px = _w.x - along * ux, pz = _w.z - along * uz; // perpendicular component
    const sp = Math.hypot(px, pz);
    const k = 0.5 * AIR_DENSITY * 1.3 * sp;
    const fx = k * px, fz = k * pz; // force per m² of projected area
    const jibMoment = 0.42 * ((61 * 61 - 1) / 2); // ∫x·h dx along jib
    const cjMoment = 1.6 * ((16 * 16 - 1) / 2) + 5.7 * 15; // counter-jib + ballast
    const net = jibMoment - cjMoment;
    // τ_y = (u × f)_y · ∫x
    return (uz * fx - ux * fz) * net;
  }

  // levers: {slew:+right, trolley:+out, hoist:+up}; perm from Safety
  update(dt, levers, perm, hoist) {
    const payloadKg = Math.max(0, hoist.tensionFiltered / G - CRANE.hookMass);
    const micro = this.micromove ? 0.1 : 1;
    const powered = this.power && !perm.eStop;

    // --------------------------------------------------------------- hoist
    const bands = this.reeving.bands;
    // speed band with hysteresis so dynamic load swings don't make it hunt
    let band = this.hoistBand;
    if (band >= bands.length) band = bands.length - 1;
    if (band < bands.length - 1 && payloadKg > bands[band].upTo * 1.03) band++;
    else if (band > 0 && payloadKg < bands[band - 1].upTo * 0.9) band--;
    this.hoistBand = band;
    // VFD current-limit: speed is set by load band
    this.hoistBandSpeed = approach(this.hoistBandSpeed, bands[band].speed, dt * 0.8);
    let hoistCmd = powered ? levers.hoist : 0;
    if (hoistCmd > 0) hoistCmd *= perm.hoistUp;
    if (hoistCmd < 0) hoistCmd *= perm.lower;
    // upper limit slow-down zone and final limit
    const toTop = this.ropeLen - this.ropeLenMin;
    if (hoistCmd > 0) hoistCmd *= clamp(toTop / CRANE.hoistSlowZone, 0.12, 1);
    const toBottom = this.ropeLenMax - this.ropeLen;
    if (hoistCmd < 0) hoistCmd *= clamp(toBottom / 2, 0.1, 1);
    const hTarget = hoistCmd * this.hoistBandSpeed * micro;
    const hRate = (Math.abs(hTarget) > Math.abs(this.hoistVel) && Math.sign(hTarget) === Math.sign(this.hoistVel || hTarget)
      ? CRANE.hoistAccel : CRANE.hoistDecel) * (perm.eStop ? 3 : 1);
    this.hoistVel = approach(this.hoistVel, hTarget, hRate * dt);
    let newLen = this.ropeLen - this.hoistVel * dt;
    if (newLen <= this.ropeLenMin) { newLen = this.ropeLenMin; if (this.hoistVel > 0) this.hoistVel = 0; }
    if (newLen >= this.ropeLenMax) { newLen = this.ropeLenMax; if (this.hoistVel < 0) this.hoistVel = 0; }
    // slack-rope: stop paying out once the hook is resting and the rope is well slack
    const dist = hoist.hook.distanceTo(hoist.sheave);
    if (this.hoistVel < 0 && hoist.hookGrounded && newLen > dist + 2.5) { newLen = this.ropeLen; this.hoistVel = 0; }
    this.ropeLen = newLen;

    // -------------------------------------------------------------- trolley
    let trolCmd = powered ? levers.trolley : 0;
    if (trolCmd > 0) trolCmd *= perm.trolleyOut;
    if (trolCmd < 0) trolCmd *= perm.trolleyIn;
    const outDist = CRANE.trolleyMax - this.trolley;
    const inDist = this.trolley - CRANE.trolleyMin;
    if (trolCmd > 0) trolCmd *= clamp(outDist / CRANE.trolleySlowZone, 0.1, 1);
    if (trolCmd < 0) trolCmd *= clamp(inDist / CRANE.trolleySlowZone, 0.1, 1);
    const tTarget = trolCmd * CRANE.trolleyMaxSpeed * micro;
    const tRate = (Math.abs(tTarget) > Math.abs(this.trolleyVel) && Math.sign(tTarget) === Math.sign(this.trolleyVel || tTarget)
      ? CRANE.trolleyAccel : CRANE.trolleyDecel) * (perm.eStop ? 3 : 1);
    this.trolleyVel = approach(this.trolleyVel, tTarget, tRate * dt);
    this.trolley += this.trolleyVel * dt;
    if (this.trolley > CRANE.trolleyMax) { this.trolley = CRANE.trolleyMax; this.trolleyVel = 0; }
    if (this.trolley < CRANE.trolleyMin) { this.trolley = CRANE.trolleyMin; this.trolleyVel = 0; }

    // ---------------------------------------------------------------- slew
    const mode = SLEW_MODES[this.slewMode];
    const r = this.trolley;
    const I = CRANE.craneSlewInertia + CRANE.trolleyMass * r * r;
    // rope reaction torque on the jib
    const T = hoist.tension;
    const s = hoist.sheave;
    let nx = hoist.hook.x - s.x, ny = hoist.hook.y - s.y, nz = hoist.hook.z - s.z;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const Fx = T * nx, Fz = T * nz;
    this.ropeTorque = s.z * Fx - s.x * Fz;
    this.windTorque = this.windTorqueOnJib();
    const ext = this.ropeTorque + this.windTorque - this.slewRate * 2.5e5; // + slewing ring friction/viscous
    const lever = powered && !this.freeSlew ? levers.slew : 0;
    const slewCmd = lever * (lever > 0 ? perm.slewRight : perm.slewLeft);
    const target = -slewCmd * CRANE.slewMaxSpeed * micro; // lever right → clockwise from above → θ decreasing
    const tMax = CRANE.slewTorque * mode.torque;
    let drive = 0;
    const prevRate = this.slewRate;
    this.slewSlipping = false;
    if (this.freeSlew && !perm.eStop) {
      // out of service: brake released, jib weathervanes
      drive = 0;
      this.brakeSlew = false;
    } else if (!powered || perm.eStop) {
      // mechanical brake
      this.brakeSlew = true;
      const need = -I * this.slewRate / dt - ext;
      drive = clamp(need, -CRANE.slewBrakeTorque, CRANE.slewBrakeTorque);
      if (Math.abs(need) > CRANE.slewBrakeTorque && Math.abs(this.slewRate) < 1e-4) this.slewSlipping = true;
    } else if (Math.abs(lever) < 0.02) {
      // lever released: VFD decelerates with the mode's release characteristic, then holding brake
      const brakeLimit = tMax * mode.releaseBrake;
      if (Math.abs(this.slewRate) < 0.0006) {
        if (!this.brakeSlew) this.brakeEvents.push('slew');
        this.brakeSlew = true;
        const need = -I * this.slewRate / dt - ext;
        drive = clamp(need, -CRANE.slewBrakeTorque, CRANE.slewBrakeTorque);
        if (Math.abs(need) > CRANE.slewBrakeTorque) this.slewSlipping = true;
      } else {
        drive = clamp(-I * this.slewRate / 0.8, -brakeLimit, brakeLimit);
      }
    } else {
      this.brakeSlew = false;
      // speed-controlled VFD with torque limit (compensates external torques)
      const need = (I * (target - this.slewRate)) / 0.9 - ext;
      drive = clamp(need, -tMax, tMax);
    }
    this.slewTorque = drive;
    this.slewRate += ((drive + ext) / I) * dt;
    if (this.brakeSlew && !this.slewSlipping && Math.abs(lever) < 0.02 && Math.abs(this.slewRate) < 0.0006) this.slewRate = 0;
    this.slewAccel = (this.slewRate - prevRate) / dt;
    this.slew += this.slewRate * dt;

    // ------------------------------------------------------------ structure
    const vertLoad = Math.max(0, -T * ny);
    const moment = vertLoad * r + CRANE.trolleyMass * G * r;
    const pitchStatic = CRANE.jibCompliance * moment;
    const wv = (2 * Math.PI) / CRANE.jibVertPeriod;
    this.pitchVel += (wv * wv * (pitchStatic - this.pitch) - 2 * CRANE.jibVertDamping * wv * this.pitchVel) * dt;
    this.pitch += this.pitchVel * dt;
    // structural safety clamp (design tip deflection is ~0.8 m ≈ 0.013 rad)
    if (Math.abs(this.pitch) > 0.03) { this.pitch = Math.sign(this.pitch) * 0.03; this.pitchVel *= 0.5; }

    const ux = Math.cos(this.slew), uz = -Math.sin(this.slew);
    const tx = uz, tz = -ux; // horizontal perpendicular (direction of increasing θ)
    const fPerp = T * (nx * tx + nz * tz);
    const latStatic = fPerp * r * CRANE.jibCompliance * 0.6;
    const wl = (2 * Math.PI) / CRANE.jibLatPeriod;
    this.latVel += (wl * wl * (latStatic - this.lat) - 2 * CRANE.jibLatDamping * wl * this.latVel
      - CRANE.jibLatGain * this.slewAccel) * dt;
    this.lat += this.latVel * dt;
    if (Math.abs(this.lat) > 0.02) { this.lat = Math.sign(this.lat) * 0.02; this.latVel *= 0.5; }
  }
}
