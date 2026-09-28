import * as THREE from 'three';
import { Box } from './physics/collide.js';
import { SITE } from './config.js';
import { CW_DECK, carrierToWorld } from './mobile/config.js';
import {
  MOBILE_JOBS, MOBILE_KPI, readMobile, mobileCounters, setupChecklist, snapshotSetup, setupKpis, configMatches, rclCode,
  resolveStart, recommendedSlewRpm, insideSite, SITE_KPI_KMH, spawnMobileFreePlay,
} from './mobile/jobs.js';
import { buildProp, ensureP1Markings, groundApi } from './mobile/jobProps.js';

// Lift jobs modelled on professional tower crane training curricula
// (load control, executing lifts, steel erection, concrete bucket / form
// following, wind, corridor course), plus the AT-100 mobile-crane jobs M1–M6
// (src/mobile/jobs.js, spec §8.4). Scored with diagnostic KPIs.

const deckY = SITE.building.levels * SITE.building.floor; // 16.0

const TOWER_JOBS = [
  {
    id: 'lc1', title: 'Load Control 1', module: 'Pendulum control',
    brief: 'The 1 t test weight is on the hook. Trolley it out to the marker at 40 m radius and hold it steady inside the target sphere — no residual swing. Use smooth lever work and catch the swing.',
    par: 90, wind: 1.5,
    setup: (J) => {
      const tw = J.spawn('testWeight', 15 * Math.cos(0.35), -15 * Math.sin(0.35), 0.35, 0);
      J.startWith({ slew: 0.35, trolley: 15, ropeLen: 30, attach: tw });
      return [{ kind: 'hover', load: tw, target: J.polar(40, 0.35, 6), tol: 1.0, hold: 5, maxSwing: 1.0, text: 'Trolley out to 40 m. Hold the weight in the sphere, swing under 1°, for 5 s.' }];
    },
  },
  {
    id: 'lc2', title: 'Barrel Test', module: 'Hook & load management',
    brief: 'Pick the test weight from the yard and set it down inside the barrel ring without touching the barrels. Classic certification exercise: plumb hook, controlled swing, gentle landing.',
    par: 150, wind: 2,
    setup: (J) => {
      const tw = J.spawn('testWeight', -22, 2, 0, 0);
      J.startWith({ slew: 2.6, trolley: 20, ropeLen: 18 });
      const ring = J.barrelRing(-14, 36, 1.25);
      return [
        { kind: 'attach', load: tw, text: 'Lower the hook onto the test weight and hook on (R).' },
        { kind: 'deliver', load: tw, target: { x: -14, y: 0, z: 36, yaw: null }, tol: 0.35, clearY: 3.5, text: 'Test lift, then land the weight in the barrel ring. Don\'t touch the barrels.', ring },
      ];
    },
  },
  {
    id: 'lifts', title: 'Executing Lifts', module: 'Materials handling',
    brief: 'Two lifts from the lay-down yard: a 2 t rebar bundle up to the level-5 deck, then a 1.2 t brick pallet to lay-down B at 55 m — close to the tip rating, so watch the LMI and your slewing outswing.',
    par: 330, wind: 3,
    setup: (J) => {
      const rebar = J.spawn('rebar', -30, -8, 0, 0.1);
      const bricks = J.spawn('bricks', -21, 1, 0.2, 0.1);
      J.startWith({ slew: 2.8, trolley: 25, ropeLen: 20 });
      return [
        { kind: 'attach', load: rebar, text: 'Hook on the rebar bundle in the yard (R).' },
        { kind: 'deliver', load: rebar, target: { x: 27.3, y: deckY, z: 16.2, yaw: 0 }, tol: 0.6, yawTol: 12, clearY: deckY + 3.5, text: 'Test lift, then fly the rebar to the marked bay on the level-5 deck.' },
        { kind: 'attach', load: bricks, text: 'Return to the yard and hook on the brick pallet.' },
        { kind: 'deliver', load: bricks, target: { x: 3, y: 0, z: 55, yaw: null }, tol: 0.6, clearY: 4, text: 'Land the brick pallet in lay-down B (55 m radius). Watch the LMI.' },
      ];
    },
  },
  {
    id: 'steel', title: 'Steel Erection', module: 'Structural steel',
    brief: 'Lift the 12 m HEB 300 beam off the trailer and land it across the two column heads on level 6. The rigger can use tag lines (Q/E) while the beam is low; at height, slewing and wind will rotate it — plan your approach.',
    par: 300, wind: 3, blind: true,
    setup: (J) => {
      const yaw = -0.15;
      const beam = J.spawn('beam', 4.8, -22.2, yaw, 1.34);
      J.startWith({ slew: 1.2, trolley: 20, ropeLen: 22 });
      return [
        { kind: 'attach', load: beam, text: 'Hook on the beam on the delivery trailer.' },
        { kind: 'deliver', load: beam, target: { x: 30.3, y: deckY + 3.2, z: 19.5, yaw: 0 }, tol: 0.3, yawTol: 4, clearY: deckY + 6.5, text: 'Land the beam across both column heads (±0.3 m, ±4°). Follow the signaller.' },
      ];
    },
  },
  {
    id: 'bucket', title: 'Concrete Pour', module: 'Bucket placement / form following',
    brief: 'Fly the 2.8 t concrete bucket from the mixer to the wall form on the deck, then follow the form from end to end at pour height (just above the form), and bring the empty bucket back. Blind lift — work with the signaller.',
    par: 330, wind: 2.5, blind: true,
    setup: (J) => {
      const bucket = J.spawn('bucket', -15, -24, 0, 0);
      J.startWith({ slew: 2.1, trolley: 26, ropeLen: 24 });
      const fl = J.site.formLine;
      const top = deckY + 2.8;
      const wps = [];
      for (let i = 0; i <= 4; i++) wps.push({ x: fl.x0 + 0.4 + (fl.x1 - fl.x0 - 0.8) * (i / 4), y: top + 0.4, z: fl.z });
      return [
        { kind: 'attach', load: bucket, text: 'Hook on the concrete bucket by the mixer truck.' },
        { kind: 'path', load: bucket, waypoints: wps, band: [0.25, 1.6], tol: 1.0, clearY: top + 2.5, text: 'Pour: pass over each marker along the wall form, bucket just above the form.' },
        { kind: 'deliver', load: bucket, target: { x: -15, y: 0, z: -24, yaw: null }, tol: 1.0, clearY: top + 2.5, text: 'Return the bucket to the mixer and land it.' },
      ];
    },
  },
  {
    id: 'wind', title: 'Wind Challenge', module: 'Adverse weather',
    brief: 'A 3.6 × 2.4 m formwork shutter (1.3 t) has a wind limit of about 6.5 m/s because of its large area. The wind is freshening. Get it onto the deck before the gusts exceed the limit — time spent flying it above its limit is penalised.',
    par: 240, wind: 4.5, gust: 0.8, windRamp: { to: 10, duration: 260 },
    setup: (J) => {
      const sh = J.spawn('shutter', -30, 14, 0.1, 0.1);
      J.startWith({ slew: 2.2, trolley: 28, ropeLen: 20 });
      return [
        { kind: 'attach', load: sh, text: 'Hook on the formwork shutter in the yard.' },
        { kind: 'deliver', load: sh, target: { x: 21.3, y: deckY, z: 9.6, yaw: 0 }, tol: 0.6, yawTol: 15, clearY: deckY + 4, text: 'Land the shutter in the bay on the deck. Mind the wind limit (6.5 m/s).' },
      ];
    },
  },
  {
    id: 'zigzag', title: 'Corridor Course', module: 'Certification practical',
    brief: 'Fly the test weight low through the four gates of the corridor course in order without touching a pole, then land it on the finish pad.',
    par: 260, wind: 2,
    setup: (J) => {
      const tw = J.spawn('testWeight', -40, 30, 0, 0);
      J.startWith({ slew: 2.45, trolley: 44, ropeLen: 30 });
      const gates = [[-32, 42], [-22, 32], [-12, 44], [-2, 34]];
      const wps = gates.map(([x, z]) => ({ x, y: 1.8, z }));
      gates.forEach(([x, z], i) => {
        const prev = i ? gates[i - 1] : [-40, 30];
        const dx = x - prev[0], dz = z - prev[1];
        const l = Math.hypot(dx, dz);
        J.gate(x, z, -dz / l, dx / l, 1.6);
      });
      return [
        { kind: 'attach', load: tw, text: 'Hook on the test weight.' },
        { kind: 'path', load: tw, waypoints: wps, band: [-1.2, 1.2], tol: 1.3, clearY: 2.4, text: 'Fly through gates 1 → 4, keeping the weight low (under 3 m). Don\'t touch the poles.' },
        { kind: 'deliver', load: tw, target: { x: 8, y: 0, z: 42, yaw: null }, tol: 0.5, clearY: 2.4, text: 'Land on the finish pad.' },
      ];
    },
  },
];

