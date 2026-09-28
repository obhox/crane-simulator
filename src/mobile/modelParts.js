import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Kit, mBox, mCyl, mTorus, mExtrude, boltGeo, sweepGeo, prep, Atlas, fitText, grunge, WEAR_JOINT, WEAR_LIGHT, TAU } from '../crane/kit.js';
import { rng } from '../util/math.js';
import { AT100, CW_SLAB_SIZE, MATS, HOOK_BLOCKS, HOOK_BLOCK_HB100 } from './config.js';

// Building blocks for the AT-100 5.1 model (src/mobile/model.js) and its hook
// blocks (src/mobile/hookBlocks.js): the extra materials the mobile needs on
// top of the tower's createCraneMaterials() set (which is shared and never
// modified here), the mobile decal atlas, two draw-call savers (ProxyInstancer,
// LodKit) and the geometry of the repeated / self-contained parts (wheels,
// outrigger beams, floats, mats, counterweight slabs, both cabs).
//
// Frames: carrier-local three.js space (+X forward, +Y up, +Z right = −y_c),
// see docs/mobile-crane-spec.md §0. Everything is in metres, UVs in metres
// (kit.js primitives) so the tiled paint scan keeps its real-world scale.

export const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Paint wear on large painted plates: a light joint-grime film but no rust
// streaks (kit.js WEAR_JOINT is for small fittings; on big plates it reads as
// wood grain). A rental AT crane is kept far cleaner than a tower crane.
export const WEAR_PLATE = [0.55, 0.55, 0.35];
const UP = V(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// ------------------------------------------------------------------ materials
// Mobile-only materials, derived once per tower material set (cached). The
// tower set is only read (its 'amber' / 'lamp' / 'decal' are driven by the
// tower, so the mobile gets its own beacon, lamp and decal materials).
const matCache = new WeakMap();
let lastMats = null;

export function mobileMaterials(mats) {
  if (!mats) throw new Error('mobileMaterials(mats): pass the tower material set (ctx.craneMats)');
  let M = matCache.get(mats);
  if (M) return M;
  const atlas = mobileAtlas();
  const lamp = lampTextures();
  M = {
    ...mats,
    // hard-chromed piston rods: nearly mirror-like, the environment does the work
    // (kept below white: a bright sky in a near-mirror otherwise reads as a white pipe)
    chrome: new THREE.MeshStandardMaterial({ color: 0x9aa1a8, metalness: 1, roughness: 0.2, envMapIntensity: 0.9 }),
    // 385/95 R25 crane tyres: sidewall lettering + dusty tread from a canvas
    tyre: new THREE.MeshStandardMaterial({ map: tyreTexture(), color: 0xffffff, roughness: 0.92, metalness: 0 }),
    // rotating amber beacons (flash pattern set by model.setLights)
    beacon: new THREE.MeshStandardMaterial({ color: 0xff8a00, emissive: 0xff6a00, emissiveIntensity: 0.05, roughness: 0.25, transparent: true, opacity: 0.88 }),
    // all lamp lenses (head / tail / indicator / work LED) in one material:
    // colour and emission come from a 4-swatch atlas, UVs pick the swatch
    lamps: new THREE.MeshStandardMaterial({ map: lamp.map, emissiveMap: lamp.emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.18, metalness: 0 }),
    mdecal: new THREE.MeshStandardMaterial({
      map: atlas.texture(), alphaTest: 0.45, roughness: 0.62, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };
  M.chrome.name = 'mobileChrome';
  M.tyre.name = 'mobileTyre';
  M.beacon.name = 'mobileBeacon';
  M.lamps.name = 'mobileLamps';
  M.mdecal.name = 'mobileDecal';
  M.mdecal.userData.atlas = atlas;
  matCache.set(mats, M);
  lastMats = mats;
  return M;
}
/** the tower material set last passed to mobileMaterials() (hook blocks default to it) */
export const lastMaterialSet = () => lastMats;

// Lamp swatches: [u centre] of each 32-px swatch in the 128-px lamp atlas
export const LAMP_UV = { white: 0.125, red: 0.375, amber: 0.625, work: 0.875 };
function lampTextures() {
  const mk = (cols) => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 32;
    const x = c.getContext('2d');
    cols.forEach((col, i) => {
      const g = x.createRadialGradient(i * 32 + 16, 16, 2, i * 32 + 16, 16, 22);
      g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
      x.fillStyle = g; x.fillRect(i * 32, 0, 32, 32);
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    // lens colour when off (clear glass reads light grey, tail lamps dark red)
    map: mk([['#f4f6f8', '#b9c0c6'], ['#b0140c', '#5a0704'], ['#ff9a1a', '#b85a00'], ['#f2f6f8', '#aab2b8']]),
    // emission when lit: warm-white halogen, red, amber, cold-white LED
    emissive: mk([['#fffaf0', '#fff1d8'], ['#ff2a12', '#d80c04'], ['#ffa21a', '#ff7a00'], ['#ffffff', '#eef4ff']]),
  };
}

// 385/95 R25: canvas mapped by the tyre lathe (u around, v across the
// section: 0 outer bead → 0.30 outer shoulder, 0.35–0.65 tread, 0.70 → 1
// inner sidewall; see tyreGeometry). Lettering on the outer sidewall only.
function tyreTexture() {
  const W = 2048, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#1b1b1c'; x.fillRect(0, 0, W, H);
  // tread band: lighter, dusty rubber (flipY: v = 1 − y/H)
  const y0 = (1 - 0.66) * H, y1 = (1 - 0.34) * H;
  x.fillStyle = '#272625'; x.fillRect(0, y0, W, y1 - y0);
  grunge(x, W, y1 - y0, 17, 0.9, 'rgba(120,108,92,');
  // outer sidewall: moulded lettering (slightly lighter, low contrast) at r ≈ 0.50 m
  const r = rng(5);
  for (let i = 0; i < 2600; i++) {
    x.fillStyle = `rgba(70,68,64,${(0.05 + r() * 0.08).toFixed(3)})`;
    x.fillRect(r() * W, H * (1 - 0.3) + r() * H * 0.3, 2 + r() * 6, 1 + r() * 2);
  }
  x.save();
  x.fillStyle = '#3b3a39';
  x.textBaseline = 'middle';
  const vText = 0.14, vSmall = 0.2;
  // letters are drawn squashed: 1 px of u ≈ 1.5 mm, 1 px of v ≈ 3 mm on the sidewall
  for (let k = 0; k < 2; k++) {
    x.setTransform(1, 0, 0, 0.5, k * W / 2, (1 - vText) * H);
    x.font = 'bold 46px Arial, Helvetica, sans-serif';
    x.fillText('385/95 R25   170F   ALL-TERRAIN CRANE', 40, 0);
    x.setTransform(1, 0, 0, 0.45, k * W / 2, (1 - vSmall) * H);
    x.font = 'bold 26px Arial, Helvetica, sans-serif';
    x.fillText('TUBELESS  ·  RADIAL  ·  E-2  ·  MAX LOAD 6700 kg AT 900 kPa', 90, 0);
  }
  x.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------ decals
function mobileAtlas() {
  const A = new Atlas(1024, 1024);
  const sans = 'Arial, Helvetica, sans-serif';
  const stencil = 'Impact, "Arial Narrow", Arial, sans-serif';
  // model word mark (generic livery: black on the yellow paint)
  A.add('wordmark', 1000, 140, (c, w, h) => {
    c.fillStyle = '#141414'; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.font = `900 132px ${sans}`;
    const wa = Math.min(c.measureText('AT-100').width, w * 0.66);
    fitText(c, 'AT-100', 10, h * 0.54, w * 0.66, 132, sans, '900');
    c.fillRect(wa + 40, h * 0.2, 8, h * 0.64);
    fitText(c, '5.1', wa + 72, h * 0.54, w - wa - 80, 118, sans, '900');
    c.globalCompositeOperation = 'destination-out';
    grunge(c, w, h, 21, 1.1, 'rgba(0,0,0,');
    c.globalCompositeOperation = 'source-over';
  });
  // red / white warning stripes (beam ends, boom head, under-run bar)
  A.add('stripes', 256, 64, (c, w, h) => {
    c.fillStyle = '#f1f0ea'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#c8190f';
    for (let i = -h; i < w + h; i += 48) { c.beginPath(); c.moveTo(i, h); c.lineTo(i + 24, h); c.lineTo(i + 24 + h, 0); c.lineTo(i + h, 0); c.fill(); }
    grunge(c, w, h, 31, 0.7);
  });
  // beam extension scale: painted marks that line up with the box end at 50 / 100 %
  A.add('pct', 512, 48, (c, w, h) => {
    c.fillStyle = '#141414';
    c.font = `900 30px ${sans}`; c.textBaseline = 'middle'; c.textAlign = 'center';
    for (const [f, t] of [[BEAM_MARK_50 / BEAM_LEN, '50%'], [BEAM_MARK_100 / BEAM_LEN, '100%']]) {
      const x = f * w;
      c.fillRect(x - 3, 0, 6, h);
      c.fillText(t, x + (t === '50%' ? -40 : -52), h / 2 + 1);
    }
    c.globalCompositeOperation = 'destination-out';
    grunge(c, w, h, 41, 1.0, 'rgba(0,0,0,');
    c.globalCompositeOperation = 'source-over';
  });
  A.add('plate', 256, 150, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#c9ccce'); g.addColorStop(0.5, '#a9adb1'); g.addColorStop(1, '#c2c5c8');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#333'; c.lineWidth = 3; c.strokeRect(8, 8, w - 16, h - 16);
    c.fillStyle = '#1a1a1a'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.font = `900 28px ${sans}`; c.fillText('AT-100 5.1', 20, 40);
    c.font = `bold 14px ${sans}`;
    ['ALL-TERRAIN CRANE  EN 13000', 'SERIAL No  51-0212', 'MAX LOAD 100 000 kg', 'CW 35 t   BASE 7.37 x 7.0 m'].forEach((s, i) => c.fillText(s, 20, 64 + i * 19));
  });
  // load-chart booklet page (cab wall): generic grid, the RCL is the authority
  A.add('chart', 256, 180, (c, w, h) => {
    c.fillStyle = '#f1f1ee'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#1d4fa8'; c.fillRect(0, 0, w, 24);
    c.fillStyle = '#fff'; c.font = `bold 14px ${sans}`; c.textAlign = 'center'; c.fillText('LOAD CHART  AT-100 5.1  360°', w / 2, 17);
    c.strokeStyle = '#8a8f96'; c.lineWidth = 1;
    for (let i = 0; i < 9; i++) { c.beginPath(); c.moveTo(10, 36 + i * 16); c.lineTo(w - 10, 36 + i * 16); c.stroke(); }
    for (let j = 0; j < 7; j++) { c.beginPath(); c.moveTo(10 + j * 39, 30); c.lineTo(10 + j * 39, h - 10); c.stroke(); }
    c.fillStyle = '#333'; c.font = `9px ${sans}`;
    const r = rng(9);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 6; j++) c.fillText((r() * 60 + 3).toFixed(1), 30 + j * 39, 48 + i * 16);
  });
  for (const [k, t] of [['swl8.8', '8.8 t'], ['swl26', '26 t'], ['swl60', '60 t'], ['swl90', '90 t'], ['swl100', '100 t']]) {
    A.add(k, 200, 90, (c, w, h) => {
      c.fillStyle = '#f2b705'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#111'; c.lineWidth = 7; c.strokeRect(4, 4, w - 8, h - 8);
      c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
      fitText(c, t, w / 2, h / 2 + 2, w - 30, 58, sans, '900');
      grunge(c, w, h, 7, 0.6);
    });
  }
  for (const [k, t] of [['cw11.5', '11.5 t'], ['cw12.0', '12.0 t']]) {
    A.add(k, 256, 100, (c, w, h) => {
      c.fillStyle = '#121212'; c.textAlign = 'center'; c.textBaseline = 'middle';
      fitText(c, t, w / 2, h / 2, w - 16, 86, stencil, 'normal');
      c.globalCompositeOperation = 'destination-out';
      c.fillRect(0, h * 0.48, w, 4);
      grunge(c, w, h, 12, 1.4, 'rgba(0,0,0,');
      c.globalCompositeOperation = 'source-over';
    });
  }
  A.add('grille', 128, 128, (c, w, h) => {
    c.fillStyle = '#1b1c1e'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#6d7075'; c.lineWidth = 3;
    for (let r = 10; r < 64; r += 9) { c.beginPath(); c.arc(w / 2, h / 2, r, 0, TAU); c.stroke(); }
    c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.stroke();
  });
  A.add('louvre', 128, 96, (c, w, h) => {
    c.fillStyle = '#23252a'; c.fillRect(0, 0, w, h);
    for (let y = 6; y < h - 6; y += 10) { c.fillStyle = '#0b0c0d'; c.fillRect(6, y, w - 12, 5); c.fillStyle = '#5a5e63'; c.fillRect(6, y + 5, w - 12, 2); }
  });
  A.add('mesh', 128, 64, (c, w, h) => {
    c.fillStyle = '#16171a'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#4b4f55'; c.lineWidth = 2;
    for (let i = -h; i < w; i += 8) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + h, h); c.moveTo(i + h, 0); c.lineTo(i, h); c.stroke(); }
  });
  // driver's dashboard: two dials, a centre display and warning lamps
  A.add('dash', 256, 96, (c, w, h) => {
    c.fillStyle = '#121315'; c.fillRect(0, 0, w, h);
    for (const cx of [48, w - 48]) {
      c.fillStyle = '#050506'; c.beginPath(); c.arc(cx, 50, 34, 0, TAU); c.fill();
      c.strokeStyle = '#d9dde0'; c.lineWidth = 2;
      for (let i = 0; i <= 10; i++) { const a = Math.PI * (0.8 + 1.4 * i / 10); c.beginPath(); c.moveTo(cx + Math.cos(a) * 26, 50 + Math.sin(a) * 26); c.lineTo(cx + Math.cos(a) * 32, 50 + Math.sin(a) * 32); c.stroke(); }
      c.strokeStyle = '#ff5a1a'; c.lineWidth = 3; c.beginPath(); c.moveTo(cx, 50); c.lineTo(cx - 20, 38); c.stroke();
    }
    c.fillStyle = '#0d2a3a'; c.fillRect(92, 18, 72, 50);
    c.fillStyle = '#7fd4ff'; c.font = `bold 11px ${sans}`; c.fillText('D6  ALL', 100, 36); c.fillText('35 km/h', 100, 54);
    for (let i = 0; i < 6; i++) { c.fillStyle = ['#2bd14a', '#f0b40c', '#3d8bff', '#d42', '#2bd14a', '#f0b40c'][i]; c.fillRect(96 + i * 11, 76, 7, 7); }
  });
  A.add('keepclear', 150, 132, (c, w, h) => {
    c.fillStyle = '#f7c600'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#111'; c.lineWidth = 6; c.strokeRect(3, 3, w - 6, h - 6);
    c.fillStyle = '#111'; c.beginPath(); c.moveTo(w / 2, 12); c.lineTo(w / 2 + 34, 70); c.lineTo(w / 2 - 34, 70); c.closePath(); c.fill();
    c.fillStyle = '#f7c600'; c.font = `900 38px ${sans}`; c.textAlign = 'center'; c.fillText('!', w / 2, 64);
    c.fillStyle = '#111'; c.font = `900 17px ${sans}`;
    c.fillText('KEEP CLEAR', w / 2, 96); c.fillText('SLEWING AREA', w / 2, 118);
  });
  A.add('level', 96, 96, (c, w, h) => { // bubble level on the outrigger control panel
    c.fillStyle = '#20232a'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#b8e1a0'; c.beginPath(); c.arc(w / 2, h / 2, 36, 0, TAU); c.fill();
    c.strokeStyle = '#222'; c.lineWidth = 2; c.beginPath(); c.arc(w / 2, h / 2, 12, 0, TAU); c.stroke();
    c.fillStyle = '#eefbe8'; c.beginPath(); c.arc(w / 2 + 3, h / 2 - 2, 8, 0, TAU); c.fill();
  });
  return A;
}

// Decal quad from the mobile atlas at pos, facing normal (small polygon offset).
export function decal(kit, atlas, name, w, h, pos, normal, rotZ = 0) {
  const g = atlas.quad(name, w, h);
  if (rotZ) g.rotateZ(rotZ);
  _q.setFromUnitVectors(V(0, 0, 1), normal.clone().normalize());
  _m.makeRotationFromQuaternion(_q).setPosition(pos);
  kit.add('mdecal', g, _m.clone(), null, false);
}

// Lamp lens (rectangle or disc) using one swatch of the lamp atlas.
export function lamp(kit, kind, w, h, pos, normal, round = false) {
  const g = round ? new THREE.CircleGeometry(w / 2, 16) : new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, LAMP_UV[kind] ?? 0.125, 0.5);
  _q.setFromUnitVectors(V(0, 0, 1), normal.clone().normalize());
  _m.makeRotationFromQuaternion(_q).setPosition(pos);
  kit.add('lamps', g, _m.clone(), null, false);
}

