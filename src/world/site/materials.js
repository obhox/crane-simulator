import * as THREE from 'three';
import { SITE } from '../../config.js';
import { pbrMaterial, MANIFEST } from '../assets.js';
import { makeCanvas, canvasTexture, noiseField } from '../textures.js';
import { rng } from '../../util/math.js';
import { weatherConcrete, grime, windFlutter, interiorUniforms, interiorShade } from './kit.js';

// One shared material palette for the whole site. Painted / plastic / wood
// materials use baked vertex colours (albedo normalised to 1 in the texture)
// so a single material — one draw call — covers every colour of that finish.
// Albedo targets are linear mean reflectance measured off real materials:
// fresh concrete ~0.28-0.32, weathered timber ~0.2, bitumen/rubber ~0.04.

// Linear-space albedo (what vertex colours multiply in the shader).
export const lin = (r, g, b) => new THREE.Color(r, g, b);

// Timber finishes as measured linear albedo. The wood/ply scans are hue-
// neutralised (see neutral()), so these ARE the final surface colours.
export const WOOD = {
  weathered: lin(0.2, 0.16, 0.11), // dunnage, bearers, old offcuts
  fresh: lin(0.46, 0.37, 0.23), // new sawn whitewood packs
  board: lin(0.25, 0.22, 0.18), // grey weathered scaffold boards
  pallet: lin(0.34, 0.27, 0.17),
  post: lin(0.22, 0.19, 0.12), // treated hoarding framing
  ply: lin(0.42, 0.31, 0.18), // raw birch/pine ply
  plyUsed: lin(0.3, 0.24, 0.16), // concrete-stained soffit ply
  film: lin(0.12, 0.052, 0.03), // phenolic film-faced form ply
  h20: lin(0.6, 0.37, 0.035), // yellow-painted timber beams
  hardwood: lin(0.11, 0.075, 0.05), // trailer deck
};

// Tint that turns a scan's mean colour neutral grey, so with albedo:1 the
// texture only contributes grain / knots / pattern and the vertex colour sets
// the real albedo (otherwise an orange scan × a tan vertex colour saturates
// into bright orange — the classic "cartoon timber" look).
function neutral(name) {
  const a = MANIFEST.textures[name]?.albedo;
  if (!a) return 0xffffff;
  const l = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  return new THREE.Color(l / a[0], l / a[1], l / a[2]);
}

