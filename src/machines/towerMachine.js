import * as THREE from 'three';
import { CRANE, PHYS, SLEW_MODES, G } from '../config.js';
import { clamp } from '../util/math.js';
import { buildCrane, buildHookBlock } from '../crane/model.js';
import { CraneSim } from '../crane/crane.js';
import { Safety } from '../crane/safety.js';
import { Box } from '../physics/collide.js';
import { HoistSystem } from '../physics/rope.js';
import { RopeRenderer } from './ropeRender.js';
import { displaySlewDeg } from './machine.js';

// The TC-6010 hammerhead tower crane as a Machine (src/machines/machine.js).
// Pure extraction of what main.js used to do inline — drives, LMI, hoist rope,
// sway assist, tag line, visuals, HUD / cab-screen state and audio — with no
// behaviour change. New: park() / activate() for machine switching (§8.3).

const _sv = new THREE.Vector3();
const _a = new THREE.Vector3();
const _c = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _blockTop = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _pts = [];
for (let i = 0; i < 8; i++) _pts.push(new THREE.Vector3());

// audio mix depends on where the listener is
const MIXES = {
  cab: { slew: 1, trolley: 0.35, hoist: 0.55, wind: 1 },
  orbit: { slew: 0.35, trolley: 0.35, hoist: 0.4, wind: 0.7 },
  hook: { slew: 0.25, trolley: 0.9, hoist: 0.6, wind: 0.8 },
  ground: { slew: 0.2, trolley: 0.2, hoist: 0.25, wind: 0.4 },
};
const MENU_MIX = { slew: 0, trolley: 0, hoist: 0, wind: 0.4 };
const METAL_LOADS = ['beam', 'container', 'bucket'];

export class TowerMachine {
  /** @param {import('./machine.js').MachineCtx} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.id = 'tower';
    this.label = 'Tower TC-6010';
    const parts = (this.parts = buildCrane());
    this.root = parts.root;
    ctx.scene.add(parts.root);
    this.colliders = [
      new Box(0, CRANE.mastTop / 2, 0, CRANE.mastWidth / 2 + 0.1, CRANE.mastTop / 2, CRANE.mastWidth / 2 + 0.1, 0, 'mast'),
      new Box(0, 0.3, 0, 3.25, 0.3, 3.25, 0, 'foundation'),
    ];
    for (const f of parts.floods) { f.spot.decay = 2; f.spot.distance = 0; }

    this.crane = new CraneSim(ctx.wind);
    this.safety = new Safety();
    this.hoist = new HoistSystem(ctx.world, ctx.wind);
    this.ropes = new RopeRenderer(ctx.scene, parts.mats.rope, { maxRope: 72, maxSling: 32 });
    this.hookBlock = null;
    this.rebuildHookBlock();

    this.levers = { slew: 0, trolley: 0, hoist: 0 };
    this.impactCooldown = 0;
    this.tagWarned = false;
    setInterval(() => { this.tagWarned = false; }, 6000);
    this.cabScreenTimer = 0;
    this.parked = false;
    this._parking = null; // {t} while the park manoeuvre runs
    this._rig = null;
  }

  // ------------------------------------------------------------- contract
  get power() { return this.crane.power; }
  set power(v) { this.crane.power = v; }
  get eStop() { return this.safety.eStop; }
  get counters() { return this.safety; } // {twoBlockCount, lmiTrips} live on Safety
  get hoistSpeed() { return this.crane.hoistVel; }
  inputProfile() { return 'tower'; }
  cameraModes() { return ['cab', 'orbit', 'hook', 'ground']; }
  signallerGeometry() { return { cx: 0, cz: 0, radialOut: 'Trolley out', radialIn: 'Trolley in' }; }

  cameraRig() {
    if (!this._rig) {
      const hoist = this.hoist;
      const focus = (out) => out.copy(hoist.load ? hoist.load.pos : hoist.hook);
      this._rig = {
        cab: { parent: this.parts.cab, headPos: new THREE.Vector3(-0.22, 1.32, 0), baseYaw: -Math.PI / 2 },
        hook: { parent: this.parts.trolley, pos: new THREE.Vector3(0.35, -0.5, 0.6) },
        chaseTarget: (out) => focus(out),
        focus,
      };
    }
    return this._rig;
  }

  rebuildHookBlock() {
    if (this.hookBlock) this.ctx.scene.remove(this.hookBlock);
    this.hookBlock = buildHookBlock(this.parts.mats, this.crane.falls);
    this.ctx.scene.add(this.hookBlock);
  }

  // settings hooks (main.js applySetting)
  setFalls(n) {
    if (this.hoist.load) return false;
    this.crane.falls = this.hoist.falls = Number(n);
    this.rebuildHookBlock();
    return true;
  }
  setSlewMode(i) { this.crane.slewMode = Number(i); }
  setZoneLimiter(on) { this.safety.zoneEnabled = !!on; }

  /** @param {import('./machine.js').TowerStart} start */
  reset({ slew = 0.35, trolley = 18, ropeLen = 20, attach = null } = {}) {
    const { crane, hoist, safety } = this;
    if (hoist.load) hoist.detach();
    crane.slew = slew;
    crane.slewRate = crane.trolleyVel = crane.hoistVel = 0;
    crane.trolley = trolley;
    crane.ropeLen = ropeLen;
    crane.pitch = crane.pitchVel = crane.lat = crane.latVel = 0;
    crane.power = false;
    crane.freeSlew = false;
    safety.eStop = false;
    crane.sheavePosition(_sv);
    hoist.ropeLen = ropeLen;
    hoist.radius = trolley;
    hoist.reset(_sv);
    if (attach) {
      attach.pos.set(hoist.hook.x, hoist.hook.y - attach.hangLength, hoist.hook.z);
      attach.yaw = slew;
      hoist.attach(attach);
      attach.sync();
    }
    hoist.tension = hoist.tensionFiltered = (CRANE.hookMass + (attach ? attach.mass : 0)) * G;
    this._parking = null;
    this.parked = false;
  }