// Glass pane (outer tinted skin + inner dusty skin + EPDM seal), like the tower cab.
// c: centre, n: outward normal, w×h in the pane plane (h along the projected up).
export function pane(kit, w, h, c, n, inner = 'glassIn') {
  _q.setFromUnitVectors(V(0, 0, 1), n);
  _m.makeRotationFromQuaternion(_q).setPosition(c.clone().addScaledVector(n, 0.004));
  kit.add('glass', new THREE.PlaneGeometry(w, h), _m.clone(), null, false);
  const gm = _m.clone();
  const sw = 0.026, st = 0.014;
  for (const [gw, gh, gx, gy] of [[w + sw, sw, 0, h / 2], [w + sw, sw, 0, -h / 2], [sw, h - sw, w / 2, 0], [sw, h - sw, -w / 2, 0]]) {
    kit.add('rubber', mBox(gw, gh, st).translate(gx, gy, 0.002), gm, null, false);
  }
  if (!inner) return;
  _q.setFromUnitVectors(V(0, 0, 1), n.clone().negate());
  _m.makeRotationFromQuaternion(_q).setPosition(c.clone().addScaledVector(n, -0.004));
  kit.add(inner, new THREE.PlaneGeometry(w, h), _m.clone(), null, false);
}

// Sheave: disc with a rope groove (axis along z, centred) — as the tower's.
export function sheaveGeo(r, w) {
  const pts = [
    [0.03, -w / 2], [r * 0.55, -w / 2], [r * 0.7, -w * 0.35], [r, -w / 2], [r, -w * 0.4],
    [r - 0.022, -w * 0.08], [r - 0.022, w * 0.08], [r, w * 0.4], [r, w / 2], [r * 0.7, w * 0.35],
    [r * 0.55, w / 2], [0.03, w / 2],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2);
  return g;
}

