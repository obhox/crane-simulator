import * as THREE from 'three';
import { Box } from './physics/collide.js';
import { buildLoadMesh } from './loadModels.js';

// Load catalogue. Masses follow typical construction values:
// 1 m³ concrete bucket ≈ 2.4 t concrete + skip, 3.6×2.4 m shutter 1.3 t
// (CPA wind example), HEB 300 at 117 kg/m × 12 m ≈ 1.4 t, etc.
// size = [x (long axis), y (height), z]; slings are attach points on top (local).
export const LOAD_DEFS = {
  testWeight: {
    name: 'Test weight 1.0 t', mass: 1000, size: [0.85, 0.85, 0.85],
    points: [[0, 0]], sling: 1.1, cd: 1.05, windLimit: 20,
  },
  rebar: {
    name: 'Rebar bundle 2.0 t', mass: 2000, size: [6.0, 0.36, 0.5],
    points: [[-1.9, 0], [1.9, 0]], sling: 2.7, cd: 1.1, windLimit: 17,
  },
  bricks: {
    name: 'Brick pallet 1.2 t', mass: 1200, size: [1.2, 1.1, 1.0],
    points: [[-0.55, -0.45], [0.55, -0.45], [0.55, 0.45], [-0.55, 0.45]], sling: 1.7, cd: 1.1, windLimit: 17,
  },
  shutter: {
    name: 'Formwork shutter 1.3 t', mass: 1300, size: [3.6, 2.4, 0.28],
    points: [[-1.2, 0], [1.2, 0]], sling: 2.1, cd: 1.2, windLimit: 6.5,
  },
  beam: {
    name: 'Steel beam HEB 300 × 12 m', mass: 1400, size: [12.0, 0.3, 0.3],
    points: [[-3.2, 0], [3.2, 0]], sling: 3.9, cd: 1.6, windLimit: 17,
  },
  bucket: {
    name: 'Concrete bucket 1 m³ (full)', mass: 2800, size: [1.45, 1.95, 1.45],
    points: [[0, 0]], sling: 0.35, cd: 0.8, windLimit: 17,
  },
  container: {
    name: 'Material container 2.3 t', mass: 2300, size: [3.0, 2.55, 2.44],
    points: [[-1.4, -1.1], [1.4, -1.1], [1.4, 1.1], [-1.4, 1.1]], sling: 2.6, cd: 1.15, windLimit: 14,
  },
  pallet: {
    name: 'Block pallet 1.6 t', mass: 1600, size: [1.2, 1.25, 1.0],
    points: [[-0.55, -0.45], [0.55, -0.45], [0.55, 0.45], [-0.55, 0.45]], sling: 1.7, cd: 1.1, windLimit: 17,
  },

  // ---- AT-100 mobile crane jobs (spec §8.4 load table). Sizes, sling points,
  // sling lengths and wind limits are the spec's; cd where the spec gives "—"
  // is the value for the nearest bluff shape (box 1.05–1.15, plate 1.2).
  testBlock5: {
    name: 'Test block 5.0 t', mass: 5000, size: [1.6, 1.25, 1.0],
    points: quad(0.6, 0.35), sling: 1.6, cd: 1.05, windLimit: 20, metal: false,
  },
  // v_max = v_chart·sqrt(1.2·m[t]/A[m²]) [S16]: 14.3·sqrt(1.2·3/8.82) ≈ 9 m/s
  hvac: {
    name: 'Rooftop HVAC unit 3.0 t', mass: 3000, size: [4.2, 2.1, 2.2],
    points: quad(1.9, 0.95), sling: 3.2, cd: 1.2, windLimit: 9.0, metal: true,
  },
  generator: {
    name: 'Generator set 11.5 t', mass: 11500, size: [6.0, 2.6, 2.3],
    points: quad(2.7, 1.0), sling: 3.4, cd: 1.15, windLimit: 13, metal: true,
  },
  precast: {
    name: 'Precast wall panel 4.2 t', mass: 4200, size: [4.0, 2.1, 0.2],
    points: [[-1.2, 0], [1.2, 0]], sling: 2.4, cd: 1.2, windLimit: 11,
  },
  // 8 × HEB 260 × 8.0 m at 93 kg/m = 5.95 t
  steelBundle: {
    name: 'Steel bundle HEB 260 6.0 t', mass: 6000, size: [8.0, 0.6, 1.0],
    points: [[-2.6, 0], [2.6, 0]], sling: 3.6, cd: 1.3, windLimit: 17, metal: true,
  },
  transformer: {
    name: 'Transformer 7.5 t', mass: 7500, size: [2.4, 2.2, 1.6],
    points: quad(1.0, 0.6), sling: 2.0, cd: 1.1, windLimit: 14, metal: true,
  },
  // counterweight slabs (§1.5): long axis = across the carrier (2.6 m)
  cwA: {
    name: 'Counterweight slab A 11.5 t', mass: 11500, size: [2.6, 0.47, 1.25],
    points: quad(1.0, 0.45), sling: 1.8, cd: 1.05, windLimit: 20, metal: true, slab: 'A',
  },
  cwB: {
    name: 'Counterweight slab B 12.0 t', mass: 12000, size: [2.6, 0.49, 1.25],
    points: quad(1.0, 0.45), sling: 1.8, cd: 1.05, windLimit: 20, metal: true, slab: 'B',
  },
  cwC: {
    name: 'Counterweight slab C 11.5 t', mass: 11500, size: [2.6, 0.47, 1.25],
    points: quad(1.0, 0.45), sling: 1.8, cd: 1.05, windLimit: 20, metal: true, slab: 'C',
  },
};

