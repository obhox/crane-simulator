import * as THREE from 'three';
import { Box } from '../physics/collide.js';
import { QUALITY } from '../config.js';
import { MeshBatch, box, cyl, plane, prism, lathe, trs, col } from '../world/site/kit.js';
import { siteMaterials } from '../world/site/materials.js';
import { planCity } from '../world/buildings/planner.js';
import { Atlas, fitText, grunge } from '../crane/kit.js';
import { P1, FLOATS, BASES, carrierToWorld } from './config.js';
import * as groundModule from './ground.js';

// Job scenery for the AT-100 mobile-crane jobs (spec §8.2, §8.4, §8.10):
// delivery vehicles (ballast truck, rigid flatbeds, semi-trailers: flat,
// low-loader, A-frame), the neighbour roof (derived from planCity()), plinths,
// the precast rack, the M6 cable-trench barriers, lay-down areas, and the
// permanent P1 pad markings. Everything is built in the prop's LOCAL frame
// (+x = forward for vehicles) from the site kit and site materials, merged
// per material, so a prop costs a handful of draw calls and can move (the M5
// ballast truck drives in). Colliders are yawed boxes kept in sync with the
// prop pose; the JobRunner registers them in the collider world.
//
//   buildProp(name, opts, J) → Prop {name, root, colliders[], info, update?(dt), carry(load), dispose()}
//   ensureP1Markings(scene, site?)  permanent pad markings (idempotent)
//   bindGround({addZone, clearZones}) / groundApi()   ground.js job zones (§4.8)
//   neighbourRoof() → parcel {x0,x1,z0,z1,roofY,parapet,fallback}

// ------------------------------------------------------------ ground zones
// Job bearing zones go to src/mobile/ground.js (§4.8); bindGround() can
// redirect them (tests, or a machine that keeps its own ground model).
let GROUND = null;
export function bindGround(api) { GROUND = api || null; }
export function groundApi() { return GROUND || groundModule; }

// ------------------------------------------------------------ materials
let SM = null; // site material set (shared with the site when available)
let OM = null; // own materials (paint markings, sign atlas)
function siteMats(site) {
  if (site && site._fx && site._fx.M) return site._fx.M;
  if (!SM) SM = siteMaterials(QUALITY.high);
  return SM;
}

function signAtlas() {
  const A = new Atlas(1024, 512);
  const sans = 'Arial, Helvetica, sans-serif';
  A.add('p1', 512, 220, (c, w, h) => {
    c.fillStyle = '#f4f4ef'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#e8a90c'; c.fillRect(0, 0, w, 58);
    c.fillStyle = '#111'; c.textAlign = 'left'; c.textBaseline = 'middle';
    fitText(c, 'CRANE PAD  P1', 16, 30, w - 30, 40, sans, 'bold');
    c.font = `bold 26px ${sans}`; c.fillText('Prepared hardcore  400 kN/m²', 16, 92);
    c.font = `22px ${sans}`;
    c.fillText('Mobile crane set-up area. Mats under every', 16, 132);
    c.fillText('outrigger. Level to ±0.3°. No storage.', 16, 162);
    c.font = `bold 20px ${sans}`; c.fillText('Lifting supervisor: ext. 214', 16, 198);
    c.globalCompositeOperation = 'destination-out'; grunge(c, w, h, 211, 0.8, 'rgba(0,0,0,'); c.globalCompositeOperation = 'source-over';
  });
  A.add('cable', 300, 150, (c, w, h) => {
    c.fillStyle = '#f5c400'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#111'; c.fillRect(8, 8, w - 16, 44);
    c.fillStyle = '#f5c400'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, 'DANGER', w / 2, 31, w - 40, 34, sans, 'bold');
    c.fillStyle = '#111';
    fitText(c, 'LIVE HV CABLES', w / 2, 82, w - 30, 30, sans, 'bold');
    fitText(c, 'NO OUTRIGGERS - KEEP CLEAR', w / 2, 120, w - 24, 20, sans, 'bold');
  });
  A.add('sub', 260, 150, (c, w, h) => {
    c.fillStyle = '#f2f2ee'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#b3140c'; c.fillRect(0, 0, w, 40);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, 'DANGER  11 000 V', w / 2, 21, w - 20, 28, sans, 'bold');
    c.fillStyle = '#111';
    fitText(c, 'SUBSTATION  SS-14', w / 2, 72, w - 20, 26, sans, 'bold');
    fitText(c, 'Transformer plinth', w / 2, 108, w - 20, 22, sans, 'normal');
  });
  // ground stencils (white on transparent)
  A.add('layC', 400, 120, (c, w, h) => {
    c.fillStyle = 'rgba(240,240,232,0.95)'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, 'LAYDOWN  C', w / 2, h / 2, w - 20, 92, 'Impact, "Arial Narrow", Arial, sans-serif', 'normal');
    c.globalCompositeOperation = 'destination-out'; grunge(c, w, h, 221, 2.5, 'rgba(0,0,0,'); c.globalCompositeOperation = 'source-over';
  });
  A.add('p1g', 240, 120, (c, w, h) => {
    c.fillStyle = 'rgba(240,200,40,0.95)'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, 'P1', w / 2, h / 2, w - 20, 110, 'Impact, "Arial Narrow", Arial, sans-serif', 'normal');
    c.globalCompositeOperation = 'destination-out'; grunge(c, w, h, 231, 3, 'rgba(0,0,0,'); c.globalCompositeOperation = 'source-over';
  });
  return A;
}

function ownMats() {
  if (OM) return OM;
  const atlas = signAtlas();
  const tex = atlas.texture();
  const decalOpts = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
  OM = {
    atlas,
    sign: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0 }),
    stencil: new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.35, depthWrite: false, roughness: 0.8, ...decalOpts }),
    // spray-painted pad marking on hardcore (slightly translucent, matt)
    lineYellow: new THREE.MeshStandardMaterial({ color: 0xe0a000, roughness: 0.85, transparent: true, opacity: 0.85, depthWrite: false, ...decalOpts }),
    lineWhite: new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.85, transparent: true, opacity: 0.8, depthWrite: false, ...decalOpts }),
    marker: new THREE.MeshBasicMaterial({ color: 0x33ff88, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    post: new THREE.MeshStandardMaterial({ color: 0x8c9196, roughness: 0.6, metalness: 0.3 }),
  };
  for (const m of [OM.lineYellow, OM.lineWhite, OM.stencil]) m.userData.cast = false;
  return OM;
}

