// AT-100 5.1 boom: single-cylinder pinned telescope (§3.4), luff-cylinder
// geometry (§3.3), head position (§3.1) and boom-contact sampling (§3.7).
// Pure module (no three.js).
//
// Telescope: base + 5 sections T1..T5 moved one at a time by ONE cylinder and
// locked by boom pins at 0 / 46 / 92 / 100 % of the 8.10 m stroke [S20]. The
// sequence is outer-first round-robin (46 % T5..T1, 92 % T5..T1, 100 % T5..T1),
// the best fit to the chart lengths [F]. A section only moves while it is
// unpinned and coupled to the cylinder; releasing the lever mid-stroke leaves
// the boom held by the cylinder (unpinned — the RCL shows "TELE / NOT PINNED"),
// and every stroke ends with a 4 s pin event with L frozen.

import { AT100, DRIVES, PINNED_LENGTHS, BOOM_CONTACT } from './config.js';

const B = AT100.boom;
const P = AT100.pivot;
const STROKE = B.stroke; // 8.1 m
const PINS = B.pins; // [0, 0.46, 0.92, 1.0]

// Extension sequence: SEQ[i] = {section (ext index: 0 = T1 … 4 = T5), from, to}.
// Completing SEQ[i] outward pins the boom at sequence position i + 1.
export const SEQ = (() => {
  const s = [];
  for (let stage = 1; stage < PINS.length; stage++) {
    for (let sec = B.nTele - 1; sec >= 0; sec--) s.push({ section: sec, from: PINS[stage - 1], to: PINS[stage] });
  }
  return Object.freeze(s.map(Object.freeze));
})(); // 15 entries

// Charted pinned configurations: k = 0..10 are the first 10 SEQ steps (all
// sections alike at 0 / 46 / 92 %, stepped T5 first); k = 11 is all at 100 %.
// Sequence positions 11..14 (some sections at 100 %, others at 92 %) are
// physically pinned but not charted: the RCL treats them as "between pins".
export const seqPosForK = (k) => (k <= 10 ? Math.max(0, Math.round(k)) : SEQ.length);
export const kForSeqPos = (p) => (p <= 10 ? p : p === SEQ.length ? 11 : null);

export function extForSeqPos(p, out = [0, 0, 0, 0, 0]) {
  out.fill(0);
  for (let i = 0; i < p && i < SEQ.length; i++) out[SEQ[i].section] = SEQ[i].to;
  return out;
}

export class TeleBoom {
  constructor(k = 0) {
    this.ext = [0, 0, 0, 0, 0]; // T1..T5, 0..1 of the stroke
    this.seqPos = 0; // completed SEQ steps while pinned (0..15)
    this.phase = 'pinned'; // 'pinned' | 'moving' | 'pinning'
    this.activeSection = -1; // ext index coupled to the cylinder, −1 when pinned
    this.entry = -1; // SEQ index being worked
    this.pinTimer = 0;
    this.pinTarget = 0;
    this.speed = 0; // cylinder speed m/s (+ = extending)
    this.cmd = 0; // command actually applied last update (−1..1, after perms)
    this.events = []; // 'unpinned' | 'pinning' | 'pinned' (cleared at each update)
    this.setPinned(k);
  }

  // Jump to charted pinned step k (0..11) — reset / job start.
  setPinned(k) {
    const kk = Math.max(0, Math.min(11, Math.round(k)));
    this.seqPos = seqPosForK(kk);
    extForSeqPos(this.seqPos, this.ext);
    this.phase = 'pinned';
    this.activeSection = -1;
    this.entry = -1;
    this.pinTimer = 0;
    this.speed = 0;
    this.cmd = 0;
    this.events.length = 0;
  }

