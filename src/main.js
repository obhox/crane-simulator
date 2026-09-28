import * as THREE from 'three';
import { SITE, PHYS, QUALITY, G } from './config.js';
import { Environment } from './world/environment.js';
import { buildSite, updateSite } from './world/site.js';
import { buildTerrain } from './world/terrain.js';
import { buildStreets } from './world/streets.js';
import { loadAssets } from './world/assets.js';
import { createRenderPipeline } from './world/postfx.js';
import { buildCity } from './world/city.js';
import { ColliderWorld } from './physics/collide.js';
import { Wind } from './physics/wind.js';
import { Load } from './loads.js';
import { Input, setupTouchControls } from './input.js';
import { CameraRig, CAMERA_NAMES } from './cameras.js';
import { AudioSys } from './audio.js';
import { Signaller } from './signaller.js';
import { JobRunner, JOBS } from './jobs.js';
import { Hud } from './hud.js';
import { TowerMachine } from './machines/towerMachine.js';
import { MobileMachine } from './mobile/mobileMachine.js';
import { NULL_INPUT, neutralInput, makeMobileStart } from './machines/machine.js';
import { MOBILE_SETTINGS, TIME_WARP } from './mobile/config.js';

// Host for the machines (src/machines/machine.js contract): owns the world,
// shared loads, jobs, HUD, cameras, audio and input, and drives the tower
// crane and the AT-100 mobile crane. Both machines always exist; the inactive
// one is parked and keeps stepping with neutral input (spec §8.6, §9.2).

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  quality: matchMedia('(pointer: coarse)').matches ? 'low' : 'high',
  hour: 10.5, weather: 'cloudy', windMean: 4, gustiness: 0.5, windDir: 35, falls: 2, slewMode: 1,
  swayAssist: false, isoHoist: false, voice: true, volume: 0.8, zoneLimiter: true, autoLook: true, showHints: true,
  ...MOBILE_SETTINGS, // machine, mobileStart, siteSpeedLimit, quickBallast, allowBypass, timeWarp
};
function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tcsim.settings') || '{}') };
  } catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('tcsim.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
const settings = loadSettings();
const Q = () => QUALITY[settings.quality] || QUALITY.high;

// ------------------------------------------------------------------ renderer
const app = document.getElementById('app');
// the post pipeline renders into its own 4x MSAA target, so canvas MSAA would only waste memory
const renderer = new THREE.WebGLRenderer({ antialias: Q().antialias && !Q().post, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q().pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in r18x
app.appendChild(renderer.domElement);

// load CC0 assets before building the world (loading screen shows progress)
const loadingText = document.querySelector('#loading .loading-status, #loading [data-status]') || null;
await loadAssets((f, label) => {
  const el = document.getElementById('loading');
  if (!el) return;
  el.style.setProperty('--progress', String(f));
  if (loadingText) loadingText.textContent = `Loading ${label || ''} ${Math.round(f * 100)}%`;
}, { renderer, quality: settings.quality });

const scene = new THREE.Scene();
const world = new ColliderWorld();
const env = new Environment(renderer, scene);
env.setShadowMapSize(Q().shadowMap);
const terrain = buildTerrain(scene, SITE, Q());
const site = buildSite(scene, world, Q());
const city = buildCity(scene, Q().city);
const streets = buildStreets(scene, Q());
const pipeline = createRenderPipeline(renderer, scene);
pipeline.setQuality(Q());

// ------------------------------------------------------------------ machines
const wind = new Wind();
const audio = new AudioSys();
const loads = [];
let active = null; // the machine the player operates
let jobs = null;

// shared construction context (hud is filled in once it exists)
const ctx = {
  scene, world, wind, terrain, streets, site, audio, settings, loads, hud: null, craneMats: null,
  // impacts: machines play the sound, the host forwards the active machine's to the job KPIs
  onImpact: (m, ev) => { if (m === active && jobs) jobs.onImpact(ev); },
};

// every machine's owned boxes stay registered in the collider world
const registered = new Map();
function syncColliders(m) {
  let reg = registered.get(m);
  if (!reg) registered.set(m, (reg = new Set()));
  const list = m.colliders;
  let same = list.length === reg.size;
  for (let i = 0; same && i < list.length; i++) same = reg.has(list[i]);
  if (same) return;
  for (const b of reg) if (!list.includes(b)) { world.remove(b); reg.delete(b); }
  for (const b of list) if (!reg.has(b)) { world.add(b); reg.add(b); }
}

const tower = new TowerMachine(ctx);
syncColliders(tower);
ctx.craneMats = tower.parts.mats;
const mobile = new MobileMachine(ctx);
syncColliders(mobile);
const machines = { tower, mobile };
const machineList = [tower, mobile];
active = tower;

const input = new Input();
const cameras = new CameraRig(renderer, tower.parts);
ctx.cameras = cameras; // machines shake the view on a slam / overturn

const hud = new Hud(document.getElementById('hud'), {
  onFreePlay: () => startFreePlay(),
  onStartJob: (id) => startJob(id),
  onResume: () => setPaused(false),
  onQuit: () => toMenu(),
  onRetry: () => currentJobId && startJob(currentJobId),
  onNextJob: () => {
    const i = JOBS.findIndex((j) => j.id === currentJobId);
    startJob(JOBS[(i + 1) % JOBS.length].id);
  },
  onSetting: (k, v) => applySetting(k, v, true),
  onPowerClick: () => input.push('power'),
  onCameraClick: () => input.push('camera'),
  onPauseClick: () => input.push('pause'),
  getSettings: () => settings,
});
ctx.hud = hud;
const signaller = new Signaller(audio, (t) => hud.radio(t));

const sim = {
  scene, world, site, terrain, wind, audio, hud, signaller, settings, guidance: true, machines,
  get machine() { return active; }, // jobs: the active machine (reset, counters, hoistSpeed, signallerGeometry)
  // back-compat for tower-only code paths
  get crane() { return tower.crane; },
  get hoist() { return tower.hoist; },
  get safety() { return tower.safety; },
  spawnLoad, clearLoads, removeLoad,
  resetCrane: (o) => active.reset(o),
  setMachine: (id, opts) => setMachine(id, opts),
};
jobs = new JobRunner(sim);
ctx.jobs = jobs; // mobile: composite-mat stock, job-aware toasts

// ------------------------------------------------------------------ loads
function spawnLoad(type, x, z, yaw = 0, baseY = 0) {
  const l = new Load(type, x, z, yaw, baseY);
  scene.add(l.mesh);
  world.add(l.box);
  loads.push(l);
  return l;
}

function removeLoad(l) {
  for (const m of machineList) if (m.hoist.load === l) m.hoist.detach();
  scene.remove(l.mesh);
  world.remove(l.box);
  const i = loads.indexOf(l);
  if (i >= 0) loads.splice(i, 1);
}

// machines absorb / remove loads themselves (ballast slabs landed on the carrier deck)
ctx.spawnLoad = spawnLoad;
ctx.removeLoad = removeLoad;

function clearLoads() {
  for (const m of machineList) if (m.hoist.load) m.hoist.detach();
  for (const l of loads) {
    scene.remove(l.mesh);
    world.remove(l.box);
  }
  loads.length = 0;
}

// ------------------------------------------------------------------ settings
function applySetting(key, value, save = false) {
  settings[key] = value;
  switch (key) {
    case 'quality':
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, Q().pixelRatio));
      env.setShadowMapSize(Q().shadowMap);
      pipeline.setQuality(Q());
      pipeline.setSize(window.innerWidth, window.innerHeight);
      terrain.setQuality?.(Q());
      break;
    case 'hour':
      env.setTime(value);
      break;
    case 'weather':
      env.setWeather?.(value);
      break;
    case 'windMean':
      if (!jobs.job) wind.setMean(value);
      break;
    case 'gustiness':
      if (!jobs.job) wind.gustiness = value;
      break;
    case 'windDir':
      wind.baseDir = THREE.MathUtils.degToRad(value);
      break;
    case 'falls':
      if (!tower.setFalls(value)) {
        hud.toast('Land and release the load before changing the reeving', 'warn');
        settings.falls = tower.crane.falls;
      }
      break;
    case 'slewMode': tower.setSlewMode(value); break;
    case 'isoHoist': input.isoHoist = !!value; break;
    case 'voice': signaller.voiceOn = !!value; break;
    case 'volume': audio.volume = Number(value); break;
    case 'zoneLimiter': tower.setZoneLimiter(value); break;
    case 'autoLook': cameras.autoLook = !!value; break;
    default: break; // machine / mobileStart / siteSpeedLimit / ... are read live from `settings`
  }
  if (save) saveSettings();
}
for (const k of Object.keys(settings)) applySetting(k, settings[k]);

// ------------------------------------------------------------------ machine switching
let modesKey = '';
// cameras: machine-aware CameraRig (attach/setModes, Phase 1) or the original
// rig, whose cab head and hook cameras are simply re-parented to the machine
function attachCameras(m) {
  const rig = m.cameraRig();
  if (typeof cameras.attach === 'function') {
    cameras.attach(rig);
  } else {
    if (cameras.head.parent !== rig.cab.parent) {
      cameras.head.position.copy(rig.cab.headPos);
      rig.cab.parent.add(cameras.head);
    }
    if (cameras.hookCam.parent !== rig.hook.parent) {
      const p = rig.hook.pos || new THREE.Vector3(0, -0.5, 0);
      cameras.hookCam.position.copy(p);
      cameras.pipCam.position.copy(p);
      rig.hook.parent.add(cameras.hookCam);
      rig.hook.parent.add(cameras.pipCam);
    }
  }
  modesKey = '';
}
// input profile and camera cycle follow the active machine's mode every frame
function syncMachineUi() {
  const prof = active.inputProfile();
  if (input.profile !== prof) input.profile = prof;
  const modes = active.cameraModes();
  const key = modes.join(',');
  if (key !== modesKey) {
    modesKey = key;
    if (typeof cameras.setModes === 'function') cameras.setModes(modes);
  }
}

function setMachine(id, { force = false, silent = false } = {}) {
  const next = machines[id];
  if (!next) return false;
  if (next === active) {
    if (next.parked) next.activate();
    for (const m of machineList) if (m !== active && !m.parked) m.park(); // e.g. after a reset
    syncMachineUi();
    return true;
  }
  if (!force) {
    if (jobs.job) { hud.toast('Machine switching is only available in free play', 'warn'); return false; }
    const c = active.canPark ? active.canPark() : { ok: true };
    if (!c.ok) { hud.toast(c.reason || 'Cannot switch now', 'warn'); return false; }
  }
  active.park();
  active = next;
  active.activate();
  attachCameras(active);
  hud.setMachine?.(active.id);
  syncMachineUi();
  if (typeof cameras.setModes !== 'function') cameras.setMode(cameras.mode);
  if (!silent) hud.toast(`Now operating: ${active.label} — P to power on`, 'info');
  return true;
}

function switchMachine() {
  if (jobs.job) { hud.toast('Machine switching is only available in free play', 'warn'); return; }
  setMachine(active === tower ? 'mobile' : 'tower');
}

// ------------------------------------------------------------------ game flow
let state = 'menu'; // menu | play | pause | results
let currentJobId = null;
let menuAngle = 0.6;

function startFreePlay() {
  jobs.stop();
  hud.jobHide();
  hud.closeMobileDialogs?.();
  hud.closeBallastPanel?.();
  currentJobId = null;
  clearLoads();
  wind.setMean(settings.windMean);
  wind.gustiness = settings.gustiness;
  spawnLoad('testWeight', -24, 22, 0.3, 0);
  spawnLoad('rebar', -29, -8, 0, 0.1);
  spawnLoad('rebar', -24.5, -8.4, 0.05, 0.1);
  spawnLoad('bricks', -20, 1, 0.2, 0.1);
  spawnLoad('pallet', -24.5, 1, 0, 0.1);
  spawnLoad('container', -34, 11, 0.1, 0);
  spawnLoad('shutter', -16, 12, 0.05, 0.1);
  spawnLoad('bucket', -15, -24, 0, 0);
  spawnLoad('beam', 4.8, -22.2, -0.15, 1.34);
  // §8.10 mobile extras near P1 (test block, precast, generator; ballast truck for the road start)
  jobs.spawnFreePlay({ mobileStart: settings.mobileStart });
  tower.reset({ slew: 2.5, trolley: 22, ropeLen: 18 });
  mobile.reset(makeMobileStart(settings.mobileStart === 'road' ? 'road' : 'pad'));
  setMachine(settings.machine === 'mobile' ? 'mobile' : 'tower', { force: true, silent: true });
  signaller.enabled = false;
  signaller.reset();
  enterPlay();
  hud.toast('Free play — press P to power on (levers in neutral)', 'info');
}

function startJob(id) {
  const def = JOBS.find((j) => j.id === id);
  if (!def) return;
  currentJobId = id;
  hud.closeMobileDialogs?.();
  hud.closeBallastPanel?.();
  // a job carries its machine; the other one is reset to its default and parked
  const mid = def.machine === 'mobile' ? 'mobile' : 'tower';
  clearLoads();
  if (mid === 'tower') mobile.reset(makeMobileStart('pad'));
  else tower.reset();
  setMachine(mid, { force: true, silent: true });
  jobs.start(def);
  hud.jobShow(def);
  if (active.hoist.load) hud.toast('Load is on the hook', 'info');
  enterPlay();
  hud.toast('Press P to power on — sound the horn (H) before moving', 'info');
}

function enterPlay() {
  state = 'play';
  hud.hideMenu();
  // a job / free play started programmatically (__sim.startJob) while a results or other
  // HUD screen is still up: close it, or the mobile dialogs would not get the keyboard
  for (let i = 0; i < 6 && hud.anyModalOpen; i++) hud.back?.();
  hud.showPause(false);
  input.enabled = true;
  if (cameras.mode === 'orbit' && !cameras.controls.enabled) cameras.setMode('cab');
  cameras.setMode(cameras.mode);
}

function toMenu() {
  jobs.stop();
  hud.jobHide();
  state = 'menu';
  hud.showPause(false);
  hud.showMenu();
  active.power = false;
}

function setPaused(p) {
  if (p && state === 'play') {
    state = 'pause';
    hud.showPause(true);
  } else if (!p && state === 'pause') {
    state = 'play';
    hud.showPause(false);
  }
}

// ------------------------------------------------------------------ hook helpers (generic)
const _a = new THREE.Vector3();

function findAttachable(hoist) {
  if (hoist.load) return null;
  const h = hoist.hook;
  let best = null, bd = Infinity;
  for (const l of loads) {
    if (l.attached) continue;
    l.topCenter(_a);
    const horiz = Math.hypot(h.x - _a.x, h.z - _a.z);
    const dy = h.y - _a.y;
    if (horiz < 1.3 && dy > -0.3 && dy < l.def.sling + 1.2 && horiz + Math.abs(dy) * 0.1 < bd) {
      best = l;
      bd = horiz;
    }
  }
  return best;
}

function canRelease(hoist) {
  const l = hoist.load;
  return !!l && hoist.loadGrounded && hoist.slingTension < l.mass * G * 0.2;
}

function hookAction(m) {
  const hoist = m.hoist;
  if (hoist.load) {
    if (canRelease(hoist)) {
      const l = hoist.detach();
      l.pos.y = Math.max(l.pos.y, l.half.y);
      l.sync();
      const absorbed = m.onRelease(l); // e.g. a ballast slab landed on the carrier deck
      if (!absorbed) hud.toast(`Released: ${l.def.name}`, 'info');
      jobs.onRelease(l);
    } else if (!hoist.loadGrounded) hud.toast('Cannot release a suspended load — land it first', 'bad');
    else hud.toast('Slack the slings first (lower the hook a little)', 'warn');
  } else {
    const l = findAttachable(hoist);
    if (l) {
      hoist.attach(l);
      hud.toast(`Rigger: hooked on — ${l.def.name}`, 'good');
    } else hud.toast('No load within reach — lower the hook onto the load', 'warn');
  }
}

// ------------------------------------------------------------------ actions
const api = {
  toast: (t, k) => hud.toast(t, k), loads, world, audio, input, settings, applySetting, saveSettings,
  spawnLoad, removeLoad, hud, jobs, sim, cameras,
};

function processAction(a) {
  audio.init();
  if (a === 'pause') {
    if (state === 'play') setPaused(true);
    else if (state === 'pause') setPaused(false);
    return;
  }
  if (state !== 'play') return;
  switch (a) {
    case 'hook':
      // the machine sees it first (e.g. releasing a block stowed on the bumper)
      if (!active.handleAction('hook', api)) hookAction(active);
      break;
    case 'camera':
    case 'nextcam': {
      const m = cameras.next();
      hud.toast(CAMERA_NAMES[m] || m, 'info');
      break;
    }
    case 'switchMachine':
      switchMachine();
      break;
    case 'voice':
      sim.guidance = !signaller.enabled;
      signaller.enabled = sim.guidance;
      signaller.reset();
      hud.toast(`Signaller guidance ${signaller.enabled ? 'ON' : 'OFF'}`, 'info');
      break;
    default:
      active.handleAction(a, api); // power, estop, freeslew, slewmode, sway, machine-specific keys
      break;
  }
}

function handleActions() {
  for (const a of input.consume()) processAction(a);
}

// Tab switches machine (free play). input.js may map it itself ('switchMachine');
// its keydown listener runs first, so only add the action if it did not.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Tab' || e.repeat || state !== 'play') return;
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  e.preventDefault();
  if (document.body.dataset.hudModal) return; // a HUD dialog owns the keyboard
  if (!input.actions.includes('switchMachine')) input.push('switchMachine');
});