  // §8.3: out of service while the mobile works — trolley in to 3 m, hook to
  // the upper limit, power off, slew brake released so the jib weathervanes.
  canPark() { return this.hoist.load ? { ok: false, reason: 'Land the load first' } : { ok: true }; }
  park() {
    this.parked = true;
    if (this.safety.eStop) { this._finishPark(); return; }
    this.crane.power = true;
    this.crane.freeSlew = false;
    this._parking = { t: 0 };
  }
  _finishPark() {
    this._parking = null;
    this.crane.power = false;
    this.crane.freeSlew = true;
  }
  activate() {
    if (!this.parked) return;
    // back in service: slew brake on; the operator powers up (zero-position interlock)
    this.parked = false;
    this._parking = null;
    this.crane.power = false;
    this.crane.freeSlew = false;
  }
  _parkLevers(dt) {
    const c = this.crane, p = this._parking;
    p.t += dt;
    const trolleyIn = c.trolley > CRANE.trolleyMin + 0.05;
    const hoistUp = c.ropeLen > c.ropeLenMin + 0.05;
    const settled = !trolleyIn && !hoistUp && Math.abs(c.trolleyVel) < 1e-3 && Math.abs(c.hoistVel) < 1e-3;
    if (settled || p.t > 90 || c.power === false) { this._finishPark(); return null; }
    return { slew: 0, trolley: trolleyIn ? -1 : 0, hoist: hoistUp ? 1 : 0 };
  }

  // ------------------------------------------------------------ actions
  handleAction(a, api) {
    const { crane, safety } = this;
    switch (a) {
      case 'power':
        if (safety.eStop || !crane.power) {
          if (api.input.anyLeverOffNeutral) {
            api.toast('Zero-position interlock: return both levers to neutral', 'bad');
          } else {
            safety.eStop = false;
            crane.power = true;
            api.audio.clunk(0.3);
            api.toast('Crane power ON', 'good');
          }
        } else {
          crane.power = false;
          api.toast('Crane power OFF', 'info');
        }
        return true;
      case 'estop':
        safety.eStop = true;
        crane.power = false;
        api.toast('EMERGENCY STOP — press P to reset', 'bad');
        return true;
      case 'freeslew':
        crane.freeSlew = !crane.freeSlew;
        api.toast(crane.freeSlew ? 'Free slew: brake released, jib weathervanes (out of service)' : 'Free slew OFF', 'warn');
        return true;
      case 'slewmode':
        crane.slewMode = (crane.slewMode + 1) % SLEW_MODES.length;
        api.settings.slewMode = crane.slewMode;
        api.saveSettings();
        api.toast(`Slewing mode: ${SLEW_MODES[crane.slewMode].name}`, 'info');
        return true;
      case 'sway':
        api.applySetting('swayAssist', !api.settings.swayAssist, true);
        api.toast(`Sway Control assist ${api.settings.swayAssist ? 'ON' : 'OFF'}`, 'info');
        return true;
      default:
        return false;
    }
  }

