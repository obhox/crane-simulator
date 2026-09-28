// Machine contract shared by the tower crane (src/machines/towerMachine.js)
// and the AT-100 mobile crane (src/mobile/mobileMachine.js). main.js is the
// host: it owns the world, loads, jobs, HUD, cameras, audio and input, and
// drives every machine through this interface. Frozen after Phase 0 (spec §9.1).
//
// Host call order
//   construction: new XMachine(ctx); the machine adds its own meshes to
//                 ctx.scene, the host keeps m.colliders registered in ctx.world
//                 (re-synced after every step), then calls reset(start).
//   switching:    old.canPark() → old.park() → active = new → new.activate()
//   per 120 Hz step (state !== 'pause'):
//       for m of machines: m.step(dt, m === active ? (play ? input : NEUTRAL) : NULL_INPUT)
//       wind.update(dt)
//   per frame:
//       jobs.update(dt, active.levers, input.horn)          (state 'play')
//       m.updateVisuals(dt, t, night) for every machine
//       cameras.update(...)  with active.cameraRig()
//       hs = active.hudState() + host fields → hud.update(hs); active.updateCabScreen?.(dt, hs)
//       audio.update(dt, tower.audioState(mode, host)); audio.updateMobile?.(dt, mobile.audioState(mode, host))
//   actions (input.consume()): 'pause', 'camera'/'nextcam', 'switchMachine', 'voice'
//       are generic; 'hook' is offered to active.handleAction first (return true
//       = consumed, e.g. releasing a stowed block), otherwise the host runs the
//       generic hook-on / release path (findAttachable / canRelease on
//       active.hoist, then active.onRelease(load) and jobs.onRelease(load));
//       every other action goes to active.handleAction(action, api).

/**
 * Per-step input. The host passes its Input instance to the active machine
 * while playing, NEUTRAL_INPUT (levers zero, micro mirrored) to the active
 * machine otherwise, and NULL_INPUT to inactive machines.
 * @typedef {object} MachineInput
 * @property {{slew:number, trolley?:number, hoist:number, tele?:number, luff?:number}} levers
 *   tower: slew +right, trolley +out, hoist +up; mobile-crane: slew +right, tele +out, luff +up, hoist +up
 * @property {{throttle:number, brake:number, steer:number}} [drive]  mobile-drive (steer +right)
 * @property {{beam:number, jack:number, autoLevel?:boolean, ballast?:boolean}} [setup]  mobile-setup (+extend / +float down; G / B held)
 * @property {boolean} micro   micromove (10 %)
 * @property {number} tag      tag line −1..1
 * @property {boolean} horn
 * @property {boolean} [timeWarp]  hold-Z ×4 (mobile, §3.4 rules). The HOST applies the warp (more fixed
 *   steps per frame, job time scaled) when settings.timeWarp && input.timeWarp && active.canTimeWarp?.();
 *   machines never scale dt themselves.
 *
 * Discrete presses (select float, mat, pin, gear, program, config dialog, ...) never travel in this
 * object: they arrive once, per frame, through handleAction(action, api); a machine that needs them in
 * step() queues them itself. HELD controls (auto-level G, ballast B, horn, micro, tag, time warp) are
 * input state fields — input.js exposes them (e.g. input.setup.autoLevel / input.setup.ballast).
 */

/**
 * Host API handed to handleAction(action, api).
 * @typedef {object} HostApi
 * @property {(text:string, kind?:'info'|'good'|'warn'|'bad')=>void} toast
 * @property {import('../loads.js').Load[]} loads      shared load list (both machines)
 * @property {import('../physics/collide.js').ColliderWorld} world
 * @property {object} audio        AudioSys
 * @property {object} input        Input (anyLeverOffNeutral, profile, ...)
 * @property {object} settings     live settings object
 * @property {(key:string, value:any, save?:boolean)=>void} applySetting
 * @property {()=>void} saveSettings
 * @property {(type:string, x:number, z:number, yaw?:number, baseY?:number)=>object} spawnLoad
 * @property {(load:object)=>void} removeLoad
 * @property {object} hud
 * @property {object} jobs         JobRunner
 * @property {object} sim          the sim object jobs use (sim.machine = active)
 */

