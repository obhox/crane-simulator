import * as THREE from 'three';
import { PHYS, G, SITE } from '../config.js';
import { Box } from '../physics/collide.js';
import { HoistSystem } from '../physics/rope.js';
import { RopeRenderer } from '../machines/ropeRender.js';
import { NULL_INPUT, makeMobileStart, displaySlewDeg } from '../machines/machine.js';
import {
  AT100, HOOK_BLOCKS, DRIVES, CAMERA_MODES, MODE_PROFILE, FLOATS, VEHICLE, CW_DECK, TOWER_ZONE, MATS, BASES,
  reeveTime,
} from './config.js';
import { buildMobileCrane } from './model.js';
import { buildMobileHookBlock, blockFallPoints } from './hookBlocks.js';
import { chartKey, chartColumn, permitted, windPermLoad, slewRecRpm } from './charts.js';
import { boomSamples, boomContact } from './boom.js';
import { MobileDrives, rotatingProps, ropeLoads, tiltTorque } from './drives.js';
import { RCL } from './rcl.js';
import { Stability, makeBodies, fillBodies, headCarrier } from './stability.js';
import { Outriggers } from './outriggers.js';
import { Settlement, groundAt, pressureKPa } from './ground.js';
import { Ballast } from './ballast.js';
import { Vehicle, travelInterlock } from './vehicle.js';
import { buildRouteMarkers, guidance, resetGuidance, approachHold } from './route.js';
import { drawCabScreen } from '../hudMobile.js';

// AT-100 5.1 all-terrain crane as a Machine (src/machines/machine.js, spec §9).
//
// Assembled from the Phase-1 modules; this file owns the ORDER of a 120 Hz
// step (§9.4) and everything that couples them:
//   1 mode logic      ROAD / SETUP / CRANE / TIPPING / OVERTURNED, travel
//                     interlock (§6.5), riggers re-reeving, queued presses
//   2 vehicle         ROAD only: Vehicle.update → carrier pose (stability plane
//                     imposed from the wheel-plane fit)
//   3 outriggers      beams / jacks / mats / auto-level (SETUP), ballast stack
//   4 RCL             snapshot of the previous step's geometry → permissions
//   5 drives          slew / luff / telescope / winch / deflection
//   6 head → hoist    head sheave (tipped carrier pose) → HoistSystem.step
//   7 stability       bodies + rope force at the head → support reactions,
//                     pose, FLOAT_LIGHT / LIFTOFF / TIPPING / OVERTURNED
//   8 colliders       own world boxes (tag 'mobile'), mutated in place
//   9 KPIs            counters, boom contact, events → audio / toasts / jobs
//
// Frames (§0): world three.js +y up; carrier frame C = x forward, y left,
// z up (origin on the slew axis at road-stance ground level). The carrier
// pose lives in Stability (x, z, yaw + the resting plane z0/a/b and the tip
// rotation); every world point of the crane goes through stab.carrierPoint(),
// and the model's `tip` group gets stab.rootTransform() so what you see is
// exactly what the physics uses.

const DEG = Math.PI / 180;
const RIDE = AT100.carrier.rideHeight; // 1.30 m frame datum above ground on tyres
const ROAD_MASS = AT100.carrier.basicMassKg + AT100.carrier.hookBallKg; // 46.95 t without CW
const ANCHOR = VEHICLE.stowedHook; // stowed hook bowl on the front bumper (C)
const NO_OBSTACLES = Object.freeze([]);
const NULL_SETUP = Object.freeze({ beam: 0, jack: 0, autoLevel: false, ballast: false });
const FENCE = SITE.fence;
const EAST_LANE_Z = -64.25; // eastbound lane next to the site (road centre −66, lane 1.75 off)
const insideFence = (p) => p.x > FENCE.minX && p.x < FENCE.maxX && p.z > FENCE.minZ && p.z < FENCE.maxZ;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const sgn = (v) => (v > 0.02 ? 1 : v < -0.02 ? -1 : 0);
const clampSpeed = (v, max) => { const l = v.length(); if (l > max) v.multiplyScalar(max / l); };
const SEL_ACT = { selectFL: 'sel0', selectFR: 'sel1', selectRL: 'sel2', selectRR: 'sel3', selectAll: 'selAll' };
const PERM_KEYS = ['hoistUp', 'lower', 'luffUp', 'luffDown', 'teleOut', 'teleIn', 'slewL', 'slewR'];
// RCL ids (rcl.js, upper case) → HUD / job ids (hudMobile.js RCL_LABELS)
const STOP_ID = {
  LMB: 'lmb', HOOK_LIMIT: 'hookLimit', RANGE: 'range', TELE_LOAD: 'teleLoad', BLOCK: 'blockRating', NO_CONFIG: 'noConfig',
  NOT_PERMITTED: 'notPermitted', LOWER_LIMIT: 'lowerLimit', TOWER_ZONE: 'zone', ROAD_ZONE: 'roadZone', PINNED: 'pinned',
  LUFF_MAX: 'luffStop', LUFF_MIN: 'luffStop', RMIN: 'RMIN',
};
const WARN_ID = {
  SUPPORT_CONFIG: 'support', TILT: 'tilt', WIND: 'wind', TYRES_NOT_CLEAR: 'tyres', FLOAT_LIGHT: 'floatLight', LIFTED: 'floatLifted',
  SIDE_PULL: 'sidePull', HOIST_OVERLOAD: 'hoistOverload', TELE_NOT_PINNED: 'unpinned', RECONFIRM: 'reeving', BYPASS: 'bypass',
};
// boom contact (§3.7): all boom motions stop, after 0.5 s only moves away from the contact
const CONTACT_LOCK = 0.5;
const CONTACT_EVERY = 3; // steps between boom-contact sweeps (40 Hz)
const WINCH_SLIP = 1.6 * AT100.hoist.linePullN; // N per fall: winch holding brake slips [E]

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _pa = { x: 0, y: 0, z: 0 };
const _pb = { x: 0, y: 0, z: 0 };