  onRelease() { return false; }

  // ------------------------------------------------------------ physics
  // Sway Control: drive trolley/slew so the sheave follows the swinging load
  // (trolley velocity += k·offset ⇒ trolley accel ∝ swing rate ⇒ damping).
  applySwayAssist(lev) {
    const { crane, hoist } = this;
    if (!this.ctx.settings.swayAssist || !crane.power) return lev;
    if (hoist.hookGrounded || (hoist.load && hoist.loadGrounded)) return lev;
    const ref = hoist.load ? hoist.load.pos : hoist.hook;
    // swing measured against the rigid jib line (IMU rope angle), so the
    // controller doesn't chase the jib's own structural vibration
    const ux = Math.cos(crane.slew), uz = -Math.sin(crane.slew);
    const ex = ref.x - ux * crane.trolley, ez = ref.z - uz * crane.trolley;
    const L = Math.max(2, hoist.sheave.y - ref.y);
    const k = 1.4 * Math.sqrt(G / L);
    const er = ex * ux + ez * uz; // radial offset
    const et = ex * uz - ez * ux; // offset toward increasing θ
    const out = { ...lev };
    out.trolley = clamp(lev.trolley + (k * er) / CRANE.trolleyMaxSpeed, -1, 1);
    const thetaDot = (k * et) / Math.max(crane.trolley, 3);
    out.slew = clamp(lev.slew - thetaDot / CRANE.slewMaxSpeed, -1, 1);
    return out;
  }

  /** @param {number} dt @param {import('./machine.js').MachineInput} input */
  step(dt, input) {
    const { crane, safety, hoist, ctx } = this;
    let lev = input.levers;
    if (this._parking) lev = this._parkLevers(dt) || lev;
    lev = this.applySwayAssist(lev);
    this.levers = lev;
    crane.micromove = input.micro;
    safety.update(dt, crane, hoist, ctx.wind, lev);
    crane.update(dt, lev, safety.perm, hoist);
    crane.sheavePosition(_sv);
    hoist.falls = crane.falls;
    hoist.radius = crane.trolley;
    hoist.slewRate = crane.slewRate;
    // tag line: the rigger can only reach the load while it's low
    hoist.tagTorque = 0;
    if (hoist.load && input.tag) {
      const l = hoist.load;
      const low = l.pos.y - l.half.y - ctx.world.heightAt(l.pos.x, l.pos.z) < 4.5;
      if (low) hoist.tagTorque = -input.tag * l.inertiaYaw * 0.08;
      else if (!this.tagWarned) { ctx.hud.toast('Tag line: load too high for the rigger to reach', 'warn'); this.tagWarned = true; }
    }
    hoist.step(dt, PHYS.substeps, _sv, crane.ropeLen);

    // impacts → sound + job KPIs
    this.impactCooldown -= dt;
    if (hoist.impacts.length && this.impactCooldown <= 0) {
      let best = hoist.impacts[0];
      for (const i of hoist.impacts) if (i.speed > best.speed) best = i;
      if (best.speed > 0.12) {
        const metal = hoist.load && METAL_LOADS.includes(hoist.load.type);
        ctx.audio.impact(best.speed, metal || best.kind === 'hook' ? 'metal' : 'thud', best.mass);
        ctx.onImpact?.(this, best);
        this.impactCooldown = 0.25;
      }
    }
    for (const ev of crane.brakeEvents) if (ev === 'slew') ctx.audio.clunk(0.12);
    crane.brakeEvents.length = 0;
    safety.events.length = 0;
  }

