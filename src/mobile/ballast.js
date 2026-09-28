// AT-100 5.1 self-ballasting (spec §1.5, §6.6): counterweight slabs A/B/C are
// landed with the crane's own hook on the carrier rear deck (x_c −3.18, top
// z 1.85), absorbed from loads into the deck stack (a carrier body), then
// raised into the superstructure CW frame by the ballasting cylinders in 45 s
// [E] — only with the turntable pinned [S14]. Lowering reverses it
// (demobilisation). The RCL is NOT told: the counterweight actually fitted is
// never checked against the configured one (Blanchardstown case [S19]).
//
//   const bal = new Ballast();  bal.reset(start.cwKg, start.deckSlabs)
//   onRelease(load): if (bal.canAbsorb(load, pose)) { bal.absorb(load); remove the Load; return true }
//   B pressed: bal.toggle(pinned)   (or startRaise / startLower)
//   each step: bal.update(dt, input.setup.ballast, pinned) → events
//   bodies: fillBodies(..., {cwKg: bal.superKg, deckKg: bal.deckKg, deckH: bal.deckH, deckZ: bal.deckZ})

import { AT100, CW_SLABS, CW_MAKEUP, CW_CONFIGS, CW_DECK, BALLAST, worldToCarrier } from './config.js';

const DEG = Math.PI / 180;
const RIDE = AT100.carrier.rideHeight;
const SLAB_OF_TYPE = Object.fromEntries(Object.values(CW_SLABS).map((s) => [s.loadType, s.id]));
const HEIGHT_TOL = 0.15; // m: slab bottom vs deck-stack top when released [E]
const MAX_STACK = 3;
const _c = { x: 0, y: 0 };

const slabRec = (id, load = null) => ({ id, massKg: CW_SLABS[id].massKg, h: CW_SLABS[id].h, loadType: CW_SLABS[id].loadType, load });
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

export class Ballast {
  constructor() {
    this.quick = false; // setting quickBallast (training): instant, 120 s time penalty
    this.events = []; // this step's events (rebuilt by update())
    this._pending = []; // raised between steps (absorb, quick ballast), delivered by the next update()
    this.lastReason = null;
    this.reset();
  }

  /** @param {number} cwKg on the superstructure @param {string[]} deckSlabs ids on the deck, bottom first */
  reset(cwKg = 0, deckSlabs = []) {
    this.superSlabs = [...(CW_MAKEUP[cwKg] || [])];
    this.deckStack = deckSlabs.filter((id) => CW_SLABS[id] && !this.superSlabs.includes(id)).map((id) => slabRec(id));
    this.raising = null; // {dir: +1 raise | −1 lower, t, dur}
    this.events.length = 0;
    this._pending.length = 0;
    this.lastReason = null;
  }

  get superKg() { let m = 0; for (const id of this.superSlabs) m += CW_SLABS[id].massKg; return m; }
  get deckKg() { let m = 0; for (const s of this.deckStack) m += s.massKg; return m; }
  get deckH() { let h = 0; for (const s of this.deckStack) h += s.h; return h; }
  get busy() { return !!this.raising; }
  get progress() { return this.raising ? Math.min(1, this.raising.t / this.raising.dur) : 0; }
  get direction() { return this.raising ? this.raising.dir : 0; }
  // total if everything ended up on the superstructure
  get totalKg() { return this.superKg + this.deckKg; }

  // CG height (C, road stance) of the deck stack; rises toward the CW frame (§1.3 z 2.45) while raising
  get deckZ() {
    const z0 = CW_DECK.topZ + this.deckH / 2;
    return this.raising && this.raising.dir > 0 ? z0 + (AT100.cwCg.z - z0) * this.progress : z0;
  }
  // Deck-stack top (C, road stance): where the next slab must land
  get deckTopZ() { return CW_DECK.topZ + this.deckH; }

  /**
   * Can this released load be absorbed into the deck stack (§6.6)? Slab type
   * cwA/cwB/cwC, not already fitted, landed on the deck zone: carrier
   * (x −3.18 ± 0.15, y 0 ± 0.15), long side across the carrier ± 3°, resting on
   * the stack top (± 0.15 m, if pose.z0 is known), stack < 3, cylinders idle.
   * @param {{type:string, pos:{x,y,z}, yaw:number, half?:{y:number}}} load
   * @param {{x:number, z:number, yaw:number, z0?:number}} pose  carrier slew-axis point / yaw / datum height
   */
  canAbsorb(load, pose) {
    const id = SLAB_OF_TYPE[load?.type];
    const no = (r) => { this.lastReason = r; return false; };
    if (!id) return no('not a counterweight slab');
    if (this.superSlabs.includes(id) || this.deckStack.some((s) => s.id === id)) return no(`slab ${id} already fitted`);
    if (this.raising) return no('ballast cylinders moving');
    if (this.deckStack.length >= MAX_STACK) return no('deck stack full');
    worldToCarrier(pose, pose.yaw, load.pos.x, load.pos.z, _c);
    if (Math.abs(_c.x - CW_DECK.x) > CW_DECK.tolPos || Math.abs(_c.y - CW_DECK.y) > CW_DECK.tolPos) return no('not on the deck zone');
    // slab local x (2.60 m) must lie across the carrier: load yaw = carrier yaw + 90° (mod 180°)
    let d = (load.yaw - pose.yaw - Math.PI / 2) % Math.PI;
    if (d > Math.PI / 2) d -= Math.PI; else if (d < -Math.PI / 2) d += Math.PI;
    if (Math.abs(d) > CW_DECK.tolYawDeg * DEG) return no('slab not square to the deck');
    if (pose.z0 !== undefined && load.half) {
      const top = pose.z0 - RIDE + this.deckTopZ, bottom = load.pos.y - load.half.y;
      if (Math.abs(bottom - top) > HEIGHT_TOL) return no('slab not resting on the deck');
    }
    this.lastReason = null;
    return true;
  }