// Box with rounded vertical edges (panels, housings), metric UVs from mBox-like scale
export function rbox(w, h, d, r = 0.04, seg = 2) {
  const g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.max(w, d), uv.getY(i) * h);
  return g;
}

// ------------------------------------------------------------------ helpers
// Move whole material bins of a kit to other keys before building (draw-call
// budget: small fittings take the colour of the part they sit on).
export function remapBins(kit, map) {
  for (const bins of [kit.bins, kit.lo].filter(Boolean)) {
    for (const [from, to] of Object.entries(map)) {
      const list = bins.get(from);
      if (!list || from === to) continue;
      bins.delete(from);
      if (!to) { for (const g of list) g.dispose(); continue; }
      if (!bins.has(to)) bins.set(to, []);
      bins.get(to).push(...list);
    }
  }
  return kit;
}

// Merge a kit's bins into {key: geometry} without creating meshes (for instancing).
export function kitGeometries(kit, mats) {
  const tmp = new THREE.Group();
  kit.build(tmp, mats);
  const out = [];
  for (const m of tmp.children) out.push({ key: m.name, geometry: m.geometry, material: m.material });
  return out;
}

// Chains of Object3D → does anything between p and host hide it?
function shown(p, host) {
  for (let o = p; o && o !== host; o = o.parent) if (!o.visible) return false;
  return true;
}

/**
 * ProxyInstancer: draw many moving copies of a part with ONE draw call per
 * material. Each copy is an ordinary (empty) Object3D "proxy" placed anywhere
 * under `host` in the scene graph, animated like any other node; after
 * host.updateMatrixWorld() (which the renderer runs every frame) the proxies'
 * world matrices are copied into InstancedMeshes parented to the host. A proxy
 * that is (or sits under) an invisible node is drawn with zero scale.
 * Must be created before anything calls host.updateMatrixWorld.
 */
export class ProxyInstancer {
  constructor(host) {
    this.host = host;
    this.sets = [];
    this._inv = new THREE.Matrix4();
    this._mm = new THREE.Matrix4();
    this._zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const inst = this, base = host.updateMatrixWorld;
    host.updateMatrixWorld = function (force) {
      base.call(this, force);
      inst.sync();
    };
  }

  // specs: [{geometry, material}] (e.g. from kitGeometries); proxies: Object3D[]
  add(name, specs, proxies) {
    const meshes = specs.map(({ geometry, material }) => {
      const im = new THREE.InstancedMesh(geometry, material, proxies.length);
      im.name = `${name}:${material.name || ''}`;
      im.frustumCulled = false; // proxies move: a cached bounding sphere would go stale
      im.castShadow = !material.transparent && material !== this.noShadowMat;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.host.add(im);
      return im;
    });
    this.sets.push({ name, meshes, proxies });
    return meshes;
  }

  sync() {
    this._inv.copy(this.host.matrixWorld).invert();
    for (const s of this.sets) {
      for (let i = 0; i < s.proxies.length; i++) {
        const p = s.proxies[i];
        const m = shown(p, this.host) ? this._mm.multiplyMatrices(this._inv, p.matrixWorld) : this._zero;
        for (const im of s.meshes) im.setMatrixAt(i, m);
      }
      for (const im of s.meshes) im.instanceMatrix.needsUpdate = true;
    }
  }
}

/**
 * LodKit: a Kit that also collects a coarse copy of every non-detail part
 * into a few material bins, then builds a THREE.LOD (hi = full kit, lo = the
 * coarse merge) — the renderer switches by camera distance. Set
 * kit.detail = true around bolts, interiors, hoses and other small parts
 * that vanish at distance.
 */
export const LOD_DIST = 140;
const LO_MAP = {
  yellow: 'yellow', yellowDark: 'yellow', hazard: 'yellow', red: 'yellow',
  cabBody: 'cabBody', white: 'cabBody', grey: 'cabBody', panel: 'cabBody',
  cabFrame: 'cabFrame', machine: 'cabFrame', darkSteel: 'cabFrame', black: 'cabFrame', rubber: 'cabFrame', seat: 'cabFrame', ropeWound: 'cabFrame',
  galv: 'galv', chrome: 'galv', grating: 'galv',
  glass: 'glass',
};
export class LodKit extends Kit {
  constructor(seed = 1) {
    super(seed);
    this.detail = false;
    this.lo = new Map();
  }

  add(key, geo, m = null, wear = null, jitter = true) {
    const g = super.add(key, geo, m, wear, jitter);
    const lk = this.detail ? null : LO_MAP[key];
    if (lk) {
      if (!this.lo.has(lk)) this.lo.set(lk, []);
      this.lo.get(lk).push(g.clone());
    }
    return g;
  }

  // → {lod, hi, lo, meshes}; add hi-only extras (sticks, screens) to `hi`
  buildLod(parent, mats, { distance = LOD_DIST, noShadow = [] } = {}) {
    const hi = new THREE.Group();
    hi.name = 'hi';
    const meshes = this.build(hi, mats, { noShadow });
    const lo = new THREE.Group();
    lo.name = 'lo';
    for (const [key, list] of this.lo) {
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(geo, mats[key]);
      mesh.name = key;
      mesh.castShadow = !mats[key].transparent;
      mesh.receiveShadow = true;
      lo.add(mesh);
    }
    this.lo.clear();
    const lod = new THREE.LOD();
    lod.name = 'lod';
    lod.addLevel(hi, 0);
    lod.addLevel(lo, distance);
    parent.add(lod);
    return { lod, hi, lo, meshes };
  }
}

