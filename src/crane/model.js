import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CRANE, ratedCapacity } from '../config.js';
import { pbrMaterial, textureSet } from '../world/assets.js';
import {
  Kit, mBox, mCyl, mTorus, mExtrude, boltGeo, sweepGeo, weathered, ropeMaterial, woundRopeTextures,
  Atlas, fitText, grunge, glassDirtTexture, hazardStripes, glassMaterial, WEAR_JOINT, WEAR_LIGHT, TAU,
} from './kit.js';

// Tower crane "TC-6010" (fictional 60 m flat-top/hammerhead, 8 t).
// Built from real section profiles (angle chords, CHS lacing, RHS rail
// chords, I-beam counter-jib) with gussets, fishplates and bolts, merged per
// material and moving part (mast sections are one InstancedMesh per
// material), so the whole crane is ~60 draw calls.
//
// Conventions (relied on by main.js / cameras.js — keep):
//  slew group at y = CRANE.mastTop, rotates about y; jibPivot at
//  (jibRootX, jibBottomY, 0); jib-local x runs 0 (root) → jibLength along the
//  bottom-chord centreline (y = 0); trolley child of jib, position.x set by
//  main, its sheave centres at y = -sheaveDrop with rope exits x = ±0.1/±0.5;
//  cab origin = cab floor centre, operator eye at (-0.22, 1.32, 0) looking +x.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();

// Linear-RGB tints over the neutral ~0.6 grey paint scan → RAL 1003 signal yellow
const YELLOW = new THREE.Color().setRGB(1.2, 0.72, 0.018);
const YELLOW_OLD = new THREE.Color().setRGB(1.04, 0.6, 0.018);

// Section library (metres)
const SEC = {
  mastChord: { k: 'L', w: 0.16, th: 0.016 },
  mastBrace: { k: 'L', w: 0.075, th: 0.008 },
  headLeg: { k: 'box', w: 0.16, d: 0.16 },
  headBrace: { k: 'L', w: 0.065, th: 0.007 },
  jibBottom: { k: 'box', w: 0.14, d: 0.12 },
  jibFlange: { k: 'box', w: 0.018, d: 0.24, ox: -0.079 },
  jibTop: { k: 'tube', r: 0.065, seg: 10 },
  jibDiag: { k: 'tube', r: 0.036, seg: 8 },
  jibLace: { k: 'tube', r: 0.028, seg: 7 },
  cjGirder: { k: 'I', h: 0.36, b: 0.15, tw: 0.011, tf: 0.017 },
  cjCross: { k: 'I', h: 0.2, b: 0.1, tw: 0.007, tf: 0.011 },
  cjBrace: { k: 'L', w: 0.07, th: 0.007 },
  tie: { k: 'box', w: 0.12, d: 0.034 },
  rail: { k: 'tube', r: 0.022, seg: 7 },
  post: { k: 'tube', r: 0.022, seg: 7 },
  toe: { k: 'box', w: 0.1, d: 0.006 },
  rung: { k: 'tube', r: 0.013, seg: 6 },
  stile: { k: 'box', w: 0.012, d: 0.065 },
  strap: { k: 'box', w: 0.006, d: 0.04 },
};

// ------------------------------------------------------------ materials
export function createCraneMaterials() {
  // Semi-gloss alkyd/PU coat (roughness ~0.45) so round members get a real
  // specular sheen. The scan's brush-stroke normals read as wood grain when
  // enlarged along a member, so they are kept small (0.8 m tile) and faint;
  // the weathering (joint rust, blotches, top dust) comes from the shader.
  const paint = (color, w = {}, o = {}) =>
    weathered(pbrMaterial('metal_painted', { color, metalness: 0, roughness: 0.8, normalScale: 0.18, repeat: 1.25, ...o }), { contrast: 0.3, ...w });
  const paintSet = textureSet('metal_painted');

  const hazard = weathered(new THREE.MeshStandardMaterial({ map: hazardStripes().clone(), roughness: 0.55, metalness: 0 }), { rust: 0.8, dirt: 1.2 });
  hazard.map.repeat.set(2.5, 2.5);
  if (paintSet) { hazard.normalMap = paintSet.normalMap.clone(); hazard.normalMap.repeat.set(1.25, 1.25); hazard.normalScale.set(0.2, 0.2); }

  const wound = woundRopeTextures();
  const ropeWound = new THREE.MeshStandardMaterial({
    color: 0x8d9195, map: wound.map.clone(), normalMap: wound.normalMap.clone(), roughness: 0.45, metalness: 0.9,
  });
  ropeWound.map.repeat.set(1 / 0.12, 1 / 0.088); // u: around the drum (m), v: along the axis, 22 mm turns
  ropeWound.normalMap.repeat.copy(ropeWound.map.repeat);

  const dirt = glassDirtTexture(5, false), wiped = glassDirtTexture(9, true);
  const atlas = craneAtlas();

  const mats = {
    // structure paint (weathered)
    yellow: paint(YELLOW, { rust: 1, dirt: 1, dust: 0.75 }),
    yellowDark: paint(YELLOW_OLD, { rust: 1.25, dirt: 1.3 }),
    grey: paint(new THREE.Color().setRGB(0.95, 0.98, 0.96), { rust: 0.5, dirt: 1.2 }), // RAL 7035 machinery
    machine: paint(new THREE.Color().setRGB(0.12, 0.17, 0.24), { rust: 0.4, dirt: 0.8 }, { roughness: 0.8 }), // motors
    white: paint(new THREE.Color().setRGB(1.2, 1.2, 1.17), { rust: 0.35, dirt: 1.4 }), // cab skin
    // cab structure: light grey (RAL 7035-ish) like current cab designs; the
    // dark look comes from the rubber window seals + tinted glass, not the frame
    cabBody: paint(new THREE.Color().setRGB(0.88, 0.9, 0.9), { rust: 0.3, dirt: 1.5 }),
    cabFrame: paint(new THREE.Color().setRGB(0.06, 0.065, 0.07), { rust: 0.4, dirt: 0.6 }),
    hazard,
    red: paint(new THREE.Color().setRGB(0.95, 0.04, 0.02), { rust: 0.6, dirt: 0.8 }),
    // bare metal
    darkSteel: pbrMaterial('galvanized_metal', { color: new THREE.Color().setRGB(0.32, 0.31, 0.3), roughness: 1.15 }),
    galv: pbrMaterial('galvanized_metal', { roughness: 1.05 }),
    grating: pbrMaterial('metal_grating', { repeat: 2, roughness: 1.1 }),
    rope: ropeMaterial(),
    ropeWound,
    // concrete
    concrete: pbrMaterial('concrete_rough', { repeat: 0.5, albedo: 0.3 }),
    concreteSlab: pbrMaterial('concrete_slab', { repeat: 1 / 3, albedo: 0.24 }),
    // glazing: separate outside / inside skins (single-sided) so the outside
    // reads as dark reflective glass while the operator looks through a clear,
    // slightly dusty pane.
    // outside skin: solar-tinted, the dim interior behind it makes real cab glass
    // read dark with sky reflections rather than see-through
    glass: glassMaterial({ color: 0x0b1115, opacity: 0.46, envMapIntensity: 1.9 }),
    glassIn: new THREE.MeshStandardMaterial({ map: dirt, color: 0xffffff, roughness: 0.6, metalness: 0, transparent: true, depthWrite: false }),
    glassWiped: new THREE.MeshStandardMaterial({ map: wiped, color: 0xffffff, roughness: 0.6, metalness: 0, transparent: true, depthWrite: false }),
    // plastics, rubber, fabric
    black: new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.55, metalness: 0 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x0d0d0e, roughness: 0.9, metalness: 0 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.95, metalness: 0 }),
    // interior trim: light grey moulded panels (a dark trim turns the glazed cab into a cave)
    panel: new THREE.MeshStandardMaterial({ color: 0x9da2a6, roughness: 0.7, metalness: 0 }),
    blind: new THREE.MeshStandardMaterial({ color: 0x0b0c0d, roughness: 0.8, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false }),
    amber: new THREE.MeshStandardMaterial({ color: 0xff8a00, emissive: 0xff6a00, emissiveIntensity: 0.25, roughness: 0.25, transparent: true, opacity: 0.85 }),
    // lights driven by main.js (emissiveIntensity)
    obstacle: new THREE.MeshStandardMaterial({ color: 0x5a0805, emissive: 0xff1a0a, emissiveIntensity: 0, roughness: 0.25 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xd8dde2, emissive: 0xfff2d0, emissiveIntensity: 0, roughness: 0.2 }),
    decal: new THREE.MeshStandardMaterial({
      map: atlas.texture(), alphaTest: 0.45, roughness: 0.62, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
  };
  mats.decal.userData.atlas = atlas;
  mats.concrete.name = 'counterweight';
  return mats;
}

