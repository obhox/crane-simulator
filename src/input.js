import { clamp, approach } from './util/math.js';

// Maps keyboard / gamepad / touch onto the controls of the active machine.
// input.profile (set by the host from machine.inputProfile()) selects:
//
//   'tower'        two ISO 7752-3 master switches: left = slew (x) + trolley (y),
//                  right = hoist (y). levers {slew +right, trolley +out, hoist +up}.
//   'mobile-crane' ISO 7752-2 cross-shift layout (spec §6.2): left lever slew (x)
//                  + telescope (y, away = extend); right lever luff (x, LEFT =
//                  raise) + hoist (y). levers {slew +right, tele +out, luff +up, hoist +up}.
//   'mobile-drive' carrier driving (§6.3): drive {throttle 0..1, brake 0..1, steer −1..1 (+right), crawl}.
//   'mobile-setup' outrigger remote (§6.4): setup {beam −1..1 (+extend), jack −1..1
//                  (+extend = float down), autoLevel (G held), ballast (B held)}.
//
// levers / drive / setup are single objects mutated in place (machines may keep
// references). levers always carries all five keys; the ones the profile does
// not use stay 0, and every control of an inactive profile is 0, so a crane
// can never move while driving and vice versa. Discrete presses go through
// consume() as action names (ACTIONS below); held controls (horn, micro, tag,
// timeWarp, drive.crawl, setup.autoLevel / setup.ballast) are state fields.

export const PROFILES = ['tower', 'mobile-crane', 'mobile-drive', 'mobile-setup'];

// Keyboard → action per profile (non-repeating keydown). 'switchMachine' (Tab)
// is handled by the host (free play only); 'pause' by the host as well.
const KEY_ACTIONS = {
  tower: {
    KeyR: 'hook', KeyC: 'camera', KeyP: 'power', Space: 'estop', KeyV: 'voice',
    KeyF: 'freeslew', KeyM: 'slewmode', Escape: 'pause', KeyT: 'testlift', KeyB: 'sway',
    KeyL: 'lookback', KeyG: 'windoff', KeyN: 'nextcam', Tab: 'switchMachine',
  },
  // §6.2 "other crane-mode keys". The spec also lists J / L as luff alternates,
  // which collides with L = RCL config; the config key wins (it is the one the
  // power-on flow refers to) and luff stays on ← / → / RS-X / touch.
  'mobile-crane': {
    KeyR: 'hook', KeyC: 'camera', KeyP: 'power', Space: 'estop', KeyV: 'voice',
    KeyL: 'rclConfig', KeyO: 'reeving', KeyT: 'pin', KeyF: 'freeslew', KeyM: 'rclMute',
    Enter: 'toSetup', NumpadEnter: 'toSetup', Escape: 'pause', Tab: 'switchMachine',
  },
  // §6.3. Space = engine stop / start (toggle).
  'mobile-drive': {
    KeyX: 'gear', KeyK: 'program', KeyF: 'parkingBrake', KeyC: 'camera', Space: 'engine',
    Enter: 'toSetup', NumpadEnter: 'toSetup', Escape: 'pause', Tab: 'switchMachine', KeyV: 'voice',
  },
  // §6.4. Space is the remote's stop button ('estop'): the machine halts every
  // outrigger motion (a hand-held remote always has one).
  'mobile-setup': {
    Digit1: 'selectFL', Digit2: 'selectFR', Digit3: 'selectRL', Digit4: 'selectRR', Digit5: 'selectAll',
    Numpad1: 'selectFL', Numpad2: 'selectFR', Numpad3: 'selectRL', Numpad4: 'selectRR', Numpad5: 'selectAll',
    KeyX: 'mat', KeyT: 'pin', Enter: 'toCrane', NumpadEnter: 'toCrane', Backspace: 'toRoad',
    KeyC: 'camera', Space: 'estop', Escape: 'pause', Tab: 'switchMachine', KeyV: 'voice',
  },
};

