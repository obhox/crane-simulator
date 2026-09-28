import * as THREE from 'three';
import { textureSet } from '../assets.js';
import { rng } from '../../util/math.js';

// Surface library for the city: every wall / roof / trim material the
// buildings use is one layer of a pair of texture ARRAYS, so the whole city
// can be drawn with a single shader (one draw call per chunk):
//   albedo array : rgb = albedo (sRGB), a = roughness
//   normal array : rgb = tangent-space normal (OpenGL +Y), a = ambient occlusion
// Layers come from the CC0 scans in public/assets (albedo re-normalised so a
// vertex tint gives the final colour) plus a few procedural ones (roof tiles,
// standing-seam metal, flat paint). Also builds the generic shop-sign atlas.

// tile: metres per texture repeat · albedo: target mean linear albedo before
// tint · metal: metalness · nrm: normal strength
export const LAYERS = [
  { key: 'plaster', src: 'plaster', tile: 2.0, albedo: 0.62, nrm: 0.8 },
  { key: 'brick', src: 'brick_red', tile: 1.4, albedo: 0.2, nrm: 1.0 },
  { key: 'brick_old', src: 'brick_old', tile: 3.0, albedo: 0.17, nrm: 1.0 },
  { key: 'concrete', src: 'concrete_wall', tile: 2.71, albedo: 0.34, nrm: 0.8 },
  { key: 'concrete_rough', src: 'concrete_rough', tile: 2.0, albedo: 0.28, nrm: 0.9 },
  { key: 'stone', src: 'tiles_or_stone', tile: 3.0, albedo: 0.4, nrm: 0.7 },
  { key: 'panel', src: 'metal_painted', tile: 1.0, albedo: 0.62, nrm: 0.5 },
  { key: 'corrugated', src: 'corrugated_metal', tile: 2.7, albedo: 0.5, nrm: 1.0 },
  { key: 'membrane', src: 'roof_membrane', tile: 20, albedo: 0.32, nrm: 0.8 },
  { key: 'gravel', src: 'gravel', tile: 2.0, albedo: 0.3, nrm: 1.0 },
  { key: 'sedum', src: 'grass', tile: 2.0, albedo: 0.13, nrm: 0.8 },
  { key: 'rooftile', proc: 'rooftile', tile: 2.1, albedo: 0.5, nrm: 1.0 },
  { key: 'zinc', src: 'galvanized_metal', tile: 1.0, albedo: 0.5, metal: 1, nrm: 0.4 },
  { key: 'wood', src: 'wood_planks', tile: 1.5, albedo: 0.2, nrm: 0.8 },
  { key: 'seam', proc: 'seam', tile: 2.0, albedo: 0.5, nrm: 1.0 },
  { key: 'flat', proc: 'flat', tile: 1.0, albedo: 0.5, nrm: 0 },
];
export const L = Object.fromEntries(LAYERS.map((l, i) => [l.key, i]));

// ------------------------------------------------------------------ colour helpers
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const L2S = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const l = i / 4095;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  L2S[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
}
const lin2srgb = (l) => L2S[Math.max(0, Math.min(4095, Math.round(l * 4095)))];

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d', { willReadFrequently: true });
}

// Draw a texture's image into an N×N buffer with row 0 = bottom (GL order).
// ImageBitmaps from the 'low' preset loader are already flipped (flipY=false).
function readPixels(tex, N) {
  const img = tex?.image;
  if (!img) return null;
  const ctx = canvas2d(N, N);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (tex.flipY !== false) { ctx.translate(0, N); ctx.scale(1, -1); }
  try {
    ctx.drawImage(img, 0, 0, N, N);
    return ctx.getImageData(0, 0, N, N).data;
  } catch (e) {
    console.warn('[city] could not read texture', tex.name, e);
    return null;
  }
}

