import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clamp } from './util/math.js';

// Camera rig shared by every machine. The host calls attach(machine.cameraRig())
// when the active machine changes, setModes(machine.cameraModes()) whenever the
// cycle list changes (first entry = default for that machine state) and
// update(dt, machine) every frame. Cameras:
//   cab     operator eye on rig.cab.parent (tower cab / mobile superstructure),
//           drag look + auto-look at the load; optional cab tilt (rig.cab.tilt)
//   driver  mobile driver eye on rig.driver.parent, looks ahead
//   chase   behind and above the carrier (rig.carrier), smoothed (§8.7: 16 m back, 7 m up, 4 m ahead)
//   setup   ground eye 1.7 m high, 6 m diagonally out from the selected float (rig.setupTarget)
//   hook    looks straight down from rig.hook.parent (also the PIP monitor camera)
//   ground  signaller position near the load
//   orbit   free orbit following rig.focus
// plus a scripted overturn cinematic (machine.mode === 'OVERTURNED') and shake().

const TOWER_MODES = ['cab', 'orbit', 'hook', 'ground'];
export const CAMERA_NAMES = {
  cab: 'Operator cab', orbit: 'Orbit', hook: 'Hook camera', ground: 'Signaller (ground)',
  driver: 'Driver cab', chase: 'Chase', setup: 'Outrigger (ground)', cinematic: 'Overturn replay',
};
const DRAG_MODES = new Set(['cab', 'ground', 'driver', 'chase', 'setup']);
const CHASE = { back: 16, up: 7, ahead: 4 }; // §8.7 / CAMERAS.chase
const SETUP = { eye: 1.7, dist: 6 }; // §8.7 / CAMERAS.setup
const CAB_TILT_RATE = 5 * Math.PI / 180; // rad/s, hydraulic cab tilt
const CINE_TIME = 14; // s of scripted orbit before handing over to the free orbit

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _f = new THREE.Vector3(); // focus of the current frame
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _e = new THREE.Vector3();
const _l = new THREE.Vector3();
const _q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class CameraRig {
  constructor(renderer, parts) {
    this.renderer = renderer;
    this.dom = renderer.domElement;
    this.mode = 'cab';
    this.modes = null; // cycle list from the machine (null = tower default)
    this.rig = null;
    const aspect = window.innerWidth / window.innerHeight;

    // cab camera: pivot (base yaw + cab tilt) → head (look yaw / pitch) → camera
    this.cabCam = new THREE.PerspectiveCamera(70, aspect, 0.05, 7000);
    this.cabPivot = new THREE.Object3D();
    this.cabPivot.rotation.order = 'YXZ';
    this.head = new THREE.Object3D();
    this.head.rotation.order = 'YXZ';
    this.head.add(this.cabCam);
    this.cabPivot.add(this.head);
    this.cabBaseYaw = -Math.PI / 2;
    this.cabPivot.position.set(-0.22, 1.32, 0);
    this.cabPivot.rotation.set(0, this.cabBaseYaw, 0);
    if (parts?.cab) parts.cab.add(this.cabPivot);
    this.yaw = 0;
    this.pitch = -0.32;
    this.cabTilt = 0;
    this.autoLook = true;
    this.lastManual = -10;

    // driver camera (mobile carrier cab)
    this.driverCam = new THREE.PerspectiveCamera(72, aspect, 0.05, 7000);
    this.driverPivot = new THREE.Object3D();
    this.driverPivot.rotation.order = 'YXZ';
    this.driverHead = new THREE.Object3D();
    this.driverHead.rotation.order = 'YXZ';
    this.driverHead.add(this.driverCam);
    this.driverPivot.add(this.driverHead);
    this.driverYaw = 0;
    this.driverPitch = -0.1;
    this.driverManual = -10;

    // hook camera looking straight down from the trolley / boom head mount
    this.hookCam = new THREE.PerspectiveCamera(46, aspect, 0.2, 400);
    this.hookCam.position.set(0.35, -0.5, 0.6);
    this.hookCam.rotation.set(-Math.PI / 2, 0, 0);
    if (parts?.trolley) parts.trolley.add(this.hookCam);
    this.pipCam = this.hookCam.clone();
    this.pipCam.aspect = 4 / 3;
    if (parts?.trolley) parts.trolley.add(this.pipCam);

    // orbit camera
    this.orbitCam = new THREE.PerspectiveCamera(55, aspect, 0.2, 7000);
    this.orbitCam.position.set(-55, 30, 70);
    this.controls = new OrbitControls(this.orbitCam, this.dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 450;
    this.controls.target.set(10, 20, 0);
    this.controls.enabled = false;
    this.followTarget = new THREE.Vector3();
    this._orbitRecenter = false;

    // ground (signaller) camera
    this.groundCam = new THREE.PerspectiveCamera(60, aspect, 0.1, 7000);
    this.groundSpot = new THREE.Vector3(20, 1.7, -10);
    this.groundYawOff = 0;
    this.groundPitchOff = 0;

    // chase camera (world space, smoothed)
    this.chaseCam = new THREE.PerspectiveCamera(60, aspect, 0.1, 7000);
    this.chasePos = new THREE.Vector3();
    this.chaseLook = new THREE.Vector3();
    this.chaseYawOff = 0;
    this.chaseZoom = 1;
    this.chaseManual = -10;

    // outrigger setup camera (world space, smoothed)
    this.setupCam = new THREE.PerspectiveCamera(62, aspect, 0.05, 7000);
    this.setupPos = new THREE.Vector3();
    this.setupLook = new THREE.Vector3();
    this.setupYawOff = 0;
    this.setupZoom = 1;

    // overturn cinematic
    this.cineCam = new THREE.PerspectiveCamera(50, aspect, 0.2, 7000);
    this.cine = null; // {t, center, ang, returnMode}
    this._cineDone = false;
    this._machineMode = null;

    this.shakeAmp = 0;
    this._snap = true;
    this._userOrbit = false;
    this.active = this.cabCam;
    this._setupDrag();
  }

  _setupDrag() {
    let dragging = false, lx = 0, ly = 0;
    this.dom.addEventListener('pointerdown', (e) => {
      if (!DRAG_MODES.has(this.mode)) return;
      dragging = true;
      lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      const now = performance.now() / 1000;
      if (this.mode === 'cab') {
        const lim = this._cabLimits();
        this.yaw -= dx * 0.004;
        this.pitch -= dy * 0.004;
        this.yaw = clamp(this.yaw, -lim.yawMax, lim.yawMax);
        this.pitch = clamp(this.pitch, lim.pitchMin, lim.pitchMax);
        this.lastManual = now;
      } else if (this.mode === 'driver') {
        this.driverYaw = clamp(this.driverYaw - dx * 0.004, -2.4, 2.4);
        this.driverPitch = clamp(this.driverPitch - dy * 0.004, -1.2, 0.8);
        this.driverManual = now;
      } else if (this.mode === 'chase') {
        this.chaseYawOff -= dx * 0.005;
        this.chaseManual = now;
      } else if (this.mode === 'setup') {
        this.setupYawOff -= dx * 0.005;
      } else {
        this.groundYawOff -= dx * 0.004;
        this.groundPitchOff = clamp(this.groundPitchOff - dy * 0.004, -1, 1);
      }
    });
    window.addEventListener('pointerup', () => { dragging = false; });
    this.dom.addEventListener('wheel', (e) => {
      const s = Math.sign(e.deltaY);
      if (this.mode === 'cab' || this.mode === 'ground' || this.mode === 'driver') {
        const cam = this.mode === 'cab' ? this.cabCam : this.mode === 'driver' ? this.driverCam : this.groundCam;
        cam.fov = clamp(cam.fov + s * 4, 25, 85);
        cam.updateProjectionMatrix();
      } else if (this.mode === 'chase') {
        this.chaseZoom = clamp(this.chaseZoom * (1 + s * 0.1), 0.45, 2.5);
      } else if (this.mode === 'setup') {
        this.setupZoom = clamp(this.setupZoom * (1 + s * 0.1), 0.5, 2.5);
      }
    }, { passive: true });
  }

  _cabLimits() {
    const l = this.rig?.cab?.limits || {};
    return { yawMax: l.yawMax ?? 2.6, pitchMin: l.pitchMin ?? -1.45, pitchMax: l.pitchMax ?? 0.7, autoPitchMax: l.autoPitchMax ?? 0.5 };
  }

  // ------------------------------------------------------------- machine rig
  /**
   * Re-parent the machine-mounted cameras onto a machine's rig
   * (src/machines/machine.js CameraRigSpec). Optional extras read here:
   * rig.cab.tilt (number | () => rad, cab tilt, smoothed at 5°/s),
   * rig.cab.limits {yawMax, pitchMin, pitchMax, autoPitchMax} (rad).
   */
  attach(rig) {
    if (!rig) return;
    const changed = this.rig !== rig;
    if (changed && this.rig) {
      // a different machine: fresh look state, orbit re-centres on it
      this.yaw = 0;
      this.pitch = -0.32;
      this.cabTilt = 0;
      this.driverYaw = 0;
      this.driverPitch = -0.1;
      this.chaseYawOff = this.setupYawOff = 0;
      this._orbitRecenter = true;
      this.cine = null;
      this._cineDone = false;
    }
    this.rig = rig;
    const place = (obj, parent, pos) => {
      if (obj.parent !== parent) parent.add(obj);
      if (pos) obj.position.copy(pos);
    };
    if (rig.cab?.parent) {
      place(this.cabPivot, rig.cab.parent, rig.cab.headPos);
      this.cabBaseYaw = rig.cab.baseYaw ?? -Math.PI / 2;
      this.head.position.set(0, 0, 0);
    }
    if (rig.driver?.parent) {
      place(this.driverPivot, rig.driver.parent, rig.driver.headPos);
      this.driverBaseYaw = rig.driver.baseYaw ?? -Math.PI / 2;
    } else if (this.driverPivot.parent) {
      this.driverPivot.parent.remove(this.driverPivot);
    }
    if (rig.hook?.parent) {
      const p = rig.hook.pos || _v.set(0, -0.5, 0);
      place(this.hookCam, rig.hook.parent, p);
      place(this.pipCam, rig.hook.parent, p);
    }
    this._snap = true;
  }

  /** Cycle list for the current machine state; switches to its default when the state changes. */
  setModes(list) {
    if (!Array.isArray(list) || !list.length) return;
    const prevDefault = this.modes ? this.modes[0] : null;
    this.modes = list.slice();
    if (this.mode === 'cinematic') return;
    // a state change (e.g. ROAD → SETUP) jumps to its default camera, unless the
    // player deliberately chose the orbit view
    const keepOrbit = this.mode === 'orbit' && list.includes('orbit') && this._userOrbit;
    if (!list.includes(this.mode) || (prevDefault && prevDefault !== list[0] && !keepOrbit)) {
      this.setMode(list[0]);
      this._userOrbit = false;
    }
  }

  setMode(mode) {
    if (mode === 'cinematic') {
      this.mode = mode;
      this.controls.enabled = false;
      this.active = this.cineCam;
      return;
    }
    const cam = {
      cab: this.cabCam, orbit: this.orbitCam, hook: this.hookCam, ground: this.groundCam,
      driver: this.driverCam, chase: this.chaseCam, setup: this.setupCam,
    }[mode];
    if (!cam) return;
    if (mode === 'driver' && !this.driverPivot.parent) return; // no driver cab on this machine
    if (mode !== this.mode) this._snap = true;
    this.mode = mode;
    this.controls.enabled = mode === 'orbit';
    this.active = cam;
  }

  next() {
    const list = this.modes || TOWER_MODES;
    if (this.mode === 'cinematic') this._endCinematic();
    const i = list.indexOf(this.mode);
    this.setMode(list[(i + 1) % list.length]);
    this._userOrbit = this.mode === 'orbit';
    return this.mode;
  }

  resize(w, h) {
    for (const c of [this.cabCam, this.orbitCam, this.hookCam, this.groundCam, this.driverCam, this.chaseCam, this.setupCam, this.cineCam]) {
      c.aspect = w / h;
      c.updateProjectionMatrix();
    }
  }

  /** Short camera shake (e.g. a slam or the overturn crash); amplitude in rad, decays in ~0.5 s. */
  shake(amount = 0.02) { this.shakeAmp = Math.max(this.shakeAmp, amount); }

  // ------------------------------------------------------------- per frame
  // update(dt, machine) — machine-aware path. The legacy signature
  // update(dt, focus, cabMatrixWorld) still works for a rig-less host.
  update(dt, machine, legacyCabMatrix) {
    let focus = _f;
    if (machine && machine.isVector3) {
      focus.copy(machine);
      machine = null;
      if (!this.rig && legacyCabMatrix) { this._legacyCab(dt, focus, legacyCabMatrix); return; }
    } else if (machine) {
      const rig = machine.cameraRig ? machine.cameraRig() : null;
      if (rig && rig !== this.rig) this.attach(rig);
    }
    const rig = this.rig;
    if (!machine && !rig) return;
    if (machine && rig?.focus) rig.focus(focus);
    const now = performance.now() / 1000;

    // machine state: overturn cinematic, tipping rumble
    const mm = machine ? machine.mode : null;
    if (mm !== this._machineMode) {
      if (this._machineMode === 'OVERTURNED') this._cineDone = false;
      this._machineMode = mm;
    }
    if (mm === 'OVERTURNED' && !this._cineDone && !this.cine) this._startCinematic(rig, focus);
    if (mm === 'TIPPING') this.shake(0.006);
    if (this.mode !== 'cinematic' && this.modes && !this.modes.includes(this.mode)) this.setMode(this.modes[0]);
    if (this.mode === 'driver' && !this.driverPivot.parent) this.setMode(this.modes?.[0] || 'cab');

    switch (this.mode) {
      case 'cab': this._updateCab(dt, focus, now); break;
      case 'driver': this._updateDriver(dt, now); break;
      case 'chase': this._updateChase(dt, rig, focus, now); break;
      case 'setup': this._updateSetup(dt, rig, focus); break;
      case 'orbit': this._updateOrbit(dt, focus); break;
      case 'ground': this._updateGround(focus); break;
      case 'cinematic': this._updateCinematic(dt); break;
      default: break; // hook: fixed to its mount
    }
    this._snap = false;
    this._applyShake(dt);
  }

  _updateCab(dt, focus, now) {
    const lim = this._cabLimits();
    const tiltSrc = this.rig?.cab?.tilt;
    const tiltTarget = typeof tiltSrc === 'function' ? tiltSrc() : Number(tiltSrc) || 0;
    const dTilt = clamp(tiltTarget - this.cabTilt, -CAB_TILT_RATE * dt, CAB_TILT_RATE * dt);
    this.cabTilt = this._snap ? tiltTarget : this.cabTilt + dTilt;
    // pivot = Ry(baseYaw)·Rx(tilt): the cab tilts up about its own lateral axis
    this.cabPivot.rotation.set(this.cabTilt, this.cabBaseYaw, 0);
    if (this.autoLook && now - this.lastManual > 4) {
      // operator naturally keeps the load in view (angles in the tilted cab frame)
      this.cabPivot.updateWorldMatrix(true, false);
      const local = _v.copy(focus).applyMatrix4(_m.copy(this.cabPivot.matrixWorld).invert());
      const tyaw = Math.atan2(-local.x, -local.z);
      const tpitch = Math.atan2(local.y, Math.hypot(local.x, local.z));
      const k = 1 - Math.exp(-dt * 1.6);
      this.yaw += (clamp(wrapPi(tyaw), -lim.yawMax, lim.yawMax) - this.yaw) * k;
      this.pitch += (clamp(tpitch, lim.pitchMin, lim.autoPitchMax) - this.pitch) * k;
    }
    this.head.rotation.set(this.pitch, this.yaw, 0);
  }

  _updateDriver(dt, now) {
    this.driverPivot.rotation.set(0, this.driverBaseYaw ?? -Math.PI / 2, 0);
    if (now - this.driverManual > 3) {
      // eyes back on the road
      const k = 1 - Math.exp(-dt * 1.2);
      this.driverYaw += (0 - this.driverYaw) * k;
      this.driverPitch += (-0.1 - this.driverPitch) * k;
    }
    this.driverHead.rotation.set(this.driverPitch, this.driverYaw, 0);
  }

  // carrier pose from its matrixWorld: origin = slew axis at ground, +X = forward
  _carrierPose(rig, pos, fwd) {
    const c = rig?.carrier;
    if (!c) return false;
    c.updateWorldMatrix(true, false);
    pos.setFromMatrixPosition(c.matrixWorld);
    c.getWorldQuaternion(_q);
    fwd.set(1, 0, 0).applyQuaternion(_q).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
    fwd.normalize();
    return true;
  }

  _updateChase(dt, rig, focus, now) {
    const pos = _c, fwd = _d;
    if (!this._carrierPose(rig, pos, fwd)) { pos.copy(focus); fwd.set(1, 0, 0); }
    if (now - this.chaseManual > 4) this.chaseYawOff *= Math.exp(-dt * 0.8); // swing back behind
    const a = this.chaseYawOff;
    const bx = fwd.x * Math.cos(a) + fwd.z * Math.sin(a), bz = -fwd.x * Math.sin(a) + fwd.z * Math.cos(a);
    const z = this.chaseZoom;
    const want = _e.set(pos.x - bx * CHASE.back * z, pos.y + CHASE.up * z, pos.z - bz * CHASE.back * z);
    const look = rig?.chaseTarget ? rig.chaseTarget(_l, dt) : _l.set(pos.x + fwd.x * CHASE.ahead, pos.y + 2, pos.z + fwd.z * CHASE.ahead);
    if (this._snap) { this.chasePos.copy(want); this.chaseLook.copy(look); }
    else {
      this.chasePos.lerp(want, 1 - Math.exp(-dt * 2.5));
      this.chaseLook.lerp(look, 1 - Math.exp(-dt * 5));
    }
    this.chaseCam.position.copy(this.chasePos);
    this.chaseCam.lookAt(this.chaseLook);
  }

  _updateSetup(dt, rig, focus) {
    const t = rig?.setupTarget ? rig.setupTarget(_t) : _t.copy(focus);
    const c = _c, fwd = _d;
    const hasCarrier = this._carrierPose(rig, c, fwd);
    const dir = _w.set(t.x - c.x, 0, t.z - c.z);
    const z = this.setupZoom;
    const eye = _e, look = _l;
    if (!hasCarrier || dir.lengthSq() < 1) {
      // all floats selected (target = carrier centre): elevated diagonal overview
      dir.set(fwd.z, 0, -fwd.x).multiplyScalar(0.8).addScaledVector(fwd, 0.6).normalize(); // front-left
      dir.applyAxisAngle(UP, this.setupYawOff);
      eye.set(t.x + dir.x * 14 * z, t.y + 7 * z, t.z + dir.z * 14 * z);
      look.set(t.x, t.y + 1, t.z);
    } else {
      // 6 m out along the diagonal through the float, eye 1.7 m above its ground
      dir.normalize().applyAxisAngle(UP, this.setupYawOff);
      eye.set(t.x + dir.x * SETUP.dist * z, t.y + SETUP.eye, t.z + dir.z * SETUP.dist * z);
      look.set(t.x, t.y + 0.45, t.z);
    }
    if (this._snap) { this.setupPos.copy(eye); this.setupLook.copy(look); }
    else {
      this.setupPos.lerp(eye, 1 - Math.exp(-dt * 3));
      this.setupLook.lerp(look, 1 - Math.exp(-dt * 4));
    }
    this.setupCam.position.copy(this.setupPos);
    this.setupCam.lookAt(this.setupLook);
  }

  _updateOrbit(dt, focus) {
    if (this._orbitRecenter) {
      // new machine: frame it from a three-quarter view
      this._orbitRecenter = false;
      this.followTarget.copy(focus);
      this.controls.target.copy(focus);
      this.orbitCam.position.set(focus.x - 34, focus.y + 22, focus.z + 38);
    }
    const prev = _v.copy(this.followTarget);
    this.followTarget.lerp(focus, 1 - Math.exp(-dt * 3));
    const delta = prev.subVectors(this.followTarget, prev);
    this.controls.target.add(delta);
    this.orbitCam.position.add(delta);
    this.controls.update();
  }

  _updateGround(focus) {
    const flat = _v.set(focus.x, 0, focus.z);
    const dist = flat.distanceTo(_w.set(this.groundSpot.x, 0, this.groundSpot.z));
    if (dist > 34 || dist < 8) {
      const dir = flat.clone().setY(0).normalize();
      if (dir.lengthSq() < 0.1) dir.set(1, 0, 0);
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      this.groundSpot.copy(flat).addScaledVector(dir, 12).addScaledVector(side, 9).setY(1.7);
    }
    this.groundCam.position.copy(this.groundSpot);
    this.groundCam.lookAt(focus);
    this.groundCam.rotateY(this.groundYawOff);
    this.groundCam.rotateX(this.groundPitchOff);
  }

  // ------------------------------------------------------------- overturn cinematic
  _startCinematic(rig, focus) {
    const center = new THREE.Vector3();
    if (!this._carrierPose(rig, center, _d)) center.copy(focus);
    // start on the side the boom fell toward (the focus), looking back at the carrier
    const toward = _v.set(focus.x - center.x, 0, focus.z - center.z);
    const ang = toward.lengthSq() > 1 ? Math.atan2(toward.z, toward.x) + 0.9 : 0.6;
    this.cine = { t: 0, center, ang, returnMode: this.mode };
    this.setMode('cinematic');
    this.shake(0.03);
  }

  _updateCinematic(dt) {
    const c = this.cine;
    if (!c) { this.setMode(this.modes?.[0] || 'orbit'); return; }
    c.t += dt;
    c.ang += dt * 0.16;
    const r = 26 + c.t * 1.1, h = 7 + c.t * 0.45; // slow pull-back and rise
    this.cineCam.position.set(c.center.x + Math.cos(c.ang) * r, c.center.y + h, c.center.z + Math.sin(c.ang) * r);
    this.cineCam.lookAt(c.center.x, c.center.y + 3, c.center.z);
    if (c.t > CINE_TIME) this._endCinematic();
  }

  _endCinematic() {
    const c = this.cine;
    this.cine = null;
    this._cineDone = true;
    this._userOrbit = false;
    if (c) {
      // hand the shot over to the free orbit without a jump
      this.orbitCam.position.copy(this.cineCam.position);
      this.controls.target.set(c.center.x, c.center.y + 3, c.center.z);
      this.followTarget.copy(this.controls.target);
    }
    if (this.mode === 'cinematic') {
      this.mode = 'orbit';
      this.controls.enabled = true;
      this.active = this.orbitCam;
    }
  }

  _applyShake(dt) {
    const cam = this.active;
    const cabLike = cam === this.cabCam || cam === this.driverCam;
    if (this.shakeAmp < 1e-4) {
      if (cabLike && (cam.rotation.x || cam.rotation.y)) cam.rotation.set(0, 0, 0);
      this.shakeAmp = 0;
      return;
    }
    const a = this.shakeAmp;
    const rx = (Math.random() - 0.5) * 2 * a, ry = (Math.random() - 0.5) * 2 * a;
    if (cabLike) cam.rotation.set(rx, ry, 0);
    else if (cam !== this.hookCam) { cam.rotateX(rx); cam.rotateY(ry); }
    this.shakeAmp *= Math.exp(-dt * 6);
  }

  // original tower-only path (host without attach): head on the tower cab
  _legacyCab(dt, focus, cabMatrixWorld) {
    if (this.mode === 'cab' && this.autoLook && performance.now() / 1000 - this.lastManual > 4) {
      const local = _v.copy(focus).applyMatrix4(_m.copy(cabMatrixWorld).invert()).sub(this.cabPivot.position);
      const k = 1 - Math.exp(-dt * 1.6);
      this.yaw += (clamp(Math.atan2(-local.z, local.x), -2.6, 2.6) - this.yaw) * k;
      this.pitch += (clamp(Math.atan2(local.y, Math.hypot(local.x, local.z)), -1.45, 0.5) - this.pitch) * k;
      this.head.rotation.set(this.pitch, this.yaw, 0);
    } else if (this.mode === 'orbit') this._updateOrbit(dt, focus);
    else if (this.mode === 'ground') this._updateGround(focus);
  }
}
