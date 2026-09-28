import * as THREE from 'three';
import { CRANE, G, AIR_DENSITY } from '../config.js';
import { Box } from './collide.js';
import { clamp } from '../util/math.js';

// Hoist system: kinematic trolley sheave → elastic multi-fall rope → hook
// block (particle) → bridle slings → payload (particle). Solved with XPBD
// (small substeps), which gives the double-pendulum sway, centrifugal
// outswing, rope stretch/bounce and slack-rope behaviour for free.

const _n = new THREE.Vector3();
const _w = { x: 0, z: 0 };
const _t = new THREE.Vector3();

// Default hook collider half-size (the tower's block). The box sits 0.05 m
// below the hook bowl up to the block top: centre = hook + (half.y − 0.05).
const TOWER_HOOK_HALF = [0.26, 0.5, 0.26];

export class HoistSystem {
  // opts (all optional; defaults reproduce the tower exactly):
  //   hookMass   hook-block mass (kg)
  //   ropeEA     axial stiffness of ONE fall (N)
  //   deadLength () => m, rope run from the sheave back to the winch (mobile: L + 1.5);
  //              default: the tower's radius + 22 m
  //   hookHalf   hook-block collider half-size [x, y, z] (m)
  constructor(world, wind, { hookMass = CRANE.hookMass, ropeEA = CRANE.ropeEA, deadLength = null, hookHalf = TOWER_HOOK_HALF } = {}) {
    this.world = world;
    this.wind = wind;
    this.falls = 2;
    this.hook = new THREE.Vector3(10, 30, 0);
    this.hookPrev = this.hook.clone();
    this.hookVel = new THREE.Vector3();
    this.hookMass = hookMass;
    this.ropeEA = ropeEA;
    this.deadLength = deadLength;
    this.stowed = false; // mobile ROAD mode: block pinned to the bumper, step() skipped by the owner
    this.ropeLen = 16;
    this.sheave = new THREE.Vector3(10, 46.6, 0);
    this.sheavePrev = this.sheave.clone();
    this.load = null;
    this.loadPrev = new THREE.Vector3();
    this.loadVel = new THREE.Vector3();
    this.tension = this.hookMass * G;
    this.tensionFiltered = this.tension;
    this.slingTension = 0;
    this.hookBox = new Box(0, 0, 0, hookHalf[0], hookHalf[1], hookHalf[2], 0, 'hook');
    this.hookBoxOffset = hookHalf[1] - 0.05; // 0.45 for the tower block
    this.loadGrounded = false;
    this.hookGrounded = false;
    this.impacts = [];
    this.lambdaRope = 0;
    this.lambdaSling = 0;
    this.tagTorque = 0;
    this.blockYaw = 0;
    this.slewRate = 0;
    this.radius = 10;
  }

  get ropeStiffness() {
    const n = this.falls;
    // hook-level stiffness: n falls in parallel plus the rope run back to the winch
    if (this.deadLength) return (n * n * this.ropeEA) / (n * this.ropeLen + this.deadLength());
    return (n * n * this.ropeEA) / (n * this.ropeLen + this.radius + 22);
  }

  // Change the hook block (re-reeving): mass and collider size. Only with no
  // load attached; the caller sets `falls` and the rope length itself.
  setHookBlock({ mass = this.hookMass, half = null } = {}) {
    if (this.load) return false;
    this.hookMass = mass;
    if (half) {
      const b = this.hookBox;
      b.set(b.cx, b.cy, b.cz, half[0], half[1], half[2], b.yaw);
      this.hookBoxOffset = half[1] - 0.05;
    }
    return true;
  }

  reset(sheave) {
    this.sheave.copy(sheave);
    this.sheavePrev.copy(sheave);
    this.hook.set(sheave.x, sheave.y - this.ropeLen, sheave.z);
    this.hookPrev.copy(this.hook);
    this.hookVel.set(0, 0, 0);
  }