// four sling points at [±a, ±b] (order as the existing 4-leg loads)
function quad(a, b) { return [[-a, -b], [a, -b], [a, b], [-a, b]]; }

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

export class Load {
  constructor(type, x, z, yaw = 0, baseY = 0) {
    const def = LOAD_DEFS[type];
    this.type = type;
    this.def = def;
    this.mass = def.mass;
    this.half = new THREE.Vector3(def.size[0] / 2, def.size[1] / 2, def.size[2] / 2);
    this.mesh = buildLoadMesh(type, def);
    this.pos = new THREE.Vector3(x, baseY + this.half.y, z);
    this.yaw = yaw;
    this.yawVel = 0;
    this.upDir = new THREE.Vector3(0, 1, 0);
    this.attached = false;
    this.box = new Box(x, this.pos.y, z, this.half.x, this.half.y, this.half.z, yaw, 'load');
    this.box.load = this;
    this.area = { face: def.size[0] * def.size[1], side: def.size[2] * def.size[1], top: def.size[0] * def.size[2] };
    this.sync();
  }

  get inertiaYaw() {
    const [a, , b] = this.def.size;
    return (this.mass * (a * a + b * b)) / 12;
  }

  sync() {
    this.box.cx = this.pos.x;
    this.box.cy = this.pos.y;
    this.box.cz = this.pos.z;
    this.box.setYaw(this.yaw);
    _q.setFromAxisAngle(_up, this.yaw);
    _q2.setFromUnitVectors(_up, this.upDir);
    this.mesh.quaternion.copy(_q2).multiply(_q);
    this.mesh.position.copy(this.pos);
  }

  // world position of sling attach point i
  slingPoint(i, out) {
    const [px, pz] = this.def.points[i];
    out.set(px, this.half.y + (this.type === 'bucket' ? 0.3 : 0), pz).applyQuaternion(this.mesh.quaternion).add(this.pos);
    return out;
  }

  // point on top centre the bridle converges above
  topCenter(out) {
    return out.set(0, this.half.y, 0).applyQuaternion(this.mesh.quaternion).add(this.pos);
  }

  // Distance from hook bowl to load CoG when slings are taut
  get hangLength() {
    return this.def.sling + this.half.y + (this.type === 'bucket' ? 0.3 : 0);
  }

  // projected area facing a horizontal wind direction (wx,wz unit)
  windArea(wx, wz) {
    const ax = Math.cos(this.yaw), az = -Math.sin(this.yaw); // local x axis
    const along = Math.abs(ax * wx + az * wz);
    return this.area.side * along + this.area.face * (1 - along);
  }
}