// ------------------------------------------------------------------ constants
// Everything below that is not in config.js is a visual-only dimension [E]
// chosen to respect the config geometry (clearances noted where they matter).
const TY = AT100.carrier.tyre;
export const TYRE_R = TY.dia / 2; // 0.685
export const DATUM = AT100.carrier.rideHeight; // frame datum 1.30 above ground on tyres
export const J0 = AT100.outriggers.jackJ0; // 0.90 datum → pad bottom (jack retracted)
// Outrigger beams (single stage): body 0.32 × 0.26, 2.40 long from the jack
// housing inward. Left beams run in the upper half of the box, right beams in
// the lower half, so both floats of a box sit exactly on its float line.
export const BEAM = { depth: 0.32, height: 0.26, len: 2.40, yUpper: 0.05, yLower: -0.27, housing: 0.24 };
export const BEAM_LEN = BEAM.len;
// painted marks: distance from the housing face at which the box end (|z| 1.10)
// meets the beam when the float is at 50 % / 100 % (float |y| 2.50 / 3.50)
export const BOX_HALF = 1.10;
const BEAM_Z0 = BEAM.housing / 2 - 0.02; // beam body starts this far inboard of the float axis
const BEAM_MARK_50 = 2.50 - BOX_HALF - BEAM_Z0;
const BEAM_MARK_100 = 3.50 - BOX_HALF - BEAM_Z0;
export const PAD = { size: AT100.outriggers.pad.size, t: 0.06, dome: 0.08 };

// ------------------------------------------------------------------ wheels
// Tyre: lathe of the 385/95 R25 section (outer sidewall toward local −z, the
// left side of the carrier; right wheels get a π turn) + two rows of tread
// blocks. Axle along z, centre at the origin.
export function tyreGeometry() {
  const R = TYRE_R, hw = TY.width / 2, bead = 0.3175; // 25" rim
  // [radius, axial, v] from the outer bead (a < 0) to the inner bead
  const prof = [
    [bead, -0.150], [0.36, -0.172], [0.44, -0.188], [0.52, -hw], [0.60, -0.184], [0.648, -0.166], [0.672, -0.142],
    [R - 0.002, -0.07], [R, 0], [R - 0.002, 0.07], [0.672, 0.142], [0.648, 0.166], [0.60, 0.184], [0.52, hw], [0.44, 0.188], [0.36, 0.172], [bead, 0.150],
  ];
  const vOf = (r, a) => (a < -0.141 ? 0.30 * (r - bead) / (0.672 - bead) : a > 0.141 ? 1 - 0.30 * (r - bead) / (0.672 - bead) : 0.35 + 0.30 * (a + 0.142) / 0.284);
  const lathe = new THREE.LatheGeometry(prof.map(([r, a]) => new THREE.Vector2(r, a)), 56);
  // lathe uv.y = index / (n − 1): replace with the section parameter above
  const uv = lathe.attributes.uv, pos = lathe.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    uv.setY(i, vOf(Math.hypot(x, z), y));
  }
  lathe.rotateX(Math.PI / 2); // axial y → z
  const parts = [lathe];
  // tread blocks: 2 staggered rows of 38, 22 mm deep, slightly angled (all-terrain crane pattern)
  const N = 38;
  for (let row = 0; row < 2; row++) {
    for (let k = 0; k < N; k++) {
      const phi = (k + row * 0.5) / N * TAU;
      const b = new THREE.BoxGeometry(0.085, 0.024, 0.118);
      const buv = b.attributes.uv;
      for (let i = 0; i < buv.count; i++) buv.setXY(i, phi / TAU, 0.5);
      b.rotateY(row ? 0.32 : -0.32);
      b.translate(0, R + 0.008, row ? 0.066 : -0.066);
      b.rotateZ(phi);
      parts.push(b);
    }
  }
  return mergeGeometries(parts.map((g) => prep(g)), false);
}

// Rim (grey paint): 25" multi-piece rim with a dished centre disc, ten wheel
// nuts and a hub cap on the outer face (local −z).
export function rimKit(kit) {
  // barrel + flange lips, profile ascending in a so the lathe faces outward; the
  // barrel's inside (seen past the lip) is a second, reversed shell
  const prof = [[0.33, -0.16], [0.345, -0.15], [0.335, -0.135], [0.30, -0.12], [0.30, 0.02], [0.305, 0.11], [0.335, 0.125], [0.345, 0.14], [0.33, 0.150]];
  const g = new THREE.LatheGeometry(prof.map(([r, a]) => new THREE.Vector2(r, a)), 40);
  g.rotateX(Math.PI / 2);
  kit.add('grey', g, null, WEAR_LIGHT, false);
  const gi = new THREE.LatheGeometry([[0.296, 0.1], [0.296, -0.13]].map(([r, a]) => new THREE.Vector2(r, a)), 40);
  gi.rotateX(Math.PI / 2);
  kit.add('grey', gi, null, WEAR_LIGHT, false);
  // centre disc (dished toward the outside) + hand holes as dark rings
  const disc = new THREE.LatheGeometry([[0.30, -0.04], [0.22, -0.06], [0.14, -0.075], [0.10, -0.08]].map(([r, a]) => new THREE.Vector2(r, a)).reverse(), 32);
  disc.rotateX(Math.PI / 2);
  kit.add('grey', disc, null, WEAR_JOINT, false);
  kit.add('grey', mCyl(0.10, 0.10, 0.07, 20).rotateX(Math.PI / 2).translate(0, 0, -0.115), null, WEAR_JOINT, false);
  kit.add('grey', mCyl(0.075, 0.085, 0.05, 20).rotateX(Math.PI / 2).translate(0, 0, -0.17), null, WEAR_JOINT, false);
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU;
    const nut = boltGeo(0.026, 0.03, true);
    nut.rotateX(-Math.PI / 2); // axis → −z (outward)
    nut.translate(Math.cos(a) * 0.175, Math.sin(a) * 0.175, -0.075);
    kit.add('grey', nut, null, null, false);
  }
}

// ------------------------------------------------------------------ outriggers
// Beam + jack housing, beam-local: origin on the float axis at datum height,
// the beam runs inward toward +z (left side; right beams are turned by π).
// upper: true = runs in the upper half of the box (left beams).
export function beamKit(kit, atlas, upper) {
  const y0 = upper ? BEAM.yUpper : BEAM.yLower, H = BEAM.height, hs = BEAM.housing;
  const z0 = BEAM_Z0, z1 = z0 + BEAM.len;
  kit.box('yellow', BEAM.depth, H, z1 - z0, 0, y0 + H / 2, (z0 + z1) / 2, null, WEAR_LIGHT);
  kit.box('yellow', BEAM.depth + 0.02, H + 0.02, 0.03, 0, y0 + H / 2, z1 - 0.015, null, WEAR_PLATE); // inner end cap
  // jack housing: square tube from the beam top down to just above the float
  const hTop = y0 + H + 0.1, hBot = -J0 + PAD.t + PAD.dome + 0.04;
  kit.box('yellow', hs, hTop - hBot, hs, 0, (hTop + hBot) / 2, 0, null, WEAR_PLATE);
  kit.box('yellow', hs + 0.03, 0.04, hs + 0.03, 0, hBot + 0.02, 0, null, WEAR_PLATE); // gland collar
  kit.box('yellow', hs + 0.02, 0.05, hs + 0.02, 0, hTop + 0.025, 0, null, WEAR_PLATE); // head plate
  kit.cyl('darkSteel', 0.045, 0.08, 0.06, hTop + 0.09, 0.03, 'y', 10); // hydraulic fittings
  kit.cyl('darkSteel', 0.03, 0.07, -0.06, hTop + 0.085, -0.02, 'y', 8);
  kit.member('black', V(0.06, hTop + 0.13, 0.03), V(0.12, hTop + 0.05, 0.3), { k: 'tube', r: 0.016, seg: 6 }, null, 0);
  // gusset between housing and beam
  kit.box('yellow', 0.02, H * 0.9, 0.22, 0, y0 + H * 0.45, hs / 2 + 0.1, null, WEAR_PLATE);
  // markings: red / white stripes on the outer face, extension scale on top
  decal(kit, atlas, 'stripes', hs - 0.03, 0.5, V(0, hBot + 0.45, -hs / 2 - 0.002), V(0, 0, -1));
  decal(kit, atlas, 'pct', BEAM.len, 0.1, V(0, y0 + H + 0.002, z0 + BEAM.len / 2), V(0, 1, 0), -Math.PI / 2);
  // lifting eye
  kit.add('darkSteel', mTorus(0.04, 0.012, 6, 12).rotateY(Math.PI / 2).translate(0, hTop + 0.09, -0.06), null, null, false);
}

