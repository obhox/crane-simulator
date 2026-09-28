// AT-100 5.1 carrier driving model (build spec §7, docs/mobile-crane-spec.md).
//
// Pure simulation (no three.js): mobileMachine.js owns the meshes and reads
// pos / yaw / pose / wheelSteer / wheelSpin to pose the carrier group.
//
//   const veh = new Vehicle();
//   veh.reset({ x, z, yaw, engine: true, parkingBrake: true });
//   events = veh.update(dt, drive {throttle, brake, steer, crawl?}, actions, env)
//   env = { terrain (heightAt), world (ColliderWorld), traffic (streets.traffic),
//           siteRect (fence rect), limitKmh (site limit setting), massKg?, ignore? }
//
// Kinematics: low-speed multi-axle bicycle model. Every axle is steered, so
// the vehicle turns about an instantaneous centre of rotation (ICR) that lies
// on the lateral line through a reference point x_ref (the point with no
// side-slip). The steering program picks x_ref and the maximum curvature:
// ROAD turns about axle 3, fading to axle 4 with the rear steer locked at
// 50 km/h (rear steer fades with speed on real 5-axle ATs [S6]); ALL puts the
// ICR mid-wheelbase for the tightest turn; CRAB steers all axles parallel.
// The ref point is integrated along an exact arc, pos (the slew axis) follows
// rigidly, so pos stays continuous when x_ref changes.
//
// Frames (§0): yaw φ = three.js rotation.y; fwd = (cos φ, −sin φ) in (x, z);
// carrier y_c = left; steer input + = right, κ + = left (so κ = −steer·κ_max).

import { VEHICLE, SPEED_LIMITS, AXLES, AT100, TRAVEL_INTERLOCK } from './config.js';
import { SITE } from '../config.js';
import { Box, obbXZ } from '../physics/collide.js';

const DEG = Math.PI / 180;
const KMH = 1 / 3.6;
const G = 9.81;
const P = VEHICLE.programs;
const TYRE_R = AT100.carrier.tyre.dia / 2; // 0.685 m
const TRACK = AT100.carrier.tyre.trackY; // ±1.18 m tyre-centre track
const GEAR_TOP = VEHICLE.gearTopKmh; // km/h at 1,800 rpm, D1..D12
const REV_TOP = VEHICLE.reverseGears; // R1, R2 km/h at 1,800 rpm
const RATED = VEHICLE.ratedRpm;

// Gate apron + wheel wash (x −34..−26 through the south footway up to the end
// of the wash, §7 "gate and wheel wash: advisory 5 km/h"). Not in config.js
// (frozen): derived from the gate opening (site/perimeter.js GATE) and the wash
// at (−30, −53.5), 7.2 m long.
const GATE_ZONE = { minX: -34, maxX: -26, minZ: -61, maxZ: -49.5 };

// Engine start (cranking) time [E]; parking-brake spring brakes when applied
// while rolling [E]; auto-brake used by the speed governors (crawl, CRAB,
// reverse, 80 km/h) above the governed speed [E].
const CRANK_TIME = 1.0;
const PARK_DECEL = 3.0;
const GOVERNOR_DECEL = 1.0;
// Drive-force model. §7's F_drive = throttle·min(340e3/max(|v|, 1), 0.7·0.6·m·g)
// treats the 340 kW at the wheels as available at every road speed; on its
// own that gives 0 → 50 km/h in 21.7 s (spec check: about 25 s). Two sourced /
// physical refinements close the gap without touching the §7 constants:
//  · engine full-load curve [S1: 400 kW rated at 1,800 rpm, 2,516 N·m peak]:
//    peak-torque plateau up to 1,300 rpm [E], then linear to the rated-power
//    torque at 1,800 rpm. Between the 1,700 rpm up-shift and the ~1,350 rpm it
//    lands on, the wheel power is 300-335 kW, not 340 kW. Wheel power =
//    0.85 × engine power (340/400, the §7 figure). During launch the clutch slips
//    with the engine at ≥ 1,000 rpm.
//  · driveline rotating inertia as equivalent mass: 10 wheel/tyre/hub/drum
//    sets ≈ 2.1 t [E], plus the engine and flywheel (4 kg·m² [E]) reflected
//    through the gear ratio (heavy in low gears).
// Result: 0 → 50 km/h ≈ 24 s and 0 → 80 km/h ≈ 58 s. The spec's "0 → 80 in
// about 75 s" cannot be reached with its own 340 kW formula (≈ 50 s).
const ENGINE = AT100.carrier.engine;
const DRIVELINE_EFF = VEHICLE.wheelPowerW / (ENGINE.kW * 1000); // 0.85
const W_RATED = (ENGINE.ratedRpm * 2 * Math.PI) / 60;
const T_RATED = (ENGINE.kW * 1000) / W_RATED; // 2,122 N·m at rated power
const TORQUE_PLATEAU_RPM = 1300; // [E]
const LAUNCH_RPM = 1000; // [E] clutch-slip engine speed at launch
const WHEEL_EQ_KG = 2100; // [E]
const ENGINE_J = 4.0; // kg·m² [E]
function engineTorque(rpm) {
  if (rpm <= TORQUE_PLATEAU_RPM) return ENGINE.torqueNm;
  return ENGINE.torqueNm + ((T_RATED - ENGINE.torqueNm) * (Math.min(rpm, ENGINE.ratedRpm) - TORQUE_PLATEAU_RPM)) / (ENGINE.ratedRpm - TORQUE_PLATEAU_RPM);
}
/** Full-load engine power (W) at an engine speed. */
export const enginePower = (rpm) => (engineTorque(rpm) * rpm * 2 * Math.PI) / 60;

