import { CRANE, SAFETY, SITE, SLEW_MODES, G, ratedCapacity } from '../config.js';
import { clamp } from '../util/math.js';

// Safety systems per ISO 10245-3 / EN 14439 practice:
//  - rated capacity (moment) limiter: pre-warning ≥90 %, cut-off at 105 %
//    of non-conservative motions (hoist up, trolley out); hoist down and
//    trolley in stay available
//  - maximum-load limiter per reeving
//  - hoist upper/lower and trolley limit switches (handled in the drives, events here)
//  - anemometer thresholds, working-area (zone) limitation, E-stop and
//    zero-position interlock for power-on
export class Safety {
  constructor() {
    this.payload = 0; // kg (tared, hook block excluded)
    this.capacity = 8000;
    this.ratio = 0;
    this.lmiState = 'ok'; // ok | warn | limit | cut
    this.maxLoadCut = false;
    this.windState = 'ok'; // ok | warn | alarm | stop
    this.eStop = false;
    this.zoneEnabled = true;
    this.zoneDist = 99;
    this.zoneActive = false;
    this.twoBlock = false;
    this.events = []; // strings for KPI tracking / audio
    this.perm = {
      hoistUp: 1, lower: 1, trolleyOut: 1, trolleyIn: 1, slewLeft: 1, slewRight: 1, eStop: false,
    };
    this.lmiTrips = 0;
    this.twoBlockCount = 0;
    this._prevCut = false;
    this._prevTop = false;
  }

  update(dt, crane, hoist, wind, levers) {
    const payload = Math.max(0, hoist.tensionFiltered / G - CRANE.hookMass);
    this.payload = payload;
    this.capacity = ratedCapacity(crane.trolley, crane.falls);
    this.ratio = payload / this.capacity;

    // LMI with hysteresis on the cut-off
    const cut = this.lmiState === 'cut' ? this.ratio > 1.0 : this.ratio >= SAFETY.lmiCutoff;
    if (cut) this.lmiState = 'cut';
    else if (this.ratio >= SAFETY.lmiLimit) this.lmiState = 'limit';
    else if (this.ratio >= SAFETY.lmiWarn) this.lmiState = 'warn';
    else this.lmiState = 'ok';
    if (cut && !this._prevCut) { this.lmiTrips++; this.events.push('lmiTrip'); }
    this._prevCut = cut;

    const maxLoad = crane.reeving.maxLoad;
    this.maxLoadCut = this.maxLoadCut ? payload > maxLoad : payload > maxLoad * 1.05;

    const a = wind.anemometer;
    this.windState = a >= SAFETY.windStop ? 'stop' : a >= SAFETY.windAlarm ? 'alarm' : a >= SAFETY.windWarn ? 'warn' : 'ok';

    // hoist upper limit reached while hoisting → anti-two-block event
    const atTop = crane.ropeLen <= crane.ropeLenMin + 0.02;
    if (atTop && !this._prevTop && levers.hoist > 0.05) { this.twoBlockCount++; this.events.push('upperLimit'); }
    this._prevTop = atTop;
    this.twoBlock = atTop;

    const p = this.perm;
    p.eStop = this.eStop;
    p.hoistUp = cut || this.maxLoadCut || this.windState === 'stop' ? 0 : 1;
    p.trolleyOut = cut ? 0 : 1;
    p.lower = 1;
    p.trolleyIn = 1;
    p.slewLeft = 1;
    p.slewRight = 1;

    // working-area limitation: keep the hook out of the public road / footway
    this.zoneActive = false;
    if (this.zoneEnabled) {
      const zLimit = SITE.zoneLimitZ;
      const L = hoist.load;
      const ext = L ? L.half.x * Math.abs(Math.sin(L.yaw)) + L.half.z * Math.abs(Math.cos(L.yaw)) : 0;
      const hz = Math.min(hoist.sheave.z, hoist.hook.z, L ? L.pos.z - ext : 1e9);
      const d = hz - zLimit;
      this.zoneDist = d;
      // dz/dθ and dz/dr for the sheave: z = -r sinθ
      const th = crane.slew, r = crane.trolley;
      // slow-down band sized from the current stopping distance
      const I = CRANE.craneSlewInertia + CRANE.trolleyMass * r * r;
      const aMax = (CRANE.slewTorque * SLEW_MODES[crane.slewMode].torque) / I;
      const slow = 6 + 1.5 * ((r * crane.slewRate ** 2) / (2 * aMax) + crane.trolleyVel ** 2 / (2 * CRANE.trolleyDecel));
      const dzdth = -r * Math.cos(th);
      const dzdr = -Math.sin(th);
      const k = clamp(d / slow, 0, 1);
      // slew lever right → θ decreasing → dz = -dzdth
      if (-dzdth < 0) p.slewRight *= k; // moving toward zone
      if (dzdth < 0) p.slewLeft *= k;
      if (dzdr < 0) p.trolleyOut *= k;
      else p.trolleyIn *= k;
      if (d < slow) this.zoneActive = true;
      if (d <= 0) {
        if (-dzdth < 0) p.slewRight = 0;
        if (dzdth < 0) p.slewLeft = 0;
        if (dzdr < 0) p.trolleyOut = 0; else p.trolleyIn = 0;
      }
    } else this.zoneDist = 99;
  }
}