export function siteMaterials(q) {
  const low = q.name === 'low';
  const M = {};
  const n = (m, name) => { m.name = name; return m; };
  const b = SITE.building;
  M.interiorU = interiorUniforms({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, top: b.levels * b.floor - b.slab });

  // --- concrete (world-space weathered)
  M.concSlab = weatherConcrete(n(pbrMaterial('concrete_slab', { repeat: 1 / 3.0, albedo: 0.3, color: 0xf2f0ea, roughness: 1.1 }), 'concSlab'), { streak: 0.55 });
  M.concCol = weatherConcrete(n(pbrMaterial('concrete_wall', { repeat: 1 / 2.71, albedo: 0.29, color: 0xe6ecf4, roughness: 1.05 }), 'concCol'), { streak: 0.6, wet: 0.4 });
  M.concCore = weatherConcrete(n(pbrMaterial('concrete_rough', { repeat: 1 / 2.0, albedo: 0.27, color: 0xf4f4f0 }), 'concCore'), { streak: 0.7, wet: 0.3 });
  // precast items on the ground (barriers, kentledge, rings): splash-back grime
  M.precast = grime(n(pbrMaterial('concrete_wall', { repeat: 1 / 2.71, albedo: 0.3, color: 0xeef0f4 }), 'precast'), { height: 0.35, color: 0x3d3024, amount: 0.7 });

  // --- paint on steel / timber (vertex coloured)
  M.paint = grime(n(pbrMaterial('metal_painted', { repeat: 1, albedo: 1, vertexColors: true, roughness: 0.9 }), 'paint'), { height: 0.35, amount: 0.75 });
  M.paintVeh = grime(n(pbrMaterial('metal_painted', { repeat: 1, albedo: 1, vertexColors: true, roughness: 0.65 }), 'paintVeh'), { height: 1.25, color: 0x57432d, amount: 0.9, scale: 1.1 });
  M.paintWorn = grime(n(pbrMaterial('metal_painted_worn', { repeat: 1 / 1.5, albedo: 1, vertexColors: true, roughness: 1.3 }), 'paintWorn'), { height: 0.7, color: 0x4d3b28, amount: 0.8 });
  M.corrugated = grime(n(pbrMaterial('corrugated_metal', { repeat: 1 / 2.7, albedo: 1, vertexColors: true, roughness: 0.8, metalness: 0.4 }), 'corrugated'), { height: 0.45, amount: 0.6 });
  M.container = grime(n(pbrMaterial('container_side', { repeat: 1 / 1.94, albedo: 0.14 }), 'container'), { height: 0.5, amount: 0.7 });
  M.galv = n(pbrMaterial('galvanized_metal', { repeat: 1, roughness: 1.1 }), 'galv');
  M.galvTube = n(pbrMaterial('galvanized_metal', { repeat: [0.4, 1], roughness: 1.1 }), 'galvTube');
  M.rebar = n(pbrMaterial('rusty_metal', { repeat: 1 / 2.2, albedo: 0.1, roughness: 1, metalness: 0.2 }), 'rebar');
  M.rust = grime(n(pbrMaterial('rusty_metal', { repeat: 1 / 2.2, albedo: 0.11, metalness: 0.3 }), 'rust'), { height: 0.4, amount: 0.6 });

  // --- timber
  M.wood = grime(n(pbrMaterial('wood_planks', { repeat: 1 / 1.5, albedo: 1, color: neutral('wood_planks'), vertexColors: true, roughness: 1.1 }), 'wood'), { height: 0.3, amount: 0.6 });
  M.ply = n(pbrMaterial('plywood', { repeat: 1 / 0.5, albedo: 1, color: neutral('plywood'), vertexColors: true }), 'ply');
  // OSB reads orange once ACES pushes saturation: pull the tint a little cooler
  M.osb = grime(n(pbrMaterial('osb', { repeat: 1 / 2.51, albedo: 0.27, color: 0xe4e8f2 }), 'osb'), { height: 0.4, amount: 0.8 });

  // --- masonry
  M.brick = n(pbrMaterial('brick_red', { repeat: 1 / 1.4, albedo: 0.2, color: 0xffe6d8 }), 'brick');
  M.block = n(new THREE.MeshStandardMaterial({ map: blockTexture(), roughness: 0.93, metalness: 0 }), 'block');
  M.block.map.repeat.set(1 / 1.76, 1 / 1.72);

  // --- plain finishes (vertex coloured)
  M.rubber = grime(n(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0 }), 'rubber'), { height: 1.2, color: 0x5a4632, amount: 0.8, scale: 1.8 });
  M.plastic = grime(n(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0 }), 'plastic'), { height: 0.35, amount: 0.6 });
  M.steel = n(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 1 }), 'steel');
  M.glass = n(new THREE.MeshStandardMaterial({ color: 0x0c1116, roughness: 0.05, metalness: 0.1, envMapIntensity: 1.6 }), 'glass');
  M.cabinGlass = n(new THREE.MeshStandardMaterial({ color: 0x151b20, roughness: 0.06, metalness: 0.1, emissive: 0xffd6a0, emissiveIntensity: 0 }), 'cabinGlass');
  M.lamp = n(new THREE.MeshStandardMaterial({ color: 0xf2f2ea, roughness: 0.2, metalness: 0, emissive: 0xfff1d6, emissiveIntensity: 0 }), 'lamp');
  M.lamp.userData.cast = false;
  M.dirt = n(pbrMaterial('dirt', { repeat: 1 / 1.3, albedo: 0.11 }), 'dirt');
  M.gravel = n(pbrMaterial('gravel', { repeat: 1 / 2, albedo: 0.2 }), 'gravel');

  // --- see-through: welded mesh (edge protection, Heras, brick guards)
  const meshTex = weldMeshTexture();
  meshTex.repeat.set(1 / 0.4, 1 / 0.4);
  M.mesh = n(new THREE.MeshStandardMaterial({
    map: meshTex, vertexColors: true, transparent: true, alphaTest: 0.02, depthWrite: true,
    side: THREE.DoubleSide, roughness: 0.55, metalness: 0.5,
  }), 'mesh');
  M.mesh.userData.cast = false;

  // debris netting (knitted HDPE) and monaflex-style sheeting
  M.net = n(new THREE.MeshStandardMaterial({
    map: netTexture(), color: 0x3f6e5c, transparent: true, opacity: 0.9, depthWrite: false,
    side: THREE.DoubleSide, roughness: 0.9,
  }), 'net');
  M.net.userData.cast = false;
  M.net.userData.renderOrder = 2;
  M.sheet = n(new THREE.MeshStandardMaterial({
    map: sheetTexture(), color: 0xe8ebec, transparent: true, opacity: 0.88, depthWrite: false,
    side: THREE.DoubleSide, roughness: 0.75,
  }), 'sheet');
  M.sheet.userData.renderOrder = 2;
  M.windU = low ? null : [windFlutter(M.net, { amp: 0.06, offset: 12 }), windFlutter(M.sheet, { amp: 0.09, offset: 12 })];

  // standing water (deck ponding, wheel-wash run-off)
  M.puddle = puddleMaterial();

  // everything that can sit inside the frame gets the interior light falloff
  for (const k of ['concSlab', 'concCol', 'concCore', 'block', 'brick', 'precast', 'ply', 'wood', 'paint', 'osb', 'steel', 'plastic', 'rubber']) interiorShade(M[k], M.interiorU);

  return M;
}