const POSE_TAU = 0.1; // s, hydro-pneumatic suspension settling of the body pose [E]
const KERB_GROUP_M = 8; // one kerb-strike event per 8 m of travel (the whole 7.45 m axle group crossing one kerb)
const CONTACT_GAP = 0.5; // s without contact before the same obstacle counts as a new contact

// wheel i = axle j (0..4) × side (0 = left +y_c, 1 = right −y_c)
const WHEELS = [];
for (let j = 0; j < AXLES.length; j++) for (const side of [1, -1]) WHEELS.push({ j, side, x: AXLES[j], y: side * TRACK });
const NW = WHEELS.length;
// least-squares plane z = z0 + a·x + b·y through the wheel contact points:
// the track is symmetric (Σy = Σxy = 0), so b decouples and (z0, a) is a 2×2 system
const SX = WHEELS.reduce((s, w) => s + w.x, 0);
const SXX = WHEELS.reduce((s, w) => s + w.x * w.x, 0);
const SYY = WHEELS.reduce((s, w) => s + w.y * w.y, 0);
const DET = NW * SXX - SX * SX;

const KERB_BUF = 32; // samples per wheel in the 0.2 s kerb window (≥ 24 at 120 Hz)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const inRect = (r, x, z) => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ;
const NO_DRIVE = Object.freeze({ throttle: 0, brake: 0, steer: 0 });

// action aliases (input.js names are owned by WP-UI; accept the obvious spellings)
const ACTIONS = {
  gear: 'gear', gearToggle: 'gear', direction: 'gear', reverse: 'gear',
  program: 'program', steerProgram: 'program', steering: 'program',
  parkingBrake: 'park', parkBrake: 'park', handbrake: 'park',
  engine: 'engine', engineStop: 'engine', engineToggle: 'engine',
};

const PROGRAM_TEXT = {
  ROAD: 'Steering: ROAD program',
  ALL: 'Steering: ALL-wheel (≤ 20 km/h)',
  CRAB: 'Steering: CRAB (≤ 10 km/h)',
};

/**
 * §6.5 travel interlock (pure). ROAD driving is allowed only if every item holds.
 * @param {object} s
 * @param {number[]} s.beams        4 beam extensions 0..1 (FL, FR, RL, RR)
 * @param {number[]} [s.jacks]      4 jack strokes (m); or s.jacksRetracted:boolean
 * @param {boolean} s.pinned        turntable lock pin engaged
 * @param {number} s.slewDeg        ψ in degrees (pinned at 0°)
 * @param {number} s.luffDeg        boom angle θ
 * @param {number} s.boomLen        L (m)
 * @param {boolean} s.stowed        hook block stowed on the bumper
 * @param {number} s.cwKg           counterweight on the superstructure
 * @param {number|any[]} s.deckSlabs  slab count or list lying on the deck
 * @param {boolean} [s.siteTravel]  job M6 exception: may travel on site with CW mounted
 * @returns {{ok:boolean, reason:string|null, text:string|null}}  text = 'TRAVEL INTERLOCK: <reason>'
 */
export function travelInterlock(s) {
  const I = TRAVEL_INTERLOCK;
  const fail = (reason) => ({ ok: false, reason, text: `TRAVEL INTERLOCK: ${reason}` });
  if ((s.beams || []).some((b) => b > I.beams + 0.01)) return fail('retract all outrigger beams');
  const jacksIn = s.jacks ? s.jacks.every((e) => e <= 0.005) : s.jacksRetracted !== false;
  if (!jacksIn) return fail('retract all jacks');
  if (!s.pinned || Math.abs(s.slewDeg ?? 0) > 0.5) return fail('slew to 0° and pin the turntable');
  if ((s.luffDeg ?? 0) > I.maxLuffDeg + 1e-6) return fail('lower the boom onto its rest');
  if ((s.boomLen ?? I.boomLen) > I.boomLen + 0.01) return fail('retract the boom to 11.5 m');
  if (!s.stowed) return fail('stow the hook block on the bumper');
  if ((s.cwKg ?? 0) > I.cwKg && !s.siteTravel) return fail('remove the superstructure counterweight');
  const slabs = Array.isArray(s.deckSlabs) ? s.deckSlabs.length : (s.deckSlabs ?? 0);
  if (slabs > I.deckSlabs) return fail('clear the ballast slabs off the deck');
  return { ok: true, reason: null, text: null };
}

/** Steering-program geometry at a speed: {xRef, kappaMax, crab}. */
export function programGeometry(program, kmh) {
  if (program === 'ALL') return { xRef: P.ALL.xRef, kappaMax: P.ALL.kappaMax, crab: false };
  if (program === 'CRAB') return { xRef: P.ALL.xRef, kappaMax: 0, crab: true };
  const R = P.ROAD, f = R.fadeTo;
  const t = clamp((kmh - R.fadeFromKmh) / (f.atKmh - R.fadeFromKmh), 0, 1);
  return { xRef: lerp(R.xRef, f.xRef, t), kappaMax: lerp(R.kappaMax, f.kappaMax, t), crab: false };
}