  // Geometric length L = 11.5 + 8.1·Σext (chart labels are this rounded to 0.1 m).
  get length() {
    const e = this.ext;
    return B.baseLen + STROKE * (e[0] + e[1] + e[2] + e[3] + e[4]);
  }
  // Charted pinned column (0..11) or null (moving, pinning, held by the cylinder,
  // or pinned at an uncharted 92/100 % mix).
  get k() { return this.phase === 'pinned' ? kForSeqPos(this.seqPos) : null; }
  get pinned() { return this.phase === 'pinned'; }
  get chartLength() { const k = this.k; return k === null ? this.length : PINNED_LENGTHS[k]; }
  get percent() { return this.ext.map((e) => Math.round(e * 100)); }
  get atMin() { return this.phase === 'pinned' && this.seqPos === 0; }
  get atMax() { return this.phase === 'pinned' && this.seqPos === SEQ.length; }

  /**
   * @param {number} dt
   * @param {number} cmd  tele lever −1..1 (+ out), micro already applied
   * @param {number|{teleOut:number, teleIn:number}} [perm]  RCL permissions (lever multipliers)
   */
  update(dt, cmd, perm = 1) {
    this.events.length = 0;
    const pOut = typeof perm === 'number' ? perm : perm?.teleOut ?? 1;
    const pIn = typeof perm === 'number' ? perm : perm?.teleIn ?? 1;
    let u = cmd > 0 ? cmd * pOut : cmd < 0 ? cmd * pIn : 0;
    if (Math.abs(u) < 0.01) u = 0;
    this.cmd = u;

    if (this.phase === 'pinning') {
      // the pin completes even when the lever is released (§3.4)
      this.speed = 0;
      this.pinTimer -= dt;
      if (this.pinTimer <= 0) {
        this.seqPos = this.pinTarget;
        this.phase = 'pinned';
        this.activeSection = -1;
        this.entry = -1;
        this.pinTimer = 0;
        this.events.push('pinned');
      }
      return;
    }

    if (this.phase === 'pinned') {
      if (u > 0 && this.seqPos < SEQ.length) this.entry = this.seqPos;
      else if (u < 0 && this.seqPos > 0) this.entry = this.seqPos - 1;
      else { this.speed = 0; return; }
      this.phase = 'moving';
      this.activeSection = SEQ[this.entry].section;
      this.speed = 0;
      this.events.push('unpinned');
    }

    // 'moving': the cylinder drives the coupled section; hydraulic ramp 0.5 m/s² [E]
    const e = SEQ[this.entry], s = e.section;
    const target = u * DRIVES.tele.speed;
    const a = 0.5 * dt;
    this.speed = this.speed < target ? Math.min(this.speed + a, target) : Math.max(this.speed - a, target);
    if (u === 0 && Math.abs(this.speed) < 1e-4) this.speed = 0;
    this.ext[s] += (this.speed * dt) / STROKE;
    if (this.speed > 0 && this.ext[s] >= e.to - 1e-9) this.beginPin(e.to, this.entry + 1);
    else if (this.speed < 0 && this.ext[s] <= e.from + 1e-9) this.beginPin(e.from, this.entry);
  }

  beginPin(extValue, seqPos) {
    this.ext[this.activeSection] = extValue;
    this.speed = 0;
    this.phase = 'pinning';
    this.pinTarget = seqPos;
    this.pinTimer = DRIVES.tele.pinPause;
    this.events.push('pinning');
  }
}

// ------------------------------------------------------------ §3.3 luff cylinder
// Anchor A on the superstructure, attachment B 5.6 m along the boom and 0.6 m
// below its axis; the stroke ratio is > 1, so the model draws a 2-stage cylinder.
const A = AT100.luff.cylA, CB = AT100.luff.cylB;

// cylinder attachment B in S (u, z) for boom angle θ (frame-relative)
export function cylB(theta, out = { u: 0, z: 0 }) {
  const c = Math.cos(theta), s = Math.sin(theta);
  out.u = P.u + CB.along * c + CB.below * s;
  out.z = P.z + CB.along * s - CB.below * c;
  return out;
}
const _b = { u: 0, z: 0 };
// cylinder length c(θ) = |B(θ) − A| (m)
export function cylLen(theta) {
  cylB(theta, _b);
  return Math.hypot(_b.u - A.u, _b.z - A.z);
}
// dc/dθ by central difference (m/rad)
export function cylLenRate(theta, h = 1e-4) {
  return (cylLen(theta + h) - cylLen(theta - h)) / (2 * h);
}
// θ̇ = v_cyl / c′(θ): 0.132 m/s → 2.3°/s at 0°, 1.9°/s at 20–45°, 2.6°/s at 82°
export function luffRate(theta, vCyl) {
  return vCyl / cylLenRate(theta);
}

