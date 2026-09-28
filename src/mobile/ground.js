// Ground bearing, job zones and float settlement (spec §4.8). Pure data +
// math (node-testable). Allowable bearing pressures after the CICA / QLD code
// of practice table [S18]; ultimate = 2.5 × allowable [E].
//
//   groundAt(x, z)            → {kind, allowKPa, ultKPa} (shared objects, do not mutate)
//   addZone(rect, props)      job zones (checked first, last added wins) → zone handle
//   removeZone(zone), clearZones()
//   new Settlement()          per-float permanent settlement s[4] (m) and pressures
//     .update(dt, reactionsN[4], areas[4] m², positions[4] {x, z}) → events[]

import { GROUND } from './config.js';
import { SITE } from '../config.js';
import { ROAD, X_ROADS, Z_ROADS } from '../world/layout.js';

const ULT = GROUND.ultFactor;
const mk = (kind, allowKPa, ultKPa = allowKPa * ULT) => Object.freeze({ kind, allowKPa, ultKPa });
const P1 = GROUND.p1;
export const GROUND_KINDS = Object.freeze({
  hardcore: mk(P1.kind, P1.allowKPa), // P1 prepared hardcore 400 kPa
  fill: mk(GROUND.site.kind, GROUND.site.allowKPa), // compacted fill inside the fence 200 kPa
  asphalt: mk(GROUND.road.kind, GROUND.road.allowKPa), // carriageways 200 kPa
  lot: mk(GROUND.soft.kind, GROUND.soft.allowKPa), // lots / sidewalks / grass 100 kPa
});

const FENCE = SITE.fence;
const HALF_ROAD = ROAD.width / 2;
const zones = [];

// rect: {minX, maxX, minZ, maxZ} or an oriented {x, z, hx, hz, yaw} (three.js
// rotation.y convention, like collider Boxes). props: {kind, allowKPa, ultKPa?}.
export function addZone(rect, props) {
  const allow = props.allowKPa ?? GROUND.site.allowKPa;
  const z = { rect: { ...rect }, props: mk(props.kind || 'zone', allow, props.ultKPa ?? allow * ULT) };
  if (z.rect.hx !== undefined) {
    z.rect.c = Math.cos(z.rect.yaw || 0); z.rect.s = Math.sin(z.rect.yaw || 0);
  }
  zones.push(z);
  return z;
}
export function removeZone(zone) {
  const i = zones.indexOf(zone);
  if (i >= 0) zones.splice(i, 1);
}
export function clearZones() { zones.length = 0; }
export const zoneCount = () => zones.length;

function inZone(r, x, z) {
  if (r.hx === undefined) return x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ;
  // Box local axes (collide.js obbXZ): x' = dx·c − dz·s, z' = dx·s + dz·c
  const dx = x - r.x, dz = z - r.z;
  return Math.abs(dx * r.c - dz * r.s) <= r.hx && Math.abs(dx * r.s + dz * r.c) <= r.hz;
}

// Bearing capacity of the ground at world (x, z).
export function groundAt(x, z) {
  for (let i = zones.length - 1; i >= 0; i--) if (inZone(zones[i].rect, x, z)) return zones[i].props;
  if (x >= P1.minX && x <= P1.maxX && z >= P1.minZ && z <= P1.maxZ) return GROUND_KINDS.hardcore;
  if (x > FENCE.minX && x < FENCE.maxX && z > FENCE.minZ && z < FENCE.maxZ) return GROUND_KINDS.fill;
  for (const c of X_ROADS) if (Math.abs(z - c) <= HALF_ROAD) return GROUND_KINDS.asphalt;
  for (const c of Z_ROADS) if (Math.abs(x - c) <= HALF_ROAD) return GROUND_KINDS.asphalt;
  return GROUND_KINDS.lot;
}

// Float bearing pressure (kPa) from a reaction (N) and bearing area (m²).
export const pressureKPa = (reactionN, area) => (area > 0 ? Math.max(0, reactionN) / area / 1000 : 0);