/**
 * Construction context (same object for every machine).
 * @typedef {object} MachineCtx
 * @property {THREE.Scene} scene
 * @property {import('../physics/collide.js').ColliderWorld} world
 * @property {import('../physics/wind.js').Wind} wind
 * @property {object} terrain      buildTerrain() result (heightAt(x, z))
 * @property {object} streets      buildStreets() result (traffic, peds, ...)
 * @property {object} site         buildSite() result
 * @property {object} audio        AudioSys
 * @property {object} hud          Hud (toast etc.)
 * @property {object} settings     live settings object (read only for machines, except via api.applySetting)
 * @property {object[]} loads      shared load list
 * @property {object} [craneMats]  createCraneMaterials() set of the tower (reuse; do not mutate)
 * @property {(machine:Machine, impact:{speed:number, kind:string, tag?:string, mass:number})=>void} onImpact
 *   report a hook / load impact (host plays nothing; it forwards to jobs when machine is active)
 */

/** @interface Machine
 * id:'tower'|'mobile'; label; root:THREE.Object3D; hoist:HoistSystem; power:boolean
 * inputProfile(): 'tower'|'mobile-drive'|'mobile-setup'|'mobile-crane'
 * cameraModes(): string[]                  // cycle list for the current state (first = default)
 * cameraRig(): { cab:{parent,headPos,baseYaw}, driver?, hook:{parent}, chaseTarget(out,dt), focus(out) }
 * colliders: Box[]                          // owned boxes, kept in world by main; updated in step()
 * counters: { twoBlockCount, lmiTrips }     // used by jobs (existing KPIs)
 * hoistSpeed: number                        // m/s, + up (for test-lift detection)
 * reset(start)                              // tower: {slew,trolley,ropeLen,attach}; mobile: MobileStart
 * park(); activate()
 * handleAction(action, api) -> boolean      // api = {toast, loads, world, audio, spawnLoad, removeLoad}
 * step(dt, input)                           // 120 Hz; input zeroed when inactive/paused
 * updateVisuals(dt, t, night)
 * onRelease(load) -> boolean                // true = absorbed (ballast slab)
 * hudState() -> object                      // common fields (payload, capacity, ratio, lmiState, radius, hookHeight, slewDeg, wind, power, eStop, levers, cameraName...) + machine:'tower'|'mobile' + mobile:{...§8.8}
 * audioState(cameraMode) -> object
 * signallerGeometry() -> { cx, cz, radialOut:'Trolley out'|'Boom down', radialIn:'Trolley in'|'Boom up' }
 */

/**
 * Full Phase-0 contract (the spec block above plus the details the host relies on).
 * @typedef {object} Machine
 * @property {'tower'|'mobile'} id
 * @property {string} label                 e.g. 'Tower TC-6010', 'Mobile AT-100 5.1'
 * @property {THREE.Object3D} root          the machine's scene root (already added to ctx.scene)
 * @property {import('../physics/rope.js').HoistSystem} hoist   its own HoistSystem (loads are shared)
 * @property {boolean} power                crane control power (read by the host / HUD)
 * @property {boolean} eStop
 * @property {import('../physics/collide.js').Box[]} colliders  owned boxes; the host registers them in
 *   ctx.world and re-syncs after every step (add missing / remove dropped). Mutate boxes in place in step().
 * @property {import('../physics/collide.js').Box[]} [boomColliders]  mobile: the subset of `colliders` along its
 *   boom (tag 'mobileBoom'), there for the OTHER machine's hook and load; the machine switches them off while it
 *   steps itself, and the host skips them when it asks what lies under this machine's own load (jobs.supportBelow)
 * @property {{twoBlockCount:number, lmiTrips:number}} counters  monotonic counters (jobs diff them)
 * @property {number} hoistSpeed            m/s, + = hook up
 * @property {object} levers                lever set actually applied last step (after assists)
 * @property {boolean} parked               true while park()ed (inactive)
 * @property {() => string} inputProfile
 * @property {() => string[]} cameraModes
 * @property {() => CameraRigSpec} cameraRig
 * @property {(start:object) => void} reset
 * @property {() => {ok:boolean, reason?:string}} canPark   host asks before switching away
 * @property {() => void} park              called when the machine becomes inactive
 * @property {() => void} activate          called when the machine becomes active
 * @property {(action:string, api:HostApi) => boolean} handleAction   true = consumed
 * @property {(dt:number, input:MachineInput) => void} step
 * @property {(dt:number, t:number, night:number) => void} updateVisuals
 * @property {(load:object) => boolean} onRelease  true = absorbed (e.g. ballast slab onto the deck)
 * @property {() => object} hudState        machine fields; host adds cameraName, attachable, canRelease,
 *   job, jobTime, showHints (and machine = id if missing)
 * @property {(dt:number, hudState:object) => void} [updateCabScreen]  optional, active machine only
 * @property {(cameraMode:string, host:AudioHost) => object} audioState
 * @property {() => {cx:number, cz:number, radialOut:string, radialIn:string}} signallerGeometry
 * @property {() => {x:number, z:number, hx:number, hz:number, yaw:number}[]} [vehicleObstacles]  mobile only;
 *   the host feeds it to streets.traffic.setObstacles / streets.peds.setObstacles every frame (return a cached array)
 * @property {() => boolean} [canTimeWarp]  hold-Z ×4 time allowed now (§3.4: never with a suspended load);
 *   absent = never (the tower)
 */