// Every job carries its machine; the host activates it before start().
export const JOBS = [...TOWER_JOBS.map((j) => ({ machine: 'tower', ...j })), ...MOBILE_JOBS];

const markerMat = new THREE.MeshBasicMaterial({ color: 0x33ff88, transparent: true, opacity: 0.25, depthWrite: false });
const lineMat = new THREE.LineBasicMaterial({ color: 0x3dff8e });
const beamMat = new THREE.MeshBasicMaterial({ color: 0x3dff8e, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });

const LEVER_KEYS = ['slew', 'trolley', 'hoist', 'tele', 'luff'];
const BLOCK_NAMES = { ball: 'hook ball', hb26: '26 t block (3 falls)', hb60: '60 t block (7 falls)', hb90: '90 t block (10 falls)' };
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Machine-aware job runner. Tower jobs behave exactly as before; mobile jobs
// (src/mobile/jobs.js) add the state step kinds drive / setup / ballast /
// reeve / config / boom and the load step kind deck, timed events, job props
// and ground zones, and the §8.5 KPIs with critical failures and the set-up
// checklist. Everything machine-specific goes through sim.machine (the active
// Machine: reset via sim.resetCrane, counters, hoist, hoistSpeed,
// signallerGeometry, hudState().mobile, kpi).
export class JobRunner {
  constructor(sim) {
    this.sim = sim;
    this.site = sim.site;
    this.group = new THREE.Group();
    this.group.name = 'jobs';
    sim.scene.add(this.group);
    this.job = null;
    this.extraColliders = [];
    this.props = [];
    this.zonesUsed = false;
    this.checklist = null; // live set-up checklist for the HUD ([{label, ok}] or null)
    try { ensureP1Markings(sim.scene, sim.site); } catch (e) { console.warn('[jobs] P1 markings', e); }
  }