// ------------------------------------------------------------ decals
function craneAtlas() {
  const A = new Atlas(1024, 1024);
  const sans = 'Arial, Helvetica, sans-serif';
  const stencil = 'Impact, "Arial Narrow", Arial, sans-serif';
  A.add('name', 1000, 150, (c, w, h) => {
    c.fillStyle = '#dcd9cf'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#e8a300'; c.fillRect(0, 0, w, 12); c.fillRect(0, h - 12, w, 12);
    c.fillStyle = '#17181a'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, 'TC-6010', w * 0.5, h * 0.53, w * 0.62, 112, sans, '900');
    grunge(c, w, h, 4, 0.5);
    // rain-washed dirt running down from the top edge
    for (let i = 0; i < 70; i++) {
      const x = (i * 97.3) % w, len = 20 + ((i * 53) % 110);
      const gr = c.createLinearGradient(0, 0, 0, len);
      gr.addColorStop(0, 'rgba(70,60,45,0.22)'); gr.addColorStop(1, 'rgba(70,60,45,0)');
      c.fillStyle = gr; c.fillRect(x, 0, 2 + (i % 4) * 2, len);
    }
  });
  for (const [k, t] of [['swl4', 'SWL 4 t'], ['swl8', 'SWL 8 t']]) {
    A.add(k, 240, 104, (c, w, h) => {
      c.fillStyle = '#f2b705'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#111'; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8);
      c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
      fitText(c, t, w / 2, h / 2 + 2, w - 36, 64, sans, '900');
      grunge(c, w, h, 7, 0.6);
    });
  }
  for (const r of [20, 30, 40, 50, 60]) {
    A.add('rad' + r, 150, 150, (c, w, h) => {
      c.fillStyle = '#f2b705'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#111'; c.lineWidth = 7; c.strokeRect(4, 4, w - 8, h - 8);
      c.fillRect(10, h / 2 - 2, w - 20, 4);
      c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
      fitText(c, `${r} m`, w / 2, h * 0.28, w - 26, 50, sans, '900');
      fitText(c, `${(ratedCapacity(r, 4) / 1000).toFixed(1)} t`, w / 2, h * 0.74, w - 26, 50, sans, '900');
      grunge(c, w, h, r, 0.7);
    });
  }
  A.add('cw', 256, 120, (c, w, h) => {
    c.fillStyle = '#ebe6d6'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, '3.5 t', w / 2, h / 2, w - 20, 104, stencil, 'normal');
    c.globalCompositeOperation = 'destination-out'; // stencil bridges + wear
    c.fillRect(0, h * 0.48, w, 5);
    grunge(c, w, h, 12, 1.4, 'rgba(0,0,0,');
    c.globalCompositeOperation = 'source-over';
  });
  A.add('plate', 256, 150, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#c9ccce'); g.addColorStop(0.5, '#a9adb1'); g.addColorStop(1, '#c2c5c8');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#333'; c.lineWidth = 3; c.strokeRect(8, 8, w - 16, h - 16);
    c.fillStyle = '#1a1a1a'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.font = `900 30px ${sans}`; c.fillText('TC-6010', 20, 42);
    c.font = `bold 15px ${sans}`;
    ['TOWER CRANE  EN 14439', 'SERIAL No  60-0417', 'YEAR  2024', 'MAX LOAD  8000 kg'].forEach((s, i) => c.fillText(s, 20, 68 + i * 19));
    c.fillStyle = '#555';
    for (const [x, y] of [[16, 16], [w - 16, 16], [16, h - 16], [w - 16, h - 16]]) { c.beginPath(); c.arc(x, y, 4, 0, TAU); c.fill(); }
  });
  const tri = (c, w, h, sym) => {
    c.fillStyle = '#111'; c.beginPath(); c.moveTo(w / 2, 2); c.lineTo(w - 2, h - 2); c.lineTo(2, h - 2); c.closePath(); c.fill();
    c.fillStyle = '#f7c600'; c.beginPath(); c.moveTo(w / 2, 13); c.lineTo(w - 11, h - 7); c.lineTo(11, h - 7); c.closePath(); c.fill();
    c.fillStyle = '#111'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `900 44px ${sans}`; c.fillText(sym, w / 2, h * 0.62);
  };
  A.add('warn', 96, 84, (c, w, h) => tri(c, w, h, '!'));
  A.add('elec', 96, 84, (c, w, h) => tri(c, w, h, '⚡'));
  A.add('chart', 256, 180, (c, w, h) => {
    c.fillStyle = '#f1f1ee'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#c21d12'; c.fillRect(0, 0, w, 26);
    c.fillStyle = '#fff'; c.font = `bold 16px ${sans}`; c.textAlign = 'center'; c.fillText('LOAD CHART  TC-6010', w / 2, 19);
    c.fillStyle = '#111'; c.font = `bold 13px ${sans}`; c.textAlign = 'left';
    [[13.5, 8000], [20, 5200], [30, 3200], [40, 2200], [50, 1650], [60, 1300]].forEach(([r, q], i) => {
      c.fillText(`${r} m`, 24, 50 + i * 21); c.fillText(`${q} kg`, 130, 50 + i * 21);
    });
    c.strokeStyle = '#999'; c.lineWidth = 1;
    for (let i = 0; i < 7; i++) { c.beginPath(); c.moveTo(16, 34 + i * 21 + 21); c.lineTo(w - 16, 34 + i * 21 + 21); c.stroke(); }
  });
  A.add('grille', 128, 128, (c, w, h) => {
    c.fillStyle = '#1b1c1e'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#6d7075'; c.lineWidth = 3;
    for (let r = 10; r < 64; r += 9) { c.beginPath(); c.arc(w / 2, h / 2, r, 0, TAU); c.stroke(); }
    c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.moveTo(w / 2, 0); c.lineTo(w / 2, h); c.stroke();
  });
  A.add('louvre', 128, 96, (c, w, h) => {
    c.fillStyle = '#b9bdbc'; c.fillRect(0, 0, w, h);
    for (let y = 8; y < h - 6; y += 11) { c.fillStyle = '#2b2d2f'; c.fillRect(8, y, w - 16, 5); c.fillStyle = '#e0e3e2'; c.fillRect(8, y + 5, w - 16, 2); }
  });
  return A;
}

function lmiScreenTexture() {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const x = c.getContext('2d');
  x.fillStyle = '#06110d'; x.fillRect(0, 0, 320, 200);
  x.fillStyle = '#123a2b'; x.fillRect(0, 0, 320, 26);
  x.fillStyle = '#9ff5c8'; x.font = 'bold 15px monospace'; x.fillText('LMI  TC-6010   4 FALLS', 10, 18);
  x.font = 'bold 26px monospace';
  x.fillStyle = '#e8fff2'; x.fillText('R 18.0 m', 12, 62); x.fillText('Q 1.20 t', 12, 96);
  x.fillStyle = '#7fd9a8'; x.font = 'bold 15px monospace'; x.fillText('Qmax 5.84 t', 12, 122); x.fillText('H 26.4 m', 180, 62); x.fillText('WIND 4.2 m/s', 180, 96);
  x.strokeStyle = '#7fd9a8'; x.strokeRect(12, 140, 296, 22);
  x.fillStyle = '#35c47a'; x.fillRect(14, 142, 60, 18);
  x.fillStyle = '#9ff5c8'; x.font = 'bold 13px monospace'; x.fillText('21 %', 140, 156);
  x.fillText('SLEW 0.0°   TROLLEY ▸   HOIST ▴', 12, 186);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------ helpers
function bolt(kit, p, n, d = 0.022, key = 'darkSteel', washer = true) {
  _q.setFromUnitVectors(UP, n);
  _m.makeRotationFromQuaternion(_q).setPosition(p);
  kit.add(key, boltGeo(d, 0.018, washer), _m.clone(), null, false);
}

function decal(kit, atlas, name, w, h, pos, normal, rotZ = 0) {
  const g = atlas.quad(name, w, h);
  if (rotZ) g.rotateZ(rotZ);
  _q.setFromUnitVectors(V(0, 0, 1), normal.clone().normalize());
  _m.makeRotationFromQuaternion(_q).setPosition(pos);
  kit.add('decal', g, _m.clone(), null, false);
}

// Guard rail along a polyline of deck points: posts, top/knee rails, toe board.
function handrail(kit, pts, { h = 1.1, spacing = 1.5, key = 'yellow', toe = true } = {}) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const L = a.distanceTo(b);
    const n = Math.max(1, Math.round(L / spacing));
    for (let k = 0; k <= n; k++) {
      if (k === n && i < pts.length - 2) continue;
      const p = a.clone().lerp(b, k / n);
      kit.member(key, p, p.clone().setY(p.y + h), SEC.post, null, 0.5);
    }
    kit.member(key, a.clone().setY(a.y + h), b.clone().setY(b.y + h), SEC.rail, null, 0.4);
    kit.member(key, a.clone().setY(a.y + h * 0.5), b.clone().setY(b.y + h * 0.5), SEC.rail, null, 0.4);
    if (toe) kit.member(key, a.clone().setY(a.y + 0.06), b.clone().setY(b.y + 0.06), SEC.toe, UP, 0.8);
  }
}

// Vertical ladder in the plane z = z0 (stiles at x0 ± 0.2), climber on the
// +side (z0 + side), optional back hoops every 0.9 m with 5 vertical straps.
function ladder(kit, x0, z0, y0, y1, { side = 1, hoops = true, key = 'galv', hoopFrom = 2.2 } = {}) {
  const hw = 0.2;
  kit.member(key, V(x0 - hw, y0, z0), V(x0 - hw, y1, z0), SEC.stile, V(0, 0, 1), 0.3);
  kit.member(key, V(x0 + hw, y0, z0), V(x0 + hw, y1, z0), SEC.stile, V(0, 0, 1), 0.3);
  for (let y = y0 + 0.2; y < y1 - 0.05; y += 0.28) kit.member(key, V(x0 - hw, y, z0), V(x0 + hw, y, z0), SEC.rung, null, 0);
  if (!hoops || y1 - y0 < hoopFrom) return;
  const R = 0.36;
  const cz = z0 + side * 0.32;
  const ys = [];
  for (let y = y0 + hoopFrom; y < y1 - 0.2; y += 0.9) ys.push(y);
  for (const y of ys) {
    const g = mTorus(R, 0.01, 5, 14, Math.PI);
    g.rotateX(Math.PI / 2); // half ring in the x-z plane, bulging to +z
    if (side < 0) g.rotateY(Math.PI);
    g.translate(x0, y, cz);
    kit.add(key, g, null, WEAR_LIGHT);
    for (const sx of [-1, 1]) kit.member(key, V(x0 + sx * 0.2, y, z0), V(x0 + sx * R, y, cz), SEC.strap, UP, 0.3);
  }
  if (ys.length) {
    const ya = Math.max(y0, ys[0] - 0.5), yb = Math.min(y1, ys[ys.length - 1] + 0.7);
    for (let k = 1; k < 6; k++) {
      const a = (k / 6) * Math.PI;
      const x = x0 + Math.cos(a) * R, z = cz + side * Math.sin(a) * R;
      kit.member(key, V(x, ya, z), V(x, yb, z), SEC.strap, V(-Math.cos(a), 0, -side * Math.sin(a)), 0.3);
    }
  }
}

// Sheave: disc with a rope groove (axis along z, centred), for kit bins
function sheaveGeo(r, w) {
  const pts = [
    V(0.03, -w / 2, 0), V(r * 0.55, -w / 2, 0), V(r * 0.7, -w * 0.35, 0), V(r, -w / 2, 0), V(r, -w * 0.4, 0),
    V(r - 0.022, -w * 0.08, 0), V(r - 0.022, w * 0.08, 0), V(r, w * 0.4, 0), V(r, w / 2, 0), V(r * 0.7, w * 0.35, 0),
    V(r * 0.55, w / 2, 0), V(0.03, w / 2, 0),
  ].map((p) => new THREE.Vector2(p.x, p.y));
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(Math.PI / 2);
  return g;
}

// Soft radial glow for the aviation lights: a 0.14 m dome is only a pixel or
// two from the cab or the street, but the real lights read as a red halo
// (lamp flare + the moist air around it). Driven off the dome's emissive.
let _glowMat = null;
function glowMaterial() {
  if (_glowMat) return _glowMat;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _glowMat = new THREE.SpriteMaterial({
    map: t, color: 0xff2410, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, opacity: 0,
  });
  return _glowMat;
}

function obstacleLight(kit, parent, list, mats, x, y, z) {
  // LED obstruction light: grey base + red dome (the dome is main's emissive mesh)
  kit.cyl('grey', 0.075, 0.07, x, y - 0.075, z, 'y', 14);
  kit.cyl('darkSteel', 0.05, 0.02, x, y - 0.03, z, 'y', 12);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.068, 16, 8, 0, TAU, 0, Math.PI / 2), mats.obstacle);
  dome.position.set(x, y - 0.03, z);
  dome.scale.y = 1.2;
  parent.add(dome);
  list.push(dome);
  const glow = new THREE.Sprite(glowMaterial());
  glow.position.set(x, y + 0.02, z);
  glow.scale.setScalar(1.6);
  glow.castShadow = false;
  // main.js sets emissiveIntensity to 2 + 6·night when lit, ~0 when off:
  // the halo only shows against the dark sky
  glow.onBeforeRender = () => { glow.material.opacity = THREE.MathUtils.clamp((mats.obstacle.emissiveIntensity - 2.5) / 5.5, 0, 1); };
  parent.add(glow);
}

