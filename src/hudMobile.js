import {
  RCL_COLOURS, HOOK_BLOCKS, HOOK_BLOCK_IDS, CW_CONFIGS, CW_SLABS, CW_MAKEUP, reeveTime, FLOATS, BASES, AXLES, LEVEL, SPEED_LIMITS,
  WIND_PERM, SLEW_REC_RPM, tableLookup, PINNED_LENGTHS, RMIN, TOWER_ZONE, AT100, MATS, BALLAST,
} from './mobile/config.js';

// AT-100 5.1 operator display (spec §8.8), hosted by hud.js via setMachine('mobile').
// Three pages follow the machine mode: ROAD (carrier dashboard), SETUP (the
// outrigger remote: top view, jacks, float forces / pressures, level bubble)
// and CRANE (the RCL: config code, utilisation bar, geometry, wind, hoist,
// STOP icons, warning triangles, chart column, working-range side view).
// Plus the RCL-config and reeving dialogs, the ballast panel, a setup
// checklist, context hints and the crane-cab screen renderer (drawCabScreen).
//
// Input: hud.update(s) with s.machine === 'mobile'; s carries the common HUD
// fields (payload, capacity, ratio, lmiState, radius, hookHeight, slewDeg,
// wind, gustPeak, power, eStop, levers, cameraName, attachable, canRelease,
// job, showHints) and s.mobile (MobileHudState below). Every s.mobile field
// is optional: missing ones fall back to the common fields or config.js.

/**
 * @typedef {object} MobileHudState   hudState().mobile
 * @property {'ROAD'|'SETUP'|'CRANE'|'TIPPING'|'OVERTURNED'} mode
 * @property {boolean} [engineOn]            carrier engine running
 * @property {boolean} [stowed]              hook block stowed on the bumper
 * @property {object} [road]  {speedKmh, limitKmh, onSite, gear:'D1'..'D12'|'N'|'R1'|'R2'|number (+D, 0 N, −R),
 *   rpm, program:'ROAD'|'ALL'|'CRAB', parkingBrake, crawl, steer:−1..1 (actual, +right),
 *   interlock:string|null (reason text, e.g. 'beams not retracted'),
 *   guidance:{distance m, text, bearingDeg (relative to heading, + = right)}|null}
 * @property {object} [setup] {beams:[4×{ext 0..1, detent:0|50|100|null, obstructed}],
 *   jacks:[4×{e m, max m}], floats:[4×{contact, forceKg, pressureKPa, allowKPa, mat:'none'|'carried'|'composite',
 *   light, lifted, settleMm}], selected:0..3|4 (all), level:{pitchDeg, rollDeg}, tiltDeg?,
 *   tyresClear, floatsSet, autoLevel:'off'|'active'|'done'|'range'|string, pinned}
 *   (order FL, FR, RL, RR everywhere)
 * @property {object} [ballast] {superKg, deckStack:['A'|'B'|'C'…], raising:{dir:+1|−1, progress 0..1}|null, pinned, quick}
 * @property {object} [rcl] {config:{mode,base,cwKg,block,confirmed}, code?, state:'noconfig'|'blue'|'ok'|'warn'|'stop',
 *   ratio, capKg, grossKg, netKg, stops:Iterable<id>, warnings:Iterable<id>, muted, bypass}
 *   (ids: see RCL_LABELS; unknown ids are shown upper-cased)
 * @property {object} [boom] {L, k:0..11|null (null = between pins), sections:[5×0..1] (T1..T5), phase:'pinned'|'moving'|'pinning',
 *   activeSection:0..4|−1, R, thetaGDeg, thetaDeg, headHeight, hookHeight, lift}
 * @property {number} [slewDeg]  displayed slew (0 front, 90 right …); [slewRpm] actual (+ = right); [slewRecRpm]
 * @property {object} [wind] {head, gust3s, perm, loadMax}   m/s
 * @property {object} [hoist] {speedMpm, linePullKN, falls, block, overload}
 * @property {object} [chart] {key, L, cells:[{R, kg, stab}]}  current column (buildChartColumn), key changes with cfg / L
 * @property {object} [zone] {inTowerZone, ceiling, headTop}
 * @property {number[]} [supportsKg]  4 float reactions for the CRANE-page support bars
 * @property {object} [reeving] {to, t, total} while the riggers re-reeve
 * @property {object} [tip] {state:'STABLE'|'FLOAT_LIGHT'|'LIFTOFF'|'TIPPING'|'OVERTURNED', margin m}
 * @property {Array<{label:string, ok:boolean, value?:string}>} [checklist]  job setup checklist (overrides the derived one)
 */

const PAGE_OF = { ROAD: 'road', SETUP: 'setup', CRANE: 'crane', TIPPING: 'crane', OVERTURNED: 'crane' };
const STATE_COL = { noconfig: '#8e98a3', blue: RCL_COLOURS.blue, ok: RCL_COLOURS.ok, warn: RCL_COLOURS.warn, stop: RCL_COLOURS.stop };
const STATE_TEXT = { noconfig: 'NO CONFIG', blue: 'RECONFIG OK', ok: 'OK', warn: 'PRE-WARNING', stop: 'LMB STOP' };