  // helpers used by job setups
  spawn(type, x, z, yaw, baseY) { return this.sim.spawnLoad(type, x, z, yaw, baseY); }
  polar(r, th, y) { return { x: r * Math.cos(th), y, z: -r * Math.sin(th) }; }
  // world target on the ground at (x, z) (mobile jobs work in world coordinates)
  place(x, z, y = null) { return { x, y: y ?? this.groundY(x, z), z, yaw: null }; }
  groundY(x, z) { const t = this.sim.terrain; return t && t.heightAt ? t.heightAt(x, z) : 0; }
  startWith(o) {
    this._started = true;
    const m = this.sim.machine;
    if (m && typeof m.reset === 'function') m.reset(o);
    else this.sim.resetCrane(o);
  }
  toast(text, kind = 'info') { this.sim.hud.toast(text, kind); }

  // job scenery + colliders from src/mobile/jobProps.js (cleared with the job)
  prop(name, opts = {}) {
    const p = buildProp(name, opts, this);
    this.group.add(p.root);
    for (const b of p.colliders) { this.sim.world.add(b); this.extraColliders.push(b); }
    this.props.push(p);
    return p;
  }

  // ground bearing zone (§4.8) through ground.js (bound by the host / machine)
  zone(rect, props = {}) {
    const g = this.sim.ground || groundApi();
    if (g && typeof g.addZone === 'function') { g.addZone(rect, props); this.zonesUsed = true; }
    return rect;
  }

  // composite mats the site provides (§4.8): per job (def.compositeMats), 4 in free play
  get compositeStock() { return this.job ? (this.job.compositeMats || 0) : 4; }

  // §8.10 mobile free-play extras (host calls this after clearLoads())
  spawnFreePlay(opts = {}) {
    try { spawnMobileFreePlay(this, opts); } catch (e) { console.warn('[jobs] free-play props', e); }
  }

