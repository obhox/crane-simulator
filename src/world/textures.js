import * as THREE from 'three';
import { rng } from '../util/math.js';

// All textures are generated procedurally at startup — no external assets.

export function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Tileable value-noise field, values 0..1
export function noiseField(size, cells, octaves = 4, seed = 1) {
  const out = new Float32Array(size * size);
  const r = rng(seed);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = cells << o;
    const lat = new Float32Array(n * n);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    for (let y = 0; y < size; y++) {
      const fy = (y / size) * n;
      const y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const ya = (y0 % n) * n, yb = ((y0 + 1) % n) * n;
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * n;
        const x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const xa = x0 % n, xb = (x0 + 1) % n;
        const a = lat[ya + xa], b = lat[ya + xb], c = lat[yb + xa], d = lat[yb + xb];
        out[y * size + x] += ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function fieldToCanvas(size, field, colorFn) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const [r, g, b] = colorFn(field[i], i % size, (i / size) | 0);
    d[i * 4] = r;
    d[i * 4 + 1] = g;
    d[i * 4 + 2] = b;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function canvasTexture(canvas, { repeat = 1, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const cache = {};
function memo(key, fn) {
  if (!cache[key]) cache[key] = fn();
  return cache[key];
}

// Grey tiling detail noise used to break up large surfaces.
export const detailNoise = () =>
  memo('detail', () => {
    const size = 256;
    const f = noiseField(size, 8, 5, 7);
    const c = fieldToCanvas(size, f, (v) => {
      const g = Math.floor(90 + v * 140);
      return [g, g, g];
    });
    return canvasTexture(c, { srgb: false });
  });

export const concreteTexture = () =>
  memo('concrete', () => {
    const size = 512;
    const f = noiseField(size, 6, 6, 21);
    const f2 = noiseField(size, 24, 3, 22);
    const c = fieldToCanvas(size, f, (v, x, y) => {
      const s = f2[y * size + x];
      const base = 150 + (v - 0.5) * 60 + (s - 0.5) * 30;
      return [base, base * 0.99, base * 0.95];
    });
    const ctx = c.getContext('2d');
    // formwork tie holes and panel joints
    ctx.strokeStyle = 'rgba(80,80,80,0.25)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * 128);
      ctx.lineTo(size, i * 128);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(60,60,60,0.45)';
    for (let y = 64; y < size; y += 128) for (let x = 32; x < size; x += 96) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    return canvasTexture(c);
  });

export const plywoodTexture = () =>
  memo('plywood', () => {
    const size = 256;
    const f = noiseField(size, 4, 4, 31);
    const c = fieldToCanvas(size, f, (v, x, y) => {
      const grain = Math.sin(y * 0.35 + v * 12) * 0.5 + 0.5;
      const k = 0.8 + grain * 0.15 + (v - 0.5) * 0.2;
      return [226 * k, 170 * k, 40 * k];
    });
    return canvasTexture(c);
  });

export const brickTexture = () =>
  memo('brick', () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#9b9690';
    ctx.fillRect(0, 0, 256, 256);
    const r = rng(41);
    const bh = 16, bw = 42;
    for (let row = 0; row < 256 / bh; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -bw; x < 256 + bw; x += bw) {
        const t = 0.85 + r() * 0.25;
        ctx.fillStyle = `rgb(${Math.floor(168 * t)},${Math.floor(78 * t)},${Math.floor(56 * t)})`;
        ctx.fillRect(x + off + 1.5, row * bh + 1.5, bw - 3, bh - 3);
      }
    }
    return canvasTexture(c);
  });

export const corrugatedTexture = (hex = '#2f6f9e') =>
  memo('corr' + hex, () => {
    const c = makeCanvas(256);
    const ctx = c.getContext('2d');
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 16) {
      const g = ctx.createLinearGradient(x, 0, x + 16, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.28)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
      g.addColorStop(1, 'rgba(0,0,0,0.28)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 16, 256);
    }
    const f = noiseField(128, 6, 4, 55);
    for (let i = 0; i < 700; i++) {
      const x = Math.random() * 256, y = Math.random() * 256;
      ctx.fillStyle = `rgba(90,50,20,${0.05 + f[(i * 37) % f.length] * 0.12})`;
      ctx.fillRect(x, y, 2 + Math.random() * 6, 1 + Math.random() * 10);
    }
    return canvasTexture(c);
  });

export const rustTexture = () =>
  memo('rust', () => {
    const size = 128;
    const f = noiseField(size, 8, 4, 61);
    const c = fieldToCanvas(size, f, (v) => {
      const k = 0.55 + v * 0.6;
      return [120 * k, 62 * k, 38 * k];
    });
    return canvasTexture(c);
  });

export const hazardTexture = () =>
  memo('hazard', () => {
    const c = makeCanvas(128);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e8b400';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#161616';
    for (let i = -128; i < 256; i += 32) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 16, 0);
      ctx.lineTo(i + 16 + 128, 128);
      ctx.lineTo(i + 128, 128);
      ctx.fill();
    }
    return canvasTexture(c);
  });