// Float pad (pad-local: origin at the pad bottom centre): ribbed plate + ball socket.
export function floatKit(kit) {
  const s = PAD.size;
  kit.add('cabFrame', rbox(s, PAD.t, s, 0.03, 2).translate(0, PAD.t / 2, 0), null, WEAR_LIGHT, true);
  for (const a of [0, Math.PI / 2]) {
    const rib = mBox(s - 0.08, 0.05, 0.02).translate(0, PAD.t + 0.025, 0);
    rib.rotateY(a);
    kit.add('cabFrame', rib, null, WEAR_JOINT);
  }
  kit.add('cabFrame', new THREE.SphereGeometry(0.1, 16, 8, 0, TAU, 0, Math.PI / 2).scale(1, PAD.dome / 0.1, 1).translate(0, PAD.t, 0), null, WEAR_JOINT, false);
  kit.cyl('darkSteel', 0.1, 0.03, 0, PAD.t + PAD.dome - 0.01, 0, 'y', 16);
  for (const [x, z] of [[0.2, 0.2], [-0.2, 0.2], [0.2, -0.2], [-0.2, -0.2]]) kit.add('darkSteel', boltGeo(0.02, 0.012, false).translate(x, PAD.t, z), null, null, false);
}

// Mats (mat-local: origin at the mat bottom centre, long side along x).
export function carriedMatKit(kit) {
  const [L, T, W] = MATS.carried.size;
  kit.add('galv', rbox(L, T, W, 0.03, 2).translate(0, T / 2, 0), null, WEAR_LIGHT);
  for (let i = -3; i <= 3; i++) kit.box('galv', 0.03, 0.012, W - 0.12, i * 0.22, T + 0.006, 0); // anti-slip ribs
  for (const x of [-L / 2, L / 2]) kit.add('darkSteel', mTorus(0.08, 0.012, 6, 12, Math.PI).rotateX(Math.PI / 2).rotateY(x > 0 ? Math.PI / 2 : -Math.PI / 2).translate(x, T / 2, 0), null, null, false); // rope handles
}
export function compositeMatKit(kit) {
  const [L, T, W] = MATS.composite.size;
  kit.add('rubber', rbox(L, T, W, 0.05, 2).translate(0, T / 2, 0), null, null);
  kit.add('rubber', mTorus(0.5, 0.012, 4, 32).rotateX(Math.PI / 2).translate(0, T + 0.004, 0), null, null, false);
  for (const [x, z] of [[L / 2 - 0.1, 0], [-L / 2 + 0.1, 0], [0, W / 2 - 0.1], [0, -W / 2 + 0.1]]) kit.box('black', 0.14, 0.012, 0.05, x, T + 0.004, z, x ? null : [0, Math.PI / 2, 0]);
}

// ------------------------------------------------------------------ counterweight
// Slab plan (slab-local: origin at the bottom centre = CG line u −3.18 of §1.3):
// straight front edge, rear edge an arc about the slew axis at the tail-swing
// radius 3.84 m, side notches for the ballasting rams at |z| 1.18.
export const CW_U = AT100.cwCg.u; // −3.18
export const TAIL_R = AT100.tailSwing; // 3.84
export const RAM_Z = 1.18;
export function tailShape(front = CW_SLAB_SIZE.depth / 2, halfW = CW_SLAB_SIZE.width / 2, notch = true, uc = -CW_U) {
  // plan in (x = u − u_cg, y = −z) — symmetric, so the sign of y does not matter
  const s = new THREE.Shape();
  const xr = (y) => uc - Math.sqrt(TAIL_R * TAIL_R - y * y); // arc: x of the tail-swing circle
  s.moveTo(front, -halfW);
  s.lineTo(front, halfW);
  if (notch) { s.lineTo(0.12, halfW); s.lineTo(0.12, RAM_Z - 0.1); s.lineTo(-0.12, RAM_Z - 0.1); s.lineTo(-0.12, halfW); }
  for (let i = 0; i <= 16; i++) { const y = halfW - (2 * halfW) * i / 16; s.lineTo(xr(y) + 0.005, y); }
  if (notch) { s.lineTo(-0.12, -halfW); s.lineTo(-0.12, -RAM_Z + 0.1); s.lineTo(0.12, -RAM_Z + 0.1); s.lineTo(0.12, -halfW); }
  s.closePath();
  return s;
}
export function cwSlabKit(kit, atlas, h, label) {
  const g = mExtrude(tailShape(), h, { curveSegments: 4 });
  g.rotateX(-Math.PI / 2); // extrusion → +y
  kit.add('yellowDark', g, null, [0.6, 0.6, 0.9]);
  // lifting lugs (4-leg sling points) and stacking cones
  for (const [x, z] of [[0.35, 0.85], [0.35, -0.85], [-0.45, 0.85], [-0.45, -0.85]]) {
    kit.add('yellowDark', mTorus(0.07, 0.022, 6, 12, Math.PI).translate(x, h, z), null, WEAR_JOINT, false);
    kit.box('yellowDark', 0.16, 0.03, 0.05, x, h + 0.015, z, null, WEAR_JOINT);
  }
  for (const z of [0.5, -0.5]) kit.add('darkSteel', mCyl(0.02, 0.05, 0.05, 10).translate(0, h + 0.025, z), null, null, false);
  const mid = h / 2;
  // side labels on the flat part of the side faces, in front of the ram notch
  const sx = (CW_SLAB_SIZE.depth / 2 + 0.12) / 2, sw = CW_SLAB_SIZE.depth / 2 - 0.12 - 0.06;
  decal(kit, atlas, label, sw, sw * 0.39, V(sx, mid, CW_SLAB_SIZE.width / 2 + 0.002), V(0, 0, 1));
  decal(kit, atlas, label, sw, sw * 0.39, V(sx, mid, -CW_SLAB_SIZE.width / 2 - 0.002), V(0, 0, -1));
  decal(kit, atlas, label, 0.5, 0.19, V(-CW_U - TAIL_R - 0.002, mid, 0), V(-1, 0, 0)); // centre of the rear arc (narrow: flat on a curve)
}

// ------------------------------------------------------------------ small parts
// Unit capped cylinder (radius 1, height 1, centred, axis y) for chrome rods.
export function unitRodGeometry(seg = 14) {
  return prep(mCyl(1, 1, 1, seg, false));
}
export function beaconGeometry() {
  const g = mergeGeometries([
    prep(mCyl(0.068, 0.072, 0.12, 16).translate(0, 0.06, 0)),
    prep(new THREE.SphereGeometry(0.068, 16, 6, 0, TAU, 0, Math.PI / 2).translate(0, 0.12, 0)),
  ], false);
  return g;
}