export class Vehicle {
  /** @param {{massKg?:number}} [opts] */
  constructor(opts = {}) {
    this.mass = opts.massKg ?? AT100.carrier.roadMassKg; // 47.0 t road trim (§1.1)
    this.pos = { x: 0, z: 0 }; // slew-axis point (world)
    this.yaw = 0; // φ
    this.v = 0; // m/s, + forward
    this.kappa = 0; // 1/m, + left
    this.omega = 0; // yaw rate rad/s (rotation.y)
    this.steerPos = 0; // steering position −1..1 (+ right), rate-limited
    this.crabAngle = 0; // rad (rotation.y convention) in CRAB
    this.program = 'ROAD';
    this.xRef = P.ROAD.xRef;
    this.direction = 1; // selector: +1 D, −1 R
    this.fwdGear = 1; // 1..12
    this.revGear = 1; // 1..2
    this.gear = 0; // signed: +1..+12 D, −1..−2 R, 0 = N
    this.shiftT = 0;
    this.rpm = VEHICLE.idleRpm;
    this.engineOn = true;
    this.crankT = 0;
    this.parkingBrake = true;
    this.throttle = 0; this.brake = 0; this.crawl = false;
    this.engineLoad = 0; // 0..1 (audio)
    this.retarder = 0; // 0..1 retarder / engine-brake level (audio whoosh)
    this.braking = false; // brake lights
    this.wheelSteer = [0, 0, 0, 0, 0]; // rad per axle (centreline), rotation.y convention (+ = wheel points left)
    this.wheelSteerLR = AXLES.map(() => [0, 0]); // Ackermann per side [left, right]
    this.wheelSpin = 0; // rad, accumulated wheel rotation (distance / tyre radius)
    this.wheelGround = new Float64Array(NW); // world ground height under wheel i = axle·2 + (right ? 1 : 0)
    this.pose = { y: 0, pitch: 0, roll: 0 }; // carrier plane: root y (ground under the slew axis), rotation.z, rotation.x
    this.zone = 'road'; // 'road' | 'gate' | 'site'
    this.limitKmh = SPEED_LIMITS.roadKmh;
    this.speeding = false;
    this.inContact = false;
    this.kpi = { kerb: 0, kerbHard: 0, collisions: 0, scrapes: 0, speedingTime: 0, trafficCollisions: 0, distance: 0, maxSiteKmh: 0 };
    this.events = [];
    // internals
    this._kerbH = new Float64Array(NW * KERB_BUF);
    this._kerbT = new Float64Array(NW * KERB_BUF).fill(-1e9);
    this._kerbI = 0;
    this._kerbLatch = new Uint8Array(NW);
    this._kerbGroupAt = -1e9; // odometer at the start of the current kerb group
    this._kerbGroupHard = false;
    this._t = 0;
    this._odo = 0;
    this._hintT = 0;
    this._contacts = new Map(); // obstacle id / car → last contact time
    this._body = new Box(0, 0, 0, VEHICLE.body.hx, 1, VEHICLE.body.hz, 0, 'mobile-vehicle');
    this._nose = new Box(0, 0, 0, (VEHICLE.nose.x1 - VEHICLE.nose.x0) / 2, 1, VEHICLE.nose.hz, 0, 'mobile-vehicle');
    // the south fence collider is continuous across the gate: replaced by two segments (§7)
    const fg = VEHICLE.fenceGate;
    this._fenceSegs = fg.segments.map(([a, b]) => new Box((a + b) / 2, 1.2, fg.z, (b - a) / 2, 1.2, 0.1, 0, 'fence'));
    this._cars = [];
    this._obb = { x: 0, z: 0, hx: VEHICLE.body.hx, hz: VEHICLE.body.hz, yaw: 0 };
    this._obstacles = [{ x: 0, z: 0, hx: 0, hz: 0, yaw: 0, vx: 0, vz: 0 }];
    this._w = { x: 0, y: 0, z: 0 };
    this._updateGear();
  }

  /**
   * Place the carrier (MobileStart / job reset). Pose settles immediately.
   * @param {{x:number, z:number, yaw?:number, program?:string, engine?:boolean, parkingBrake?:boolean, massKg?:number, terrain?:object}} s
   */
  reset(s = {}) {
    this.pos.x = s.x ?? s.pos?.x ?? 0;
    this.pos.z = s.z ?? s.pos?.z ?? 0;
    this.yaw = s.yaw ?? 0;
    if (s.massKg) this.mass = s.massKg;
    this.v = this.kappa = this.omega = this.steerPos = this.crabAngle = 0;
    this.program = P[s.program] ? s.program : 'ROAD';
    this.xRef = programGeometry(this.program, 0).xRef;
    this.direction = 1; this.fwdGear = 1; this.revGear = 1; this.shiftT = 0;
    this.engineOn = s.engine ?? true;
    this.crankT = 0;
    this.parkingBrake = s.parkingBrake ?? true;
    this.throttle = this.brake = this.engineLoad = this.retarder = 0;
    this.rpm = this.engineOn ? VEHICLE.idleRpm : 0;
    this.wheelSteer.fill(0);
    for (const lr of this.wheelSteerLR) lr[0] = lr[1] = 0;
    this.speeding = false;
    this.inContact = false;
    this.resetKpi();
    this._contacts.clear();
    this._kerbT.fill(-1e9);
    this._kerbLatch.fill(0);
    this._updateGear();
    this._terrainPose(s.terrain, 1, true);
    return this;
  }

  resetKpi() {
    const k = this.kpi;
    k.kerb = k.kerbHard = k.collisions = k.scrapes = k.speedingTime = k.trafficCollisions = k.distance = k.maxSiteKmh = 0;
  }