// ------------------------------------------------------------------ physics
const _neutral = neutralInput();

function stepPhysics(dt) {
  const playing = state === 'play';
  for (const m of machineList) {
    let inp = NULL_INPUT;
    if (m === active) {
      if (playing) inp = input;
      else { _neutral.micro = input.micro; inp = _neutral; }
    }
    m.step(dt, inp);
    syncColliders(m);
  }
  wind.update(dt);
}

// gameplay tick without rendering (QA / autopilot): n fixed steps + job logic
function advance(seconds) {
  const FIX = 1 / PHYS.rate;
  const n = Math.max(1, Math.round(seconds / FIX));
  for (let i = 0; i < n; i++) {
    stepPhysics(FIX);
    if (state === 'play') {
      const h = active.hoist;
      if (h.load) jobs.supportBelow = world.heightAt(h.load.pos.x, h.load.pos.z);
      jobs.update(FIX, active.levers, input.horn);
      if (jobs.job && jobs.done) state = 'results';
    }
  }
}

// ------------------------------------------------------------------ HUD state
function hudState() {
  const s = active.hudState();
  const h = active.hoist;
  if (!s.machine) s.machine = active.id;
  s.cameraName = CAMERA_NAMES[cameras.mode] || cameras.mode;
  s.attachable = !!findAttachable(h);
  s.canRelease = canRelease(h);
  s.job = !!jobs.job;
  s.jobTime = jobs.t || 0;
  s.showHints = settings.showHints;
  // job set-up checklist (mobile 'setup' steps) for the HUD panel
  s.jobChecklist = jobs.checklist;
  if (s.mobile) s.mobile.checklist = jobs.checklist || undefined;
  return s;
}