// ------------------------------------------------------------ Prop
class Prop {
  constructor(name) {
    this.name = name;
    this.root = new THREE.Group();
    this.root.name = 'prop:' + name;
    this.colliders = [];
    this._locals = [];
    this.info = {};
    this.carried = []; // loads riding on the prop: {load, lx, ly, lz, lyaw}
    this.x = 0; this.z = 0; this.yaw = 0;
  }

  // collider in the prop's local frame (centre lx, ly, lz; half extents; local yaw)
  box(lx, ly, lz, hx, hy, hz, lyaw = 0, tag = 'truck') {
    const b = new Box(0, 0, 0, hx, hy, hz, 0, tag);
    this._locals.push({ lx, ly, lz, lyaw, b });
    this.colliders.push(b);
    return b;
  }

  // world point of a local point (x, z)
  toWorld(lx, lz, out = { x: 0, z: 0 }) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    out.x = this.x + lx * c + lz * s;
    out.z = this.z - lx * s + lz * c;
    return out;
  }

  place(x, z, yaw = this.yaw) {
    this.x = x; this.z = z; this.yaw = yaw;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = yaw;
    const w = { x: 0, z: 0 };
    for (const L of this._locals) {
      this.toWorld(L.lx, L.lz, w);
      L.b.set(w.x, L.ly, w.z, L.b.hx, L.b.hy, L.b.hz, yaw + L.lyaw);
    }
    for (const c of this.carried) {
      this.toWorld(c.lx, c.lz, w);
      c.load.pos.set(w.x, c.ly, w.z);
      c.load.yaw = yaw + c.lyaw;
      c.load.sync();
    }
    return this;
  }

  // a load riding on the prop (moves with it while it drives in)
  carry(load) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    const dx = load.pos.x - this.x, dz = load.pos.z - this.z;
    this.carried.push({ load, lx: dx * c - dz * s, lz: dx * s + dz * c, ly: load.pos.y, lyaw: load.yaw - this.yaw });
    return load;
  }

  update() {}

  dispose() {
    this.root.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  }
}

// ------------------------------------------------------------ vehicle parts
const TYRE = col(0x1c1c1c), RIM = col(0xb9bcbf), DARK = col(0x2d3135), CHROME = col(0xd0d4d8);
const LAMP_W = col(0xf2f2ea), LAMP_A = col(0xff9a1a), LAMP_R = col(0xb3140c);

function wheel(B, M, x, y, z, r, w, dual = false) {
  const tyre = lathe([[r * 0.62, -w / 2], [r * 0.92, -w / 2], [r, -w * 0.38], [r, w * 0.38], [r * 0.92, w / 2], [r * 0.62, w / 2]], 20);
  tyre.rotateX(Math.PI / 2);
  const hub = cyl(r * 0.62, r * 0.62, w * 0.8, 14);
  hub.rotateX(Math.PI / 2);
  const nut = cyl(r * 0.2, r * 0.2, w * 0.86, 10);
  nut.rotateX(Math.PI / 2);
  for (const o of dual ? [-w * 0.52, w * 0.52] : [0]) {
    B.add(M.rubber, tyre, trs(x, y, z + o), TYRE);
    B.add(M.paintVeh, hub, trs(x, y, z + o), RIM);
  }
  B.add(M.steel, nut, trs(x, y, z), CHROME);
}

// cab-over truck cab: rear at x0, front at x0 + L, floor at y0 (local frame)
function cab(B, M, x0, y0, L, H, W, color, high = false) {
  const prof = [[0, 0], [L, 0], [L, H * 0.46], [L - 0.1, H * 0.88], [L - 0.28, H], [0, H]];
  B.add(M.paintVeh, prism(prof.map(([px, py]) => [x0 + px, y0 + py]), W), null, color);
  const wsH = H * 0.4, wsY = y0 + H * 0.67, rake = Math.atan2(0.1, H * 0.42);
  B.add(M.glass, plane(W - 0.2, wsH), trs(x0 + L - 0.045, wsY, 0, Math.PI / 2, 0, 0).multiply(trs(0, 0, 0, 0, -rake)));
  for (const s of [-1, 1]) {
    B.add(M.glass, plane(0.85, H * 0.34), trs(x0 + L - 0.62, y0 + H * 0.68, s * (W / 2 + 0.005), s > 0 ? 0 : Math.PI));
    B.add(M.paintVeh, box(0.02, H * 0.8, 0.01), trs(x0 + L - 1.15, y0 + H * 0.45, s * (W / 2 + 0.006)), DARK);
    B.add(M.steel, box(0.16, 0.03, 0.03), trs(x0 + L - 1.05, y0 + H * 0.5, s * (W / 2 + 0.02)), CHROME);
    for (const sy of [-0.45, -0.1]) B.add(M.paint, box(0.45, 0.05, 0.25), trs(x0 + L - 0.65, y0 + sy, s * (W / 2 - 0.08)), DARK);
    B.add(M.paint, box(0.05, 0.05, 0.35), trs(x0 + L - 0.2, y0 + H * 0.78, s * (W / 2 + 0.17)), DARK);
    B.add(M.paint, box(0.08, 0.42, 0.22), trs(x0 + L - 0.15, y0 + H * 0.7, s * (W / 2 + 0.36)), DARK);
    B.add(M.plastic, box(0.04, 0.14, 0.3), trs(x0 + L + 0.02, y0 + 0.28, s * (W / 2 - 0.35)), LAMP_W);
    B.add(M.plastic, box(0.04, 0.08, 0.12), trs(x0 + L + 0.02, y0 + 0.28, s * (W / 2 - 0.12)), LAMP_A);
  }
  B.add(M.paint, box(0.03, H * 0.3, W * 0.62), trs(x0 + L + 0.01, y0 + H * 0.28, 0), DARK);
  for (let i = 0; i < 5; i++) B.add(M.paint, box(0.02, 0.02, W * 0.6), trs(x0 + L + 0.03, y0 + H * 0.16 + i * 0.07, 0), col(0x55595e));
  B.add(M.paint, box(0.22, 0.32, W + 0.05), trs(x0 + L + 0.05, y0 - 0.05, 0), col(0x46494d));
  B.add(M.paintVeh, box(0.3, 0.05, W - 0.1), trs(x0 + L - 0.02, y0 + H + 0.01, 0, 0, 0, -0.2), color);
  if (high) B.add(M.paintVeh, prism([[0, 0], [1.3, 0], [1.3, 0.1], [0.2, 0.55], [0, 0.55]].map(([px, py]) => [x0 + 0.25 + px, y0 + H + py]), W - 0.3), null, color);
  B.add(M.plastic, cyl(0.08, 0.1, 0.14, 10), trs(x0 + 0.5, y0 + H + (high ? 0.6 : 0.07), 0), LAMP_A);
}