// ------------------------------------------------------------ mast
function buildMast(mats) {
  const g = new THREE.Group();
  g.name = 'mast';
  const w = CRANE.mastWidth / 2, H = CRANE.mastSectionHeight, N = CRANE.mastSections;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  // --- one 3 m section, instanced N times
  const kit = new Kit(11);
  for (const [sx, sz] of corners) {
    const ref = sx === sz ? V(-sx, 0, 0) : V(0, 0, -sz);
    kit.member('yellow', V(sx * w, 0, sz * w), V(sx * w, H, sz * w), SEC.mastChord, ref, 1);
    // fishplates spanning the joint to the section below (2 per chord) + bolts
    const pa = V(sx * (w - 0.085), 0, sz * (w + 0.009)), pb = V(sx * (w + 0.009), 0, sz * (w - 0.085));
    kit.box('yellowDark', 0.14, 0.5, 0.018, pa.x, 0, pa.z, null, WEAR_JOINT);
    kit.box('yellowDark', 0.018, 0.5, 0.14, pb.x, 0, pb.z, null, WEAR_JOINT);
    for (const y of [-0.18, -0.07, 0.07, 0.18]) {
      for (const o of [-0.035, 0.035]) {
        bolt(kit, V(pa.x + o, y, sz * (w + 0.018)), V(0, 0, sz), 0.022, 'darkSteel', false);
        bolt(kit, V(sx * (w + 0.018), y, pb.z + o), V(sx, 0, 0), 0.022, 'darkSteel', false);
      }
    }
    // end plates at the chord splice
    kit.box('yellowDark', 0.2, 0.025, 0.2, sx * (w - 0.08), 0.0125, sz * (w - 0.08), null, WEAR_JOINT);
  }
  const levels = [0.15, 1.5, 2.85];
  for (let f = 0; f < 4; f++) {
    const [ax, az] = corners[f], [bx, bz] = corners[(f + 1) % 4];
    const n = V((ax + bx) / 2, 0, (az + bz) / 2).normalize(); // outward face normal
    const t = V(bx - ax, 0, bz - az).normalize();
    const inset = w - 0.024;
    const node = (c, y, dir) => V(c[0] * w, y, c[1] * w).addScaledVector(t, dir * 0.085).addScaledVector(n, -(w - inset));
    const A = (y) => node(corners[f], y, 1), B = (y) => node(corners[(f + 1) % 4], y, -1);
    const inward = n.clone().negate();
    for (const y of levels) kit.member('yellow', A(y), B(y), SEC.mastBrace, inward, 0.8);
    const odd = f % 2 === 1;
    kit.member('yellow', odd ? B(levels[0]) : A(levels[0]), odd ? A(levels[1]) : B(levels[1]), SEC.mastBrace, inward, 0.8);
    kit.member('yellow', odd ? A(levels[1]) : B(levels[1]), odd ? B(levels[2]) : A(levels[2]), SEC.mastBrace, inward, 0.8);
    // gusset plates + 2 bolts at every node
    for (const y of levels) {
      for (const [c, dir] of [[corners[f], 1], [corners[(f + 1) % 4], -1]]) {
        const p = V(c[0] * w, y, c[1] * w).addScaledVector(t, dir * 0.12).addScaledVector(n, -0.022);
        _q.setFromUnitVectors(V(0, 0, 1), n);
        _m.makeRotationFromQuaternion(_q).setPosition(p);
        kit.add('yellowDark', mBox(0.2, 0.2, 0.012), _m.clone(), WEAR_JOINT);
        for (const dy of [-0.05, 0.05]) bolt(kit, V(c[0] * w, y + dy, c[1] * w).addScaledVector(t, dir * 0.07).addScaledVector(n, 0.001), n, 0.018, 'darkSteel', false);
      }
    }
  }
  ladder(kit, 0, -w + 0.3, 0, H, { side: 1, hoops: true, hoopFrom: 0.5 });
  const inst = [], cols = [];
  for (let s = 0; s < N; s++) {
    inst.push(new THREE.Matrix4().makeTranslation(0, s * H, 0));
    const k = 0.9 + ((s * 37) % 11) / 11 * 0.16; // sections repainted / swapped at different times
    cols.push(new THREE.Color(k, k * (0.98 + ((s * 13) % 5) * 0.008), k * 0.97));
  }
  kit.build(g, mats, { instances: inst, colors: cols });

  // --- static parts: foundation, anchors, rest platforms, top support + ring
  const st = new Kit(12);
  st.box('concreteSlab', 6.5, 1.4, 6.5, 0, -0.55, 0);
  st.box('concrete', 2.3, 0.05, 2.3, 0, 0.175, 0); // grout pad under the base
  for (const [sx, sz] of corners) {
    const cx = sx * (w - 0.08), cz = sz * (w - 0.08);
    st.box('yellowDark', 0.46, 0.04, 0.46, cx, 0.22, cz, null, WEAR_JOINT);
    st.box('yellowDark', 0.26, 0.22, 0.26, cx, 0.35, cz, null, WEAR_JOINT); // fixing anchor shoe
    for (const [ox, oz] of [[-0.17, -0.17], [0.17, -0.17], [0.17, 0.17], [-0.17, 0.17]]) {
      st.cyl('darkSteel', 0.018, 0.14, cx + ox, 0.29, cz + oz, 'y', 8);
      st.add('darkSteel', mCyl(0.036, 0.036, 0.034, 6).translate(cx + ox, 0.257, cz + oz), null, null, false);
    }
  }
  // rest platforms every 3 sections (grating with a ladder hatch)
  for (let s = 3; s < N; s += 3) {
    const y = s * H + 0.16;
    st.box('grating', 1.42, 0.03, 0.48, 0, y, 0.47);
    st.box('grating', 0.31, 0.03, 0.96, -0.555, y, -0.24);
    st.box('grating', 0.31, 0.03, 0.96, 0.555, y, -0.24);
    st.box('galv', 1.44, 0.06, 0.03, 0, y - 0.01, 0.23);
    st.box('galv', 0.03, 0.06, 0.96, -0.4, y - 0.01, -0.24);
    st.box('galv', 0.03, 0.06, 0.96, 0.4, y - 0.01, -0.24);
  }
  // slewing support frame + fixed toothed ring on the mast head
  const top = N * H;
  st.box('yellow', 1.9, 0.2, 1.9, 0, top + 0.1, 0, null, WEAR_LIGHT);
  for (const [sx, sz] of corners) st.box('yellowDark', 0.36, 0.3, 0.36, sx * 0.78, top + 0.05, sz * 0.78, null, WEAR_JOINT);
  const gear = new THREE.Shape();
  const Z = 96, r0 = 1.17, r1 = 1.21;
  for (let i = 0; i < Z; i++) {
    const a = (i / Z) * TAU, p = TAU / Z;
    const pts = [[a, r0], [a + p * 0.18, r1], [a + p * 0.5, r1], [a + p * 0.68, r0]];
    pts.forEach(([aa, rr], k) => (i === 0 && k === 0 ? gear.moveTo(Math.cos(aa) * rr, Math.sin(aa) * rr) : gear.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr)));
  }
  gear.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 0.93, 0, TAU, true);
  gear.holes.push(hole);
  const ring = mExtrude(gear, 0.13, { curveSegments: 48 });
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, top + 0.2, 0);
  st.add('darkSteel', ring, null, null, false);
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * TAU;
    bolt(st, V(Math.cos(a) * 1.0, top + 0.33, Math.sin(a) * 1.0), UP, 0.02);
  }
  st.build(g, mats);
  return g;
}