export class MobileMachine {
  /** @param {import('../machines/machine.js').MachineCtx} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.id = 'mobile';
    this.label = 'Mobile AT-100 5.1';
    this.gf = (x, z) => (ctx.terrain?.heightAt ? ctx.terrain.heightAt(x, z) : 0);

    // simulation modules (Phase 1)
    this.vehicle = new Vehicle();
    this.drives = new MobileDrives({ k: 0 });
    this.rcl = new RCL();
    this.stab = new Stability();
    this.bodiesC = makeBodies();
    this.outr = new Outriggers();
    this.settle = new Settlement();
    this.ballast = new Ballast();
    // jobs.js / hud fallbacks read these names
    this.outriggers = this.outr;
    this.stability = this.stab;
    this.settlement = this.settle;

    // state
    this.mode = 'CRANE';
    this.block = 'ball';
    this.stowed = false;
    this.power = false;
    this.eStop = false;
    this.remoteStop = false; // SETUP remote stop button (Space)
    this.parked = false;
    this.siteTravel = false;
    this.reeving = null; // {from, to, t, total} while the riggers re-reeve
    this.t = 0; // sim time
    this.R = 0; this.thetaG = 0;
    this.anemo = 0; this.gustPeak = 0;
    this.cabTilt = 0;
    this.craneRpm = 0;
    this.levers = { slew: 0, trolley: 0, hoist: 0, tele: 0, luff: 0 };
    this.perm = Object.fromEntries(PERM_KEYS.map((k) => [k, 0]));
    this.counters = { twoBlockCount: 0, lmiTrips: 0 };
    this.driveActs = [];
    this.setupActs = [];
    this._drive = { throttle: 0, brake: 0, steer: 0, crawl: false };
    this._outEnv = { pose: null, floatR: null, enabled: false, compositeStock: 0, settle: null, ignore: null };
    this._snapObj = { floats: [0, 1, 2, 3].map(() => ({ light: false, lifted: false })), beamsActual: [0, 0, 0, 0], axis: { x: 0, z: 0 } };
    this._dctx = {};
    this._rp = { inertia: 0, mu: 0, mass: 0 };
    this._rl = {};
    this._F = { x: 0, y: 0, z: 0 };
    this._sup = null;
    this._contact = null; // boom contact episode {t, clear, cmd}
    this._contactN = 0;
    this._candidates = [];
    this._samples = [];
    this._samplesW = [];
    this._audio = []; // one-shot audio events, drained by audioState()
    this._events = []; // scratch
    this._bPrev = false;
    this._prevWarn = new Set();
    this._hs = null; this._hsT = -1;
    this._chart = { key: '', L: 0, cells: [] };
    this.hc = { x: 0, y: 0, z: 0 }; // head sheave in C (road stance)
    this.headW = new THREE.Vector3();
    this.axisW = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.anchorW = new THREE.Vector3();

    // KPI counters for the job runner (monotonic between resets, §8.5)
    const self = this;
    this.kpi = {
      get collisions() { return self.vehicle.kpi.collisions; },
      get scrapes() { return self.vehicle.kpi.scrapes; },
      get kerb() { return self.vehicle.kpi.kerb; },
      get kerbHard() { return self.vehicle.kpi.kerbHard; },
      get speedingTime() { return self.vehicle.kpi.speedingTime; },
      get trafficCollisions() { return self.vehicle.kpi.trafficCollisions; },
      sidePulls: 0, boomContacts: 0, floatLight: 0, liftoffs: 0, slams: 0,
      get maxSettlement() { return self.settle.maxS; },
      punchThrough: 0, overturned: false,
      get rclWarnTime() { return self.rcl.counters.warnTime; },
      // support / tilt / tyres ≠ config time while the RCL is ON (the RCL keeps evaluating its
      // warnings while switched off, e.g. while driving on 0 % beams with a B100 config)
      mismatchTime: 0,
      timePenalty: 0,
    };

    // model (WP-MODEL): parts.root stays at the world origin; the carrier
    // group is identity and the tip group carries the whole carrier pose
    this.parts = buildMobileCrane(ctx.craneMats);
    this.root = this.parts.root;
    ctx.scene.add(this.root);
    this.parts.setCarrierPose(0, 0, 0, 0, 0, 0);
    this.hookBlock = null;
    this._hookId = null;
    this._tops = []; this._bots = []; this._lead = []; this._p6 = [0, 0, 0, 0, 0, 0];

    // one HoistSystem of its own (loads are shared with the tower)
    const b = HOOK_BLOCKS.ball;
    this.hoist = new HoistSystem(ctx.world, ctx.wind, {
      hookMass: b.massKg, ropeEA: AT100.hoist.ropeEA, deadLength: () => this.drives.L + DRIVES.hoist.deadExtra, hookHalf: b.half,
    });
    this.ropes = new RopeRenderer(ctx.scene, ctx.craneMats?.rope || new THREE.MeshStandardMaterial({ color: 0x8d9195, roughness: 0.45, metalness: 0.9 }));
    this.route = buildRouteMarkers(ctx.scene, { terrain: ctx.terrain });

    // own collider boxes (tag 'mobile': the vehicle, outrigger obstruction and
    // boom-contact tests skip them): chassis, rear ballast deck (slabs land on
    // it), driver cab, superstructure
    this.colliders = [
      new Box(0, 0, 0, 1, 1, 1, 0, 'mobile'), new Box(0, 0, 0, 1, 1, 1, 0, 'mobile'),
      new Box(0, 0, 0, 1, 1, 1, 0, 'mobile'), new Box(0, 0, 0, 1, 1, 1, 0, 'mobile'),
    ];
    this._ignore = new Set(this.colliders);
    this.reset(makeMobileStart(ctx.settings?.mobileStart === 'road' ? 'road' : 'pad'));
  }

  // ------------------------------------------------------------- contract
  get hoistSpeed() { return this.stowed ? 0 : this.drives.hookVel; }
  get blockDef() { return HOOK_BLOCKS[this.block] || HOOK_BLOCKS.ball; }
  get boomLen() { return this.drives.L; }
  get cwKg() { return this.ballast.superKg; }
  get pos() { return this.vehicle.pos; }
  get yaw() { return this.vehicle.yaw; }
  get boom() { return this.drives.boom; }
  inputProfile() { return MODE_PROFILE[this.mode] || 'mobile-crane'; }
  cameraModes() { return CAMERA_MODES[this.mode] || CAMERA_MODES.CRANE; }
  signallerGeometry() { return { cx: this.vehicle.pos.x, cz: this.vehicle.pos.z, radialOut: 'Boom down', radialIn: 'Boom up' }; }
  // §3.4: hold-Z ×4 only with no suspended load (and never during a tip-over)
  canTimeWarp() {
    if (this.mode === 'TIPPING' || this.mode === 'OVERTURNED') return false;
    return !(this.hoist.load && !this.hoist.loadGrounded);
  }
  canPark() {
    return this.hoist.load && !this.hoist.loadGrounded ? { ok: false, reason: 'Land the load first' } : { ok: true };
  }
  park() { this.parked = true; this.power = false; this.route.setVisible(false); }
  activate() { this.parked = false; }

  // Street obstacles (§7.1): the carrier footprint (plus floats when set up) while it is near the
  // public road; route.approachHold() adds the banksman's hold of the oncoming lane at the gate.
  vehicleObstacles() {
    const v = this.vehicle;
    if (v.pos.z > -46) return NO_OBSTACLES;
    let half = 0;
    if (this.mode !== 'ROAD') for (const bm of this.outr.beams) half = Math.max(half, bm.y + 0.4);
    const road = this.mode === 'ROAD';
    const base = v.obstacles({ extra: road ? approachHold(v.pos, v.yaw) : null, halfWidth: half });
    const list = this._obst || (this._obst = []);
    list.length = 0;
    for (const o of base) list.push(o);
    // Rolling closure behind the crane [E]: from the moment it leaves its lane for the far lane
    // until its tail is through the gate, an escort holds the eastbound lane just behind the
    // carrier. Without it, cars pass on the inside and are caught alongside the crane when it
    // swings across their lane into the gate (traffic cannot reverse out of the sweep).
    const rearX = v.pos.x + AT100.carrier.rearX * Math.cos(v.yaw);
    const rearZ = v.pos.z - AT100.carrier.rearX * Math.sin(v.yaw);
    if (road && v.pos.x > -95 && v.pos.x < -20 && rearZ < -60.5) {
      const h = this._escort || (this._escort = { x: 0, z: EAST_LANE_Z, hx: 2.5, hz: 1.75, yaw: 0, vx: 0, vz: 0 });
      h.x = Math.min(rearX, v.pos.x) - 4;
      h.vx = Math.max(0, v.v * Math.cos(v.yaw));
      list.push(h);
    }
    return list;
  }

  cameraRig() {
    if (!this._rig) {
      const P = this.parts, hoist = this.hoist, stab = this.stab, outr = this.outr;
      this._rig = {
        // the operator eye rides in the tilting crane cab (model mount; the spec's y 1.45 would be outside the carrier)
        cab: { parent: P.craneCab, headPos: P.cameraMounts.craneEye.position.clone(), baseYaw: -Math.PI / 2, limits: { pitchMax: 1.25, autoPitchMax: 1.15 } },
        driver: { parent: P.driverCab, headPos: P.cameraMounts.driverEye.position.clone(), baseYaw: -Math.PI / 2 },
        hook: { parent: P.head.headCamMount, pos: new THREE.Vector3(0, -0.4, 0) }, // self-levelling, looks down
        carrier: P.carrier,
        chaseTarget: (out) => stab.carrierPoint(4, 0, 2, out, true),
        setupTarget: (out) => {
          const i = outr.selected;
          if (i >= 4) return stab.carrierPoint(0.9, 0, 0, out, false);
          const f = outr.floatWorld[i];
          return out.set(f.x, f.y, f.z);
        },
        focus: (out) => out.copy(hoist.load ? hoist.load.pos : hoist.hook),
      };
    }
    return this._rig;
  }

  // ------------------------------------------------------------- reset
  /** @param {import('../machines/machine.js').MobileStart} start */
  reset(start = makeMobileStart('pad')) {
    const s = start, ctx = this.ctx, hoist = this.hoist, d = this.drives, stab = this.stab, v = this.vehicle;
    if (hoist.load) hoist.detach();
    this.mode = s.mode === 'ROAD' || s.mode === 'SETUP' ? s.mode : 'CRANE';
    this._preTip = null;
    this.power = false; this.eStop = false; this.remoteStop = false; this.parked = false;
    this.siteTravel = !!s.siteTravel;
    this.block = HOOK_BLOCKS[s.block] ? s.block : 'ball';
    this.reeving = null; this._contact = null;
    this.driveActs.length = 0; this.setupActs.length = 0; this._audio.length = 0;
    const blk = this.blockDef;
    // ballast first (the vehicle mass depends on it)
    this.ballast.reset(s.cwKg || 0, s.deckSlabs || []);
    const pos = s.pos || { x: 0, z: 0 };
    v.reset({
      x: pos.x, z: pos.z, yaw: s.yaw ?? 0, engine: true,
      // on the public road the carrier is rolling in traffic; anywhere on site it stands parked
      parkingBrake: this.mode !== 'ROAD' || insideFence(pos),
      massKg: ROAD_MASS + this.ballast.totalKg, terrain: ctx.terrain,
    });
    resetGuidance();
    // crane: road trim is pinned at 0° (travel interlock)
    const stowed = s.ropeLen === null || s.ropeLen === undefined;
    d.reset({
      psi: (s.slewDeg || 0) * DEG, theta: (s.luffDeg || 0) * DEG, boomK: s.boomK ?? 0, ropeLen: stowed ? 3.5 : s.ropeLen,
      falls: blk.falls, blockHeight: blk.height, pinned: this.mode === 'ROAD' || !!s.pinned,
    });
    this._setHookMesh(this.block);
    hoist.setHookBlock({ mass: blk.massKg, half: blk.half });
    hoist.falls = blk.falls;
    this.stowed = stowed;
    hoist.stowed = stowed;
    // carrier pose, outriggers, ground
    stab.reset();
    stab.setCarrier(v.pos.x, v.pos.z, v.yaw);
    stab.setPlane(v.pose.y + RIDE, Math.tan(v.pose.pitch), Math.tan(v.pose.roll));
    this.outr.reset(s, this.gf, stab.pose);
    this.settle.reset();
    this.rcl.reset(s.rcl || this.rcl.config, false);
    this.rcl.resetCounters();
    this.counters.twoBlockCount = 0; this.counters.lmiTrips = 0;
    const k = this.kpi;
    k.sidePulls = k.boomContacts = k.floatLight = k.liftoffs = k.slams = k.punchThrough = k.timePenalty = k.mismatchTime = 0;
    k.overturned = false;
    this._prevWarn.clear();
    this._bPrev = false;
    this._lightEp = this._liftEp = false;
    this._guideT = 0;
    // placed on the public road (M1 / free-play road start): moving cars there are cleared away
    // The banksman's gate hold (route.approachHold) stops new oncoming cars east of the gate; the
    // westbound stretch between that hold and the crane starts clear, as it would once traffic
    // management is in place for the mobilisation [E].
    if (this.mode === 'ROAD' && !insideFence(v.pos)) {
      ctx.streets?.clearArea?.(v.obstacles({ ahead: 12 })[0], 2);
      if (v.pos.x < -20) ctx.streets?.clearArea?.({ x: (v.pos.x - 20 - 20) / 2, z: -67.75, hx: (-20 - v.pos.x + 20) / 2, hz: 1.75, yaw: 0 }, 1);
    }
    // settle the carrier on its supports (latches the floats, fills the ground-compliance filter)
    if (this.mode !== 'ROAD') this._presettle(stowed ? 0 : (blk.massKg + (s.attach ? s.attach.mass : 0)) * G);
    this._geometry();
    // hoist: stowed on the bumper, or hanging at ropeLen
    if (stowed) {
      this._anchor(this.anchorW);
      d.setFallLength(Math.max(this.headW.distanceTo(this.anchorW), d.ropeLenMin + 0.05));
      hoist.ropeLen = d.fallLength();
      hoist.reset(this.headW);
      hoist.hook.copy(this.anchorW); hoist.hookPrev.copy(this.anchorW);
    } else {
      d.setFallLength(Math.max(d.ropeLenMin, s.ropeLen));
      hoist.ropeLen = d.fallLength();
      hoist.reset(this.headW);
      if (s.attach) {
        const a = s.attach;
        a.pos.set(hoist.hook.x, hoist.hook.y - a.hangLength, hoist.hook.z);
        a.yaw = v.yaw + d.psi;
        hoist.attach(a);
        a.sync();
      }
    }
    hoist.tension = hoist.tensionFiltered = stowed ? 0 : (blk.massKg + (hoist.load ? hoist.load.mass : 0)) * G;
    this.t = 0;
    this.anemo = ctx.wind ? ctx.wind.speedAt(this.headW.y) : 0;
    this.gustPeak = this.anemo;
    this.cabTilt = 0;
    this.craneRpm = 0;
    for (const kk of PERM_KEYS) this.perm[kk] = 0;
    this._updateColliders();
    this.route.setVisible(false);
    this._hsT = -1;
  }