function mudguard(B, M, x, y, z, len, w) {
  B.add(M.plastic, box(len, 0.04, w), trs(x, y, z), col(0x161616));
  B.add(M.plastic, box(0.04, 0.35, w), trs(x - len / 2, y - 0.17, z), col(0x161616));
}

function chassis(B, M, x0, x1, y = 0.95) {
  for (const s of [-1, 1]) B.add(M.paint, box(x1 - x0, 0.28, 0.1), trs((x0 + x1) / 2, y, s * 0.45), DARK);
  for (let x = x0 + 0.3; x < x1; x += 1.4) B.add(M.paint, box(0.1, 0.2, 0.9), trs(x, y, 0), DARK);
}

// flat platform body: steel frame, hardwood deck, side rails, stake pockets
function platform(B, M, x0, x1, top, W = 2.5) {
  const L = x1 - x0, xc = (x0 + x1) / 2;
  B.add(M.wood, box(L, 0.05, W - 0.06), trs(xc, top - 0.025, 0), col(0x8a6a48));
  for (const s of [-1, 1]) {
    B.add(M.paint, box(L, 0.2, 0.08), trs(xc, top - 0.1, s * (W / 2 - 0.04)), col(0x3d4247));
    for (let x = x0 + 0.5; x < x1 - 0.2; x += 1.2) B.add(M.paint, box(0.08, 0.14, 0.05), trs(x, top - 0.12, s * (W / 2 + 0.01)), DARK);
  }
  B.add(M.paint, box(0.1, 0.25, W), trs(x0 + 0.05, top - 0.12, 0), col(0x3d4247));
  B.add(M.paint, box(0.1, 0.25, W), trs(x1 - 0.05, top - 0.12, 0), col(0x3d4247));
  for (let x = x0 + 0.6; x < x1; x += 1.1) B.add(M.paint, box(0.08, 0.18, W - 0.2), trs(x, top - 0.14, 0), DARK);
}

function rearLights(B, M, x, y, W = 2.5) {
  B.add(M.paint, box(0.06, 0.15, W - 0.1), trs(x, y, 0), DARK); // underrun bar
  for (const s of [-1, 1]) {
    B.add(M.plastic, box(0.04, 0.12, 0.3), trs(x - 0.03, y + 0.2, s * (W / 2 - 0.25)), LAMP_R);
    B.add(M.plastic, box(0.04, 0.08, 0.08), trs(x - 0.03, y + 0.2, s * (W / 2 - 0.05)), LAMP_A);
  }
}

// ------------------------------------------------------------ vehicles
// Rigid 8×4 truck with a flat platform. Local origin = overall centre on the
// ground, +x forward. Returns platform extents for load placement.
function rigidTruck(P, M, { len = 10.5, bedY = 1.4, color = col(0xe9e9e4), crane = false } = {}) {
  const B = new MeshBatch();
  const front = len / 2, rear = -len / 2;
  const cabL = 2.35, cabBack = front - cabL;
  const r = 0.52;
  chassis(B, M, rear + 0.1, front - 0.3);
  cab(B, M, cabBack, 1.05, cabL, 2.05, 2.5, color, false);
  const bed0 = rear, bed1 = cabBack - (crane ? 1.0 : 0.15);
  platform(B, M, bed0, bed1, bedY);
  if (crane) { // folded loader crane behind the cab (visual only)
    B.add(M.paintVeh, box(0.7, 1.3, 1.2), trs(cabBack - 0.5, bedY + 0.2, 0), color);
    B.add(M.paintVeh, box(0.35, 0.35, 2.3), trs(cabBack - 0.5, bedY + 1.0, 0), color);
  }
  B.add(M.paint, box(0.08, 1.0, 2.4), trs(bed1 + 0.02, bedY + 0.5, 0), col(0x3d4247)); // headboard
  for (const s of [-1, 1]) {
    wheel(B, M, front - 1.45, r, s * 1.02, r, 0.32);
    wheel(B, M, front - 3.2, r, s * 1.02, r, 0.32);
    wheel(B, M, rear + 2.95, r, s * 0.93, r, 0.3, true);
    wheel(B, M, rear + 1.6, r, s * 0.93, r, 0.3, true);
    mudguard(B, M, rear + 2.28, 1.14, s * 0.95, 2.4, 0.66);
    mudguard(B, M, front - 2.3, 1.14, s * 1.02, 2.8, 0.4);
    B.add(M.paint, box(2.0, 0.06, 0.04), trs(front - 5.0, 0.75, s * 1.2), col(0x8d9296)); // side guard
  }
  const tank = cyl(0.3, 0.3, 0.9, 14);
  tank.rotateZ(Math.PI / 2);
  B.add(M.steel, tank, trs(front - 4.4, 0.75, -0.95), col(0xa9adb0));
  rearLights(B, M, rear + 0.05, 0.6);
  B.build(P.root);
  P.box(front - cabL / 2, 1.6, 0, cabL / 2, 1.6, 1.25);
  P.box((bed0 + bed1) / 2, (bedY + 0.55) / 2, 0, (bed1 - bed0) / 2, (bedY - 0.55) / 2, 1.25);
  P.box(bed1 + 0.02, bedY + 0.5, 0, 0.06, 0.5, 1.2); // headboard
  P.info.bedY = bedY;
  P.info.bed = [bed0, bed1];
}