/** Display text for RCL stop / warning ids (hudState().mobile.rcl.stops / .warnings). */
export const RCL_LABELS = {
  // stops: motions blocked
  lmb: 'LMB STOP', hookLimit: 'HOOK LIMIT', range: 'WORKING RANGE', teleLoad: 'TELE LOAD', blockRating: 'BLOCK RATING',
  noConfig: 'NO CONFIG', notPermitted: 'CONFIG NOT PERMITTED', lowerLimit: 'LOWERING LIMIT', zone: 'TOWER ZONE', roadZone: 'ROAD ZONE',
  boomContact: 'BOOM CONTACT', hoistOverload: 'HOIST OVERLOAD', pinned: 'TURNTABLE PINNED', luffStop: 'LUFF END STOP',
  // warnings: never blocking
  support: 'SUPPORT ≠ CONFIG', tilt: 'TILT', wind: 'WIND', tyres: 'TYRES NOT CLEAR', floatLight: 'OUTRIGGER LIGHT',
  floatLifted: 'FLOAT LIFTED', sidePull: 'SIDE PULL', unpinned: 'TELE / NOT PINNED', reeving: 'REEVING CHANGED — CONFIRM CONFIG',
  bypass: 'RCL BYPASS', settlement: 'SETTLEMENT', slewSpeed: 'SLEW SPEED',
};
const STOP_ICONS = [['lmb', 'LMB'], ['hookLimit', 'HOOK'], ['range', 'RANGE'], ['teleLoad', 'TELE']];
const WARN_ICONS = [['support', 'SUPPORT'], ['tilt', 'TILT'], ['wind', 'WIND'], ['tyres', 'TYRES']];

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setText(n, v) { if (n && n._v !== v) { n._v = v; n.textContent = v; } }
function setData(n, k, v) { const kk = '_d' + k; if (n && n[kk] !== v) { n[kk] = v; n.dataset[k] = v; } }
function setHidden(n, h) { if (n && n._h !== h) { n._h = h; n.hidden = h; } }
function setClass(n, c, on) { const k = '_c' + c; if (n && n[k] !== on) { n[k] = on; n.classList.toggle(c, on); } }
function setStyle(n, prop, v) { const k = '_s' + prop; if (n && n[k] !== v) { n[k] = v; n.style[prop] = v; } }
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const tFmt = (kg) => { const t = num(kg) / 1000; return Math.abs(t) >= 10 ? t.toFixed(1) : t.toFixed(2); };
const sgn = (v, d = 1) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}`;
const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : v ? Array.from(v) : []));
const sectorOf = (deg) => (deg < 45 || deg >= 315 ? 'FRONT' : deg < 135 ? 'RIGHT' : deg < 225 ? 'REAR' : 'LEFT');
const fmtGear = (g) => {
  if (typeof g === 'string') return g;
  if (!Number.isFinite(g) || g === 0) return 'N';
  return g > 0 ? `D${g}` : `R${-g}`;
};
const blockDef = (id) => HOOK_BLOCKS[id] || HOOK_BLOCKS.ball;
// state colour of a float pressure vs the ground's allowable bearing (green / amber / red)
const pressureState = (f) => {
  if (!f || !f.contact) return 'none';
  if (f.lifted) return 'bad';
  const p = num(f.pressureKPa, NaN), a = num(f.allowKPa, NaN);
  if (Number.isFinite(p) && Number.isFinite(a) && a > 0) return p > a ? 'bad' : p > 0.8 * a ? 'warn' : 'ok';
  return f.light ? 'warn' : 'ok';
};
const PSTATE_COL = { none: '#56626c', ok: '#35c47a', warn: '#f0b40c', bad: '#ff3030' };

/** Short RCL code shown on the display, e.g. "OR B100 CW35.0 n1 BALL" (§5). */
export function rclShortCode(cfg) {
  if (!cfg) return '—';
  const b = blockDef(cfg.block);
  const sup = cfg.mode === 'tyres' ? 'TY' : `OR B${cfg.base ?? 100}`;
  return `${sup} CW${(num(cfg.cwKg) / 1000).toFixed(1)} n${b.falls} ${b.id.toUpperCase()}`;
}

/**
 * Current chart column for the mini chart (§8.8). table = a chart in the §2.1
 * format ([R, [kg per LENGTHS entry | null]] rows, e.g. CHARTS[chartKey(cfg)]),
 * struct = STRUCT (same format) for the stability-governed flag (chart < STRUCT, §2).
 * k = pinned step, or [kLo, kHi] between pins (cell = min of both columns, §2.3.3).
 * @returns {{R:number, kg:number, stab:boolean}[]}
 */
export function buildChartColumn(table, struct, k) {
  const out = [];
  if (!Array.isArray(table) || k === null || k === undefined) return out;
  const ks = Array.isArray(k) ? k : [k];
  const structAt = (i, R, kk) => {
    if (!Array.isArray(struct)) return null;
    const row = struct[i] && struct[i][0] === R ? struct[i] : struct.find((r) => r[0] === R);
    return row ? row[1][kk] : null;
  };
  table.forEach(([R, row], i) => {
    let kg = Infinity, stab = false;
    for (const kk of ks) {
      const v = row ? row[kk] : null;
      if (v === null || v === undefined) { kg = null; break; }
      if (v < kg) {
        kg = v;
        const s = structAt(i, R, kk);
        stab = s !== null && s !== undefined && v < s;
      }
    }
    if (kg !== null && Number.isFinite(kg)) out.push({ R, kg, stab });
  });
  return out;
}

// linear interpolation of a column at R (0 outside)
function columnAt(cells, R) {
  if (!cells || !cells.length) return 0;
  if (R <= cells[0].R) return cells[0].kg;
  for (let i = 1; i < cells.length; i++) {
    if (R <= cells[i].R) {
      const a = cells[i - 1], b = cells[i];
      return a.kg + (b.kg - a.kg) * (R - a.R) / (b.R - a.R);
    }
  }
  return 0;
}

// ------------------------------------------------------------------ canvas drawings (shared with the cab screen)
// Top view of the carrier (front to the right, left side up) with beams, mats and floats.
function drawTopView(x, W, H, su, flash) {
  const sc = Math.min((W - 6) / 12.6, (H - 6) / 9.6);
  const X = (xc) => W / 2 + (xc - 2.0) * sc;
  const Y = (yc) => H / 2 - yc * sc;
  const beams = su.beams || [];
  const floats = su.floats || [];
  const jacks = su.jacks || [];
  const sel = su.selected;
  x.lineWidth = 1;
  // detent guide ticks along each beam line
  x.strokeStyle = 'rgba(160,220,185,0.18)';
  for (const f of FLOATS) {
    for (const b of [0, 50, 100]) {
      const yy = Y(f.side * BASES[b]);
      x.beginPath(); x.moveTo(X(f.x) - 5, yy); x.lineTo(X(f.x) + 5, yy); x.stroke();
    }
  }
  // carrier body, axles, cab, turntable
  x.fillStyle = '#26303a'; x.strokeStyle = '#7d8a93';
  x.fillRect(X(-3.7), Y(1.375), 11.45 * sc, 2.75 * sc);
  x.strokeRect(X(-3.7) + 0.5, Y(1.375) + 0.5, 11.45 * sc, 2.75 * sc);
  x.fillStyle = '#3a4650';
  x.fillRect(X(6.1), Y(1.375), 1.65 * sc, 1.1 * sc); // driver cab, front left
  x.fillStyle = '#10151a';
  for (const ax of AXLES) for (const s of [1, -1]) x.fillRect(X(ax - 0.68), Y(s * 1.18 + 0.19), 1.37 * sc, 0.385 * sc);
  x.strokeStyle = '#5c6a74';
  x.beginPath(); x.arc(X(0), Y(0), 1.25 * sc, 0, Math.PI * 2); x.stroke();
  // beams, mats, floats
  FLOATS.forEach((f, i) => {
    const bm = beams[i];
    const ext = typeof bm === 'number' ? bm : num(bm?.ext);
    const yF = f.side * (BASES[0] + (BASES[100] - BASES[0]) * ext);
    const fl = floats[i] || {};
    const st = pressureState(fl);
    // beam
    x.fillStyle = bm?.obstructed ? '#7a2622' : '#b58a12';
    const y0 = Y(f.side * 0.9), y1 = Y(yF);
    x.fillRect(X(f.x) - 0.17 * sc, Math.min(y0, y1), 0.34 * sc, Math.abs(y1 - y0));
    // mat
    const mat = MATS[fl.mat] || null;
    if (mat && mat.thickness > 0) {
      const mx = mat.size[0], my = mat.size[2];
      x.fillStyle = fl.mat === 'composite' ? '#3b3f45' : '#6b4a2b';
      x.fillRect(X(f.x - mx / 2), Y(yF + my / 2), mx * sc, my * sc);
    }
    // float pad: colour = pressure state; outline flashes when light / lifted
    const ps = Math.max(5, 0.55 * sc);
    x.fillStyle = st === 'none' ? '#1c2328' : PSTATE_COL[st];
    x.fillRect(X(f.x) - ps / 2, Y(yF) - ps / 2, ps, ps);
    x.strokeStyle = (fl.light || fl.lifted) && flash ? '#ffffff' : PSTATE_COL[st];
    x.lineWidth = 1.5;
    x.strokeRect(X(f.x) - ps / 2, Y(yF) - ps / 2, ps, ps);
    x.lineWidth = 1;
    if (sel === i || sel === 4 || sel === 'all') {
      x.strokeStyle = '#f0b40c';
      x.lineWidth = 2;
      x.strokeRect(X(f.x) - ps / 2 - 4, Y(yF) - ps / 2 - 4, ps + 8, ps + 8);
      x.lineWidth = 1;
    }
    if (bm?.obstructed) {
      x.strokeStyle = '#ff3030';
      x.beginPath();
      x.moveTo(X(f.x) - ps, Y(yF) - ps); x.lineTo(X(f.x) + ps, Y(yF) + ps);
      x.moveTo(X(f.x) + ps, Y(yF) - ps); x.lineTo(X(f.x) - ps, Y(yF) + ps);
      x.stroke();
    }
    // jack stroke gauge beside the float
    const jk = jacks[i];
    if (jk && jk.max > 0) {
      const gx = X(f.x) + (f.x > 0 ? -1 : 1) * (ps / 2 + 6) - 2, gh = Math.max(12, 0.9 * sc);
      x.fillStyle = '#10151a'; x.fillRect(gx, Y(yF) - gh / 2, 4, gh);
      x.fillStyle = '#9ff5c8'; const fr = clamp(num(jk.e) / jk.max, 0, 1);
      x.fillRect(gx, Y(yF) + gh / 2 - gh * fr, 4, gh * fr);
    }
    // beam % + detent lamp near the carrier side
    const pct = Math.round(ext * 100);
    const det = bm && typeof bm === 'object' ? bm.detent : [0, 50, 100].includes(pct) ? pct : null;
    x.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
    x.textAlign = f.x > 0 ? 'right' : 'left';
    x.textBaseline = 'middle';
    const lx = X(f.x) + (f.x > 0 ? -0.35 * sc : 0.35 * sc), ly = Y(f.side * 1.9);
    x.fillStyle = '#cfe9da';
    x.fillText(`${pct}%`, lx + (f.x > 0 ? -8 : 8), ly);
    x.fillStyle = det !== null && det !== undefined ? '#35c47a' : '#f0b40c';
    x.beginPath(); x.arc(lx, ly, 2.6, 0, Math.PI * 2); x.fill();
  });
  // front marker
  x.fillStyle = 'rgba(160,220,185,0.6)';
  x.font = '600 8px "JetBrains Mono", ui-monospace, monospace';
  x.textAlign = 'right';
  x.textBaseline = 'bottom';
  x.fillText('FRONT ▶', W - 2, H - 1);
}

// Inclinometer bubble: x = pitch (front high → right), y = roll (left high → up); rings ±0.3° / ±1°.
function drawBubble(x, W, H, pitchDeg, rollDeg) {
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 3;
  const k = R / 1.0; // px per degree (outer ring = 1°)
  x.fillStyle = 'rgba(0,0,0,0.35)';
  x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.fill();
  x.strokeStyle = 'rgba(160,220,185,0.25)'; x.lineWidth = 1;
  x.beginPath(); x.arc(cx, cy, R, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.arc(cx, cy, LEVEL.warnDeg * k, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = 'rgba(53,196,122,0.7)';
  x.beginPath(); x.arc(cx, cy, LEVEL.okDeg * k, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = 'rgba(160,220,185,0.18)';
  x.beginPath(); x.moveTo(cx - R, cy); x.lineTo(cx + R, cy); x.moveTo(cx, cy - R); x.lineTo(cx, cy + R); x.stroke();
  const p = num(pitchDeg), r = num(rollDeg);
  const mag = Math.hypot(p, r);
  let bx = p * k, by = -r * k;
  const bl = Math.hypot(bx, by);
  if (bl > R - 5) { bx *= (R - 5) / bl; by *= (R - 5) / bl; }
  const col = mag <= LEVEL.okDeg ? '#35c47a' : mag <= LEVEL.warnDeg ? '#f0b40c' : '#ff3030';
  x.fillStyle = col;
  x.shadowColor = col; x.shadowBlur = 6;
  x.beginPath(); x.arc(cx + bx, cy + by, 5, 0, Math.PI * 2); x.fill();
  x.shadowBlur = 0;
}

// Working-range side view: boom, rope, hook, Rmin / Rmax and the tower-zone ceiling.
function drawSideView(x, W, H, d) {
  const pad = 4;
  const rMax = Math.max(20, Math.ceil((Math.max(d.L + 2, num(d.R) + 4)) / 10) * 10);
  const zMax = Math.max(20, Math.ceil((Math.max(d.headH + 3, d.ceiling ? d.ceiling + 3 : 0)) / 10) * 10);
  const sc = Math.min((W - 2 * pad) / (rMax + 5), (H - 2 * pad - 8) / zMax);
  const X = (r) => pad + (r + 5) * sc;
  const Y = (z) => H - pad - 8 - z * sc;
  x.lineWidth = 1;
  x.strokeStyle = 'rgba(120,255,170,0.08)';
  x.fillStyle = 'rgba(160,220,185,0.5)';
  x.font = '600 7.5px "JetBrains Mono", ui-monospace, monospace';
  x.textAlign = 'center'; x.textBaseline = 'top';
  for (let r = 0; r <= rMax; r += 10) {
    x.beginPath(); x.moveTo(X(r) + 0.5, Y(0)); x.lineTo(X(r) + 0.5, Y(zMax)); x.stroke();
    if (r) x.fillText(String(r), X(r), Y(0) + 1);
  }
  x.textAlign = 'left'; x.textBaseline = 'middle';
  for (let z = 10; z <= zMax; z += 10) { x.beginPath(); x.moveTo(X(-5), Y(z) + 0.5); x.lineTo(X(rMax), Y(z) + 0.5); x.stroke(); }
  // ground + carrier silhouette
  x.strokeStyle = 'rgba(160,220,185,0.45)';
  x.beginPath(); x.moveTo(X(-5), Y(0) + 0.5); x.lineTo(X(rMax), Y(0) + 0.5); x.stroke();
  x.fillStyle = '#34414b';
  x.fillRect(X(-3.7), Y(2.2), 7.7 * sc, 2.2 * sc);
  x.fillRect(X(-3.2), Y(3.4), 4.2 * sc, 1.2 * sc);
  // Rmin / Rmax
  x.setLineDash([2, 2]);
  x.strokeStyle = 'rgba(240,180,12,0.55)';
  for (const r of [d.rmin, d.rmax]) if (Number.isFinite(r) && r > 0) { x.beginPath(); x.moveTo(X(r) + 0.5, Y(0)); x.lineTo(X(r) + 0.5, Y(zMax)); x.stroke(); }
  // tower-crane zone ceiling (§5.1)
  if (d.ceiling) {
    x.strokeStyle = 'rgba(255,48,48,0.85)';
    x.beginPath(); x.moveTo(X(-5), Y(d.ceiling) + 0.5); x.lineTo(X(rMax), Y(d.ceiling) + 0.5); x.stroke();
    x.fillStyle = '#ff7b73';
    x.textAlign = 'right'; x.textBaseline = 'bottom';
    x.fillText(`${d.ceiling.toFixed(1)} m`, X(rMax) - 1, Y(d.ceiling) - 1);
  }
  x.setLineDash([]);
  // boom (pivot → head), rope, hook
  const pu = AT100.pivot.u, pz = AT100.pivot.z + num(d.lift);
  x.strokeStyle = d.col || '#f0b40c';
  x.lineWidth = 3;
  x.lineCap = 'round';
  x.beginPath(); x.moveTo(X(pu), Y(pz)); x.lineTo(X(d.R), Y(d.headH)); x.stroke();
  x.lineCap = 'butt';
  x.lineWidth = 1;
  x.strokeStyle = '#c9d2d8';
  x.beginPath(); x.moveTo(X(d.R) + 0.5, Y(d.headH)); x.lineTo(X(d.R) + 0.5, Y(Math.max(0, d.hookH))); x.stroke();
  x.fillStyle = '#ff5a3c';
  x.beginPath(); x.arc(X(d.R), Y(Math.max(0, d.hookH)), 2.5, 0, Math.PI * 2); x.fill();
}

// Current chart column (t over R) with the working point; S cells hollow (stability-governed).
function drawMiniChart(x, W, H, d) {
  const cells = d.cells || [];
  const padL = 20, padR = 5, padT = 12, padB = 12;
  const rMax = Math.max(12, Math.ceil(((cells.length ? cells[cells.length - 1].R : 10) + 2) / 5) * 5);
  const capR = columnAt(cells, num(d.R));
  const want = Math.max(num(d.grossKg) * 1.5, capR * 1.6, 5000) / 1000;
  const step = want > 40 ? 20 : want > 16 ? 10 : want > 8 ? 4 : 2;
  const yMax = Math.ceil(want / step) * step;
  const X = (r) => padL + (r / rMax) * (W - padL - padR);
  const Y = (t) => H - padB - (Math.min(t, yMax) / yMax) * (H - padT - padB);
  x.lineWidth = 1;
  x.font = '600 7.5px "JetBrains Mono", ui-monospace, monospace';
  x.strokeStyle = 'rgba(120,255,170,0.08)';
  x.fillStyle = 'rgba(160,220,185,0.5)';
  x.textAlign = 'center'; x.textBaseline = 'top';
  for (let r = 0; r <= rMax; r += rMax > 30 ? 10 : 5) {
    x.beginPath(); x.moveTo(X(r) + 0.5, padT); x.lineTo(X(r) + 0.5, H - padB); x.stroke();
    if (r) x.fillText(String(r), X(r), H - padB + 2);
  }
  x.textAlign = 'right'; x.textBaseline = 'middle';
  for (let t = 0; t <= yMax + 1e-6; t += step) {
    x.beginPath(); x.moveTo(padL, Y(t) + 0.5); x.lineTo(W - padR, Y(t) + 0.5); x.stroke();
    if (t) x.fillText(String(t), padL - 3, Y(t));
  }
  x.textAlign = 'left'; x.textBaseline = 'top';
  x.fillStyle = 'rgba(160,220,185,0.7)';
  x.fillText(d.label || 'CHART', padL + 2, 1);
  if (cells.length) {
    x.save();
    x.beginPath(); x.rect(padL, padT - 1, W - padL - padR, H - padT - padB + 1); x.clip();
    x.beginPath();
    x.moveTo(X(cells[0].R), Y(0));
    for (const c of cells) x.lineTo(X(c.R), Y(c.kg / 1000));
    x.lineTo(X(cells[cells.length - 1].R), Y(0));
    x.closePath();
    x.fillStyle = 'rgba(53,224,122,0.13)';
    x.fill();
    x.setLineDash([3, 3]);
    x.strokeStyle = 'rgba(240,180,12,0.55)';
    x.beginPath();
    cells.forEach((c, i) => (i ? x.lineTo(X(c.R), Y(c.kg * 0.9 / 1000)) : x.moveTo(X(c.R), Y(c.kg * 0.9 / 1000))));
    x.stroke();
    x.setLineDash([]);
    x.strokeStyle = '#35e07a';
    x.lineWidth = 1.5;
    x.beginPath();
    cells.forEach((c, i) => (i ? x.lineTo(X(c.R), Y(c.kg / 1000)) : x.moveTo(X(c.R), Y(c.kg / 1000))));
    x.stroke();
    x.lineWidth = 1;
    for (const c of cells) {
      x.beginPath(); x.arc(X(c.R), Y(c.kg / 1000), 2, 0, Math.PI * 2);
      if (c.stab) { x.fillStyle = '#081210'; x.fill(); x.strokeStyle = '#9fe8ff'; x.stroke(); } // S: stability-governed
      else { x.fillStyle = '#35e07a'; x.fill(); }
    }
    x.restore();
  }
  // R marker + working point
  const rx = X(clamp(num(d.R), 0, rMax));
  x.strokeStyle = 'rgba(200,255,220,0.35)';
  x.setLineDash([2, 2]);
  x.beginPath(); x.moveTo(Math.round(rx) + 0.5, padT); x.lineTo(Math.round(rx) + 0.5, H - padB); x.stroke();
  x.setLineDash([]);
  const col = d.col || '#35e07a';
  x.fillStyle = col; x.shadowColor = col; x.shadowBlur = 8;
  x.beginPath(); x.arc(rx, Y(num(d.grossKg) / 1000), 3.4, 0, Math.PI * 2); x.fill();
  x.shadowBlur = 0;
}

/**
 * Crane-cab screen (LICCON-like), drawn by the machine at 4 Hz into its
 * screen canvas: MobileMachine.updateCabScreen(dt, s) → drawCabScreen(tex.image.getContext('2d'), s).
 * Logical 320 × 200 page, scaled to the canvas.
 */
export function drawCabScreen(x, s, W = x.canvas.width, H = x.canvas.height) {
  const m = (s && s.mobile) || {};
  const page = PAGE_OF[m.mode] || 'crane';
  x.setTransform(W / 320, 0, 0, H / 200, 0, 0);
  x.fillStyle = '#06110d'; x.fillRect(0, 0, 320, 200);
  x.textBaseline = 'alphabetic';
  x.textAlign = 'left';
  const hdr = (col, text) => {
    x.fillStyle = col; x.fillRect(0, 0, 320, 24);
    x.fillStyle = '#e8fff2'; x.font = 'bold 13px monospace';
    x.fillText(text, 8, 17);
  };
  if (page === 'road') {
    const r = m.road || {};
    hdr('#1d2c3a', `AT-100  ROAD   ${m.engineOn === false ? 'ENGINE OFF' : 'ENGINE ON'}`);
    x.fillStyle = '#e8fff2'; x.font = 'bold 44px monospace';
    x.fillText(String(Math.round(Math.abs(num(r.speedKmh)))), 14, 84);
    x.font = 'bold 14px monospace'; x.fillStyle = '#7fd9a8';
    x.fillText('km/h', 16, 102);
    x.fillText(`GEAR ${fmtGear(r.gear)}   ${Math.round(num(r.rpm, 600))} rpm`, 130, 60);
    x.fillText(`STEER ${r.program || 'ROAD'}   ${r.parkingBrake ? 'P-BRAKE' : ''}`, 130, 84);
    if (r.interlock) { x.fillStyle = '#ff9a3a'; x.font = 'bold 12px monospace'; x.fillText(`INTERLOCK: ${String(r.interlock).slice(0, 30)}`, 12, 150); }
    if (r.guidance) { x.fillStyle = '#9ff5c8'; x.font = 'bold 12px monospace'; x.fillText(`${Math.round(num(r.guidance.distance))} m  ${String(r.guidance.text || '').slice(0, 28)}`, 12, 178); }
    return;
  }
  if (page === 'setup') {
    const su = m.setup || {};
    hdr('#2a2a12', `AT-100  SETUP  ${su.floatsSet ? 'FLOATS SET' : ''}`);
    x.save(); x.translate(4, 28); drawTopView(x, 200, 150, su, false); x.restore();
    const lv = su.level || {};
    x.save(); x.translate(222, 40); drawBubble(x, 84, 84, lv.pitchDeg, lv.rollDeg); x.restore();
    x.fillStyle = '#9ff5c8'; x.font = 'bold 11px monospace';
    x.fillText(`P ${sgn(num(lv.pitchDeg))}°`, 222, 146);
    x.fillText(`R ${sgn(num(lv.rollDeg))}°`, 222, 162);
    x.fillStyle = su.tyresClear ? '#35c47a' : '#ff9a3a';
    x.fillText(su.tyresClear ? 'TYRES CLEAR' : 'ON TYRES', 222, 180);
    return;
  }
  const rcl = m.rcl || {};
  const state = rcl.state || lmiToState(s);
  const ratio = num(rcl.ratio, num(s?.ratio));
  const col = STATE_COL[state] || STATE_COL.ok;
  hdr(s?.eStop ? '#5a0f0f' : '#123a2b', `RCL ${rcl.code || rclShortCode(rcl.config)}  ${s?.power ? 'ON' : 'OFF'}`);
  const boom = m.boom || {};
  const L = num(boom.L, num(m.boomLen, 11.5));
  x.font = 'bold 24px monospace'; x.fillStyle = '#e8fff2';
  x.fillText(`R ${num(boom.R, num(s?.radius)).toFixed(1)} m`, 10, 56);
  x.fillText(`${tFmt(num(rcl.grossKg, num(m.grossKg)))} t`, 176, 56);
  x.font = 'bold 13px monospace'; x.fillStyle = '#7fd9a8';
  x.fillText(`L ${L.toFixed(1)} m  ${boom.k === null ? 'TELE' : 'PIN'}`, 10, 80);
  x.fillText(`CAP ${tFmt(num(rcl.capKg, num(s?.capacity)))} t`, 176, 80);
  x.fillText(`θ ${num(boom.thetaGDeg, num(m.luffDeg)).toFixed(1)}°  SLEW ${Math.round(num(m.slewDeg, num(s?.slewDeg)))}°`, 10, 102);
  x.fillText(`HOOK ${num(boom.hookHeight, num(s?.hookHeight)).toFixed(1)} m`, 176, 102);
  x.strokeStyle = '#7fd9a8'; x.strokeRect(10, 114, 300, 22);
  x.fillStyle = col; x.fillRect(12, 116, Math.min(296, 296 * ratio / 1.2), 18);
  x.fillStyle = '#ffb020'; x.fillRect(12 + 296 * 0.9 / 1.2, 112, 2, 26);
  x.fillStyle = '#ff3030'; x.fillRect(12 + 296 / 1.2, 112, 2, 26);
  x.fillStyle = '#e8fff2'; x.font = 'bold 13px monospace';
  x.fillText(`${Math.round(ratio * 100)} %  ${STATE_TEXT[state] || ''}`, 120, 130);
  const stops = [...toSet(rcl.stops)].map((id) => RCL_LABELS[id] || String(id).toUpperCase());
  const warns = [...toSet(rcl.warnings)].map((id) => RCL_LABELS[id] || String(id).toUpperCase());
  x.font = 'bold 12px monospace';
  x.fillStyle = '#ff6b5e'; x.fillText(stops.join(' · ').slice(0, 42), 10, 160);
  x.fillStyle = '#ffc04a'; x.fillText(warns.join(' · ').slice(0, 42), 10, 180);
  if (m.mode === 'TIPPING' || m.mode === 'OVERTURNED') {
    x.fillStyle = 'rgba(255,48,48,0.85)'; x.fillRect(0, 186, 320, 14);
    x.fillStyle = '#fff'; x.font = 'bold 12px monospace'; x.fillText(m.mode, 130, 197);
  }
}

// RCL state from the common lmiState when s.mobile.rcl is missing (placeholder)
function lmiToState(s) {
  const l = s?.lmiState;
  return l === 'cut' || l === 'limit' ? 'stop' : l === 'warn' ? 'warn' : 'ok';
}

// steering program icon: top view of the 5 axles, front to the right
function progSvg(p) {
  const ang = { ROAD: [26, 18, 7, 0, -16], ALL: [28, 20, 8, -12, -30], CRAB: [15, 15, 15, 15, 15] }[p] || [0, 0, 0, 0, 0];
  const wheels = AXLES.map((ax, i) => [1.18, -1.18].map((y) =>
    `<rect x="${(ax - 0.62).toFixed(2)}" y="${(-y - 0.2).toFixed(2)}" width="1.24" height="0.4" rx="0.12" transform="rotate(${-ang[i]} ${ax} ${-y})"/>`).join('')).join('');
  return `<svg viewBox="-4.2 -2 12.6 4" width="60" height="19" aria-hidden="true"><rect x="-3.7" y="-1.375" width="11.45" height="2.75" rx="0.3" class="pg-body"/>${wheels}</svg>`;
}

// ================================================================== MobileHud
export class MobileHud {
  /**
   * @param {HTMLElement} layer  the HUD's game layer (.hud-game)
   * @param {object} host        the Hud (toast, cb.onPowerClick, _screen)
   */
  constructor(layer, host) {
    this.layer = layer;
    this.host = host;
    this._visible = false;
    this._hookVisible = true;
    this._userPage = null;
    this._userPageMode = null;
    this._mode = null;
    this._checklist = null;
    this._dlg = null; // {kind, ...}
    this._ballastOpen = false;
    this._sizes = new Map();
    this._flash = false;
    this._padPrev = [];
    this._build();
    this._bind();
  }

  // ------------------------------------------------------------- DOM
  _build() {
    const lamp = (k, t) => `<span class="lamp" data-k="${k}" data-s="off">${t}</span>`;
    const panel = document.createElement('aside');
    panel.className = 'lmi mhud';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'AT-100 operator display');
    panel.innerHTML = `