// Joystick pivot (black grip on a rubber boot), pivot at the console top.
export function joystick(mats, seed) {
  const pivot = new THREE.Group();
  const pk = new Kit(seed);
  pk.add('black', new THREE.CylinderGeometry(0.018, 0.04, 0.05, 12), null, null, false);
  for (let i = 0; i < 3; i++) pk.add('black', new THREE.TorusGeometry(0.03 - i * 0.006, 0.006, 5, 12).rotateX(Math.PI / 2).translate(0, -0.01 + i * 0.015, 0), null, null, false);
  pk.cyl('black', 0.01, 0.07, 0, 0.06, 0, 'y', 8);
  pk.add('black', new THREE.CapsuleGeometry(0.026, 0.085, 4, 12).rotateZ(-0.16).translate(0.012, 0.15, 0), null, null, false);
  pk.cyl('black', 0.011, 0.012, 0.026, 0.215, 0, 'y', 10);
  pk.build(pivot, mats);
  return pivot;
}

// ------------------------------------------------------------------ crane cab
// Tilting crane cab on the left of the boom (§1.2). Group origin = tilt hinge
// at the cab's rear-bottom centre; +X forward, outer (door) side = −Z.
// Operator eye at CAB.eye (the spec's y 1.45 would put the eye outside the
// 2.75 m vehicle width; the cab is kept inside it, eye on the cab centreline).
export const CAB = { D: 2.05, W: 0.875, H: 1.55, eye: V(1.40, 1.15, 0) };
export function buildCraneCab(M, atlas) {
  const g = new THREE.Group();
  g.name = 'craneCab';
  const kit = new LodKit(301);
  const { D, W, H } = CAB;
  const hz = W / 2, rake = 0.16; // windscreen top sits 0.16 m behind its foot
  const xf = (y) => D - rake * (y / H); // front face x at height y
  const fr = (a, b, w = 0.055, d = 0.055) => kit.member('cabBody', a, b, { k: 'box', w, d }, null, 0.4);
  // --- frame
  for (const z of [-hz + 0.03, hz - 0.03]) {
    fr(V(0.03, 0, z), V(0.03, H, z));
    fr(V(xf(0) - 0.03, 0, z), V(xf(H) - 0.03, H, z));
    fr(V(0, H - 0.03, z), V(xf(H), H - 0.03, z), 0.07);
    fr(V(0, 0.03, z), V(D, 0.03, z), 0.07);
    fr(V(0.25, 0.3, z), V(xf(0.3), 0.3, z), 0.05); // sill rail (side windows start above)
  }
  for (const y of [0.03, H - 0.03]) fr(V(xf(y) - 0.03, y, -hz), V(xf(y) - 0.03, y, hz), 0.07);
  fr(V(xf(0.55) - 0.02, 0.55, -hz), V(xf(0.55) - 0.02, 0.55, hz), 0.045); // front transom
  fr(V(1.32, 0.3, -hz + 0.02), V(1.32, H, -hz + 0.02), 0.05); // door front post
  fr(V(0.95, H - 0.02, -hz), V(0.95, H - 0.02, hz), 0.06); // roof bow (roof window in front of it)
  // --- skin: rear wall, lower side panels, roof (rear half), floor
  kit.box('cabBody', 0.03, H, W, -0.012, H / 2, 0, null, WEAR_LIGHT);
  for (const s of [-1, 1]) kit.box('cabBody', D - 0.1, 0.27, 0.02, D / 2 - 0.04, 0.15, s * (hz + 0.005), null, WEAR_LIGHT);
  kit.box('cabBody', 1.0, 0.06, W + 0.06, 0.47, H + 0.03, 0, null, WEAR_LIGHT);
  kit.box('cabBody', D, 0.05, W, D / 2, 0.0, 0);
  kit.box('cabFrame', D - 0.2, 0.12, W - 0.1, D / 2 - 0.05, -0.08, 0); // sub-floor / tilt frame
  // door (outer side): outline, handle, grab rail
  kit.box('black', 0.012, 1.18, 0.006, 0.26, 0.9, -hz - 0.012);
  kit.box('black', 0.012, 1.18, 0.006, 1.30, 0.9, -hz - 0.012);
  kit.box('darkSteel', 0.14, 0.03, 0.04, 1.18, 0.95, -hz - 0.03);
  kit.member('galv', V(0.12, 0.35, -hz - 0.07), V(0.12, 1.3, -hz - 0.07), { k: 'tube', r: 0.015, seg: 8 }, null, 0);
  decal(kit, atlas, 'plate', 0.2, 0.117, V(-0.03, 0.5, -0.2), V(-1, 0, 0));
  // --- glazing: front (upper + floor-level lower pane), roof window, both sides
  const nF = V(H, rake, 0).normalize(); // front pane normal (raked)
  const paneF = (y0, y1, inner) => {
    const yc = (y0 + y1) / 2;
    pane(kit, W - 0.1, (y1 - y0) / Math.cos(Math.atan(rake / H)), V(xf(yc), yc, 0), nF, inner);
  };
  paneF(0.58, H - 0.07, 'glassWiped');
  paneF(0.07, 0.52, 'glassIn');
  pane(kit, xf(H) - 1.04, W - 0.12, V((xf(H) + 1.0) / 2 - 0.02, H - 0.005, 0), V(0, 1, 0)); // roof window (w along x)
  pane(kit, D - 0.45, H - 0.4, V(0.2 + (D - 0.45) / 2 + 0.02, 0.33 + (H - 0.4) / 2, hz), V(0, 0, 1)); // boom side
  pane(kit, 0.98, H - 0.45, V(0.79, 0.33 + (H - 0.45) / 2, -hz), V(0, 0, -1)); // door window
  pane(kit, xf(1) - 1.4, H - 0.45, V(1.36 + (xf(1) - 1.4) / 2, 0.33 + (H - 0.45) / 2, -hz), V(0, 0, -1));
  // FOPS bars over the roof window
  for (let i = 0; i < 4; i++) kit.box('black', xf(H) - 1.0, 0.02, 0.025, (xf(H) + 1.0) / 2, H + 0.03, -0.27 + i * 0.18);
  // --- exterior: wiper, visor, roof lamps, beacon base, horn
  kit.member('black', V(xf(0.6) + 0.01, 0.62, -hz + 0.1), V(xf(1.35) + 0.01, 1.35, -hz + 0.13), { k: 'box', w: 0.012, d: 0.02 }, V(1, 0, 0), 0);
  kit.cyl('black', 0.022, 0.035, xf(0.6) + 0.02, 0.62, -hz + 0.1, 'x', 10);
  for (const z of [-0.26, 0.26]) {
    kit.box('black', 0.12, 0.1, 0.16, xf(H) - 0.02, H + 0.1, z);
    lamp(kit, 'work', 0.13, 0.08, V(xf(H) + 0.042, H + 0.1, z), V(1, -0.25, 0));
  }
  kit.cyl('black', 0.07, 0.04, 0.2, H + 0.08, -0.25, 'y', 14);
  kit.cyl('black', 0.04, 0.12, 0.35, H + 0.06, 0.25, 'x', 10);
  // --- interior (hi LOD only)
  kit.detail = true;
  kit.box('panel', 0.02, H - 0.1, W - 0.1, 0.03, H / 2, 0);
  kit.box('panel', 0.96, 0.02, W - 0.1, 0.5, H - 0.07, 0);
  kit.box('rubber', D - 0.15, 0.012, W - 0.1, D / 2, 0.031, 0);
  kit.box('panel', 0.5, 0.08, 0.3, 0.45, H - 0.12, 0.22); // overhead console
  kit.box('black', 0.2, 0.05, 0.14, 0.45, H - 0.18, 0.2);
  decal(kit, atlas, 'chart', 0.3, 0.21, V(0.05, 1.05, -0.2), V(1, 0, 0));
  kit.box('panel', 0.3, 0.22, 0.2, 0.2, 0.14, 0.25); // heater
  kit.cyl('red', 0.06, 0.34, 0.15, 0.3, -0.3, 'y', 14); // extinguisher
  // floor pedals (slew brake) and foot rest
  kit.box('black', 0.26, 0.03, 0.34, D - 0.35, 0.12, 0, [0, 0, 0.35]);
  // seat with armrest consoles
  const seatX = 1.2;
  kit.box('darkSteel', 0.36, 0.03, 0.36, seatX + 0.1, 0.06, 0);
  kit.cyl('darkSteel', 0.05, 0.25, seatX + 0.1, 0.2, 0, 'y', 12);
  kit.add('rubber', new RoundedBoxGeometry(0.46, 0.11, 0.46, 3, 0.04).translate(seatX + 0.12, 0.43, 0), null, null, false);
  kit.add('rubber', new RoundedBoxGeometry(0.11, 0.62, 0.44, 3, 0.045).rotateZ(0.14).translate(seatX - 0.1, 0.8, 0), null, null, false);
  kit.add('rubber', new RoundedBoxGeometry(0.08, 0.18, 0.26, 2, 0.035).rotateZ(0.14).translate(seatX - 0.16, 1.2, 0), null, null, false);
  const sticks = [];
  for (const s of [-1, 1]) {
    const cz = s * 0.3;
    kit.add('black', new RoundedBoxGeometry(0.44, 0.1, 0.16, 2, 0.025).translate(seatX + 0.3, 0.6, cz), null, null, false);
    kit.box('darkSteel', 0.05, 0.28, 0.05, seatX + 0.2, 0.42, cz);
    kit.box('panel', 0.12, 0.004, 0.12, seatX + 0.42, 0.652, cz);
    for (const [dx, dz, k] of [[0.08, -0.04, 'red'], [0.12, -0.04, 'galv'], [0.08, 0.04, 'galv'], [0.12, 0.04, 'yellow']]) kit.cyl(k, 0.01, 0.012, seatX + 0.36 + dx, 0.655, cz + dz * s, 'y', 10);
    const st = joystick(M, 330 + s);
    st.position.set(seatX + 0.46, 0.65, cz);
    sticks.push(st);
  }
  // RCL screen on an arm from the right front post, facing the operator; the
  // housing goes into the kit, only the live screen is its own mesh
  const scrPos = V(1.8, 0.84, 0.3);
  kit.member('galv', V(xf(0.9) - 0.05, 0.9, hz - 0.05), scrPos.clone().add(V(0.03, -0.04, 0.03)), { k: 'tube', r: 0.013, seg: 8 }, null, 0);
  const lmi = new THREE.Group();
  lmi.position.copy(scrPos);
  lmi.lookAt(CAB.eye);
  lmi.updateMatrix();
  kit.add('black', new RoundedBoxGeometry(0.34, 0.23, 0.045, 2, 0.012), lmi.matrix.clone(), null, false);
  kit.detail = false;
  remapBins(kit, { panel: 'cabBody', darkSteel: 'black', galv: 'black', yellow: 'black', seat: 'rubber' });
  const built = kit.buildLod(g, M, { noShadow: ['glassIn', 'glassWiped', 'mdecal', 'lamps'] });
  const hi = built.hi;
  for (const st of sticks) hi.add(st);
  const c = document.createElement('canvas');
  c.width = 512; c.height = 320;
  const x = c.getContext('2d');
  x.fillStyle = '#05080c'; x.fillRect(0, 0, 512, 320);
  x.fillStyle = '#1d4fa8'; x.fillRect(0, 0, 512, 38);
  x.fillStyle = '#e8f1ff'; x.font = 'bold 22px monospace'; x.fillText('RCL  AT-100 5.1', 14, 27);
  x.fillStyle = '#7fb0ff'; x.font = 'bold 18px monospace'; x.fillText('SYSTEM START ...', 14, 90);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.1875), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  screen.name = 'rclScreen';
  screen.position.z = 0.0235;
  lmi.add(screen);
  hi.add(lmi);
  const eye = new THREE.Object3D();
  eye.name = 'craneEye';
  eye.position.copy(CAB.eye);
  g.add(eye);
  const beaconAt = new THREE.Object3D();
  beaconAt.position.set(0.2, H + 0.1, -0.25);
  g.add(beaconAt);
  g.leftStick = sticks[0];
  g.rightStick = sticks[1];
  g.screen = screen;
  return { group: g, eye, beacon: beaconAt, lod: built.lod };
}

