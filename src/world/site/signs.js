import * as THREE from 'three';
import { makeCanvas, canvasTexture } from '../textures.js';
import { rng } from '../../util/math.js';

// One canvas atlas for every sign/board on site (one material, one draw
// call). Generic construction signage only: ISO 7010-style pictograms,
// project board and hoarding graphics with no real names or logos.

const S = 2048;
export const SIGN_RECTS = {
  board: [0, 0, 1024, 512],
  banner: [0, 512, 2048, 512],
  ppe: [1024, 0, 512, 512],
  entrance: [1536, 0, 512, 256],
  keepout: [1536, 256, 512, 256],
  speed: [0, 1024, 256, 256],
  firstaid: [256, 1024, 256, 256],
  assembly: [512, 1024, 256, 256],
  crane: [768, 1024, 256, 256],
  noentry: [1024, 1024, 256, 256],
  hardhat: [1280, 1024, 256, 256],
  hivis: [1536, 1024, 256, 256],
  boots: [1792, 1024, 256, 256],
  office: [0, 1280, 512, 128],
  canteen: [512, 1280, 512, 128],
  drying: [1024, 1280, 512, 128],
  firstaidLbl: [1536, 1280, 512, 128],
  meeting: [0, 1408, 512, 128],
  toilets: [512, 1408, 512, 128],
  pedestrian: [1024, 1408, 512, 128],
  deliveries: [1536, 1408, 512, 128],
  electric: [0, 1536, 256, 256],
  tag: [256, 1536, 256, 256],
  firepoint: [512, 1536, 256, 256],
  turning: [768, 1536, 512, 256],
  contact: [1280, 1536, 768, 256],
  hoist: [0, 1792, 512, 256],
  wash: [512, 1792, 512, 256],
  banner2: [1024, 1792, 1024, 256],
};

const BLUE = '#1c5aa6', RED = '#cf2a1f', YEL = '#f4c300', GRN = '#17803a', INK = '#161616';
const FONT = 'Arial, Helvetica, sans-serif';

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function txt(ctx, s, x, y, size, color = INK, { align = 'center', weight = 'bold', max = 0, base = 'middle' } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  if (max) ctx.fillText(s, x, y, max); else ctx.fillText(s, x, y);
}