<div class="lmi-screen mhud-screen">
  <header class="lmi-head mh-head">
    <span class="lmi-brand mh-brand">AT-100 5.1</span>
    <nav class="mh-tabs" aria-label="Display page">
      <button type="button" class="mh-tab" data-page="road">ROAD</button><button type="button" class="mh-tab" data-page="setup">SETUP</button><button type="button" class="mh-tab" data-page="crane">CRANE</button>
    </nav>
    <button class="lmi-pwr mh-pwr" type="button" title="Crane power on / off (P)" data-s="off"><i class="led"></i><span class="pwr-text">PWR</span></button>
    <button class="lmi-collapse mh-collapse" type="button" aria-expanded="true" title="Collapse / expand">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
  </header>
  <div class="mh-banner" hidden></div>

  <section class="mp mp-road" data-page="road" hidden>
    <div class="rd-top">
      <div class="big rd-speed" data-s="ok"><label>SPEED</label><div class="bv"><b class="v-spd">0</b><small>km/h</small></div></div>
      <div class="rd-limit" title="Speed limit"><span class="v-limit">10</span></div>
      <div class="big rd-gear"><label>GEAR</label><div class="bv"><b class="v-gear">N</b></div></div>
    </div>
    <div class="rd-rpm"><label>RPM</label><div class="rpm-bar"><i class="rpm-band"></i><i class="rpm-fill"></i></div><b class="v-rpm">600</b></div>
    <div class="rd-row">
      <div class="rd-prog" title="Steering program (K)"><span class="v-progicon"></span><b class="v-prog">ROAD</b></div>
      <div class="rd-steer" title="Steering"><i class="steer-mark"></i></div>
    </div>
    <div class="m-lamps m-lamps-4">${lamp('pbrake', 'P-BRAKE')}${lamp('crawl', 'CRAWL')}${lamp('engine', 'ENGINE')}${lamp('reverse', 'REVERSE')}</div>
    <div class="rd-interlock" hidden></div>
    <div class="rd-guide" hidden>
      <div class="gd-arrow"><svg viewBox="-10 -10 20 20" width="30" height="30" aria-hidden="true"><path d="M0-8 6 4 0 1-6 4Z"/></svg></div>
      <div class="gd-body"><div class="gd-dist"><b class="v-gdist">0</b><small>m to P1</small></div><div class="gd-text"></div></div>
    </div>
  </section>

  <section class="mp mp-setup" data-page="setup" hidden>
    <div class="su-view"><canvas class="su-top" aria-label="Outrigger top view"></canvas></div>
    <div class="su-floats">
      <div class="fc" data-i="2"></div><div class="fc" data-i="0"></div>
      <div class="fc" data-i="3"></div><div class="fc" data-i="1"></div>
    </div>
    <div class="su-level">
      <canvas class="su-bubble" aria-label="Level"></canvas>
      <div class="su-lvtext">
        <div><label>PITCH</label><b class="v-pitch">+0.0°</b></div>
        <div><label>ROLL</label><b class="v-roll">+0.0°</b></div>
        <div class="su-auto"><label>AUTO-LEVEL</label><b class="v-auto">OFF</b></div>
      </div>
    </div>
    <div class="m-lamps m-lamps-3">${lamp('tyres', 'TYRES CLEAR')}${lamp('floats', 'FLOATS SET')}${lamp('pin', 'TT PIN')}${lamp('engine2', 'ENGINE')}${lamp('pbrake2', 'P-BRAKE')}${lamp('autolvl', 'AUTO-LVL')}</div>
    <div class="su-cw"><label>CW</label><span class="v-cw">—</span><div class="cw-prog" hidden><i></i></div></div>
  </section>

  <section class="mp mp-crane" data-page="crane" hidden>
    <div class="rc-code"><b class="v-code">—</b><span class="rc-conf" hidden>UNCONFIRMED</span></div>
    <div class="rc-bar lmi-moment" data-state="ok">
      <div class="mo-row"><label class="v-state">OK</label><span class="mo-val"><b class="v-util">0</b><small>%</small></span></div>
      <div class="mo-bar"><i class="mo-fill"></i><span class="mo-mark m90"><em>90</em></span><span class="mo-mark m100"><em>100</em></span></div>
    </div>
    <div class="lmi-big rc-big">
      <div class="big"><label>GROSS</label><div class="bv"><b class="v-gross">0.00</b><small>t</small></div><span class="sub v-net">net 0.00 t</span></div>
      <div class="big b-swl"><label>CAPACITY</label><div class="bv"><b class="v-cap">0.00</b><small>t</small></div><span class="sub v-block">BALL n1</span></div>
    </div>
    <div class="rc-grid">
      <div class="cell"><label>RADIUS</label><div class="cv"><b class="v-r">0.0</b><small>m</small></div></div>
      <div class="cell"><label>ANGLE θg</label><div class="cv"><b class="v-th">0.0</b><small>°</small></div></div>
      <div class="cell"><label>SLEW</label><div class="cv"><b class="v-slew">000</b><small>°</small></div><span class="sub v-sector">FRONT</span></div>
      <div class="cell rc-boom"><label>BOOM <span class="v-pin">PIN</span></label><div class="cv"><b class="v-L">11.5</b><small>m</small></div>
        <div class="secs"><i></i><i></i><i></i><i></i><i></i></div></div>
      <div class="cell"><label>HEAD</label><div class="cv"><b class="v-head">0.0</b><small>m</small></div></div>
      <div class="cell"><label>HOOK HT</label><div class="cv"><b class="v-hook">0.0</b><small>m</small></div></div>
      <div class="cell rc-wind" data-state="ok"><label>WIND · GUST / PERM</label><div class="cv"><b class="v-wind">0.0</b><small class="v-windsub">/ 0.0 · 14.3 m/s</small></div><span class="sub v-wload"></span></div>
      <div class="cell rc-rpm" data-state="ok"><label>SLEW RPM / REC</label><div class="cv"><b class="v-rpm2">0.00</b><small class="v-rec">/ 0.50</small></div></div>
      <div class="cell rc-hoist"><label>HOIST · LINE PULL</label><div class="cv"><b class="v-hs">0</b><small class="v-hsub">m/min · 0 / 88 kN</small></div></div>
    </div>
    <div class="rc-icons">
      ${STOP_ICONS.map(([k, t]) => `<span class="ic stop" data-k="${k}" data-s="off">${t}</span>`).join('')}
      ${WARN_ICONS.map(([k, t]) => `<span class="ic warn" data-k="${k}" data-s="off">${t}</span>`).join('')}
    </div>
    <div class="rc-extra"></div>
    <div class="rc-charts">
      <canvas class="rc-chart" aria-label="Chart column"></canvas>
      <canvas class="rc-side" aria-label="Working range"></canvas>
    </div>
    <div class="rc-lower">
      <div class="rc-supports"><div class="sp" data-i="0"><i></i><span>FL</span></div><div class="sp" data-i="1"><i></i><span>FR</span></div><div class="sp" data-i="2"><i></i><span>RL</span></div><div class="sp" data-i="3"><i></i><span>RR</span></div></div>
      <div class="levers" aria-hidden="true">
        <div class="lever lv-left"><i class="lv-cross"></i><i class="lv-dot"></i><span>SLW/TEL</span></div>
        <div class="lever lv-rightxy"><i class="lv-cross"></i><i class="lv-dot"></i><span>LUF/HST</span></div>
      </div>
    </div>
    <div class="lmi-load"><span class="ll-name">HOOK ONLY</span><span class="ll-chip ll-state" hidden></span></div>
  </section>

  <section class="mp-check" hidden><h4>SETUP CHECKLIST</h4><ul class="ck-list"></ul></section>