// 6×4 tractor unit (fifth wheel at local x −1.2), local origin = its centre
function tractor(B, M, ox, color) {
  const r = 0.52, front = ox + 3.2;
  chassis(B, M, ox - 3.1, front - 0.3);
  cab(B, M, front - 2.3, 1.05, 2.3, 2.1, 2.5, color, true);
  B.add(M.steel, cyl(0.55, 0.55, 0.12, 20), trs(ox - 1.2, 1.18, 0), col(0x5a5f64)); // fifth wheel
  for (const s of [-1, 1]) {
    wheel(B, M, front - 1.4, r, s * 1.02, r, 0.32);
    wheel(B, M, ox - 0.9, r, s * 0.93, r, 0.3, true);
    wheel(B, M, ox - 2.25, r, s * 0.93, r, 0.3, true);
    mudguard(B, M, ox - 1.58, 1.14, s * 0.95, 2.4, 0.66);
  }
  const tank = cyl(0.32, 0.32, 1.2, 14);
  tank.rotateZ(Math.PI / 2);
  B.add(M.steel, tank, trs(front - 3.2, 0.72, 0.98), col(0xa9adb0));
  B.add(M.paint, box(0.5, 0.6, 0.5), trs(front - 3.1, 0.8, -1.0), DARK); // batteries / air tanks
}

// Semi-trailer + tractor. Local origin = trailer centre. kinds:
//   flat (13.6 m, deck 1.45), lowloader (gooseneck + deck 0.9 on small
//   pendle wheels), aframe (low deck 1.0 with a central A-frame rack)
function semi(P, M, { kind = 'flat', color = col(0x1f4f8f) } = {}) {
  const B = new MeshBatch();
  const Lt = kind === 'flat' ? 13.6 : kind === 'lowloader' ? 13.0 : 10.0;
  const front = Lt / 2, rear = -Lt / 2;
  // tractor centre so its fifth wheel (tractor x −1.2) sits under the
  // kingpin, 1.2 m behind the trailer front
  const tx = front;
  tractor(B, M, tx, color);
  let deckY, deck0, deck1;
  if (kind === 'flat') {
    deckY = 1.45; deck0 = rear; deck1 = front;
    platform(B, M, deck0, deck1, deckY);
    for (const s of [-1, 1]) for (const x of [rear + 1.4, rear + 2.7, rear + 4.0]) wheel(B, M, x, 0.5, s * 0.93, 0.5, 0.3, true);
    for (const s of [-1, 1]) B.add(M.paint, box(Lt - 5, 0.3, 0.12), trs(front - (Lt - 5) / 2, 1.1, s * 0.5), DARK);
    for (const s of [-1, 1]) B.add(M.paint, box(0.1, 0.9, 0.1), trs(front - 2.8, 0.55, s * 0.6), DARK); // landing legs
    rearLights(B, M, rear + 0.05, 0.7);
  } else if (kind === 'lowloader') {
    deckY = 0.9; deck0 = rear; deck1 = front - 3.0;
    // gooseneck over the tractor
    B.add(M.paintVeh, box(3.0, 0.35, 2.5), trs(front - 1.5, 1.45, 0), color);
    B.add(M.paintVeh, prism([[0, 0], [0.6, 0], [0.6, 0.62], [0, 0.3]].map(([a, b]) => [deck1 + a, deckY - 0.15 + b]), 2.5), null, color);
    platform(B, M, deck0, deck1, deckY);
    for (const s of [-1, 1]) {
      B.add(M.paintVeh, box(deck1 - deck0, 0.4, 0.14), trs((deck0 + deck1) / 2, deckY - 0.3, s * 1.1), color); // outer beams
      for (const x of [rear + 0.9, rear + 1.9, rear + 2.9]) wheel(B, M, x, 0.37, s * 0.95, 0.37, 0.24, true);
    }
    rearLights(B, M, rear + 0.05, 0.55);
  } else { // aframe
    deckY = 1.0; deck0 = rear; deck1 = front - 0.4;
    platform(B, M, deck0, deck1, deckY);
    B.add(M.paint, box(1.4, 0.4, 2.4), trs(front - 0.7, 1.35, 0), DARK); // gooseneck
    for (const s of [-1, 1]) for (const x of [rear + 1.2, rear + 2.4]) wheel(B, M, x, 0.45, s * 0.95, 0.45, 0.28, true);
    // A-frame: inclined posts both sides of the spine, top rail, stays
    const aH = 2.3, lean = 0.28;
    for (let x = rear + 0.8; x <= deck1 - 0.4; x += 2.0) {
      for (const s of [-1, 1]) B.add(M.paint, box(0.1, Math.hypot(aH, lean), 0.1), trs(x, deckY + aH / 2, s * lean / 2, 0, -s * Math.atan2(lean, aH), 0), col(0x2f6db3));
    }
    B.add(M.paint, box(deck1 - rear - 1.2, 0.12, 0.12), trs((rear + 0.8 + deck1 - 0.4) / 2, deckY + aH, 0), col(0x2f6db3));
    for (const s of [-1, 1]) B.add(M.paint, box(deck1 - rear - 1.2, 0.1, 0.1), trs((rear + 0.8 + deck1 - 0.4) / 2, deckY + 0.08, s * 0.3), col(0x2f6db3)); // kick rails at the spine foot
    rearLights(B, M, rear + 0.05, 0.6);
    P.info.aFrame = { lean, aH };
  }
  B.build(P.root);
  // colliders: tractor cab + chassis, trailer deck (+ gooseneck / A-frame spine)
  P.box(tx + 2.05, 1.6, 0, 1.15, 1.6, 1.25);
  P.box(tx - 0.9, 0.65, 0, 2.2, 0.65, 1.25);
  P.box((deck0 + deck1) / 2, (deckY + 0.3) / 2, 0, (deck1 - deck0) / 2, (deckY - 0.3) / 2, 1.25);
  if (kind === 'lowloader') P.box(front - 1.5, 1.3, 0, 1.5, 0.35, 1.25);
  if (kind === 'aframe') P.box((rear + 0.8 + deck1 - 0.4) / 2, 1.0 + 1.15, 0, (deck1 - rear - 1.2) / 2, 1.15, 0.12, 0, 'rack');
  P.info.bedY = deckY;
  P.info.bed = [deck0, deck1];
}