  // ------------------------------------------------------------ visuals
  updateVisuals(dt, t, night) {
    const { crane, hoist, parts, hookBlock } = this;
    parts.slew.rotation.y = crane.slew;
    parts.jibPivot.rotation.order = 'YZX';
    parts.jibPivot.rotation.set(0, crane.lat, -crane.pitch);
    parts.trolley.position.x = crane.trolley - CRANE.jibRootX;
    parts.drum.rotateY(-crane.hoistVel * crane.falls * dt / 0.42);
    parts.cups.rotation.y += this.ctx.wind.anemometer * dt * 1.8;
    parts.root.updateMatrixWorld(true);

    // hook block pose
    const up = _tmpA.subVectors(hoist.sheave, hoist.hook).normalize();
    _blockTop.copy(hoist.hook).addScaledVector(up, CRANE.hookBlockHeight);
    crane.jibAxis(_axis);
    const x = _tmpB.copy(_axis).addScaledVector(up, -_axis.dot(up)).normalize();
    const z = _c.crossVectors(x, up).normalize();
    _m4.makeBasis(x, up, z);
    hookBlock.quaternion.setFromRotationMatrix(_m4);
    hookBlock.position.copy(_blockTop);

    // ropes: falls trolley sheaves → block, trolley rope along the jib, drum lead
    const rr = this.ropes;
    rr.begin();
    const falls = crane.falls;
    const topOff = falls === 4 ? [-0.5, -0.1, 0.1, 0.5] : [-0.1, 0.1];
    const botOff = falls === 4 ? [-0.26, -0.08, 0.08, 0.26] : [-0.2, 0.2];
    for (let f = 0; f < falls; f++) {
      const a = parts.trolley.localToWorld(_pts[0].set(topOff[f], -CRANE.sheaveDrop, 0));
      const b = _pts[1].copy(_blockTop).addScaledVector(x, botOff[f]).addScaledVector(up, -0.05);
      rr.rope(a, b, 0.011);
    }
    const L = CRANE.jibLength;
    const tr = parts.trolley.position.x;
    const jibPts = [
      [tr - 0.3, 0.05, 0, 0.4, 0.12, 0],
      [tr + 0.3, 0.05, 0, L - 0.4, 0.12, 0],
      [tr - 0.8, 0.02, 0.3, 0.3, 0.03, 0.3],
      [tr + 0.8, 0.02, -0.3, L - 0.3, 0.03, -0.3],
    ];
    for (const [ax, ay, az, bx, by, bz] of jibPts) {
      rr.rope(parts.jib.localToWorld(_pts[0].set(ax, ay, az)), parts.jib.localToWorld(_pts[1].set(bx, by, bz)), 0.008);
    }
    parts.drum.getWorldPosition(_pts[2]);
    rr.rope(_pts[2], parts.jib.localToWorld(_pts[3].set(0.4, 0.12, 0)), 0.009);
    // slings (with sag when slack)
    if (hoist.load) {
      hoist.updateLoadAttitude(dt);
      rr.slings(hoist);
    }
    rr.end();

    // cab joysticks follow the levers (ISO directions)
    const lv = this.levers;
    parts.cab.userData.leftStick.rotation.set(lv.slew * 0.35, 0, -lv.trolley * 0.35);
    parts.cab.userData.rightStick.rotation.set(0, 0, lv.hoist * 0.35);

    // lights
    const blink = (t % 1.0) < 0.5;
    for (const o of parts.obstacleLights) o.material.emissiveIntensity = blink ? 2 + night * 6 : 0.05;
    for (const f of parts.floods) {
      f.spot.intensity = night > 0.3 ? 3500 * night : 0; // calibrated against the night exposure (~1.35)
      f.lampMesh.material.emissiveIntensity = night > 0.3 ? 4 : 0;
    }
  }

  // the LMI touchscreen inside the cab mirrors the HUD (redrawn at 4 Hz)
  updateCabScreen(dt, s) {
    this.cabScreenTimer -= dt;
    const tex = this.parts.cab.userData.screen?.material?.map;
    if (this.cabScreenTimer > 0 || !tex || !tex.image || !tex.image.getContext) return;
    this.cabScreenTimer = 0.25;
    const c = tex.image, x = c.getContext('2d');
    const W = c.width, H = c.height, k = W / 320;
    const col = { ok: '#35c47a', warn: '#f0b40c', limit: '#ff7a1a', cut: '#ff3030' }[s.lmiState] || '#35c47a';
    x.setTransform(k, 0, 0, H / 200, 0, 0);
    x.fillStyle = '#06110d'; x.fillRect(0, 0, 320, 200);
    x.fillStyle = s.eStop ? '#5a0f0f' : '#123a2b'; x.fillRect(0, 0, 320, 26);
    x.fillStyle = '#9ff5c8'; x.font = 'bold 15px monospace';
    x.fillText(`LMI  TC-6010   ${s.falls} FALLS  ${s.power ? 'ON' : 'OFF'}`, 10, 18);
    x.font = 'bold 26px monospace'; x.fillStyle = '#e8fff2';
    x.fillText(`R ${s.radius.toFixed(1)} m`, 12, 62);
    x.fillText(`Q ${(s.payload / 1000).toFixed(2)} t`, 12, 96);
    x.font = 'bold 15px monospace'; x.fillStyle = '#7fd9a8';
    x.fillText(`Qmax ${(s.capacity / 1000).toFixed(2)} t`, 12, 122);
    x.fillText(`H ${s.hookHeight.toFixed(1)} m`, 180, 62);
    x.fillStyle = s.windState === 'ok' ? '#7fd9a8' : '#ff9a3a';
    x.fillText(`WIND ${s.wind.toFixed(1)} m/s`, 180, 96);
    x.strokeStyle = '#7fd9a8'; x.strokeRect(12, 140, 296, 22);
    x.fillStyle = col; x.fillRect(14, 142, Math.min(292, 292 * s.ratio / 1.1), 18);
    x.fillStyle = '#e8fff2'; x.font = 'bold 13px monospace';
    x.fillText(`${Math.round(s.ratio * 100)} %`, 140, 156);
    x.fillStyle = '#9ff5c8';
    x.fillText(`SLEW ${s.slewDeg.toFixed(0)}°  ${s.lmiState === 'cut' ? 'CUT-OUT' : s.twoBlock ? 'HOOK LIMIT' : ''}`, 12, 186);
    tex.needsUpdate = true;
  }