// ------------------------------------------------------------ slewing part
function buildSlewStatic(slew, mats) {
  const kit = new Kit(21);
  const TT = CRANE.turntableHeight;
  // upper race of the slewing ring + turntable box girder
  kit.cyl('darkSteel', 1.12, 0.1, 0, 0.38, 0, 'y', 48);
  kit.box('yellow', 2.4, 0.78, 2.4, 0, 0.81, 0, null, WEAR_LIGHT);
  kit.box('yellow', 2.48, 0.03, 2.48, 0, TT - 0.015, 0, null, WEAR_LIGHT);
  kit.box('yellowDark', 2.3, 0.04, 2.3, 0, 0.44, 0);
  for (let f = 0; f < 4; f++) {
    const rot = [0, 0, 0];
    for (let k = -2; k <= 2; k++) {
      const s = k * 0.45;
      const x = f === 0 ? 1.225 : f === 1 ? -1.225 : s, z = f < 2 ? s : f === 2 ? 1.225 : -1.225;
      kit.box('yellow', f < 2 ? 0.05 : 0.02, 0.7, f < 2 ? 0.02 : 0.05, x, 0.8, z, rot, WEAR_LIGHT);
    }
  }
  // manhole cover
  kit.cyl('yellowDark', 0.22, 0.02, 0, 0.8, -1.21, 'z', 24);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    bolt(kit, V(Math.cos(a) * 0.18, 0.8 + Math.sin(a) * 0.18, -1.22), V(0, 0, -1), 0.016);
  }
  // slewing drives (2): pinion on the fixed ring, planetary gearbox, motor, brake + fan cowl
  for (const s of [-1, 1]) {
    const a = Math.PI - s * 0.52;
    const x = Math.cos(a) * 1.31, z = Math.sin(a) * 1.31;
    kit.cyl('darkSteel', 0.1, 0.13, x, 0.265, z, 'y', 18);
    kit.cyl('grey', 0.19, 0.78, x, 0.82, z, 'y', 20, WEAR_LIGHT);
    kit.cyl('grey', 0.23, 0.05, x, 0.64, z, 'y', 20);
    kit.box('yellowDark', 0.52, 0.04, 0.52, x + 0.06, TT + 0.02, z, null, WEAR_JOINT);
    kit.cyl('grey', 0.23, 0.06, x, TT + 0.07, z, 'y', 20);
    kit.cyl('machine', 0.165, 0.46, x, TT + 0.33, z, 'y', 20);
    for (let i = 0; i < 10; i++) {
      const b = (i / 10) * TAU;
      kit.box('machine', 0.022, 0.4, 0.035, x + Math.cos(b) * 0.175, TT + 0.33, z + Math.sin(b) * 0.175, [0, -b, 0]);
    }
    kit.cyl('grey', 0.18, 0.16, x, TT + 0.64, z, 'y', 20);
    kit.cyl('grey', 0.15, 0.03, x, TT + 0.735, z, 'y', 20);
    kit.box('grey', 0.14, 0.12, 0.12, x + 0.2, TT + 0.42, z, [0, -a, 0]);
    kit.cyl('rubber', 0.02, 0.3, x + 0.22, TT + 0.2, z, 'y', 6);
  }
  // cathead (A-frame tower head), 4 SHS legs + angle lacing
  const H = CRANE.catheadHeight;
  const base = 0.9, topS = 0.24;
  const s = (y) => base - (base - topS) * (y - TT) / (H - TT);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of corners) {
    kit.member('yellow', V(sx * base, TT, sz * base), V(sx * topS, H, sz * topS), SEC.headLeg, null, 1);
    kit.box('yellowDark', 0.34, 0.04, 0.34, sx * base, TT + 0.02, sz * base, null, WEAR_JOINT);
  }
  const NL = 6;
  for (let k = 1; k < NL; k++) {
    const y = TT + (H - TT) * k / NL, yp = TT + (H - TT) * (k - 1) / NL;
    for (let f = 0; f < 4; f++) {
      const [ax, az] = corners[f], [bx, bz] = corners[(f + 1) % 4];
      const n = V((ax + bx) / 2, 0, (az + bz) / 2);
      kit.member('yellow', V(ax * s(y), y, az * s(y)), V(bx * s(y), y, bz * s(y)), SEC.headBrace, n.clone().negate(), 0.8);
      const flip = (k + f) % 2 === 0;
      kit.member('yellow', flip ? V(ax * s(yp), yp, az * s(yp)) : V(bx * s(yp), yp, bz * s(yp)),
        flip ? V(bx * s(y), y, bz * s(y)) : V(ax * s(y), y, az * s(y)), SEC.headBrace, n.clone().negate(), 0.8);
    }
  }
  // head: pin plates for the pendants
  kit.box('yellow', 0.52, 0.42, 0.52, 0, H + 0.1, 0, null, WEAR_LIGHT);
  for (const z of [-0.09, 0.09]) kit.box('yellowDark', 1.0, 0.36, 0.03, 0, H - 0.02, z, null, WEAR_JOINT);
  for (const x of [-0.4, 0.4]) {
    kit.cyl('darkSteel', 0.038, 0.34, x, H - 0.02, 0, 'z', 12);
    for (const z of [-0.17, 0.17]) kit.cyl('darkSteel', 0.05, 0.015, x, H - 0.02, z, 'z', 12);
  }
  // head platform + rail, obstacle-light mast
  const PY = H + 0.31;
  kit.box('grating', 1.3, 0.03, 1.3, 0, PY, 0);
  kit.box('yellowDark', 1.34, 0.06, 1.34, 0, PY - 0.04, 0);
  handrail(kit, [V(-0.65, PY, -0.65), V(0.65, PY, -0.65), V(0.65, PY, 0.65), V(-0.65, PY, 0.65), V(-0.65, PY, -0.65)], { h: 0.9, spacing: 0.7 });
  kit.member('yellow', V(0, PY, 0), V(0, H + 1.26, 0), { k: 'tube', r: 0.03, seg: 8 }, null, 0.3);
  ladder(kit, 0, 0, TT, H - 0.25, { side: 1, hoops: false });
  // jib foot: pinned lugs on the tower head legs
  const JB = CRANE.jibBottomY, JR = CRANE.jibRootX;
  kit.member('yellow', V(s(JB) - 0.02, JB, -s(JB)), V(s(JB) - 0.02, JB, s(JB)), { k: 'box', w: 0.26, d: 0.16 }, UP, 0.6);
  for (const z of [-0.8, 0.8]) {
    for (const dz of [-0.09, 0.09]) kit.box('yellowDark', JR - s(JB) + 0.2, 0.26, 0.03, (s(JB) + JR) / 2 + 0.02, JB, z + dz, null, WEAR_JOINT);
    kit.cyl('darkSteel', 0.04, 0.3, JR - 0.02, JB, z, 'z', 12);
  }
  const JT = JB + CRANE.jibHeight;
  kit.member('yellow', V(s(JT), JT, -s(JT)), V(s(JT), JT, s(JT)), { k: 'box', w: 0.2, d: 0.14 }, UP, 0.6);
  for (const dz of [-0.07, 0.07]) kit.box('yellowDark', JR - s(JT) + 0.15, 0.22, 0.025, (s(JT) + JR) / 2, JT, dz, null, WEAR_JOINT);
  kit.cyl('darkSteel', 0.035, 0.22, JR - 0.03, JT, 0, 'z', 12);
  // counter-jib root beam (its girders butt against it) + brackets
  const CY = JB - 0.1;
  kit.member('yellow', V(-1.0, CY, -1.1), V(-1.0, CY, 1.1), SEC.cjGirder, UP, 0.7);
  for (const z of [-1, 1]) kit.member('yellow', V(-s(CY), CY, z * s(CY)), V(-1.0, CY, z * 1.02), { k: 'box', w: 0.22, d: 0.14 }, UP, 0.8);
  for (const z of [-1, 1]) kit.member('yellow', V(-s(CY + 1.6), CY + 1.6, z * s(CY + 1.6)), V(-1.0, CY + 0.15, z * 1.08), { k: 'box', w: 0.12, d: 0.1 }, null, 0.8);
  // walkway on the -z side of the turntable (+ rail)
  kit.box('grating', 2.3, 0.03, 0.7, 0.05, TT - 0.015, -1.6);
  for (const x of [-1.05, 1.1]) kit.member('yellowDark', V(x, TT - 0.06, -1.24), V(x, TT - 0.06, -1.95), { k: 'C', h: 0.1, b: 0.05, tw: 0.006, tf: 0.008 }, UP, 0.5);
  handrail(kit, [V(-1.05, TT, -1.95), V(1.15, TT, -1.95), V(1.15, TT, -1.25)]);
  // cable tray from the counter-jib down to the turntable and over to the cab
  const tray = (a, b) => {
    kit.member('galv', a, b, { k: 'box', w: 0.012, d: 0.3 }, UP, 0);
    for (const dz of [-0.15, 0.15]) kit.member('galv', a.clone().add(V(0, 0.03, dz)), b.clone().add(V(0, 0.03, dz)), { k: 'box', w: 0.06, d: 0.004 }, UP, 0);
    for (const dz of [-0.07, 0, 0.07]) kit.member('rubber', a.clone().add(V(0, 0.03, dz)), b.clone().add(V(0, 0.03, dz)), { k: 'tube', r: 0.018, seg: 6 }, null, 0);
  };
  tray(V(-0.95, TT + 0.05, 0.62), V(0.3, TT + 0.05, 0.62));
  kit.member('rubber', V(-0.95, TT + 0.08, 0.62), V(-1.2, CY + 0.25, 0.9), { k: 'tube', r: 0.035, seg: 6 }, null, 0);
  // cab support: cantilever beams + struts, rear access platform
  const CZ0 = 1.2, CZ1 = 2.95, FY = TT - 0.2;
  for (const x of [0.55, 1.52]) { // under the solid rear floor, clear of the floor window
    kit.member('yellow', V(x, FY - 0.1, CZ0), V(x, FY - 0.1, CZ1), { k: 'I', h: 0.2, b: 0.1, tw: 0.008, tf: 0.012 }, UP, 0.8);
    kit.member('yellow', V(x, 0.5, CZ0 + 0.03), V(x, FY - 0.18, CZ1 - 0.35), { k: 'box', w: 0.1, d: 0.1 }, null, 0.8);
  }
  kit.box('grating', 0.95, 0.03, CZ1 - CZ0, -0.1, FY - 0.015, (CZ0 + CZ1) / 2);
  kit.member('yellowDark', V(-0.6, FY - 0.08, CZ1), V(0.4, FY - 0.08, CZ1), { k: 'C', h: 0.12, b: 0.05, tw: 0.006, tf: 0.008 }, UP, 0.5);
  kit.member('yellowDark', V(-0.6, FY - 0.08, CZ0), V(-0.6, FY - 0.08, CZ1), { k: 'C', h: 0.12, b: 0.05, tw: 0.006, tf: 0.008 }, UP, 0.5);
  handrail(kit, [V(-0.6, FY, CZ0 + 0.05), V(-0.6, FY, CZ1), V(0.38, FY, CZ1)]);
  kit.build(slew, mats);
}

// Tie bars (pendants): twin flat bars with pinned link joints every ~9 m.
function buildTies(slew, mats) {
  const kit = new Kit(31);
  const H = CRANE.catheadHeight, JB = CRANE.jibBottomY, JR = CRANE.jibRootX;
  const top = CRANE.jibBottomY + CRANE.jibHeight;
  const ties = [
    { a: V(0.4, H - 0.02, 0), b: V(JR + 22, top + 0.2, 0), gap: 0.05 },
    { a: V(0.4, H - 0.02, 0), b: V(JR + 42, top + 0.2, 0), gap: 0.11 },
    { a: V(-0.4, H - 0.02, -0.02), b: V(-1.0 - CRANE.counterJibLength + 0.15, JB + 0.2, -1.1), gap: 0.05 },
    { a: V(-0.4, H - 0.02, 0.02), b: V(-1.0 - CRANE.counterJibLength + 0.15, JB + 0.2, 1.1), gap: 0.05 },
  ];
  for (const { a, b, gap } of ties) {
    const L = a.distanceTo(b);
    const n = Math.max(1, Math.round(L / 9));
    const dir = b.clone().sub(a).normalize();
    const side = new THREE.Vector3().crossVectors(dir, UP).normalize();
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(a.clone().lerp(b, i / n));
    for (let i = 0; i < n; i++) {
      for (const sgn of [-1, 1]) {
        const off = side.clone().multiplyScalar(sgn * gap / 2);
        kit.member('yellowDark', pts[i].clone().add(off), pts[i + 1].clone().add(off), SEC.tie, UP, 1);
      }
    }
    // pin joints: eye plates + pins across the pair
    for (let i = 0; i <= n; i++) {
      const p = pts[i];
      _m.makeBasis(dir, new THREE.Vector3().crossVectors(side, dir), side).setPosition(p);
      kit.add('yellowDark', mBox(0.34, 0.2, gap + 0.06), _m.clone(), WEAR_JOINT);
      const pin = mCyl(0.035, 0.035, gap + 0.14, 12);
      pin.rotateX(Math.PI / 2);
      kit.add('darkSteel', pin, _m.clone(), null, false);
    }
  }
  kit.build(slew, mats);
}