  barrelRing(x, z, radius) {
    const posts = [];
    const geo = new THREE.CylinderGeometry(0.28, 0.28, 0.9, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1f5fb0, roughness: 0.5, metalness: 0.3 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = x + Math.cos(a) * (radius + 0.28), pz = z + Math.sin(a) * (radius + 0.28);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, 0.45, pz);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      const b = new Box(px, 0.45, pz, 0.24, 0.45, 0.24, 0, 'barrel');
      this.sim.world.add(b);
      this.extraColliders.push(b);
      posts.push(m);
    }
    return posts;
  }

  gate(x, z, px, pz, half) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.5 });
    const geo = new THREE.CylinderGeometry(0.12, 0.12, 4, 10);
    for (const s of [-1, 1]) {
      const gx = x + px * half * s, gz = z + pz * half * s;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(gx, 2, gz);
      m.castShadow = true;
      this.group.add(m);
      const b = new Box(gx, 2, gz, 0.12, 2, 0.12, 0, 'pole');
      this.sim.world.add(b);
      this.extraColliders.push(b);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, half * 2), mat);
    bar.position.set(x, 4, z);
    bar.rotation.y = Math.atan2(px, pz);
    this.group.add(bar);
  }

  clearMarkers() {
    for (const c of this.extraColliders) this.sim.world.remove(c);
    this.extraColliders = [];
    for (const p of this.props) p.dispose();
    this.props = [];
    if (this.zonesUsed) {
      const g = this.sim.ground || groundApi();
      if (g && typeof g.clearZones === 'function') g.clearZones();
      this.zonesUsed = false;
    }
    this.group.clear();
    this.setChecklist(null);
  }

  addTargetMarker(load, t) {
    const g = new THREE.Group();
    const [sx, sy, sz] = load.def.size;
    const box = new THREE.BoxGeometry(sx + 0.1, sy, sz + 0.1);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), lineMat);
    edges.position.y = sy / 2;
    g.add(edges);
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(sx + t.tol * 2, sz + t.tol * 2), markerMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.03;
    g.add(pad);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 60, 12, 1, true), beamMat);
    beam.position.y = 30;
    g.add(beam);
    g.position.set(t.target.x, t.target.y, t.target.z);
    const yaw = t.target.markerYaw ?? t.target.yaw;
    if (yaw !== null && yaw !== undefined) g.rotation.y = yaw;
    this.group.add(g);
    return g;
  }

  // carrier footprint (x_c −3.70 … +7.75, ±1.375) at a drive target
  addDriveMarker(t) {
    const g = new THREE.Group();
    const L = 11.45, W = 2.75;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(L, W), markerMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(2.025, 0.04, 0);
    g.add(pad);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, 0.02, W)), lineMat);
    edges.position.set(2.025, 0.05, 0);
    g.add(edges);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 30, 12, 1, true), beamMat);
    beam.position.y = 15;
    g.add(beam);
    g.position.set(t.x, this.groundY(t.x, t.z), t.z);
    g.rotation.y = t.yaw ?? 0;
    this.group.add(g);
    return g;
  }

  addHoverMarker(p, tol) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(tol, 20, 14), new THREE.MeshBasicMaterial({ color: 0x3dff8e, wireframe: true, transparent: true, opacity: 0.5 }));
    m.position.set(p.x, p.y, p.z);
    this.group.add(m);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, p.y, 10, 1, true), beamMat);
    beam.position.set(p.x, p.y / 2, p.z);
    this.group.add(beam);
    return m;
  }

  addWaypointMarkers(wps, tol) {
    return wps.map((w, i) => {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(tol, 0.06, 8, 32), new THREE.MeshBasicMaterial({ color: i ? 0xffc93d : 0x3dff8e }));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(w.x, w.y, w.z);
      this.group.add(ring);
      return ring;
    });
  }

  start(def) {
    this.stop();
    this.sim.clearLoads();
    this.clearMarkers();
    const w = this.sim.wind;
    w.setMean(def.wind ?? 2);
    w.gustiness = def.gust ?? 0.5;
    w.ramp = def.windRamp ? { from: w.mean, to: def.windRamp.to, duration: def.windRamp.duration, t: 0 } : null;
    this.job = def;
    this.isMobile = def.machine === 'mobile';
    this._started = false;
    this.failure = null;
    this.steps = def.setup(this);
    // mobile jobs carry their MobileStart (§9.1); props and loads exist by now
    if (!this._started && def.start) {
      const st = resolveStart(def.start);
      this.startWith(typeof st === 'function' ? st(this) : st);
    }
    this.stepIndex = -1;
    this.t = 0;
    this.events = (def.events || []).map((e) => ({ t: e.t, run: e.run, done: false }));
    this.kpi = {
      time: 0, maxSway: 0, collisions: 0, rough: 0, twoBlock: 0, lmiTrips: 0,
      hornFirst: null, testLifts: 0, liftsNeeded: 0, placeErr: [], windExposure: 0,
      assist: false, maxHeightErr: 0, lateralErr: 0,
    };
    this.steps.forEach((s, i) => { s.needsTestLift = i > 0 && this.steps[i - 1].kind === 'attach'; });
    this.kpi.liftsNeeded = this.steps.filter((s) => s.needsTestLift).length;
    const c = this.sim.machine.counters;
    this.base2b = c.twoBlockCount;
    this.baseLmi = c.lmiTrips;
    this.moved = false;
    this.done = false;
    if (this.isMobile) this.initMobile();
    this.nextStep();
    this.sim.signaller.enabled = !!def.blind || this.sim.guidance;
    this.sim.signaller.reset();
  }

  stop() {
    this.job = null;
    this.failure = null;
    this.clearMarkers();
    this.sim.signaller.reset();
    this.sim.wind.ramp = null;
  }

  get step() { return this.steps ? this.steps[this.stepIndex] : null; }

  nextStep() {
    this.stepIndex++;
    this.group.children.filter((c) => c.userData.stepMarker).forEach((c) => this.group.remove(c));
    this.setChecklist(null);
    this.sim.hud.progress(null);
    const s = this.step;
    if (!s) return this.finish();
    s.state = { hold: 0, testPhase: 'none', testTimer: 0, wp: 0 };
    let marker = null;
    if (s.kind === 'deck') {
      s.target = this.deckTarget();
      s.tol = s.tol ?? CW_DECK.tolPos;
      s.clearY = s.clearY ?? 2.8;
    }
    if (s.kind === 'deliver' || s.kind === 'deck') marker = this.addTargetMarker(s.load, s);
    if (s.kind === 'hover') marker = this.addHoverMarker(s.target, s.tol);
    if (s.kind === 'drive') marker = this.addDriveMarker(s.target);
    if (s.kind === 'path') s.state.rings = this.addWaypointMarkers(s.waypoints, s.tol);
    if (marker) marker.userData.stepMarker = true;
    if (s.state.rings) s.state.rings.forEach((r) => { r.userData.stepMarker = true; });
    this.sim.signaller.reset();
    this.sim.hud.jobStep(s.text, this.stepIndex, this.steps.length);
  }

  onImpact(ev) {
    if (!this.job) return;
    const s = this.step;
    const isTargetLanding = s && s.kind === 'deliver' && ev.kind === 'land';
    if (ev.kind === 'side' && ev.speed > 0.25) { this.kpi.collisions++; this.sim.hud.toast(`Collision (${ev.tag || 'object'})`, 'bad'); }
    else if (ev.kind === 'land' && ev.speed > 0.45) { this.kpi.rough++; this.sim.hud.toast('Rough landing', 'warn'); }
    else if (ev.kind === 'hook' && ev.speed > 0.8) { this.kpi.collisions++; this.sim.hud.toast('Hook block impact', 'bad'); }
    void isTargetLanding;
  }

  onRelease(load) {
    if (!this.job) return;
    const s = this.step;
    if (!s || s.load !== load) return;
    if (s.kind === 'deck') {
      if (this.slabOnDeck(load)) this.completeDeck(load);
      else {
        this.sim.hud.toast('Slab released off the deck zone. Land it on the carrier deck (±0.15 m, ±3°), boom over the rear.', 'bad');
        this.sim.audio.chime(false);
      }
      return;
    }
    if (s.kind !== 'deliver') return;
    const t = s.target;
    const bottom = load.pos.y - load.half.y;
    const err = Math.hypot(load.pos.x - t.x, load.pos.z - t.z);
    let yawErr = 0;
    if (t.yaw !== null && t.yaw !== undefined) {
      // symmetric loads: 180° is equivalent
      let d = ((load.yaw - t.yaw) % Math.PI + Math.PI) % Math.PI;
      if (d > Math.PI / 2) d = Math.PI - d;
      yawErr = THREE.MathUtils.radToDeg(Math.abs(d));
    }
    const levelOk = Math.abs(bottom - t.y) < 0.35;
    if (err <= s.tol && levelOk && (!s.yawTol || yawErr <= s.yawTol)) {
      this.kpi.placeErr.push(err / s.tol);
      load._jobDone = true;
      this.sim.hud.toast(`Placed — ${err.toFixed(2)} m${s.yawTol ? `, ${yawErr.toFixed(1)}°` : ''}`, 'good');
      this.sim.audio.chime(true);
      this.nextStep();
    } else {
      const why = !levelOk ? 'not on the target level' : err > s.tol ? `${err.toFixed(2)} m off target` : `rotated ${yawErr.toFixed(0)}°`;
      this.sim.hud.toast(`Released outside the target (${why}). Re-attach and place it correctly.`, 'bad');
      this.sim.audio.chime(false);
      s.state.misplaced = (s.state.misplaced || 0) + 1;
      this.kpi.placeErr.push(1.5);
    }
  }

  update(dt, levers, horn) {
    if (!this.job || this.done) return;
    const sim = this.sim;
    const m = sim.machine;
    const hoist = m.hoist;
    this.t += dt;
    this.kpi.time = this.t;
    for (const e of this.events) {
      if (e.done || this.t < e.t) continue;
      e.done = true;
      try { e.run(this); } catch (err) { console.warn('[jobs] event', err); }
    }
    for (const p of this.props) p.update(dt);
    let lev = 0;
    for (const k of LEVER_KEYS) lev += Math.abs(levers[k] || 0);
    const moving = lev > 0.08;
    if (horn && this.kpi.hornFirst === null) this.kpi.hornFirst = !this.moved;
    if (moving && !this.moved) {
      this.moved = true;
      if (this.kpi.hornFirst === null) {
        this.kpi.hornFirst = false;
        sim.hud.toast('Tip: sound the horn (H) before the first movement', 'warn');
      }
    }
    if (!this.isMobile && sim.settings.swayAssist) this.kpi.assist = true;
    const c = m.counters;
    this.kpi.twoBlock = c.twoBlockCount - this.base2b;
    this.kpi.lmiTrips = c.lmiTrips - this.baseLmi;
    const suspended = hoist.load && !hoist.loadGrounded;
    if (suspended) {
      this.kpi.maxSway = Math.max(this.kpi.maxSway, THREE.MathUtils.radToDeg(hoist.swingAngle));
      if (sim.wind.anemometer > hoist.load.def.windLimit) this.kpi.windExposure += dt;
    }
    if (this.isMobile) {
      this.updateMobile(dt, !!suspended);
      if (this.done || this.failure) return;
    }

    const s = this.step;
    if (!s) return;
    if (!s.load) { this.updateStateStep(dt, s); return; }
    const st = s.state;
    if (s.kind === 'attach' && s.anyOf && !s.load.attached) {
      const alt = s.anyOf.find((l) => l.attached && !l._jobDone);
      if (alt) this.rebindLoad(s, alt);
    }
    const load = s.load;
    const lp = load.pos;
    const bottomY = lp.y - load.half.y;

    // test lift detection for delivery steps
    if (s.needsTestLift && load.attached && st.testPhase !== 'done' && st.testPhase !== 'skipped') {
      const clear = !hoist.loadGrounded;
      if (clear) {
        const support = this.supportBelow ?? 0;
        const hgt = bottomY - support;
        if (st.testPhase === 'none') st.testPhase = 'lifting';
        if (hgt < 0.8 && Math.abs(m.hoistSpeed) < 0.02 && Math.abs(levers.hoist) < 0.05) {
          st.testTimer += dt;
          if (st.testTimer > 2) {
            st.testPhase = 'done';
            this.kpi.testLifts++;
            sim.hud.toast('Test lift OK — brakes hold, rigging checked', 'good');
          }
        } else if (hgt > 1.6) {
          st.testPhase = 'skipped';
          sim.hud.toast('No test lift performed (lift 5–60 cm and hold 2 s first)', 'warn');
        }
      }
    }

    // signaller guidance (slew centre and radial words from the machine)
    let tgt = null, clearY = s.clearY ?? 3;
    if (s.kind === 'deliver' || s.kind === 'deck') tgt = s.target;
    else if (s.kind === 'path') tgt = { ...s.waypoints[Math.min(st.wp, s.waypoints.length - 1)] };
    else if (s.kind === 'hover') tgt = { x: s.target.x, y: s.target.y - load.half.y, z: s.target.z };
    if (s.kind === 'attach' || !load.attached) tgt = { x: lp.x, y: lp.y + load.half.y + 0.2, z: lp.z };
    if (tgt) {
      const ref = load.attached ? { x: lp.x, y: bottomY, z: lp.z } : hoist.hook;
      sim.signaller.pathStep = s.kind === 'path';
      sim.signaller.update(dt, m.signallerGeometry(), ref, tgt, clearY, THREE.MathUtils.radToDeg(hoist.swingAngle));
    }

    switch (s.kind) {
      case 'attach':
        if (load.attached) this.nextStep();
        break;
      case 'deck':
        if (!load.attached && this.slabOnDeck(load, this.mv)) this.completeDeck(load);
        break;
      case 'hover': {
        const d = Math.hypot(lp.x - s.target.x, lp.z - s.target.z, lp.y - s.target.y);
        const sw = THREE.MathUtils.radToDeg(hoist.swingAngle);
        if (d < s.tol && sw < s.maxSwing) {
          st.hold += dt;
          sim.hud.progress(st.hold / s.hold);
          if (st.hold >= s.hold) {
            this.kpi.placeErr.push(d / s.tol);
            sim.audio.chime(true);
            sim.hud.progress(null);
            this.nextStep();
          }
        } else {
          st.hold = Math.max(0, st.hold - dt * 2);
          sim.hud.progress(st.hold > 0 ? st.hold / s.hold : null);
        }
        break;
      }
      case 'path': {
        const wp = s.waypoints[st.wp];
        if (!wp) break;
        const horiz = Math.hypot(lp.x - wp.x, lp.z - wp.z);
        const dy = bottomY - wp.y;
        if (horiz < s.tol * 1.5) this.kpi.maxHeightErr = Math.max(this.kpi.maxHeightErr, Math.max(0, s.band[0] - dy, dy - s.band[1]));
        if (horiz < s.tol && dy > s.band[0] - 0.4 && dy < s.band[1] + 0.4) {
          this.kpi.lateralErr = Math.max(this.kpi.lateralErr, horiz);
          st.rings[st.wp].material.color.set(0x7a7a7a);
          st.wp++;
          if (st.rings[st.wp]) st.rings[st.wp].material.color.set(0x3dff8e);
          sim.audio.chime(true);
          sim.hud.toast(`Marker ${st.wp}/${s.waypoints.length}`, 'good');
          if (st.wp >= s.waypoints.length) this.nextStep();
        }
        break;
      }
      default:
        break;
    }
  }

  // any-of attach (M4 panels): the load actually hooked takes over this step
  // and the later steps of the one it replaces
  rebindLoad(s, alt) {
    const old = s.load;
    for (let i = this.stepIndex; i < this.steps.length; i++) {
      const st = this.steps[i];
      if (st.load === old) st.load = alt;
      else if (st.load === alt) st.load = old;
    }
  }

  // ------------------------------------------------------------ mobile
  initMobile() {
    const m = this.sim.machine;
    this.mBase = mobileCounters(m);
    this.mLast = { ...this.mBase };
    // job-side integrals, used where the machine does not report a value
    this.mk = { speeding: 0, warn: 0, mismatch: 0, slewOver: 0, maxSettle: 0, drove: false, padErr: null, setupSnap: null };
    this.firstLift = null;
    this._wasSuspended = false;
    this.mv = readMobile(m);
  }

  // world pose of the carrier-deck landing zone (§6.6: x_c −3.18, deck top 1.85)
  deckTarget() {
    const v = readMobile(this.sim.machine);
    const w = carrierToWorld(v.pos, v.yaw, CW_DECK.x, CW_DECK.y);
    return { x: w.x, y: CW_DECK.topZ + v.frameLift + this.groundY(v.pos.x, v.pos.z), z: w.z, yaw: v.yaw + Math.PI / 2 };
  }

  slabOnDeck(load, view = null) {
    if (load.absorbed) return true;
    const id = load.def.slab;
    const v = view || readMobile(this.sim.machine);
    if (id && v.deckSlabs.includes(id)) return true;
    // absorbed slabs leave the shared scene (re-parented to the deck or removed)
    return !!id && load.mesh.parent !== this.sim.scene;
  }

  completeDeck(load) {
    this.sim.hud.toast(`${load.def.name.replace(/\s[\d.]+ t$/, '')} is on the carrier deck`, 'good');
    this.sim.audio.chime(true);
    this.nextStep();
  }

  setChecklist(list) {
    this.checklist = list;
    const key = list ? list.map((i) => (i.ok ? '1' : '0') + i.label).join('|') : '';
    if (key === this._ckKey) return;
    this._ckKey = key;
    if (typeof this.sim.hud.jobChecklist === 'function') this.sim.hud.jobChecklist(list);
  }

  fail(reason, delay = 3) {
    if (this.failure) return;
    this.failure = { reason, t: delay };
    this.sim.hud.toast(`CRITICAL: ${reason} — job failed`, 'bad');
    this.sim.audio.chime(false);
    this.sim.signaller.reset();
    this.setChecklist(null);
  }

  updateMobile(dt, suspended) {
    const m = this.sim.machine;
    if (this.failure) {
      this.failure.t -= dt;
      if (this.failure.t <= 0) this.finish();
      return;
    }
    const v = (this.mv = readMobile(m));
    const mk = this.mk;
    const cnt = mobileCounters(m);
    // time penalties the machine books (quick ballast): job time is sim time + penalties
    const pen = cnt.timePenalty - this.mLast.timePenalty;
    if (pen > 0) { this.t += pen; this.kpi.time = this.t; this.sim.hud.toast(`+${Math.round(pen)} s time penalty`, 'warn'); }
    if (Math.abs(v.speedKmh) > 1) mk.drove = true;
    if (insideSite(v.pos) && Math.abs(v.speedKmh) > SITE_KPI_KMH) mk.speeding += dt;
    if (v.mode === 'CRANE') {
      if (v.warnings.has('support')) mk.mismatch += dt;
      if (v.rclState === 'warn') mk.warn += dt;
    }
    // slewing faster than recommended for this boom with a real load on (§3.2, §8.5)
    if (suspended && v.ratio > MOBILE_KPI.op.slewLoadRatio && Math.abs(v.slewRpm) > recommendedSlewRpm(v.boomLen) + 0.02) mk.slewOver += dt;
    for (const s of v.settlement) if (s > mk.maxSettle) mk.maxSettle = s;
    // set-up snapshot at the first lift-off of the job (§8.5)
    if (suspended && !this._wasSuspended && !this.firstLift) this.firstLift = snapshotSetup(v, this.t);
    this._wasSuspended = suspended;

    const last = this.mLast, hud = this.sim.hud;
    const inc = (k) => cnt[k] > last[k];
    if (inc('collisions')) hud.toast('Collision — carrier stopped', 'bad');
    if (inc('scrapes')) hud.toast('Scrape', 'warn');
    if (inc('kerbHard')) hud.toast('Hard kerb strike', 'bad');
    else if (inc('kerb')) hud.toast('Kerb strike', 'warn');
    if (inc('sidePulls')) hud.toast('SIDE PULL — never drag a load: get the head over it first', 'bad');
    if (inc('boomContacts')) hud.toast('BOOM CONTACT — all motions stopped', 'bad');
    if (inc('floatLight')) hud.toast('OUTRIGGER LIGHT', 'warn');
    if (inc('liftoffs')) hud.toast('FLOAT LIFTED — set the load down', 'bad');
    if (inc('slams')) hud.toast('Near tip-over! The crane slammed back onto its outriggers', 'bad');
    this.mLast = cnt;

    // critical failures → grade F, job ends (§8.5)
    const b = this.mBase;
    const settle = Math.max(mk.maxSettle, cnt.maxSettlement ?? 0);
    if (v.mode === 'OVERTURNED' || v.stabilityState === 'OVERTURNED' || cnt.overturned) this.fail('Crane overturned', 6);
    else if (cnt.trafficCollisions > b.trafficCollisions) this.fail('Collision with road traffic', 2.5);
    else if (settle >= MOBILE_KPI.critical.punchThrough) this.fail('Outrigger punched through the ground', 3);
    else if (cnt.bypass > b.bypass) this.fail('RCL emergency bypass used', 2.5);
  }

  updateStateStep(dt, s) {
    const v = this.mv;
    if (!v) return;
    const st = s.state, hud = this.sim.hud;
    const done = (msg) => { hud.toast(msg, 'good'); this.sim.audio.chime(true); this.nextStep(); };
    switch (s.kind) {
      case 'drive': {
        const d = Math.hypot(v.pos.x - s.target.x, v.pos.z - s.target.z);
        const yawErr = Math.abs(THREE.MathUtils.radToDeg(wrapPi(v.yaw - s.target.yaw)));
        const stopped = Math.abs(v.speedKmh) < 0.3;
        if (d <= s.tol.pos && yawErr <= s.tol.yawDeg && stopped && v.parkingBrake) {
          this.mk.padErr = { d, yawErr };
          done(`On the pad mark — ${d.toFixed(2)} m, ${yawErr.toFixed(1)}°`);
        } else if (stopped && v.parkingBrake && d < 4) {
          if (!st.warned) {
            st.warned = true;
            hud.toast(`Not on the mark: ${d.toFixed(2)} m / ${yawErr.toFixed(1)}° (needs ±${s.tol.pos} m, ±${s.tol.yawDeg}°)`, 'warn');
          }
        } else if (!stopped) st.warned = false;
        break;
      }
      case 'setup': {
        const list = setupChecklist(v, s.require);
        this.setChecklist(list);
        const ok = list.every((i) => i.ok);
        const crane = v.mode === 'CRANE';
        if (crane && ok) {
          s.snapshot = this.mk.setupSnap = snapshotSetup(v, this.t);
          this.setChecklist(null);
          done('Set-up complete');
        } else if (crane && !st.wasCrane) {
          const miss = list.filter((i) => !i.ok).map((i) => i.label);
          hud.toast(`Set-up incomplete: ${miss.slice(0, 3).join('; ')}`, 'warn');
        }
        st.wasCrane = crane;
        break;
      }
      case 'ballast':
        if (v.ballastProgress !== null && v.ballastProgress > 0 && v.ballastProgress < 1) hud.progress(v.ballastProgress);
        if (v.cwKg >= s.cwKg - 1) done(`Counterweight ${(v.cwKg / 1000).toFixed(1)} t on the superstructure`);
        break;
      case 'reeve':
        if (v.reeving && v.reeveProgress !== null) hud.progress(v.reeveProgress);
        if (v.block === s.block && !v.reeving) done(`Reeved: ${BLOCK_NAMES[s.block] || s.block}`);
        break;
      case 'config':
        if (configMatches(v)) done(`RCL configuration matches the crane: ${rclCode(v.rcl)}`);
        break;
      case 'boom':
        hud.progress(THREE.MathUtils.clamp((v.boomLen - 11.5) / Math.max(0.1, s.length - 11.5), 0, 1));
        if (v.boomLen >= s.length - 0.05 && v.pinned) done(`Boom ${v.boomLen.toFixed(1)} m, pinned`);
        break;
      default:
        break;
    }
  }

  // §8.5 mobile KPI rows (appended to the common rows); returns the checklist
  mobileItems(items) {
    const K = MOBILE_KPI, mk = this.mk;
    const cnt = mobileCounters(this.sim.machine), b = this.mBase;
    const d = (key) => Math.max(0, (cnt[key] ?? 0) - (b[key] ?? 0));
    const tdiff = (key, local) => (typeof cnt[key] === 'number' && typeof b[key] === 'number' ? Math.max(0, cnt[key] - b[key]) : local);
    const add = (label, value, pts, note) => items.push({ label, value, pts, note });
    if (this.steps.some((s) => s.kind === 'drive') || mk.drove) {
      const col = d('collisions'), scr = d('scrapes'), kb = d('kerb'), kh = d('kerbHard');
      add('Carrier collisions', `${col}`, -K.drive.collision * col);
      add('Scrapes', `${scr}`, -Math.min(K.drive.scrapeMax, K.drive.scrape * scr));
      add('Kerb strikes', kh ? `${kb} + ${kh} hard` : `${kb}`, -(K.drive.kerb * kb + K.drive.kerbHard * kh));
      const sp = tdiff('speedingTime', mk.speeding);
      add('Site speeding (> 11 km/h)', `${sp.toFixed(0)} s`, -Math.min(K.drive.speedMax, Math.floor(sp * K.drive.speedPerS)));
      if (mk.padErr) add('Pad position', `${mk.padErr.d.toFixed(2)} m, ${mk.padErr.yawErr.toFixed(1)}°`, 0);
      const tc = d('trafficCollisions');
      if (tc) add('Traffic collision', `${tc}`, 0, 'CRITICAL');
    }
    const snap = this.firstLift || mk.setupSnap;
    let checklist = null, criticalRisk = false;
    if (snap) {
      const r = setupKpis(snap, tdiff('mismatchTime', mk.mismatch));
      items.push(...r.items);
      checklist = r.checklist;
      criticalRisk = r.criticalRisk;
    }
    add('Slew overspeed with load', `${mk.slewOver.toFixed(0)} s`, -Math.min(K.op.slewMax, Math.floor(mk.slewOver / 2) * K.op.slewPer2s));
    const sp = d('sidePulls'), bc = d('boomContacts'), fl = d('floatLight'), lo = d('liftoffs'), sl = d('slams');
    if (sp) add('Side pull', `${sp}`, -Math.min(K.op.sidePullMax, K.op.sidePull * sp));
    if (bc) add('Boom contact', `${bc}`, -K.op.boomContact * bc);
    if (fl) add('Outrigger light', `${fl}`, -Math.min(K.op.floatLightMax, K.op.floatLight * fl));
    if (lo) add('Float lift-off', `${lo}`, -K.op.liftoff * lo);
    if (sl) add('Near tip-over (slam)', `${sl}`, -K.op.slam * sl);
    const settle = Math.max(mk.maxSettle, cnt.maxSettlement ?? 0);
    add('Ground settlement (max)', `${Math.round(settle * 1000)} mm`, settle > K.op.settle2 ? -K.op.settle2Pts : settle > K.op.settle1 ? -K.op.settle1Pts : 0);
    const wt = tdiff('warnTime', mk.warn);
    add('Time in RCL warning (90–100 %)', `${Math.round(wt)} s`, 0, wt > K.op.warnInfoS ? 'info' : undefined);
    if (d('bypass')) add('RCL emergency bypass', 'Used', -K.op.bypass, 'CRITICAL');
    if (this.failure) add(`CRITICAL: ${this.failure.reason}`, 'Job failed', 0);
    return { checklist, criticalRisk };
  }

  finish() {
    this.done = true;
    const k = this.kpi;
    const job = this.job;
    const mob = this.isMobile;
    const items = [];
    const add = (label, value, pts, note) => items.push({ label, value, pts, note });
    const over = Math.max(0, k.time - job.par);
    add('Execution time', `${fmtTime(k.time)} (par ${fmtTime(job.par)})`, -Math.min(20, Math.floor(over / 5)));
    add('Max load sway', `${k.maxSway.toFixed(1)}°`, -Math.min(15, Math.max(0, Math.round((k.maxSway - 2.5) * 2))));
    add(mob ? 'Load / hook collisions' : 'Collisions', `${k.collisions}`, -8 * k.collisions);
    add('Rough landings', `${k.rough}`, -5 * k.rough);
    add('Upper limit (anti two-block) trips', `${k.twoBlock}`, -5 * k.twoBlock);
    add(mob ? 'RCL cut-outs (STOP)' : 'LMI cut-outs', `${k.lmiTrips}`, -10 * k.lmiTrips);
    add('Horn before first motion', k.hornFirst ? 'Yes' : 'No', k.hornFirst ? 0 : -5);
    if (k.liftsNeeded) add('Test lifts', `${k.testLifts}/${k.liftsNeeded}`, -5 * Math.max(0, k.liftsNeeded - k.testLifts));
    const pe = k.placeErr.length ? k.placeErr.reduce((a, b) => a + b, 0) / k.placeErr.length : 0;
    add('Placement accuracy', `${Math.round(Math.max(0, 1 - pe) * 100)}% of tolerance`, -Math.round(pe * 10));
    if (job.id === 'bucket' || job.id === 'zigzag') add('Max height error on path', `${k.maxHeightErr.toFixed(2)} m`, -Math.min(10, Math.round(k.maxHeightErr * 5)));
    if (k.windExposure > 0) add('Time above load wind limit', `${k.windExposure.toFixed(0)} s`, -Math.min(20, Math.round(k.windExposure / 2)));
    if (k.assist) add('Sway Control assist used', 'Yes', 0, 'assisted');
    const extra = mob ? this.mobileItems(items) : null;
    let score = 100 + items.reduce((a, b) => a + b.pts, 0);
    score = Math.max(0, Math.min(100, score));
    let grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
    const failed = this.failure ? this.failure.reason : null;
    if (failed) { score = Math.min(score, 59); grade = 'F'; }
    let best = null;
    try {
      const key = 'tcsim.best.' + job.id;
      best = Number(localStorage.getItem(key)) || null;
      if (!failed && (!best || score > best)) localStorage.setItem(key, String(score));
    } catch { /* storage unavailable */ }
    this.setChecklist(null);
    this.sim.signaller.reset();
    const res = { job, items, score, grade, best, assisted: k.assist };
    if (mob) Object.assign(res, { checklist: extra.checklist, failed, criticalRisk: extra.criticalRisk });
    this.sim.hud.showResults(res);
  }
}

export function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function bestScore(id) {
  try { return Number(localStorage.getItem('tcsim.best.' + id)) || null; } catch { return null; }
}