</div>
<div class="hookmon mhookmon"><span class="hm-label"><i></i>HOOK CAM</span></div>`;
    this.layer.appendChild(panel);

    const dlg = document.createElement('div');
    dlg.className = 'mdlg';
    dlg.hidden = true;
    dlg.innerHTML = `
<div class="mdlg-box" role="dialog" aria-modal="true" aria-labelledby="mdlg-title">
  <header class="mdlg-head"><div><div class="mdlg-kicker">AT-100 · RCL</div><h3 class="mdlg-title" id="mdlg-title">Configuration</h3></div><b class="mdlg-code"></b></header>
  <div class="mdlg-body"></div>
  <div class="mdlg-msg" hidden></div>
  <footer class="mdlg-foot"><button type="button" class="btn ghost" data-act="cancel">Cancel <kbd>Esc</kbd></button><button type="button" class="btn primary" data-act="ok">OK <kbd>Enter</kbd></button></footer>
</div>`;
    this.layer.appendChild(dlg);

    const bal = document.createElement('section');
    bal.className = 'mballast';
    bal.hidden = true;
    bal.setAttribute('aria-label', 'Counterweight');
    bal.innerHTML = `
<header class="mb-head"><span>COUNTERWEIGHT</span><button type="button" class="mb-x" aria-label="Close">×</button></header>
<div class="mb-slabs"></div>
<div class="mb-rows">
  <div><label>SUPERSTRUCTURE</label><b class="v-super">0.0 t</b></div>
  <div><label>DECK STACK</label><b class="v-deck">—</b></div>
  <div><label>TURNTABLE</label><b class="v-mbpin">FREE</b></div>
</div>
<div class="mb-prog" hidden><i></i><span></span></div>
<ol class="mb-steps">
  <li>Set the RCL for the counterweight <b>on the superstructure</b> (L).</li>
  <li>Land the slabs on the rear deck: boom over the rear, R ≈ 3.2 m, release (R).</li>
  <li>Slew to 0°, pin the turntable (T), then in SETUP hold <kbd>B</kbd> to raise (${BALLAST.raiseTime} s).</li>
  <li>Unpin and re-configure the RCL for the new counterweight.</li>