// ------------------------------------------------------------------ driver cab
// Front-left driver cab, built straight into the carrier kit (static), with the
// steering wheel as its own small group. Carrier coordinates (§1.2: eye at
// C(6.95, +0.70, 2.85) → three (6.95, 2.85, −0.70)). Its right part lies under
// the boom in road trim (roof 3.10 < boom underside 3.18 at 0° luff).
export const DCAB = { x0: 5.95, x1: 7.62, zOut: -AT100.carrier.width / 2, zIn: -0.15, floor: 1.60, roof: 3.10, rake: 0.15 };
export function addDriverCab(kit, M, atlas, cabGroup) {
  const { x0, x1, zOut, zIn, floor, roof, rake } = DCAB;
  const zc = (zOut + zIn) / 2, W = zIn - zOut;
  const yWs = 2.02; // windscreen foot
  const xf = (y) => x1 - rake * Math.max(0, (y - yWs) / (roof - yWs)); // front face x at height y
  const fr = (a, b, w = 0.06, d = 0.06) => kit.member('cabBody', a, b, { k: 'box', w, d }, null, 0.4);
  // --- base below the floor (clear of the front tyre: starts at x 6.35) + wheel-arch panel
  // (the cab's lower body is carrier bodywork, in the carrier colour)
  kit.add('yellow', rbox(x1 - 6.35, floor - 1.08, W, 0.05).translate((x1 + 6.35) / 2, (floor + 1.08) / 2, zc), null, WEAR_LIGHT);
  kit.box('yellow', 6.35 - x0, 0.08, W, (x0 + 6.35) / 2, floor - 0.04, zc, null, WEAR_LIGHT);
  // --- shell: posts, rails, panels
  for (const z of [zOut + 0.03, zIn - 0.03]) {
    fr(V(x0 + 0.03, floor, z), V(x0 + 0.03, roof, z));
    fr(V(x1 - 0.03, floor, z), V(x1 - 0.03, yWs, z));
    fr(V(x1 - 0.03, yWs, z), V(xf(roof) - 0.03, roof, z));
    fr(V(x0, roof - 0.03, z), V(xf(roof), roof - 0.03, z), 0.07);
    fr(V(x0, 2.05, z), V(x1, 2.05, z), 0.05); // waist rail
  }
  fr(V(x1 - 0.03, yWs, zOut), V(x1 - 0.03, yWs, zIn), 0.07);
  fr(V(xf(roof) - 0.03, roof - 0.03, zOut), V(xf(roof) - 0.03, roof - 0.03, zIn), 0.07);
  fr(V(6.25, floor, zOut + 0.02), V(6.25, roof, zOut + 0.02), 0.05); // door posts
  fr(V(7.15, floor, zOut + 0.02), V(7.15, roof, zOut + 0.02), 0.05);
  kit.box('cabBody', 0.03, roof - floor, W, x0 - 0.012, (roof + floor) / 2, zc, null, WEAR_LIGHT); // rear wall
  for (const z of [zOut - 0.005, zIn + 0.005]) kit.box('cabBody', x1 - x0, 2.05 - floor, 0.02, (x0 + x1) / 2, (floor + 2.05) / 2, z, null, WEAR_LIGHT);
  kit.box('cabBody', 0.02, yWs - floor, W, x1 + 0.005, (yWs + floor) / 2, zc, null, WEAR_LIGHT); // front panel under the screen
  kit.add('cabBody', rbox(xf(roof) - x0 + 0.1, 0.07, W + 0.06, 0.03).translate((xf(roof) + x0) / 2 + 0.02, roof + 0.03, zc), null, WEAR_LIGHT);
  // door handle, outline, steps (under the door, clear of the tyre)
  kit.box('black', 0.006, 1.4, 0.006, 6.27, 1.35 + 0.35, zOut - 0.013);
  kit.box('black', 0.006, 1.4, 0.006, 7.13, 1.35 + 0.35, zOut - 0.013);
  kit.box('darkSteel', 0.14, 0.03, 0.04, 7.0, 2.0, zOut - 0.03);
  for (const [y, d] of [[0.42, 0.24], [0.75, 0.2], [1.04, 0.16]]) {
    kit.box('galv', 0.7, 0.04, d, 6.7, y, zOut + d / 2 + 0.005);
    kit.box('yellow', 0.02, 0.2, d, 6.34, y - 0.08, zOut + d / 2 + 0.005);
  }
  kit.member('galv', V(6.3, 1.2, zOut - 0.06), V(6.3, 2.7, zOut - 0.06), { k: 'tube', r: 0.015, seg: 8 }, null, 0);
  // --- glazing
  const nF = V(roof - yWs, rake, 0).normalize();
  const hWs = Math.hypot(roof - yWs - 0.1, rake);
  pane(kit, W - 0.12, hWs, V((x1 + xf(roof)) / 2, (yWs + roof) / 2, zc), nF, 'glassIn');
  pane(kit, 0.84, roof - 2.1 - 0.06, V(6.70, (2.1 + roof) / 2 - 0.03, zOut), V(0, 0, -1)); // door window
  pane(kit, x1 - 7.2 - 0.05, roof - 2.1 - 0.06, V((7.2 + x1) / 2 - 0.05, (2.1 + roof) / 2 - 0.03, zOut), V(0, 0, -1));
  pane(kit, x1 - x0 - 0.2, roof - 2.1 - 0.06, V((x0 + x1) / 2, (2.1 + roof) / 2 - 0.03, zIn), V(0, 0, 1));
  pane(kit, 0.5, 0.45, V(x0 - 0.03, 2.65, zc), V(-1, 0, 0));
  // --- exterior: visor, wipers, mirrors, beacons bases, horns, lamps
  kit.box('black', 0.3, 0.02, W + 0.04, xf(roof) + 0.12, roof - 0.02, zc, [0, 0, -0.12]);
  // wipers parked along the windscreen foot (out of the driver's sight line)
  for (const z of [zOut + 0.12, zc + 0.05]) {
    const p0 = V(x1 + 0.014, yWs + 0.05, z), p1 = V(xf(yWs + 0.08) + 0.014, yWs + 0.08, z + 0.5);
    kit.member('black', p0, p1, { k: 'box', w: 0.012, d: 0.02 }, V(1, 0, 0), 0);
    kit.cyl('black', 0.02, 0.03, x1 + 0.01, yWs + 0.05, z, 'x', 8);
  }
  // left mirror on an arm from the A-pillar; right mirror on a post at the carrier front right
  kit.member('black', V(x1 - 0.1, 2.75, zOut), V(x1 + 0.05, 2.7, zOut - 0.24), { k: 'tube', r: 0.018, seg: 8 }, null, 0);
  kit.add('black', rbox(0.1, 0.42, 0.22, 0.03).translate(x1 + 0.06, 2.62, zOut - 0.3), null, null, false);
  kit.member('black', V(7.5, 1.95, 1.3), V(7.5, 2.55, 1.42), { k: 'tube', r: 0.02, seg: 8 }, null, 0);
  kit.add('black', rbox(0.1, 0.38, 0.2, 0.03).translate(7.55, 2.62, 1.42), null, null, false);
  kit.detail = true;
  for (const z of [zOut + 0.12, zIn - 0.12]) kit.cyl('black', 0.07, 0.04, x0 + 0.15, roof + 0.085, z, 'y', 14); // beacon bases
  kit.cyl('galv', 0.035, 0.38, x0 + 0.5, roof + 0.1, zc, 'x', 10); // air horn
  kit.cyl('black', 0.006, 0.5, x0 + 0.9, roof + 0.3, zIn - 0.1, 'y', 6); // antenna
  lamp(kit, 'amber', 0.07, 0.07, V(x1 + 0.012, 1.95, zOut + 0.06), V(1, 0, -0.4), true);
  // --- interior
  kit.box('black', 0.34, 0.3, W - 0.1, x1 - 0.2, 1.97, zc); // dashboard
  decal(kit, atlas, 'dash', 0.52, 0.2, V(x1 - 0.37, 2.16, -0.70), V(-1, 0.55, 0));
  kit.box('panel', x1 - x0 - 0.1, 0.02, W - 0.1, (x0 + x1) / 2, roof - 0.07, zc);
  kit.box('rubber', x1 - x0 - 0.1, 0.012, W - 0.1, (x0 + x1) / 2, floor + 0.006, zc);
  const sx = 6.78, sz = -0.70; // seat under the spec eye (6.95, 2.85): eye ~0.3 m ahead of the backrest
  kit.cyl('darkSteel', 0.05, 0.3, sx + 0.1, floor + 0.15, sz, 'y', 12);
  kit.add('seat', new RoundedBoxGeometry(0.5, 0.12, 0.48, 3, 0.045).translate(sx + 0.12, floor + 0.36, sz), null, null, false);
  kit.add('seat', new RoundedBoxGeometry(0.12, 0.7, 0.46, 3, 0.05).rotateZ(0.2).translate(sx - 0.1, floor + 0.75, sz), null, null, false);
  kit.add('seat', new RoundedBoxGeometry(0.1, 0.2, 0.28, 2, 0.04).rotateZ(0.2).translate(sx - 0.2, floor + 1.18, sz), null, null, false);
  kit.box('black', 0.08, 0.35, 0.06, x1 - 0.3, 1.95, -0.3); // gear selector
  kit.detail = false;
  // steering wheel: truck-flat wheel, column axis leaning 26° back from the
  // vertical (column runs forward-down into the dash); the spinner turns about it
  const wheelTilt = new THREE.Group();
  wheelTilt.position.set(7.22, 2.30, -0.70);
  wheelTilt.rotation.z = 0.45;
  cabGroup.add(wheelTilt);
  const wheel = new THREE.Group();
  wheel.name = 'steeringWheel';
  wheelTilt.add(wheel);
  const wk = new Kit(311);
  wk.add('black', mTorus(0.21, 0.018, 8, 28).rotateX(Math.PI / 2), null, null, false);
  wk.cyl('black', 0.05, 0.05, 0, 0, 0, 'y', 12);
  for (let i = 0; i < 3; i++) {
    const a = i * TAU / 3 + Math.PI / 2;
    wk.member('black', V(0, 0, 0), V(Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2), { k: 'box', w: 0.012, d: 0.04 }, UP, 0);
  }
  wk.cyl('black', 0.03, 0.35, 0, -0.18, 0, 'y', 8);
  wk.build(wheel, M);
  const eye = new THREE.Object3D();
  eye.name = 'driverEye';
  eye.position.set(AT100.driverCab.x, AT100.driverCab.z, -AT100.driverCab.y);
  cabGroup.add(eye);
  const beacons = [zOut + 0.12, zIn - 0.12].map((z) => {
    const b = new THREE.Object3D();
    b.position.set(x0 + 0.15, roof + 0.105, z);
    cabGroup.add(b);
    return b;
  });
  return { wheel, eye, beacons };
}