  get kmh() { return this.v * 3.6; }
  get gearName() { return this.gear === 0 ? 'N' : this.gear > 0 ? `D${this.gear}` : `R${-this.gear}`; }
  get engineRunning() { return this.engineOn && this.crankT <= 0; }
  get reverseAlarm() { return this.direction < 0 && this.engineRunning && !this.parkingBrake; }
  get standstill() { return Math.abs(this.v) < 0.05; }
  /** reference point (world) = pos + x_ref·fwd */
  refPoint(out = { x: 0, z: 0 }) {
    out.x = this.pos.x + this.xRef * Math.cos(this.yaw);
    out.z = this.pos.z - this.xRef * Math.sin(this.yaw);
    return out;
  }

  /**
   * One fixed step (120 Hz). Returns this step's events (array reused):
   *   {type:'kerb', speed, tag:'soft'|'hard'}           KPI −3 / −8
   *   {type:'collision', speed, tag}                    KPI −10 (v → 0)
   *   {type:'scrape', speed, tag}                       KPI −2 per contact
   *   {type:'trafficCollision', speed, tag:'traffic', critical:true}
   *   {type:'program', program, auto}   {type:'gear', gear}   {type:'direction', dir}
   *   {type:'parkingBrake', on}  (air-brake psst)   {type:'engine', on}
   *   {type:'speeding', kmh, limit}  (start of site speeding)
   *   {type:'refused', ...}  (a pressed action was not possible)   {type:'hint'}  (throttle against the parking brake)
   * Every event with `text` is meant for the HUD toast (kind: 'info'|'good'|'warn'|'bad').
   * @param {number} dt
   * @param {{throttle:number, brake:number, steer:number, crawl?:boolean}} drive
   * @param {Iterable<string>|null} actions  discrete presses queued since the last step
   *   ('gear' D↔R, 'program' ROAD→ALL→CRAB, 'parkingBrake', 'engine'; aliases accepted)
   * @param {{terrain?, world?, traffic?, siteRect?, limitKmh?, massKg?, crawl?:boolean, ignore?:Set|Array}} env
   */
  update(dt, drive = NO_DRIVE, actions = null, env = {}) {
    const ev = this.events;
    ev.length = 0;
    this._t += dt;
    if (actions) for (const a of actions) this._action(a, ev);
    if (this.crankT > 0) {
      this.crankT -= dt;
      if (this.crankT <= 0) ev.push({ type: 'engine', on: true, text: 'Carrier engine running', kind: 'info' });
    }
    const thr = this.engineRunning ? clamp(drive.throttle || 0, 0, 1) : 0;
    const brk = clamp(drive.brake || 0, 0, 1);
    this.throttle = thr;
    this.brake = brk;
    this.crawl = !!(drive.crawl ?? env.crawl);

    // ------------------------------------------------ steering (lock to lock 3.0 s)
    const steerIn = clamp(drive.steer || 0, -1, 1);
    const rate = (2 / VEHICLE.steerLockToLock) * dt;
    this.steerPos += clamp(steerIn - this.steerPos, -rate, rate);

    // ------------------------------------------------ longitudinal
    this._longitudinal(dt, thr, brk, env, ev);

    // ------------------------------------------------ program limits (§7: ALL ≤ 20 km/h, else ROAD with a toast)
    const kmh = Math.abs(this.v) * 3.6;
    if (this.program === 'ALL' && kmh > P.ALL.maxKmh) {
      this.program = 'ROAD';
      ev.push({ type: 'program', program: 'ROAD', auto: true, text: 'Above 20 km/h: steering switched to ROAD', kind: 'warn' });
    }

    // ------------------------------------------------ lateral kinematics
    const geo = programGeometry(this.program, kmh);
    this.xRef = geo.xRef;
    let kappa = -this.steerPos * geo.kappaMax;
    const v = this.v;
    if (Math.abs(v) > 0.5) { const lim = VEHICLE.lateralLimit / (v * v); kappa = clamp(kappa, -lim, lim); } // |κ| ≤ 2.5/v² (high CG)
    this.kappa = kappa;
    // CRAB: all axles parallel, velocity = fwd rotated by −steer·15°, faded out above the 10 km/h limit
    this.crabAngle = geo.crab ? -this.steerPos * P.CRAB.maxDeg * DEG * clamp((P.CRAB.maxKmh + 2 - kmh) / 2, 0, 1) : 0;
    this._integrate(dt);

    // ------------------------------------------------ visual wheel steer (Ackermann per side, y = ±1.18)
    for (let j = 0; j < AXLES.length; j++) {
      if (geo.crab) { this.wheelSteer[j] = this.wheelSteerLR[j][0] = this.wheelSteerLR[j][1] = this.crabAngle; continue; }
      const dx = (AXLES[j] - this.xRef) * kappa;
      this.wheelSteer[j] = Math.atan(dx);
      this.wheelSteerLR[j][0] = Math.atan(dx / (1 - kappa * TRACK));
      this.wheelSteerLR[j][1] = Math.atan(dx / (1 + kappa * TRACK));
    }
    const ds = Math.abs(this.v) * dt;
    this.wheelSpin = (this.wheelSpin + (this.v * dt) / TYRE_R) % (2 * Math.PI);
    this._odo += ds;
    this.kpi.distance += ds;

    // ------------------------------------------------ terrain pose + kerb strikes
    this._terrainPose(env.terrain, dt, false);
    this._kerbs(ev);

    // ------------------------------------------------ collisions
    this.inContact = false;
    if (env.world) this._collide(env, ev);
    if (env.traffic?.vehicleBoxes) this._collideTraffic(env, ev);

    // ------------------------------------------------ zone, speed limits, KPIs
    this._zone(dt, env, ev);
    return ev;
  }