// Per-float permanent settlement [E] (§4.8):
//   p ≤ allow:        no settlement
//   allow < p < ult:  ṡ = 0.004·(p/allow − 1) m/s
//   p ≥ ult:          punch-through, ṡ = 0.25 m/s until s ≥ 0.40 m or p < allow
// Settlement lowers the float's support height (outriggers.supports), so the
// carrier tilts: RCL tilt warning, capacity loss and possibly a tip.
export class Settlement {
  constructor() {
    this.s = [0, 0, 0, 0]; // m, FLOATS order FL, FR, RL, RR
    this.p = [0, 0, 0, 0]; // kPa (last step)
    this.allow = [0, 0, 0, 0]; // kPa at each float
    this.ult = [0, 0, 0, 0];
    this.kind = ['', '', '', ''];
    this.punching = [false, false, false, false];
    this.events = [];
    this.reset();
  }

  reset() {
    for (let i = 0; i < 4; i++) { this.s[i] = 0; this.p[i] = 0; this.punching[i] = false; }
    this.maxS = 0;
    this.punched = false; // any punch-through happened
    this._lvl = 0; // KPI level reached: 0, 20 mm, 50 mm
    this._crit = false;
    this.events.length = 0;
  }

  // ratio p/allow for the HUD colour (≤ 1 green, ≤ ult/allow amber, above red)
  ratio(i) { return this.allow[i] > 0 ? this.p[i] / this.allow[i] : 0; }

  /**
   * @param {number} dt
   * @param {number[]} reactionsN   float reactions (N), FLOATS order
   * @param {number[]} areas        bearing areas (m²): pad 0.242, carried mat 1.75, composite 3.24
   * @param {{x:number,z:number}[]} positions  float centres (world) for groundAt()
   * @returns {object[]} events: 'overPressure' {i, p, allow} (first time p > allow per loading),
   *   'settle' {mm: 20|50, s}, 'punch' {i, p}, 'punchStop' {i, s}, 'punchCritical' {i, s} (s ≥ 0.30 m)
   */
  update(dt, reactionsN, areas, positions) {
    const ev = this.events;
    ev.length = 0;
    for (let i = 0; i < 4; i++) {
      const pos = positions[i], gnd = groundAt(pos.x, pos.z);
      const p = pressureKPa(reactionsN[i], areas[i]);
      const was = this.p[i] > this.allow[i];
      this.p[i] = p; this.allow[i] = gnd.allowKPa; this.ult[i] = gnd.ultKPa; this.kind[i] = gnd.kind;
      if (p > gnd.allowKPa && !was) ev.push({ type: 'overPressure', i, p, allow: gnd.allowKPa });
      let rate = 0;
      if (this.punching[i]) {
        if (this.s[i] >= GROUND.punchMax || p < gnd.allowKPa) { this.punching[i] = false; ev.push({ type: 'punchStop', i, s: this.s[i] }); }
        else rate = GROUND.punchRate;
      } else if (p >= gnd.ultKPa && this.s[i] < GROUND.punchMax) {
        this.punching[i] = true; this.punched = true;
        ev.push({ type: 'punch', i, p });
        rate = GROUND.punchRate;
      } else if (p > gnd.allowKPa) {
        rate = GROUND.settleRate * (p / gnd.allowKPa - 1);
      }
      if (rate > 0) this.s[i] = Math.min(GROUND.punchMax, this.s[i] + rate * dt);
      if (this.s[i] > this.maxS) this.maxS = this.s[i];
      if (!this._crit && this.s[i] >= 0.30 && this.punched) { this._crit = true; ev.push({ type: 'punchCritical', i, s: this.s[i] }); }
    }
    if (this._lvl < 1 && this.maxS > 0.020) { this._lvl = 1; ev.push({ type: 'settle', mm: 20, s: this.maxS }); }
    if (this._lvl < 2 && this.maxS > 0.050) { this._lvl = 2; ev.push({ type: 'settle', mm: 50, s: this.maxS }); }
    return ev;
  }
}