  // machine part of the HUD state; the host adds cameraName, attachable,
  // canRelease, job, jobTime and showHints
  hudState() {
    const { crane, hoist, safety, ctx } = this;
    const l = hoist.load;
    let slingAngle = null;
    if (l && l.def.points.length > 1) {
      slingAngle = 90;
      for (let p = 0; p < l.def.points.length; p++) {
        const pt = l.slingPoint(p, _pts[7]);
        const d = pt.distanceTo(hoist.hook);
        if (d > 0.01) slingAngle = Math.min(slingAngle, THREE.MathUtils.radToDeg(Math.asin(clamp((hoist.hook.y - pt.y) / d, -1, 1))));
      }
    }
    return {
      machine: 'tower',
      payload: safety.payload, capacity: safety.capacity, ratio: safety.ratio, lmiState: safety.lmiState,
      maxLoadCut: safety.maxLoadCut, radius: crane.trolley, hookHeight: Math.max(0, hoist.hook.y), slewDeg: displaySlewDeg(crane.slew),
      wind: ctx.wind.anemometer, gustPeak: ctx.wind.gustPeak, windState: safety.windState, falls: crane.falls,
      slewModeName: SLEW_MODES[crane.slewMode].name, power: crane.power, eStop: safety.eStop, zoneActive: safety.zoneActive,
      twoBlock: safety.twoBlock, brake: crane.brakeSlew, micro: crane.micromove, swayAssist: ctx.settings.swayAssist,
      freeSlew: crane.freeSlew, levers: this.levers, hoistSpeed: crane.hoistVel * 60, hoistBandSpeed: crane.hoistBandSpeed * 60,
      trolleySpeed: crane.trolleyVel * 60, slewRpm: (-crane.slewRate * 60) / (2 * Math.PI),
      loadName: l ? l.def.name : null, loadWindLimit: l ? l.def.windLimit : null, slingAngle,
      grounded: hoist.loadGrounded,
    };
  }

  /** @param {string} cameraMode @param {import('./machine.js').AudioHost} host */
  audioState(cameraMode, host) {
    const { crane, safety, ctx } = this;
    const camMix = MIXES[cameraMode] || MIXES.orbit;
    // a parked tower is silent apart from the wind (the mobile's audio owns the rest)
    const mix = host.menu ? MENU_MIX : host.active ? camMix : { slew: 0, trolley: 0, hoist: 0, wind: camMix.wind };
    const live = host.playing && host.active;
    return {
      mix,
      slew: crane.slewRate / CRANE.slewMaxSpeed,
      slewEffort: Math.min(1, Math.abs(crane.slewTorque) / CRANE.slewTorque) * (crane.brakeSlew ? 0 : 1),
      trolley: crane.trolleyVel / CRANE.trolleyMaxSpeed,
      hoist: crane.hoistVel / 1.33,
      hoistEffort: crane.hoistVel !== 0 ? Math.min(1, safety.payload / crane.reeving.maxLoad) : 0,
      wind: ctx.wind.speedAt(cameraMode === 'ground' ? 2 : host.active ? 47 : 6),
      horn: !!host.horn,
      lmi: live ? safety.lmiState : 'ok',
      windAlarm: live && (safety.windState === 'alarm' || safety.windState === 'stop'),
    };
  }
}