// ------------------------------------------------------------ jib
function buildJib(mats, atlas, obstacleLights) {
  const g = new THREE.Group();
  g.name = 'jib';
  const kit = new Kit(41);
  const L = CRANE.jibLength, hw = CRANE.jibHalfWidth, h = CRANE.jibHeight;
  const panel = 2.0, n = Math.round(L / panel);
  const ht = (x) => h * (x > L - 6 ? 1 - (x - (L - 6)) / 8 : 1);
  const CT = 0.07; // bottom chord top
  const rTop = SEC.jibTop.r;
  // bottom chords (RHS + outboard running flange), in 10 m sections
  for (const z of [-hw, hw]) {
    for (let x = 0; x < L; x += 10) {
      const xb = Math.min(L, x + 10);
      kit.member('yellow', V(x, 0, z), V(xb, 0, z), SEC.jibBottom, UP, 1);
      kit.member('yellowDark', V(x, 0, z), V(xb, 0, z), SEC.jibFlange, UP, 0.8);
    }
  }
  // top chord (CHS) node to node (taper at the tip)
  for (let i = 0; i < n; i++) {
    const xa = i * panel, xb = xa + panel;
    kit.member('yellow', V(xa, ht(xa), 0), V(xb, ht(xb), 0), SEC.jibTop, UP, xa % 10 === 0 ? 1 : 0.45);
  }
  // side lacing (warren) + bottom lacing
  for (let i = 0; i < n; i++) {
    const xa = i * panel, xb = xa + panel;
    const flip = i % 2 === 0;
    const xBot = flip ? xa : xb, xTop = flip ? xb : xa;
    for (const z of [-hw, hw]) {
      kit.member('yellow', V(xBot + (flip ? 0.06 : -0.06), CT, z * 0.94), V(xTop, ht(xTop) - rTop * 0.8, z * 0.05), SEC.jibDiag, null, 0.7);
    }
    kit.member('yellow', V(xa + 0.05, CT + 0.03, -hw + 0.06), V(xa + 0.05, CT + 0.03, hw - 0.06), SEC.jibLace, null, 0.6);
    if (flip) kit.member('yellow', V(xa + 0.1, CT + 0.03, -hw + 0.08), V(xb - 0.1, CT + 0.03, hw - 0.08), SEC.jibLace, null, 0.6);
    else kit.member('yellow', V(xa + 0.1, CT + 0.03, hw - 0.08), V(xb - 0.1, CT + 0.03, -hw + 0.08), SEC.jibLace, null, 0.6);
    // node gussets on the bottom chords
    for (const z of [-hw, hw]) kit.box('yellowDark', 0.26, 0.012, 0.13, xBot + (flip ? 0.08 : -0.08), CT + 0.006, z * 0.97, null, WEAR_JOINT);
  }
  kit.member('yellow', V(L, CT + 0.03, -hw), V(L, CT + 0.03, hw), SEC.jibLace, null, 0.6);
  // section splices every 10 m: bottom-chord pin lugs, top-chord bolted flanges
  for (let x = 10; x < L; x += 10) {
    for (const z of [-hw, hw]) {
      kit.box('yellowDark', 0.32, 0.2, 0.18, x, 0, z, null, WEAR_JOINT);
      kit.cyl('darkSteel', 0.036, 0.3, x, -0.02, z, 'z', 12);
      for (const dz of [-0.16, 0.16]) kit.cyl('darkSteel', 0.05, 0.02, x, -0.02, z + dz, 'z', 10);
    }
    const y = ht(x);
    for (const dx of [-0.014, 0.014]) kit.cyl('yellowDark', 0.12, 0.024, x + dx, y, 0, 'x', 20, WEAR_JOINT);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU;
      bolt(kit, V(x + 0.028, y + Math.cos(a) * 0.095, Math.sin(a) * 0.095), V(1, 0, 0), 0.016);
    }
  }
  // root lugs (pin into the tower head)
  for (const z of [-hw, hw]) for (const dz of [-0.075, 0.075]) kit.box('yellowDark', 0.28, 0.2, 0.025, 0.08, 0, z + dz, null, WEAR_JOINT);
  kit.box('yellowDark', 0.26, 0.18, 0.1, 0.06, h, 0, null, WEAR_JOINT);
  // pendant lugs on the top chord
  for (const x of [22, 42]) {
    for (const dz of [-0.08, 0.08]) kit.box('yellowDark', 0.5, 0.3, 0.03, x, ht(x) + 0.14, dz, null, WEAR_JOINT);
    kit.cyl('darkSteel', 0.04, 0.24, x, ht(x) + 0.2, 0, 'z', 12);
  }
  // tip: end frame, trolley-rope return sheave, buffers, light mast
  const tipH = ht(L);
  for (const z of [-hw, hw]) kit.member('yellow', V(L, CT, z * 0.94), V(L, tipH - 0.05, 0), { k: 'box', w: 0.1, d: 0.1 }, null, 0.8);
  kit.box('yellowDark', 0.02, 0.24, 1.7, L + 0.07, 0, 0, null, WEAR_JOINT);
  const tipSheave = sheaveGeo(0.14, 0.05);
  tipSheave.translate(L - 0.4, -0.02, 0);
  kit.add('darkSteel', tipSheave, null, null, false);
  for (const dz of [-0.05, 0.05]) kit.box('yellowDark', 0.36, 0.3, 0.012, L - 0.4, 0.0, dz, null, WEAR_JOINT);
  for (const z of [-hw, hw]) kit.box('rubber', 0.16, 0.12, 0.12, L - 0.9, -0.03, z - Math.sign(z) * 0.14);
  kit.member('yellow', V(L + 0.2, tipH - 0.05, 0), V(L + 0.2, 0.93, 0), { k: 'tube', r: 0.03, seg: 8 }, null, 0.3);
  kit.box('yellowDark', 0.25, 0.03, 0.12, L + 0.1, tipH - 0.05, 0);
  obstacleLight(kit, g, obstacleLights, mats, L + 0.2, 1.0, 0);
  // jib foot: deflection sheave, trolley winch, short walkway
  const footSheave = sheaveGeo(0.17, 0.06);
  footSheave.translate(0.4, -0.05, 0);
  kit.add('darkSteel', footSheave, null, null, false);
  for (const dz of [-0.06, 0.06]) kit.box('yellowDark', 0.42, 0.34, 0.012, 0.4, -0.03, dz, null, WEAR_JOINT);
  for (const x of [1.45, 2.55]) kit.member('yellowDark', V(x, CT + 0.05, -hw), V(x, CT + 0.05, hw), { k: 'I', h: 0.12, b: 0.08, tw: 0.006, tf: 0.009 }, UP, 0.6);
  kit.cyl('grey', 0.15, 0.5, 2.0, 0.34, 0.1, 'z', 20, WEAR_LIGHT); // trolley drum
  kit.cyl('ropeWound', 0.162, 0.46, 2.0, 0.34, 0.1, 'z', 20);
  for (const dz of [-0.16, 0.36]) kit.cyl('grey', 0.2, 0.025, 2.0, 0.34, dz, 'z', 20);
  kit.box('grey', 0.3, 0.32, 0.2, 2.0, 0.32, -0.27, null, WEAR_LIGHT); // gearbox
  kit.cyl('machine', 0.12, 0.3, 2.0, 0.34, -0.52, 'z', 16);
  kit.cyl('grey', 0.13, 0.05, 2.0, 0.34, -0.69, 'z', 16);
  kit.box('grey', 0.1, 0.08, 0.12, 2.0, 0.49, -0.52);
  kit.box('grating', 9.0, 0.03, 0.6, 7.6, CT + 0.075, 0);
  // load-radius boards (both sides) — as on real jibs
  for (const r of [20, 30, 40, 50, 60]) {
    const x = r === 60 ? L - 1.3 : r - CRANE.jibRootX;
    // hung just outboard of the chord, above the trolley's highest part (y 0.11)
    for (const zs of [-1, 1]) {
      const z = zs * (hw + 0.07);
      kit.box('white', 0.7, 0.7, 0.02, x, 0.56, z);
      for (const dx of [-0.25, 0.25]) kit.box('galv', 0.04, 0.24, 0.012, x + dx, 0.17, z - zs * 0.016);
      decal(kit, atlas, 'rad' + r, 0.66, 0.66, V(x, 0.56, z + zs * 0.012), V(0, 0, zs));
    }
  }
  kit.build(g, mats);
  return g;
}

// ------------------------------------------------------------ counter-jib
function buildCounterJib(mats, atlas, obstacleLights) {
  const g = new THREE.Group();
  g.name = 'counterJib';
  const kit = new Kit(51);
  const L = CRANE.counterJibLength, hw = 1.1;
  // main girders (2 sections, spliced at mid-length)
  for (const z of [-hw, hw]) {
    kit.member('yellow', V(0, 0, z), V(-L / 2, 0, z), SEC.cjGirder, UP, 1);
    kit.member('yellow', V(-L / 2, 0, z), V(-L, 0, z), SEC.cjGirder, UP, 1);
    for (const dz of [-0.09, 0.09]) kit.box('yellowDark', 0.5, 0.3, 0.014, -L / 2, 0, z + dz, null, WEAR_JOINT);
    for (const y of [-0.08, 0, 0.08]) for (const x of [-0.15, 0.15]) bolt(kit, V(-L / 2 + x, y, z + Math.sign(z) * 0.097), V(0, 0, Math.sign(z)), 0.018);
  }
  // cross beams (none through the ballast bay; x=0 is the tower-head root beam) + plan bracing
  const xs = [0, -2.5, -5, -7.5, -10, -12.3, -L];
  xs.forEach((x, i) => {
    if (i > 0) kit.member('yellow', V(x, -0.02, -hw), V(x, -0.02, hw), SEC.cjCross, UP, 0.8);
    if (i < 5) {
      const xb = xs[i + 1], f = i % 2 === 0;
      kit.member('yellow', V(x - 0.1, -0.15, f ? -hw + 0.1 : hw - 0.1), V(xb + 0.1, -0.15, f ? hw - 0.1 : -hw + 0.1), SEC.cjBrace, UP, 0.6);
    }
  });
  // deck + guard rails (both sides, on the girder top flanges)
  kit.box('grating', 12.2, 0.03, 2.05, -6.35, 0.095, 0);
  for (const zs of [-1, 1]) {
    const z = zs * 1.14;
    handrail(kit, [V(-0.2, 0.18, z), V(-L + 0.1, 0.18, z)], { h: 1.1, spacing: 1.5 });
    // name boards on the rails
    kit.box('white', 5.8, 0.78, 0.03, -6.3, 0.83, z + zs * 0.05);
    decal(kit, atlas, 'name', 5.74, 0.86, V(-6.3, 0.83, z + zs * 0.067), V(0, 0, zs));
  }
  // counterweight: 4 precast blocks hung between the girders on steel hangers
  const nB = 4, t = 0.55;
  for (let i = 0; i < nB; i++) {
    const x = -L + 0.5 + i * 0.6;
    kit.box('concrete', t, 2.55, 2.0, x, -1.02, 0, null);
    // steel hangers resting on the girder top flanges
    for (const zs of [-1, 1]) {
      kit.box('darkSteel', 0.3, 0.3, 0.04, x, 0.06, zs * 1.02);
      kit.box('darkSteel', 0.3, 0.03, 0.24, x, 0.195, zs * 1.08);
    }
    for (const z of [-0.55, 0.55]) {
      const lug = mTorus(0.07, 0.016, 6, 12, Math.PI);
      lug.rotateY(Math.PI / 2);
      lug.translate(x, 0.25, z);
      kit.add('darkSteel', lug, null, null, false);
    }
    for (const zs of [-1, 1]) decal(kit, atlas, 'cw', 0.5, 0.24, V(x, -0.6, zs * 1.003), V(0, 0, zs));
  }
  decal(kit, atlas, 'cw', 1.2, 0.56, V(-L + 0.5 - t / 2 - 0.003, -0.7, 0), V(-1, 0, 0));
  // end beam, pendant lugs (tie pins at y 0.3), light mast
  for (const z of [-hw, hw]) {
    for (const dz of [-0.07, 0.07]) kit.box('yellowDark', 0.45, 0.35, 0.025, -L + 0.2, 0.3, z + dz, null, WEAR_JOINT);
    kit.cyl('darkSteel', 0.038, 0.24, -L + 0.15, 0.3, z, 'z', 12);
  }
  kit.member('yellow', V(-L, 0.1, 0), V(-L, 1.23, 0), { k: 'tube', r: 0.03, seg: 8 }, null, 0.3);
  obstacleLight(kit, g, obstacleLights, mats, -L, 1.3, 0);

  // --- hoist winch: frame, drum (rotating), gearbox, motor, brake, limit switch
  const winch = new THREE.Group();
  winch.position.set(-7.0, 0.11, 0);
  const wk = new Kit(52);
  for (const z of [-0.6, 0.6]) wk.member('yellowDark', V(-0.8, 0.06, z), V(1.9, 0.06, z), { k: 'I', h: 0.12, b: 0.1, tw: 0.007, tf: 0.01 }, UP, 0.8);
  for (const z of [-0.8, 0.8]) wk.box('grey', 0.34, 0.6, 0.12, 1.2, 0.35, z, null, WEAR_LIGHT); // drum pedestals
  wk.box('grey', 1.5, 0.75, 0.28, 0.55, 0.52, 0.93, null, WEAR_LIGHT); // gearbox
  for (let i = 0; i < 5; i++) wk.box('grey', 0.02, 0.6, 0.05, 0.05 + i * 0.25, 0.52, 1.08);
  // motor: finned frame, fan cowl, terminal box
  wk.cyl('machine', 0.28, 0.84, -0.15, 0.5, 0.2, 'z', 24);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    wk.box('machine', 0.025, 0.05, 0.8, -0.15 + Math.cos(a) * 0.29, 0.5 + Math.sin(a) * 0.29, 0.2, [0, 0, a]);
  }
  wk.cyl('grey', 0.3, 0.14, -0.15, 0.5, -0.29, 'z', 24);
  wk.add('decal', (() => { const q = atlas.quad('grille', 0.5, 0.5); q.rotateY(Math.PI); q.translate(-0.15, 0.5, -0.362); return q; })(), null, null, false);
  wk.box('grey', 0.26, 0.16, 0.22, -0.15, 0.85, 0.2);
  wk.cyl('rubber', 0.025, 0.5, -0.15, 0.95, 0.45, 'x', 6);
  wk.cyl('darkSteel', 0.24, 0.05, -0.15, 0.5, 0.68, 'z', 24); // brake disc
  wk.box('red', 0.14, 0.2, 0.12, -0.15, 0.78, 0.68);
  wk.box('grey', 0.16, 0.16, 0.14, 1.2, 0.62, -0.93); // rotary limit switch
  wk.build(winch, mats);
  // the drum rotates about its local y (main.js: drum.rotateY)
  const drum = new THREE.Group();
  drum.position.set(1.2, 0.62, 0);
  drum.rotation.x = Math.PI / 2;
  const dk = new Kit(53);
  dk.cyl('grey', 0.42, 1.44, 0, 0, 0, 'y', 32);
  dk.cyl('ropeWound', 0.445, 1.38, 0, 0, 0, 'y', 32);
  for (const y of [-0.72, 0.72]) {
    dk.cyl('grey', 0.56, 0.04, 0, y, 0, 'y', 32, WEAR_LIGHT);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      dk.cyl('darkSteel', 0.05, 0.05, Math.cos(a) * 0.35, y * 1.03, Math.sin(a) * 0.35, 'y', 10);
    }
  }
  dk.box('yellowDark', 0.1, 0.02, 0.8, 0, 0.745, 0); // flange marker (shows rotation)
  dk.build(drum, mats);
  winch.add(drum);
  g.add(winch);
  g.userData.drum = drum;

  // --- switchgear cabinet, braking resistors, cable tray
  const cx = -10.9;
  kit.box('grey', 0.62, 1.75, 1.6, cx, 0.11 + 0.875, 0, null, WEAR_LIGHT);
  kit.box('grey', 0.74, 0.04, 1.72, cx, 1.88, 0);
  for (const zs of [-1, 1]) { // two doors, seam at z = 0
    kit.box('darkSteel', 0.03, 0.18, 0.04, cx + 0.33, 1.0, zs * 0.1);
    for (const y of [0.35, 1.6]) kit.box('darkSteel', 0.03, 0.08, 0.03, cx + 0.33, y, zs * 0.77);
    decal(kit, atlas, 'louvre', 0.36, 0.27, V(cx + 0.315, 0.45, zs * 0.4), V(1, 0, 0));
    decal(kit, atlas, 'elec', 0.16, 0.14, V(cx + 0.315, 1.5, zs * 0.4), V(1, 0, 0));
  }
  kit.box('black', 0.006, 1.62, 0.006, cx + 0.313, 0.99, 0);
  kit.box('galv', 0.5, 0.5, 0.9, -9.0, 0.37, 0.55); // braking resistors
  decal(kit, atlas, 'louvre', 0.8, 0.4, V(-9.0, 0.37, 1.002), V(0, 0, 1));
  decal(kit, atlas, 'warn', 0.16, 0.14, V(-8.749, 0.5, 0.55), V(1, 0, 0));
  // cable tray on the outside of the -z girder web
  const trayY = -0.06, trayZ = -1.27;
  kit.member('galv', V(-10.7, trayY, trayZ), V(-0.3, trayY, trayZ), { k: 'box', w: 0.01, d: 0.18 }, UP, 0);
  for (const dz of [-0.09, 0.09]) kit.member('galv', V(-10.7, trayY + 0.03, trayZ + dz), V(-0.3, trayY + 0.03, trayZ + dz), { k: 'box', w: 0.06, d: 0.004 }, UP, 0);
  for (const dz of [-0.05, 0, 0.05]) kit.member('rubber', V(-10.7, trayY + 0.025, trayZ + dz), V(-0.3, trayY + 0.025, trayZ + dz), { k: 'tube', r: 0.017, seg: 6 }, null, 0);
  for (let x = -10.2; x < -0.5; x += 1.5) kit.box('galv', 0.05, 0.03, 0.2, x, trayY - 0.02, trayZ + 0.06);
  kit.member('rubber', V(-10.7, trayY + 0.03, trayZ), V(-10.62, 0.3, -0.72), { k: 'tube', r: 0.022, seg: 6 }, null, 0);
  kit.member('rubber', V(-7.2, trayY + 0.03, trayZ), V(-7.15, 0.95, 0.2), { k: 'tube', r: 0.02, seg: 6 }, null, 0);
  kit.build(g, mats);
  return g;
}