// Gamepad (standard mapping) buttons → action on press, per profile.
// 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 Back, 9 Start, 10 LS, 11 RS, 12–15 D-pad up/down/left/right.
const PAD_ACTIONS = {
  tower: { 0: 'hook', 2: 'camera', 3: 'power', 8: 'estop', 9: 'pause' },
  'mobile-crane': { 0: 'hook', 2: 'camera', 3: 'power', 8: 'estop', 9: 'pause', 12: 'rclConfig', 13: 'toSetup', 14: 'pin', 15: 'freeslew' },
  'mobile-drive': { 0: 'gear', 2: 'camera', 3: 'parkingBrake', 4: 'program', 8: 'engine', 9: 'pause', 13: 'toSetup' },
  'mobile-setup': { 0: 'mat', 2: 'camera', 3: 'selectAll', 4: 'selectPrev', 5: 'selectNext', 8: 'estop', 9: 'pause', 12: 'toCrane', 13: 'toRoad', 14: 'pin' },
};

/** Every action name each profile can emit through consume() (keyboard, gamepad, touch). */
export const ACTIONS = {
  tower: ['hook', 'camera', 'power', 'estop', 'voice', 'freeslew', 'slewmode', 'pause', 'testlift', 'sway', 'lookback', 'windoff', 'nextcam', 'switchMachine'],
  'mobile-crane': ['hook', 'camera', 'power', 'estop', 'voice', 'rclConfig', 'reeving', 'pin', 'freeslew', 'rclMute', 'toSetup', 'pause', 'switchMachine', 'bypass'],
  'mobile-drive': ['gear', 'program', 'parkingBrake', 'camera', 'engine', 'toSetup', 'pause', 'switchMachine', 'voice'],
  'mobile-setup': ['selectFL', 'selectFR', 'selectRL', 'selectRR', 'selectAll', 'selectPrev', 'selectNext', 'mat', 'pin', 'toCrane', 'toRoad', 'camera', 'estop', 'pause', 'switchMachine', 'voice'],
};

// the host's HUD dialogs (RCL config / reeving) flag themselves here; while one
// is open every control is neutral and gamepad presses are left to the dialog
const modalOpen = () => typeof document !== 'undefined' && !!document.body && !!document.body.dataset.hudModal;

// the live Input (the HUD reads timeWarp from it for the ×4 badge)
let current = null;
/** The most recently constructed Input, or null. */
export function currentInput() { return current; }

export class Input {
  constructor() {
    current = this;
    this.keys = new Set();
    this._profile = 'tower';
    this.levers = { slew: 0, trolley: 0, hoist: 0, tele: 0, luff: 0 };
    this.drive = { throttle: 0, brake: 0, steer: 0, crawl: false };
    this.setup = { beam: 0, jack: 0, autoLevel: false, ballast: false };
    this.raw = { slew: 0, trolley: 0, hoist: 0, tele: 0, luff: 0, throttle: 0, brake: 0, steer: 0 };
    this.actions = [];
    this.horn = false;
    this.micro = false;
    this.tag = 0;
    this.timeWarp = false;
    this.isoHoist = false; // true: ↑ / stick forward = lower (ISO lever direction)
    // touch sticks write raw axes (+x right, +y up); update() maps them per profile
    this.touch = { lx: 0, ly: 0, rx: 0, ry: 0, active: false };
    this.touchHeld = {}; // horn, micro, tag, timeWarp, crawl, autoLevel, ballast
    this.gamepadIndex = null;
    this.padPrev = [];
    this.lastDevice = 'keyboard';
    this.enabled = true;
    this._touchUi = null;

    window.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.code === 'Backspace' && this._profile === 'mobile-setup') e.preventDefault();
      // a HUD dialog (RCL config / reeving) owns the keyboard while it is open: Enter / L / Esc
      // there must not also switch mode, reopen the dialog or pause
      if (!e.repeat && !modalOpen()) {
        // EN 13000 emergency RCL bypass: a deliberate chord, never a single key (§5)
        if (this._profile === 'mobile-crane' && e.code === 'KeyB' && e.ctrlKey && e.shiftKey) {
          e.preventDefault();
          this.actions.push('bypass');
        } else {
          const a = (KEY_ACTIONS[this._profile] || KEY_ACTIONS.tower)[e.code];
          if (a) this.actions.push(a);
        }
      }
      this.keys.add(e.code);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  get profile() { return this._profile; }
  set profile(p) {
    if (!KEY_ACTIONS[p]) p = 'tower';
    if (p === this._profile) return;
    this._profile = p;
    // a new control set starts from neutral: no ramp carries over between profiles
    for (const k of Object.keys(this.raw)) this.raw[k] = 0;
    this._zero();
    this.touch.lx = this.touch.ly = this.touch.rx = this.touch.ry = 0;
    if (this._touchUi) this._touchUi.setProfile(p);
  }