  // -------------------------------------------------------------- actions
  _action(a, ev) {
    const name = typeof a === 'string' ? a : a?.type;
    switch (ACTIONS[name]) {
      case 'gear':
        if (!this.standstill) { ev.push({ type: 'refused', action: 'gear', text: 'Stop before selecting D ↔ R', kind: 'warn' }); return; }
        this.direction = -this.direction;
        this.fwdGear = 1; this.revGear = 1;
        this._updateGear();
        ev.push({ type: 'direction', dir: this.direction, text: this.direction > 0 ? 'Drive (D)' : 'Reverse (R)', kind: 'info' });
        return;
      case 'program': {
        const next = { ROAD: 'ALL', ALL: 'CRAB', CRAB: 'ROAD' }[this.program] || 'ROAD';
        const kmh = Math.abs(this.v) * 3.6;
        const max = next === 'ALL' ? P.ALL.maxKmh : next === 'CRAB' ? P.CRAB.maxKmh : Infinity;
        if (kmh > max) { ev.push({ type: 'refused', action: 'program', text: `${next === 'ALL' ? 'ALL-wheel' : 'CRAB'} steer only below ${max} km/h`, kind: 'warn' }); return; }
        this.program = next;
        ev.push({ type: 'program', program: next, auto: false, text: PROGRAM_TEXT[next], kind: 'info' });
        return;
      }
      case 'park':
        if (this.parkingBrake && !this.engineRunning) { ev.push({ type: 'refused', action: 'parkingBrake', text: 'No air pressure: start the engine to release the parking brake', kind: 'warn' }); return; }
        this.parkingBrake = !this.parkingBrake;
        this._updateGear();
        ev.push({ type: 'parkingBrake', on: this.parkingBrake, text: this.parkingBrake ? 'Parking brake ON' : 'Parking brake released', kind: 'info' });
        return;
      case 'engine':
        if (this.engineOn) {
          this.engineOn = false; this.crankT = 0;
          ev.push({ type: 'engine', on: false, text: 'Carrier engine stopped', kind: 'info' });
        } else {
          this.engineOn = true; this.crankT = CRANK_TIME;
          ev.push({ type: 'engine', on: true, cranking: true });
        }
        this._updateGear();
        return;
      default:
    }
  }

  _updateGear() {
    this.gear = !this.engineRunning || this.parkingBrake ? 0 : this.direction > 0 ? this.fwdGear : -this.revGear;
  }

  // -------------------------------------------------------------- longitudinal
  _longitudinal(dt, thr, brk, env, ev) {
    const m = env.massKg ?? this.mass;
    const dir = this.direction;
    const f = env.siteRect || SITE.fence;
    const crr = inRect(f, this.pos.x, this.pos.z) || inRect(GATE_ZONE, this.pos.x, this.pos.z) ? VEHICLE.crr.site : VEHICLE.crr.asphalt;
    // governed speed in the selected direction
    let vmax = (dir > 0 ? GEAR_TOP[GEAR_TOP.length - 1] : VEHICLE.reverseMaxKmh) * KMH;
    if (this.crawl) vmax = Math.min(vmax, 5 * KMH); // Shift: crawl limiter 5 km/h (§6.3)
    if (this.program === 'CRAB') vmax = Math.min(vmax, P.CRAB.maxKmh * KMH);
    if (this.shiftT > 0) this.shiftT -= dt;
    const canDrive = this.engineRunning && !this.parkingBrake && this.shiftT <= 0;
    const along = this.v * dir; // speed in the selected direction (negative = rolling against it)
    const speed = Math.abs(this.v);
    // engaged gear → engine speed per m/s; effective mass incl. rotating driveline
    const topMs = (dir > 0 ? GEAR_TOP[this.fwdGear - 1] : REV_TOP[this.revGear - 1]) * KMH;
    const ratio = W_RATED / topMs; // engine rad/s per m/s of road speed
    const mEff = m + WHEEL_EQ_KG + ENGINE_J * ratio * ratio;
    // F_drive = throttle·min(0.85·P_engine(rpm) / max(|v|, 1), μ·share·m·g): 10×6 traction share 0.6
    let aDrive = 0, gov = 1;
    if (canDrive && thr > 0) {
      gov = clamp((vmax - along) / 0.15, 0, 1);
      const rpm = clamp((ENGINE.ratedRpm * speed) / topMs, LAUNCH_RPM, ENGINE.ratedRpm);
      const F = thr * Math.min((DRIVELINE_EFF * enginePower(rpm)) / Math.max(speed, 1), VEHICLE.mu * VEHICLE.tractionShare * m * G) * gov;
      aDrive = Math.min(F / mEff, VEHICLE.maxAccel); // clamped to 1.2 m/s² (traction and comfort)
    }
    this.engineLoad = canDrive ? thr * gov : 0;
    // resistances (all oppose motion): rolling (asphalt 0.009 / site 0.025), aero (CdA 8), brakes
    const aRes = (m * crr * G + 0.5 * VEHICLE.rho * VEHICLE.cdA * speed * speed) / mEff;
    const coasting = thr === 0 && this.engineRunning && speed > 1;
    this.retarder = coasting ? clamp((speed - 1) / 4, 0, 1) : 0;
    let aBrake = brk * VEHICLE.brakeDecel + (coasting ? VEHICLE.retarderDecel : 0) + (this.parkingBrake ? PARK_DECEL : 0);
    if (along > vmax + 0.3) aBrake += Math.min(GOVERNOR_DECEL, (along - vmax) * 2); // governor: retarder + auto brake
    this.braking = brk > 0.05;
    this._hintT -= dt;
    if (this.parkingBrake && thr > 0.5 && speed < 0.05 && this._hintT <= 0) {
      this._hintT = 4;
      ev.push({ type: 'hint', text: 'Parking brake is ON: press F to release', kind: 'warn' });
    }
    if (along >= 0) {
      // moving in (or at rest toward) the selected direction
      this.v = dir * Math.max(0, along + (aDrive - aRes - aBrake) * dt);
    } else {
      // rolling against the selection (after a push): everything decelerates it
      const back = Math.max(0, -along - (aDrive + aRes + aBrake) * dt);
      this.v = -dir * back;
    }

    // ------------------------------------------------ automated 12-speed gearbox (audio + HUD)
    const vk = Math.abs(this.v) * 3.6;
    if (dir > 0) {
      if (vk < 1 && this.fwdGear > 1) this.fwdGear = 1; // standstill: back to the start gear
      else if (this.shiftT <= 0) {
        const top = GEAR_TOP[this.fwdGear - 1];
        if (this.fwdGear < GEAR_TOP.length && vk > top * VEHICLE.upshiftRpm / RATED) this._shift(1, ev);
        else if (this.fwdGear > 1 && vk < top * VEHICLE.downshiftRpm / RATED) this._shift(-1, ev);
      }
    } else if (this.shiftT <= 0) {
      if (this.revGear === 1 && vk > REV_TOP[0] * VEHICLE.upshiftRpm / RATED) this._shift(1, ev);
      else if (this.revGear === 2 && vk < REV_TOP[1] * VEHICLE.downshiftRpm / RATED) this._shift(-1, ev);
    }
    this._updateGear();
    // rpm = max(600, 1,800·|v|/v_top(gear)); launch clutch slip revs the engine up; free revs in N
    let rpm = 0;
    if (this.engineRunning) {
      const top = (dir > 0 ? GEAR_TOP[this.fwdGear - 1] : REV_TOP[this.revGear - 1]) * KMH;
      rpm = Math.max(VEHICLE.idleRpm, RATED * Math.abs(this.v) / top);
      if (this.gear === 0) rpm = VEHICLE.idleRpm + 900 * thr;
      else if (canDrive && thr > 0 && rpm < 1100) rpm = Math.max(rpm, VEHICLE.idleRpm + 500 * thr);
      rpm = Math.min(rpm, RATED + 100);
    } else if (this.crankT > 0) rpm = 200;
    this.rpm += (rpm - this.rpm) * Math.min(1, dt / 0.12);
  }