</ol>
<p class="mb-note" hidden>Quick ballast (training): instant, +${BALLAST.quickPenalty} s.</p>`;
    this.layer.appendChild(bal);

    const q = (s) => panel.querySelector(s);
    this.el = {
      panel, dlg, bal,
      brand: q('.mh-brand'), tabs: [...panel.querySelectorAll('.mh-tab')], pwr: q('.mh-pwr'), pwrText: q('.mh-pwr .pwr-text'),
      collapse: q('.mh-collapse'), banner: q('.mh-banner'),
      pages: { road: q('.mp-road'), setup: q('.mp-setup'), crane: q('.mp-crane') },
      // road
      spdCell: q('.rd-speed'), spd: q('.v-spd'), limit: q('.v-limit'), gear: q('.v-gear'), rpmFill: q('.rpm-fill'), rpm: q('.v-rpm'),
      progIcon: q('.v-progicon'), prog: q('.v-prog'), steerMark: q('.steer-mark'), interlock: q('.rd-interlock'),
      guide: q('.rd-guide'), gArrow: q('.gd-arrow svg'), gDist: q('.v-gdist'), gText: q('.gd-text'),
      // setup
      suTop: q('.su-top'), bubble: q('.su-bubble'), fcs: [...panel.querySelectorAll('.fc')], pitch: q('.v-pitch'), roll: q('.v-roll'),
      auto: q('.v-auto'), cw: q('.v-cw'), cwProg: q('.cw-prog'), cwProgFill: q('.cw-prog i'),
      // crane
      code: q('.v-code'), conf: q('.rc-conf'), bar: q('.rc-bar'), stateLbl: q('.v-state'), util: q('.v-util'), fill: q('.rc-bar .mo-fill'),
      gross: q('.v-gross'), net: q('.v-net'), cap: q('.v-cap'), blk: q('.v-block'),
      r: q('.v-r'), th: q('.v-th'), slew: q('.v-slew'), sector: q('.v-sector'), L: q('.v-L'), pin: q('.v-pin'), secs: [...panel.querySelectorAll('.secs i')],
      head: q('.v-head'), hook: q('.v-hook'), windCell: q('.rc-wind'), wind: q('.v-wind'), windSub: q('.v-windsub'), wLoad: q('.v-wload'),
      hs: q('.v-hs'), hsub: q('.v-hsub'), rpmCell: q('.rc-rpm'), rpm2: q('.v-rpm2'), rec: q('.v-rec'),
      icons: {}, extra: q('.rc-extra'), chart: q('.rc-chart'), side: q('.rc-side'),
      sps: [...panel.querySelectorAll('.rc-supports .sp')], lvL: q('.lv-left .lv-dot'), lvR: q('.lv-rightxy .lv-dot'),
      llName: q('.ll-name'), llState: q('.ll-state'),
      check: q('.mp-check'), checkList: q('.ck-list'),
      hookmon: panel.querySelector('.mhookmon'),
      // dialog
      dBox: dlg.querySelector('.mdlg-box'), dTitle: dlg.querySelector('.mdlg-title'), dKicker: dlg.querySelector('.mdlg-kicker'),
      dCode: dlg.querySelector('.mdlg-code'), dBody: dlg.querySelector('.mdlg-body'), dMsg: dlg.querySelector('.mdlg-msg'), dOk: dlg.querySelector('[data-act="ok"]'),
      // ballast
      bSlabs: bal.querySelector('.mb-slabs'), bSuper: bal.querySelector('.v-super'), bDeck: bal.querySelector('.v-deck'), bPin: bal.querySelector('.v-mbpin'),
      bProg: bal.querySelector('.mb-prog'), bProgFill: bal.querySelector('.mb-prog i'), bProgText: bal.querySelector('.mb-prog span'),
      bSteps: [...bal.querySelectorAll('.mb-steps li')], bNote: bal.querySelector('.mb-note'),
    };
    for (const n of panel.querySelectorAll('.ic')) this.el.icons[n.dataset.k] = n;
    this.lamps = {};
    for (const n of panel.querySelectorAll('.lamp')) this.lamps[n.dataset.k] = n;
    this.el.progIcon._prog = null;
  }

  _bind() {
    const E = this.el;
    E.tabs.forEach((b) => b.addEventListener('click', () => {
      const p = b.dataset.page;
      const auto = PAGE_OF[this._mode] || 'crane';
      this._userPage = p === auto ? null : p;
      this._userPageMode = this._mode;
      if (this._lastS) this.update(this._lastS);
      b.blur();
    }));
    E.pwr.addEventListener('click', () => {
      if (this.host?.cb?.onPowerClick) this.host.cb.onPowerClick();
      E.pwr.blur();
    });
    E.collapse.addEventListener('click', () => {
      const c = !E.panel.classList.contains('collapsed');
      E.panel.classList.toggle('collapsed', c);
      E.collapse.setAttribute('aria-expanded', String(!c));
      E.collapse.blur();
    });
    E.bal.querySelector('.mb-x').addEventListener('click', () => this.closeBallastPanel());
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) this._sizes.set(e.target, { w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) });
      });
      for (const c of [E.suTop, E.bubble, E.chart, E.side]) ro.observe(c);
    }
    // dialog: clicks
    E.dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act], [data-opt], [data-pick]');
      if (!b || !this._dlg) return;
      if (b.dataset.act === 'ok') this._dlgOk();
      else if (b.dataset.act === 'cancel') this._dlgCancel();
      else if (b.dataset.opt !== undefined) {
        const row = Number(b.dataset.row);
        this._dlg.row = row;
        this._cfgSet(row, b.dataset.opt);
      } else if (b.dataset.pick !== undefined) {
        this._dlg.row = Number(b.dataset.pick);
        this._renderReeving();
        if (e.detail >= 2) this._dlgOk(); // double-click / double-tap picks
      }
      b.blur();
    });
    // dialog: keyboard (capture phase: runs before input.js, which then never
    // sees these keys, so Enter / arrows cannot drive the crane)
    window.addEventListener('keydown', (e) => {
      if (!this._dlg || this.host?._screen) return;
      if (['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(e.code)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.repeat && !e.code.startsWith('Arrow')) return;
      this._dlgKey(e.code);
    }, true);
  }

  // ------------------------------------------------------------- visibility
  setVisible(on) {
    on = !!on;
    this._visible = on;
    setHidden(this.el.panel, !on);
    if (!on) { this.closeDialogs(); this.closeBallastPanel(); }
  }

  get page() {
    if (this._userPage && this._userPageMode === this._mode) return this._userPage;
    return PAGE_OF[this._mode] || 'crane';
  }

  get dialogOpen() { return !!this._dlg; }

  hookMonitorRect() {
    if (!this._visible || !this._hookVisible || this.page !== 'crane' || this.el.panel.classList.contains('collapsed')) return null;
    const r = this.el.hookmon.getBoundingClientRect();
    return r.width < 8 || r.height < 8 ? null : r;
  }

  setHookMonitorVisible(on) {
    this._hookVisible = !!on;
    setHidden(this.el.hookmon, !on || this.page !== 'crane');
  }

  /** Job setup checklist shown on the SETUP page ([{label, ok, value?}] or null = derived from the setup state). */
  setChecklist(items) { this._checklist = Array.isArray(items) ? items : null; }

  // ------------------------------------------------------------- per frame (≈15 Hz, from hud.update)
  update(s) {
    if (!s) return;
    this._lastS = s;
    const m = s.mobile || {};
    const E = this.el;
    const mode = m.mode || 'CRANE';
    if (mode !== this._mode) {
      this._mode = mode;
      this._userPage = null;
      if (mode === 'ROAD') this.closeBallastPanel();
    }
    this._flash = Math.floor(performance.now() / 300) % 2 === 0;
    const page = this.page;
    for (const [k, n] of Object.entries(E.pages)) setHidden(n, k !== page);
    for (const b of E.tabs) {
      setClass(b, 'on', b.dataset.page === page);
      setClass(b, 'auto', b.dataset.page === (PAGE_OF[mode] || 'crane'));
    }
    setClass(E.panel, 'tipping', mode === 'TIPPING' || mode === 'OVERTURNED');
    setText(E.brand, page === 'crane' ? 'AT-100 5.1 · RCL' : page === 'setup' ? 'AT-100 · OUTRIGGERS' : 'AT-100 · CARRIER');
    setData(E.pwr, 's', s.eStop ? 'estop' : s.power ? 'on' : 'off');
    setText(E.pwrText, s.eStop ? 'E-STOP' : 'PWR');
    setHidden(E.pwr, page !== 'crane');
    setHidden(E.hookmon, !this._hookVisible || page !== 'crane');
    this._banner(s, m, mode);

    if (!E.panel.classList.contains('collapsed') || page === 'crane') {
      if (page === 'road') this._road(s, m);
      else if (page === 'setup') this._setup(s, m);
      else this._crane(s, m);
    }
    this._renderChecklist(m, page);
    if (this._ballastOpen) this._updateBallast(m);
    if (this._dlg) this._pollPad();
  }

  _banner(s, m, mode) {
    const E = this.el;
    let text = '', kind = '';
    if (mode === 'OVERTURNED') { text = 'OVERTURNED'; kind = 'bad'; }
    else if (mode === 'TIPPING') { text = 'TIPPING — LOWER THE LOAD'; kind = 'bad'; }
    else if (m.rcl?.bypass) { text = 'RCL BYPASS ACTIVE — 15 % SPEED'; kind = 'bypass'; }
    else if (m.reeving) {
      const r = m.reeving;
      text = `RIGGERS RE-REEVING → ${blockDef(r.to).id.toUpperCase()} · ${Math.max(0, Math.ceil(num(r.total) - num(r.t)))} s`;
      kind = 'info';
    } else if (m.tip?.state === 'LIFTOFF') { text = 'FLOAT LIFTED'; kind = 'bad'; }
    setHidden(E.banner, !text);
    if (text) { setText(E.banner, text); setData(E.banner, 'k', kind); }
  }

  // ------------------------------------------------------------- ROAD page
  _road(s, m) {
    const E = this.el, L = this.lamps;
    const r = m.road || {};
    const spd = Math.abs(num(r.speedKmh));
    const lim = num(r.limitKmh, r.onSite === false ? SPEED_LIMITS.roadKmh : SPEED_LIMITS.siteKmh);
    setText(E.spd, String(Math.round(spd)));
    setData(E.spdCell, 's', spd > lim + 1 ? 'bad' : spd > lim ? 'warn' : 'ok');
    setText(E.limit, String(Math.round(lim)));
    const gear = fmtGear(r.gear);
    setText(E.gear, gear);
    const rpm = num(r.rpm, m.engineOn === false ? 0 : AT100.carrier.engine.idleRpm);
    setStyle(E.rpmFill, 'transform', `scaleX(${(clamp(rpm / 2200, 0, 1)).toFixed(3)})`);
    setText(E.rpm, String(Math.round(rpm)));
    const prog = r.program || 'ROAD';
    if (E.progIcon._prog !== prog) { E.progIcon._prog = prog; E.progIcon.innerHTML = progSvg(prog); }
    setText(E.prog, prog);
    setStyle(E.steerMark, 'left', `${(50 + 46 * clamp(num(r.steer), -1, 1)).toFixed(1)}%`);
    setData(L.pbrake, 's', r.parkingBrake ? 'bad' : 'off');
    setData(L.crawl, 's', r.crawl ? 'info' : 'off');
    setData(L.engine, 's', m.engineOn === false ? 'warn' : 'ok');
    setData(L.reverse, 's', gear.startsWith('R') ? 'warn' : 'off');
    setHidden(E.interlock, !r.interlock);
    if (r.interlock) setText(E.interlock, `TRAVEL INTERLOCK: ${r.interlock}`);
    const g = r.guidance;
    setHidden(E.guide, !g);
    if (g) {
      setText(E.gDist, String(Math.round(num(g.distance))));
      setText(E.gText, g.text || '');
      setStyle(E.gArrow, 'transform', `rotate(${Math.round(num(g.bearingDeg))}deg)`);
    }
  }

  // ------------------------------------------------------------- SETUP page
  _setup(s, m) {
    const E = this.el, L = this.lamps;
    const su = this._setupData(m);
    const top = this._ctx(E.suTop);
    if (top) { drawTopView(top.x, top.w, top.h, su, this._flash); }
    const lv = su.level || {};
    const bub = this._ctx(E.bubble);
    if (bub) drawBubble(bub.x, bub.w, bub.h, lv.pitchDeg, lv.rollDeg);
    const tilt = num(su.tiltDeg, Math.hypot(num(lv.pitchDeg), num(lv.rollDeg)));
    setText(E.pitch, `${sgn(num(lv.pitchDeg))}°`);
    setText(E.roll, `${sgn(num(lv.rollDeg))}°`);
    const lvState = tilt <= LEVEL.okDeg ? 'ok' : tilt <= LEVEL.warnDeg ? 'warn' : 'bad';
    setData(E.pitch, 's', lvState);
    setData(E.roll, 's', lvState);
    const al = su.autoLevel || 'off';
    setText(E.auto, al === 'active' ? 'LEVELLING…' : al === 'done' ? 'LEVEL' : al === 'range' ? 'RANGE EXCEEDED' : String(al).toUpperCase());
    setData(E.auto, 's', al === 'range' ? 'bad' : al === 'active' ? 'info' : al === 'done' ? 'ok' : 'off');
    // float cards (laid out like the top view: left floats on top, front to the right)
    for (const card of E.fcs) {
      const i = Number(card.dataset.i);
      const f = FLOATS[i];
      const bm = su.beams?.[i];
      const ext = typeof bm === 'number' ? bm : num(bm?.ext);
      const det = bm && typeof bm === 'object' ? bm.detent : null;
      const fl = su.floats?.[i] || {};
      const jk = su.jacks?.[i];
      const st = pressureState(fl);
      const sel = su.selected === i || su.selected === 4 || su.selected === 'all';
      const force = fl.forceKg !== undefined ? `${tFmt(fl.forceKg)} t` : '—';
      const pres = fl.pressureKPa !== undefined ? `${Math.round(fl.pressureKPa)}${fl.allowKPa ? `/${Math.round(fl.allowKPa)}` : ''} kPa` : '';
      const jack = jk ? `${Math.round(num(jk.e) * 1000)}/${Math.round(num(jk.max) * 1000)} mm` : '';
      const mat = fl.mat && fl.mat !== 'none' ? (fl.mat === 'composite' ? 'COMP MAT' : 'MAT') : 'NO MAT';
      const html = `<div class="fc-h"><b>${f.id}</b><span class="dl" data-s="${det !== null && det !== undefined ? 'ok' : 'warn'}"></span>${Math.round(ext * 100)}%${bm?.obstructed ? ' <em class="obs">OBSTRUCTED</em>' : ''}</div>`
        + `<div class="fc-f" data-s="${st}">${fl.contact ? force : 'no contact'}${fl.light ? ' · LIGHT' : ''}${fl.lifted ? ' · LIFTED' : ''}</div>`
        + `<div class="fc-p">${esc(pres)}</div><div class="fc-j">${esc(jack)} · ${mat}</div>`;
      if (card._html !== html) { card._html = html; card.innerHTML = html; }
      setClass(card, 'sel', sel);
    }
    setData(L.tyres, 's', su.tyresClear ? 'ok' : 'bad');
    setData(L.floats, 's', su.floatsSet ? 'ok' : 'off');
    setData(L.pin, 's', (su.pinned ?? m.pinned) ? 'on' : 'off');
    setData(L.engine2, 's', m.engineOn === false ? 'warn' : 'ok');
    setData(L.pbrake2, 's', m.road?.parkingBrake === false ? 'warn' : 'on');
    setData(L.autolvl, 's', al === 'active' ? 'info' : al === 'range' ? 'bad' : al === 'done' ? 'ok' : 'off');
    // counterweight line
    const b = m.ballast || {};
    const superKg = num(b.superKg, num(m.cwKg));
    const deck = (b.deckStack || []).map((id) => `${id} ${(num(CW_SLABS[id]?.massKg) / 1000).toFixed(1)} t`).join(' + ') || '—';
    setText(E.cw, `super ${(superKg / 1000).toFixed(1)} t · deck ${deck}`);
    setHidden(E.cwProg, !b.raising);
    if (b.raising) setStyle(E.cwProgFill, 'transform', `scaleX(${clamp(num(b.raising.progress), 0, 1).toFixed(3)})`);
  }

  // normalised setup data (falls back to the placeholder's flat fields)
  _setupData(m) {
    const su = m.setup || {};
    if (su.beams) return su;
    return { ...su, beams: (m.beams || [0, 0, 0, 0]).map((e) => ({ ext: e, detent: [0, 0.5, 1].includes(e) ? e * 100 : null })) };
  }

  // ------------------------------------------------------------- CRANE page
  _crane(s, m) {
    const E = this.el;
    const rcl = m.rcl || {};
    const boom = m.boom || {};
    const cfg = rcl.config || null;
    const state = rcl.state || lmiToState(s);
    const col = STATE_COL[state] || STATE_COL.ok;
    const blockId = m.hoist?.block || m.block || cfg?.block || 'ball';
    const bd = blockDef(blockId);
    const ratio = Math.max(0, num(rcl.ratio, num(s.ratio)));
    const capKg = num(rcl.capKg, num(s.capacity));
    const grossKg = num(rcl.grossKg, num(m.grossKg, num(s.payload) + bd.massKg));
    const netKg = num(rcl.netKg, Math.max(0, grossKg - (cfg ? blockDef(cfg.block).massKg : bd.massKg)));
    const L = num(boom.L, num(m.boomLen, PINNED_LENGTHS[0]));
    const k = boom.k === undefined ? PINNED_LENGTHS.indexOf(L) : boom.k;
    const R = num(boom.R, num(s.radius));

    setText(E.code, rcl.code || (cfg ? rclShortCode(cfg) : 'NO CONFIG'));
    setHidden(E.conf, !cfg || !!cfg.confirmed);
    setData(E.bar, 'state', state);
    E.bar.style.setProperty('--st', col);
    setText(E.stateLbl, STATE_TEXT[state] || String(state).toUpperCase());
    setText(E.util, String(Math.round(ratio * 100)));
    const f = Math.round((Math.min(ratio, 1.2) / 1.2) * 400) / 400;
    setStyle(E.fill, 'transform', `scaleX(${f})`);
    setText(E.gross, tFmt(grossKg));
    setText(E.net, `net ${tFmt(netKg)} t`);
    setText(E.cap, tFmt(capKg));
    setText(E.blk, `${bd.id.toUpperCase()} n${m.hoist?.falls ?? bd.falls} · ${(bd.ratedKg / 1000).toFixed(1)} t`);

    // geometry
    setText(E.r, R.toFixed(1));
    setText(E.th, num(boom.thetaGDeg, num(m.luffDeg)).toFixed(1));
    const slewDeg = ((Math.round(num(m.slewDeg, num(s.slewDeg))) % 360) + 360) % 360;
    setText(E.slew, String(slewDeg).padStart(3, '0'));
    setText(E.sector, sectorOf(slewDeg));
    setText(E.L, L.toFixed(1));
    const phase = boom.phase || (k === null || k < 0 ? 'moving' : 'pinned');
    setText(E.pin, phase === 'pinning' ? 'PINNING' : k === null || k < 0 || phase === 'moving' ? 'TELE' : 'PIN');
    setData(E.pin, 's', phase === 'pinned' && k !== null && k >= 0 ? 'ok' : 'warn');
    const secs = boom.sections || [0, 0, 0, 0, 0];
    E.secs.forEach((n, i) => {
      setText(n, String(Math.round(num(secs[i]) * 100)));
      setClass(n, 'act', boom.activeSection === i);
    });
    const headH = num(boom.headHeight, AT100.pivot.z + L * Math.sin(num(boom.thetaDeg, num(m.luffDeg)) * Math.PI / 180));
    setText(E.head, headH.toFixed(1));
    const hookH = num(boom.hookHeight, num(s.hookHeight));
    setText(E.hook, hookH.toFixed(1));

    // wind (head anemometer, 3-s gust vs permissible for this boom length)
    const w = m.wind || {};
    const head = num(w.head, num(s.wind));
    const gust = num(w.gust3s, num(s.gustPeak, head));
    const perm = num(w.perm, tableLookup(WIND_PERM, L));
    setText(E.wind, head.toFixed(1));
    setText(E.windSub, `/ ${gust.toFixed(1)} · ${perm.toFixed(1)} m/s`);
    setData(E.windCell, 'state', gust > perm ? 'alarm' : gust > 0.85 * perm ? 'warn' : 'ok');
    setText(E.wLoad, Number.isFinite(w.loadMax) ? `load max ${w.loadMax.toFixed(1)} m/s` : '');

    // hoist
    const h = m.hoist || {};
    const hs = num(h.speedMpm, num(s.hoistSpeed));
    setText(E.hs, `${Math.abs(hs) >= 0.5 ? (hs > 0 ? '↑' : '↓') : ''}${Math.round(Math.abs(hs))}`);
    const pull = num(h.linePullKN, (grossKg * 9.81 / 1000) / Math.max(1, h.falls ?? bd.falls));
    setText(E.hsub, `m/min · ${Math.round(pull)} / ${Math.round(AT100.hoist.linePullN / 1000)} kN`);

    // slew speed vs recommended under load (§3.2 [S15])
    const rpm = num(m.slewRpm, num(s.slewRpm));
    const rec = num(m.slewRecRpm, tableLookup(SLEW_REC_RPM, L));
    setText(E.rpm2, `${Math.abs(rpm) >= 0.005 ? (rpm > 0 ? 'R ' : 'L ') : ''}${Math.abs(rpm).toFixed(2)}`);
    setText(E.rec, `/ ${rec.toFixed(2)}`);
    const loaded = !!s.loadName && !s.grounded;
    setData(E.rpmCell, 'state', loaded && Math.abs(rpm) > rec ? 'warn' : 'ok');

    // STOP icons, warning triangles and any further RCL messages
    const stops = toSet(rcl.stops), warns = toSet(rcl.warnings);
    if (!rcl.stops && (state === 'stop')) stops.add('lmb');
    if (!rcl.stops && s.twoBlock && !m.stowed) stops.add('hookLimit');
    if (!rcl.warnings && Number.isFinite(gust) && gust > perm) warns.add('wind');
    for (const [id] of STOP_ICONS) setData(E.icons[id], 's', stops.has(id) ? (this._flash ? 'bad' : 'bad2') : 'off');
    for (const [id] of WARN_ICONS) setData(E.icons[id], 's', warns.has(id) ? 'warn' : 'off');
    const extra = [];
    for (const id of stops) if (!STOP_ICONS.some(([k2]) => k2 === id)) extra.push(['bad', RCL_LABELS[id] || String(id).toUpperCase()]);
    for (const id of warns) if (!WARN_ICONS.some(([k2]) => k2 === id)) extra.push(['warn', RCL_LABELS[id] || String(id).toUpperCase()]);
    if (!cfg?.confirmed && m.rcl) extra.unshift(['info', 'CONFIRM CONFIG (L)']);
    if (m.stowed) extra.push(['info', 'BLOCK STOWED — R TO RELEASE']);
    const ek = extra.map((e) => e.join(':')).join('|');
    if (E.extra._k !== ek) {
      E.extra._k = ek;
      E.extra.innerHTML = extra.map(([kd, t]) => `<span class="rc-msg" data-s="${kd}">${esc(t)}</span>`).join('');
    }

    // chart column + working-range side view
    const chartCells = m.chart?.cells || null;
    const ch = this._ctx(E.chart);
    if (ch) {
      drawMiniChart(ch.x, ch.w, ch.h, {
        cells: chartCells || [], R, grossKg, col,
        label: chartCells ? `L ${num(m.chart.L, L).toFixed(1)} m · ${cfg ? rclShortCode(cfg).split(' n')[0] : ''}` : 'CHART —',
      });
    }
    const sv = this._ctx(E.side);
    if (sv) {
      const rmin = Number.isFinite(k) && k >= 0 ? RMIN[k] : NaN;
      const rmax = chartCells && chartCells.length ? chartCells[chartCells.length - 1].R : NaN;
      const zone = m.zone;
      drawSideView(sv.x, sv.w, sv.h, {
        L, R, headH, hookH, lift: num(boom.lift), rmin, rmax, col,
        ceiling: zone ? (zone.inTowerZone ? num(zone.ceiling, TOWER_ZONE.ceiling) : 0) : 0,
      });
    }
    // support-force bars (float reactions)
    const sup = m.supportsKg || m.setup?.floats?.map((fl) => num(fl.forceKg));
    const maxKg = AT100.outriggers.maxFloatKg;
    E.sps.forEach((n, i) => {
      const kg = sup ? num(sup[i]) : 0;
      const bar = n.firstElementChild;
      setStyle(bar, 'transform', `scaleY(${clamp(kg / maxKg, 0, 1).toFixed(3)})`);
      const fl = m.setup?.floats?.[i];
      setData(n, 's', !sup ? 'off' : fl?.lifted ? 'bad' : fl?.light || kg < 2000 ? 'warn' : pressureState(fl) === 'bad' ? 'bad' : 'ok');
      n.title = sup ? `${FLOATS[i].id} ${tFmt(kg)} t` : FLOATS[i].id;
    });
    // lever indicators: left = slew (x) / tele (y); right = luff (x, left = up) / hoist (y)
    const lv = s.levers || {};
    const qz = (v) => Math.round(clamp(num(v), -1, 1) * 50) / 50;
    const lk = `${qz(lv.slew)},${qz(lv.tele ?? lv.trolley)}`;
    if (E.lvL._k !== lk) {
      E.lvL._k = lk;
      E.lvL.style.transform = `translate(${qz(lv.slew) * 15}px, ${-qz(lv.tele ?? lv.trolley) * 15}px)`;
      setClass(E.lvL, 'live', lk !== '0,0');
    }
    const rk = `${qz(lv.luff)},${qz(lv.hoist)}`;
    if (E.lvR._k !== rk) {
      E.lvR._k = rk;
      E.lvR.style.transform = `translate(${-qz(lv.luff) * 15}px, ${-qz(lv.hoist) * 15}px)`;
      setClass(E.lvR, 'live', rk !== '0,0');
    }
    // attached load
    setText(E.llName, s.loadName || (m.stowed ? 'BLOCK STOWED' : 'HOOK ONLY'));
    setHidden(E.llState, !s.loadName);
    if (s.loadName) {
      setText(E.llState, s.grounded ? 'LANDED' : 'SUSPENDED');
      setData(E.llState, 's', s.grounded ? 'info' : 'ok');
    }
  }

  _ctx(canvas) {
    const sz = this._sizes.get(canvas);
    let w = sz?.w, h = sz?.h;
    if (!w || !h) {
      if (typeof ResizeObserver !== 'undefined') return null; // not laid out yet / hidden
      w = canvas.clientWidth; h = canvas.clientHeight;
      if (!w || !h) return null;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.round(w * dpr), chh = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== chh) { canvas.width = cw; canvas.height = chh; }
    const x = canvas.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, cw, chh);
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { x, w, h };
  }

  // ------------------------------------------------------------- checklist
  _renderChecklist(m, page) {
    const E = this.el;
    let items = m.checklist || this._checklist;
    if (!items && page === 'setup') items = this._derivedChecklist(m);
    const show = !!items && items.length > 0 && (page === 'setup' || !!(m.checklist || this._checklist));
    setHidden(E.check, !show);
    if (!show) return;
    const html = items.map((it) => `<li data-ok="${it.ok ? 1 : 0}"><i>${it.ok ? '✓' : '✗'}</i>${esc(it.label)}${it.value ? `<em>${esc(it.value)}</em>` : ''}</li>`).join('');
    if (E.checkList._html !== html) { E.checkList._html = html; E.checkList.innerHTML = html; }
  }

  _derivedChecklist(m) {
    const su = this._setupData(m);
    const beams = su.beams || [];
    const det = beams.map((b) => (typeof b === 'object' ? b.detent : null));
    const floats = su.floats || [];
    const lv = su.level || {};
    const tilt = num(su.tiltDeg, Math.hypot(num(lv.pitchDeg), num(lv.rollDeg)));
    const items = [
      { label: 'Beams at a detent', ok: det.length === 4 && det.every((d) => d !== null && d !== undefined), value: det.map((d) => (d === null || d === undefined ? '–' : d)).join('/') },
    ];
    if (floats.length) items.push({ label: 'Mats under all floats', ok: floats.every((f) => f.mat && f.mat !== 'none') });
    items.push({ label: 'Floats set', ok: !!su.floatsSet });
    items.push({ label: 'Tyres clear', ok: !!su.tyresClear });
    items.push({ label: `Level ≤ ${LEVEL.okDeg}°`, ok: tilt <= LEVEL.okDeg, value: `${tilt.toFixed(1)}°` });
    return items;
  }

  // ------------------------------------------------------------- hints (hud.js chips)
  /** Context hints for the current mode: [[key, text, kind]]. */
  hints(s) {
    const m = s.mobile || {};
    const mode = m.mode || 'CRANE';
    const H = [];
    if (mode === 'OVERTURNED') return [['', 'Crane overturned — job over', 'bad']];
    if (mode === 'TIPPING') return [['↓', 'Tipping! Lower the load now', 'bad']];
    if (mode === 'ROAD') {
      const r = m.road || {};
      if (m.engineOn === false) H.push(['Space', 'start the engine', 'warn']);
      if (r.interlock) H.push(['', `Travel interlock: ${r.interlock}`, 'bad']);
      const stopped = Math.abs(num(r.speedKmh)) < 0.3;
      if (stopped && !r.parkingBrake) H.push(['F', 'parking brake', 'info']);
      if (stopped && r.parkingBrake) H.push(['Enter', 'set up here (outrigger remote)', 'good']);
      if (stopped && !r.parkingBrake) H.push(['X', 'gear D / R (standstill)', 'info']);
      if (!stopped) H.push(['K', `steering ${r.program || 'ROAD'} → ${r.program === 'ROAD' ? 'ALL' : r.program === 'ALL' ? 'CRAB' : 'ROAD'}`, 'info']);
      return H;
    }
    if (mode === 'SETUP') {
      const su = this._setupData(m);
      const lv = su.level || {};
      const tilt = num(su.tiltDeg, Math.hypot(num(lv.pitchDeg), num(lv.rollDeg)));
      H.push(['1–5', 'select float', 'info']);
      H.push(['A D', 'beam in / out', 'info']);
      H.push(['W S', 'jack down / up', 'info']);
      const anyMatMissing = (su.floats || []).some((f) => !f.contact && (!f.mat || f.mat === 'none'));
      if (anyMatMissing) H.push(['X', 'place mat', 'info']);
      if (su.floatsSet && tilt > LEVEL.okDeg) H.push(['G', 'hold to auto-level', 'warn']);
      if ((m.ballast?.deckStack || []).length) H.push(['B', 'hold to raise ballast (pinned)', 'info']);
      if (su.floatsSet && su.tyresClear && tilt <= LEVEL.okDeg) H.push(['Enter', 'enter the crane cab', 'good']);
      else H.push(['⌫', 'back to road mode', 'info']);
      return H;
    }
    // CRANE
    const rcl = m.rcl || {};
    const lv = s.levers || {};
    const neutral = ['slew', 'tele', 'luff', 'hoist'].every((k) => Math.abs(num(lv[k])) < 0.05);
    if (s.eStop) H.push(['Space', 'E-STOP active — press P to reset', 'bad']);
    else if (!s.power) H.push(['P', neutral ? 'power on' : 'levers to neutral, then power on', 'warn']);
    if (s.power && rcl.config && !rcl.config.confirmed) H.push(['L', 'confirm the RCL configuration', 'warn']);
    if (m.stowed) H.push(['R', 'release the hook block from the bumper', 'info']);
    if (m.turntablePinned && s.power) H.push(['T', 'unpin the turntable to slew', 'info']);
    if (s.attachable) H.push(['R', 'hook on', 'good']);
    if (s.canRelease) H.push(['R', 'release', 'good']);
    const stops = toSet(rcl.stops);
    if (rcl.state === 'stop' || stops.has('lmb')) H.push(['', 'RCL STOP — lower, luff up or telescope in', 'bad']);
    if (stops.has('hookLimit') || (s.twoBlock && !m.stowed)) H.push(['', 'Hook limit — hoist down', 'warn']);
    if (stops.has('teleLoad')) H.push(['', 'Tele load — land the load before telescoping', 'warn']);
    if (toSet(rcl.warnings).has('support')) H.push(['L', 'support ≠ config — check beams / RCL', 'warn']);
    if (s.power && neutral && !s.loadName && !m.stowed) H.push(['Enter', 'outrigger remote', 'info']);
    return H;
  }

  // ------------------------------------------------------------- dialogs
  /**
   * RCL configuration dialog (§5). cfg = {mode, base, cwKg, block, confirmed} pre-filled
   * (possibly wrong — the operator must enter the actual set-up). onOk(newCfg) → {ok, reason}
   * | boolean | void; ok === false keeps the dialog open showing the reason
   * ("CONFIG NOT PERMITTED"). opts: {permitted(cfg) → {ok, reason} (live check),
   * sensed:{beams:[4 × 0..1]} (beam sensors, shown as info), onCancel(), title}.
   */
  openConfigDialog(cfg, onOk, opts = {}) {
    const c = { mode: 'outriggers', base: 100, cwKg: 0, block: 'ball', ...(cfg || {}) };
    this._openDlg({ kind: 'config', cfg: c, onOk, opts, row: 0 });
    this.el.dKicker.textContent = 'AT-100 · RCL';
    this.el.dTitle.textContent = opts.title || 'Configuration';
    this._renderConfig();
  }

  /**
   * Reeving dialog (§1.4 / §6.6): cur = current block id; onPick(id) → {ok, reason} | boolean | void.
   * opts: {onCancel(), note}. Re-reeving time per block from reeveTime(cur, id).
   */
  openReevingDialog(cur, onPick, opts = {}) {
    const row = Math.max(0, HOOK_BLOCK_IDS.indexOf(cur));
    this._openDlg({ kind: 'reeve', cur, onPick, opts, row });
    this.el.dKicker.textContent = 'AT-100 · RIGGERS';
    this.el.dTitle.textContent = 'Reeving / hook block';
    this._renderReeving();
  }

  /**
   * Counterweight panel (non-modal, §6.6). state (= hudState().mobile.ballast plus optional
   * {rclCwKg, slewDeg}) seeds it; it then follows s.mobile.ballast on every update.
   */
  openBallastPanel(state = {}) {
    this._ballastOpen = true;
    this._ballastSeed = state || {};
    this._ballastMoved = false;
    setHidden(this.el.bal, false);
    this._updateBallast(this._lastS?.mobile || {});
  }

  closeBallastPanel() {
    this._ballastOpen = false;
    setHidden(this.el.bal, true);
  }

  closeDialogs() {
    if (!this._dlg) return;
    this._dlg = null;
    setHidden(this.el.dlg, true);
    if (document.body) delete document.body.dataset.hudModal;
  }

  _openDlg(d) {
    this._dlg = d;
    setHidden(this.el.dlg, false);
    setHidden(this.el.dMsg, true);
    document.body.dataset.hudModal = d.kind;
    this._padPrev = [];
    const pad = this._pad();
    if (pad) this._padPrev = pad.buttons.map((b) => !!b.pressed); // the press that opened it does not act
    requestAnimationFrame(() => { if (this._dlg === d) this.el.dOk.focus({ preventScroll: true }); });
  }

  _cfgRows(c) {
    return [
      { key: 'mode', label: 'Support', opts: [['outriggers', 'Outriggers'], ['tyres', 'On tyres']] },
      { key: 'base', label: 'Outrigger base', opts: [100, 50, 0].map((b) => [b, `${b} % · ${(2 * BASES[b]).toFixed(1)} m`]), off: c.mode === 'tyres' },
      { key: 'cwKg', label: 'Counterweight (superstructure)', opts: CW_CONFIGS.map((kg) => [kg, `${(kg / 1000).toFixed(1)} t`]) },
      { key: 'block', label: 'Hook block · falls', opts: HOOK_BLOCK_IDS.map((id) => [id, `${id === 'ball' ? 'Ball' : id.toUpperCase()} · n${HOOK_BLOCKS[id].falls}`]) },
    ];
  }

  _renderConfig() {
    const d = this._dlg, c = d.cfg, E = this.el;
    const rows = this._cfgRows(c);
    E.dCode.textContent = rclShortCode(c);
    const sensed = d.opts.sensed?.beams;
    E.dBody.innerHTML = rows.map((r, ri) => `