  attach(load) {
    this.load = load;
    load.attached = true;
    load.box.enabled = false;
    // Safety nets for scripted/reset attaches (the hosts only hook on within
    // sling reach): resolve the load out of any overlap once, here, so the
    // de-penetration never turns into velocity on the first step…
    const lb = load.box;
    lb.cx = load.pos.x; lb.cy = load.pos.y; lb.cz = load.pos.z;
    lb.setYaw(load.yaw);
    this.world.resolve(lb, load.pos.y, lb);
    load.pos.set(lb.cx, lb.cy, lb.cz);
    // …and take any over-reach (hook further than the slings reach) up
    // gently in step() instead of snatching the load at the first substep.
    load.slingExtra = Math.max(0, load.pos.distanceTo(this.hook) - load.hangLength);
    this.loadPrev.copy(load.pos);
    this.loadVel.set(0, 0, 0);
    load.yawVel = 0;
  }

  detach() {
    const load = this.load;
    if (!load) return null;
    load.slingExtra = 0;
    load.attached = false;
    load.upDir.set(0, 1, 0);
    load.box.enabled = true;
    load.sync();
    this.load = null;
    return load;
  }

  applyDrag(vel, h, area, cd, mass, out) {
    this.wind.velocityAt(h, _w);
    const rx = _w.x - vel.x, ry = -vel.y, rz = _w.z - vel.z;
    const sp = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const k = (0.5 * AIR_DENSITY * cd * area * sp) / mass;
    out.x += rx * k;
    out.y += ry * k;
    out.z += rz * k;
  }

