import * as THREE from 'three';
import { X_ROADS, Z_ROADS } from '../layout.js';
import { rng } from '../../util/math.js';
import { LANE, STOP_LINE, HALF_ROAD, BUS_STOPS, blockEdges, siteBlocked, inCraneApproach, nearBusStop, weighted, ROAD_Y, prepObstacles, obstacleDist } from './common.js';
import { VehicleRenderer, VEHICLE_TYPES, TYPE_NAMES, PAINTS, BUS_PAINTS } from './vehicles.js';
import { key } from './signals.js';
import { LightPools } from './lights.js';

// Moving traffic on the roads around the site plus parked cars along the
// curbs. Lane graph: straight road lanes between junctions + turn connectors
// (quarter circles) inside each junction. Car following is the Intelligent
// Driver Model (Treiber 2000); drivers obey the signals (amber: stop if they
// comfortably can), yield inside junctions to vehicles on conflicting paths,
// let pedestrians clear the crossing before turning, never enter a junction
// they cannot leave, and left-turners wait for a gap in oncoming traffic.
// Buses pull in to serve the bus stops. Right-hand traffic.
//
// Obstacles (spec §7.1, the mobile crane on the approach): setObstacles(list)
// with yawed rectangles {x, z, hx, hz, yaw, vx?, vz?}. A vehicle treats any
// obstacle that intersects its lane corridor (lane centre ± 1.6 m) within 60 m
// ahead of its front bumper as a leader at the obstacle's near edge: stopped,
// or moving at the obstacle's speed along the lane when it drives away in the
// same direction. Nobody enters a junction whose exit is blocked. With no
// obstacles set, the step logic is exactly as before.
// vehicleBoxes(qx, qz, r, out) lists the OBBs of moving and parked cars near a
// point (collision tests by the crane's carrier).

const NET_X = [-176, -66, 104, 214]; // X roads (their z) with moving traffic
const NET_Z = [-210, -100, 110, 220]; // Z roads (their x) with moving traffic
const ARTERIAL = new Set(['x:-66', 'z:-100', 'z:110']);
const NODE_LIMIT = 400; // junctions further out are driven straight through (no signals)
const TERM = 452; // network entry / exit points
const IDM = { a: 1.5, b: 2.4, T: 1.25, s0: 2.3 };
const TURN_V = { straight: 13.5, right: 5.2, left: 6.8 };

class Lane {
  constructor(o) {
    Object.assign(this, o);
    this.vehs = []; // sorted by s, front-most first
    this.conns = [];
    this.occ = 0; // vehicles on / committed to this connector
    this.stops = [];
  }

  at(s, o) {
    if (this.arc) {
      const a = this.arc;
      const th = a.th0 + a.sweep * (s / this.len);
      const sg = a.sweep > 0 ? 1 : -1;
      o.x = a.cx + a.r * Math.cos(th);
      o.z = a.cz + a.r * Math.sin(th);
      o.hx = -Math.sin(th) * sg;
      o.hz = Math.cos(th) * sg;
    } else {
      o.x = this.x0 + this.dx * s;
      o.z = this.z0 + this.dz * s;
      o.hx = this.dx;
      o.hz = this.dz;
    }
    return o;
  }
}