<div class="cfg-row${ri === d.row ? ' focus' : ''}${r.off ? ' off' : ''}">
  <span class="cfg-label">${esc(r.label)}</span>
  <div class="cfg-opts" role="radiogroup" aria-label="${esc(r.label)}">${r.opts.map(([v, t]) => `<button type="button" role="radio" data-row="${ri}" data-opt="${esc(v)}" aria-checked="${String(c[r.key]) === String(v)}"${r.off ? ' disabled' : ''}>${esc(t)}</button>`).join('')}</div>
</div>`).join('') + `
<p class="cfg-note">Enter the <b>actual</b> set-up. The RCL senses the beams but cannot check the counterweight or the reeving.${sensed ? ` Beams sensed: ${FLOATS.map((f, i) => `${f.id} ${Math.round(num(sensed[i]) * 100)}`).join(' · ')} %.` : ''}</p>`;
    // live pre-check (the RCL itself refuses on OK); any edit clears an old refusal
    const p = d.opts.permitted ? d.opts.permitted(c) : null;
    if (p && p.ok === false) this._msg(`NOT PERMITTED: ${p.reason || 'configuration not permitted'}`, 'warn');
    else setHidden(E.dMsg, true);
  }

  _cfgSet(row, raw) {
    const d = this._dlg;
    const r = this._cfgRows(d.cfg)[row];
    if (!r || r.off) return;
    const opt = r.opts.find(([v]) => String(v) === String(raw));
    if (!opt) return;
    d.cfg[r.key] = opt[0];
    if (r.key === 'mode' && opt[0] === 'tyres') d.cfg.base = 0; // on tyres the beams are in
    this._renderConfig();
  }

  _cfgStep(dir) {
    const d = this._dlg;
    const r = this._cfgRows(d.cfg)[d.row];
    if (!r || r.off) return;
    const i = r.opts.findIndex(([v]) => String(v) === String(d.cfg[r.key]));
    const n = clamp((i < 0 ? 0 : i) + dir, 0, r.opts.length - 1);
    this._cfgSet(d.row, r.opts[n][0]);
  }

  _renderReeving() {
    const d = this._dlg, E = this.el;
    E.dCode.textContent = `NOW ${blockDef(d.cur).id.toUpperCase()} · n${blockDef(d.cur).falls}`;
    E.dBody.innerHTML = `<div class="rv-list">${HOOK_BLOCK_IDS.map((id, i) => {
      const b = HOOK_BLOCKS[id];
      const cur = id === d.cur;
      return `<button type="button" class="rv-item${i === d.row ? ' focus' : ''}${cur ? ' cur' : ''}" data-pick="${i}">
  <span class="rv-k">${i + 1}</span><b>${esc(b.name)}</b><span>${b.falls} ${b.falls === 1 ? 'fall' : 'falls'}</span><span>${(b.ratedKg / 1000).toFixed(1)} t</span><span>${b.massKg} kg</span><span>${cur ? 'CURRENT' : `${reeveTime(d.cur, id)} s`}</span>
</button>`;
    }).join('')}</div><p class="cfg-note">Only with the block landed and no load on the hook. The riggers re-reeve; then confirm the RCL configuration.${d.opts.note ? ` ${esc(d.opts.note)}` : ''}</p>`;
  }

  _msg(text, kind = 'bad') {
    const E = this.el;
    E.dMsg.textContent = text;
    E.dMsg.dataset.k = kind;
    setHidden(E.dMsg, false);
    E.dBox.classList.remove('shake');
    void E.dBox.offsetWidth;
    if (kind === 'bad') E.dBox.classList.add('shake');
  }

  _dlgOk() {
    const d = this._dlg;
    if (!d) return;
    let res;
    if (d.kind === 'config') res = d.onOk ? d.onOk({ ...d.cfg, confirmed: true }) : true;
    else {
      const id = HOOK_BLOCK_IDS[d.row];
      if (id === d.cur) { this.closeDialogs(); return; }
      res = d.onPick ? d.onPick(id) : true;
    }
    if (res === false || (res && typeof res === 'object' && res.ok === false)) {
      this._msg(res && res.reason ? String(res.reason) : d.kind === 'config' ? 'CONFIG NOT PERMITTED' : 'Not possible now', 'bad');
      return;
    }
    if (this._dlg === d) this.closeDialogs();
  }

  _dlgCancel() {
    const d = this._dlg;
    this.closeDialogs();
    d?.opts?.onCancel?.();
  }

  _dlgKey(code) {
    const d = this._dlg;
    if (!d) return;
    if (code === 'Escape') { this._dlgCancel(); return; }
    if (code === 'Enter' || code === 'NumpadEnter') { this._dlgOk(); return; }
    if ((d.kind === 'config' && code === 'KeyL') || (d.kind === 'reeve' && code === 'KeyO')) { this._dlgCancel(); return; }
    if (d.kind === 'config') {
      const n = this._cfgRows(d.cfg).length;
      if (code === 'ArrowUp' || code === 'KeyW') { d.row = (d.row + n - 1) % n; this._renderConfig(); }
      else if (code === 'ArrowDown' || code === 'KeyS') { d.row = (d.row + 1) % n; this._renderConfig(); }
      else if (code === 'ArrowLeft' || code === 'KeyA') this._cfgStep(-1);
      else if (code === 'ArrowRight' || code === 'KeyD') this._cfgStep(1);
    } else {
      const n = HOOK_BLOCK_IDS.length;
      if (code === 'ArrowUp' || code === 'KeyW') { d.row = (d.row + n - 1) % n; this._renderReeving(); }
      else if (code === 'ArrowDown' || code === 'KeyS') { d.row = (d.row + 1) % n; this._renderReeving(); }
      else if (/^(Digit|Numpad)[1-4]$/.test(code)) { d.row = Number(code.slice(-1)) - 1; this._renderReeving(); this._dlgOk(); }
    }
  }

  _pad() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.from(pads || []).find((p) => p) || null;
  }

  // gamepad inside a dialog: D-pad navigates, A = OK, B = cancel (input.js stays neutral meanwhile)
  _pollPad() {
    const pad = this._pad();
    if (!pad) return;
    const map = { 0: 'Enter', 1: 'Escape', 12: 'ArrowUp', 13: 'ArrowDown', 14: 'ArrowLeft', 15: 'ArrowRight' };
    for (const [i, code] of Object.entries(map)) {
      const on = !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (on && !this._padPrev[i]) this._dlgKey(code);
      this._padPrev[i] = on;
      if (!this._dlg) break;
    }
  }

  // ------------------------------------------------------------- ballast panel
  _updateBallast(m) {
    const E = this.el;
    const b = { ...(this._ballastSeed || {}), ...(m.ballast || {}) };
    const superKg = num(b.superKg, num(m.cwKg));
    const deck = b.deckStack || [];
    const onSuper = CW_MAKEUP[superKg] || [];
    setText(E.bSuper, `${(superKg / 1000).toFixed(1)} t`);
    setText(E.bDeck, deck.length ? deck.map((id) => `${id} (${(num(CW_SLABS[id]?.massKg) / 1000).toFixed(1)} t)`).join(' + ') : '—');
    const pinned = b.pinned ?? m.setup?.pinned ?? m.pinned;
    setText(E.bPin, pinned ? 'PINNED' : 'FREE');
    setData(E.bPin, 's', pinned ? 'ok' : 'off');
    const slabs = ['A', 'B', 'C'].map((id) => {
      const where = onSuper.includes(id) ? 'super' : deck.includes(id) ? 'deck' : 'off';
      return `<span class="mb-slab" data-w="${where}"><b>${id}</b>${(CW_SLABS[id].massKg / 1000).toFixed(1)} t<small>${where === 'super' ? 'FRAME' : where === 'deck' ? 'DECK' : 'TRUCK'}</small></span>`;
    }).join('');
    if (E.bSlabs._html !== slabs) { E.bSlabs._html = slabs; E.bSlabs.innerHTML = slabs; }
    const r = b.raising;
    setHidden(E.bProg, !r);
    if (r) {
      setStyle(E.bProgFill, 'transform', `scaleX(${clamp(num(r.progress), 0, 1).toFixed(3)})`);
      setText(E.bProgText, `${r.dir < 0 ? 'LOWERING' : 'RAISING'} ${Math.round(num(r.progress) * 100)} %`);
    }
    setHidden(E.bNote, !b.quick);
    // current step of the §6.6 flow: slabs on the deck or moving → raise;
    // RCL ≠ superstructure CW → configure (step 1 before a raise, step 4 after)
    const rclCw = num(b.rclCwKg, num(m.rcl?.config?.cwKg, superKg));
    if (r) this._ballastMoved = true;
    const step = r || deck.length ? 2 : rclCw !== superKg ? (this._ballastMoved ? 3 : 0) : 1;
    E.bSteps.forEach((li, i) => { setClass(li, 'cur', i === step); setClass(li, 'done', i < step); });
  }

  // ------------------------------------------------------------- cab screen
  /** Same as the exported drawCabScreen (for callers holding the HUD instance). */
  drawCabScreen(ctx2d, s) { drawCabScreen(ctx2d, s); }
}