// ------------------------------------------------------------ site props
function concreteBlock(B, M, x, y, z, w, h, d) {
  B.add(M.precast, box(w, h, d), trs(x, y, z));
}

function sign(P, key, w, h, x, y, z, yaw, post = true) {
  const O = ownMats();
  const g = O.atlas.quad(key, w, h);
  const m = new THREE.Mesh(g, O.sign);
  m.position.set(x, y, z);
  m.rotation.y = yaw;
  P.root.add(m);
  if (post) {
    const pm = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, h + 0.04, 0.02), O.post);
    pm.position.set(x - Math.sin(yaw) * 0.012, y, z - Math.cos(yaw) * 0.012);
    pm.rotation.y = yaw;
    P.root.add(pm);
  }
}

function groundDecal(P, mat, geo, x, y, z, yaw = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.rotation.set(-Math.PI / 2, 0, yaw);
  m.position.set(x, y, z);
  m.receiveShadow = true;
  m.renderOrder = 1;
  P.root.add(m);
  return m;
}

// painted line A→B on the ground
function stripe(P, mat, ax, az, bx, bz, w = 0.12, y = 0.018) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
  return groundDecal(P, mat, new THREE.PlaneGeometry(len, w), (ax + bx) / 2, y, (az + bz) / 2, Math.atan2(-dz, dx));
}

// thin rectangle outline (ground paint)
function outline(P, mat, cx, cz, w, d, lw = 0.1, y = 0.02, yaw = 0) {
  const g = [];
  for (const s of [-1, 1]) {
    g.push([cx + s * (w / 2 - lw / 2), cz, lw, d]);
    g.push([cx, cz + s * (d / 2 - lw / 2), w, lw]);
  }
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  for (const [x, z, a, b] of g) {
    const dx = x - cx, dz = z - cz;
    groundDecal(P, mat, new THREE.PlaneGeometry(a, b), cx + dx * c + dz * sn, y, cz - dx * sn + dz * c, yaw);
  }
}

// ------------------------------------------------------------ neighbour roof (M2)
let _parcel;
// Flat-roof parcel of the neighbour east of the site that contains (94, −13)
// (planCity(): "modern, 5 floors", roof ≈ 16.4, parapet 0.9). Falls back to the
// spec's numbers if the planner no longer has such a parcel.
export function neighbourRoof() {
  if (_parcel !== undefined) return _parcel;
  _parcel = { x0: 87.5, x1: 100.5, z0: -19.9, z1: -5.9, roofY: 16.4, parapet: 0.9, fallback: true };
  try {
    for (const lot of planCity()) {
      for (const b of lot.buildings || []) {
        if (b.roof !== 'flat' || !(b.x0 <= 94 && b.x1 >= 94 && b.z0 <= -13 && b.z1 >= -13)) continue;
        const roofY = Number.isFinite(b.eave) ? b.eave : (b.floors || 5) * (b.fh || 3.2);
        _parcel = { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, roofY, parapet: b.parapet ?? 0.9, fallback: false };
      }
    }
  } catch { /* planner unavailable: keep the fallback */ }
  return _parcel;
}

// Rooftop plant the city draws on that roof (lift overrun, AHUs, stair
// access): found at runtime from the merged city meshes — every triangle
// wholly above the roof is unioned by shared corners, so each box's top face
// becomes one component → an AABB collider. The parapet band is skipped.
function roofPlant(scene, pc) {
  const out = [];
  if (!scene) return out;
  const v = new THREE.Vector3(), bb = new THREE.Box3();
  const y0 = pc.roofY + 0.05, m = 0.45;
  const inside = (p) => p.x > pc.x0 + m && p.x < pc.x1 - m && p.z > pc.z0 + m && p.z < pc.z1 - m && p.y > y0 && p.y < pc.roofY + 8;
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.attributes.position || String(o.name).startsWith('prop:')) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    bb.copy(g.boundingBox).applyMatrix4(o.matrixWorld);
    if (bb.max.x < pc.x0 || bb.min.x > pc.x1 || bb.max.z < pc.z0 || bb.min.z > pc.z1 || bb.max.y < y0 || bb.min.y > pc.roofY + 8) return;
    const pos = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : pos.count;
    const parent = new Map();
    const find = (k) => { while (parent.get(k) !== k) { const p = parent.get(parent.get(k)); parent.set(k, p); k = p; } return k; };
    const pts = new Map();
    const key = (p) => `${Math.round(p.x * 20)},${Math.round(p.y * 20)},${Math.round(p.z * 20)}`;
    for (let t = 0; t + 2 < n; t += 3) {
      const ks = [];
      let ok = true;
      for (let j = 0; j < 3 && ok; j++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(t + j) : t + j).applyMatrix4(o.matrixWorld);
        if (!inside(v)) ok = false;
        else { const k = key(v); if (!pts.has(k)) { pts.set(k, v.clone()); parent.set(k, k); } ks.push(k); }
      }
      if (!ok) continue;
      const r0 = find(ks[0]);
      for (let j = 1; j < 3; j++) { const r = find(ks[j]); if (r !== r0) parent.set(r, r0); }
    }
    const comps = new Map();
    for (const [k, p] of pts) {
      const r = find(k);
      let c = comps.get(r);
      if (!c) comps.set(r, (c = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, top: -Infinity }));
      c.x0 = Math.min(c.x0, p.x); c.x1 = Math.max(c.x1, p.x);
      c.z0 = Math.min(c.z0, p.z); c.z1 = Math.max(c.z1, p.z);
      c.top = Math.max(c.top, p.y);
    }
    for (const c of comps.values()) {
      if (c.x1 - c.x0 < 0.25 || c.z1 - c.z0 < 0.25) continue;
      // the same box appears once per material mesh (walls / roof): keep one
      if (!out.some((o) => Math.abs(o.x0 - c.x0) + Math.abs(o.x1 - c.x1) + Math.abs(o.z0 - c.z0) + Math.abs(o.z1 - c.z1) < 0.2)) out.push(c);
      else for (const o of out) if (Math.abs(o.x0 - c.x0) + Math.abs(o.x1 - c.x1) + Math.abs(o.z0 - c.z0) + Math.abs(o.z1 - c.z1) < 0.2) o.top = Math.max(o.top, c.top);
    }
  });
  return out;
}

