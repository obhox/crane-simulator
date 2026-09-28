import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { pbrMaterial } from './world/assets.js';
import { noiseField } from './world/textures.js';
import { rng } from './util/math.js';
import {
  Kit, mCyl, mTorus, mPlane, sweepGeo, weathered, glassMaterial, Atlas, fitText, grunge, WEAR_JOINT, WEAR_LIGHT, TAU,
} from './crane/kit.js';

// Visual models for the loads in LOAD_DEFS (loads.js). CONTRACT:
// buildLoadMesh(type, def) returns a THREE.Group whose origin is the centre
// of the load's collision box (def.size = [x long axis, y height, z]); the
// visual must fit that box (the bucket's bail may stick up ≤0.3 m above it).
// Sling attach points are def.points on the box top. Visual only.
//
// Every model is built from real-size parts with metric UVs on the CC0 PBR
// sets and merged per material (2-7 draw calls per load); materials, the
// stencil atlas and procedural normal maps are shared by all spawns.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

let M = null; // shared materials

function dataTex(fn, W, H, srgb = false, repeat = [1, 1]) {
  const d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a = 255] = fn(x / W, y / H);
      const i = (y * W + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    }
  }
  const t = new THREE.DataTexture(d, W, H);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.repeat.set(...repeat);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// Normal map from a height function h(u,v) (tileable), tangent space
function normalTex(h, W, H, strength, repeat) {
  const e = 1 / W;
  return dataTex((u, v) => {
    const dx = (h(u + e, v) - h(u - e, v)) * strength, dy = (h(u, v + e) - h(u, v - e)) * strength;
    const l = Math.hypot(dx, dy, 1);
    return [(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255];
  }, W, H, false, repeat);
}

// Deformed bar (B500B): transverse ribs every ~0.65 d plus two longitudinal ribs.
// Tile: 0.1 m around (u) × 0.021 m along (v).
function ribNormal() {
  const h = (u, v) => {
    const vv = ((v % 1) + 1) % 1, uu = ((u % 1) + 1) % 1;
    const dv = ((vv + (uu < 0.5 ? 0 : 0.5)) % 1) - 0.5;
    const rib = Math.exp(-(dv * dv) / 0.012);
    const lng = Math.exp(-((uu - 0.25) ** 2) / 0.0015) + Math.exp(-((uu - 0.75) ** 2) / 0.0015);
    return Math.min(1, rib * (Math.abs(uu - 0.25) > 0.06 && Math.abs(uu - 0.75) > 0.06 ? 1 : 0.3) + lng);
  };
  return normalTex(h, 64, 64, 2.2, [10, 1 / 0.021]);
}

// Stretch-wrap film: random soft wrinkles, mostly horizontal (wound on)
function wrapNormal() {
  const S = 128;
  const n = noiseField(S, 4, 4, 91), f = noiseField(S, 16, 3, 92);
  const h = (u, v) => {
    const x = Math.floor(((u % 1) + 1) % 1 * S) % S, y = Math.floor(((v % 1) + 1) % 1 * S) % S;
    return n[y * S + x] * 0.6 + f[y * S + x] * 0.4 + 0.25 * Math.sin((v * 22 + n[y * S + x] * 3) * TAU);
  };
  return normalTex(h, S, S, 2.5, [1.2, 1.2]);
}

// Brick pack faces (no mortar: packs are dry-stacked with 2-4 mm gaps),
// per-brick colour variation from the kiln, speckle, softened arrises.
// nx × ny bricks of bw × bh metres per tile; returns { map, normalMap, tile }.
function brickPackTex(bw, bh, nx, ny, seed) {
  const W = 512, H = Math.round(512 * (ny * bh) / (nx * bw));
  const pal = [[152, 70, 48], [166, 84, 58], [131, 58, 43], [174, 96, 66], [121, 54, 40], [158, 76, 52]];
  const n = noiseField(256, 24, 3, seed);
  const r = rng(seed);
  const cols = [];
  for (let i = 0; i < nx * ny; i++) cols.push(pal[Math.floor(r() * pal.length)].map((c) => c * (0.9 + r() * 0.2)));
  const offs = [];
  for (let j = 0; j < ny; j++) offs.push(Math.floor((r() - 0.5) * 6)); // courses never line up exactly
  const cw = W / nx, ch = H / ny, gap = 2.2;
  const height = new Float32Array(W * H);
  const col = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const j = Math.floor(y / ch), ly = y - j * ch;
    for (let x = 0; x < W; x++) {
      const xx = (x + offs[j] + W) % W;
      const i = Math.floor(xx / cw), lx = xx - i * cw;
      const e = Math.min(lx, cw - lx, ly, ch - ly); // px to the brick edge
      const h = Math.min(1, Math.max(0, (e - gap) / 3));
      const sp = n[(y % 256) * 256 + (x % 256)];
      height[y * W + x] = h * (0.92 + 0.08 * sp);
      const c = cols[j * nx + i];
      const k = h <= 0 ? 0.18 : (0.78 + 0.3 * sp) * (0.82 + 0.18 * h);
      const o = (y * W + x) * 4;
      col[o] = Math.min(255, c[0] * k); col[o + 1] = Math.min(255, c[1] * k); col[o + 2] = Math.min(255, c[2] * k); col[o + 3] = 255;
    }
  }
  const nrm = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const hx = (height[y * W + (x + 1) % W] - height[y * W + (x - 1 + W) % W]) * 1.6;
      const hy = (height[((y + 1) % H) * W + x] - height[((y - 1 + H) % H) * W + x]) * 1.6;
      const l = Math.hypot(hx, hy, 1), o = (y * W + x) * 4;
      // DataTexture row 0 is v = 0, so the slopes map straight onto u/v
      nrm[o] = (-hx / l * 0.5 + 0.5) * 255; nrm[o + 1] = (-hy / l * 0.5 + 0.5) * 255; nrm[o + 2] = (1 / l * 0.5 + 0.5) * 255; nrm[o + 3] = 255;
    }
  }
  const mk = (d, srgb) => {
    const t = new THREE.DataTexture(d, W, H);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.repeat.set(1 / (nx * bw), 1 / (ny * bh));
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(col, true), normalMap: mk(nrm, false) };
}