function buildNetwork(signals) {
  const lanes = [];
  const incoming = new Map(); // node key → lanes ending there
  const outgoing = new Map();
  const push = (m, k, l) => { if (!m.has(k)) m.set(k, []); m.get(k).push(l); };
  const roads = [...NET_X.map((c) => ({ axis: 'x', c })), ...NET_Z.map((c) => ({ axis: 'z', c }))];
  for (const rd of roads) {
    const cross = (rd.axis === 'x' ? Z_ROADS : X_ROADS).filter((p) => Math.abs(p) <= NODE_LIMIT).sort((a, b) => a - b);
    const arterial = ARTERIAL.has(`${rd.axis}:${rd.c}`);
    for (const dir of [1, -1]) {
      const pts = dir > 0 ? [-TERM, ...cross, TERM] : [TERM, ...[...cross].reverse(), -TERM];
      const lat = (rd.axis === 'x' ? dir : -dir) * LANE;
      for (let i = 0; i < pts.length - 1; i++) {
        const first = i === 0, last = i + 1 === pts.length - 1;
        const t0 = pts[i] + dir * (first ? 0 : STOP_LINE);
        const t1 = pts[i + 1] - dir * (last ? 0 : STOP_LINE);
        const nodeXZ = (p) => (rd.axis === 'x' ? [p, rd.c] : [rd.c, p]);
        const l = new Lane({
          kind: 'road', axis: rd.axis, c: rd.c, dir, arterial, len: Math.abs(t1 - t0),
          x0: rd.axis === 'x' ? t0 : rd.c + lat, z0: rd.axis === 'x' ? rd.c + lat : t0,
          dx: rd.axis === 'x' ? dir : 0, dz: rd.axis === 'x' ? 0 : dir,
          t0, entry: first, exit: last, node: null,
        });
        if (!last) {
          const [x, z] = nodeXZ(pts[i + 1]);
          l.node = signals.get(x, z);
          l.nodeKey = key(x, z);
          push(incoming, l.nodeKey, l);
        }
        if (!first) push(outgoing, key(...nodeXZ(pts[i])), l);
        lanes.push(l);
      }
    }
  }
  // junction connectors
  const conns = [];
  for (const [k, ins] of incoming) {
    const outs = outgoing.get(k) || [];
    const local = [];
    for (const a of ins) {
      const P0 = { x: a.x0 + a.dx * a.len, z: a.z0 + a.dz * a.len };
      for (const b of outs) {
        const dot = a.dx * b.dx + a.dz * b.dz;
        if (dot < -0.5) continue; // no U-turns
        const P1 = { x: b.x0, z: b.z0 };
        const turn = dot > 0.5 ? 'straight' : (a.dx * b.dz - a.dz * b.dx > 0 ? 'right' : 'left');
        const c = new Lane({ kind: 'conn', turn, from: a, to: b, node: a.node, nodeKey: k, axis: a.axis });
        if (turn === 'straight') {
          Object.assign(c, { x0: P0.x, z0: P0.z, dx: a.dx, dz: a.dz, len: Math.hypot(P1.x - P0.x, P1.z - P0.z) });
        } else {
          const R = Math.hypot(P1.x - P0.x, P1.z - P0.z) / Math.SQRT2;
          const s = turn === 'right' ? 1 : -1;
          const cx = P0.x - a.dz * R * s, cz = P0.z + a.dx * R * s; // centre on the turning side
          const th0 = Math.atan2(P0.z - cz, P0.x - cx), th1 = Math.atan2(P1.z - cz, P1.x - cx);
          let sweep = th1 - th0;
          while (sweep > Math.PI) sweep -= 2 * Math.PI;
          while (sweep < -Math.PI) sweep += 2 * Math.PI;
          c.arc = { cx, cz, r: R, th0, sweep };
          c.len = Math.abs(sweep) * R;
        }
        // leg the connector leaves by (for pedestrian crossings)
        const leg = b.dx > 0.5 ? 'E' : b.dx < -0.5 ? 'W' : b.dz > 0.5 ? 'N' : 'S';
        c.crossKey = `${k}:${leg}`;
        c.vmax = TURN_V[turn];
        // turns only onto roads that exist in the network (all outs are network lanes)
        c.weight = (turn === 'straight' ? 0.62 : 0.19) * (b.arterial ? 1.7 : a.arterial ? 0.6 : 1);
        a.conns.push(c);
        local.push(c);
        conns.push(c);
      }
      // opposing incoming lane (for permitted left turns)
      a.opposing = ins.find((o) => o.dx === -a.dx && o.dz === -a.dz) || null;
    }
    // geometric conflicts between connectors of this junction
    const samples = local.map((c) => {
      const pts = [];
      const o = {};
      for (let s = 0; s <= c.len; s += 1) { c.at(s, o); pts.push([o.x, o.z]); }
      return pts;
    });
    for (let i = 0; i < local.length; i++) {
      local[i].conflicts = local[i].conflicts || [];
      for (let j = i + 1; j < local.length; j++) {
        if (local[i].from === local[j].from) continue;
        let hit = false;
        for (const p of samples[i]) {
          for (const q of samples[j]) {
            if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < 2.7 * 2.7) { hit = true; break; }
          }
          if (hit) break;
        }
        if (hit) {
          local[i].conflicts.push(local[j]);
          (local[j].conflicts = local[j].conflicts || []).push(local[i]);
        }
      }
    }
  }
  // bus stops on road lanes
  for (const bs of BUS_STOPS) {
    const l = lanes.find((q) => q.kind === 'road' && q.axis === bs.axis && q.c === bs.c && q.dir === bs.dir &&
      (bs.at - q.t0) * q.dir > 12 && (bs.at - q.t0) * q.dir < q.len - 14);
    if (l) l.stops.push({ s: (bs.at - l.t0) * l.dir, stop: bs });
  }
  return { lanes, conns, roadLanes: lanes };
}