  // static solve of the carrier on its outriggers / tyres after a reset
  _presettle(ropeN) {
    const stab = this.stab, d = this.drives, dt = 1 / 120;
    stab.snap();
    headCarrier(d.psi, d.theta, d.L, 0, 0, this.hc);
    for (let i = 0; i < 90; i++) {
      this._fillBodies();
      const sup = this.outr.supports(stab.pose, this.settle.s, stab.floatR, this.gf, dt);
      stab.carrierPoint(this.hc.x, this.hc.y, this.hc.z, _pa, false);
      this._F.x = 0; this._F.y = -ropeN; this._F.z = 0;
      stab.update(dt, stab.bodiesWorld(this.bodiesC), this._F, _pa, sup);
      this._sup = sup;
    }
    stab.events.length = 0;
    this.outr.events.length = 0;
  }

  _fillBodies() {
    const d = this.drives, b = this.ballast;
    let deckZ;
    // lowering: the slabs come down from the CW frame to the deck
    if (b.raising && b.raising.dir < 0) deckZ = AT100.cwCg.z + (CW_DECK.topZ + 0.25 - AT100.cwCg.z) * b.progress;
    fillBodies(this.bodiesC, {
      psi: d.psi, theta: d.theta, ext: d.boom.ext, dv: d.dv, dl: d.dl,
      cwKg: b.raising && b.raising.dir < 0 ? 0 : b.superKg, deckKg: b.deckKg + (b.raising && b.raising.dir < 0 ? b.superKg : 0),
      deckH: b.deckH, deckZ: deckZ ?? b.deckZ,
    });
  }

  _setHookMesh(id) {
    if (this.hookBlock && this._hookId === id) return;
    if (this.hookBlock) this.hookBlock.removeFromParent();
    this.hookBlock = buildMobileHookBlock(id, this.ctx.craneMats);
    this.hookBlock.name = 'mobileHook.' + id;
    this.ctx.scene.add(this.hookBlock);
    this._hookId = id;
  }

  _anchor(out) { return this.stab.carrierPoint(ANCHOR.x, ANCHOR.y, ANCHOR.z, out, true); }

  // head sheave, slew axis, radius and gravity-referenced boom angle for the current drive state
  _geometry() {
    const d = this.drives, stab = this.stab, hc = this.hc;
    headCarrier(d.psi, d.theta, d.L, d.dv, d.dl, hc);
    stab.carrierPoint(hc.x, hc.y, hc.z, this.headW, true);
    stab.carrierPoint(0, 0, hc.z, this.axisW, true);
    this.R = Math.hypot(this.headW.x - this.axisW.x, this.headW.z - this.axisW.z);
    const a = stab.pose.a, b = stab.pose.b;
    this.thetaG = d.theta + Math.atan(a * Math.cos(d.psi) + b * Math.sin(d.psi));
    stab.carrierPoint(0, 0, RIDE, _pa, true);
    stab.carrierPoint(0, 0, RIDE + 1, _pb, true);
    this.up.set(_pb.x - _pa.x, _pb.y - _pa.y, _pb.z - _pa.z).normalize();
  }

  // ------------------------------------------------------------- actions
  handleAction(a, api) {
    this._api = api;
    this._hsT = -1;
    const toast = (t, k = 'info') => (api?.toast ? api.toast(t, k) : this.ctx.hud?.toast?.(t, k));
    const d = this.drives, mode = this.mode;
    const crane = mode === 'CRANE' || mode === 'TIPPING';
    switch (a) {
      case 'hook': return this._hookAction(toast);
      case 'power': {
        if (!crane) { toast('Crane power is switched in the cab (Enter)', 'info'); return true; }
        if (this.eStop || !this.power) {
          if (api?.input?.anyLeverOffNeutral) { toast('Zero-position interlock: return the levers to neutral', 'bad'); return true; }
          this.eStop = false;
          this.power = true;
          // every power-on asks for the configuration again (LICCON [S14]); pre-filled with the last one
          this.rcl.reset(this.rcl.config, true);
          this.rcl.powerOn();
          this.ctx.audio?.clunk?.(0.3);
          toast('Crane power ON — confirm the RCL configuration (L)', 'good');
          this._openConfig(api, toast);
        } else {
          this.power = false;
          toast('Crane power OFF', 'info');
        }
        return true;
      }
      case 'estop':
        if (mode === 'SETUP') {
          this.remoteStop = !this.remoteStop;
          toast(this.remoteStop ? 'REMOTE STOP — outrigger motions halted (Space to release)' : 'Remote stop released', this.remoteStop ? 'bad' : 'info');
          return true;
        }
        this.eStop = true;
        this.power = false;
        toast('EMERGENCY STOP — press P to reset', 'bad');
        return true;
      case 'gear': case 'program': case 'parkingBrake': case 'engine':
        if (mode !== 'ROAD') return false;
        this.driveActs.push(a);
        return true;
      case 'toSetup': return this._toSetup(toast, api);
      case 'toCrane':
        if (mode !== 'SETUP') return false;
        this.mode = 'CRANE';
        this.remoteStop = false;
        toast(this.power ? 'In the cab' : 'In the cab — P to power on', 'info');
        return true;
      case 'toRoad': return this._toRoad(toast);
      case 'selectFL': case 'selectFR': case 'selectRL': case 'selectRR': case 'selectAll':
        if (mode !== 'SETUP') return false;
        this.setupActs.push(SEL_ACT[a]);
        return true;
      case 'selectPrev': case 'selectNext': {
        if (mode !== 'SETUP') return false;
        const n = (this.outr.selected + (a === 'selectNext' ? 1 : 4)) % 5;
        this.setupActs.push(n >= 4 ? 'selAll' : `sel${n}`);
        return true;
      }
      case 'mat':
        if (mode !== 'SETUP') return false;
        this.setupActs.push('mat');
        return true;
      case 'pin': {
        if (mode !== 'SETUP' && !crane) return false;
        if (d.pinned && this.ballast.busy) { toast('BALLAST MOVING — finish or reverse the ballasting first', 'warn'); return true; }
        const r = d.setTurntablePin(!d.pinned);
        if (!r.ok) toast(r.reason, 'warn');
        else toast(d.pinned ? 'Turntable pinned' : 'Turntable unpinned', 'info');
        return true;
      }
      case 'freeslew': {
        if (!crane) return false;
        const r = d.setFreeSlew(!d.freeSlew);
        toast(r.ok ? (d.freeSlew ? 'Free slew ON — slewing gear released' : 'Free slew OFF') : r.reason, r.ok ? 'info' : 'warn');
        return true;
      }
      case 'rclConfig':
        if (!crane) return false;
        if (!this.power || this.eStop) { toast('RCL is off — power on first (P)', 'warn'); return true; }
        this._openConfig(api, toast);
        return true;
      case 'rclMute': {
        if (!crane) return false;
        const r = this.rcl.mute();
        toast(r.ok ? 'RCL alarm muted' : r.reason, r.ok ? 'info' : 'warn');
        return true;
      }
      case 'bypass': {
        if (!crane) return false;
        if (this.rcl.bypass) { this.rcl.setBypass(false); toast('RCL bypass off', 'info'); return true; }
        const r = this.rcl.setBypass(true, !!this.ctx.settings?.allowBypass);
        toast(r.ok ? 'RCL EMERGENCY BYPASS — all motions at 15 %, RCL ignored' : r.reason, 'bad');
        return true;
      }
      case 'reeving': {
        if (!crane) return false;
        const why = this._reeveBlocked();
        if (why) { toast(why, 'warn'); return true; }
        const hud = api?.hud || this.ctx.hud;
        if (hud?.openReevingDialog) hud.openReevingDialog(this.block, (id) => this.startReeve(id, toast));
        return true;
      }
      default:
        return false;
    }
  }