  push(action) { this.actions.push(action); }

  consume() {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  // zero-position interlock (ISO 7752-1): every crane lever of either set
  get anyLeverOffNeutral() {
    const l = this.levers;
    return Math.abs(l.slew) > 0.05 || Math.abs(l.trolley) > 0.05 || Math.abs(l.hoist) > 0.05
      || Math.abs(l.tele) > 0.05 || Math.abs(l.luff) > 0.05;
  }

  // any control of the current profile deflected (crane levers, pedals, steering, setup valves)
  get anyControlOffNeutral() {
    const d = this.drive, s = this.setup;
    return this.anyLeverOffNeutral || d.throttle > 0.05 || d.brake > 0.05 || Math.abs(d.steer) > 0.05
      || Math.abs(s.beam) > 0.05 || Math.abs(s.jack) > 0.05;
  }

  /** Names of the levers the current profile drives (for HUD lever indicators). */
  get leverKeys() {
    return this._profile === 'mobile-crane' ? ['slew', 'tele', 'luff', 'hoist'] : this._profile === 'tower' ? ['slew', 'trolley', 'hoist'] : [];
  }

  _zero() {
    const l = this.levers;
    l.slew = l.trolley = l.hoist = l.tele = l.luff = 0;
    const d = this.drive;
    d.throttle = d.brake = d.steer = 0;
    d.crawl = false;
    const s = this.setup;
    s.beam = s.jack = 0;
    s.autoLevel = s.ballast = false;
  }

  _pad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return this.gamepadIndex !== null ? pads[this.gamepadIndex] : Array.from(pads).find((p) => p);
  }

  update(dt) {
    const p = this._profile;
    if (p === 'tower') this._updateTower(dt);
    else if (p === 'mobile-crane') this._updateCrane(dt);
    else if (p === 'mobile-drive') this._updateDrive(dt);
    else this._updateSetup(dt);
  }

  // ------------------------------------------------------------------ tower
  // Unchanged behaviour (keyboard ramps, gamepad and touch precedence).
  _updateTower(dt) {
    const k = this.keys;
    // keyboard: deflection ramps in (~0.45 s full travel) so taps feather the drive
    const ramp = dt / 0.45;
    const ret = dt / 0.12;
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const ky = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    let kh = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    if (k.has('PageUp') || k.has('KeyI')) kh = 1;
    if (k.has('PageDown') || k.has('KeyK')) kh = -1;
    if (this.isoHoist) kh = -kh;
    const step = (cur, tgt) => (tgt === 0 || cur * tgt < 0 ? approach(cur, 0, ret) : approach(cur, tgt, ramp));
    this.raw.slew = step(this.raw.slew, kx);
    this.raw.trolley = step(this.raw.trolley, ky);
    this.raw.hoist = step(this.raw.hoist, kh);
    let slew = this.raw.slew, trolley = this.raw.trolley, hoist = this.raw.hoist;
    let horn = k.has('KeyH');
    let micro = k.has('ShiftLeft') || k.has('ShiftRight');
    let tag = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);