// ------------------------------------------------------------------ procedural layers
function proceduralLayer(kind, N, alb, nrm) {
  const r = rng(kind === 'rooftile' ? 91 : 92);
  const h = new Float32Array(N * N); // height field → normals
  const col = new Float32Array(N * N); // linear albedo multiplier (neutral)
  const rough = new Float32Array(N * N).fill(0.7);
  if (kind === 'rooftile') {
    // interlocking clay/concrete pantiles: 7 across × 6 courses per 2.1 m tile
    const cols = 7, rows = 6;
    const tone = Array.from({ length: cols * rows * 2 }, () => 0.75 + r() * 0.5);
    for (let y = 0; y < N; y++) {
      const fy = (y / N) * rows;
      const row = Math.floor(fy), ty = fy - row; // ty 0 = lower (overlapping) edge
      for (let x = 0; x < N; x++) {
        let fx = (x / N) * cols + (row % 2) * 0.5;
        const c = Math.floor(fx), tx = fx - c;
        const i = y * N + x;
        const roll = Math.pow(Math.sin(Math.PI * tx), 0.6); // rounded pan profile
        h[i] = roll * 0.55 + (1 - ty) * 0.6; // each course sits proud of the one above it
        col[i] = tone[((c % cols) + row * cols) % tone.length] * (0.82 + 0.18 * roll) * (ty < 0.06 ? 0.55 : 1);
        rough[i] = 0.72 + r() * 0.1;
      }
    }
  } else if (kind === 'seam') {
    // standing-seam metal (zinc / painted steel): seams every 0.5 m along the fall line
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * 4, tx = fx - Math.floor(fx);
        const d = Math.min(tx, 1 - tx);
        const i = y * N + x;
        h[i] = d < 0.02 ? 1 : d < 0.035 ? 0.4 : 0.05 * Math.sin(y / N * 40 + x * 0.01);
        col[i] = (d < 0.02 ? 1.1 : 1) * (0.92 + 0.08 * Math.sin(y / N * 6.0 + Math.floor(fx) * 1.7));
        rough[i] = 0.42;
      }
    }
  } else {
    col.fill(1); rough.fill(0.55); h.fill(0);
  }
  // mean-normalise albedo, derive normals from the height field
  let mean = 0;
  for (let i = 0; i < N * N; i++) mean += col[i];
  mean /= N * N;
  const A = new Uint8Array(N * N * 4), Nm = new Uint8Array(N * N * 4);
  const k = 6 * nrm;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const g = lin2srgb(col[i] / mean * alb);
      A[i * 4] = A[i * 4 + 1] = A[i * 4 + 2] = g;
      A[i * 4 + 3] = Math.round(rough[i] * 255);
      const hx = h[y * N + ((x + 1) % N)] - h[y * N + ((x - 1 + N) % N)];
      const hy = h[((y + 1) % N) * N + x] - h[((y - 1 + N) % N) * N + x];
      const nx = -hx * k, ny = -hy * k, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      Nm[i * 4] = Math.round((nx / len * 0.5 + 0.5) * 255);
      Nm[i * 4 + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      Nm[i * 4 + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      Nm[i * 4 + 3] = Math.round(Math.min(1, 0.55 + h[i] * 0.5) * 255);
    }
  }
  return { A, Nm };
}

function scanLayer(def, N) {
  const set = textureSet(def.src);
  if (!set) return null;
  const c = readPixels(set.map, N);
  const n = readPixels(set.normalMap, N);
  const arm = readPixels(set.armMap, N);
  if (!c || !n) return null;
  const P = N * N;
  let mean = 0;
  for (let i = 0; i < P; i++) {
    mean += 0.2126 * S2L[c[i * 4]] + 0.7152 * S2L[c[i * 4 + 1]] + 0.0722 * S2L[c[i * 4 + 2]];
  }
  mean /= P;
  const k = def.albedo / Math.max(mean, 1e-4);
  const A = new Uint8Array(P * 4), Nm = new Uint8Array(P * 4);
  for (let i = 0; i < P; i++) {
    A[i * 4] = lin2srgb(S2L[c[i * 4]] * k);
    A[i * 4 + 1] = lin2srgb(S2L[c[i * 4 + 1]] * k);
    A[i * 4 + 2] = lin2srgb(S2L[c[i * 4 + 2]] * k);
    A[i * 4 + 3] = arm ? arm[i * 4 + 1] : 200;
    Nm[i * 4] = n[i * 4]; Nm[i * 4 + 1] = n[i * 4 + 1]; Nm[i * 4 + 2] = n[i * 4 + 2];
    Nm[i * 4 + 3] = arm ? arm[i * 4] : 255;
  }
  return { A, Nm };
}