// ------------------------------------------------------------------ vehicles
const TYPE_MIX = [['sedan', 30], ['hatch', 25], ['suv', 24], ['van', 11], ['truck', 5], ['bus', 5]];
function paintFor(r, type) {
  if (type === 'bus') return { color: BUS_PAINTS[Math.floor(r() * BUS_PAINTS.length)], metal: 0.15 };
  if ((type === 'van' && r() < 0.7) || (type === 'truck' && r() < 0.65)) return { color: new THREE.Color(0xe6e8e8), metal: 0 };
  const p = weighted(r, PAINTS.map((q) => [q, q.w]));
  return { color: p.color, metal: p.metal };
}

export function buildTraffic(root, quality, probe, signals, crossings, glow) {
  const r = rng(9151);
  const dens = quality.city ?? 1;
  const net = buildNetwork(signals);
  const roadLanes = net.lanes;
  const target = Math.round({ low: 60, medium: 120, high: 170, ultra: 230 }[quality.name] ?? 170);
  const maxBus = 6;

  // ---------------------------------------------------------------- parked cars
  const parked = [];
  const pr = rng(515);
  for (const e of blockEdges(quality.name === 'low' ? 150 : 260)) {
    if (e.axis === 'x' && e.c === -66 && e.side === 1) continue; // site frontage: construction zone, no parking
    let t = e.a + (e.junctionA ? 7 : 2) + pr() * 3;
    const end = e.b - (e.junctionB ? 7 : 2);
    while (t < end) {
      const type = weighted(pr, [['sedan', 36], ['hatch', 32], ['suv', 24], ['van', 8]]);
      const sp = VEHICLE_TYPES[type];
      const mid = t + sp.L / 2;
      if (mid + sp.L / 2 > end) break;
      const off = HALF_ROAD - 0.28 - sp.W / 2 + (pr() - 0.5) * 0.12;
      const [x, z] = e.axis === 'x' ? [mid, e.c + e.side * off] : [e.c + e.side * off, mid];
      const skip = nearBusStop(e.axis, e.c, e.side, mid, 20) || siteBlocked(x, z, 1.5) || pr() > 0.66 * Math.min(1, dens + 0.2);
      if (!skip) {
        // parked facing the direction of travel on that side of the road
        const dir = e.axis === 'x' ? e.side : -e.side;
        const hx = e.axis === 'x' ? dir : 0, hz = e.axis === 'x' ? 0 : dir;
        const p = paintFor(pr, type);
        const yaw = Math.atan2(-hz, hx) + (pr() - 0.5) * 0.03, odo = pr() * 10;
        // no parking along the mobile-crane approach (§7.1); tested after the
        // draws so every other parked car keeps its type / colour
        if (!inCraneApproach(x, z, 1.5)) parked.push({ type, x, z, yaw, color: p.color, metal: p.metal, odo });
      }
      t += sp.L + 0.9 + pr() * 1.8;
    }
  }

  // ---------------------------------------------------------------- moving vehicles
  const pool = [];
  const active = [];
  let busCount = 0;
  const cap = {};
  for (const t of TYPE_NAMES) cap[t] = 0;
  for (const p of parked) cap[p.type]++;
  const moverCap = { sedan: target, hatch: target, suv: target, van: Math.ceil(target * 0.4), truck: Math.ceil(target * 0.25), bus: maxBus };
  for (const t of TYPE_NAMES) cap[t] += moverCap[t];
  const renderer = new VehicleRenderer(root, cap, { shadows: quality.name !== 'low' });

  const entries = roadLanes.filter((l) => l.entry);
  const entryW = entries.map((l) => [l, l.arterial ? 3 : 1]);

  function newVehicle() {
    let type = weighted(r, TYPE_MIX);
    if (type === 'bus' && busCount >= maxBus) type = 'sedan';
    const counts = active.reduce((m, v) => { m[v.type] = (m[v.type] || 0) + 1; return m; }, {});
    if ((counts[type] || 0) >= moverCap[type]) type = 'sedan';
    const sp = VEHICLE_TYPES[type];
    const p = paintFor(r, type);
    return {
      type, len: sp.L, halfLen: sp.L / 2, color: p.color, metal: p.metal,
      v0: (type === 'bus' || type === 'truck' ? 11.5 : 13.9) * (0.88 + r() * 0.22),
      lane: null, s: 0, v: 0, acc: 0, odo: r() * 10, brake: 0, route: [], committed: null,
      lat: 0, dwell: 0, served: null, x: 0, z: 0, hx: 1, hz: 0,
    };
  }

  function planNext(v) {
    const l = v.lane;
    v.route.length = 0;
    if (l.kind !== 'road' || l.exit || !l.conns.length) return;
    const c = weighted(r, l.conns.map((q) => [q, q.weight]));
    v.route.push(c, c.to);
  }

  function insertSorted(lane, v) {
    const a = lane.vehs;
    let i = a.length;
    while (i > 0 && a[i - 1].s < v.s) i--;
    a.splice(i, 0, v);
  }

  function place(v, lane, s, speed) {
    v.lane = lane;
    v.s = s;
    v.v = speed;
    v.committed = null;
    insertSorted(lane, v);
    planNext(v);
    if (v.type === 'bus') busCount++;
    active.push(v);
  }

  // initial population spread over the road lanes (so the city starts busy)
  {
    const total = roadLanes.reduce((s, l) => s + l.len * (l.arterial ? 2.2 : 1), 0);
    for (const l of roadLanes) {
      const n = Math.round(target * 0.85 * (l.len * (l.arterial ? 2.2 : 1)) / total);
      const used = [];
      for (let k = 0; k < n * 3 && used.length < n; k++) {
        const v = newVehicle();
        const s = v.halfLen + r() * (l.len - v.len);
        if (s < v.halfLen || used.some((q) => Math.abs(q.s - s) < (q.halfLen + v.halfLen + 6))) continue;
        v.s = s;
        used.push(v);
      }
      used.sort((a, b) => b.s - a.s);
      for (const v of used) place(v, l, v.s, 7 + r() * 5);
    }
  }

  function trySpawn() {
    const l = weighted(r, entryW);
    const lastV = l.vehs[l.vehs.length - 1];
    if (lastV && lastV.s - lastV.halfLen < 24) return; // room for a bus + gap
    const v = pool.pop() || newVehicle();
    Object.assign(v, newVehicle()); // re-roll type / colour so recycled vehicles vary
    place(v, l, v.halfLen, 9 + r() * 3);
  }

  function despawn(v) {
    const i = active.indexOf(v);
    if (i >= 0) active.splice(i, 1);
    if (v.type === 'bus') busCount--;
    if (v.committed) { v.committed.occ--; v.committed = null; }
    pool.push(v);
  }

  // IDM acceleration towards an obstacle at `gap` moving at `vl`
  const idm = (v, gap, vl, v0) => {
    const dv = v.v - vl;
    const sStar = IDM.s0 + Math.max(0, v.v * IDM.T + (v.v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
    const free = 1 - Math.pow(v.v / v0, 4);
    if (gap <= 0.05) return -9;
    return IDM.a * (free - (sStar / gap) ** 2);
  };

  function mayEnter(v, c, dStop) {
    const st = c.node ? signals.state(c.node, c.from.axis) : 0;
    // a left-turner waiting at the line clears during amber / all-red (oncoming traffic is stopping)
    const clearing = c.turn === 'left' && c.node && dStop < 1.5 && v.v < 1 && signals.clearance(c.node, c.from.axis);
    if (st === 2 && !clearing) return false;
    if (st === 1 && !clearing && dStop > (v.v * v.v) / (2 * 3.5) + 1.5) return false;
    for (const k of c.conflicts) if (k.occ > 0) return false;
    // space to leave the junction
    const out = c.to.vehs[c.to.vehs.length - 1];
    if (out && out.s - out.halfLen < v.len + 3) return false;
    if (nObs && exitBlocked(c, v.len + 3)) return false;
    if (c.turn !== 'straight' && (crossings.get(c.crossKey) || 0) > 0) return false;
    if (c.turn === 'left' && c.from.opposing && !clearing) {
      for (const w of c.from.opposing.vehs) {
        const d = c.from.opposing.len - (w.s + w.halfLen);
        if (d > 45) break;
        if (w.committed) continue; // committed ones hold a reservation (checked above)
        if (w.v > 1.5 && d / w.v < 5.5) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- obstacles (§7.1)
  const CORRIDOR = 1.6, AHEAD = 60;
  const obs = []; // prepared obstacles (common.js prepObstacles)
  let nObs = 0, obsList = null;
  const pa = {}, pb = {};
  // point d metres ahead of `front` (lane param) along the vehicle's lane and planned route
  function pointAhead(v, front, d, o) {
    let l = v.lane, s = front + d, k = 0;
    while (s > l.len && k < v.route.length) { s -= l.len; l = v.route[k++]; }
    return l.at(Math.min(s, l.len), o);
  }
  function hitAt(v, front, d) {
    pointAhead(v, front, d, pb);
    for (let k = 0; k < nObs; k++) if (obstacleDist(obs[k], pb.x, pb.z) <= CORRIDOR) return k;
    return -1;
  }
  // nearest obstacle in the corridor ahead → {gap, vl} (reused object) or null
  const lead = { gap: 0, vl: 0 };
  function obstacleLeader(v, front) {
    v.lane.at(Math.min(v.s, v.lane.len), pa);
    let near = false;
    for (let k = 0; k < nObs && !near; k++) near = Math.hypot(pa.x - obs[k].x, pa.z - obs[k].z) < AHEAD + obs[k].r + v.halfLen + CORRIDOR;
    if (!near) return null;
    let prev = 0;
    for (let d = 0; d <= AHEAD; d += 1) {
      let k = hitAt(v, front, d);
      if (k < 0) { prev = d; continue; }
      let gap = 0.05;
      if (d > 0) { // refine the near edge
        let lo = prev, hi = d;
        for (let it = 0; it < 5; it++) {
          const mid = (lo + hi) / 2, km = hitAt(v, front, mid);
          if (km >= 0) { hi = mid; k = km; } else lo = mid;
        }
        gap = Math.max(0.05, hi);
      }
      // leader speed: the obstacle's velocity along our heading at the contact (never negative)
      pointAhead(v, front, gap, pb);
      lead.gap = gap;
      lead.vl = Math.max(0, obs[k].vx * pb.hx + obs[k].vz * pb.hz);
      return lead;
    }
    return null;
  }
  // a junction connector (plus room on its exit lane) crosses an obstacle
  function exitBlocked(c, room) {
    const P0 = c.at(0, pa);
    let near = false;
    for (let k = 0; k < nObs && !near; k++) near = Math.hypot(P0.x - obs[k].x, P0.z - obs[k].z) < c.len + room + obs[k].r + CORRIDOR;
    if (!near) return false;
    const total = c.len + room;
    for (let d = 0; d <= total; d += 1) {
      const o = d <= c.len ? c.at(d, pb) : c.to.at(Math.min(d - c.len, c.to.len), pb);
      for (let k = 0; k < nObs; k++) if (obstacleDist(obs[k], o.x, o.z) <= CORRIDOR) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- car boxes
  const boxPool = [];
  const heightOf = (type) => { const sp = VEHICLE_TYPES[type]; return sp.boxBody?.y1 ?? sp.roofY ?? 1.6; };
  function fillBox(k, x, z, yaw, type, vx, vz, parkedCar, id) {
    const sp = VEHICLE_TYPES[type];
    const b = boxPool[k] || (boxPool[k] = {});
    b.x = b.cx = x; b.z = b.cz = z; b.yaw = yaw; b.c = Math.cos(yaw); b.s = Math.sin(yaw);
    b.hx = sp.L / 2; b.hz = sp.W / 2; b.r = Math.hypot(b.hx, b.hz);
    b.y = ROAD_Y; b.h = heightOf(type); b.vx = vx; b.vz = vz; b.type = type; b.parked = parkedCar; b.id = id;
    return b;
  }

  const tmp = {};
  function step(dt) {
    for (let i = active.length - 1; i >= 0; i--) {
      const v = active[i];
      const l = v.lane;
      const idx = l.vehs.indexOf(v);
      const front = v.s + v.halfLen;
      let v0 = v.v0;
      if (l.kind === 'conn') v0 = Math.min(v0, l.vmax);
      let acc = IDM.a * (1 - Math.pow(v.v / v0, 4));
      // leader
      let gap = Infinity, vl = 0;
      if (idx > 0) {
        const q = l.vehs[idx - 1];
        gap = q.s - q.halfLen - front; vl = q.v;
      } else {
        let dist = l.len - front;
        for (const nl of v.route) {
          if (dist > 90) break;
          if (nl.vehs.length) {
            const q = nl.vehs[nl.vehs.length - 1];
            gap = dist + q.s - q.halfLen; vl = q.v;
            break;
          }
          dist += nl.len;
        }
      }
      if (gap < Infinity) acc = Math.min(acc, idm(v, gap, vl, v0));
      if (nObs) {
        const ob = obstacleLeader(v, front);
        if (ob) acc = Math.min(acc, idm(v, ob.gap, ob.vl, v0));
      }
      if (l.kind === 'road' && !l.exit) {
        const dStop = l.len - front - 0.8;
        const c = v.route[0];
        // slow down ahead of a turn
        if (c && c.turn !== 'straight' && dStop < 35) acc = Math.min(acc, idm(v, dStop + 25, c.vmax, v0));
        if (c && !v.committed && dStop < 60) {
          if (mayEnter(v, c, dStop)) {
            if (dStop < Math.max(4, v.v * 1.6)) { v.committed = c; c.occ++; }
          } else acc = Math.min(acc, idm(v, Math.max(0.01, dStop), 0, v0));
        }
      }
      // bus stops
      if (v.type === 'bus') {
        let target = 0;
        for (const st of l.stops) {
          const d = st.s - v.s;
          if (v.served === st.stop || d < -2) continue;
          if (d < 28) target = Math.min(1, (28 - d) / 18) * 1.25;
          if (d < 0.4 && v.v < 0.3) {
            v.dwell += dt;
            if (v.dwell > 14) { v.served = st.stop; v.dwell = 0; }
            acc = Math.min(acc, -3);
          } else acc = Math.min(acc, idm(v, Math.max(0.01, d), 0, v0));
        }
        v.lat += (target - v.lat) * Math.min(1, dt * 0.6);
      }
      acc = Math.max(-9, Math.min(IDM.a, acc));
      v.acc = acc;
      v.v = Math.max(0, v.v + acc * dt);
      const ds = v.v * dt;
      v.s += ds;
      v.odo += ds;
      v.brake = acc < -0.6 || v.v < 0.3 ? 1 : 0;
    }
    // lane transitions (front-most vehicles first keeps ordering)
    for (let i = active.length - 1; i >= 0; i--) {
      const v = active[i];
      while (v.s > v.lane.len) {
        const l = v.lane;
        if (l.exit || !v.route.length) { l.vehs.splice(l.vehs.indexOf(v), 1); despawn(v); break; }
        const next = v.route.shift();
        v.s -= l.len;
        l.vehs.splice(l.vehs.indexOf(v), 1);
        if (l.kind === 'conn' && v.committed === l) { l.occ--; v.committed = null; }
        if (next.kind === 'conn' && v.committed !== next) { v.committed = next; next.occ++; }
        v.lane = next;
        insertSorted(next, v);
        if (next.kind === 'road') { v.served = v.served && next.stops.some((s) => s.stop === v.served) ? v.served : null; planNext(v); }
      }
    }
  }

  // dipped-beam pools on the road ahead of moving vehicles near the camera (night)
  const beams = new LightPools(root, 160);
  const beamTint = [1.0 * 0.07, 0.93 * 0.07, 0.8 * 0.07]; // lamp colour × asphalt albedo

  let spawnT = 0;
  const up = new THREE.Vector3();
  return {
    renderer, parked, active, net,
    /** @param {{x:number,z:number,hx:number,hz:number,yaw:number,vx?:number,vz?:number}[]} list  (kept by reference, re-read every frame) */
    setObstacles(list) { obsList = list; },
    /**
     * Remove moving vehicles overlapping a rectangle {x, z, hx, hz, yaw} grown by
     * `pad` (e.g. where the mobile crane is placed on the road at a job start, so
     * nobody ends up inside it). Parked cars are untouched. Returns the count.
     */
    clearArea(box, pad = 1.5) {
      const tmpObs = [];
      if (!prepObstacles([box], tmpObs)) return 0;
      const o = tmpObs[0];
      let n = 0;
      for (let i = active.length - 1; i >= 0; i--) {
        const v = active[i];
        v.lane.at(Math.min(v.s, v.lane.len), pa);
        const w = VEHICLE_TYPES[v.type].W / 2 + pad;
        let hit = false;
        for (const f of [-1, -0.5, 0, 0.5, 1]) {
          if (obstacleDist(o, pa.x + pa.hx * v.halfLen * f, pa.z + pa.hz * v.halfLen * f) <= w) { hit = true; break; }
        }
        if (!hit) continue;
        v.lane.vehs.splice(v.lane.vehs.indexOf(v), 1);
        despawn(v);
        n++;
      }
      return n;
    },
    get obstacles() { return obs.slice(0, nObs); },
    /** OBBs {x, z, cx, cz, hx, hz, yaw, c, s, r, y, h, vx, vz, type, parked, id} of cars within r of (qx, qz); fills and returns `out` (pooled objects) */
    vehicleBoxes(qx, qz, r = 20, out = []) {
      out.length = 0;
      let k = 0;
      for (const v of active) {
        v.lane.at(v.s, pa);
        const x = pa.x - pa.hz * v.lat, z = pa.z + pa.hx * v.lat;
        if (Math.hypot(x - qx, z - qz) > r + v.halfLen) continue;
        out.push(fillBox(k++, x, z, Math.atan2(-pa.hz, pa.hx), v.type, pa.hx * v.v, pa.hz * v.v, false, v));
      }
      for (const p of parked) {
        if (Math.hypot(p.x - qx, p.z - qz) > r + 6) continue;
        out.push(fillBox(k++, p.x, p.z, p.yaw, p.type, 0, 0, true, p));
      }
      return out;
    },
    update(dt, night) {
      dt = Math.min(dt, 0.1);
      nObs = prepObstacles(obsList, obs);
      const n = dt > 0.05 ? 2 : 1;
      for (let k = 0; k < n; k++) step(dt / n);
      spawnT -= dt;
      if (spawnT <= 0 && active.length < target) { trySpawn(); spawnT = 0.35; }

      const cam = probe.pos;
      renderer.begin();
      const lightsOn = night > 0.12 ? 1 : 0.35; // DRLs in the day, dipped beams after dusk
      for (const v of active) {
        v.lane.at(v.s, tmp);
        // bus pull-in: shift towards the right-hand curb
        const x = tmp.x - tmp.hz * v.lat, z = tmp.z + tmp.hx * v.lat;
        v.x = x; v.z = z; v.hx = tmp.hx; v.hz = tmp.hz;
        const d = Math.hypot(x - cam.x, z - cam.z, cam.y);
        if (d > 900) continue;
        renderer.push(v.type, x, z, Math.atan2(-tmp.hz, tmp.hx), v.color, v.metal, v.odo, v.brake, lightsOn, d);
      }
      for (const p of parked) {
        const d = Math.hypot(p.x - cam.x, p.z - cam.z, cam.y);
        if (d > 700) continue;
        renderer.push(p.type, p.x, p.z, p.yaw, p.color, p.metal, p.odo, 0, 0, d);
      }
      renderer.end();
      renderer.setNight(night);
      beams.begin();
      if (night > 0.15) {
        for (const v of active) {
          if (beams.count >= beams.capacity) break;
          const d = Math.hypot(v.x - cam.x, v.z - cam.z);
          if (d > 220) continue;
          const sp = VEHICLE_TYPES[v.type];
          const f = sp.L / 2;
          // pool centred ~9 m ahead, brightest just in front of the bumper
          beams.addOriented(v.x + v.hx * (f + 9), ROAD_Y + 0.025, v.z + v.hz * (f + 9), 18, 5.2,
            v.x + v.hx * (f + 3.5), v.z + v.hz * (f + 3.5), v.hx, v.hz, 13, 2.8, beamTint);
        }
      }
      beams.finish();
      beams.setNight(night, 2.4);
      if (glow && night > 0.05) {
        for (const v of active) {
          const sp = VEHICLE_TYPES[v.type];
          const fx = v.hx * sp.L * 0.5, fz = v.hz * sp.L * 0.5;
          const sx = -v.hz * sp.W * 0.36, sz = v.hx * sp.W * 0.36;
          const hy = v.type === 'bus' || v.type === 'truck' ? 0.85 : 0.68;
          for (const s of [1, -1]) {
            glow.push(v.x + fx + sx * s, ROAD_Y + hy, v.z + fz + sz * s, 1.0, 0.92, 0.8, 1.1, night * 1.6);
            glow.push(v.x - fx + sx * s, ROAD_Y + hy + 0.15, v.z - fz + sz * s, 1.0, 0.05, 0.02, 0.7, night * (0.8 + v.brake * 1.6));
          }
        }
      }
      void up;
    },
  };
}