  _shift(d, ev) {
    if (this.direction > 0) this.fwdGear += d; else this.revGear += d;
    this.shiftT = VEHICLE.shiftPause; // no drive force for 0.4 s per shift
    this._updateGear();
    ev.push({ type: 'gear', gear: this.gear, up: d > 0 });
  }

  // -------------------------------------------------------------- kinematics
  _integrate(dt) {
    const xr = this.xRef;
    let c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let rx = this.pos.x + xr * c, rz = this.pos.z - xr * s;
    const ds = this.v * dt;
    if (this.program === 'CRAB') {
      const a = this.yaw + this.crabAngle;
      rx += ds * Math.cos(a);
      rz -= ds * Math.sin(a);
      this.omega = 0;
    } else {
      // exact arc of the reference point about the ICR (radius 1/κ)
      const dphi = ds * this.kappa;
      if (Math.abs(dphi) < 1e-9) { rx += ds * c; rz -= ds * s; }
      else {
        const chord = (2 * Math.sin(dphi / 2)) / this.kappa, hm = this.yaw + dphi / 2;
        rx += chord * Math.cos(hm);
        rz -= chord * Math.sin(hm);
      }
      this.yaw = wrap(this.yaw + dphi);
      this.omega = this.v * this.kappa;
      c = Math.cos(this.yaw); s = Math.sin(this.yaw);
    }
    this.pos.x = rx - xr * c;
    this.pos.z = rz + xr * s;
  }

  // -------------------------------------------------------------- terrain
  _terrainPose(terrain, dt, snap) {
    const h = this.wheelGround;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    let sh = 0, sxh = 0, syh = 0;
    for (let i = 0; i < NW; i++) {
      const w = WHEELS[i];
      const x = this.pos.x + w.x * c - w.y * s, z = this.pos.z - w.x * s - w.y * c;
      const y = terrain?.heightAt ? terrain.heightAt(x, z) : 0;
      h[i] = y;
      sh += y; sxh += w.x * y; syh += w.y * y;
    }
    const z0 = (SXX * sh - SX * sxh) / DET, a = (NW * sxh - SX * sh) / DET, b = syh / SYY;
    const k = snap ? 1 : Math.min(1, dt / POSE_TAU);
    const p = this.pose;
    p.y += (z0 - p.y) * k;
    p.pitch += (Math.atan(a) - p.pitch) * k;
    p.roll += (Math.atan(b) - p.roll) * k;
  }