// Cement laitance left on a used formwork face: grey film blotches (heavier
// towards the bottom, where the pour pressure squeezes grout out), drips and
// splatter. RGBA for an alpha-tested overlay spanning the whole face.
function residueTex(seed = 61) {
  const W = 512, H = 352;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const a = noiseField(256, 5, 5, seed), b = noiseField(256, 20, 3, seed + 3);
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H; // 0 = bottom
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const na = a[Math.floor(v * 255) * 256 + Math.floor(u * 255)], nb = b[(y % 256) * 256 + (x % 256)];
      const edge = Math.max(0, 0.05 - Math.min(u, 1 - u, v, 1 - v)) * 3;
      const cover = na * 0.75 + nb * 0.3 + (0.3 - v) * 0.4 + edge;
      const o = (y * W + x) * 4;
      const g = 114 + nb * 34;
      img.data[o] = g; img.data[o + 1] = g * 0.98; img.data[o + 2] = g * 0.93;
      img.data[o + 3] = cover > 0.695 ? 255 : 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const r = rng(seed);
  ctx.fillStyle = 'rgb(122,119,112)';
  for (let i = 0; i < 90; i++) { ctx.beginPath(); ctx.arc(r() * W, r() * H, 0.8 + r() * r() * 5, 0, TAU); ctx.fill(); }
  ctx.strokeStyle = 'rgb(112,109,103)';
  for (let i = 0; i < 12; i++) {
    const x = r() * W, y0 = r() * H * 0.7;
    ctx.lineWidth = 1 + r() * 2.5;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x + (r() - 0.5) * 3, y0 + 10 + r() * 60); ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function loadAtlas() {
  const A = new Atlas(1024, 512);
  const sans = 'Arial, Helvetica, sans-serif';
  const stencil = 'Impact, "Arial Narrow", Arial, sans-serif';
  A.add('tw', 300, 170, (c, w, h) => { // painted weight panel on a test block
    c.fillStyle = '#e3aa12'; c.fillRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#141414'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, '1000 kg', w / 2, h * 0.42, w - 40, 84, stencil, 'normal');
    fitText(c, 'TEST WEIGHT  No 3', w / 2, h * 0.8, w - 50, 24, sans, 'bold');
    c.globalCompositeOperation = 'destination-out';
    grunge(c, w, h, 21, 2.2, 'rgba(0,0,0,');
    const r = rng(5);
    for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(0,0,0,${0.5 + r() * 0.5})`; c.beginPath(); c.arc(r() < 0.5 ? r() * 14 : w - r() * 14, r() * h, 2 + r() * 6, 0, TAU); c.fill(); }
    c.globalCompositeOperation = 'source-over';
  });
  A.add('cont', 360, 150, (c, w, h) => { // container side marking (stencil, white)
    c.fillStyle = '#f1f1ec'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.font = `bold 58px ${sans}`; c.fillText('SITE 042', 12, 64);
    c.font = `bold 30px ${sans}`; c.fillText('MATERIAL STORE', 14, 104);
    c.font = `bold 22px ${sans}`; c.fillText('MAX GROSS 10 160 kg', 14, 136);
    c.globalCompositeOperation = 'destination-out'; grunge(c, w, h, 31, 1.2, 'rgba(0,0,0,'); c.globalCompositeOperation = 'source-over';
  });
  A.add('contDoor', 200, 120, (c, w, h) => {
    c.fillStyle = '#f1f1ec'; c.font = `bold 20px ${sans}`; c.textAlign = 'left';
    ['SITE 042  2', 'TARE    1 320 kg', 'PAYLOAD 8 840 kg', 'CU.CAP. 16.0 m3'].forEach((s, i) => c.fillText(s, 8, 26 + i * 27));
  });
  A.add('mill', 512, 70, (c, w, h) => { // mill marks on the beam web
    c.fillStyle = '#f0efe6'; c.font = `bold 34px ${sans}`; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText('S355J2  HEB 300  12000  H 48217', 10, h / 2);
    c.globalCompositeOperation = 'destination-out'; grunge(c, w, h, 41, 1.6, 'rgba(0,0,0,'); c.globalCompositeOperation = 'source-over';
  });
  A.add('chalk', 200, 80, (c, w, h) => {
    c.strokeStyle = 'rgba(240,240,230,0.9)'; c.lineWidth = 5; c.lineCap = 'round';
    c.beginPath(); c.moveTo(12, 50); c.lineTo(60, 20); c.moveTo(20, 20); c.lineTo(58, 60); c.stroke();
    c.fillStyle = 'rgba(240,240,230,0.92)'; c.font = `bold italic 38px ${sans}`; c.fillText('B4', 90, 56);
  });
  A.add('label', 256, 90, (c, w, h) => { // printed label on stretch wrap
    c.fillStyle = '#f4f4f0'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#b3261e'; c.fillRect(0, 0, 18, h);
    c.fillStyle = '#1a1a1a'; c.font = `bold 24px ${sans}`; c.fillText('FACING BRICK', 30, 34);
    c.font = `15px ${sans}`; c.fillText('215x102.5x65  400 pcs  1.2 t', 30, 60);
    c.fillRect(30, 70, 150, 12);
  });
  A.add('tag', 128, 80, (c, w, h) => { // bar bundle tag
    c.fillStyle = '#f2d21b'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#111'; c.font = `bold 18px ${sans}`; c.fillText('B500B', 10, 24); c.fillText('32 mm', 10, 46); c.fillText('6.0 m', 10, 68);
    c.beginPath(); c.arc(112, 14, 6, 0, TAU); c.fillStyle = '#555'; c.fill();
  });
  A.add('bucket', 240, 90, (c, w, h) => {
    c.fillStyle = '#141414'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, '1.0 m³  SWL 2.8 t', w / 2, h / 2, w - 20, 40, sans, 'bold');
    c.globalCompositeOperation = 'destination-out'; grunge(c, w, h, 51, 1.5, 'rgba(0,0,0,'); c.globalCompositeOperation = 'source-over';
  });
  A.add('oval', 64, 40, (c, w, h) => { c.fillStyle = '#0b0c0d'; c.beginPath(); c.ellipse(w / 2, h / 2, w / 2 - 4, h / 2 - 5, 0, 0, TAU); c.fill(); });
  A.add('hole', 32, 32, (c, w, h) => { c.fillStyle = '#121212'; c.beginPath(); c.arc(w / 2, h / 2, w / 2 - 3, 0, TAU); c.fill(); c.strokeStyle = '#6b6b6b'; c.lineWidth = 3; c.stroke(); });
  return A;
}

// Second decal atlas for the mobile-crane job loads (the first one is full).
function loadAtlas2() {
  const A = new Atlas(1024, 512);
  const sans = 'Arial, Helvetica, sans-serif';
  const stencil = 'Impact, "Arial Narrow", Arial, sans-serif';
  const worn = (c, w, h, seed, amt = 1.4) => { c.globalCompositeOperation = 'destination-out'; grunge(c, w, h, seed, amt, 'rgba(0,0,0,'); c.globalCompositeOperation = 'source-over'; };
  A.add('tb5', 300, 170, (c, w, h) => { // painted panel on the 5 t test block
    c.fillStyle = '#e3aa12'; c.fillRect(6, 6, w - 12, h - 12);
    c.fillStyle = '#141414'; c.textAlign = 'center'; c.textBaseline = 'middle';
    fitText(c, '5000 kg', w / 2, h * 0.42, w - 40, 84, stencil, 'normal');
    fitText(c, 'TEST BLOCK  No 7', w / 2, h * 0.8, w - 50, 24, sans, 'bold');
    worn(c, w, h, 121, 2.0);
  });
  A.add('hvac', 300, 110, (c, w, h) => { // aluminium maker's / lifting plate
    c.fillStyle = '#c9ccce'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#55595c'; c.lineWidth = 3; c.strokeRect(4, 4, w - 8, h - 8);
    c.fillStyle = '#16181a'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.font = `bold 26px ${sans}`; c.fillText('AHU-03  ROOF PLANT', 14, 36);
    c.font = `bold 20px ${sans}`; c.fillText('OPERATING MASS 3 000 kg', 14, 66);
    c.font = `16px ${sans}`; c.fillText('LIFT ONLY AT THE 4 MARKED EYES', 14, 92);
  });
  A.add('gen', 360, 120, (c, w, h) => { // white stencil on the canopy
    c.fillStyle = '#eef0ea'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.font = `bold 50px ${sans}`; c.fillText('500 kVA', 12, 56);
    c.font = `bold 24px ${sans}`; c.fillText('STANDBY GENERATOR', 14, 88);
    c.font = `bold 20px ${sans}`; c.fillText('GROSS 11 500 kg', 14, 112);
    worn(c, w, h, 131, 1.0);
  });
  A.add('pc', 260, 110, (c, w, h) => { // precaster's stencil + chalk
    c.fillStyle = 'rgba(30,30,30,0.9)'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.font = `bold 34px ${stencil}`; c.fillText('WP-07  L2', 10, 42);
    c.font = `bold 24px ${sans}`; c.fillText('4.2 t   28.05.', 12, 76);
    c.strokeStyle = 'rgba(40,40,40,0.9)'; c.lineWidth = 5; c.beginPath(); c.moveTo(220, 100); c.lineTo(220, 58); c.moveTo(206, 72); c.lineTo(220, 56); c.lineTo(234, 72); c.stroke();
    worn(c, w, h, 141, 1.2);
  });
  A.add('sb', 200, 110, (c, w, h) => { // bundle tag
    c.fillStyle = '#f2d21b'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#111'; c.font = `bold 26px ${sans}`; c.textAlign = 'left';
    c.fillText('HEB 260', 12, 32); c.fillText('8 × 8.00 m', 12, 64); c.fillText('5 952 kg', 12, 96);
    c.beginPath(); c.arc(184, 16, 7, 0, TAU); c.fillStyle = '#555'; c.fill();
  });
  A.add('trafo', 240, 140, (c, w, h) => { // stainless rating plate
    c.fillStyle = '#b9bdbf'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#3a3d40'; c.lineWidth = 2; c.strokeRect(5, 5, w - 10, h - 10);
    c.fillStyle = '#1a1c1e'; c.font = `bold 20px ${sans}`; c.textAlign = 'left';
    c.fillText('3~ TRANSFORMER  ONAN', 12, 30);
    c.font = `16px ${sans}`;
    ['2500 kVA   11 / 0.4 kV   Dyn11', 'uk 6.0 %   50 Hz   IEC 60076', 'OIL 1 450 kg   TOTAL 7 500 kg'].forEach((s, i) => c.fillText(s, 12, 60 + i * 26));
  });
  A.add('hv', 120, 100, (c, w, h) => { // electrical hazard triangle
    c.fillStyle = '#f5c400'; c.beginPath(); c.moveTo(w / 2, 6); c.lineTo(w - 6, h - 6); c.lineTo(6, h - 6); c.closePath(); c.fill();
    c.strokeStyle = '#111'; c.lineWidth = 6; c.stroke();
    c.fillStyle = '#111'; c.beginPath(); c.moveTo(64, 30); c.lineTo(48, 64); c.lineTo(60, 64); c.lineTo(52, 88); c.lineTo(74, 54); c.lineTo(62, 54); c.lineTo(70, 30); c.closePath(); c.fill();
  });
  A.add('fan', 128, 128, (c, w, h) => { // fan guard: rings + spokes (alpha-tested)
    c.strokeStyle = '#141516'; c.lineWidth = 3;
    for (let r = 12; r < 62; r += 8) { c.beginPath(); c.arc(64, 64, r, 0, TAU); c.stroke(); }
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; c.beginPath(); c.moveTo(64, 64); c.lineTo(64 + Math.cos(a) * 61, 64 + Math.sin(a) * 61); c.stroke(); }
    c.fillStyle = '#141516'; c.beginPath(); c.arc(64, 64, 10, 0, TAU); c.fill();
  });
  for (const [id, kg] of [['A', '11 500'], ['B', '12 000'], ['C', '11 500']]) {
    A.add('cw' + id, 320, 120, (c, w, h) => { // counterweight stencil
      c.fillStyle = '#121212'; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.font = `bold 96px ${stencil}`; c.fillText(id, 18, h / 2 + 4);
      c.font = `bold 40px ${stencil}`; c.fillText(`${kg} kg`, 96, h / 2 + 2);
      worn(c, w, h, 150 + id.charCodeAt(0), 1.6);
    });
  }
  return A;
}

function materials() {
  if (M) return M;
  const paint = (color, w = {}, o = {}) =>
    weathered(pbrMaterial('metal_painted', { color, metalness: 0, roughness: 1, normalScale: 0.6, repeat: 0.5, ...o }), { contrast: 0.5, ...w });
  const atlas = loadAtlas();
  const atlas2 = loadAtlas2();
  const rebar = pbrMaterial('rusty_metal', { repeat: 1 / 2.2, color: new THREE.Color().setRGB(0.75, 0.62, 0.55), roughness: 1.0 });
  rebar.normalMap = ribNormal();
  rebar.normalScale.set(1.4, 1.4);
  const wrap = glassMaterial({ color: 0xd8dde0, opacity: 0.16, roughness: 0.22, envMapIntensity: 1.3, side: THREE.FrontSide });
  wrap.normalMap = wrapNormal();
  wrap.normalScale.set(0.3, 0.3); // film wrinkles: subtle, or the reflections read as wood grain
  const brickMat = ({ map, normalMap }) => new THREE.MeshStandardMaterial({ map, normalMap, normalScale: new THREE.Vector2(1.3, 1.3), roughness: 0.9, metalness: 0 });
  const ply = weathered(pbrMaterial('plywood', { repeat: 2, color: new THREE.Color().setRGB(0.72, 0.5, 0.4), roughness: 0.75 }), { rust: 0, dirt: 1.8 });
  M = {
    atlas,
    decal: new THREE.MeshStandardMaterial({
      map: atlas.texture(), alphaTest: 0.45, roughness: 0.7, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    concrete: pbrMaterial('concrete_rough', { repeat: 0.5, albedo: 0.34 }),
    block: pbrMaterial('concrete_rough', { repeat: 0.5, albedo: 0.3, color: new THREE.Color().setRGB(0.95, 0.97, 1.0) }),
    blockCore: new THREE.MeshStandardMaterial({ color: 0x1b1b1a, roughness: 1 }),
    wetConcrete: pbrMaterial('concrete_slab', { repeat: 1 / 3, albedo: 0.09, roughness: 0.35, normalScale: 0.4 }),
    crust: pbrMaterial('concrete_rough', { repeat: 0.5, albedo: 0.26, color: new THREE.Color().setRGB(1, 0.98, 0.94) }),
    galv: pbrMaterial('galvanized_metal', { roughness: 1.05 }),
    steel: pbrMaterial('galvanized_metal', { color: new THREE.Color().setRGB(0.32, 0.31, 0.3), roughness: 1.15 }),
    wire: new THREE.MeshStandardMaterial({ color: 0x1c1c1d, roughness: 0.55, metalness: 0.7 }),
    rebar,
    brick: brickMat(brickPackTex(0.215, 0.065, 4, 8, 71)), // stretcher faces
    brickTop: brickMat(brickPackTex(0.215, 0.1025, 4, 4, 73)), // bed faces
    residue: new THREE.MeshStandardMaterial({
      map: residueTex(), alphaTest: 0.5, roughness: 0.95, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }),
    wood: pbrMaterial('wood_planks', { repeat: 1 / 1.5, color: new THREE.Color().setRGB(1.25, 1.15, 1.0) }),
    wrap,
    strap: new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.45 }),
    strapSteel: pbrMaterial('galvanized_metal', { roughness: 0.9, color: new THREE.Color().setRGB(0.7, 0.72, 0.75) }),
    ply,
    frameRed: paint(new THREE.Color().setRGB(0.95, 0.12, 0.05), { rust: 0.7, dirt: 1.6 }),
    primer: paint(new THREE.Color().setRGB(0.56, 0.16, 0.09), { rust: 1.3, dirt: 1.0 }, { normalScale: 0.9 }),
    bucketGrey: paint(new THREE.Color().setRGB(0.55, 0.58, 0.6), { rust: 1.2, dirt: 2.2 }),
    bucketYel: paint(new THREE.Color().setRGB(1.15, 0.68, 0.015), { rust: 1, dirt: 1.8 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x121213, roughness: 0.92 }),
    cont: paint(new THREE.Color().setRGB(0.07, 0.2, 0.52), { rust: 1.6, dirt: 1.3 }),
    contDark: paint(new THREE.Color().setRGB(0.05, 0.13, 0.32), { rust: 1.4, dirt: 1.2 }),
    gasket: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.85 }),
    // --- mobile-crane job loads
    atlas2,
    decal2: new THREE.MeshStandardMaterial({
      map: atlas2.texture(), alphaTest: 0.45, roughness: 0.6, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    precastFace: pbrMaterial('concrete_slab', { repeat: 1 / 3, albedo: 0.3, color: new THREE.Color().setRGB(0.98, 0.98, 1.0), roughness: 1.05 }),
    hvacCase: paint(new THREE.Color().setRGB(0.8, 0.82, 0.8), { rust: 0.25, dirt: 0.9 }, { roughness: 0.8 }), // RAL 7035 powder coat
    hvacTrim: paint(new THREE.Color().setRGB(0.55, 0.57, 0.57), { rust: 0.3, dirt: 1.0 }),
    louvre: paint(new THREE.Color().setRGB(0.08, 0.085, 0.09), { rust: 0.3, dirt: 0.6 }),
    genBody: paint(new THREE.Color().setRGB(0.035, 0.14, 0.075), { rust: 0.5, dirt: 1.5 }), // canopy green
    genBase: paint(new THREE.Color().setRGB(0.07, 0.075, 0.08), { rust: 0.9, dirt: 1.8 }),
    trafo: paint(new THREE.Color().setRGB(0.36, 0.4, 0.39), { rust: 0.6, dirt: 1.2 }), // RAL 7033 cement grey
    porcelain: new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.22, 0.09, 0.04), roughness: 0.18, metalness: 0 }),
    copper: new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.75, 0.38, 0.2), roughness: 0.35, metalness: 1 }),
    cwYel: paint(new THREE.Color().setRGB(1.2, 0.72, 0.018), { rust: 0.9, dirt: 2.0 }), // crane livery (as the tower)
    cwDark: paint(new THREE.Color().setRGB(0.09, 0.09, 0.095), { rust: 1.2, dirt: 1.2 }),
  };
  return M;
}

function decal2(kit, name, w, h, pos, normal, rotZ = 0) {
  const g = M.atlas2.quad(name, w, h);
  if (rotZ) g.rotateZ(rotZ);
  _q.setFromUnitVectors(V(0, 0, 1), normal.clone().normalize());
  _m.makeRotationFromQuaternion(_q).setPosition(pos);
  kit.add('decal2', g, _m.clone(), null, false);
}

function decal(kit, name, w, h, pos, normal, rotZ = 0) {
  const g = M.atlas.quad(name, w, h);
  if (rotZ) g.rotateZ(rotZ);
  _q.setFromUnitVectors(V(0, 0, 1), normal.clone().normalize());
  _m.makeRotationFromQuaternion(_q).setPosition(pos);
  kit.add('decal', g, _m.clone(), null, false);
}

// Trapezoidal corrugated sheet in the x-y plane facing +z (flat-shaded).
// length along x centred, height along y centred; pitch/depth in metres.
function corrugated(length, height, pitch = 0.278, depth = 0.036, flip = false) {
  const prof = [];
  const n = Math.max(1, Math.round(length / pitch));
  const p = length / n;
  for (let i = 0; i < n; i++) {
    const x0 = -length / 2 + i * p;
    prof.push([x0, 0], [x0 + p * 0.18, depth], [x0 + p * 0.5, depth], [x0 + p * 0.68, 0]);
  }
  prof.push([length / 2, 0]);
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i < prof.length - 1; i++) {
    const [xa, za] = prof[i], [xb, zb] = prof[i + 1];
    const dx = xb - xa, dz = zb - za, l = Math.hypot(dx, dz);
    const nx = -dz / l, nz = dx / l;
    const b = pos.length / 3;
    for (const [x, z] of [[xa, za], [xb, zb]]) {
      for (const y of [-height / 2, height / 2]) {
        pos.push(x, y, z);
        nor.push(nx, 0, nz);
        uv.push(x + length / 2, y + height / 2);
      }
    }
    idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  if (flip) g.rotateY(Math.PI);
  return g;
}

// ------------------------------------------------------------ builders
function testWeight(kit, sx, sy, sz) {
  // precast block with a cast-in galvanised lifting loop and painted weight panel
  const blk = new RoundedBoxGeometry(sx, sy, sz, 2, 0.025);
  const uv = blk.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  kit.add('concrete', blk, null, null, true);
  const loop = mTorus(0.085, 0.016, 8, 16, Math.PI);
  loop.translate(0, sy / 2 - 0.01, 0);
  kit.add('galv', loop, null, null, false);
  kit.cyl('concrete', 0.12, 0.02, 0, sy / 2 - 0.004, 0, 'y', 18); // grout pocket
  for (const [n, p] of [[V(0, 0, 1), V(0, 0.05, sz / 2 + 0.002)], [V(1, 0, 0), V(sx / 2 + 0.002, 0.05, 0)], [V(0, 0, -1), V(0, 0.05, -sz / 2 - 0.002)]]) {
    decal(kit, 'tw', 0.62, 0.35, p, n);
  }
}

function rebar(kit, sx, sy, sz) {
  const r = 0.016, sp = 0.034; // 32 mm bars, hex-packed in a flattened bundle
  const rand = rng(7);
  const a = sz / 2 - 0.03, b = sy / 2 - 0.02;
  let rows = 0;
  for (let y = -b + r; y <= b - r; y += sp * 0.866, rows++) {
    const off = rows % 2 ? sp / 2 : 0;
    for (let z = -a + r + off; z <= a - r; z += sp) {
      // elliptical bundle cross-section (slings pull it round)
      if ((z / a) ** 2 + (y / b) ** 2 > 1) continue;
      const len = sx - 0.06 - rand() * 0.1;
      const g = mCyl(r, r, len, 7, false);
      g.rotateZ(Math.PI / 2);
      g.translate((rand() - 0.5) * 0.06, y + (rand() - 0.5) * 0.004, z + (rand() - 0.5) * 0.004);
      kit.add('rebar', g);
    }
  }
  // tie-wire bindings (3 turns) at three stations + bundle tag
  for (const x of [-2.4, 0, 2.4]) {
    for (let k = -1; k <= 1; k++) {
      const pts = [];
      for (let i = 0; i < 28; i++) {
        const t = (i / 28) * TAU;
        pts.push(V(x + k * 0.012, Math.sin(t) * (b + 0.018), Math.cos(t) * (a + 0.018)));
      }
      kit.add('wire', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 40, 0.0035, 4, true), null, null, false);
    }
    kit.box('wire', 0.02, 0.03, 0.012, x, b + 0.03, 0.02);
  }
  kit.box('strap', 0.004, 0.06, 0.1, 2.42, 0.1, a + 0.05);
  decal(kit, 'tag', 0.09, 0.056, V(2.424, 0.1, a + 0.05), V(1, 0, 0));
}

function pallet(kit, sx, sy, sz) {
  // EUR-style pallet: 3 bottom boards, 9 blocks, 3 stringers, 5 top boards
  const y0 = -sy / 2;
  for (const z of [-sz / 2 + 0.05, 0, sz / 2 - 0.05]) kit.box('wood', sx, 0.022, 0.1, 0, y0 + 0.011, z);
  for (const x of [-sx / 2 + 0.07, 0, sx / 2 - 0.07]) for (const z of [-sz / 2 + 0.05, 0, sz / 2 - 0.05]) kit.box('wood', 0.14, 0.078, 0.1, x, y0 + 0.061, z);
  for (const z of [-sz / 2 + 0.05, 0, sz / 2 - 0.05]) kit.box('wood', sx, 0.022, 0.1, 0, y0 + 0.111, z);
  for (let i = 0; i < 5; i++) kit.box('wood', sx, 0.022, 0.12, 0, y0 + 0.133, -sz / 2 + 0.06 + i * (sz - 0.12) / 4);
  return y0 + 0.144;
}

function bricks(kit, sx, sy, sz) {
  const top = pallet(kit, sx, sy, sz);
  const w = sx - 0.08, d = sz - 0.08, h = sy / 2 - 0.02 - top;
  // brick stack: packs of 65 mm courses with small gaps (no mortar); the
  // top shows the bricks' bed faces, so it gets its own pattern
  kit.box('brick', w, h - 0.002, d, 0, top + h / 2 - 0.001, 0);
  const lid = mPlane(w, d);
  lid.rotateX(-Math.PI / 2);
  lid.translate(0, top + h, 0);
  kit.add('brickTop', lid);
  // stretch wrap (sides + top, slightly bulged over the edges) + label
  const wr = new RoundedBoxGeometry(w + 0.03, h + 0.02, d + 0.03, 2, 0.03);
  const uv = wr.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w + d) * 0.5, uv.getY(i) * h);
  wr.translate(0, top + h / 2 + 0.005, 0);
  kit.add('wrap', wr, null, null, false);
  decal(kit, 'label', 0.34, 0.12, V(0.1, top + h * 0.72, d / 2 + 0.018), V(0, 0, 1));
  straps(kit, w + 0.035, h + 0.03, d + 0.035, top, 'strap');
}

function blocks(kit, sx, sy, sz) {
  const top = pallet(kit, sx, sy, sz);
  // 390x190x190 hollow blocks, 3 x 5 per layer, 6 layers (gaps 6 mm)
  const nx = 3, nz = 5, ny = 6;
  const bx = (sx - 0.04) / nx, bz = (sz - 0.04) / nz, by = (sy / 2 - 0.015 - top) / ny;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const x = -sx / 2 + 0.02 + (i + 0.5) * bx, z = -sz / 2 + 0.02 + (k + 0.5) * bz, y = top + (j + 0.5) * by;
        kit.box('block', bx - 0.008, by - 0.006, bz - 0.008, x, y, z);
        if (j === ny - 1) for (const dx of [-bx * 0.24, bx * 0.24]) kit.box('blockCore', bx * 0.3, 0.004, bz * 0.62, x + dx, y + by / 2 - 0.0005, z);
      }
    }
  }
  straps(kit, sx - 0.03, sy / 2 - top, sz - 0.03, top, 'strapSteel');
}

// packing bands: 2 lengthwise + 2 crosswise, over the top and down the sides
function straps(kit, w, h, d, base, key) {
  const t = 0.003, bw = 0.016;
  for (const z of [-d * 0.28, d * 0.28]) {
    kit.box(key, w + 2 * t, t, bw, 0, base + h + t / 2, z);
    for (const s of [-1, 1]) kit.box(key, t, h + 0.13, bw, s * (w / 2 + t / 2), base + h / 2 - 0.065, z);
  }
  for (const x of [-w * 0.3, w * 0.3]) {
    kit.box(key, bw, t, d + 2 * t, x, base + h + t * 1.5, 0);
    for (const s of [-1, 1]) kit.box(key, bw, h + 0.13, t, x, base + h / 2 - 0.065, s * (d / 2 + t / 2));
  }
}

function shutter(kit, sx, sy, sz) {
  // framed formwork panel: film-faced ply face (+z), steel frame, walers, lifting eyes
  const zf = sz / 2;
  kit.box('ply', sx - 0.02, sy - 0.02, 0.021, 0, 0, zf - 0.0105);
  // cement laitance on the used face (UV 0..1 over the whole face)
  const film = new THREE.PlaneGeometry(sx - 0.03, sy - 0.03);
  film.translate(0, 0, zf + 0.0008);
  kit.add('residue', film, null, null, false);
  const fz = zf - 0.021 - 0.06; // frame centre (120 deep)
  const fr = (a, b, w = 0.12, d = 0.06) => kit.member('frameRed', a, b, { k: 'box', w, d }, V(0, 0, 1), 0.8);
  fr(V(-sx / 2 + 0.03, -sy / 2, fz), V(-sx / 2 + 0.03, sy / 2, fz), 0.12, 0.06);
  fr(V(sx / 2 - 0.03, -sy / 2, fz), V(sx / 2 - 0.03, sy / 2, fz), 0.12, 0.06);
  for (const y of [-sy / 2 + 0.03, sy / 2 - 0.03]) fr(V(-sx / 2 + 0.06, y, fz), V(sx / 2 - 0.06, y, fz), 0.12, 0.06);
  for (let i = 1; i < 6; i++) fr(V(-sx / 2 + 0.06, -sy / 2 + i * sy / 6, fz), V(sx / 2 - 0.06, -sy / 2 + i * sy / 6, fz), 0.1, 0.012);
  for (const x of [-0.6, 0.6]) fr(V(x, -sy / 2 + 0.06, fz), V(x, sy / 2 - 0.06, fz), 0.12, 0.05);
  // walers (channels) + waler clamps
  for (const y of [-0.62, 0.62]) {
    kit.member('primer', V(-sx / 2 + 0.05, y, -zf + 0.07), V(sx / 2 - 0.05, y, -zf + 0.07), { k: 'C', h: 0.14, b: 0.06, tw: 0.006, tf: 0.009 }, UP, 1);
    for (const x of [-1.2, 0, 1.2]) kit.box('steel', 0.06, 0.18, 0.05, x, y, -zf + 0.1);
  }
  // tie holes through the face + plugs, lifting eyes at the sling points
  for (const x of [-1.2, 0, 1.2]) for (const y of [-0.62, 0.62]) decal(kit, 'hole', 0.05, 0.05, V(x, y, zf + 0.002), V(0, 0, 1));
  for (const x of [-1.2, 1.2]) {
    kit.box('steel', 0.12, 0.08, 0.06, x, sy / 2 - 0.02, fz);
    const eye = mTorus(0.04, 0.012, 6, 14, Math.PI);
    eye.translate(x, sy / 2 - 0.055, fz);
    kit.add('steel', eye, null, null, false);
  }
}

function beam(kit, sx, sy, sz) {
  // HEB 300, red-oxide primer; mill marks + chalk on the web, bare saw-cut ends
  const L = sx - 0.004;
  kit.member('primer', V(-L / 2, 0, 0), V(L / 2, 0, 0), { k: 'I', h: sy, b: sz, tw: 0.011, tf: 0.019 }, UP, 1);
  for (const s of [-1, 1]) {
    // bare saw-cut ends (I-shaped caps)
    const x = s * (L / 2 + 0.001);
    kit.box('steel', 0.002, sy - 0.038, 0.011, x, 0, 0);
    for (const y of [-1, 1]) kit.box('steel', 0.002, 0.019, sz, x, y * (sy / 2 - 0.0095), 0);
    decal(kit, 'mill', 1.5, 0.2, V(-2.2, 0.0, s * 0.0065), V(0, 0, s));
  }
  decal(kit, 'chalk', 0.5, 0.2, V(3.4, 0.0, 0.0065), V(0, 0, 1));
}

function bucket(kit, sx, sy, sz) {
  // bottom-discharge concrete skip: cylinder + cone, 4 legs, gate + lever,
  // rubber chute, bail; grey with concrete crust
  const R = Math.min(sx, sz) / 2 - 0.02, y0 = -sy / 2;
  const prof = [
    [0.17, y0 + 0.22], [0.2, y0 + 0.26], [R, y0 + 0.95], [R, sy / 2 - 0.08], [R + 0.02, sy / 2 - 0.06], [R + 0.02, sy / 2 - 0.02],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const shell = new THREE.LatheGeometry(prof, 40);
  const uv = shell.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * TAU * R, uv.getY(i) * 1.9);
  kit.add('bucketGrey', shell, null, [0.4, 9, 0.8]);
  // splashed-on concrete crust over the cone and barrel (alpha-tested film,
  // heaviest low down where every pour drips off the gate)
  const splash = new THREE.LatheGeometry(prof.slice(1, 4).map((p) => new THREE.Vector2(p.x + 0.004, p.y)), 40);
  kit.add('residue', splash, null, null, false);
  const inner = new THREE.LatheGeometry(prof.slice(2).reverse().map((p) => new THREE.Vector2(p.x - 0.012, p.y)), 40);
  kit.add('bucketGrey', inner, null, WEAR_JOINT);
  // wet concrete surface + crusty buildup at the rim
  const top = new THREE.CircleGeometry(R - 0.015, 36);
  top.rotateX(-Math.PI / 2);
  top.translate(0, sy / 2 - 0.3, 0);
  kit.add('wetConcrete', top);
  const rim = mTorus(R + 0.01, 0.035, 6, 40);
  rim.rotateX(Math.PI / 2);
  rim.translate(0, sy / 2 - 0.03, 0);
  kit.add('crust', rim);
  // stiffener bands + legs + feet
  for (const y of [y0 + 1.05, sy / 2 - 0.35]) {
    const band = mTorus(R + 0.005, 0.022, 4, 40);
    band.rotateX(Math.PI / 2);
    band.translate(0, y, 0);
    kit.add('bucketYel', band, null, WEAR_LIGHT);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const c = Math.cos(a), s = Math.sin(a);
    kit.member('bucketYel', V(c * (R - 0.02), y0 + 1.05, s * (R - 0.02)), V(c * (R - 0.05), y0, s * (R - 0.05)), { k: 'box', w: 0.07, d: 0.07 }, null, 1);
    kit.box('bucketYel', 0.16, 0.02, 0.16, c * (R - 0.05), y0 + 0.01, s * (R - 0.05));
    kit.member('bucketYel', V(c * (R - 0.05), y0 + 0.3, s * (R - 0.05)), V(c * 0.24, y0 + 0.3, s * 0.24), { k: 'box', w: 0.05, d: 0.05 }, UP, 0.7);
  }
  // discharge gate, lever, rubber chute
  kit.box('bucketGrey', 0.46, 0.04, 0.46, 0, y0 + 0.21, 0, null, WEAR_JOINT);
  kit.cyl('crust', 0.14, 0.05, 0, y0 + 0.17, 0, 'y', 16);
  kit.member('steel', V(0.22, y0 + 0.24, 0.1), V(0.65, y0 + 0.62, 0.55), { k: 'tube', r: 0.02, seg: 8 }, null, 0);
  kit.add('rubber', sweepGeo([V(0.66, y0 + 0.63, 0.56), V(0.7, y0 + 0.67, 0.6), V(0.72, y0 + 0.7, 0.62)], () => 0.028, { steps: 6, seg: 8 }), null, null, false);
  const chute = new THREE.CylinderGeometry(0.12, 0.1, 0.18, 16, 1, true);
  chute.translate(0, y0 + 0.1, 0);
  kit.add('rubber', chute, null, null, false);
  // bail (trunnions on the rim band, round bar arch up to +0.28)
  const bl = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, a = Math.PI * t;
    bl.push(V(-Math.cos(a) * (R + 0.04), sy / 2 - 0.3 + Math.sin(a) * 0.58, 0));
  }
  kit.add('bucketYel', sweepGeo(bl, () => 0.028, { steps: 36, seg: 10, capEnd: false }), null, WEAR_LIGHT, false);
  for (const s of [-1, 1]) kit.cyl('steel', 0.05, 0.08, s * (R + 0.02), sy / 2 - 0.3, 0, 'x', 14);
  kit.box('bucketYel', 0.4, 0.16, 0.012, 0, sy / 2 - 0.2, R + 0.004);
  decal(kit, 'bucket', 0.38, 0.14, V(0, sy / 2 - 0.2, R + 0.011), V(0, 0, 1));
}

function container(kit, sx, sy, sz) {
  // 10 ft site store: corrugated walls, top/bottom rails, corner posts +
  // castings, twin doors with locking bars, stencils
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const wallH = sy - 0.26;
  const wy = -hy + 0.16 + wallH / 2;
  for (const s of [-1, 1]) {
    const side = corrugated(sx - 0.24, wallH, 0.278, 0.036, s < 0);
    side.translate(0, wy, s * (hz - 0.045));
    kit.add('cont', side, null, [0.8, 0.8, 0.5]);
  }
  const front = corrugated(sz - 0.24, wallH, 0.278, 0.036);
  front.rotateY(-Math.PI / 2);
  front.translate(-hx + 0.045, wy, 0);
  kit.add('cont', front, null, [0.8, 0.8, 0.5]);
  kit.box('cont', sx - 0.1, 0.04, sz - 0.1, 0, hy - 0.035, 0, null, [0.6, 0.6, 0.6]); // roof
  for (let i = 0; i < 9; i++) kit.box('cont', 0.12, 0.012, sz - 0.14, -hx + 0.25 + i * (sx - 0.5) / 8, hy - 0.012, 0);
  // rails
  for (const s of [-1, 1]) {
    kit.member('contDark', V(-hx + 0.08, -hy + 0.08, s * (hz - 0.04)), V(hx - 0.08, -hy + 0.08, s * (hz - 0.04)), { k: 'box', w: 0.16, d: 0.08 }, UP, 1);
    kit.member('contDark', V(-hx + 0.08, hy - 0.045, s * (hz - 0.035)), V(hx - 0.08, hy - 0.045, s * (hz - 0.035)), { k: 'box', w: 0.09, d: 0.07 }, UP, 1);
    for (const x of [-0.55, 0.55]) kit.box('gasket', 0.36, 0.1, 0.01, x, -hy + 0.08, s * hz); // forklift pockets
  }
  for (const x of [-hx + 0.04, hx - 0.04]) {
    kit.member('contDark', V(x, -hy + 0.08, -hz + 0.08), V(x, -hy + 0.08, hz - 0.08), { k: 'box', w: 0.16, d: 0.08 }, UP, 1);
    kit.member('contDark', V(x, hy - 0.05, -hz + 0.08), V(x, hy - 0.05, hz - 0.08), { k: 'box', w: 0.1, d: 0.08 }, UP, 1);
  }
  // corner posts + castings (ISO fittings with oval apertures)
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      kit.box('contDark', 0.15, sy - 0.24, 0.15, x * (hx - 0.075), 0, z * (hz - 0.075), null, [0.3, 0.3, 0.8]);
      for (const y of [-1, 1]) {
        const p = V(x * (hx - 0.089), y * (hy - 0.059), z * (hz - 0.081));
        kit.box('contDark', 0.178, 0.118, 0.162, p.x, p.y, p.z, null, WEAR_JOINT);
        decal(kit, 'oval', 0.1, 0.06, V(p.x, p.y, z * (hz + 0.001)), V(0, 0, z));
        decal(kit, 'oval', 0.1, 0.06, V(x * (hx + 0.001), p.y, p.z), V(x, 0, 0), Math.PI / 2);
        if (y > 0) decal(kit, 'oval', 0.1, 0.06, V(p.x, hy + 0.001, p.z), V(0, 1, 0));
      }
    }
  }
  // doors (+x end): two leaves, vertical corrugation, 4 locking bars
  const dw = (sz - 0.3) / 2;
  for (const s of [-1, 1]) {
    const leaf = corrugated(dw - 0.02, wallH, 0.24, 0.03);
    leaf.rotateY(Math.PI / 2);
    leaf.translate(hx - 0.1, wy, s * (dw / 2 + 0.005));
    kit.add('cont', leaf, null, [0.8, 0.8, 0.5]);
    kit.box('gasket', 0.012, wallH, 0.02, hx - 0.075, wy, s * 0.005);
    for (const zz of [s * (dw * 0.25), s * (dw * 0.8)]) {
      kit.member('galv', V(hx - 0.045, -hy + 0.2, zz), V(hx - 0.045, hy - 0.2, zz), { k: 'tube', r: 0.014, seg: 8 }, null, 0.4);
      for (const y of [-hy + 0.19, hy - 0.19]) kit.box('galv', 0.05, 0.05, 0.05, hx - 0.05, y, zz);
      kit.box('galv', 0.05, 0.03, 0.14, hx - 0.025, -0.1, zz - s * 0.06);
      for (const y of [-0.9, 0.2, 0.9]) kit.box('galv', 0.025, 0.02, 0.04, hx - 0.05, y, zz);
    }
    for (const y of [-0.8, 0, 0.8]) kit.box('steel', 0.04, 0.12, 0.05, hx - 0.03, y, s * (hz - 0.14));
  }
  decal(kit, 'contDoor', 0.5, 0.3, V(hx - 0.068, 0.55, 0.62), V(1, 0, 0));
  for (const s of [-1, 1]) decal(kit, 'cont', 1.2, 0.5, V(0.2, 0.55, s * (hz - 0.004)), V(0, 0, s));
}

// ------------------------------------------------------------ mobile-crane job loads
// Cast-in lifting loop standing on a top face at (x, y, z), in plane `yaw`.
function liftLoop(kit, x, y, z, yaw = 0, R = 0.06, r = 0.013) {
  const g = mTorus(R, r, 8, 14, Math.PI);
  g.rotateY(yaw);
  g.translate(x, y, z);
  kit.add('galv', g, null, null, false);
}

// Welded lifting lug (plate + eye) on a top face.
function lug(kit, key, x, y, z, yaw = 0) {
  kit.box(key, 0.14, 0.09, 0.03, x, y + 0.045, z, [0, yaw, 0], WEAR_JOINT);
  const eye = mTorus(0.03, 0.012, 6, 12);
  eye.rotateY(yaw);
  eye.translate(x, y + 0.075, z);
  kit.add('steel', eye, null, null, false);
}

function testBlock5(kit, sx, sy, sz, def) {
  // 5 t precast proof-load block, four cast-in loops, painted weight panels
  const blk = new RoundedBoxGeometry(sx, sy, sz, 2, 0.03);
  const uv = blk.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  kit.add('concrete', blk, null, null, true);
  // formwork joint lines (the block is cast in two lifts)
  kit.box('crust', sx + 0.004, 0.012, sz + 0.004, 0, -0.08, 0);
  for (const [px, pz] of def.points) {
    kit.cyl('crust', 0.11, 0.02, px, sy / 2 - 0.006, pz, 'y', 16); // grout pocket
    liftLoop(kit, px, sy / 2 - 0.01, pz, Math.PI / 4 * Math.sign(px * pz));
  }
  for (const [n, p] of [[V(0, 0, 1), V(0, 0.12, sz / 2 + 0.002)], [V(0, 0, -1), V(0, 0.12, -sz / 2 - 0.002)], [V(1, 0, 0), V(sx / 2 + 0.002, 0.12, 0)]]) {
    decal2(kit, 'tb5', 0.66, 0.37, p, n);
  }
}

function hvacUnit(kit, sx, sy, sz, def) {
  // packaged rooftop air-handling unit: channel skid, panelled casing with
  // access doors, intake louvre at −x, two condenser fans on top at +x
  const y0 = -sy / 2, skid = 0.14, top = sy / 2 - 0.07;
  const hB = top - (y0 + skid);
  const yc = y0 + skid + hB / 2;
  for (const s of [-1, 1]) {
    kit.member('louvre', V(-sx / 2, y0 + skid / 2, s * (sz / 2 - 0.05)), V(sx / 2, y0 + skid / 2, s * (sz / 2 - 0.05)), { k: 'box', w: skid, d: 0.1 }, UP, 0.7);
  }
  for (const x of [-1.8, -0.6, 0.6, 1.8]) kit.box('louvre', 0.08, 0.1, sz - 0.2, x, y0 + 0.07, 0);
  kit.box('hvacCase', sx - 0.02, hB, sz - 0.05, 0, yc, 0);
  kit.box('hvacTrim', sx, 0.035, sz - 0.02, 0, top - 0.0175, 0); // roof flashing
  for (const s of [-1, 1]) {
    const zf = s * (sz / 2 - 0.025);
    // panel seams + door frames, hinges and quarter-turn latches
    for (const x of [-1.575, -0.525, 0.525, 1.575]) kit.box('hvacTrim', 0.035, hB - 0.04, 0.012, x, yc, zf + s * 0.006);
    kit.box('hvacTrim', sx - 0.04, 0.03, 0.012, 0, yc - 0.1, zf + s * 0.006);
    for (const x of [-1.05, 0.0, 1.05]) {
      kit.box('hvacTrim', 0.9, hB * 0.72, 0.01, x, yc + 0.05, zf + s * 0.013);
      for (const dy of [-0.5, 0.5]) kit.box('galv', 0.03, 0.09, 0.02, x - s * 0.44, yc + 0.05 + dy, zf + s * 0.022);
      kit.box('louvre', 0.05, 0.12, 0.03, x + s * 0.38, yc + 0.08, zf + s * 0.025);
    }
  }
  // intake louvre + filter frame on the −x end
  const xe = -sx / 2 + 0.005;
  kit.box('hvacTrim', 0.02, hB * 0.78, sz * 0.8, xe - 0.005, yc, 0);
  for (let i = 0; i < 12; i++) kit.box('louvre', 0.06, 0.03, sz * 0.76, xe - 0.03, yc - hB * 0.36 + i * hB * 0.065, 0, [0, 0, -0.7]);
  // electrical isolator + gland plate on the +x end
  kit.box('hvacTrim', 0.12, 0.35, 0.3, sx / 2 + 0.0, yc + 0.35, sz * 0.25);
  kit.box('louvre', 0.02, 0.06, 0.06, sx / 2 + 0.07, yc + 0.35, sz * 0.25);
  // condenser fans: raised shroud rings with guards
  for (const x of [0.45, 1.45]) {
    const ring = mCyl(0.44, 0.44, 0.06, 28, true);
    ring.translate(x, top + 0.03, 0);
    kit.add('hvacTrim', ring, null, null, false);
    decal2(kit, 'fan', 0.86, 0.86, V(x, top + 0.058, 0), V(0, 1, 0));
    kit.cyl('louvre', 0.43, 0.01, x, top + 0.004, 0, 'y', 24); // dark fan well under the guard
  }
  // coil grille panel on the −x half of the roof
  kit.box('louvre', 1.6, 0.012, sz - 0.4, -1.0, top + 0.006, 0);
  // lifting eyes at the four sling points
  for (const [px, pz] of def.points) lug(kit, 'hvacTrim', px, top - 0.005, pz, Math.PI / 2);
  decal2(kit, 'hvac', 0.46, 0.17, V(-1.55, yc + 0.55, sz / 2 + 0.004), V(0, 0, 1));
}

function generatorSet(kit, sx, sy, sz, def) {
  // canopied diesel generator: bunded fuel-tank base, sound-attenuated
  // enclosure (doors both sides), radiator discharge at +x, intake at −x,
  // roof silencer, corner castings and four roof lifting eyes
  const y0 = -sy / 2, base = 0.36, roof = sy / 2 - 0.3; // silencer fits under the box top
  const hE = roof - (y0 + base), yc = y0 + base + hE / 2;
  kit.box('genBase', sx, base, sz, 0, y0 + base / 2, 0);
  for (const x of [-2.2, 0, 2.2]) for (const s of [-1, 1]) kit.box('genBase', 0.5, 0.18, 0.02, x, y0 + 0.14, s * (sz / 2 + 0.008)); // forklift pockets
  kit.box('genBody', sx - 0.06, hE, sz - 0.06, 0, yc, 0);
  kit.box('genBody', sx, 0.05, sz, 0, roof + 0.025, 0); // drip-edge roof
  for (const s of [-1, 1]) {
    const zf = s * (sz / 2 - 0.03);
    for (const [x, grille] of [[-1.95, true], [-0.65, false], [0.65, false], [1.95, true]]) {
      kit.box('genBody', 1.18, hE - 0.18, 0.012, x, yc, zf + s * 0.007);
      kit.box('louvre', 0.02, hE - 0.2, 0.014, x - 0.6, yc, zf + s * 0.008); // door gap
      for (const dy of [-0.55, 0.55]) kit.box('galv', 0.035, 0.1, 0.025, x - 0.56, yc + dy, zf + s * 0.02); // hinges
      kit.box('louvre', 0.18, 0.05, 0.04, x + 0.42, yc, zf + s * 0.03); // lockable handle
      if (grille) for (let i = 0; i < 8; i++) kit.box('louvre', 0.8, 0.035, 0.03, x, yc + 0.1 + i * 0.075, zf + s * 0.018, [0.6 * s, 0, 0]);
    }
    decal2(kit, 'gen', 1.0, 0.33, V(0, yc + 0.55, s * (sz / 2 + 0.003)), V(0, 0, s));
  }
  // radiator discharge (+x) and intake (−x) louvres, control-panel window
  for (const e of [-1, 1]) {
    const xe = e * (sx / 2 - 0.02);
    kit.box('genBase', 0.02, hE * 0.8, sz * 0.8, xe + e * 0.005, yc, 0);
    for (let i = 0; i < 13; i++) kit.box('louvre', 0.05, 0.035, sz * 0.76, xe + e * 0.03, yc - hE * 0.36 + i * hE * 0.06, 0, [0, 0, 0.7 * e]);
  }
  // silencer on the roof, tail pipe with rain cap
  const sil = mCyl(0.14, 0.14, 1.5, 18);
  sil.rotateZ(Math.PI / 2);
  sil.translate(0.9, roof + 0.15, -0.3);
  kit.add('steel', sil, null, [0.3, 0.3, 1.2]);
  for (const x of [0.4, 1.4]) kit.box('genBase', 0.08, 0.05, 0.3, x, roof + 0.05, -0.3);
  kit.cyl('steel', 0.07, 0.16, 1.72, roof + 0.2, -0.3, 'y', 12);
  kit.box('steel', 0.18, 0.012, 0.18, 1.72, roof + 0.285, -0.3, [0.3, 0, 0]);
  // corner castings + roof lifting eyes
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    kit.box('genBase', 0.16, 0.12, 0.16, x * (sx / 2 - 0.08), y0 + 0.06, z * (sz / 2 - 0.08), null, WEAR_JOINT);
  }
  for (const [px, pz] of def.points) lug(kit, 'genBase', px, roof + 0.05, pz);
  kit.cyl('galv', 0.06, 0.05, -2.6, roof + 0.075, 0.6, 'y', 12); // fuel filler
}

function precastPanel(kit, sx, sy, sz, def) {
  // storey-height precast wall panel with a window opening, two cast-in
  // spherical-head anchors on top (clutch rings on), steel-float faces
  const wx0 = 0.35, wx1 = 1.55, wy0 = -0.35, wy1 = 0.75; // window opening (local)
  const k = 'precastFace';
  kit.box(k, wx0 + sx / 2, sy, sz, (-sx / 2 + wx0) / 2, 0, 0);
  kit.box(k, sx / 2 - wx1, sy, sz, (wx1 + sx / 2) / 2, 0, 0);
  kit.box(k, wx1 - wx0, sy / 2 - wy1, sz, (wx0 + wx1) / 2, (wy1 + sy / 2) / 2, 0);
  kit.box(k, wx1 - wx0, wy0 + sy / 2, sz, (wx0 + wx1) / 2, (wy0 - sy / 2) / 2, 0);
  // window reveal: rebate + frame fixing strips
  kit.box('crust', wx1 - wx0, 0.015, sz * 0.5, (wx0 + wx1) / 2, wy0 + 0.008, 0);
  for (const [px] of def.points) {
    kit.cyl('crust', 0.06, 0.012, px, sy / 2 - 0.004, 0, 'y', 14); // anchor recess
    const ring = mTorus(0.05, 0.012, 6, 14, Math.PI); // lifting clutch ring (kept ≤ 7 cm proud)
    ring.translate(px, sy / 2 + 0.005, 0);
    kit.add('galv', ring, null, null, false);
    kit.box('frameRed', 0.1, 0.03, 0.07, px, sy / 2 + 0.012, 0);
  }
  // grout sleeves on the bottom edge, fixing sockets on the face
  for (const x of [-1.6, -0.4, 1.8]) kit.cyl('crust', 0.025, 0.01, x, -sy / 2 + 0.25, sz / 2 + 0.002, 'z', 10);
  decal2(kit, 'pc', 0.62, 0.26, V(-1.1, 0.45, sz / 2 + 0.003), V(0, 0, 1));
}

function steelBundle(kit, sx, sy, sz) {
  // 8 × HEB 260 in two layers of four on timber spacers, three steel bands
  const L = sx - 0.02, hb = 0.26, b = 0.25;
  const layers = [-sy / 2 + hb / 2, -sy / 2 + hb + 0.06 + hb / 2];
  for (const y of layers) {
    for (const z of [-0.375, -0.125, 0.125, 0.375]) {
      kit.member('primer', V(-L / 2, y, z), V(L / 2, y, z), { k: 'I', h: hb, b, tw: 0.01, tf: 0.0175 }, UP, 1);
    }
  }
  for (const x of [-3.0, 0, 3.0]) kit.box('wood', 0.1, 0.06, sz, x, -sy / 2 + hb + 0.03, 0);
  const top = layers[1] + hb / 2;
  for (const x of [-2.2, 0.4, 3.2]) {
    kit.box('strapSteel', 0.032, 0.004, sz + 0.012, x, top + 0.002, 0);
    kit.box('strapSteel', 0.032, 0.004, sz + 0.012, x, -sy / 2 - 0.002, 0);
    for (const s of [-1, 1]) kit.box('strapSteel', 0.032, sy, 0.004, x, 0, s * (sz / 2 + 0.006));
    kit.box('strapSteel', 0.05, 0.02, 0.04, x, top + 0.012, 0.2); // seal
  }
  decal2(kit, 'sb', 0.2, 0.11, V(L / 2 + 0.004, layers[1], 0.125), V(1, 0, 0));
}

function transformerUnit(kit, sx, sy, sz, def) {
  // oil-immersed distribution transformer: skid, tank with panel radiators on
  // both long sides, conservator, HV (3) and LV (4) bushings, lifting lugs
  const y0 = -sy / 2;
  for (const s of [-1, 1]) kit.member('trafo', V(-0.95, y0 + 0.06, s * 0.5), V(0.95, y0 + 0.06, s * 0.5), { k: 'C', h: 0.12, b: 0.06, tw: 0.008, tf: 0.01 }, UP, 1);
  const tb = y0 + 0.12, th = 1.25, tank = [1.7, 0.95];
  kit.box('trafo', tank[0], th, tank[1], 0, tb + th / 2, 0);
  const cover = tb + th;
  kit.box('trafo', tank[0] + 0.1, 0.05, tank[1] + 0.1, 0, cover + 0.025, 0, null, WEAR_JOINT);
  // radiators: 2 banks per long side, 9 fins each, top/bottom headers
  for (const s of [-1, 1]) {
    for (const bx of [-0.45, 0.45]) {
      for (let i = 0; i < 9; i++) kit.box('trafo', 0.022, 0.95, 0.26, bx - 0.32 + i * 0.08, tb + 0.62, s * (tank[1] / 2 + 0.14));
      for (const y of [tb + 0.12, tb + 1.1]) {
        const h = mCyl(0.04, 0.04, 0.72, 10);
        h.rotateZ(Math.PI / 2);
        h.translate(bx, y, s * (tank[1] / 2 + 0.14));
        kit.add('trafo', h);
        kit.cyl('trafo', 0.035, 0.14, bx, y, s * (tank[1] / 2 + 0.05), 'z', 8);
      }
    }
  }
  // conservator on brackets, Buchholz pipe
  const con = mCyl(0.15, 0.15, 1.0, 18);
  con.rotateZ(Math.PI / 2);
  con.translate(-0.2, cover + 0.42, -0.34);
  kit.add('trafo', con);
  for (const x of [-0.55, 0.15]) kit.box('trafo', 0.05, 0.3, 0.05, x, cover + 0.2, -0.34);
  kit.cyl('trafo', 0.03, 0.3, -0.75, cover + 0.2, -0.3, 'y', 8);
  // HV bushings (porcelain sheds) and LV bushings with copper studs
  for (const x of [-0.45, 0, 0.45]) {
    kit.cyl('porcelain', 0.06, 0.5, x, cover + 0.3, 0.26, 'y', 12);
    for (let i = 0; i < 5; i++) {
      const shed = mCyl(0.085, 0.095, 0.03, 14);
      shed.translate(x, cover + 0.12 + i * 0.085, 0.26);
      kit.add('porcelain', shed);
    }
    kit.cyl('copper', 0.02, 0.1, x, cover + 0.6, 0.26, 'y', 8);
  }
  for (const x of [-0.5, -0.17, 0.17, 0.5]) {
    kit.cyl('porcelain', 0.045, 0.2, x, cover + 0.15, 0.0, 'y', 10);
    kit.box('copper', 0.06, 0.1, 0.012, x, cover + 0.3, 0.0);
  }
  // cantilever lifting lugs reaching the sling points
  for (const [px, pz] of def.points) {
    kit.box('trafo', Math.abs(px) - 0.72, 0.05, 0.14, Math.sign(px) * (0.72 + (Math.abs(px) - 0.72) / 2), cover - 0.03, pz * 0.8, null, WEAR_JOINT);
    lug(kit, 'trafo', px, cover - 0.01, pz, Math.PI / 2);
  }
  // cable box on +x, dial thermometer, drain valve, plates
  kit.box('trafo', 0.2, 0.55, 0.7, tank[0] / 2 + 0.1, tb + 0.8, 0);
  kit.cyl('galv', 0.06, 0.03, -tank[0] / 2 - 0.015, tb + 1.0, 0.25, 'x', 14);
  kit.cyl('galv', 0.03, 0.12, -tank[0] / 2 - 0.06, tb + 0.12, -0.2, 'x', 8);
  decal2(kit, 'trafo', 0.36, 0.21, V(-tank[0] / 2 - 0.003, tb + 0.7, -0.15), V(-1, 0, 0));
  decal2(kit, 'hv', 0.2, 0.17, V(tank[0] / 2 + 0.203, tb + 0.95, 0), V(1, 0, 0));
}

function cwSlab(kit, sx, sy, sz, def) {
  // cast counterweight slab in the crane livery: machined dark top face,
  // central aperture for the ballasting cylinder, stacking cones, 4 lugs
  const body = new RoundedBoxGeometry(sx, sy, sz, 2, 0.025);
  const uv = body.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  kit.add('cwYel', body, null, [0.4, 0.4, 0.8]);
  kit.box('cwDark', sx - 0.5, 0.006, sz - 0.4, 0, sy / 2 + 0.001, 0); // machined bearing face
  kit.box('louvre', 0.36, 0.008, 0.36, 0, sy / 2 + 0.004, 0); // cylinder aperture
  for (const x of [-0.9, 0.9]) {
    const cone = mCyl(0.03, 0.06, 0.04, 12);
    cone.translate(x, sy / 2 + 0.02, 0);
    kit.add('cwDark', cone);
  }
  for (const [px, pz] of def.points) lug(kit, 'cwDark', px, sy / 2, pz);
  for (const s of [-1, 1]) decal2(kit, 'cw' + def.slab, 1.0, 0.375, V(-0.2, 0, s * (sz / 2 + 0.003)), V(0, 0, s));
}

// ------------------------------------------------------------ entry
export function buildLoadMesh(type, def) {
  const [sx, sy, sz] = def.size;
  const g = new THREE.Group();
  g.name = 'load:' + type;
  materials();
  const kit = new Kit(type.length * 17 + Math.floor(Math.random() * 1000));
  switch (type) {
    case 'testWeight': testWeight(kit, sx, sy, sz); break;
    case 'rebar': rebar(kit, sx, sy, sz); break;
    case 'bricks': bricks(kit, sx, sy, sz); break;
    case 'pallet': blocks(kit, sx, sy, sz); break;
    case 'shutter': shutter(kit, sx, sy, sz); break;
    case 'beam': beam(kit, sx, sy, sz); break;
    case 'bucket': bucket(kit, sx, sy, sz); break;
    case 'container': container(kit, sx, sy, sz); break;
    case 'testBlock5': testBlock5(kit, sx, sy, sz, def); break;
    case 'hvac': hvacUnit(kit, sx, sy, sz, def); break;
    case 'generator': generatorSet(kit, sx, sy, sz, def); break;
    case 'precast': precastPanel(kit, sx, sy, sz, def); break;
    case 'steelBundle': steelBundle(kit, sx, sy, sz, def); break;
    case 'transformer': transformerUnit(kit, sx, sy, sz, def); break;
    case 'cwA': case 'cwB': case 'cwC': cwSlab(kit, sx, sy, sz, def); break;
    default: kit.box('concrete', sx, sy, sz); break;
  }
  kit.build(g, M, { noShadow: ['decal', 'decal2', 'wrap', 'residue'] });
  return g;
}