// ------------------------------------------------------------------ main loop
const FIXED = 1 / PHYS.rate;
const NO_OBSTACLES = [];
let acc = 0;
let last = performance.now();
let time = 0;
const focus = new THREE.Vector3();

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  input.update(dt);
  handleActions();

  // hold-Z time warp (§3.4): only where the active machine allows it (never the tower)
  const warp = state === 'play' && settings.timeWarp && input.timeWarp && active.canTimeWarp?.() ? TIME_WARP : 1;
  if (state !== 'pause') {
    acc += dt * warp;
    const maxSteps = 16 * warp;
    let n = 0;
    while (acc >= FIXED && n < maxSteps) {
      stepPhysics(FIXED);
      acc -= FIXED;
      n++;
    }
    if (n >= maxSteps) acc = 0;
  }
  if (state === 'play') {
    const h = active.hoist;
    if (h.load) jobs.supportBelow = world.heightAt(h.load.pos.x, h.load.pos.z);
    jobs.update(dt * warp, active.levers, input.horn); // job time is sim time
    if (jobs.job && jobs.done) state = 'results';
  }
  syncMachineUi();

  // visuals: machines, then the world around them
  const night = env.nightFactor;
  for (const m of machineList) m.updateVisuals(dt, time, night);
  updateSite(site, dt, night);
  city.setNight(night);
  streets.setWind?.(wind.mean * (wind.factor ?? 1), wind.dir ?? 0.6);
  streets.update(dt, night);
  // the mobile crane in the carriageway is an obstacle for traffic and pedestrians (§7.1)
  const obstacles = mobile.vehicleObstacles ? mobile.vehicleObstacles() : NO_OBSTACLES;
  streets.traffic?.setObstacles?.(obstacles);
  streets.peds?.setObstacles?.(obstacles);
  terrain.update(dt, env);
  env.update(dt, time);

  if (debugView) {
    cameras.active = debugCam;
  } else if (state === 'menu') {
    menuAngle += dt * 0.04;
    const cam = cameras.orbitCam;
    cameras.controls.enabled = false;
    cam.position.set(Math.cos(menuAngle) * 92, 34 + Math.sin(menuAngle * 0.7) * 8, Math.sin(menuAngle) * 92);
    cam.lookAt(8, 28, 4);
    cameras.active = cam;
  } else {
    if (cameras.active === cameras.orbitCam && cameras.mode !== 'orbit') cameras.setMode(cameras.mode);
    if (cameras.mode === 'orbit' && !cameras.controls.enabled) cameras.setMode('orbit');
    if (typeof cameras.attach === 'function') cameras.update(dt, active);
    else {
      const rig = active.cameraRig();
      rig.focus(focus);
      cameras.update(dt, focus, rig.cab.parent.matrixWorld);
    }
  }

  const hs = hudState();
  hud.update(hs);
  active.updateCabScreen?.(dt, hs);

  // audio: the tower channel (motors, wind, horn, LMI) and, once audio.js has
  // it, the mobile channel; the inactive machine is mixed at idle
  const playing = state === 'play', menu = state === 'menu';
  const horn = input.horn && playing;
  const ts = tower.audioState(cameras.mode, { active: active === tower, playing, menu, horn: horn && (active === tower || !audio.updateMobile) });
  audio.mix = ts.mix;
  audio.update(dt, ts);
  if (typeof audio.updateMobile === 'function') {
    audio.updateMobile(dt, mobile.audioState(cameras.mode, { active: active === mobile, playing, menu, horn: horn && active === mobile }));
  }

  // render main view
  const cam = cameras.active;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  if (Q().post) pipeline.render(cam);
  else renderer.render(scene, cam);

  // hook camera monitor (picture-in-picture inside the cab LMI panel)
  const showPip = Q().hookCam && state !== 'menu' && cameras.mode !== 'hook';
  hud.setHookMonitorVisible(showPip);
  if (showPip) {
    const rect = hud.hookMonitorRect();
    if (rect && rect.width > 10) {
      const pip = cameras.pipCam;
      pip.aspect = rect.width / rect.height;
      pip.updateProjectionMatrix();
      const y = window.innerHeight - rect.bottom;
      renderer.setScissorTest(true);
      renderer.setScissor(rect.left, y, rect.width, rect.height);
      renderer.setViewport(rect.left, y, rect.width, rect.height);
      renderer.render(scene, pip);
      renderer.setScissorTest(false);
    }
  }
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameras.resize(window.innerWidth, window.innerHeight);
  pipeline.setSize(window.innerWidth, window.innerHeight);
});
const unlock = () => audio.init();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