// --- pictogram glyphs, drawn in a [-1,1] box centred at (cx,cy) with scale k
function glyph(ctx, kind, cx, cy, k, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(k, k);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (kind) {
    case 'hardhat':
      ctx.beginPath(); ctx.arc(0, 0.15, 0.62, Math.PI, 0); ctx.closePath(); ctx.fill();
      ctx.fillRect(-0.85, 0.12, 1.7, 0.18);
      ctx.fillRect(-0.08, -0.55, 0.16, 0.5);
      break;
    case 'hivis':
      ctx.beginPath();
      ctx.moveTo(-0.55, -0.75); ctx.lineTo(-0.2, -0.75); ctx.lineTo(0, -0.35); ctx.lineTo(0.2, -0.75); ctx.lineTo(0.55, -0.75);
      ctx.lineTo(0.7, -0.35); ctx.lineTo(0.6, 0.8); ctx.lineTo(-0.6, 0.8); ctx.lineTo(-0.7, -0.35); ctx.closePath(); ctx.fill();
      ctx.fillStyle = color === '#fff' ? BLUE : '#fff';
      ctx.fillRect(-0.62, 0.15, 1.24, 0.12); ctx.fillRect(-0.64, 0.45, 1.28, 0.12);
      break;
    case 'boots':
      ctx.beginPath();
      ctx.moveTo(-0.55, -0.8); ctx.lineTo(0.05, -0.8); ctx.lineTo(0.1, 0.1); ctx.quadraticCurveTo(0.8, 0.15, 0.85, 0.55);
      ctx.lineTo(0.85, 0.75); ctx.lineTo(-0.6, 0.75); ctx.closePath(); ctx.fill();
      break;
    case 'person':
      ctx.beginPath(); ctx.arc(0.05, -0.72, 0.17, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 0.2;
      ctx.beginPath(); ctx.moveTo(0.02, -0.48); ctx.lineTo(-0.05, 0.15); ctx.lineTo(0.35, 0.85); ctx.moveTo(-0.05, 0.15); ctx.lineTo(-0.4, 0.85);
      ctx.moveTo(0.0, -0.35); ctx.lineTo(0.4, 0.05); ctx.moveTo(0.0, -0.35); ctx.lineTo(-0.38, 0.0); ctx.stroke();
      break;
    case 'load':
      ctx.lineWidth = 0.09;
      ctx.beginPath(); ctx.moveTo(0, -0.9); ctx.lineTo(0, -0.35); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -0.2, 0.15, -Math.PI / 2, Math.PI * 0.9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -0.05); ctx.lineTo(-0.45, 0.2); ctx.moveTo(0, -0.05); ctx.lineTo(0.45, 0.2); ctx.stroke();
      ctx.fillRect(-0.55, 0.2, 1.1, 0.42);
      break;
    case 'bolt':
      ctx.beginPath(); ctx.moveTo(0.15, -0.85); ctx.lineTo(-0.35, 0.1); ctx.lineTo(0.0, 0.1); ctx.lineTo(-0.15, 0.85); ctx.lineTo(0.4, -0.15);
      ctx.lineTo(0.05, -0.15); ctx.lineTo(0.3, -0.85); ctx.closePath(); ctx.fill();
      break;
    case 'cross':
      ctx.fillRect(-0.22, -0.7, 0.44, 1.4); ctx.fillRect(-0.7, -0.22, 1.4, 0.44);
      break;
    case 'excl':
      ctx.fillRect(-0.1, -0.55, 0.2, 0.75); ctx.beginPath(); ctx.arc(0, 0.45, 0.12, 0, Math.PI * 2); ctx.fill();
      break;
    case 'gloves':
      rr(ctx, -0.45, -0.1, 0.8, 0.85, 0.15); ctx.fill();
      for (let i = 0; i < 4; i++) { rr(ctx, -0.42 + i * 0.2, -0.75, 0.15, 0.75, 0.07); ctx.fill(); }
      ctx.save(); ctx.translate(0.35, 0.05); ctx.rotate(-0.7); rr(ctx, 0, -0.08, 0.5, 0.17, 0.08); ctx.fill(); ctx.restore();
      break;
    case 'goggles':
      ctx.lineWidth = 0.14;
      ctx.beginPath(); ctx.ellipse(-0.38, 0, 0.3, 0.24, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0.38, 0, 0.3, 0.24, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-0.1, 0); ctx.lineTo(0.1, 0); ctx.moveTo(-0.68, -0.05); ctx.lineTo(-0.9, -0.12); ctx.moveTo(0.68, -0.05); ctx.lineTo(0.9, -0.12); ctx.stroke();
      break;
    case 'group':
      for (const [x, s] of [[-0.5, 0.8], [0, 1], [0.5, 0.8]]) {
        ctx.beginPath(); ctx.arc(x, -0.35 * s, 0.14 * s, 0, Math.PI * 2); ctx.fill();
        rr(ctx, x - 0.15 * s, -0.18 * s, 0.3 * s, 0.75 * s, 0.1); ctx.fill();
      }
      break;
    default: break;
  }
  ctx.restore();
}

// ISO 7010 families
function mandatory(ctx, cx, cy, r, kind) {
  ctx.fillStyle = BLUE;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  glyph(ctx, kind, cx, cy, r * 0.62, '#fff');
}
function warning(ctx, cx, cy, r, kind) {
  ctx.fillStyle = INK;
  ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 1.1, cy + r * 0.8); ctx.lineTo(cx - r * 1.1, cy + r * 0.8); ctx.closePath(); ctx.fill();
  ctx.fillStyle = YEL;
  const k = 0.8;
  ctx.beginPath(); ctx.moveTo(cx, cy - r * k); ctx.lineTo(cx + r * 1.1 * k, cy + r * 0.8 * k - r * 0.04); ctx.lineTo(cx - r * 1.1 * k, cy + r * 0.8 * k - r * 0.04); ctx.closePath(); ctx.fill();
  glyph(ctx, kind, cx, cy + r * 0.2, r * 0.42, INK);
}
function prohibition(ctx, cx, cy, r, kind) {
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  glyph(ctx, kind, cx, cy, r * 0.62, INK);
  ctx.strokeStyle = RED;
  ctx.lineWidth = r * 0.17;
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - r * 0.64, cy - r * 0.64); ctx.lineTo(cx + r * 0.64, cy + r * 0.64); ctx.stroke();
}
function safe(ctx, x, y, w, h, kind) {
  ctx.fillStyle = GRN;
  ctx.fillRect(x, y, w, h);
  glyph(ctx, kind, x + w / 2, y + h / 2, Math.min(w, h) * 0.36, '#fff');
}