    // gamepad
    const pad = this._pad();
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const ax = pad.axes;
      const gx = dz(ax[0] || 0), gy = dz(-(ax[1] || 0)), gh = dz(-(ax[3] || 0));
      if (Math.abs(gx) + Math.abs(gy) + Math.abs(gh) > 0) this.lastDevice = 'gamepad';
      if (Math.abs(gx) > Math.abs(slew)) slew = gx;
      if (Math.abs(gy) > Math.abs(trolley)) trolley = gy;
      // ISO: pushing the right lever forward lowers the load
      const ghh = this.isoHoist ? -gh : gh;
      if (Math.abs(ghh) > Math.abs(hoist)) hoist = ghh;
      const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      this._padEdges(pad);
      if (b(1)) horn = true;
      if ((pad.buttons[6] && pad.buttons[6].value > 0.4)) micro = true;
      if (b(4)) tag = -1;
      if (b(5)) tag = 1;
    }

    // touch levers
    const T = this.touch, H = this.touchHeld;
    if (T.active) {
      if (Math.abs(T.lx) > Math.abs(slew)) slew = T.lx;
      if (Math.abs(T.ly) > Math.abs(trolley)) trolley = T.ly;
      if (Math.abs(T.ry) > Math.abs(hoist)) hoist = T.ry;
    }
    if (H.horn) horn = true;
    if (H.micro) micro = true;
    if (H.tag) tag = H.tag;

    if (!this.enabled) { slew = trolley = hoist = 0; horn = false; tag = 0; }
    this.levers.slew = clamp(slew, -1, 1);
    this.levers.trolley = clamp(trolley, -1, 1);
    this.levers.hoist = clamp(hoist, -1, 1);
    this.levers.tele = this.levers.luff = 0;
    this.horn = horn;
    this.micro = micro;
    this.tag = tag;
    this.timeWarp = false; // never on the tower
  }

  // fire the current profile's press actions; padPrev tracks every button so a
  // button held across a profile change does not fire again
  _padEdges(pad) {
    if (modalOpen()) { // the dialog reads the pad itself
      for (let i = 0; i < pad.buttons.length; i++) this.padPrev[i] = !!(pad.buttons[i] && pad.buttons[i].pressed);
      return;
    }
    const map = PAD_ACTIONS[this._profile] || PAD_ACTIONS.tower;
    for (let i = 0; i < pad.buttons.length; i++) {
      const on = !!(pad.buttons[i] && pad.buttons[i].pressed);
      if (on && !this.padPrev[i] && map[i]) { this.actions.push(map[i]); this.lastDevice = 'gamepad'; }
      this.padPrev[i] = on;
    }
  }

  // ------------------------------------------------------------------ mobile crane
  _updateCrane(dt) {
    const k = this.keys;
    const ramp = dt / 0.45; // proportional joysticks: keyboard taps feather like the tower
    const ret = dt / 0.12;
    const step = (cur, tgt) => (tgt === 0 || cur * tgt < 0 ? approach(cur, 0, ret) : approach(cur, tgt, ramp));
    const kSlew = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const kTele = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    // right lever LEFT = raise (ISO 7752-2 cross-shift)
    const kLuff = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    let kh = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    if (k.has('PageUp') || k.has('KeyI')) kh = 1;
    if (k.has('PageDown') || k.has('KeyK')) kh = -1;
    if (this.isoHoist) kh = -kh;
    const R = this.raw;
    R.slew = step(R.slew, kSlew);
    R.tele = step(R.tele, kTele);
    R.luff = step(R.luff, kLuff);
    R.hoist = step(R.hoist, kh);
    let slew = R.slew, tele = R.tele, luff = R.luff, hoist = R.hoist;
    let horn = k.has('KeyH');
    let micro = k.has('ShiftLeft') || k.has('ShiftRight');
    let tag = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    let warp = k.has('KeyZ');

    const pad = this._pad();
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const ax = pad.axes;
      const gx = dz(ax[0] || 0), gy = dz(-(ax[1] || 0));
      const rl = dz(-(ax[2] || 0)); // RS left = luff up
      const gh = dz(-(ax[3] || 0));
      if (Math.abs(gx) + Math.abs(gy) + Math.abs(rl) + Math.abs(gh) > 0) this.lastDevice = 'gamepad';
      if (Math.abs(gx) > Math.abs(slew)) slew = gx;
      if (Math.abs(gy) > Math.abs(tele)) tele = gy;
      if (Math.abs(rl) > Math.abs(luff)) luff = rl;
      const ghh = this.isoHoist ? -gh : gh;
      if (Math.abs(ghh) > Math.abs(hoist)) hoist = ghh;
      const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      this._padEdges(pad);
      if (b(1)) horn = true;
      if (pad.buttons[6] && pad.buttons[6].value > 0.4) micro = true;
      if (b(4)) tag = -1;
      if (b(5)) tag = 1;
      if (b(11)) warp = true;
    }

    const T = this.touch, H = this.touchHeld;
    if (T.active) {
      if (Math.abs(T.lx) > Math.abs(slew)) slew = T.lx;
      if (Math.abs(T.ly) > Math.abs(tele)) tele = T.ly;
      if (Math.abs(T.rx) > Math.abs(luff)) luff = -T.rx; // knob left = raise
      if (Math.abs(T.ry) > Math.abs(hoist)) hoist = T.ry;
    }
    if (H.horn) horn = true;
    if (H.micro) micro = true;
    if (H.tag) tag = H.tag;
    if (H.timeWarp) warp = true;

    if (!this.enabled || modalOpen()) { slew = tele = luff = hoist = 0; horn = false; tag = 0; warp = false; }
    const l = this.levers;
    l.slew = clamp(slew, -1, 1);
    l.tele = clamp(tele, -1, 1);
    l.luff = clamp(luff, -1, 1);
    l.hoist = clamp(hoist, -1, 1);
    l.trolley = 0;
    this.horn = horn;
    this.micro = micro;
    this.tag = tag;
    this.timeWarp = warp;
  }

  // ------------------------------------------------------------------ carrier driving
  _updateDrive(dt) {
    const k = this.keys;
    const R = this.raw;
    const up = k.has('KeyW') || k.has('ArrowUp');
    const dn = k.has('KeyS') || k.has('ArrowDown');
    const ks = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    // pedals ramp like a foot (throttle 0.6 s, brake 0.35 s) and snap back when released
    R.throttle = up ? approach(R.throttle, 1, dt / 0.6) : approach(R.throttle, 0, dt / 0.15);
    R.brake = dn ? approach(R.brake, 1, dt / 0.35) : approach(R.brake, 0, dt / 0.1);
    // steering demand: 0.5 s to full lock, self-centres in 0.35 s; the vehicle
    // model adds the real lock-to-lock rate (3 s) on top
    R.steer = ks === 0 || R.steer * ks < 0 ? approach(R.steer, 0, dt / 0.35) : approach(R.steer, ks, dt / 0.5);
    let throttle = R.throttle, brake = R.brake, steer = R.steer;
    let horn = k.has('KeyH');
    let crawl = k.has('ShiftLeft') || k.has('ShiftRight');

    const pad = this._pad();
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.1 ? 0 : (v - Math.sign(v) * 0.1) / 0.9);
      const gs = dz(pad.axes[0] || 0);
      const rt = pad.buttons[7] ? pad.buttons[7].value || 0 : 0;
      const lt = pad.buttons[6] ? pad.buttons[6].value || 0 : 0;
      if (Math.abs(gs) + rt + lt > 0.05) this.lastDevice = 'gamepad';
      if (Math.abs(gs) > Math.abs(steer)) steer = gs;
      if (rt > throttle) throttle = rt;
      if (lt > brake) brake = lt;
      this._padEdges(pad);
      if (pad.buttons[1] && pad.buttons[1].pressed) horn = true;
      if (pad.buttons[5] && pad.buttons[5].pressed) crawl = true;
    }

    const T = this.touch, H = this.touchHeld;
    if (T.active) {
      if (Math.abs(T.lx) > Math.abs(steer)) steer = T.lx;
      if (T.ry > throttle) throttle = T.ry;
      if (-T.ry > brake) brake = -T.ry;
    }
    if (H.horn) horn = true;
    if (H.crawl) crawl = true;

    if (!this.enabled || modalOpen()) { throttle = steer = 0; brake = this.enabled ? brake : 0; horn = false; }
    const d = this.drive;
    d.throttle = clamp(throttle, 0, 1);
    d.brake = clamp(brake, 0, 1);
    d.steer = clamp(steer, -1, 1);
    d.crawl = crawl;
    const l = this.levers;
    l.slew = l.trolley = l.hoist = l.tele = l.luff = 0;
    this.horn = horn;
    this.micro = crawl;
    this.tag = 0;
    this.timeWarp = false; // no ×4 on the public road (traffic keeps real time)
  }

  // ------------------------------------------------------------------ outrigger remote
  _updateSetup() {
    const k = this.keys;
    // hydraulic valves on the remote: on / off, the drives own their speeds
    let beam = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let jack = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let autoLevel = k.has('KeyG');
    let ballast = k.has('KeyB');
    let horn = k.has('KeyH');
    let warp = k.has('KeyZ');

    const pad = this._pad();
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.2 ? 0 : (v - Math.sign(v) * 0.2) / 0.8);
      const gb = dz(pad.axes[0] || 0);
      const gj = dz(-(pad.axes[1] || 0)) || dz(-(pad.axes[3] || 0));
      if (Math.abs(gb) + Math.abs(gj) > 0) this.lastDevice = 'gamepad';
      if (Math.abs(gb) > Math.abs(beam)) beam = gb;
      if (Math.abs(gj) > Math.abs(jack)) jack = gj;
      this._padEdges(pad);
      if (pad.buttons[6] && pad.buttons[6].value > 0.4) autoLevel = true;
      if (pad.buttons[7] && pad.buttons[7].value > 0.4) ballast = true;
      if (pad.buttons[1] && pad.buttons[1].pressed) horn = true;
      if (pad.buttons[11] && pad.buttons[11].pressed) warp = true;
    }

    const T = this.touch, H = this.touchHeld;
    if (T.active) {
      if (Math.abs(T.lx) > Math.abs(beam)) beam = T.lx;
      if (Math.abs(T.ry) > Math.abs(jack)) jack = T.ry;
    }
    if (H.autoLevel) autoLevel = true;
    if (H.ballast) ballast = true;
    if (H.horn) horn = true;
    if (H.timeWarp) warp = true;

    if (!this.enabled || modalOpen()) { beam = jack = 0; autoLevel = ballast = horn = warp = false; }
    const s = this.setup;
    s.beam = clamp(beam, -1, 1);
    s.jack = clamp(jack, -1, 1);
    s.autoLevel = autoLevel;
    s.ballast = ballast;
    const l = this.levers;
    l.slew = l.trolley = l.hoist = l.tele = l.luff = 0;
    const d = this.drive;
    d.throttle = d.steer = 0;
    d.brake = 0;
    d.crawl = false;
    this.horn = horn;
    this.micro = false;
    this.tag = 0;
    this.timeWarp = warp;
  }
}