// ------------------------------------------------------------ prop builders
const BUILDERS = {
  // Rigid 8×4 ballast truck with CW slabs (§6.6). opts {x, z, yaw, arrive (s)}
  // info.slot(id) → world {x, z, y} for slab A/B/C on the platform.
  ballastTruck(P, o, J, M) {
    rigidTruck(P, M, { len: 10.5, bedY: 1.4, color: col(0xf0b400), crane: false });
    const slots = { A: 1.3, B: -1.1, C: -3.5 };
    P.info.slot = (id) => { const w = P.toWorld(slots[id] ?? 0, 0); return { x: w.x, z: w.z, y: P.info.bedY }; };
    if (o.arrive) arrive(P, o, o.arrive);
  },
  // Rigid flatbed truck with a folded loader crane (HVAC, transformer)
  flatTruck(P, o, J, M) {
    rigidTruck(P, M, { len: 10.0, bedY: 1.3, color: col(o.color ?? 0xe9e9e4), crane: true });
    P.info.at = (lx) => { const w = P.toWorld(lx, 0); return { x: w.x, z: w.z, y: P.info.bedY }; };
  },
  semiFlat(P, o, J, M) { semi(P, M, { kind: 'flat', color: col(o.color ?? 0x1f4f8f) }); },
  lowLoader(P, o, J, M) { semi(P, M, { kind: 'lowloader', color: col(o.color ?? 0xb3261e) }); },
  aFrameTrailer(P, o, J, M) { semi(P, M, { kind: 'aframe', color: col(o.color ?? 0x2d6a3e) }); },

  // M2 neighbour roof: roof slab collider, parapets, curb (+ fallback building)
  neighbourRoof(P, o, J, M) {
    const pc = neighbourRoof();
    const B = new MeshBatch();
    const cx = (pc.x0 + pc.x1) / 2, cz = (pc.z0 + pc.z1) / 2, hx = (pc.x1 - pc.x0) / 2, hz = (pc.z1 - pc.z0) / 2;
    const top = pc.roofY, par = pc.parapet;
    if (pc.fallback) { // job-owned stand-in building
      B.add(M.concCore, box(hx * 2, top, hz * 2), trs(cx, top / 2, cz));
      for (const s of [-1, 1]) {
        B.add(M.paint, box(hx * 2 + 0.02, 0.25, 0.25), trs(cx, top + par - 0.12, cz + s * (hz - 0.125)), col(0xbfc2c4));
        B.add(M.paint, box(0.25, 0.25, hz * 2), trs(cx + s * (hx - 0.125), top + par - 0.12, cz), col(0xbfc2c4));
      }
    }
    // the building itself (roof top), parapets 0.25 × 0.9 m
    P.box(cx, top / 2, cz, hx, top / 2, hz, 0, 'building');
    for (const s of [-1, 1]) {
      P.box(cx, top + par / 2, cz + s * (hz - 0.125), hx, par / 2, 0.125, 0, 'parapet');
      P.box(cx + s * (hx - 0.125), top + par / 2, cz, 0.125, par / 2, hz, 0, 'parapet');
    }
    // rooftop plant already drawn by the city → colliders; pick a clear curb spot
    const plant = pc.fallback ? [] : roofPlant(J?.sim?.scene, pc);
    for (const c of plant) P.box((c.x0 + c.x1) / 2, (top + c.top) / 2, (c.z0 + c.z1) / 2, (c.x1 - c.x0) / 2, (c.top - top) / 2, (c.z1 - c.z0) / 2, 0, 'roofplant');
    // curb candidates: the spec's spot first (93, −13, along x), then clear
    // spots on the same roof (the city's lift overrun sits on the spec spot).
    // Phase 2: the next clear spot is between the west parapet and the overrun
    // (R 32.4 m). The earlier fallback at R 39.3 m could not be served at all: with
    // the 45 m boom the head is only 21.7 m up there, so the unit's bottom cannot
    // rise above 12.8 m, below the 16.7 m curb. The R ≈ 36 m spots are blocked by
    // the rooftop plant the city draws.
    const cands = o.curbs || [[93.0, -13.0, 0], [89.4, -11.9, Math.PI / 2], [92.5, -8.6, 0], [92.5, -17.2, 0], [96.3, -12.4, Math.PI / 2]];
    const clear = ([x, z, yaw]) => {
      const ax = yaw ? 1.2 : 2.2, az = yaw ? 2.2 : 1.2, mg = 0.45; // unit half-extents + margin
      if (x - ax < pc.x0 + 0.3 || x + ax > pc.x1 - 0.3 || z - az < pc.z0 + 0.3 || z + az > pc.z1 - 0.3) return false;
      return plant.every((c) => x + ax + mg < c.x0 || x - ax - mg > c.x1 || z + az + mg < c.z0 || z - az - mg > c.z1);
    };
    const [ux, uz, uyaw] = cands.find(clear) || cands[0];
    // curb: galvanised upstand frame 0.3 m on the membrane, sized for the unit
    const cw = 4.0, cd = 2.0, ch = 0.3;
    B.within(trs(ux, top, uz, uyaw), () => {
      for (const s of [-1, 1]) {
        B.add(M.galv, box(cw, ch, 0.12), trs(0, ch / 2, s * (cd / 2 - 0.06)));
        B.add(M.galv, box(0.12, ch, cd - 0.24), trs(s * (cw / 2 - 0.06), ch / 2, 0));
      }
      B.add(M.plastic, box(cw - 0.3, 0.02, cd - 0.3), trs(0, 0.01, 0), col(0x202224)); // duct opening
    });
    P.box(ux, top + ch / 2, uz, uyaw ? cd / 2 : cw / 2, ch / 2, uyaw ? cw / 2 : cd / 2, 0, 'curb');
    B.build(P.root);
    P.info = { ...P.info, parcel: pc, curb: { x: ux, y: top + ch, z: uz, yaw: uyaw }, roofY: top, parapetTop: top + par, plant };
  },

  // M3 generator plinth (0.3 m, anti-vibration pads, duct stubs)
  generatorPlinth(P, o, J, M) {
    const B = new MeshBatch();
    const top = o.top ?? 0.3, w = 6.6, d = 3.0;
    concreteBlock(B, M, 0, top / 2, 0, w, top, d);
    for (const x of [-2.6, -0.9, 0.9, 2.6]) for (const s of [-1, 1]) B.add(M.rubber, box(0.25, 0.02, 0.25), trs(x, top + 0.01, s * 1.0), col(0x151515));
    for (const z of [-0.5, 0.5]) B.add(M.plastic, cyl(0.07, 0.07, 0.25, 12), trs(-3.4, 0.12, z), col(0xe86a12));
    B.build(P.root);
    P.box(0, top / 2, 0, w / 2, top / 2, d / 2, 0, 'plinth');
    P.info.top = top;
  },

  // M4 precast storage rack: timber bearers, end frames with slot dividers
  // opts {x, z, slots:[x…], len: 4}. Panels stand along z in the slots.
  precastRack(P, o, J, M) {
    const B = new MeshBatch();
    const slots = o.slots || [-0.5, 0, 0.5];
    const xs0 = Math.min(...slots) - 0.5, xs1 = Math.max(...slots) + 0.5;
    const half = (o.len ?? 4.0) / 2 + 0.35;
    const BLUE = col(0x2f6db3);
    for (const z of [-1.5, 1.5]) {
      B.add(M.wood, box(xs1 - xs0, 0.1, 0.2), trs((xs0 + xs1) / 2, 0.05, z), col(0x8a6a48));
      P.box((xs0 + xs1) / 2, 0.05, z, (xs1 - xs0) / 2, 0.05, 0.1, 0, 'bearer');
    }
    for (const s of [-1, 1]) {
      const z = s * half;
      B.add(M.paint, box(xs1 - xs0 + 0.2, 0.14, 0.14), trs((xs0 + xs1) / 2, 0.07, z), BLUE);
      B.add(M.paint, box(xs1 - xs0 + 0.2, 0.1, 0.1), trs((xs0 + xs1) / 2, 1.85, z), BLUE);
      for (let i = 0; i <= slots.length; i++) {
        const x = i === 0 ? slots[0] - 0.25 : slots[i - 1] + 0.25;
        B.add(M.paint, box(0.1, 1.8, 0.1), trs(x, 0.9, z), BLUE);
        P.box(x, 0.9, z, 0.05, 0.9, 0.05, 0, 'rack');
      }
      B.add(M.paint, box(0.1, 0.1, 1.2), trs(xs0 - 0.05, 0.9, z - s * 0.55), BLUE); // stays
      B.add(M.paint, box(0.1, 0.1, 1.2), trs(xs1 + 0.05, 0.9, z - s * 0.55), BLUE);
    }
    B.build(P.root);
    P.info.slots = slots;
  },

  // M6 neighbour substation: plinth on the lot (y 0.15), bollards, sign
  substationPlinth(P, o, J, M) {
    const B = new MeshBatch();
    const base = o.base ?? 0.15, top = o.top ?? 0.6, w = 3.0, d = 2.6;
    concreteBlock(B, M, 0, (base + top) / 2 - 0.05, 0, w, top - base + 0.1, d);
    for (const x of [-1.0, 0, 1.0]) B.add(M.plastic, cyl(0.08, 0.08, 0.2, 12), trs(x, top - 0.02, 1.1), col(0x1a1a1a)); // cable ducts
    for (const [x, z] of [[-2.3, -2.2], [2.3, -2.2], [-2.3, 2.2], [2.3, 2.2]]) {
      B.add(M.paint, cyl(0.08, 0.08, 1.0, 12), trs(x, base + 0.5, z), col(0xf0b400));
      B.add(M.paint, cyl(0.082, 0.082, 0.1, 12), trs(x, base + 0.8, z), col(0x151515));
      P.box(x, base + 0.5, z, 0.08, 0.5, 0.08, 0, 'bollard');
    }
    B.add(M.galv, box(0.08, 1.9, 0.08), trs(2.6, base + 0.95, 0));
    B.build(P.root);
    sign(P, 'sub', 0.9, 0.52, 2.6, base + 1.55, 0.05, Math.PI / 2);
    P.box(0, (base + top) / 2, 0, w / 2, (top - base) / 2, d / 2, 0, 'plinth');
    P.info.top = top;
  },

  // M6 cable-trench barriers (spec: Box(60.9, 0.5, z, 0.5, 0.5, 1.5) each)
  cableBarriers(P, o, J, M) {
    const B = new MeshBatch();
    const zs = o.zs || [-16.5, -13.5, -10.5, -7.5];
    for (const z of zs) {
      B.add(M.precast, box(1.0, 0.85, 2.96), trs(0, 0.425, z));
      B.add(M.precast, box(0.7, 0.15, 2.9), trs(0, 0.925, z));
      for (const s of [-1, 1]) B.add(M.paint, box(0.01, 0.12, 2.9), trs(s * 0.505, 0.7, z), col(0xd21f1a));
      P.box(0, 0.5, z, 0.5, 0.5, 1.5, 0, 'barrier');
    }
    B.build(P.root);
    // red/white tape stripes read at a distance: sign boards on the site side
    sign(P, 'cable', 0.8, 0.4, -0.52, 0.6, zs[1], -Math.PI / 2, false);
    sign(P, 'cable', 0.8, 0.4, -0.52, 0.6, zs[3], -Math.PI / 2, false);
  },

  // Lay-down area: painted outline, stencil, timber bearers along x
  laydown(P, o, J, M) {
    const O = ownMats();
    const w = o.w ?? 9, d = o.d ?? 3.4;
    outline(P, O.lineWhite, 0, 0, w, d, 0.12, 0.02);
    if (o.label) groundDecal(P, O.stencil, O.atlas.quad(o.label, 2.4, 0.72), 0, 0.022, d / 2 + 0.6, 0);
    const B = new MeshBatch();
    for (const [x, z, len] of o.bearers || []) { // timber bearers laid along x
      B.add(M.wood, box(len, 0.1, 0.15), trs(x, 0.05, z), col(0x8a6a48));
      P.box(x, 0.05, z, len / 2, 0.05, 0.075, 0, 'bearer');
    }
    B.build(P.root);
  },
};