// ------------------------------------------------------------ cab
function buildCab(mats, atlas) {
  // Origin at cab floor centre; eye at (-0.22, 1.32, 0) looking +x.
  const g = new THREE.Group();
  g.name = 'cab';
  const kit = new Kit(61);
  const W = 1.55, D = 2.2, H = 2.25;
  const hx = D / 2, hz = W / 2, TR = 0.95, MX = 0.1;
  const fr = (a, b, w = 0.06, d = 0.06) => kit.member('cabBody', a, b, { k: 'box', w, d }, null, 0.4);
  // --- frame
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) fr(V(sx * (hx - 0.03), 0, sz * (hz - 0.03)), V(sx * (hx - 0.03), H, sz * (hz - 0.03)));
  for (const y of [0.04, H - 0.04]) {
    fr(V(-hx, y, -hz + 0.03), V(hx, y, -hz + 0.03), 0.08);
    fr(V(-hx, y, hz - 0.03), V(hx, y, hz - 0.03), 0.08);
    fr(V(-hx + 0.03, y, -hz), V(-hx + 0.03, y, hz), 0.08);
    fr(V(hx - 0.03, y, -hz), V(hx - 0.03, y, hz), 0.08);
  }
  fr(V(hx - 0.02, TR, -hz), V(hx - 0.02, TR, hz), 0.05, 0.05);
  for (const z of [-1, 1]) {
    fr(V(MX, TR, z * (hz - 0.02)), V(hx, TR, z * (hz - 0.02)), 0.05, 0.05);
    fr(V(MX, 0, z * (hz - 0.02)), V(MX, H, z * (hz - 0.02)), 0.055, 0.05);
    fr(V(-hx, TR, z * (hz - 0.02)), V(MX, TR, z * (hz - 0.02)), 0.05, 0.05);
  }
  fr(V(MX, 0.04, -hz), V(MX, 0.04, hz), 0.08, 0.07);
  for (const z of [-0.26, 0.26]) kit.member('galv', V(MX + 0.05, 0.075, z), V(hx - 0.05, 0.075, z), { k: 'box', w: 0.025, d: 0.035 }, UP, 0);
  // --- skin: rear wall, rear side panels (below the transom), roof, rear floor
  kit.box('white', 0.03, H, W, -hx - 0.012, H / 2, 0, null, WEAR_LIGHT);
  kit.box('panel', 0.02, H - 0.1, W - 0.1, -hx + 0.035, H / 2, 0);
  for (const z of [-1, 1]) {
    kit.box('white', hx + MX, TR - 0.06, 0.02, (MX - hx) / 2, TR / 2, z * (hz + 0.005));
    kit.box('panel', hx + MX - 0.08, TR - 0.12, 0.02, (MX - hx) / 2, TR / 2, z * (hz - 0.045));
  }
  kit.box('white', D + 0.12, 0.07, W + 0.1, 0.03, H + 0.035, 0, null, WEAR_LIGHT);
  kit.box('panel', D - 0.1, 0.02, W - 0.1, 0, H - 0.08, 0);
  kit.box('white', hx + MX, 0.05, W, (MX - hx) / 2, 0.0, 0);
  kit.box('rubber', hx + MX - 0.08, 0.012, W - 0.12, (MX - hx) / 2, 0.031, 0);
  // underside: floor beams (none under the floor window)
  for (const x of [-0.8, 0.06]) kit.box('cabFrame', 0.1, 0.1, W, x, -0.06, 0);
  // door outline, window, handle, grab rail (rear wall, outside)
  kit.box('black', 0.006, 1.95, 0.012, -hx - 0.03, 0.99, -0.1);
  kit.box('black', 0.006, 1.95, 0.012, -hx - 0.03, 0.99, 0.62);
  kit.box('black', 0.006, 0.012, 0.72, -hx - 0.03, 1.97, 0.26);
  kit.box('glass', 0.006, 0.7, 0.5, -hx - 0.031, 1.5, 0.26);
  kit.box('darkSteel', 0.05, 0.03, 0.14, -hx - 0.05, 1.05, 0.52);
  kit.member('galv', V(-hx - 0.1, 0.4, 0.7), V(-hx - 0.1, 1.6, 0.7), { k: 'tube', r: 0.016, seg: 8 }, null, 0);
  decal(kit, atlas, 'plate', 0.2, 0.117, V(-hx - 0.028, 0.6, -0.45), V(-1, 0, 0));
  // --- glazing: outer skin (normal out) and inner skin (normal in, dusty)
  const pane = (w, h, c, n, inner = 'glassIn') => {
    _q.setFromUnitVectors(V(0, 0, 1), n);
    _m.makeRotationFromQuaternion(_q).setPosition(c.clone().addScaledVector(n, 0.004));
    kit.add('glass', new THREE.PlaneGeometry(w, h), _m.clone(), null, false);
    // black EPDM glazing seal around the pane (outside face)
    const gm = _m.clone();
    const sw = 0.028, st = 0.014;
    for (const [gw, gh, gx, gy] of [[w + sw, sw, 0, h / 2], [w + sw, sw, 0, -h / 2], [sw, h - sw, w / 2, 0], [sw, h - sw, -w / 2, 0]]) {
      kit.add('rubber', mBox(gw, gh, st).translate(gx, gy, 0.002), gm, null, false);
    }
    _q.setFromUnitVectors(V(0, 0, 1), n.clone().negate());
    _m.makeRotationFromQuaternion(_q).setPosition(c.clone().addScaledVector(n, -0.004));
    kit.add(inner, new THREE.PlaneGeometry(w, h), _m.clone(), null, false);
  };
  const up0 = TR + 0.025, top0 = H - 0.08, lo0 = 0.08, lo1 = TR - 0.025;
  pane(W - 0.12, top0 - up0, V(hx, (up0 + top0) / 2, 0), V(1, 0, 0), 'glassWiped');
  pane(W - 0.12, lo1 - lo0, V(hx, (lo0 + lo1) / 2, 0), V(1, 0, 0));
  for (const z of [-1, 1]) {
    const n = V(0, 0, z);
    pane(hx - MX - 0.09, top0 - up0, V((MX + hx) / 2, (up0 + top0) / 2, z * hz), n);
    pane(hx - MX - 0.09, lo1 - lo0, V((MX + hx) / 2, (lo0 + lo1) / 2, z * hz), n);
    pane(hx + MX - 0.09, top0 - up0, V((MX - hx) / 2, (up0 + top0) / 2, z * hz), n);
  }
  pane(hx - MX - 0.09, W - 0.12, V((MX + hx) / 2, 0.03, 0), V(0, -1, 0));
  // --- exterior: sun visor, wiper, roof A/C, beacon, horn
  kit.box('glass', 0.34, 0.012, W + 0.06, hx + 0.16, H + 0.02, 0, [0, 0, -0.18]);
  kit.box('cabFrame', 0.03, 0.02, W + 0.06, hx + 0.32, H - 0.01, 0, [0, 0, -0.18]);
  // wiper parked upright against the left pillar (pivot at the transom), so
  // it never crosses the operator's line of sight like a car wiper would
  const wz = -hz + 0.1;
  const wp = V(hx + 0.012, TR + 0.05, wz);
  const wtip = V(hx + 0.012, TR + 0.84, wz + 0.035);
  kit.member('black', wp, wtip, { k: 'box', w: 0.012, d: 0.022 }, V(1, 0, 0), 0);
  kit.member('rubber', wp.clone().lerp(wtip, 0.15).add(V(0.012, 0, 0)), wtip.clone().add(V(0.012, 0.05, 0.0)), { k: 'box', w: 0.014, d: 0.02 }, V(1, 0, 0), 0);
  kit.cyl('black', 0.025, 0.04, hx + 0.02, TR + 0.05, wz, 'x', 10);
  kit.box('cabFrame', 0.08, 0.1, 0.16, hx + 0.03, TR - 0.1, wz + 0.02);
  kit.box('white', 0.72, 0.28, 0.9, -0.6, H + 0.21, 0, null, WEAR_LIGHT);
  const gr = atlas.quad('grille', 0.46, 0.46);
  gr.rotateX(-Math.PI / 2);
  gr.translate(-0.6, H + 0.352, 0);
  kit.add('decal', gr, null, null, false);
  decal(kit, atlas, 'louvre', 0.6, 0.18, V(-0.6, H + 0.2, 0.452), V(0, 0, 1));
  decal(kit, atlas, 'louvre', 0.6, 0.18, V(-0.6, H + 0.2, -0.452), V(0, 0, -1));
  kit.cyl('black', 0.065, 0.04, 0.75, H + 0.09, 0.62, 'y', 14);
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 14), mats.amber);
  beacon.position.set(0.75, H + 0.16, 0.62);
  g.add(beacon);
  kit.cyl('black', 0.045, 0.1, 0.5, -0.12, 0.5, 'x', 10);
  // --- interior: overhead console + radio, sun blind, LMI arm, extinguisher, heater, chart
  kit.box('panel', 0.48, 0.08, 0.34, 0.72, H - 0.13, 0.5);
  kit.box('black', 0.2, 0.06, 0.15, 0.72, H - 0.2, 0.46);
  kit.box('panel', 0.14, 0.02, 0.06, 0.72, H - 0.23, 0.46);
  kit.add('black', new THREE.CapsuleGeometry(0.022, 0.07, 4, 8).rotateZ(Math.PI / 2).translate(0.66, H - 0.2, 0.6), null, null, false);
  kit.cyl('panel', 0.032, W - 0.2, hx - 0.07, H - 0.12, 0, 'z', 10);
  kit.box('blind', 0.004, 0.16, W - 0.26, hx - 0.05, H - 0.2, 0);
  kit.box('panel', 0.2, 0.04, 0.08, -0.7, H - 0.1, 0.0); // cab light
  // LMI display on an arm from the right front post
  const lmiPos = V(0.62, 1.07, 0.5);
  kit.member('galv', V(hx - 0.06, 1.0, hz - 0.06), lmiPos.clone().add(V(0.05, -0.05, 0.05)), { k: 'tube', r: 0.014, seg: 8 }, null, 0);
  const lmi = new THREE.Group();
  lmi.position.copy(lmiPos);
  lmi.lookAt(-0.22, 1.32, 0);
  const lmiHousing = new THREE.Mesh(new RoundedBoxGeometry(0.32, 0.22, 0.045, 2, 0.012), mats.black);
  lmiHousing.castShadow = true;
  lmi.add(lmiHousing);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.168), new THREE.MeshBasicMaterial({ map: lmiScreenTexture(), toneMapped: false }));
  screen.position.z = 0.0235;
  lmi.add(screen);
  g.add(lmi);
  // extinguisher (rear right) + bracket, hose
  kit.cyl('red', 0.072, 0.42, -hx + 0.14, 0.38, 0.6, 'y', 16);
  kit.add('red', new THREE.SphereGeometry(0.072, 16, 8, 0, TAU, 0, Math.PI / 2).translate(-hx + 0.14, 0.59, 0.6), null, null, false);
  kit.cyl('black', 0.022, 0.07, -hx + 0.14, 0.66, 0.6, 'y', 10);
  kit.box('black', 0.12, 0.014, 0.03, -hx + 0.17, 0.7, 0.6);
  kit.cyl('white', 0.074, 0.12, -hx + 0.14, 0.36, 0.6, 'y', 16);
  kit.add('black', sweepGeo([V(-hx + 0.16, 0.66, 0.62), V(-hx + 0.2, 0.62, 0.66), V(-hx + 0.21, 0.4, 0.66), V(-hx + 0.19, 0.25, 0.64)], () => 0.009, { steps: 16, seg: 6 }), null, null, false);
  kit.box('galv', 0.04, 0.06, 0.16, -hx + 0.05, 0.45, 0.6);
  // heater under the rear-left
  kit.box('panel', 0.3, 0.22, 0.4, -hx + 0.22, 0.14, -0.45);
  for (let i = 0; i < 5; i++) kit.box('black', 0.005, 0.012, 0.32, -hx + 0.372, 0.07 + i * 0.035, -0.45);
  decal(kit, atlas, 'chart', 0.32, 0.225, V(-hx + 0.047, 1.3, -0.42), V(1, 0, 0));
  // --- operator seat with armrest consoles (joystick pivots driven by main.js)
  const seat = new THREE.Group();
  seat.position.set(-0.35, 0, 0);
  const sk = new Kit(62);
  sk.box('darkSteel', 0.4, 0.03, 0.4, 0, 0.03, 0);
  sk.cyl('darkSteel', 0.06, 0.22, 0, 0.15, 0, 'y', 12);
  sk.cyl('rubber', 0.1, 0.12, 0, 0.3, 0, 'y', 14);
  sk.box('black', 0.46, 0.05, 0.46, 0, 0.38, 0);
  sk.add('seat', new RoundedBoxGeometry(0.5, 0.12, 0.5, 3, 0.045).translate(0.01, 0.47, 0), null, null, false);
  const back = new RoundedBoxGeometry(0.12, 0.66, 0.48, 3, 0.05);
  back.rotateZ(0.12);
  back.translate(-0.26, 0.86, 0);
  sk.add('seat', back, null, null, false);
  sk.add('seat', new RoundedBoxGeometry(0.09, 0.2, 0.28, 2, 0.04).rotateZ(0.12).translate(-0.33, 1.31, 0), null, null, false);
  for (const z of [-0.12, 0.12]) sk.cyl('darkSteel', 0.008, 0.1, -0.325, 1.2, z, 'y', 6);
  sk.box('black', 0.08, 0.5, 0.36, -0.34, 0.8, 0);
  const consoles = [];
  for (const side of [-1, 1]) {
    const con = new THREE.Group();
    con.position.set(0.05, 0.62, side * 0.38);
    const ck = new Kit(63 + side);
    ck.add('seat', new RoundedBoxGeometry(0.32, 0.07, 0.14, 2, 0.03).translate(-0.2, 0.0, 0), null, null, false);
    ck.add('black', new RoundedBoxGeometry(0.38, 0.12, 0.2, 2, 0.025).translate(0.1, -0.02, 0), null, null, false);
    ck.box('darkSteel', 0.05, 0.3, 0.05, -0.1, -0.2, 0);
    ck.box('panel', 0.14, 0.004, 0.14, 0.2, 0.041, 0);
    const btn = [[0.16, -0.045, 'red'], [0.2, -0.045, 'galv'], [0.24, -0.045, 'galv'], [0.16, 0.045, 'galv'], [0.2, 0.045, 'amber']];
    for (const [x, z, k] of btn) ck.cyl(k, 0.011, 0.012, x, 0.048, z * side, 'y', 10);
    if (side > 0) {
      ck.cyl('amber', 0.028, 0.02, 0.255, 0.05, 0.0, 'y', 14);
      ck.cyl('red', 0.022, 0.03, 0.255, 0.07, 0.0, 'y', 14);
    } else {
      ck.cyl('darkSteel', 0.014, 0.02, 0.255, 0.05, 0.0, 'y', 10); // key switch
    }
    ck.build(con, mats);
    const pivot = new THREE.Group();
    pivot.position.set(0.12, 0.07, 0);
    const pk = new Kit(70 + side);
    pk.add('rubber', new THREE.CylinderGeometry(0.018, 0.04, 0.055, 12).translate(0, 0.0, 0), null, null, false);
    for (let i = 0; i < 3; i++) pk.add('rubber', new THREE.TorusGeometry(0.03 - i * 0.006, 0.006, 5, 12).rotateX(Math.PI / 2).translate(0, -0.01 + i * 0.016, 0), null, null, false);
    pk.cyl('darkSteel', 0.01, 0.07, 0, 0.06, 0, 'y', 8);
    const grip = new THREE.CapsuleGeometry(0.026, 0.085, 4, 12);
    grip.rotateZ(-0.18);
    grip.translate(0.012, 0.15, 0);
    pk.add('black', grip, null, null, false);
    pk.cyl('red', 0.011, 0.012, 0.026, 0.215, side * 0.005, 'y', 10);
    pk.box('amber', 0.012, 0.03, 0.02, 0.04, 0.15, 0);
    pk.build(pivot, mats);
    con.add(pivot);
    seat.add(con);
    consoles.push(pivot);
  }
  sk.build(seat, mats);
  g.add(seat);
  kit.build(g, mats, { noShadow: ['glassIn', 'glassWiped', 'blind', 'decal'] });
  g.userData.leftStick = consoles[0];
  g.userData.rightStick = consoles[1];
  g.userData.screen = screen;
  return g;
}