// ------------------------------------------------------------- §3.1 head sheave
// Head sheave in the superstructure frame S: u horizontal along the boom,
// z up (above the carrier-frame origin at ground level in road stance),
// y = lateral (left positive). dv = vertical (luff-plane) deflection, dl =
// lateral deflection, lift = z_f − 1.30 (frame datum above road stance).
export function headLocal(L, theta, dv = 0, dl = 0, lift = 0, out = { u: 0, z: 0, y: 0 }) {
  const c = Math.cos(theta), s = Math.sin(theta);
  out.u = P.u + L * c + dv * s;
  out.z = P.z + L * s - dv * c + lift;
  out.y = dl;
  return out;
}
// head radius from the slew axis without tilt: u_h
export const radiusFor = (L, theta, dv = 0) => P.u + L * Math.cos(theta) + dv * Math.sin(theta);
// boom angle for a head radius R (Newton on u_h(θ) = R; dv included)
export function thetaForRadius(L, R, dv = 0) {
  let th = Math.acos(Math.max(-1, Math.min(1, (R - P.u) / L)));
  for (let i = 0; i < 4; i++) {
    const f = radiusFor(L, th, dv) - R, df = -L * Math.sin(th) + dv * Math.cos(th);
    if (Math.abs(df) < 1e-9) break;
    th -= f / df;
  }
  return th;
}

// ----------------------------------------------------------- §3.7 boom contact
// Sample points on the boom axis every 1.0 m from the pivot to the head, in S
// (u, z, y) with the contact radius tapering 0.55 m → 0.35 m. Deflection uses
// the cantilever tip-load shape w(s) = δ·ξ²(3 − ξ)/2, ξ = s/L.
export function boomSamples(L, theta, dv = 0, dl = 0, lift = 0, out = []) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const n = Math.max(1, Math.ceil(L / BOOM_CONTACT.sample));
  out.length = n + 1;
  for (let i = 0; i <= n; i++) {
    const d = (L * i) / n, xi = d / L, w = (xi * xi * (3 - xi)) / 2;
    const p = out[i] || (out[i] = { u: 0, z: 0, y: 0, r: 0 });
    p.u = P.u + d * c + dv * w * s;
    p.z = P.z + d * s - dv * w * c + lift;
    p.y = dl * w;
    p.r = BOOM_CONTACT.rPivot + (BOOM_CONTACT.rHead - BOOM_CONTACT.rPivot) * xi;
  }
  return out;
}

// Test world points [{x, y, z, r}] against enabled collider boxes (point in the
// OBB inflated by r, in XZ plus the y range). ignore: Set (or array) of boxes to
// skip (the mobile's own colliders, the attached load). Returns
// {box, index, tag} of the first contact or null.
export function boomContact(world, points, ignore = null) {
  const boxes = world.boxes;
  const skip = ignore ? (ignore.has ? ignore : new Set(ignore)) : null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], r = p.r || 0;
    for (let j = 0; j < boxes.length; j++) {
      const b = boxes[j];
      if (!b.enabled || (skip && skip.has(b))) continue;
      if (p.y < b.cy - b.hy - r || p.y > b.cy + b.hy + r) continue;
      const dx = p.x - b.cx, dz = p.z - b.cz;
      // box local axes (three.js rotation.y): x̂ = (c, −s), ẑ = (s, c)
      const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      if (Math.abs(lx) <= b.hx + r && Math.abs(lz) <= b.hz + r) return { box: b, index: i, tag: b.tag };
    }
  }
  return null;
}