// the M5 ballast truck drives in: 16 m approach, decelerating to a stop
function arrive(P, o, seconds) {
  const T = Math.max(1, seconds), dist = o.from ?? 26;
  const fx = Math.cos(o.yaw ?? 0), fz = -Math.sin(o.yaw ?? 0); // forward (world)
  const x1 = o.x, z1 = o.z;
  let t = 0;
  P._placedByAnim = true;
  P.update = (dt) => {
    if (t >= T) return;
    t = Math.min(T, t + dt);
    const u = t / T, s = 1 - (1 - u) * (1 - u); // ease-out
    const back = dist * (1 - s);
    P.place(x1 - fx * back, z1 - fz * back);
  };
  P.update(0);
}

// ------------------------------------------------------------ entry
/**
 * Build a job prop. opts: {x, z, yaw} placement plus builder-specific fields.
 * J: the JobRunner (for sim.scene / site materials); may be null for tests.
 */
export function buildProp(name, opts = {}, J = null) {
  const fn = BUILDERS[name];
  if (!fn) throw new Error(`unknown job prop '${name}'`);
  const P = new Prop(name);
  P.x = opts.x ?? 0; P.z = opts.z ?? 0; P.yaw = opts.yaw ?? 0;
  const M = siteMats(J?.sim?.site);
  fn(P, opts, J, M);
  if (!P._placedByAnim) P.place(P.x, P.z, P.yaw);
  return P;
}