// ------------------------------------------------------------ trolley
function buildTrolley(mats) {
  const g = new THREE.Group();
  g.name = 'trolley';
  const kit = new Kit(81);
  const hw = CRANE.jibHalfWidth;
  const SZ = hw + 0.17; // side plates outside the chord flanges
  for (const s of [-1, 1]) {
    kit.box('yellow', 1.7, 0.38, 0.02, 0, -0.09, s * SZ, null, WEAR_LIGHT);
    kit.box('yellowDark', 1.7, 0.02, 0.1, 0, 0.1, s * (SZ - 0.04));
    for (const x of [-0.55, 0.55]) {
      // flanged running wheels on the chord's outboard flange + anti-lift roller
      kit.cyl('darkSteel', 0.08, 0.045, x, 0.01, s * (hw + 0.09), 'z', 20);
      kit.cyl('darkSteel', 0.093, 0.01, x, 0.01, s * (hw + 0.115), 'z', 20);
      kit.cyl('darkSteel', 0.02, 0.1, x, 0.01, s * (hw + 0.14), 'z', 8);
      kit.box('grey', 0.14, 0.14, 0.03, x, 0.01, s * (SZ + 0.02), null, WEAR_LIGHT);
      kit.cyl('darkSteel', 0.03, 0.04, x, -0.115, s * (hw + 0.09), 'z', 10);
    }
    for (const x of [-0.88, 0.88]) kit.cyl('rubber', 0.05, 0.08, x + Math.sign(x) * 0.04, -0.02, s * SZ, 'x', 12);
  }
  // lower cross beams under the chords + sheave cheeks
  for (const x of [-0.62, 0.62]) kit.box('yellow', 0.1, 0.12, 2 * SZ, x, -0.22, 0, null, WEAR_LIGHT);
  for (const z of [-0.07, 0.07]) kit.box('yellow', 1.34, 0.46, 0.022, 0, -0.41, z, null, WEAR_LIGHT);
  for (const x of [-0.3, 0.3]) {
    const sh = sheaveGeo(0.2, 0.05);
    sh.translate(x, -CRANE.sheaveDrop, 0);
    kit.add('darkSteel', sh, null, null, false);
    kit.cyl('darkSteel', 0.035, 0.2, x, -CRANE.sheaveDrop, 0, 'z', 12);
    for (const z of [-0.09, 0.09]) kit.cyl('darkSteel', 0.05, 0.02, x, -CRANE.sheaveDrop, z, 'z', 6);
    kit.cyl('galv', 0.014, 0.13, x, -0.645, 0, 'z', 8); // rope keeper
  }
  // trolley-rope anchors (main.js ends the trolley ropes at (±0.3, 0.05, 0))
  for (const x of [-0.3, 0.3]) {
    kit.box('yellowDark', 0.05, 0.22, 0.05, x, -0.06, 0, null, WEAR_JOINT);
    kit.box('darkSteel', 0.12, 0.04, 0.06, x + Math.sign(x) * 0.04, 0.035, 0);
  }
  // hoist-rope deflection sheaves at the trolley ends (ropes at z = ±0.3)
  for (const [x, z] of [[-0.8, 0.3], [0.8, -0.3]]) {
    const sh = sheaveGeo(0.07, 0.035);
    sh.translate(x, -0.05, z);
    kit.add('darkSteel', sh, null, null, false);
    for (const dz of [-0.035, 0.035]) kit.box('yellowDark', 0.3, 0.16, 0.012, x - Math.sign(x) * 0.08, -0.1, z + dz, null, WEAR_JOINT);
  }
  // hook camera housing + arm (camera itself is added by cameras.js at (0.35,-0.5,0.6))
  kit.box('black', 0.1, 0.07, 0.12, 0.35, -0.42, 0.6);
  kit.box('galv', 0.03, 0.03, 0.55, 0.35, -0.37, 0.33);
  // maintenance basket
  const bx0 = 0.9, bx1 = 1.7, by = -1.6, bz = 0.6;
  for (const z of [-bz, bz]) kit.member('yellowDark', V(0.55, -0.31, z), V(bx1, -0.31, z), { k: 'box', w: 0.06, d: 0.06 }, UP, 0.6);
  for (const x of [bx0, bx1]) for (const z of [-bz, bz]) kit.member('yellowDark', V(x, -0.31, z), V(x, by, z), { k: 'box', w: 0.04, d: 0.04 }, null, 0.6);
  for (const y of [by + 0.9, by + 0.45]) {
    for (const z of [-bz, bz]) kit.member('yellowDark', V(bx0, y, z), V(bx1, y, z), SEC.rail, null, 0.4);
    kit.member('yellowDark', V(bx1, y, -bz), V(bx1, y, bz), SEC.rail, null, 0.4);
    kit.member('yellowDark', V(bx0, y, -bz), V(bx0, y, bz), SEC.rail, null, 0.4);
  }
  kit.box('grating', bx1 - bx0, 0.03, 2 * bz, (bx0 + bx1) / 2, by + 0.015, 0);
  for (const z of [-bz, bz]) kit.box('yellowDark', bx1 - bx0, 0.1, 0.006, (bx0 + bx1) / 2, by + 0.08, z);
  for (const x of [bx0, bx1]) kit.box('yellowDark', 0.006, 0.1, 2 * bz, x, by + 0.08, 0);
  kit.build(g, mats);
  return g;
}