  _openConfig(api, toast) {
    const hud = api?.hud || this.ctx.hud;
    if (!hud?.openConfigDialog) return;
    hud.openConfigDialog(this.rcl.config, (cfg) => {
      const r = this.rcl.configure(cfg);
      if (!r.ok) return r;
      const c = this.rcl.confirm();
      if (!c.ok) return c;
      this._hsT = -1;
      toast(`RCL configuration confirmed: ${this.rcl.shortCode}`, 'good');
      return { ok: true };
    }, { permitted: (c) => permitted(c), sensed: { beams: this.outr.beams.map((b) => b.ext) } });
  }

  _toSetup(toast, api) {
    const v = this.vehicle;
    if (this.mode === 'ROAD') {
      if (!v.standstill || !v.parkingBrake) { toast('Stop and apply the parking brake (F) before setting up', 'warn'); return true; }
      this.mode = 'SETUP';
      this.stab.snap(); // the resting plane is re-solved on the tyres
      this.route.setVisible(false);
      toast('Outrigger remote: 1–5 select, A/D beams, W/S jacks, X mat, G auto-level', 'info');
      return true;
    }
    if (this.mode === 'CRANE') {
      if (this.hoist.load && !this.hoist.loadGrounded) { toast('Land the load before leaving the cab', 'warn'); return true; }
      this.mode = 'SETUP';
      this.remoteStop = false;
      if (this.ballast.deckStack.length) (api?.hud || this.ctx.hud)?.openBallastPanel?.(this._ballastHud());
      return true;
    }
    return false;
  }

  _travelCheck() {
    const d = this.drives, v = this.vehicle;
    return travelInterlock({
      beams: this.outr.beams.map((b) => b.ext), jacks: this.outr.jacks.map((j) => j.e), pinned: d.pinned,
      slewDeg: wrapPi(d.psi) / DEG, luffDeg: d.theta / DEG, boomLen: d.L, stowed: this.stowed, cwKg: this.ballast.superKg,
      deckSlabs: this.ballast.deckStack.length, siteTravel: this.siteTravel && insideFence(v.pos),
    });
  }

  _toRoad(toast) {
    if (this.mode !== 'SETUP') return false;
    const r = this._travelCheck();
    if (!r.ok) { toast(r.text, 'bad'); return true; }
    const v = this.vehicle;
    this.mode = 'ROAD';
    this.power = false;
    v.mass = ROAD_MASS + this.ballast.totalKg;
    // the carrier sits on its tyres again: the vehicle's terrain fit takes the pose over
    this.stab.setPlane(v.pose.y + RIDE, Math.tan(v.pose.pitch), Math.tan(v.pose.roll));
    toast('ROAD mode — release the parking brake (F) to drive', 'info');
    return true;
  }

  _hookAction(toast) {
    if (this.mode !== 'CRANE') return false;
    const hoist = this.hoist, d = this.drives;
    if (this.stowed) {
      // §3.5: the riggers unhook the block from the bumper; it swings under the head
      this.stowed = false;
      hoist.stowed = false;
      d.setFallLength(Math.max(d.ropeLenMin, this.headW.distanceTo(hoist.hook)));
      hoist.ropeLen = d.fallLength();
      hoist.hookVel.set(0, 0, 0);
      this._guideT = 4;
      this._audio.push({ type: 'hookRelease' });
      toast('Hook block released from the bumper', 'info');
      return true;
    }
    if (!hoist.load && d.L < 11.6 && d.theta < 3 * DEG && hoist.hook.distanceTo(this._anchor(_v)) < 1.2) {
      this.stowed = true;
      hoist.stowed = true;
      this._audio.push({ type: 'stow' });
      toast('Hook block stowed on the bumper', 'info');
      return true;
    }
    return false;
  }

  _reeveBlocked() {
    const hoist = this.hoist;
    if (this.reeving) return 'The riggers are already re-reeving';
    if (hoist.load) return 'Release the load before re-reeving';
    if (this.stowed) return 'Release the hook block from the bumper and land it first';
    if (!hoist.hookGrounded) return 'Land the hook block on the ground first (the riggers re-reeve it there)';
    return null;
  }

  /** Riggers re-reeve to block id (dialog callback). @returns {{ok, reason?}} */
  startReeve(id, toast = (t, k) => this.ctx.hud?.toast?.(t, k)) {
    if (!HOOK_BLOCKS[id] || id === this.block) return { ok: false, reason: 'Already reeved' };
    const why = this._reeveBlocked();
    if (why) return { ok: false, reason: why };
    const total = reeveTime(this.block, id);
    this.reeving = { from: this.block, to: id, t: 0, total, progress: 0 };
    toast(`Riggers re-reeving to the ${HOOK_BLOCKS[id].name} (${total} s)`, 'info');
    return { ok: true };
  }

  _finishReeve() {
    const r = this.reeving;
    this.reeving = null;
    const blk = HOOK_BLOCKS[r.to];
    const hoist = this.hoist;
    if (!hoist.setHookBlock({ mass: blk.massKg, half: blk.half })) return;
    this.block = r.to;
    this.drives.setReeving(blk.falls, blk.height);
    hoist.falls = blk.falls;
    hoist.ropeLen = this.drives.fallLength();
    this._setHookMesh(r.to);
    // the RCL cannot sense the reeving: it only asks the operator to confirm again
    this.rcl.requireConfirm('REEVING CHANGED — CONFIRM CONFIG');
    this._audio.push({ type: 'hookRelease' });
    this.ctx.hud?.toast?.(`Reeved: ${blk.name}, ${blk.falls} fall${blk.falls > 1 ? 's' : ''} — confirm the RCL configuration (L)`, 'good');
  }

  _ballastPress() {
    const r = this.ballast.toggle(this.drives.pinned);
    const hud = this._api?.hud || this.ctx.hud;
    if (!r.ok) hud?.toast?.(`Ballast: ${r.reason}`, 'warn');
    else hud?.openBallastPanel?.(this._ballastHud());
  }

  /** Released load → ballast slab absorbed into the deck stack (§6.6). */
  onRelease(load) {
    const v = this.vehicle;
    const pose = { x: v.pos.x, z: v.pos.z, yaw: v.yaw, z0: this.stab.pose.z0 };
    if (!this.ballast.canAbsorb(load, pose)) {
      // a counterweight slab set down near the deck but outside the tolerances: say why
      if (load.def?.slab && this.ballast.lastReason && this.ballast.lastReason !== 'not a counterweight slab') {
        (this._api?.hud || this.ctx.hud)?.toast?.(`Ballast: ${this.ballast.lastReason}`, 'warn');
      }
      return false;
    }
    this.ballast.absorb(load);
    load.absorbed = true;
    if (this.ctx.removeLoad) this.ctx.removeLoad(load);
    else {
      load.mesh.removeFromParent();
      this.ctx.world.remove(load.box);
      const i = this.ctx.loads?.indexOf(load) ?? -1;
      if (i >= 0) this.ctx.loads.splice(i, 1);
    }
    this._audio.push({ type: 'ballast' });
    const hud = this._api?.hud || this.ctx.hud;
    hud?.toast?.(`${load.def.name} on the carrier deck — slew to 0°, pin (T) and hold B in SETUP to raise it`, 'good');
    hud?.openBallastPanel?.(this._ballastHud());
    this._hsT = -1;
    return true;
  }