  // One fixed step (dt) split into substeps. sheaveTarget is where the
  // trolley sheave will be at the end of the step.
  step(dt, substeps, sheaveTarget, ropeLenTarget) {
    this.sheavePrev.copy(this.sheave);
    const startLen = this.ropeLen;
    const lenRate = (ropeLenTarget - startLen) / dt;
    const h = dt / substeps;
    const load = this.load;
    const k = this.ropeStiffness;
    const alphaRope = 1 / k / (h * h);
    const alphaSling = 1 / 4.0e6 / (h * h);
    let tensionSum = 0, slingSum = 0;
    this.impacts.length = 0;
    let loadSupport = false, hookSupport = false;
    const acc = new THREE.Vector3();
    const accL = new THREE.Vector3();
    const sPrevSub = new THREE.Vector3();

    for (let s = 1; s <= substeps; s++) {
      const f = s / substeps;
      sPrevSub.copy(this.sheave);
      this.sheave.lerpVectors(this.sheavePrev, sheaveTarget, f);
      this.ropeLen = startLen + (ropeLenTarget - startLen) * f;

      // --- predict
      acc.set(0, -G, 0);
      this.applyDrag(this.hookVel, this.hook.y, 0.35, 1.1, this.hookMass, acc);
      this.hookVel.addScaledVector(acc, h);
      this.hookPrev.copy(this.hook);
      this.hook.addScaledVector(this.hookVel, h);

      if (load) {
        accL.set(0, -G, 0);
        this.wind.velocityAt(load.pos.y, _w);
        const ws = Math.hypot(_w.x, _w.z) || 1;
        const area = load.windArea(_w.x / ws, _w.z / ws);
        this.applyDrag(this.loadVel, load.pos.y, area, load.def.cd, load.mass, accL);
        // light vertical aero damping from the top area
        accL.y -= (0.5 * AIR_DENSITY * 1.1 * load.area.top * Math.abs(this.loadVel.y) * this.loadVel.y) / load.mass;
        this.loadVel.addScaledVector(accL, h);
        this.loadPrev.copy(load.pos);
        load.pos.addScaledVector(this.loadVel, h);
      }

      // --- constraints (2 Gauss-Seidel sweeps)
      let lr = 0, ls = 0;
      for (let it = 0; it < 2; it++) {
        // hoist rope: inextensible-ish, one-sided (can go slack)
        _n.subVectors(this.hook, this.sheave);
        let d = _n.length();
        let C = d - this.ropeLen;
        if (C > 0 && d > 1e-6) {
          _n.multiplyScalar(1 / d);
          const w = 1 / this.hookMass;
          const dl = (-C - alphaRope * lr) / (w + alphaRope);
          lr += dl;
          this.hook.addScaledVector(_n, w * dl);
        }
        if (load) {
          _n.subVectors(load.pos, this.hook);
          d = _n.length();
          C = d - (load.hangLength + (load.slingExtra || 0));
          if (C > 0 && d > 1e-6) {
            _n.multiplyScalar(1 / d);
            const wh = 1 / this.hookMass, wl = 1 / load.mass;
            const dl = (-C - alphaSling * ls) / (wh + wl + alphaSling);
            ls += dl;
            load.pos.addScaledVector(_n, wl * dl);
            this.hook.addScaledVector(_n, -wh * dl);
          }
        }
      }
      tensionSum += Math.max(0, -lr) / (h * h);
      slingSum += Math.max(0, -ls) / (h * h);

      // --- collisions
      if (load) {
        const lb = load.box;
        lb.cx = load.pos.x; lb.cy = load.pos.y; lb.cz = load.pos.z;
        lb.setYaw(load.yaw);
        const vx = (load.pos.x - this.loadPrev.x) / h;
        const vy = (load.pos.y - this.loadPrev.y) / h;
        const vz = (load.pos.z - this.loadPrev.z) / h;
        const info = this.world.resolve(lb, this.loadPrev.y, lb);
        load.pos.set(lb.cx, lb.cy, lb.cz);
        if (info.support) {
          loadSupport = true;
          if (vy < -0.05) this.impacts.push({ speed: -vy, kind: 'land', tag: info.hitTag, mass: load.mass });
        }
        if (info.lateral) {
          const vn = -(vx * info.nx + vz * info.nz);
          if (vn > 0.05) this.impacts.push({ speed: vn, kind: 'side', tag: info.hitTag, mass: load.mass });
        }
        if (info.ceiling && vy > 0.05) this.impacts.push({ speed: vy, kind: 'side', tag: info.hitTag, mass: load.mass });
        // hook resting on the attached load's top
        const top = load.pos.y + load.half.y;
        if (this.hook.y < top + 0.02 && Math.abs(this.hook.x - load.pos.x) < load.half.x + 0.2 && Math.abs(this.hook.z - load.pos.z) < Math.max(load.half.z, load.half.x) + 0.2) {
          this.hook.y = top + 0.02;
          hookSupport = true;
        }
      }
      const hb = this.hookBox, hbo = this.hookBoxOffset;
      hb.cx = this.hook.x; hb.cy = this.hook.y + hbo; hb.cz = this.hook.z;
      const hvy = (this.hook.y - this.hookPrev.y) / h;
      const hvx = (this.hook.x - this.hookPrev.x) / h, hvz = (this.hook.z - this.hookPrev.z) / h;
      const hinfo = this.world.resolve(hb, this.hookPrev.y + hbo, load ? load.box : null);
      this.hook.set(hb.cx, hb.cy - hbo, hb.cz);
      if (hinfo.support) {
        hookSupport = true;
        if (hvy < -0.6) this.impacts.push({ speed: -hvy, kind: 'hook', tag: hinfo.hitTag, mass: this.hookMass });
      }
      if (hinfo.lateral) {
        const vn = -(hvx * hinfo.nx + hvz * hinfo.nz);
        if (vn > 0.1) this.impacts.push({ speed: vn, kind: 'hook', tag: hinfo.hitTag, mass: this.hookMass });
      }

      // --- velocities
      this.hookVel.subVectors(this.hook, this.hookPrev).multiplyScalar(1 / h);
      if (load) this.loadVel.subVectors(load.pos, this.loadPrev).multiplyScalar(1 / h);

      // rope damping: internal friction of the reeving acts on the rate of
      // rope STRETCH (not on the winch paying rope in/out)
      _n.subVectors(this.hook, this.sheave);
      const dd = _n.length();
      if (dd > this.ropeLen - 0.02 && dd > 1e-6) {
        _n.multiplyScalar(1 / dd);
        _t.subVectors(this.sheave, sPrevSub).multiplyScalar(1 / h);
        const rel = (this.hookVel.x - _t.x) * _n.x + (this.hookVel.y - _t.y) * _n.y + (this.hookVel.z - _t.z) * _n.z;
        const stretchRate = rel - lenRate;
        const k = 1 - Math.exp(-9 * h);
        this.hookVel.addScaledVector(_n, -stretchRate * k);
        if (load && !loadSupport) this.loadVel.addScaledVector(_n, -stretchRate * k);
      }
      // ground / support friction
      if (hookSupport) {
        const fr = Math.exp(-14 * h);
        this.hookVel.x *= fr;
        this.hookVel.z *= fr;
      }
      if (load && loadSupport) {
        // Coulomb-ish friction scaled by how much weight still rests on the support
        const slingF = Math.max(0, -ls) / (h * h);
        const normal = clamp(1 - slingF / (load.mass * G), 0, 1);
        const vh = Math.hypot(this.loadVel.x, this.loadVel.z);
        if (vh > 1e-6) {
          const dv = 0.55 * G * normal * h;
          const k2 = vh <= dv ? 0 : (vh - dv) / vh;
          this.loadVel.x *= k2;
          this.loadVel.z *= k2;
        }
      }
      // very small structural/air damping of the swing
      this.hookVel.multiplyScalar(1 - 0.004 * h);
      if (load) this.loadVel.multiplyScalar(1 - 0.002 * h);
    }

    this.tension = tensionSum / substeps;
    this.slingTension = slingSum / substeps;
    this.tensionFiltered += (this.tension - this.tensionFiltered) * (1 - Math.exp(-dt / 0.35)); // load-cell signal filter (like a real LMI)
    this.loadGrounded = loadSupport;
    this.hookGrounded = hookSupport;

    // hook block yaw is held by the reeving (follows the jib); swivel lets the load turn
    if (load) this.stepYaw(dt, loadSupport);
  }