if (matchMedia('(pointer: coarse)').matches) {
  hud.setTouchMode(true);
  setupTouchControls(input, document.getElementById('touch'));
}

// initial scene: free-play layout visible behind the title menu
attachCameras(active);
hud.setMachine?.(active.id);
startFreePlay();
state = 'menu';
hud.showMenu();
hud.hideLoading();
requestAnimationFrame(frame);

// debugging / automated verification hook (used by QA tooling):
//   __sim.view([x,y,z],[tx,ty,tz], fov?) → fixed debug camera; __sim.view(null) → back to normal cameras
//   __sim.hideHud(true|false)
//   __sim.machines / __sim.active / __sim.setMachine(id, {force}) → machine host
//   __sim.action(name) → process one input action now (as if pressed while playing)
//   __sim.advance(seconds) → fixed physics steps + job logic, no rendering
//   __sim.crane / hoist / safety / parts → the tower (back-compat)
const debugCam = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 9000);
let debugView = false;
window.addEventListener('resize', () => { debugCam.aspect = window.innerWidth / window.innerHeight; debugCam.updateProjectionMatrix(); });
window.__sim = {
  crane: tower.crane, hoist: tower.hoist, safety: tower.safety, wind, input, loads, jobs, world, cameras, settings, env,
  startJob, startFreePlay, stepPhysics, THREE,
  scene, renderer, pipeline, parts: tower.parts, site, city, streets, terrain, applySetting,
  machines, tower, mobile, setMachine, sim, hud, audio, action: processAction, advance, spawnLoad, removeLoad,
  get active() { return active; },
  get state() { return state; },
  view(pos, target, fov = 55) {
    if (!pos) { debugView = false; cameras.setMode(cameras.mode); return; }
    debugView = true;
    debugCam.fov = fov;
    debugCam.aspect = window.innerWidth / window.innerHeight;
    debugCam.updateProjectionMatrix();
    debugCam.position.set(...pos);
    debugCam.lookAt(...target);
  },
  hideHud(h = true) {
    document.getElementById('hud').style.display = h ? 'none' : '';
    const t = document.getElementById('touch');
    if (t) t.style.display = h ? 'none' : '';
  },
};