  // a wheel's ground height changes ≥ 0.10 m within 0.2 s at |v| > 1.5 m/s → kerb strike (> 4 m/s hard)
  _kerbs(ev) {
    const K = VEHICLE.kerb, t = this._t, buf = this._kerbI;
    this._kerbI = (buf + 1) % KERB_BUF;
    const speed = Math.abs(this.v);
    for (let i = 0; i < NW; i++) {
      const base = i * KERB_BUF, hNow = this.wheelGround[i];
      this._kerbH[base + buf] = hNow;
      this._kerbT[base + buf] = t;
      let dh = 0;
      for (let k = 0; k < KERB_BUF; k++) {
        if (t - this._kerbT[base + k] > K.window + 1e-9) continue;
        const d = Math.abs(hNow - this._kerbH[base + k]);
        if (d > dh) dh = d;
      }
      if (dh < K.dh - 1e-6) { this._kerbLatch[i] = 0; continue; }
      if (this._kerbLatch[i]) continue;
      this._kerbLatch[i] = 1;
      if (speed <= K.minSpeed) continue;
      const hard = speed > K.hardSpeed;
      // group: one event per crossing of the whole axle group; a harder strike in the group upgrades it
      const fresh = this._odo - this._kerbGroupAt > KERB_GROUP_M;
      if (fresh) { this._kerbGroupAt = this._odo; this._kerbGroupHard = hard; }
      else if (!hard || this._kerbGroupHard) continue;
      else { this._kerbGroupHard = true; this.kpi.kerb = Math.max(0, this.kpi.kerb - 1); } // upgrade soft → hard
      if (hard) this.kpi.kerbHard++; else this.kpi.kerb++;
      ev.push({ type: 'kerb', speed, tag: hard ? 'hard' : 'soft', wheel: i, text: hard ? 'Hard kerb strike!' : 'Kerb strike', kind: hard ? 'bad' : 'warn' });
    }
  }