export const PROP_NAMES = Object.keys(BUILDERS);

// ------------------------------------------------------------ P1 markings
let _p1 = null;
/**
 * Permanent pad markings for P1 (§8.2): hardcore surface, painted X at the
 * slew-axis target, carrier outline with heading arrow, float squares for the
 * full and half base, "P1" stencil and the pad sign. Idempotent.
 */
export function ensureP1Markings(scene, site = null) {
  if (_p1 && _p1.parent === scene) return _p1;
  const M = siteMats(site), O = ownMats();
  const P = new Prop('p1');
  const g = P.root;
  g.name = 'P1-markings';
  // prepared hardcore: crushed stone laid over the site fill
  const hard = M.gravel ? M.gravel.clone() : new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.95 });
  hard.polygonOffset = true; hard.polygonOffsetFactor = -2; hard.polygonOffsetUnits = -2;
  const pw = 13, pd = 17;
  groundDecal(P, hard, plane(pw, pd), (50.5 + 63.5) / 2, 0.008, (-19.5 - 2.5) / 2);
  // X at the slew-axis target (spray paint)
  for (const s of [-1, 1]) stripe(P, O.lineYellow, P1.x - 0.95, P1.z - s * 0.95, P1.x + 0.95, P1.z + s * 0.95, 0.14, 0.018);
  // carrier outline (x_c −3.70 … +7.75, ±1.375) and a heading chevron
  const cw = (xc, yc) => carrierToWorld(P1, P1.yaw, xc, yc);
  const corners = [cw(7.75, 1.375), cw(7.75, -1.375), cw(-3.7, -1.375), cw(-3.7, 1.375)];
  for (let i = 0; i < 4; i++) { const a = corners[i], b = corners[(i + 1) % 4]; stripe(P, O.lineWhite, a.x, a.z, b.x, b.z, 0.08, 0.016); }
  const tip = cw(9.2, 0);
  for (const s of [-1, 1]) { const c = cw(8.3, s * 0.8); stripe(P, O.lineWhite, tip.x, tip.z, c.x, c.z, 0.12, 0.017); }
  // float squares: full base (solid, mat-sized) and half base (smaller)
  for (const f of FLOATS) {
    for (const [pct, size, mat] of [[100, 1.9, O.lineYellow], [50, 1.2, O.lineWhite]]) {
      const w = carrierToWorld(P1, P1.yaw, f.x, f.side * BASES[pct]);
      outline(P, mat, w.x, w.z, size, size, 0.09, 0.019);
    }
  }
  // "P1" stencil readable when arriving from the south (heading +z)
  groundDecal(P, O.stencil, O.atlas.quad('p1g', 2.0, 1.0), P1.x, 0.02, -18.6, Math.PI);
  sign(P, 'p1', 1.6, 0.69, 64.6, 1.25, -3.0, -Math.PI / 2);
  const postGeo = new THREE.BoxGeometry(0.06, 1.3, 0.06);
  for (const dz of [-0.6, 0.6]) { const p = new THREE.Mesh(postGeo, O.post); p.position.set(64.66, 0.65, -3.0 + dz); g.add(p); }
  g.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; } });
  scene.add(g);
  _p1 = g;
  return g;
}

// shared prop materials (sign atlas, ground paint) for other job visuals
export { ownMats as propMaterials };