function arrayTexture(data, N, depth, srgb) {
  const t = new THREE.DataArrayTexture(data, N, N, depth);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ shop signs
// 64 generic shop fascia signs (no brands): 4 × 16 cells of 512×64 px.
// rgb = sign artwork, a = glow mask (lit letters / light-box) for night.
const WORDS = [
  'CAFE', 'BAKERY', 'PHARMACY', 'BOOKS', 'FLOWERS', 'OPTICIAN', 'DELI', 'MARKET', 'WINE BAR', 'HAIR SALON',
  'LAUNDRY', 'GALLERY', 'BISTRO', 'PIZZERIA', 'SUSHI', 'NOODLE HOUSE', 'KEBAB', 'FASHION', 'SHOES', 'JEWELLER',
  'TRAVEL', 'PHONE REPAIR', 'BUTCHER', 'WINE & SPIRITS', 'GROCERY', 'BARBER', 'DENTAL CLINIC', 'LETTINGS',
  'BICYCLES', 'TOYS', 'HARDWARE', 'NEWS & TOBACCO', 'TEA ROOM', 'BURGERS', 'TAILOR', 'PET SUPPLIES', 'FITNESS',
  'PHOTO STUDIO', 'PRINT SHOP', 'HOMEWARE', 'SPORTS', 'MUSIC', 'ANTIQUES', 'BOUTIQUE', 'PATISSERIE', 'ESPRESSO',
  'RAMEN', 'TAPAS', 'GELATO', 'CYCLE HIRE', 'FLORIST', 'VINTAGE', 'OFFICE SUPPLIES', 'KITCHENS', 'LIGHTING',
  'PHYSIO', 'VET', 'DRY CLEANING', 'CORNER SHOP', 'BRASSERIE', 'STATIONERY', 'THAI KITCHEN', 'BAGELS', 'SALON',
];
const SIGN_BG = ['#1d3b2a', '#16233f', '#5a1620', '#111111', '#f2efe6', '#e8e1cf', '#9c1b1b', '#e0b422', '#0f5c5c', '#474b50', '#2a2a2a', '#6b4a2b', '#ffffff', '#2f6f3e'];
const FONTS = [
  'bold 38px Helvetica, Arial, sans-serif', '600 36px Georgia, "Times New Roman", serif', 'bold 34px "Trebuchet MS", Verdana, sans-serif',
  '300 40px "Helvetica Neue", Arial, sans-serif', 'italic bold 36px Georgia, serif', 'bold 32px "Courier New", monospace', '800 40px "Arial Black", Arial, sans-serif',
];
function signAtlas() {
  const W = 2048, H = 1024, CW = 512, CH = 64;
  const col = canvas2d(W, H), msk = canvas2d(W, H);
  const r = rng(515);
  msk.fillStyle = '#000'; msk.fillRect(0, 0, W, H);
  for (let i = 0; i < 64; i++) {
    const cx = (i % 4) * CW, cy = Math.floor(i / 4) * CH;
    const bg = SIGN_BG[Math.floor(r() * SIGN_BG.length)];
    const light = ['#f2efe6', '#e8e1cf', '#ffffff', '#e0b422'].includes(bg);
    const fg = light ? ['#111', '#1d3b2a', '#5a1620', '#16233f'][Math.floor(r() * 4)] : ['#fff', '#f2e6c8', '#e8c35a', '#ffffff'][Math.floor(r() * 4)];
    col.fillStyle = bg;
    col.fillRect(cx, cy, CW, CH);
    // subtle frame / light-box edge
    col.strokeStyle = 'rgba(0,0,0,0.35)';
    col.lineWidth = 3;
    col.strokeRect(cx + 1.5, cy + 1.5, CW - 3, CH - 3);
    const word = WORDS[i % WORDS.length];
    const font = FONTS[Math.floor(r() * FONTS.length)];
    col.font = font; msk.font = font;
    col.textAlign = msk.textAlign = r() < 0.7 ? 'center' : 'left';
    col.textBaseline = msk.textBaseline = 'middle';
    const tx = col.textAlign === 'center' ? cx + CW / 2 : cx + 22;
    col.fillStyle = fg;
    col.fillText(word, tx, cy + CH / 2 + 2, CW - 40);
    // glow: lightbox (whole sign) or halo letters
    const lightbox = r() < 0.4;
    if (lightbox) { msk.fillStyle = light ? '#bbb' : '#555'; msk.fillRect(cx + 3, cy + 3, CW - 6, CH - 6); }
    msk.fillStyle = '#fff';
    msk.fillText(word, tx, cy + CH / 2 + 2, CW - 40);
  }
  const c = col.getImageData(0, 0, W, H).data, m = msk.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4, dst = y * W * 4; // flip to GL row order
    for (let x = 0; x < W * 4; x += 4) {
      out[dst + x] = c[src + x]; out[dst + x + 1] = c[src + x + 1]; out[dst + x + 2] = c[src + x + 2];
      out[dst + x + 3] = m[src + x];
    }
  }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ build
let cached = null;
export function buildSurfaces(size = 512) {
  if (cached && cached.size === size) return cached;
  const N = size, D = LAYERS.length, P = N * N * 4;
  const albedo = new Uint8Array(P * D), normal = new Uint8Array(P * D);
  LAYERS.forEach((def, i) => {
    let layer = def.proc ? proceduralLayer(def.proc, N, def.albedo, def.nrm) : scanLayer(def, N);
    if (!layer) layer = proceduralLayer('flat', N, def.albedo, 0); // missing asset → flat paint
    albedo.set(layer.A, i * P);
    normal.set(layer.Nm, i * P);
  });
  cached = {
    size,
    albedo: arrayTexture(albedo, N, D, true),
    normal: arrayTexture(normal, N, D, false),
    signs: signAtlas(),
    tile: LAYERS.map((l) => l.tile),
    metal: LAYERS.map((l) => l.metal || 0),
    nrm: LAYERS.map((l) => l.nrm ?? 1),
  };
  return cached;
}