/**
 * @typedef {object} CameraRigSpec
 * @property {{parent:THREE.Object3D, headPos:THREE.Vector3, baseYaw:number}} cab  operator eye: head pivot
 *   position in parent space; baseYaw = yaw that looks along the parent's working direction
 *   (tower: −π/2 so the default camera −z view turns to look along +x = jib)
 * @property {{parent:THREE.Object3D, headPos:THREE.Vector3, baseYaw:number}} [driver]  mobile driver eye
 * @property {{parent:THREE.Object3D, pos?:THREE.Vector3}} hook  level mount above the hook (camera looks down)
 * @property {THREE.Object3D} [carrier]     mobile: the carrier group (local +X = forward, +Y = up), for the
 *   chase / setup cameras to read the vehicle pose from its matrixWorld
 * @property {(out:THREE.Vector3, dt:number) => THREE.Vector3} [chaseTarget]  chase camera look-at point
 * @property {(out:THREE.Vector3) => THREE.Vector3} [setupTarget]  world centre of the selected float (setup camera)
 * @property {(out:THREE.Vector3) => THREE.Vector3} focus  what the operator watches (load, else hook)
 */

/**
 * @typedef {object} AudioHost
 * @property {boolean} active   this machine is the active one
 * @property {boolean} playing  host state === 'play'
 * @property {boolean} menu     host state === 'menu'
 * @property {boolean} horn     horn pressed (active machine, playing)
 */

/**
 * Tower start (reset argument of TowerMachine).
 * @typedef {{slew?:number, trolley?:number, ropeLen?:number, attach?:object|null}} TowerStart
 */

/** MobileStart = { mode:'ROAD'|'SETUP'|'CRANE', pos:{x,z}, yaw, beams:[4 x 0|0.5|1], jacksSet:bool, mats:[4 x 'none'|'carried'|'composite'],
 *   levelled:bool, cwKg, deckSlabs:[], rcl:{mode,base,cwKg,block,confirmed}, block, boomK (0..11), luffDeg, slewDeg, ropeLen, attach, siteTravel:bool } */
/**
 * @typedef {object} MobileStart
 * @property {'ROAD'|'SETUP'|'CRANE'} mode
 * @property {{x:number, z:number}} pos      slew-axis point (world)
 * @property {number} yaw                    carrier yaw φ (rotation.y)
 * @property {number[]} beams                4 × 0 | 0.5 | 1, order FL, FR, RL, RR
 * @property {boolean} jacksSet              floats down and carrying (tyres clear)
 * @property {string[]} mats                 4 × 'none' | 'carried' | 'composite'
 * @property {boolean} levelled              auto-levelled to ±0.3°
 * @property {number} cwKg                   counterweight ON the superstructure (0 | 11500 | 23500 | 35000)
 * @property {string[]} deckSlabs            slab ids lying on the carrier deck, bottom first ('A' | 'B' | 'C')
 * @property {{mode:'outriggers'|'tyres', base:100|50|0, cwKg:number, block:string, confirmed:boolean}} rcl
 *   RCL config pre-filled at power-on (may deliberately differ from reality, e.g. job M5)
 * @property {'ball'|'hb26'|'hb60'|'hb90'} block   reeved hook block
 * @property {number} boomK                  pinned telescope step 0..11 (L = PINNED_LENGTHS[k])
 * @property {number} luffDeg                boom angle θ (frame-relative)
 * @property {number} slewDeg                ψ in degrees (+ = toward the left, §0)
 * @property {number|null} ropeLen           fall length ℓ (sheave → hook); null = stowed on the bumper
 * @property {object|null} attach            Load hanging on the hook at start
 * @property {boolean} siteTravel            M6 exception: may travel on site with CW mounted
 */