// ------------------------------------------------------------------ touch controls
// Stick axes and labels per profile (x / y = which knob axes are live).
const STICKS = {
  tower: {
    left: { x: true, y: true, label: 'SLEW ◀▶ / TROLLEY ▲▼' },
    right: { x: false, y: true, label: 'HOIST ▲▼' },
  },
  'mobile-crane': {
    left: { x: true, y: true, label: 'SLEW ◀▶ / TELE ▲OUT ▼IN' },
    right: { x: true, y: true, label: 'LUFF ◀UP ▶DN / HOIST ▲▼' },
  },
  'mobile-drive': {
    left: { x: true, y: false, label: 'STEER ◀▶' },
    right: { x: false, y: true, label: 'THROTTLE ▲ / BRAKE ▼' },
  },
  'mobile-setup': {
    left: { x: true, y: false, label: 'BEAM ◀IN / OUT▶' },
    right: { x: false, y: true, label: 'JACK ▲DOWN / UP▼' },
  },
};

// Buttons per profile: act = push an action on press; hold = input.touchHeld key
// while pressed (value = hold value, default true); sec = behind the ⋯ toggle.
const BUTTONS = {
  tower: [ // unchanged tower layout
    { label: 'HOOK', act: 'hook' },
    { label: 'HORN', hold: 'horn' },
    { label: 'MICRO', hold: 'micro' },
    { label: '⟲', hold: 'tag', value: -1 },
    { label: '⟳', hold: 'tag', value: 1 },
    { label: 'CAM', act: 'camera' },
    { label: 'PWR', act: 'power' },
    { label: 'STOP', act: 'estop', cls: 'estop' },
  ],
  'mobile-crane': [
    { label: 'HOOK', act: 'hook' },
    { label: 'HORN', hold: 'horn' },
    { label: 'MICRO', hold: 'micro' },
    { label: 'CAM', act: 'camera' },
    { label: 'PWR', act: 'power' },
    { label: 'STOP', act: 'estop', cls: 'estop' },
    { label: 'RCL', act: 'rclConfig', sec: true },
    { label: 'REEVE', act: 'reeving', sec: true },
    { label: 'PIN', act: 'pin', sec: true },
    { label: 'FREE', act: 'freeslew', sec: true },
    { label: 'MUTE', act: 'rclMute', sec: true },
    { label: '⟲', hold: 'tag', value: -1, sec: true },
    { label: '⟳', hold: 'tag', value: 1, sec: true },
    { label: '×4', hold: 'timeWarp', sec: true },
    { label: 'SETUP', act: 'toSetup', sec: true },
    { label: '⇄', act: 'switchMachine', sec: true },
  ],
  'mobile-drive': [
    { label: 'HORN', hold: 'horn' },
    { label: 'GEAR', act: 'gear' },
    { label: 'PROG', act: 'program' },
    { label: 'P-BRK', act: 'parkingBrake' },
    { label: 'CRAWL', hold: 'crawl' },
    { label: 'CAM', act: 'camera' },
    { label: 'SETUP', act: 'toSetup' },
    { label: 'ENG', act: 'engine', cls: 'estop' },
    { label: '⇄', act: 'switchMachine', sec: true },
  ],
  'mobile-setup': [
    { label: 'FL', act: 'selectFL' },
    { label: 'FR', act: 'selectFR' },
    { label: 'RL', act: 'selectRL' },
    { label: 'RR', act: 'selectRR' },
    { label: 'ALL', act: 'selectAll' },
    { label: 'MAT', act: 'mat' },
    { label: 'LEVEL', hold: 'autoLevel' },
    { label: 'CAM', act: 'camera' },
    { label: 'CRANE', act: 'toCrane' },
    { label: 'BALLAST', hold: 'ballast', sec: true },
    { label: 'PIN', act: 'pin', sec: true },
    { label: 'ROAD', act: 'toRoad', sec: true },
    { label: '×4', hold: 'timeWarp', sec: true },
    { label: 'HORN', hold: 'horn', sec: true },
    { label: 'STOP', act: 'estop', cls: 'estop', sec: true },
    { label: '⇄', act: 'switchMachine', sec: true },
  ],
};