// ------------------------------------------------------------------ hook blocks
// Forged single hook (DIN 15401 shape) as the tower's, rescaled; saddle (the
// sling bearing point = hoist.hook) at the origin, shank up the +y axis.
export function hookGeometry(s = 1) {
  const pts = [
    [0, -0.735], [0, -0.785], [-0.03, -0.83], [-0.075, -0.874], [-0.092, -0.93], [-0.07, -0.975], [-0.025, -0.995],
    [0.03, -0.99], [0.078, -0.958], [0.102, -0.912], [0.1, -0.862], [0.086, -0.828],
  ].map(([x, y]) => V(x * s, (y + 0.955) * s, 0));
  const rad = (t) => s * (t < 0.15 ? 0.032 + t / 0.15 * 0.008 : t < 0.62 ? 0.04 + 0.005 * Math.sin((t - 0.15) / 0.47 * Math.PI) : 0.04 - (t - 0.62) / 0.38 * 0.021);
  return sweepGeo(pts, rad, { steps: 48, seg: 12, flat: 0.72, planar: true });
}
export const HOOK_SHANK = 0.22; // shank top above the saddle for s = 1
export function blockDef(id) {
  return HOOK_BLOCKS[id] || (id === 'hb100' ? HOOK_BLOCK_HB100 : HOOK_BLOCKS.ball);
}