// ------------------------------------------------------------ hook block
export function buildHookBlock(mats, falls) {
  const g = new THREE.Group();
  g.name = 'hookBlock';
  // origin at the rope attachment point (top of block); hook bowl at -hookBlockHeight
  const HB = CRANE.hookBlockHeight;
  const four = falls === 4;
  const w = four ? 0.62 : 0.42;
  const kit = new Kit(91 + falls);
  const atlas = mats.decal.userData.atlas;
  // cheek plates (rounded top), hazard striped
  const hb = w / 2 + 0.07, ha = 0.19;
  const sh = new THREE.Shape();
  sh.moveTo(-ha, -0.68);
  sh.lineTo(ha, -0.68);
  sh.lineTo(hb, -0.38);
  sh.lineTo(hb, -0.2);
  sh.quadraticCurveTo(hb, -0.035, 0, -0.035);
  sh.quadraticCurveTo(-hb, -0.035, -hb, -0.2);
  sh.lineTo(-hb, -0.38);
  sh.closePath();
  const gap = 0.12, t = 0.026;
  for (const s of [-1, 1]) {
    const plate = mExtrude(sh, t, { curveSegments: 10 });
    plate.translate(0, 0, s > 0 ? gap / 2 : -gap / 2 - t);
    kit.add('hazard', plate, null, [0.5, 9, 0.6], false);
    decal(kit, atlas, four ? 'swl8' : 'swl4', 0.22, 0.095, V(0, -0.53, s * (gap / 2 + t + 0.002)), V(0, 0, s));
  }
  // sheave(s) + axle bosses, tie bolts between the cheeks
  const sheaves = four ? [[-0.165, 0.14], [0.165, 0.14]] : [[0, 0.2]];
  for (const [x, r] of sheaves) {
    const sv = sheaveGeo(r, 0.07);
    sv.translate(x, -0.3, 0);
    kit.add('darkSteel', sv, null, null, false);
    for (const s of [-1, 1]) {
      kit.cyl('yellowDark', 0.065, 0.03, x, -0.3, s * (gap / 2 + t + 0.015), 'z', 18, WEAR_JOINT);
      kit.add('darkSteel', mCyl(0.04, 0.04, 0.025, 6).rotateX(Math.PI / 2).translate(x, -0.3, s * (gap / 2 + t + 0.042)), null, null, false);
    }
  }
  for (const [x, y] of [[-hb + 0.05, -0.2], [hb - 0.05, -0.2], [0, -0.1]]) {
    kit.cyl('darkSteel', 0.016, gap + 2 * t + 0.05, x, y, 0, 'z', 8);
  }
  // crosshead (trunnion) with hook nut on top, swivel bearing below
  kit.box('yellowDark', 0.4, 0.1, gap - 0.004, 0, -0.64, 0, null, WEAR_JOINT);
  kit.cyl('darkSteel', 0.04, gap + 2 * t + 0.07, 0, -0.64, 0, 'z', 12);
  kit.add('darkSteel', mCyl(0.052, 0.052, 0.045, 6).translate(0, -0.567, 0), null, null, false);
  kit.cyl('rubber', 0.07, 0.035, 0, -0.707, 0, 'y', 18);
  kit.cyl('darkSteel', 0.06, 0.03, 0, -0.735, 0, 'y', 18);
  // forged single hook (DIN 15401 shape): shank on the axis, bowl centred under
  // it at -HB, tip curling back up; oval section, thickest at the saddle
  const pts = [
    [0, -0.735], [0, -0.785], [-0.03, -0.83], [-0.075, -0.874], [-0.092, -0.93], [-0.07, -0.975], [-0.025, -0.995],
    [0.03, -0.99], [0.078, -0.958], [0.102, -0.912], [0.1, -0.862], [0.086, -0.828],
  ].map(([x, y]) => V(x, y + (0.95 - HB), 0));
  const rad = (s) => (s < 0.15 ? 0.032 + s / 0.15 * 0.008 : s < 0.62 ? 0.04 + 0.005 * Math.sin((s - 0.15) / 0.47 * Math.PI) : 0.04 - (s - 0.62) / 0.38 * 0.021);
  kit.add('red', sweepGeo(pts, rad, { steps: 48, seg: 12, flat: 0.72, planar: true }), null, [0.3, 9, 0.6], false);
  // spring safety latch across the throat
  kit.member('galv', V(0.038, -0.768, 0), V(0.084, -0.824, 0), { k: 'box', w: 0.005, d: 0.036 }, V(0, 0, 1), 0);
  kit.cyl('darkSteel', 0.008, 0.05, 0.036, -0.765, 0, 'z', 8);
  kit.build(g, mats);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ------------------------------------------------------------ crane
export function buildCrane() {
  const mats = createCraneMaterials();
  const atlas = mats.decal.userData.atlas;
  const root = new THREE.Group();
  root.name = 'crane';
  const obstacleLights = [];

  const mast = buildMast(mats);
  root.add(mast);

  const slew = new THREE.Group();
  slew.name = 'slew';
  slew.position.y = CRANE.mastTop;
  root.add(slew);
  buildSlewStatic(slew, mats);
  buildTies(slew, mats);

  const jibPivot = new THREE.Group();
  jibPivot.position.set(CRANE.jibRootX, CRANE.jibBottomY, 0);
  slew.add(jibPivot);
  const jib = buildJib(mats, atlas, obstacleLights);
  jibPivot.add(jib);

  const counterJib = buildCounterJib(mats, atlas, obstacleLights);
  counterJib.position.set(-1.0, CRANE.jibBottomY - 0.1, 0);
  slew.add(counterJib);

  // cab: cantilevered beside the jib foot, looking along the jib
  const cab = buildCab(mats, atlas);
  cab.position.set(1.5, CRANE.turntableHeight - 0.2, 2.0);
  slew.add(cab);

  // head fittings: obstacle light on the light mast, anemometer on its arm
  const hk = new Kit(99);
  obstacleLight(hk, slew, obstacleLights, mats, 0, CRANE.catheadHeight + 1.35, 0);
  const anemo = new THREE.Group();
  anemo.position.set(0.55, CRANE.catheadHeight + 0.33, -0.55);
  hk.member('galv', V(0.55, CRANE.catheadHeight + 0.33, -0.55), V(0.55, CRANE.catheadHeight + 1.2, -0.55), { k: 'tube', r: 0.018, seg: 8 }, null, 0);
  hk.cyl('grey', 0.035, 0.12, 0.55, CRANE.catheadHeight + 1.18, -0.55, 'y', 12);
  hk.build(slew, mats);
  const cups = new THREE.Group();
  cups.position.y = 0.95;
  const cupGeo = new THREE.SphereGeometry(0.045, 12, 8, 0, TAU, 0, Math.PI / 2);
  cupGeo.rotateZ(Math.PI / 2);
  for (let i = 0; i < 3; i++) {
    const holder = new THREE.Group();
    holder.rotation.y = (i * TAU) / 3;
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.2, 6), mats.galv);
    arm.rotation.z = Math.PI / 2;
    arm.position.x = 0.1;
    const cup = new THREE.Mesh(cupGeo, mats.white);
    cup.position.set(0.2, 0, 0);
    cup.rotation.y = Math.PI / 2;
    holder.add(arm, cup);
    cups.add(holder);
  }
  cups.add(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.05, 12), mats.grey));
  anemo.add(cups);
  slew.add(anemo);

  // LED floodlights under the jib (outboard of the trolley path), aimed at the site
  const floods = [];
  for (const x of [8, 30]) {
    // bracket passes ABOVE the trolley (whose highest part is at y 0.11)
    const z = CRANE.jibHalfWidth + 0.42;
    const fk = new Kit(100 + x);
    fk.member('yellowDark', V(x, 0.17, CRANE.jibHalfWidth), V(x, 0.17, z + 0.05), { k: 'box', w: 0.05, d: 0.05 }, UP, 0.5);
    fk.box('cabFrame', 0.4, 0.08, 0.3, x, 0.06, z);
    for (let i = 0; i < 6; i++) fk.box('cabFrame', 0.36, 0.05, 0.008, x, 0.12, z - 0.12 + i * 0.048);
    fk.build(jib, mats);
    const lampMesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.01, 0.26), mats.lamp);
    lampMesh.position.set(x, 0.016, z);
    jib.add(lampMesh);
    const spot = new THREE.SpotLight(0xfff0d8, 0, 110, 0.75, 0.6, 1.2);
    spot.position.set(x, -0.05, z);
    const tgt = new THREE.Object3D();
    tgt.position.set(x + 6, -40, z);
    jib.add(tgt);
    spot.target = tgt;
    spot.castShadow = false;
    jib.add(spot);
    floods.push({ spot, lampMesh });
  }

  const trolley = buildTrolley(mats);
  trolley.position.set(10, 0, 0);
  jib.add(trolley);

  return { root, mast, slew, jibPivot, jib, counterJib, cab, trolley, cups, obstacleLights, floods, mats, drum: counterJib.userData.drum };
}