// On-screen levers for touch devices; they follow input.profile.
export function setupTouchControls(input, container) {
  const mk = (cls, label) => {
    const el = document.createElement('div');
    el.className = cls;
    if (label) el.innerHTML = label;
    container.appendChild(el);
    return el;
  };
  const sticks = {};
  const stick = (side) => {
    const base = mk(`touch-stick ${side}`);
    const knob = document.createElement('div');
    knob.className = 'knob';
    base.appendChild(knob);
    const lbl = document.createElement('div');
    lbl.className = 'touch-label';
    base.appendChild(lbl);
    const st = { base, knob, lbl, ax: { x: true, y: true }, id: null, cx: 0, cy: 0 };
    const R = 50;
    const set = (dx, dy) => {
      if (!st.ax.x) dx = 0;
      if (!st.ax.y) dy = 0;
      const l = Math.hypot(dx, dy);
      if (l > R) { dx *= R / l; dy *= R / l; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const nx = dx / R, ny = -dy / R;
      if (side === 'left') { input.touch.lx = nx; input.touch.ly = ny; } else { input.touch.rx = nx; input.touch.ry = ny; }
      input.touch.active = true;
    };
    st.set = set;
    base.addEventListener('pointerdown', (e) => {
      st.id = e.pointerId;
      const rct = base.getBoundingClientRect();
      st.cx = rct.left + rct.width / 2;
      st.cy = rct.top + rct.height / 2;
      base.setPointerCapture(st.id);
      set(e.clientX - st.cx, e.clientY - st.cy);
      input.lastDevice = 'touch';
    });
    base.addEventListener('pointermove', (e) => { if (e.pointerId === st.id) set(e.clientX - st.cx, e.clientY - st.cy); });
    const end = (e) => {
      if (e.pointerId !== st.id) return;
      st.id = null;
      set(0, 0);
    };
    base.addEventListener('pointerup', end);
    base.addEventListener('pointercancel', end);
    sticks[side] = st;
  };
  stick('left');
  stick('right');
  const bar = mk('touch-buttons');

  const setProfile = (p) => {
    const cfg = STICKS[p] || STICKS.tower;
    for (const side of ['left', 'right']) {
      const st = sticks[side], c = cfg[side];
      st.ax = { x: c.x, y: c.y };
      st.lbl.textContent = c.label;
      st.base.classList.toggle('ax-x', c.x && !c.y);
      st.base.classList.toggle('ax-y', c.y && !c.x);
      st.base.classList.toggle('ax-xy', c.x && c.y);
      st.id = null;
      st.set(0, 0);
    }
    input.touchHeld = {};
    bar.innerHTML = '';
    bar.classList.remove('more-open');
    bar.dataset.profile = p;
    const defs = BUTTONS[p] || BUTTONS.tower;
    for (const d of defs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.label;
      if (d.cls) b.classList.add(d.cls);
      if (d.sec) b.classList.add('sec');
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (d.act) input.push(d.act);
        else input.touchHeld[d.hold] = d.value ?? true;
        input.lastDevice = 'touch';
      });
      if (d.hold) {
        const up = () => { if (input.touchHeld[d.hold] === (d.value ?? true)) delete input.touchHeld[d.hold]; };
        b.addEventListener('pointerup', up);
        b.addEventListener('pointerleave', up);
        b.addEventListener('pointercancel', up);
      }
      bar.appendChild(b);
    }
    if (defs.some((d) => d.sec)) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'more';
      more.textContent = '⋯';
      more.setAttribute('aria-label', 'More controls');
      more.addEventListener('pointerdown', (e) => { e.preventDefault(); bar.classList.toggle('more-open'); });
      bar.appendChild(more);
    }
    container.dataset.profile = p;
  };
  input._touchUi = { setProfile };
  setProfile(input.profile);
}
