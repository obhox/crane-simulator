import * as THREE from 'three';
import { rng } from '../../util/math.js';

// Canvas-based painter for splat masks. Each channel is painted as greyscale
// on an opaque canvas (2D canvases store premultiplied RGBA, so painting
// channels independently into one RGBA canvas would destroy colour where alpha
// is low), read back, optionally blurred, and packed into an RGBA DataTexture.
// Row 0 of the texture is z = rect.minZ, so the shader samples
// uv = (p - rect.min) / rect.size with no flips.
export class MaskPainter {
  constructor(N, rect, seed = 1) {
    this.N = N;
    this.region = rect; // { minX, minZ, size }
    this.s = N / rect.size;
    this.c = document.createElement('canvas');
    this.c.width = this.c.height = N;
    this.ctx = this.c.getContext('2d', { willReadFrequently: true });
    this.r = rng(seed);
  }
  px(x) { return (x - this.region.minX) * this.s; }
  pz(z) { return (z - this.region.minZ) * this.s; }
  grey(v, a = 1) { const g = Math.round(Math.min(1, Math.max(0, v)) * 255); return `rgba(${g},${g},${g},${a})`; }
  begin(v = 0) {
    const { ctx } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.grey(v);
    ctx.fillRect(0, 0, this.N, this.N);
    return this;
  }
  mode(op) { this.ctx.globalCompositeOperation = op; return this; }

  // Irregular blob: ellipse (rx, rz metres, rotated) whose radius wobbles with
  // a random periodic sine series; radial gradient gives a soft rim.
  blob(x, z, rx, rz, rot = 0, v = 1, { soft = 0.45, rough = 0.28, alpha = 1 } = {}) {
    const { ctx, r } = this;
    const harm = [];
    for (let k = 2; k <= 7; k++) harm.push([k, (r() - 0.5) * 2 * rough / (k * 0.55), r() * Math.PI * 2]);
    ctx.save();
    ctx.translate(this.px(x), this.pz(z));
    ctx.rotate(rot);
    ctx.scale(rx * this.s, rz * this.s);
    ctx.beginPath();
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      let rr = 1;
      for (const [k, amp, ph] of harm) rr += amp * Math.sin(k * a + ph);
      const px = Math.cos(a) * rr, pz = Math.sin(a) * rr;
      if (i) ctx.lineTo(px, pz); else ctx.moveTo(px, pz);
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.25);
    g.addColorStop(0, this.grey(v, alpha));
    g.addColorStop(Math.max(0.01, 1 - soft), this.grey(v, alpha));
    g.addColorStop(1, this.grey(v, 0));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    return this;
  }
  rect(x0, z0, x1, z1, v = 1, alpha = 1) {
    this.ctx.fillStyle = this.grey(v, alpha);
    this.ctx.fillRect(this.px(x0), this.pz(z0), (x1 - x0) * this.s, (z1 - z0) * this.s);
    return this;
  }
  // Polyline stroke (metres). pts are smoothed with Catmull-Rom first.
  line(pts, width, v = 1, alpha = 1, cap = 'round') {
    const { ctx } = this;
    const sm = smoothPath(pts, 1.0);
    ctx.lineWidth = Math.max(0.5, width * this.s);
    ctx.lineCap = cap;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.grey(v, alpha);
    ctx.beginPath();
    sm.forEach(([x, z], i) => (i ? ctx.lineTo(this.px(x), this.pz(z)) : ctx.moveTo(this.px(x), this.pz(z))));
    ctx.stroke();
    return this;
  }
  // Read the red channel (optionally box-blurred twice ≈ gaussian).
  read(blurPx = 0) {
    const d = this.ctx.getImageData(0, 0, this.N, this.N).data;
    const out = new Uint8Array(this.N * this.N);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
    if (blurPx > 0) { boxBlur(out, this.N, blurPx); boxBlur(out, this.N, blurPx); }
    return out;
  }
}

// Offset a polyline sideways by `o` metres (normals from neighbouring points).
export function offsetPath(pts, o, wobble = 0, r = Math.random) {
  const out = [];
  let ph = r() * 10;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const w = wobble ? Math.sin(i * 0.9 + ph) * wobble + (r() - 0.5) * wobble : 0;
    out.push([pts[i][0] - dz * (o + w), pts[i][1] + dx * (o + w)]);
  }
  return out;
}

// Catmull-Rom densify so tyre tracks curve naturally through the waypoints.
export function smoothPath(pts, step = 1.0) {
  if (pts.length < 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function boxBlur(a, N, r) {
  const tmp = new Uint8Array(a.length);
  const w = 2 * r + 1;
  for (let y = 0; y < N; y++) {
    const row = y * N;
    let s = 0;
    for (let x = -r; x <= r; x++) s += a[row + Math.min(N - 1, Math.max(0, x))];
    for (let x = 0; x < N; x++) {
      tmp[row + x] = s / w;
      s += a[row + Math.min(N - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(N - 1, Math.max(0, y)) * N + x];
    for (let y = 0; y < N; y++) {
      a[y * N + x] = s / w;
      s += tmp[Math.min(N - 1, y + r + 1) * N + x] - tmp[Math.max(0, y - r) * N + x];
    }
  }
}

export function packMask(N, channels, name) {
  const data = new Uint8Array(N * N * 4);
  for (let c = 0; c < 4; c++) {
    const ch = channels[c];
    for (let i = 0; i < N * N; i++) data[i * 4 + c] = ch ? ch[i] : 0;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  t.name = name;
  return t;
}