// Standing water. A real puddle is a clear film: you see the concrete under
// it (wet, so ~45 % darker) plus a mirror reflection of sky and sun that grows
// towards grazing angles (Fresnel). Normal alpha blending would fade that
// reflection together with the darkening, so the blend is custom:
//   out = 0.75 * reflection * mask + dst * (1 - 0.6 * mask)
// (a film over rough concrete is not a perfect mirror: ripples + grit)
function puddleMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0x020303, roughness: 0.04, metalness: 0, map: puddleTexture(), transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  m.name = 'puddle';
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `
{
  float pm = diffuseColor.a;
  #ifdef USE_FOG
    pm *= 1.0 - fogFactor;
  #endif
  // alpha carries two things: the damp shore (a < ~0.5: wet concrete, only
  // darkened) and the water film (a -> 1: darkened more + sky reflection)
  float film = smoothstep(0.45, 0.9, pm);
  gl_FragColor = vec4(gl_FragColor.rgb * film * 0.9, pm * 0.42);
}
#include <dithering_fragment>`);
  };
  m.customProgramCacheKey = () => 'site:puddle';
  m.userData.cast = false;
  m.userData.renderOrder = 1;
  return m;
}

// Irregular puddle outline (alpha) — noise-eroded blob with a soft shore.
function puddleTexture() {
  const S = 256;
  const f = noiseField(S, 4, 4, 4242);
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S * 2 - 1, v = (y + 0.5) / S * 2 - 1;
      const d = u * u + v * v;
      const k = (1 - d) * 0.95 + (f[y * S + x] - 0.5) * 1.3 - 0.28;
      // water film where k > 0, plus a soft damp shore around it
      const core = Math.max(0, Math.min(1, k * 7));
      const shore = Math.max(0, Math.min(1, (k + 0.22) * 3)) * 0.45;
      const a = Math.max(core, shore) * Math.max(0, Math.min(1, (1 - d) * 6));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// 440 x 215 mm dense concrete blocks in stretcher bond with 10 mm joints.
function blockTexture() {
  const W = 512, H = 512;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const r = rng(515);
  const f = noiseField(128, 8, 4, 516);
  ctx.fillStyle = '#8d8b86';
  ctx.fillRect(0, 0, W, H);
  const bw = W / 4, bh = H / 8; // 4 blocks x 8 courses = 1.76 m x 1.72 m
  for (let row = 0; row < 8; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let i = -1; i < 5; i++) {
      const x = i * bw + off, y = row * bh;
      const k = 0.86 + r() * 0.2;
      const g = Math.round(150 * k), gg = Math.round(147 * k), gb = Math.round(140 * k);
      ctx.fillStyle = `rgb(${g},${gg},${gb})`;
      ctx.fillRect(x + 3, y + 3, bw - 6, bh - 6);
    }
  }
  // speckle + mortar smears
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < W * H; i++) {
    const v = f[((i / W | 0) % 128) * 128 + (i % W) % 128];
    const s = (r() - 0.5) * 34 + (v - 0.5) * 30;
    img.data[i * 4] += s; img.data[i * 4 + 1] += s; img.data[i * 4 + 2] += s;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTexture(c);
}

// Tileable welded mesh: 0.4 m tile, vertical wires every 100 mm, horizontal
// every 200 mm (edge protection / Heras panels).
function weldMeshTexture() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 4; i++) ctx.fillRect(i * 64, 0, 4, S);
  for (let j = 0; j < 2; j++) ctx.fillRect(0, j * 128, S, 4);
  const t = canvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Knitted debris netting: fine open weave, ~50 % cover.
function netTexture() {
  const S = 128;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 2;
  for (let i = -S; i < 2 * S; i += 8) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + S, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i, S); ctx.lineTo(i + S, 0); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(0, 0, S, S);
  const t = canvasTexture(c);
  t.repeat.set(1 / 0.25, 1 / 0.25);
  return t;
}

// Sheeting: slightly translucent film with folds and dirt.
function sheetTexture() {
  const S = 256;
  const f = noiseField(S, 4, 5, 881);
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const fold = 0.5 + 0.5 * Math.sin(x / S * Math.PI * 10 + f[i] * 5);
      const k = 205 + fold * 30 + (f[i] - 0.5) * 50;
      img.data[i * 4] = k; img.data[i * 4 + 1] = k; img.data[i * 4 + 2] = k * 0.98; img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c);
  t.repeat.set(1 / 2.5, 1 / 2);
  return t;
}