  // -------------------------------------------------------------- collisions
  _placeBoxes() {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), B = VEHICLE.body, N = VEHICLE.nose, y = this.pose.y;
    const nx = (N.x0 + N.x1) / 2;
    this._body.set(this.pos.x + B.cx * c, y + (B.y0 + B.y1) / 2, this.pos.z - B.cx * s, B.hx, (B.y1 - B.y0) / 2, B.hz, this.yaw);
    this._nose.set(this.pos.x + nx * c, y + (N.y0 + N.y1) / 2, this.pos.z - nx * s, (N.x1 - N.x0) / 2, (N.y1 - N.y0) / 2, N.hz, this.yaw);
  }

  // velocity (world xz) of a point of the carrier: v_ref + ω × (p − ref)
  _pointVel(px, pz, out) {
    const a = this.yaw + this.crabAngle;
    const rx = this.pos.x + this.xRef * Math.cos(this.yaw), rz = this.pos.z - this.xRef * Math.sin(this.yaw);
    out.x = this.v * Math.cos(a) + this.omega * (pz - rz);
    out.z = -this.v * Math.sin(a) - this.omega * (px - rx);
    return out;
  }

  // deepest point of box b along −n (the corner / edge pressed into the obstacle)
  _support(b, nx, nz, out) {
    const ax = b.c, az = -b.s, bx = b.s, bz = b.c; // local x / z axes in world
    const sa = ax * -nx + az * -nz > 0 ? 1 : -1, sb = bx * -nx + bz * -nz > 0 ? 1 : -1;
    out.x = b.cx + sa * b.hx * ax + sb * b.hz * bx;
    out.z = b.cz + sa * b.hx * az + sb * b.hz * bz;
    return out;
  }

  _hit(part, hit, tag, key, env, ev, other) {
    const p = this._support(part, hit.nx, hit.nz, this._w);
    const pv = this._pointVel(p.x, p.z, { x: 0, z: 0 });
    let rvx = pv.x, rvz = pv.z;
    if (other) { rvx -= other.vx || 0; rvz -= other.vz || 0; }
    const vn = -(rvx * hit.nx + rvz * hit.nz); // approach speed into the obstacle (m/s)
    // push out along the contact normal
    this.pos.x += hit.nx * hit.depth;
    this.pos.z += hit.nz * hit.depth;
    this._placeBoxes();
    this.inContact = true;
    const last = this._contacts.get(key);
    const fresh = last === undefined || this._t - last > CONTACT_GAP;
    this._contacts.set(key, this._t);
    const crit = other ? VEHICLE.trafficCriticalSpeed : VEHICLE.collideSpeed;
    if (vn > crit) {
      this.v = 0;
      if (fresh) {
        if (other) {
          this.kpi.trafficCollisions++;
          ev.push({ type: 'trafficCollision', speed: vn, tag: 'traffic', critical: true, text: 'COLLISION WITH TRAFFIC', kind: 'bad' });
        } else {
          this.kpi.collisions++;
          ev.push({ type: 'collision', speed: vn, tag, text: `Collision (${tag}) at ${(vn * 3.6).toFixed(1)} km/h`, kind: 'bad' });
        }
      }
      return;
    }
    // slide along: drop the velocity component into the obstacle
    const a = this.yaw + this.crabAngle, ux = Math.cos(a), uz = -Math.sin(a);
    const un = ux * hit.nx + uz * hit.nz;
    if (this.v * un < 0) this.v *= 1 - un * un;
    if (fresh && vn > -0.05) {
      this.kpi.scrapes++;
      ev.push({ type: 'scrape', speed: Math.max(0, vn), tag, text: `Scrape (${tag})`, kind: 'warn' });
    }
  }

  _collide(env, ev) {
    const fg = VEHICLE.fenceGate.ignore;
    const ign = env.ignore;
    this._placeBoxes();
    const boxes = env.world.boxes;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (!b.enabled) continue;
      const tag = b.tag || '';
      if (tag.startsWith('mobile') || (ign && (ign.has ? ign.has(b) : ign.includes(b)))) continue;
      // continuous south fence (gate included) → replaced by the two segments either side of the gate
      if (tag === fg.tag && Math.abs(b.cz - fg.cz) < fg.tol && b.hx > fg.minHx) continue;
      this._testBox(b, env, ev);
    }
    for (const seg of this._fenceSegs) this._testBox(seg, env, ev);
  }

  _testBox(box, env, ev) {
    const minTop = this.pose.y + VEHICLE.obstacleMinTop; // world boxes lower than 0.35 m are driven over
    for (let k = 0; k < 2; k++) {
      const part = k ? this._nose : this._body;
      if (box.top <= Math.max(minTop, part.bottom) || box.bottom >= part.top) continue;
      const hit = obbXZ(part, box);
      if (hit) this._hit(part, hit, box.tag || 'obstacle', box.id, env, ev, null);
    }
  }

  _collideTraffic(env, ev) {
    this._placeBoxes();
    const cars = env.traffic.vehicleBoxes(this._body.cx, this._body.cz, 18, this._cars);
    if (!cars || !cars.length) return;
    const y = this.pose.y;
    for (const car of cars) {
      for (const part of [this._body, this._nose]) {
        if (part === this._nose && (car.h ?? 1.5) + (car.y ?? 0) < y + VEHICLE.nose.y0) continue;
        const hit = obbXZ(part, car);
        if (hit) this._hit(part, hit, 'traffic', car.id ?? car, env, ev, car);
      }
    }
  }

  // -------------------------------------------------------------- zones and KPIs
  _zone(dt, env, ev) {
    const f = env.siteRect || SITE.fence;
    const inGate = inRect(GATE_ZONE, this.pos.x, this.pos.z);
    const inSite = inRect(f, this.pos.x, this.pos.z);
    this.zone = inGate ? 'gate' : inSite ? 'site' : 'road';
    const siteLimit = env.limitKmh ?? SPEED_LIMITS.siteKmh;
    this.limitKmh = this.zone === 'road' ? SPEED_LIMITS.roadKmh : this.zone === 'gate' ? SPEED_LIMITS.gateKmh : siteLimit;
    const kmh = Math.abs(this.v) * 3.6;
    // site KPI: time above limit + 1 km/h (11 km/h at the default 10 km/h limit)
    const over = (inSite || inGate) && kmh > siteLimit + (SPEED_LIMITS.siteKpiKmh - SPEED_LIMITS.siteKmh);
    if (inSite || inGate) this.kpi.maxSiteKmh = Math.max(this.kpi.maxSiteKmh, kmh);
    if (over) {
      this.kpi.speedingTime += dt;
      if (!this.speeding) ev.push({ type: 'speeding', kmh, limit: siteLimit, text: `Site speed limit ${siteLimit} km/h`, kind: 'warn' });
    }
    this.speeding = over;
  }

  // -------------------------------------------------------------- outputs
  /** Body OBB (world xz, three.js yaw): the collision box of §7. Cached object. */
  obb() {
    const o = this._obb, B = VEHICLE.body, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    o.x = this.pos.x + B.cx * c; o.z = this.pos.z - B.cx * s;
    o.hx = B.hx; o.hz = B.hz; o.yaw = this.yaw;
    return o;
  }

  /**
   * Street obstacles (§7.1) for streets.traffic/peds.setObstacles: the full road
   * footprint rear end → boom nose (x_c −3.70 … +10.10) plus a reserved
   * envelope in the direction of travel (3 m + 2 s of travel [E]). Traffic
   * management holds cars clear of where the crane is about to be, so an
   * oncoming queue does not form right at the nose of a crane that is still
   * creeping forward into its turn. The obstacle carries the crane's velocity,
   * so following traffic queues at a distance instead of treating it as
   * parked. halfWidth widens it (outrigger floats out); `extra` (e.g. route.js
   * approachHold()) is appended. Returns a cached array (1 or 2 elements).
   * @param {{halfWidth?:number, ahead?:number, extra?:object|null}} [o]
   */
  obstacles(o = {}) {
    const ob = this._obstacles[0], C = AT100.carrier;
    const reserve = o.ahead ?? 3 + 2 * Math.abs(this.v);
    const x0 = C.rearX - (this.v < -0.05 ? reserve : 0), x1 = C.boomNoseX + (this.v >= -0.05 ? reserve : 0), cx = (x0 + x1) / 2;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    ob.x = this.pos.x + cx * c; ob.z = this.pos.z - cx * s;
    ob.hx = (x1 - x0) / 2; ob.hz = Math.max(C.width / 2, o.halfWidth || 0); ob.yaw = this.yaw;
    const a = this.yaw + this.crabAngle;
    ob.vx = this.v * Math.cos(a); ob.vz = -this.v * Math.sin(a);
    const list = this._obstacles;
    list.length = 1;
    if (o.extra) list.push(o.extra);
    return list;
  }

  /**
   * World position of a wheel's contact point.
   * @param {number} i axle 0..4 (front → rear)
   * @param {number} side +1 left (y_c +), −1 right
   */
  wheelWorld(i, side = 1, out = { x: 0, y: 0, z: 0 }) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), x = AXLES[i], y = side * TRACK;
    out.x = this.pos.x + x * c - y * s;
    out.z = this.pos.z - x * s - y * c;
    out.y = this.wheelGround[i * 2 + (side > 0 ? 0 : 1)];
    return out;
  }

  /** HUD / audio snapshot (§8.8 ROAD page). */
  state(out = {}) {
    out.kmh = Math.abs(this.v) * 3.6;
    out.v = this.v;
    out.gear = this.gearName;
    out.rpm = this.rpm;
    out.program = this.program;
    out.parkingBrake = this.parkingBrake;
    out.engineOn = this.engineOn;
    out.engineRunning = this.engineRunning;
    out.limitKmh = this.limitKmh;
    out.zone = this.zone;
    out.crawl = this.crawl;
    out.reverse = this.direction < 0;
    out.steer = this.steerPos;
    out.speeding = this.speeding;
    return out;
  }
}