// Crane steel: paint with slight weathering (used as a multiplier map)
export const paintTexture = () =>
  memo('paint', () => {
    const size = 256;
    const f = noiseField(size, 10, 5, 71);
    const c = fieldToCanvas(size, f, (v) => {
      const k = 205 + v * 50;
      return [k, k, k];
    });
    return canvasTexture(c);
  });

// Building facades for the backdrop city. Returns {map, emissive}
export const facadeTextures = (variant = 0) =>
  memo('facade' + variant, () => {
    const W = 256, H = 256;
    const r = rng(100 + variant);
    const palettes = [
      ['#b9b2a6', '#2d3640'], ['#8e8a86', '#1f2a33'], ['#c9c2b5', '#39444f'],
      ['#6f7780', '#1b2530'], ['#a58d74', '#2b2b30'], ['#d8d4cc', '#33404c'],
    ];
    const [wall, glass] = palettes[variant % palettes.length];
    const c = makeCanvas(W, H);
    const e = makeCanvas(W, H);
    const ctx = c.getContext('2d');
    const ex = e.getContext('2d');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    ex.fillStyle = '#000';
    ex.fillRect(0, 0, W, H);
    const cols = 4, rows = 4;
    const cw = W / cols, rh = H / rows;
    const ribbon = variant % 3 === 1;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const px = x * cw + (ribbon ? 2 : cw * 0.18);
        const py = y * rh + rh * 0.25;
        const pw = ribbon ? cw - 4 : cw * 0.64;
        const ph = rh * 0.55;
        const tint = 0.75 + r() * 0.35;
        ctx.fillStyle = glass;
        ctx.globalAlpha = 1;
        ctx.fillRect(px, py, pw, ph);
        ctx.fillStyle = `rgba(160,190,220,${0.12 * tint})`;
        ctx.fillRect(px, py, pw, ph * 0.5);
        if (r() < 0.38) {
          const warm = r() < 0.7;
          ex.fillStyle = warm ? `rgba(255,${200 + r() * 40 | 0},${130 + r() * 50 | 0},${0.55 + r() * 0.45})` : `rgba(200,220,255,${0.5 + r() * 0.4})`;
          ex.fillRect(px, py, pw, ph);
        }
      }
    }
    return { map: canvasTexture(c), emissive: canvasTexture(e) };
  });