  // ------------------------------------------------------------- 120 Hz step
  /** @param {number} dt @param {import('../machines/machine.js').MachineInput} input */
  step(dt, input = NULL_INPUT) {
    const inp = input || NULL_INPUT;
    const ctx = this.ctx, hoist = this.hoist, d = this.drives, stab = this.stab, v = this.vehicle, outr = this.outr;
    const lev = inp.levers || NULL_INPUT.levers;
    this.t += dt;

    // ---- 1 mode logic
    if (this.reeving) {
      this.reeving.t += dt;
      this.reeving.progress = Math.min(1, this.reeving.t / this.reeving.total);
      if (this.reeving.t >= this.reeving.total) this._finishReeve();
    }
    let mode = this.mode;
    const overturned = mode === 'OVERTURNED';

    // ---- 2 vehicle (ROAD)
    stab.setCarrier(v.pos.x, v.pos.z, v.yaw);
    if (mode === 'ROAD') {
      const dr = this._drive, di = inp.drive || NULL_INPUT.drive;
      dr.throttle = di.throttle || 0; dr.brake = di.brake || 0; dr.steer = di.steer || 0;
      dr.crawl = !!(di.crawl || inp.micro);
      const ev = v.update(dt, dr, this.driveActs, {
        terrain: ctx.terrain, world: ctx.world, traffic: ctx.streets?.traffic, limitKmh: ctx.settings?.siteSpeedLimit ?? 10,
      });
      this.driveActs.length = 0;
      this._vehicleEvents(ev);
      stab.setCarrier(v.pos.x, v.pos.z, v.yaw);
      stab.setPlane(v.pose.y + RIDE, Math.tan(v.pose.pitch), Math.tan(v.pose.roll));
    } else this.driveActs.length = 0;

    // ---- 3 outriggers + ballast
    if (mode !== 'ROAD' && !overturned) {
      const su = mode === 'SETUP' ? (inp.setup || NULL_SETUP) : NULL_SETUP;
      const env = this._outEnv;
      env.pose = stab.pose; env.floatR = stab.floatR; env.settle = this.settle.s;
      env.enabled = mode === 'SETUP' && v.engineRunning && v.parkingBrake && !this.remoteStop && !this.eStop;
      env.compositeStock = ctx.jobs?.compositeStock ?? 0;
      outr.update(dt, su, this.setupActs, ctx.world, this.gf, env);
      this.setupActs.length = 0;
      const hold = mode === 'SETUP' && !!su.ballast;
      if (hold && !this._bPrev) this._ballastPress();
      this._bPrev = hold;
    } else { this.setupActs.length = 0; this._bPrev = false; }
    if (!overturned) {
      this.ballast.quick = !!ctx.settings?.quickBallast;
      this._ballastEvents(this.ballast.update(dt, mode === 'SETUP' && this._bPrev, d.pinned));
    }

    // ---- 4 RCL: snapshot of the previous step's geometry → permissions
    const crane = mode === 'CRANE' || mode === 'TIPPING';
    const blk = this.blockDef;
    const tension = this.stowed ? 0 : Math.min(hoist.tension, WINCH_SLIP * blk.falls);
    const rp = rotatingProps(this.ballast.superKg, d.theta, d.boom.ext, d.L, this._rp);
    const RL = ropeLoads(hoist.sheave, hoist.hook, tension, this.axisW, v.yaw + d.psi, d.theta, this.up, this._rl);
    const load = hoist.load;
    const S = this._snapObj;
    S.grossKg = this.stowed ? 0 : hoist.tensionFiltered / G;
    S.R = this.R; S.L = d.L; S.pinnedK = d.boom.k; S.thetaG = this.thetaG; S.luffDeg = d.theta / DEG;
    S.headPos = this.headW; S.hookPos = hoist.hook; S.loadPos = load ? load.pos : null;
    S.loadExt = load ? Math.max(load.half.x, load.half.z) : 0;
    S.loadAttached = !!load; S.loadGrounded = hoist.loadGrounded; S.hookGrounded = this.stowed || hoist.hookGrounded;
    S.twoBlock = !this.stowed && d.twoBlock; S.drumRope = d.drumRope; S.lowerLimit = d.lowerLimit;
    for (let i = 0; i < 4; i++) {
      S.beamsActual[i] = outr.beams[i].detent;
      S.floats[i].light = stab.floatLight[i];
      S.floats[i].lifted = stab.floatSet[i] && stab.floatLifted[i];
    }
    S.floatsSet = outr.floatsSet;
    S.floatsInContact = outr.floatContact.reduce((n, c) => n + (c ? 1 : 0), 0);
    S.tyresActive = mode === 'ROAD' || stab.tyresActive;
    S.tiltDeg = mode === 'ROAD' ? Math.hypot(v.pose.pitch, v.pose.roll) / DEG : stab.tiltDeg;
    S.wind = this.anemo; S.loadMassKg = load ? load.mass : 0; S.loadFaceArea = load ? load.area.face : 0;
    S.levers = lev; S.power = this.power; S.eStop = this.eStop;
    S.mode = mode === 'TIPPING' ? 'CRANE' : mode; // the operator can still lower during a tip
    S.turntablePinned = d.pinned; S.zoneLimiter = ctx.settings?.zoneLimiter !== false;
    S.axis.x = this.axisW.x; S.axis.z = this.axisW.z; S.yaw = v.yaw; S.psi = d.psi; S.psiDot = d.psiDot; S.inertia = rp.inertia;
    S.sidePullDeg = RL.outOfPlaneDeg; S.relief = d.relief; S.t = this.t;
    this.rcl.update(dt, S);
    const perm = this.perm;
    for (const k of PERM_KEYS) perm[k] = this.rcl.perm[k];
    // machine-level stops the RCL does not know about
    if (this.stowed) { perm.slewL = perm.slewR = perm.hoistUp = perm.lower = 0; } // block tied to the bumper
    if (this.reeving) for (const k of PERM_KEYS) perm[k] = 0; // riggers at the hook
    if (this._contact) this._contactPerms(perm);

    // ---- 5 drives
    const a = stab.pose.a, b = stab.pose.b;
    const dc = this._dctx;
    dc.powered = crane && this.power && !this.eStop;
    dc.eStop = this.eStop; dc.micro = !!inp.micro;
    dc.inertia = rp.inertia;
    dc.extTorque = RL.tauRope + tiltTorque(rp.mu, a, b, d.psi); // no viscous term: drives adds it
    dc.tension = this.stowed ? 0 : hoist.tensionFiltered; dc.falls = blk.falls;
    // luff speed load factor: beyond the chart (cap 0 → ratio ∞) treat as fully utilised, not 200 %
    dc.util = Number.isFinite(this.rcl.ratio) ? Math.min(this.rcl.ratio, 2) : 1;
    dc.blockHeight = blk.height; dc.fPerp = RL.fPerp; dc.fSide = RL.fSide;
    dc.hookGrounded = hoist.hookGrounded; dc.ropeDist = hoist.hook.distanceTo(hoist.sheave);
    d.update(dt, lev, perm, dc);
    // the boom rests on its rest at 0° over the front (below it would foul the driver cab)
    if (d.theta < 0 && d.L < 11.6 && Math.abs(wrapPi(d.psi)) < 10 * DEG) {
      d.theta = 0;
      if (d.vCyl < 0) d.vCyl = 0;
      if (d.thetaDot < 0) d.thetaDot = 0;
    }
    this._driveEvents();
    // RCL cut-out KPI: overload STOPs with something on the hook. A working-range STOP with an
    // empty hook (e.g. boom still on its rest at 9.5 m when the RCL is first confirmed) is not an
    // overload trip.
    if (this.rcl.events.includes('lmiTrip') && this.hoist.load) this.counters.lmiTrips++;
    this.counters.twoBlockCount = this.rcl.counters.twoBlockCount;
    // applied levers (jobs: first-motion / horn check). The carrier throttle rides on the
    // mobile's unused 'trolley' key so driving off also counts as the first motion.
    const L2 = this.levers, ap = d.applied;
    L2.slew = dc.powered ? ap.slew : 0; L2.luff = dc.powered ? ap.luff : 0; L2.tele = dc.powered ? ap.tele : 0; L2.hoist = dc.powered ? ap.hoist : 0;
    L2.trolley = mode === 'ROAD' ? this._drive.throttle : 0;

    // ---- 6 head → hoist
    this._geometry();
    if (this.stowed) {
      // the block hangs on the bumper anchor; the winch follows the geometry
      this._anchor(this.anchorW);
      d.setFallLength(Math.max(this.headW.distanceTo(this.anchorW), d.ropeLenMin + 0.05));
      hoist.sheavePrev.copy(hoist.sheave);
      hoist.sheave.copy(this.headW);
      hoist.hook.copy(this.anchorW); hoist.hookPrev.copy(this.anchorW); hoist.hookVel.set(0, 0, 0);
      hoist.ropeLen = d.fallLength();
      hoist.tension = hoist.tensionFiltered = 0;
      hoist.hookGrounded = true;
      hoist.impacts.length = 0;
    } else {
      hoist.falls = blk.falls;
      hoist.slewRate = d.psiDot;
      hoist.tagTorque = hoist.load && inp.tag ? -inp.tag * hoist.load.inertiaYaw * 0.08 : 0;
      hoist.step(dt, PHYS.substeps, this.headW, d.fallLength());
      // safety net: a load that starts inside a collider (bad placement) is pushed out within one
      // substep, which the position-based solver turns into a launch speed; no crane load or hook
      // really moves faster than this, so clamp it instead of letting the rope system explode
      clampSpeed(hoist.hookVel, 12);
      if (hoist.load) clampSpeed(hoist.loadVel, 8);
      this._impacts(dt);
      // the winch holding brake slips above ~1.6 × rated line pull [E]: a snagged hook
      // or a head yanked away pays rope off the drum instead of loading the boom without limit
      const slipN = WINCH_SLIP * blk.falls;
      // judged on a 0.1 s mean: XPBD snatch spikes (a slack rope going taut) are not a snag
      this._slipF = (this._slipF || 0) + (hoist.tension - (this._slipF || 0)) * (1 - Math.exp(-dt / 0.1));
      if (this._slipF > slipN) {
        const dist = hoist.hook.distanceTo(hoist.sheave);
        if (dist > d.fallLength()) { d.setFallLength(dist); hoist.ropeLen = d.fallLength(); }
        if (!this._slipT) this.ctx.hud?.toast?.('Winch brake slipping — rope overloaded (snagged hook?)', 'bad');
        this._slipT = 1;
      } else if (this._slipT) this._slipT = Math.max(0, this._slipT - dt);
    }

    // ---- 7 stability
    if (mode !== 'ROAD') {
      this._fillBodies();
      const sup = overturned ? this._sup : outr.supports(stab.pose, this.settle.s, stab.floatR, this.gf, dt);
      this._sup = sup;
      stab.carrierPoint(this.hc.x, this.hc.y, this.hc.z, _pa, false); // head, un-tipped
      const F = this._F;
      if (this.stowed || overturned) { F.x = F.y = F.z = 0; } else {
        _v.subVectors(hoist.hook, hoist.sheave);
        const len = _v.length() || 1, T = Math.min(hoist.tension, WINCH_SLIP * blk.falls);
        F.x = (_v.x / len) * T; F.y = (_v.y / len) * T; F.z = (_v.z / len) * T;
      }
      stab.update(dt, stab.bodiesWorld(this.bodiesC), F, _pa, sup);
      if (!overturned) {
        this._outriggerEvents(outr.events);
        this._settleEvents(this.settle.update(dt, stab.floatR, outr.areas, outr.floatWorld));
      }
      this._stabEvents(stab.events);
      // modes follow the stability state (§4.4 / §4.5)
      if (stab.state === 'OVERTURNED') {
        if (this.mode !== 'OVERTURNED') { this.mode = 'OVERTURNED'; this.power = false; }
      } else if (stab.state === 'TIPPING') {
        if (this.mode !== 'TIPPING') { this._preTip = this.mode; this.mode = 'TIPPING'; }
      } else if (this.mode === 'TIPPING') this.mode = this._preTip || 'CRANE';
    }

    // ---- 8 colliders
    this._updateColliders();

    // ---- 9 KPIs, boom contact, instruments
    this._boomContact(dt);
    this._rclEvents(dt);
    this._episodes(dt);
    // riggers steady a block just unhooked from the bumper (no free pendulum off the anchor)
    if (this._guideT > 0) {
      this._guideT -= dt;
      const k = Math.exp(-4 * dt), hv = hoist.hookVel;
      hv.x *= k; hv.z *= k;
    }
    const w = ctx.wind;
    if (w) {
      this.anemo += (w.speedAt(this.headW.y) - this.anemo) * (1 - Math.exp(-dt / DRIVES.anemometerTau));
      this.gustPeak = Math.max(this.gustPeak * Math.exp(-dt / 20), this.anemo);
    }
    // crane engine speed follows the lever deflection (§8.9 [S14]), 0.8 s ramp
    const dem = Math.max(Math.abs(L2.slew), Math.abs(L2.luff), Math.abs(L2.tele), Math.abs(L2.hoist));
    const target = this.power && !this.eStop ? 750 + 1150 * dem * (0.5 + 0.5 * Math.min(1, this.rcl.ratio || 0)) : 0;
    this.craneRpm += (target - this.craneRpm) * Math.min(1, dt / 0.8);
  }