import { Vector3 } from 'three';
import { MOBILE_STARTS } from '../mobile/config.js';

const ZERO_LEVERS = Object.freeze({ slew: 0, trolley: 0, hoist: 0, tele: 0, luff: 0 });

// Input for inactive machines: every control neutral.
export const NULL_INPUT = Object.freeze({
  levers: ZERO_LEVERS,
  drive: Object.freeze({ throttle: 0, brake: 0, steer: 0 }),
  setup: Object.freeze({ beam: 0, jack: 0, autoLevel: false, ballast: false }),
  micro: false, tag: 0, horn: false, timeWarp: false,
});

// Input for the active machine outside 'play' (menu / results): levers zero,
// but the micromove switch still mirrors the real input (the tower's HUD
// lamp always did) — `micro` is filled in by the host each step.
export function neutralInput(micro = false) {
  return { levers: ZERO_LEVERS, drive: NULL_INPUT.drive, setup: NULL_INPUT.setup, micro, tag: 0, horn: false, timeWarp: false };
}

// plain-data deep copy (presets are frozen; loads are passed by reference below)
const clone = (o) => (o === null || typeof o !== 'object' ? o : Array.isArray(o) ? o.map(clone) : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clone(v)])));

/**
 * Mutable MobileStart from a preset ('pad' | 'road') plus overrides
 * (shallow per key, nested rcl merged).
 * @param {'pad'|'road'} preset
 * @param {Partial<MobileStart>} [over]
 * @returns {MobileStart}
 */
export function makeMobileStart(preset = 'pad', over = {}) {
  const base = clone(MOBILE_STARTS[preset] || MOBILE_STARTS.pad);
  const { rcl, attach, ...rest } = over;
  Object.assign(base, clone(rest));
  if (rcl) Object.assign(base.rcl, rcl);
  if (attach !== undefined) base.attach = attach; // Load objects are passed by reference
  return base;
}

// Degrees shown on the slew readout: clockwise from the reference (same for both machines).
export const displaySlewDeg = (rad) => (((-rad * (180 / Math.PI)) % 360) + 360) % 360;

// ------------------------------------------------------------------ generic hook-on (host)
// The riggers can only sling a load while the hook bowl is within the slings' reach: hook →
// load CoG ≤ load.hangLength, the length the rope system's sling constraint enforces. A hook held
// higher than that is over the load but cannot be hooked on: attaching there would let the sling
// constraint snatch the load up by the whole over-reach in one solver step (tonnes of rope force,
// a launched load, a tipped mobile crane).
//   horiz / below / high: the search window above the load top (hint "lower the hook")
//   slack: reach tolerance (m); 2 cm keeps the take-up snatch below ~4 t on the stiffest slings
export const HOOK_REACH = Object.freeze({ horiz: 1.3, below: 0.3, high: 1.2, slack: 0.02 });
const _top = new Vector3();

/**
 * Nearest free load under the hook for the generic hook-on path.
 * @param {import('../physics/rope.js').HoistSystem} hoist
 * @param {object[]} loads  shared load list
 * @returns {{load:object, reach:boolean, over:number}|null}  reach false: over the load but the slings
 *   do not reach yet (over = metres the hook must still come down); null: nothing under the hook
 */
export function findAttachable(hoist, loads) {
  if (!hoist || hoist.load || hoist.stowed) return null;
  const h = hoist.hook, R = HOOK_REACH;
  let best = null, bestScore = Infinity, bestReach = false, bestOver = 0;
  for (const l of loads) {
    if (l.attached || l.absorbed) continue;
    l.topCenter(_top);
    const horiz = Math.hypot(h.x - _top.x, h.z - _top.z);
    const dy = h.y - _top.y;
    if (!(horiz < R.horiz && dy > -R.below && dy < l.def.sling + R.high)) continue;
    const over = h.distanceTo(l.pos) - l.hangLength;
    const reach = over <= R.slack;
    // a load the slings reach beats one they do not; then the closest
    const score = horiz + Math.abs(dy) * 0.1 + (reach ? 0 : 1000);
    if (score < bestScore) { best = l; bestScore = score; bestReach = reach; bestOver = Math.max(0, over); }
  }
  return best ? { load: best, reach: bestReach, over: bestOver } : null;
}