// weathering overlay so printed boards don't look freshly rendered
function weather(ctx, x, y, w, h, r, amount = 1) {
  for (let i = 0; i < 40 * amount; i++) {
    const px = x + r() * w, py = y + r() * h, rad = 4 + r() * 30;
    const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, `rgba(70,60,45,${0.05 + r() * 0.06})`);
    g.addColorStop(1, 'rgba(70,60,45,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  }
  const g = ctx.createLinearGradient(0, y + h * 0.75, 0, y + h);
  g.addColorStop(0, 'rgba(80,65,45,0)');
  g.addColorStop(1, `rgba(80,65,45,${0.18 * amount})`);
  ctx.fillStyle = g;
  ctx.fillRect(x, y + h * 0.75, w, h * 0.25);
}

function label(ctx, rect, text, bg, fg = '#fff', icon = null) {
  const [x, y, w, h] = rect;
  ctx.fillStyle = '#f4f4f0';
  ctx.fillRect(x, y, w, h);
  rr(ctx, x + 6, y + 6, w - 12, h - 12, 10);
  ctx.fillStyle = bg;
  ctx.fill();
  if (icon) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 16, y + 16, h - 32, h - 32);
    glyph(ctx, icon, x + h / 2, y + h / 2, (h - 40) * 0.42, bg);
    txt(ctx, text, x + h + (w - h) / 2 - 8, y + h / 2 + 2, 50, fg, { max: w - h - 20 });
  } else {
    txt(ctx, text, x + w / 2, y + h / 2 + 2, 54, fg, { max: w - 30 });
  }
}