  stepYaw(dt, grounded) {
    const load = this.load;
    const I = load.inertiaYaw;
    // swivel friction couples load yaw to the hook block (which follows the slew)
    let torque = -(load.yawVel - this.slewRate) * I * 0.03;
    torque += this.tagTorque;
    // aerodynamic weathercocking of flat loads + turbulence
    this.wind.velocityAt(load.pos.y, _w);
    const ws2 = _w.x * _w.x + _w.z * _w.z;
    if (ws2 > 0.01) {
      const wdir = Math.atan2(-_w.z, _w.x); // yaw that aligns local x with the wind
      const q = 0.5 * AIR_DENSITY * ws2;
      const lever = load.def.size[0] * 0.08;
      torque -= Math.sin(2 * (wdir - load.yaw)) * q * load.area.face * lever * 0.5; // plates turn broadside
      torque += (Math.sin(this.wind.t * 1.7 + load.mass) * 0.5) * q * load.area.face * lever * 0.3 * this.wind.gustiness;
    }
    load.yawVel += (torque / I) * dt;
    if (grounded && this.slingTension < load.mass * G * 0.9) load.yawVel *= Math.exp(-8 * dt);
    load.yawVel *= Math.exp(-0.05 * dt);
    load.yaw += load.yawVel * dt;
  }

  // orientation of the load: hang under the hook when suspended, level when resting
  updateLoadAttitude(dt) {
    const load = this.load;
    if (!load) return;
    const target = _t;
    const d = load.pos.distanceTo(this.hook);
    if (!this.loadGrounded && d > load.hangLength - 0.05) {
      target.subVectors(this.hook, load.pos).normalize();
    } else target.set(0, 1, 0);
    load.upDir.lerp(target, 1 - Math.exp(-dt * 10)).normalize();
    load.sync();
  }

  get swingAngle() {
    const dx = this.hook.x - this.sheave.x, dz = this.hook.z - this.sheave.z;
    const dy = this.sheave.y - this.hook.y;
    return Math.atan2(Math.hypot(dx, dz), Math.max(0.01, dy));
  }
}