// Large site ground texture covering [-128,128]² metres.
export const SITE_TEX_EXTENT = 128;
export function siteGroundTexture(site) {
  const size = 2048;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const m2p = (m) => ((m + SITE_TEX_EXTENT) / (SITE_TEX_EXTENT * 2)) * size; // metres → px
  const f = noiseField(512, 8, 6, 91);
  const base = fieldToCanvas(512, f, (v) => {
    // compacted dirt / gravel
    const k = 0.78 + v * 0.42;
    return [128 * k, 112 * k, 90 * k];
  });
  // grass outside
  const fg = noiseField(256, 8, 5, 92);
  const grass = fieldToCanvas(256, fg, (v) => {
    const k = 0.7 + v * 0.5;
    return [78 * k, 96 * k, 52 * k];
  });
  ctx.fillStyle = ctx.createPattern(grass, 'repeat');
  ctx.fillRect(0, 0, size, size);
  // site area
  const fe = site.fence;
  ctx.save();
  ctx.beginPath();
  ctx.rect(m2p(fe.minX), m2p(fe.minZ), m2p(fe.maxX) - m2p(fe.minX), m2p(fe.maxZ) - m2p(fe.minZ));
  ctx.clip();
  ctx.drawImage(base, m2p(fe.minX), m2p(fe.minZ), m2p(fe.maxX) - m2p(fe.minX), m2p(fe.maxZ) - m2p(fe.minZ));
  // gravel scatter
  const r = rng(93);
  for (let i = 0; i < 26000; i++) {
    const x = r() * size, y = r() * size;
    const g = 90 + r() * 90;
    ctx.fillStyle = `rgba(${g},${g * 0.95},${g * 0.88},0.5)`;
    ctx.fillRect(x, y, 1 + r() * 2, 1 + r() * 2);
  }
  // puddles / damp patches
  for (let i = 0; i < 40; i++) {
    const x = r() * size, y = r() * size, rad = 10 + r() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(60,52,44,0.45)');
    g.addColorStop(1, 'rgba(60,52,44,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // haul road tyre tracks from gate to yard and building
  ctx.strokeStyle = 'rgba(70,60,50,0.35)';
  ctx.lineCap = 'round';
  const track = (pts, w) => {
    for (const off of [-1.1, 1.1]) {
      ctx.lineWidth = w;
      ctx.beginPath();
      pts.forEach(([x, z], i) => (i ? ctx.lineTo(m2p(x + off), m2p(z)) : ctx.moveTo(m2p(x + off), m2p(z))));
      ctx.stroke();
    }
  };
  track([[-30, -58], [-28, -40], [-22, -24], [-10, -18], [8, -12], [30, -4]], 6);
  track([[-30, -58], [-40, -30], [-44, 0]], 6);
  ctx.restore();

  // crane foundation pad
  ctx.fillStyle = '#9d9b96';
  ctx.fillRect(m2p(-4), m2p(-4), m2p(4) - m2p(-4), m2p(4) - m2p(-4));
  // building ground slab
  const b = site.building;
  ctx.fillStyle = '#a3a19c';
  ctx.fillRect(m2p(b.minX - 1), m2p(b.minZ - 1), m2p(b.maxX + 1) - m2p(b.minX - 1), m2p(b.maxZ + 1) - m2p(b.minZ - 1));

  // footway + public road
  const rd = site.road;
  ctx.fillStyle = '#8f8d88';
  ctx.fillRect(0, m2p(rd.maxZ), size, m2p(fe.minZ) - m2p(rd.maxZ));
  const fa = noiseField(256, 16, 4, 94);
  const asphalt = fieldToCanvas(256, fa, (v) => {
    const k = 50 + v * 30;
    return [k, k, k * 1.03];
  });
  ctx.fillStyle = ctx.createPattern(asphalt, 'repeat');
  ctx.fillRect(0, m2p(rd.minZ), size, m2p(rd.maxZ) - m2p(rd.minZ));
  ctx.strokeStyle = 'rgba(235,235,225,0.85)';
  ctx.lineWidth = 3;
  ctx.setLineDash([24, 26]);
  ctx.beginPath();
  const mid = (rd.minZ + rd.maxZ) / 2;
  ctx.moveTo(0, m2p(mid));
  ctx.lineTo(size, m2p(mid));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(235,235,225,0.7)';
  ctx.lineWidth = 2;
  for (const z of [rd.minZ + 0.4, rd.maxZ - 0.4]) {
    ctx.beginPath();
    ctx.moveTo(0, m2p(z));
    ctx.lineTo(size, m2p(z));
    ctx.stroke();
  }
  // laydown area markings (paint lines)
  ctx.strokeStyle = 'rgba(240,210,40,0.8)';
  ctx.lineWidth = 3;
  ctx.strokeRect(m2p(-40), m2p(-12), m2p(-12) - m2p(-40), m2p(22) - m2p(-12));
  ctx.strokeRect(m2p(-6), m2p(48), m2p(14) - m2p(-6), m2p(62) - m2p(48));

  const tex = canvasTexture(c, { repeat: 1, aniso: 16 });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export function farGroundTexture() {
  const size = 512;
  const f = noiseField(size, 8, 6, 97);
  const c = fieldToCanvas(size, f, (v) => {
    const k = 0.72 + v * 0.45;
    return [80 * k, 92 * k, 60 * k];
  });
  return canvasTexture(c, { repeat: 60 });
}