let atlas = null;
export function signAtlas() {
  if (atlas) return atlas;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const r = rng(707);
  ctx.fillStyle = '#e8e8e2';
  ctx.fillRect(0, 0, S, S);

  // ---- project board (4.8 x 2.4 m)
  {
    const [x, y, w, h] = SIGN_RECTS.board;
    ctx.fillStyle = '#f7f7f3'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#1d3446'; ctx.fillRect(x, y, w, 118);
    txt(ctx, 'NEW DEVELOPMENT', x + 40, y + 48, 58, '#fff', { align: 'left' });
    txt(ctx, '64 apartments  ·  ground-floor retail  ·  cycle store', x + 42, y + 95, 26, '#cfe0ea', { align: 'left', weight: 'normal' });
    // architect's render
    const gx = x + 30, gy = y + 140, gw = 560, gh = 330;
    const sky = ctx.createLinearGradient(0, gy, 0, gy + gh);
    sky.addColorStop(0, '#8fb7d6'); sky.addColorStop(1, '#e6eef2');
    ctx.fillStyle = sky; ctx.fillRect(gx, gy, gw, gh);
    ctx.fillStyle = '#b9a58f'; ctx.fillRect(gx + 90, gy + 70, 360, 230);
    for (let fy = 0; fy < 6; fy++) {
      for (let fx = 0; fx < 8; fx++) {
        ctx.fillStyle = r() < 0.3 ? '#dbe8ef' : '#40515e';
        ctx.fillRect(gx + 102 + fx * 43, gy + 82 + fy * 36, 30, 24);
      }
      ctx.fillStyle = '#e9e4dc'; ctx.fillRect(gx + 90, gy + 108 + fy * 36, 360, 4);
    }
    ctx.fillStyle = '#6d6a66'; ctx.fillRect(gx + 80, gy + 60, 380, 12);
    ctx.fillStyle = '#6f7b63';
    for (let i = 0; i < 7; i++) { ctx.beginPath(); ctx.arc(gx + 20 + i * 85, gy + gh - 30, 26 + r() * 18, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#9aa49b'; ctx.fillRect(gx, gy + gh - 18, gw, 18);
    txt(ctx, 'Artist\'s impression', gx + gw - 10, gy + gh - 10, 16, '#fff', { align: 'right', weight: 'normal', base: 'alphabetic' });
    // details column
    const tx = x + 620;
    const lines = [
      ['Working hours', 'Mon–Fri 08:00–18:00'], ['', 'Sat 08:00–13:00'], ['Completion', 'Summer 2027'],
      ['Site enquiries', 'Site office (gate 1)'], ['24 h emergency', '0000 000 0000'],
    ];
    let ly = y + 170;
    for (const [a, b] of lines) {
      if (a) txt(ctx, a.toUpperCase(), tx, ly, 20, '#5b6d78', { align: 'left' });
      txt(ctx, b, tx, ly + (a ? 30 : 4), 28, '#1d3446', { align: 'left' });
      ly += a ? 70 : 40;
    }
    ctx.fillStyle = YEL; ctx.fillRect(x, y + h - 30, w, 30);
    ctx.fillStyle = INK;
    for (let i = 0; i < w; i += 40) { ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + 20, y + h - 30); ctx.lineTo(x + i + 38, y + h - 30); ctx.lineTo(x + i + 18, y + h); ctx.fill(); }
    weather(ctx, x, y, w, h, r, 0.7);
  }

  // ---- hoarding banner (9.6 x 2.4 m)
  {
    const [x, y, w, h] = SIGN_RECTS.banner;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#20384a'); g.addColorStop(0.55, '#2b5268'); g.addColorStop(1, '#1b3140');
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    // skyline linework
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    let bx = x + 900;
    ctx.moveTo(bx, y + h);
    while (bx < x + w) {
      const bh = 80 + r() * 260, bw = 60 + r() * 120;
      ctx.lineTo(bx, y + h - bh); ctx.lineTo(bx + bw, y + h - bh); ctx.lineTo(bx + bw, y + h);
      bx += bw + 10;
    }
    ctx.stroke();
    // tower crane silhouette
    ctx.strokeStyle = 'rgba(255,210,60,0.55)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(x + 1500, y + h); ctx.lineTo(x + 1500, y + 90); ctx.moveTo(x + 1380, y + 110); ctx.lineTo(x + 1900, y + 110); ctx.moveTo(x + 1500, y + 60); ctx.lineTo(x + 1420, y + 110); ctx.moveTo(x + 1500, y + 60); ctx.lineTo(x + 1760, y + 110); ctx.stroke();
    txt(ctx, 'BUILDING SOMETHING', x + 70, y + 170, 118, '#fff', { align: 'left' });
    txt(ctx, 'NEW HERE', x + 70, y + 300, 118, YEL, { align: 'left' });
    txt(ctx, 'Homes, shops and a new public square — opening 2027', x + 74, y + 405, 40, '#d6e3ea', { align: 'left', weight: 'normal' });
    weather(ctx, x, y, w, h, r, 1);
  }

  // ---- PPE board
  {
    const [x, y, w, h] = SIGN_RECTS.ppe;
    ctx.fillStyle = '#fbfbf8'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = BLUE; ctx.fillRect(x, y, w, 70);
    txt(ctx, 'SAFETY ON THIS SITE', x + w / 2, y + 37, 36, '#fff');
    const items = [['hardhat', 'HELMETS'], ['hivis', 'HI-VIS'], ['boots', 'BOOTS'], ['gloves', 'GLOVES'], ['goggles', 'EYE PROT.']];
    items.forEach(([k, t], i) => {
      const cx = x + 60 + (i % 3) * 196, cy = y + 150 + Math.floor(i / 3) * 150;
      mandatory(ctx, cx + 20, cy, 50, k);
      txt(ctx, t, cx + 20, cy + 70, 20, INK);
    });
    prohibition(ctx, x + 60 + 2 * 196 + 20, y + 300, 50, 'person');
    txt(ctx, 'NO ENTRY', x + 60 + 2 * 196 + 20, y + 370, 20, INK);
    ctx.fillStyle = BLUE; ctx.fillRect(x, y + h - 100, w, 100);
    txt(ctx, 'ALL VISITORS MUST REPORT', x + w / 2, y + h - 68, 30, '#fff');
    txt(ctx, 'TO THE SITE OFFICE', x + w / 2, y + h - 30, 30, '#fff');
    weather(ctx, x, y, w, h, r, 0.6);
  }

  // ---- entrance / keep out
  {
    const [x, y, w, h] = SIGN_RECTS.entrance;
    ctx.fillStyle = BLUE; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 8; ctx.strokeRect(x + 12, y + 12, w - 24, h - 24);
    txt(ctx, 'SITE ENTRANCE', x + w / 2, y + 90, 58, '#fff');
    txt(ctx, 'KEEP CLEAR · VEHICLES TURNING', x + w / 2, y + 170, 30, '#fff');
  }
  {
    const [x, y, w, h] = SIGN_RECTS.keepout;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = RED; ctx.fillRect(x, y, w, 90);
    txt(ctx, 'DANGER', x + w / 2, y + 47, 64, '#fff');
    txt(ctx, 'CONSTRUCTION SITE', x + w / 2, y + 140, 44, INK);
    txt(ctx, 'KEEP OUT', x + w / 2, y + 205, 52, INK);
    weather(ctx, x, y, w, h, r, 0.5);
  }

  // ---- small signs
  {
    const [x, y, w, h] = SIGN_RECTS.speed;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = RED; ctx.lineWidth = 26;
    ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 105, 0, Math.PI * 2); ctx.stroke();
    txt(ctx, '10', x + w / 2, y + h / 2 + 6, 110, INK);
  }
  { const [x, y, w, h] = SIGN_RECTS.firstaid; safe(ctx, x, y, w, h, 'cross'); }
  {
    const [x, y, w, h] = SIGN_RECTS.assembly;
    safe(ctx, x, y, w, h * 0.7, 'group');
    ctx.fillStyle = GRN; ctx.fillRect(x, y + h * 0.7, w, h * 0.3);
    txt(ctx, 'ASSEMBLY', x + w / 2, y + h * 0.8, 32, '#fff');
    txt(ctx, 'POINT', x + w / 2, y + h * 0.92, 32, '#fff');
  }
  { const [x, y, w, h] = SIGN_RECTS.crane; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); warning(ctx, x + w / 2, y + h / 2 + 6, 105, 'load'); }
  { const [x, y, w, h] = SIGN_RECTS.noentry; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); prohibition(ctx, x + w / 2, y + h / 2, 110, 'person'); }
  { const [x, y, w, h] = SIGN_RECTS.hardhat; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); mandatory(ctx, x + w / 2, y + h / 2, 110, 'hardhat'); }
  { const [x, y, w, h] = SIGN_RECTS.hivis; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); mandatory(ctx, x + w / 2, y + h / 2, 110, 'hivis'); }
  { const [x, y, w, h] = SIGN_RECTS.boots; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); mandatory(ctx, x + w / 2, y + h / 2, 110, 'boots'); }
  { const [x, y, w, h] = SIGN_RECTS.electric; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); warning(ctx, x + w / 2, y + h / 2 + 6, 105, 'bolt'); }
  {
    const [x, y, w, h] = SIGN_RECTS.tag;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = GRN; ctx.fillRect(x + 10, y + 10, w - 20, 90);
    txt(ctx, 'SCAFFOLD', x + w / 2, y + 42, 34, '#fff');
    txt(ctx, 'INSPECTED', x + w / 2, y + 80, 30, '#fff');
    ctx.strokeStyle = '#888'; ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(x + 24, y + 130 + i * 30); ctx.lineTo(x + w - 24, y + 130 + i * 30); ctx.stroke(); }
  }
  {
    const [x, y, w, h] = SIGN_RECTS.firepoint;
    ctx.fillStyle = RED; ctx.fillRect(x, y, w, h);
    txt(ctx, 'FIRE', x + w / 2, y + 90, 64, '#fff');
    txt(ctx, 'POINT', x + w / 2, y + 170, 64, '#fff');
  }
  {
    const [x, y, w, h] = SIGN_RECTS.turning;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    warning(ctx, x + 120, y + h / 2 + 8, 95, 'excl');
    txt(ctx, 'CAUTION', x + 350, y + 90, 50, INK);
    txt(ctx, 'SITE TRAFFIC', x + 350, y + 150, 36, INK);
    txt(ctx, 'CROSSING', x + 350, y + 195, 36, INK);
  }
  {
    const [x, y, w, h] = SIGN_RECTS.contact;
    ctx.fillStyle = '#1d3446'; ctx.fillRect(x, y, w, h);
    txt(ctx, 'CONSIDERATE BUILDING', x + w / 2, y + 60, 44, YEL);
    txt(ctx, 'Noise, dust or a concern? We want to hear about it.', x + w / 2, y + 125, 30, '#fff', { weight: 'normal' });
    txt(ctx, '24 h line  0000 000 0000', x + w / 2, y + 190, 44, '#fff');
  }
  {
    const [x, y, w, h] = SIGN_RECTS.hoist;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = YEL; ctx.fillRect(x, y, w, 80);
    txt(ctx, 'GOODS / PASSENGER HOIST', x + w / 2, y + 42, 34, INK);
    txt(ctx, 'MAX 1500 kg · 18 PERSONS', x + w / 2, y + 125, 32, INK);
    txt(ctx, 'AUTHORISED OPERATORS ONLY', x + w / 2, y + 190, 28, RED);
  }
  {
    const [x, y, w, h] = SIGN_RECTS.wash;
    ctx.fillStyle = BLUE; ctx.fillRect(x, y, w, h);
    txt(ctx, 'WHEEL WASH', x + w / 2, y + 85, 60, '#fff');
    txt(ctx, 'ALL VEHICLES LEAVING SITE', x + w / 2, y + 170, 30, '#fff');
  }
  {
    const [x, y, w, h] = SIGN_RECTS.banner2;
    ctx.fillStyle = '#f2f0ea'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#20384a'; ctx.fillRect(x, y, 60, h); ctx.fillRect(x + w - 60, y, 60, h);
    txt(ctx, 'SORRY FOR ANY DISRUPTION', x + w / 2, y + 95, 62, '#20384a');
    txt(ctx, 'We are working to finish as quickly and quietly as we can', x + w / 2, y + 175, 34, '#4b6272', { weight: 'normal' });
    weather(ctx, x, y, w, h, r, 1);
  }

  // ---- door / wayfinding labels
  label(ctx, SIGN_RECTS.office, 'SITE OFFICE', '#1d3446');
  label(ctx, SIGN_RECTS.canteen, 'CANTEEN', '#1d3446');
  label(ctx, SIGN_RECTS.drying, 'DRYING ROOM', '#1d3446');
  label(ctx, SIGN_RECTS.firstaidLbl, 'FIRST AID', GRN, '#fff', 'cross');
  label(ctx, SIGN_RECTS.meeting, 'INDUCTION', '#1d3446');
  label(ctx, SIGN_RECTS.toilets, 'TOILETS', '#1d3446');
  label(ctx, SIGN_RECTS.pedestrian, 'PEDESTRIANS', BLUE, '#fff', 'person');
  label(ctx, SIGN_RECTS.deliveries, 'DELIVERIES', '#1d3446');

  const tex = canvasTexture(c, { aniso: 8 });
  tex.generateMipmaps = true;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0 });
  mat.name = 'signs';
  atlas = { tex, mat };
  return atlas;
}

// PlaneGeometry (facing +z) of w x h metres showing atlas region `key`.
export function signGeo(key, w, h) {
  const [x, y, rw, rh] = SIGN_RECTS[key];
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  const u0 = x / S, u1 = (x + rw) / S, v0 = 1 - (y + rh) / S, v1 = 1 - y / S;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return g;
}