  // Take the load into the deck stack (the host removes the Load / moves its mesh to the deck group).
  absorb(load) {
    const id = SLAB_OF_TYPE[load?.type];
    if (!id) return null;
    const rec = slabRec(id, load);
    this.deckStack.push(rec);
    this._pending.push({ type: 'absorbed', id, massKg: rec.massKg });
    return rec;
  }

  // Demobilisation: hand the top deck slab back so the host can spawn a Load of
  // rec.loadType at the deck (world) and the player can hook it off.
  takeTop() {
    if (this.raising || !this.deckStack.length) return null;
    return this.deckStack.pop();
  }

  _combinationOk() {
    const ids = [...this.superSlabs, ...this.deckStack.map((s) => s.id)];
    const kg = this.totalKg;
    return CW_CONFIGS.includes(kg) && sameSet(ids, CW_MAKEUP[kg]);
  }

  /** Raise the deck stack into the CW frame (hold B, 45 s). @returns {{ok, reason}} */
  startRaise(pinned) {
    const r = !pinned ? 'TURNTABLE NOT PINNED' : this.raising ? 'BALLAST MOVING' : !this.deckStack.length ? 'NO SLABS ON THE DECK'
      : !this._combinationOk() ? 'CW COMBINATION NOT VALID' : null;
    if (r) { this.lastReason = r; return { ok: false, reason: r }; }
    this.raising = { dir: +1, t: 0, dur: BALLAST.raiseTime };
    if (this.quick) this._finish(true);
    return { ok: true, reason: null };
  }

  /** Lower the superstructure CW onto the deck (demobilisation). @returns {{ok, reason}} */
  startLower(pinned) {
    const r = !pinned ? 'TURNTABLE NOT PINNED' : this.raising ? 'BALLAST MOVING' : !this.superSlabs.length ? 'NO COUNTERWEIGHT FITTED'
      : this.deckStack.length ? 'DECK NOT CLEAR' : null;
    if (r) { this.lastReason = r; return { ok: false, reason: r }; }
    this.raising = { dir: -1, t: 0, dur: BALLAST.raiseTime };
    if (this.quick) this._finish(true);
    return { ok: true, reason: null };
  }

  // B pressed: continue a paused motion, else raise if slabs are on the deck, else lower.
  toggle(pinned) {
    if (this.raising) return pinned ? { ok: true, reason: null } : { ok: false, reason: 'TURNTABLE NOT PINNED' };
    return this.deckStack.length ? this.startRaise(pinned) : this.startLower(pinned);
  }

  /**
   * @param {number} dt
   * @param {boolean} hold    B held (the cylinders only move while it is held)
   * @param {boolean} pinned  turntable pin engaged (no ballast motion otherwise)
   * @returns {object[]} events: 'absorbed' {id}, 'raised' {kg}, 'lowered' {kg}, 'quick' {penalty}, 'paused' {reason}
   */
  update(dt, hold = true, pinned = true) {
    const ev = this.events;
    ev.length = 0;
    for (const e of this._pending) ev.push(e);
    this._pending.length = 0;
    const r = this.raising;
    if (!r) return ev;
    if (!pinned) { if (!r.paused) ev.push({ type: 'paused', reason: 'TURNTABLE NOT PINNED' }); r.paused = true; return ev; }
    if (!hold) { r.paused = true; return ev; }
    r.paused = false;
    r.t += dt;
    if (r.t >= r.dur) this._finish(false);
    return ev;
  }

  _finish(quick) {
    const r = this.raising;
    if (!r) return;
    if (r.dir > 0) {
      for (const s of this.deckStack) this.superSlabs.push(s.id);
      this.deckStack.length = 0;
      this._emit({ type: 'raised', kg: this.superKg }, quick);
    } else {
      for (const id of this.superSlabs) this.deckStack.push(slabRec(id));
      this.superSlabs.length = 0;
      this._emit({ type: 'lowered', kg: this.deckKg }, quick);
    }
    // keep the frame's make-up order A, B, C
    this.superSlabs.sort();
    if (quick) this._emit({ type: 'quick', penalty: BALLAST.quickPenalty }, true);
    this.raising = null;
  }

  // inside update() events go straight out; from start*/absorb they wait for the next update()
  _emit(e, pending) { (pending ? this._pending : this.events).push(e); }
}