  _contactPerms(perm) {
    const c = this._contact;
    if (c.t < CONTACT_LOCK) { perm.slewL = perm.slewR = perm.luffUp = perm.luffDown = perm.teleOut = perm.teleIn = 0; return; }
    // afterwards only the motions that move the boom away from the contact
    if (c.cmd.slew > 0) perm.slewR = 0; else if (c.cmd.slew < 0) perm.slewL = 0;
    if (c.cmd.luff > 0) perm.luffUp = 0; else if (c.cmd.luff < 0) perm.luffDown = 0;
    if (c.cmd.tele > 0) perm.teleOut = 0; else if (c.cmd.tele < 0) perm.teleIn = 0;
  }

  // §3.7 boom contact: sample the (deflected) boom axis against the world boxes
  _boomContact(dt) {
    const mode = this.mode;
    if (this._contact) this._contact.t += dt;
    if ((mode !== 'CRANE' && mode !== 'TIPPING') || this.stowed) { this._contact = null; return; }
    if (++this._contactN % CONTACT_EVERY) return;
    const d = this.drives, stab = this.stab;
    const pts = boomSamples(d.L, d.theta, d.dv, d.dl, 0, this._samples);
    const W = this._samplesW;
    const cp = Math.cos(d.psi), sp = Math.sin(d.psi);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = W[i] || (W[i] = { x: 0, y: 0, z: 0, r: 0 });
      stab.carrierPoint(p.u * cp - p.y * sp, p.u * sp + p.y * cp, p.z, q, true);
      q.r = p.r;
      if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z;
    }
    W.length = pts.length;
    // broad phase: boxes near the boom's bounding box
    const cand = this._candidates;
    cand.length = 0;
    const load = this.hoist.load;
    for (const bx of this.ctx.world.boxes) {
      if (!bx.enabled || bx.tag === 'hook' || this._ignore.has(bx) || (load && bx === load.box)) continue;
      const r = bx.r + 0.6;
      if (bx.cx + r < x0 || bx.cx - r > x1 || bx.cz + r < z0 || bx.cz - r > z1 || bx.cy + bx.hy + 0.6 < y0 || bx.cy - bx.hy - 0.6 > y1) continue;
      cand.push(bx);
    }
    const hit = cand.length ? boomContact({ boxes: cand }, W, null) : null;
    if (hit) {
      if (!this._contact) {
        const ap = d.applied;
        this._contact = { t: 0, clear: 0, tag: hit.tag, cmd: { slew: sgn(ap.slew), luff: sgn(ap.luff), tele: sgn(ap.tele) } };
        this.kpi.boomContacts++;
        this._audio.push({ type: 'boomContact', speed: Math.max(0.5, Math.abs(d.psiDot) * d.L + Math.abs(d.thetaDot) * d.L) });
        if (!this.ctx.jobs?.job) this.ctx.hud?.toast?.(`BOOM CONTACT (${hit.tag || 'obstacle'}) — motions stopped`, 'bad');
      }
      this._contact.clear = 0;
    } else if (this._contact) {
      this._contact.clear += dt * CONTACT_EVERY;
      if (this._contact.clear > 0.2 && this._contact.t > CONTACT_LOCK) this._contact = null;
    }
  }

  _impacts() {
    const hoist = this.hoist;
    this._impactCd = (this._impactCd || 0) - 1 / 120;
    if (!hoist.impacts.length || this._impactCd > 0) return;
    let best = hoist.impacts[0];
    for (const i of hoist.impacts) if (i.speed > best.speed) best = i;
    if (best.speed > 0.12) {
      this.ctx.audio?.impact?.(best.speed, best.kind === 'hook' ? 'metal' : 'thud', best.mass);
      this.ctx.onImpact?.(this, best);
      this._impactCd = 0.25;
    }
  }

  // own collider boxes from the (un-tipped) carrier pose; disabled once the machine goes over
  _updateColliders() {
    const [chassis, deck, cab, upper] = this.colliders;
    const stab = this.stab, v = this.vehicle, d = this.drives;
    const on = this.mode !== 'OVERTURNED' && !stab.edge;
    for (const b of this.colliders) b.enabled = on;
    const yaw = v.yaw;
    const put = (box, xc, yc, zc, hx, hy, hz, by) => {
      stab.carrierPoint(xc, yc, zc, _pa, false);
      box.set(_pa.x, _pa.y, _pa.z, hx, hy, hz, by);
    };
    // x_c −3.70 … 7.45 (to the bumper face below the cab; the stowed hook bowl at x_c 7.95 hangs
    // clear of it, so releasing the block does not start inside a collider), z 0.30 … 1.70
    put(chassis, 1.875, 0, 1.0, 5.575, 0.70, 1.375, yaw);
    const top = CW_DECK.topZ + this.ballast.deckH; // slabs land on the deck (or on the stack)
    put(deck, -3.0, 0, (1.0 + top) / 2, 0.70, (top - 1.0) / 2, 1.30, yaw);
    put(cab, 6.785, 0.7625, 2.40, 0.835, 0.70, 0.6125, yaw); // driver cab, front left
    // superstructure over the slew ring: tail swing 3.84 m
    const cu = -1.1, cs = Math.cos(d.psi), sn = Math.sin(d.psi);
    put(upper, cu * cs, cu * sn, 2.95, 2.75, 0.65, 1.30, yaw + d.psi);
  }

  // ------------------------------------------------------------- events
  _vehicleEvents(ev) {
    const hud = this.ctx.hud, job = !!this.ctx.jobs?.job;
    for (const e of ev) {
      switch (e.type) {
        case 'kerb': this._audio.push({ type: 'kerb', hard: e.tag === 'hard' }); break;
        case 'collision': case 'trafficCollision': this._audio.push({ type: 'collision', speed: e.speed }); break;
        case 'scrape': this._audio.push({ type: 'collision', speed: 0.3 }); break;
        case 'gear': case 'direction': case 'program': this._audio.push({ type: 'gear' }); break;
        case 'parkingBrake': this._audio.push({ type: 'airBrake' }); break;
        default: break;
      }
      // the job runner toasts its own KPI hits; everything else goes to the HUD here
      const kpiEv = e.type === 'kerb' || e.type === 'collision' || e.type === 'scrape';
      if (e.text && hud?.toast && !(job && kpiEv)) hud.toast(e.text, e.kind || 'info');
    }
  }

  _driveEvents() {
    const d = this.drives;
    for (const e of d.brakeEvents) if (e === 'slew') this._audio.push({ type: 'brake' });
    for (const e of d.events) {
      if (e === 'pin' || e === 'unpin') this._audio.push({ type: e });
      else if (e === 'pinned') this._audio.push({ type: 'detent' });
      else if (e === 'luffStop') this._audio.push({ type: 'jackEnd' });
    }
  }

  _outriggerEvents(ev) {
    const hud = this.ctx.hud;
    for (const e of ev) {
      switch (e.type) {
        case 'detent': case 'beamEnd': case 'jackEnd': this._audio.push(e); break;
        case 'touchdown': this._audio.push({ type: 'touchdown', speed: Math.abs(e.speed || 0) * 5 }); break;
        case 'matPlaced': case 'matRemoved': this._audio.push({ type: 'mat' }); break;
        case 'obstructed': hud?.toast?.(`${FLOATS[e.i].id} beam OBSTRUCTED`, 'bad'); break;
        case 'beamLocked': hud?.toast?.(`${FLOATS[e.i].id}: RETRACT JACK FIRST (float loaded)`, 'warn'); break;
        case 'levelDone': hud?.toast?.('Auto-level: level', 'good'); break;
        case 'levelRange': hud?.toast?.('LEVEL RANGE EXCEEDED — use cribbing', 'bad'); break;
        case 'blocked': if (e.reason) hud?.toast?.(e.reason, 'warn'); break;
        default: break;
      }
    }
  }

  _ballastEvents(ev) {
    const hud = this.ctx.hud;
    for (const e of ev) {
      switch (e.type) {
        case 'raised':
          this._audio.push({ type: 'ballast' });
          hud?.toast?.(`Counterweight ${(e.kg / 1000).toFixed(1)} t on the superstructure — unpin and reconfigure the RCL (L)`, 'good');
          break;
        case 'lowered':
          this._audio.push({ type: 'ballast' });
          hud?.toast?.('Counterweight lowered onto the deck', 'info');
          break;
        case 'quick': this.kpi.timePenalty += e.penalty || 0; break;
        case 'paused': if (e.reason) hud?.toast?.(`Ballast paused: ${e.reason}`, 'warn'); break;
        default: break;
      }
    }
  }

  _settleEvents(ev) {
    const hud = this.ctx.hud;
    for (const e of ev) {
      if (e.type === 'settle') hud?.toast?.(`Float settlement ${e.mm} mm — check the ground and the mats`, e.mm >= 50 ? 'bad' : 'warn');
      else if (e.type === 'punch') hud?.toast?.(`PUNCH-THROUGH under ${FLOATS[e.i].id}!`, 'bad');
      else if (e.type === 'punchCritical') this.kpi.punchThrough++;
    }
  }

  _stabEvents(ev) {
    const cams = this.ctx.cameras;
    for (const e of ev) {
      switch (e.type) {
        // one KPI per episode (the first float to go light / lift), not per float
        case 'floatLight': if (!this._lightEp) this.kpi.floatLight++; this._lightEp = true; break;
        case 'liftoff': if (!this._liftEp) this.kpi.liftoffs++; this._liftEp = true; this._audio.push({ type: 'creak' }); break;
        case 'rock': this._audio.push({ type: 'touchdown', speed: Math.max(0.3, e.speed || 0) }); break;
        case 'slam':
          this.kpi.slams++;
          this._audio.push({ type: 'slam', speed: e.speed });
          cams?.shake?.(0.02);
          break;
        case 'teeter': this._audio.push({ type: 'creak' }); break;
        case 'tipStart': this._audio.push({ type: 'creak' }); break;
        case 'overturned':
          this.kpi.overturned = true;
          this._audio.push({ type: 'overturn' });
          break;
        case 'crash': this._audio.push({ type: 'crash' }); cams?.shake?.(0.035); break;
        default: break;
      }
    }
  }

  // KPI episodes with hysteresis: a float hovering around the 20 kN threshold under a swinging
  // load is ONE 'outrigger light' event; the episode ends once every set float carries ≥ 30 kN
  // (or the load is down) for 8 s.
  _episodes(dt) {
    const st = this.stab;
    let clear = !this.mode.startsWith('TIP');
    for (let i = 0; i < 4; i++) if (st.floatSet[i] && st.floatR[i] < 1.5 * 20e3) clear = false;
    if (!(this.hoist.load && !this.hoist.loadGrounded) && !st.floatLight.some(Boolean)) clear = true;
    this._epT = clear ? (this._epT || 0) + dt : 0;
    // 8 s: longer than a swing half-period, so a pendulating load stays one episode
    if (this._epT > 8) this._lightEp = false;
    if (st.state !== 'LIFTOFF' && st.state !== 'TIPPING' && this._epT > 8) this._liftEp = false;
  }

  _rclEvents(dt) {
    const w = this.rcl.warnings, prev = this._prevWarn;
    if (this.rcl.state !== 'off' && this.rcl.state !== 'noconfig' && (w.has('SUPPORT_CONFIG') || w.has('TILT') || w.has('TYRES_NOT_CLEAR'))) this.kpi.mismatchTime += dt;
    if (w.has('SIDE_PULL') && !prev.has('SIDE_PULL')) this.kpi.sidePulls++;
    prev.clear();
    for (const k of w) prev.add(k);
  }

  // ------------------------------------------------------------- visuals
  updateVisuals(dt, t, night = 0) {
    const P = this.parts, d = this.drives, stab = this.stab, v = this.vehicle, outr = this.outr, hoist = this.hoist;
    P.setTip(stab.rootTransform(_m4));
    P.setSlew(d.psi);
    P.pFromExt(d.boom.ext, this._p6);
    P.setBoom(d.theta, this._p6, d.dv, d.dl);
    for (let i = 0; i < 4; i++) {
      P.setBeam(i, outr.beams[i].y);
      P.setJack(i, outr.jacks[i].e);
      const kind = outr.mats[i], f = outr.floatWorld[i];
      P.setMat(i, kind, f.x, f.y - (MATS[kind]?.thickness || 0), f.z, v.yaw);
    }
    P.setWheels(v.wheelSteer, v.wheelSpin, v.kappa);
    P.setSteeringWheel(v.steerPos * 2.5 * Math.PI);
    // the operator tilts the cab back to watch a steep boom [E]; level for travel
    const tiltTarget = this.mode === 'CRANE' || this.mode === 'TIPPING' ? clamp(0.3 * d.theta, 0, AT100.craneCab.tiltMaxDeg * DEG) : 0;
    this.cabTilt += clamp(tiltTarget - this.cabTilt, -4 * DEG * dt, 4 * DEG * dt);
    P.setCabTilt(this.cabTilt);
    P.setSticks(this.levers);
    // counterweight: superstructure slabs, deck stack, ballasting cylinders
    const b = this.ballast, r = b.raising;
    if (r && r.dir < 0) P.setCounterweight([], b.superSlabs, 1 - b.progress);
    else P.setCounterweight(b.superSlabs, b.deckStack.map((s) => s.id), r ? b.progress : 0);
    P.setWinch(d.sPaid);
    P.updateAnemometer(dt, this.anemo);
    P.setLights({ t, night, beacons: v.engineOn || this.power, work: night > 0.3 });

    // hook block: hangs along the rope, cheeks square to the boom (reeving holds the yaw)
    const hb = this.hookBlock;
    _y.subVectors(hoist.sheave, hoist.hook);
    if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0);
    _y.normalize();
    const az = v.yaw + d.psi;
    _x.set(Math.cos(az), 0, -Math.sin(az));
    _x.addScaledVector(_y, -_x.dot(_y));
    if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
    _x.normalize();
    _z.crossVectors(_x, _y).normalize();
    _m4.makeBasis(_x, _y, _z);
    hb.quaternion.setFromRotationMatrix(_m4);
    hb.position.copy(hoist.hook);
    P.root.updateMatrixWorld();
    hb.updateMatrixWorld();
    // ropes: falls head sheaves → block, lead drum → base rollers → head, slings
    if (hoist.load) hoist.updateLoadAttitude(dt);
    const tops = P.fallTops(hb, this._tops), bots = blockFallPoints(hb, this._bots), lead = P.ropeLead(this._lead);
    const rr = this.ropes;
    rr.begin();
    rr.falls(tops, bots, 0.0105);
    rr.rope(lead[0], lead[1], 0.0105);
    rr.rope(lead[1], lead[2], 0.0105);
    rr.rope(lead[2], lead[3], 0.0105);
    rr.slings(hoist);
    rr.end();

    // route chevrons: while driving the approach (free play road start / M1)
    const show = !this.parked && this.mode === 'ROAD' && Math.hypot(v.pos.x - 57, v.pos.z + 12) > 1.5 && (v.pos.z < -30 || v.pos.x < 50);
    this.route.setVisible(show);
    if (show) {
      const g = guidance(v.pos, v.yaw, { xRef: v.xRef });
      this.route.setProgress(g.s);
    }
  }

  // ------------------------------------------------------------- HUD
  _ballastHud() {
    const b = this.ballast;
    return {
      superKg: b.superKg, deckStack: b.deckStack.map((s) => s.id), raising: b.raising ? { dir: b.raising.dir, progress: b.progress } : null,
      pinned: this.drives.pinned, quick: b.quick, progress: b.progress, rclCwKg: this.rcl.config.cwKg,
    };
  }

  _chartHud(info) {
    const cfg = this.rcl.config;
    if (!info || !cfg) return this._chart;
    const kLo = info.kLo ?? 0, kHi = info.kHi ?? kLo;
    const key = `${chartKey(cfg)}:${kLo}:${kHi}`;
    if (this._chart.key !== key) {
      const lo = chartColumn(cfg, kLo), hi = kHi === kLo ? null : chartColumn(cfg, kHi);
      const cells = [];
      for (const c of lo) {
        if (!hi) { cells.push({ R: c.R, kg: c.kg, stab: !!c.s }); continue; }
        const h = hi.find((x) => Math.abs(x.R - c.R) < 1e-6);
        if (h) cells.push(h.kg < c.kg ? { R: c.R, kg: h.kg, stab: !!h.s } : { R: c.R, kg: c.kg, stab: !!c.s });
      }
      this._chart = { key, L: this.drives.L, cells };
    }
    this._chart.L = this.drives.L;
    return this._chart;
  }

  hudState() {
    if (this._hsT === this.t && this._hs) return this._hs;
    const { hoist, rcl, drives: d, vehicle: v, outr, stab, ballast } = this;
    const blk = this.blockDef;
    const gross = this.stowed ? 0 : hoist.tensionFiltered / G;
    const payload = Math.max(0, gross - blk.massKg);
    const ratio = Number.isFinite(rcl.ratio) ? rcl.ratio : 9.99;
    const lmiState = rcl.state === 'stop' ? 'cut' : rcl.state === 'warn' ? 'warn' : 'ok';
    const l = hoist.load;
    const lev = this.levers;
    const mode = this.mode;
    const gnd = this.gf(v.pos.x, v.pos.z);
    const lift = stab.pose.z0 - RIDE - gnd;
    const road = mode === 'ROAD';
    const pitchDeg = road ? v.pose.pitch / DEG : stab.tilt.pitch / DEG;
    const rollDeg = road ? v.pose.roll / DEG : stab.tilt.roll / DEG;
    const tiltDeg = road ? Math.hypot(pitchDeg, rollDeg) : stab.tiltDeg;
    const info = rcl.info;
    const vperm = windPermLoad(d.L, l ? l.mass : 0, l ? l.area.face : 0);
    const recRpm = slewRecRpm(d.L);
    const hookH = Math.max(0, hoist.hook.y - gnd);
    const beamsPct = outr.beams.map((bm) => (bm.detent === null ? null : Math.round(bm.detent * 100)));
    const stops = new Set(), warns = new Set();
    for (const k of rcl.stops) if (k !== 'POWER') stops.add(STOP_ID[k] || k);
    for (const k of rcl.warnings) warns.add(WARN_ID[k] || k);
    if (this._contact) stops.add('boomContact');
    const vs = v.state();
    const onSite = insideFence(v.pos);
    let interlock = null, guide = null;
    if (road) {
      const ti = this._travelCheck();
      interlock = ti.ok ? null : ti.reason;
      if (!this.parked && (!onSite || v.pos.z < -30 || v.pos.x < 50)) {
        const g = guidance(v.pos, v.yaw, { xRef: v.xRef });
        guide = { distance: g.distance, text: g.text, bearingDeg: g.bearingDeg, programHint: g.programHint, atTarget: g.atTarget };
      }
    }
    const superIds = ballast.superSlabs;
    const deckIds = ballast.deckStack.map((s) => s.id);
    const mobile = {
      mode, engineOn: v.engineOn, stowed: this.stowed, pos: { x: v.pos.x, z: v.pos.z }, yaw: v.yaw,
      speedKmh: Math.abs(vs.kmh), v: v.v, parkingBrake: v.parkingBrake, frameLift: lift,
      road: {
        speedKmh: vs.kmh, limitKmh: vs.limitKmh, onSite, gear: vs.gear, rpm: vs.rpm, program: vs.program, parkingBrake: vs.parkingBrake,
        crawl: vs.crawl, steer: vs.steer, interlock, guidance: guide, zone: vs.zone, speeding: vs.speeding,
      },
      setup: {
        beams: outr.beams.map((bm, i) => ({ ext: bm.ext, detent: beamsPct[i], obstructed: bm.obstructed, locked: bm.locked })),
        jacks: outr.jacks.map((j) => ({ e: j.e, max: j.max })),
        floats: FLOATS.map((f, i) => {
          const fw = outr.floatWorld[i], gA = groundAt(fw.x, fw.z);
          return {
            contact: !road && outr.floatContact[i], forceKg: stab.floatR[i] / G, pressureKPa: pressureKPa(stab.floatR[i], outr.areas[i]),
            allowKPa: gA.allowKPa, mat: outr.mats[i], matPending: outr.matPending[i], light: stab.floatLight[i],
            lifted: stab.floatSet[i] && stab.floatLifted[i], settleMm: this.settle.s[i] * 1000,
          };
        }),
        selected: outr.selected, level: { pitchDeg, rollDeg }, tiltDeg, tyresClear: !road && outr.tyresClear, floatsSet: !road && outr.floatsSet,
        autoLevel: outr.levelState === 'running' ? 'active' : outr.levelState === 'done' ? 'done' : outr.levelState === 'range' ? 'range' : 'off',
        pinned: d.pinned, message: outr.message, remoteStop: this.remoteStop,
      },
      ballast: this._ballastHud(),
      rcl: {
        config: { ...rcl.config }, code: rcl.shortCode, state: rcl.state === 'off' ? 'noconfig' : rcl.state, ratio, capKg: rcl.capKg,
        grossKg: rcl.grossKg, netKg: rcl.netKg, stops, warnings: warns, muted: rcl.hornMuted, bypass: rcl.bypass,
      },
      boom: {
        L: d.L, k: d.boom.k, sections: [...d.boom.ext], phase: d.boom.phase, activeSection: d.boom.activeSection, R: this.R,
        thetaGDeg: this.thetaG / DEG, thetaDeg: d.theta / DEG, headHeight: this.headW.y - gnd, hookHeight: hookH, lift,
      },
      slewDeg: displaySlewDeg(d.psi), slewRpm: d.slewRpm, slewRecRpm: recRpm,
      wind: { head: this.anemo, gust3s: this.anemo, perm: info?.windPerm ?? vperm, loadMax: l ? vperm : NaN },
      hoist: {
        speedMpm: this.hoistSpeed * 60, linePullKN: d.fLine / 1000, falls: blk.falls, block: this.block, overload: d.relief,
      },
      chart: this._chartHud(info),
      zone: { inTowerZone: rcl.zone.tower, ceiling: TOWER_ZONE.ceiling, headTop: this.headW.y + TOWER_ZONE.headTopAboveSheave },
      supportsKg: stab.floatR.map((x) => x / G),
      reeving: this.reeving ? { to: this.reeving.to, t: this.reeving.t, total: this.reeving.total, progress: this.reeving.progress } : null,
      tip: { state: stab.state, margin: stab.margin },
      // fields the job runner reads (src/mobile/jobs.js readMobile)
      beams: outr.beams.map((bm) => bm.ext), beamDetents: beamsPct, floatsSet: !road && outr.floatsSet, tyresClear: !road && outr.tyresClear,
      mats: [...outr.mats], tilt: { pitch: pitchDeg, roll: rollDeg }, levelDeg: tiltDeg,
      cwKg: ballast.superKg, deckSlabs: deckIds, superSlabs: [...superIds], block: this.block,
      boomLen: d.L, pinned: d.boom.phase === 'pinned', telePhase: d.boom.phase, turntablePinned: d.pinned,
      warnings: warns, stability: { state: stab.state, margin: stab.margin }, settlement: [...this.settle.s],
      grossKg: gross, luffDeg: d.theta / DEG,
    };
    this._hs = {
      machine: 'mobile',
      payload, capacity: rcl.capKg, ratio, lmiState, maxLoadCut: false,
      radius: this.R, hookHeight: hookH, slewDeg: displaySlewDeg(d.psi),
      wind: this.anemo, gustPeak: this.gustPeak, windState: this.anemo > vperm ? 'alarm' : this.anemo > 0.85 * vperm ? 'warn' : 'ok',
      falls: blk.falls, slewModeName: 'AT-100', power: this.power, eStop: this.eStop,
      zoneActive: rcl.zone.tower || rcl.zone.road, twoBlock: !this.stowed && d.twoBlock, brake: d.brakeSlew, micro: false,
      swayAssist: false, freeSlew: d.freeSlew, levers: { slew: lev.slew, tele: lev.tele, luff: lev.luff, hoist: lev.hoist, trolley: 0 },
      hoistSpeed: this.hoistSpeed * 60, hoistBandSpeed: (d.lineSpeedMax / blk.falls) * 60, trolleySpeed: 0, slewRpm: d.slewRpm,
      loadName: l ? l.def.name : null, loadWindLimit: l ? l.def.windLimit : null, slingAngle: null, grounded: hoist.loadGrounded,
      mobile,
    };
    this._hsT = this.t;
    return this._hs;
  }

  // crane-cab screen (the same RCL content at 4 Hz, §8.8)
  updateCabScreen(dt, s) {
    this._cabT = (this._cabT || 0) - dt;
    const tex = this.parts.craneCab?.screen?.material?.map;
    if (this._cabT > 0 || !tex || !tex.image || !tex.image.getContext) return;
    this._cabT = 0.25;
    drawCabScreen(tex.image.getContext('2d'), s);
    tex.needsUpdate = true;
  }

  // ------------------------------------------------------------- audio
  audioState(cameraMode, host = {}) {
    const d = this.drives, v = this.vehicle, outr = this.outr, rcl = this.rcl, mode = this.mode;
    const events = this._audioOut || (this._audioOut = []);
    events.length = 0;
    for (const e of this._audio) events.push(e);
    this._audio.length = 0;
    const craneOn = this.power && !this.eStop && this.craneRpm > 50;
    const carrierOn = v.engineOn && mode !== 'OVERTURNED';
    const which = craneOn && carrierOn ? 'both' : craneOn ? 'crane' : carrierOn ? 'carrier' : 'off';
    const ap = d.applied;
    const demand = Math.max(Math.abs(ap.slew), Math.abs(ap.luff), Math.abs(ap.tele), Math.abs(ap.hoist));
    const outDemand = Math.max(outr.beamSpeed / 0.2, outr.jackSpeed / 0.06);
    const w = rcl.warnings;
    const hookMax = d.lineSpeedMax / Math.max(1, d.falls);
    return {
      engine: {
        rpm: v.engineOn ? v.rpm : 0, craneRpm: this.craneRpm, which, retarder: mode === 'ROAD' ? v.retarder : 0,
        load: mode === 'ROAD' ? v.engineLoad : mode === 'SETUP' ? Math.min(1, outDemand) : demand,
      },
      hyd: { demand: craneOn ? demand : mode === 'SETUP' ? Math.min(1, outDemand) : 0, relief: d.reliefActive },
      slew: d.psiDot / DRIVES.slew.maxSpeed, luff: d.thetaDot / (2.3 * DEG), tele: d.boom.speed / DRIVES.tele.speed,
      hoist: hookMax > 0 ? this.hoistSpeed / hookMax : 0,
      outrigger: { beam: outr.beamSpeed / AT100.outriggers.beamSpeed, jack: outr.jackSpeed / AT100.outriggers.jackSpeed.extendFree, events: [] },
      rcl: { state: rcl.state, muted: rcl.hornMuted },
      warnings: { wind: w.has('WIND'), tilt: w.has('TILT'), support: w.has('SUPPORT_CONFIG'), floatLight: w.has('FLOAT_LIGHT'), muted: rcl.mismatchMuted },
      reverse: mode === 'ROAD' && v.reverseAlarm, horn: !!host.horn, events,
      active: !!host.active, menu: !!host.menu, cameraMode,
    };
  }
}

// frozen export of the helpers tests use
export const _internals = Object.freeze({ STOP_ID, WARN_ID, insideFence, BASES });
