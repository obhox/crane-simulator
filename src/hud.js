import { CRANE, CHART_POINTS, ratedCapacity, SAFETY } from './config.js';
import { JOBS, fmtTime, bestScore } from './jobs.js';
import { MobileHud } from './hudMobile.js';
import { MOBILE_SETTINGS } from './mobile/config.js';

// Heads-up display: in-cab LMI touchscreen, job card, toasts, signaller
// subtitles, context hints and all menu screens. Pure DOM, no framework.
// update() is called every frame but only touches the DOM at ~15 Hz and
// only writes values that actually changed.
//
// Two machines: setMachine('tower' | 'mobile') swaps the tower LMI for the
// AT-100 display (src/hudMobile.js, this.mobile); update(s) routes a state
// with s.machine === 'mobile' there. The mobile dialogs are reachable as
// hud.openConfigDialog / openReevingDialog / openBallastPanel (machines get
// the Hud as api.hud / ctx.hud).

const COMPACT_MQ = '(max-width: 760px), (max-height: 500px), (pointer: coarse)';
const UPDATE_INTERVAL = 1000 / 15;

// Mirrors main.js defaults; used until main supplies its live settings
// (callbacks.getSettings() or showSettings(settings)).
const DEFAULT_SETTINGS = {
  quality: 'medium', hour: 10.5, windMean: 4, gustiness: 0.5, windDir: 35, falls: 2, slewMode: 1,
  swayAssist: false, isoHoist: false, voice: true, volume: 0.8, zoneLimiter: true, autoLook: true, showHints: true,
  weather: 'cloudy',
  ...MOBILE_SETTINGS, // machine, mobileStart, siteSpeedLimit, quickBallast, allowBypass, timeWarp
};

const MACHINES = {
  tower: {
    label: 'Tower TC-6010', title: 'TOWER CRANE<br><span>SIMULATOR</span>', sub: 'TC-6010 · 60 m jib · 8 t',
    group: 'Tower crane · TC-6010',
  },
  mobile: {
    label: 'Mobile AT-100 5.1', title: 'MOBILE CRANE<br><span>SIMULATOR</span>', sub: 'AT-100 5.1 · 100 t all-terrain · 52 m boom',
    group: 'Mobile crane · AT-100 5.1',
  },
};

const LAMPS = [
  ['pwr', 'PWR'], ['brake', 'BRAKE'], ['lmi', 'LMI'], ['maxload', 'MAX LOAD'], ['wind', 'WIND'],
  ['zone', 'ZONE'], ['limit', 'LIMIT'], ['micro', 'MICRO'], ['sway', 'SWAY'], ['free', 'FREE SLEW'],
];

const LMI_LAMP = { ok: 'ok', warn: 'warn', limit: 'bad', cut: 'blink' };
const WIND_LAMP = { ok: 'off', warn: 'warn', alarm: 'bad', stop: 'blink' };
const STATE_COLOR = { ok: '#35e07a', warn: '#ffb020', limit: '#ff4640', cut: '#ff4640' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// cached DOM writers ---------------------------------------------------------
function setText(node, v) {
  if (node._v !== v) {
    node._v = v;
    node.textContent = v;
  }
}
function setData(node, key, v) {
  const k = '_d' + key;
  if (node[k] !== v) {
    node[k] = v;
    node.dataset[key] = v;
  }
}
function setHidden(node, hidden) {
  if (node._h !== hidden) {
    node._h = hidden;
    node.hidden = hidden;
  }
}
function setClass(node, cls, on) {
  const k = '_c' + cls;
  if (node[k] !== on) {
    node[k] = on;
    node.classList.toggle(cls, on);
  }
}

const fmtHour = (v) => {
  let h = Math.floor(v);
  let m = Math.round((v - h) * 60);
  if (m === 60) { h++; m = 0; }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const fmtDir = (v) => `${Math.round(v)}° ${COMPASS[Math.round(v / 45) % 8]}`;
const fmtWind = (v) => `${Number(v).toFixed(1)} m/s · ${Math.round(v * 3.6)} km/h`;
const fmtPct = (v) => `${Math.round(v * 100)}%`;

// ---------------------------------------------------------------------------
export class Hud {
  constructor(root, callbacks = {}) {
    this.root = root;
    this.cb = callbacks || {};
    this._settings = { ...DEFAULT_SETTINGS };
    if (matchMedia('(pointer: coarse)').matches) this._settings.quality = 'low';
    this._jobs = JOBS;
    this._bestFn = bestScore;
    this._screen = null;
    this._stack = [];
    this._hookVisible = true;
    this._lastUpdate = -1e9;
    this._toasts = [];
    this._radioTimer = 0;
    this._chartKey = null;
    this._dotKey = null;
    this._chartW = 0;
    this._chartH = 0;
    this._hintKey = null;
    this._lastJob = null;
    this._compact = matchMedia(COMPACT_MQ);

    root.classList.add('hud');
    root.innerHTML = this._template();
    this._refs();
    this._buildMenu();
    this._buildJobs();
    this._buildSettings();
    this._buildHelp();
    this._buildPause();
    this._buildResults();
    this._bind();
    this._machine = 'tower';
    this.mobile = new MobileHud(this.el.game, this);
    this._applyMenuMachine();

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { this._chartKey = null; this._dotKey = null; });
    }
  }

  // ======================================================== DOM construction
  _template() {
    const lamps = LAMPS.map(([k, label]) => `<span class="lamp" data-k="${k}" data-s="off">${label}</span>`).join('');
    return `
<div class="hud-game">
  <div class="topbar">
    <button class="tb-btn tb-cam" type="button" title="Change camera (C)">
      <span class="tb-label">CAM</span><span class="tb-cam-name">—</span>
    </button>
    <div class="tb-timer" hidden><span class="tb-label">JOB</span><span class="tb-time">0:00</span></div>
    <button class="tb-btn tb-pause" type="button" title="Pause (Esc)" aria-label="Pause">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><rect x="2" y="1.5" width="3" height="9" rx="0.6"/><rect x="7" y="1.5" width="3" height="9" rx="0.6"/></svg>
    </button>
  </div>

  <section class="jobcard" hidden aria-label="Current job">
    <div class="jc-head">
      <span class="jc-module"></span>
      <span class="jc-par"></span>
      <button class="jc-toggle" type="button" aria-expanded="true" title="Show / hide the brief">
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
    <h2 class="jc-title"></h2>
    <p class="jc-brief"></p>
    <div class="jc-blind" hidden>BLIND LIFT · follow the signaller</div>
    <div class="jc-step">
      <div class="jc-steplabel">STEP —</div>
      <p class="jc-steptext"></p>
    </div>
    <div class="jc-progress" hidden><i></i></div>
  </section>

  <div class="toasts" aria-live="polite"></div>
  <div class="dock">
    <div class="radio" aria-live="polite"><span class="radio-tag">📻 SIGNALLER:</span> <span class="radio-text"></span></div>
    <div class="hints"></div>
  </div>

  <aside id="lmi" class="lmi" aria-label="Load moment indicator">
    <div class="lmi-screen">
      <header class="lmi-head">
        <span class="lmi-brand">${esc(CRANE.model)} · LMI</span>
        <span class="lmi-tag lmi-falls">— FALLS</span>
        <span class="lmi-tag lmi-mode">—</span>
        <button class="lmi-pwr" type="button" title="Power on / off (P)" data-s="off"><i class="led"></i><span class="pwr-text">PWR</span></button>
        <button class="lmi-collapse" type="button" aria-expanded="true" title="Collapse / expand the LMI">
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </header>

      <div class="lmi-big">
        <div class="big b-load"><label>LOAD</label><div class="bv"><b class="v-load">0.00</b><small>t</small></div></div>
        <div class="big b-swl"><label>SWL</label><div class="bv"><b class="v-swl">0.00</b><small>t</small></div></div>
      </div>

      <div class="lmi-moment" data-state="ok">
        <div class="mo-row"><label>MOMENT</label><span class="mo-val"><b class="v-moment">0</b><small>%</small></span></div>
        <div class="mo-bar">
          <i class="mo-fill"></i>
          <span class="mo-mark m90"><em>90</em></span>
          <span class="mo-mark m100"><em>100</em></span>
        </div>
        <div class="mo-cut" hidden>CUT-OUT: HOIST ↑ / TROLLEY → BLOCKED</div>
      </div>

      <div class="lmi-grid">
        <div class="cell c-radius"><label>RADIUS</label><div class="cv"><b class="v-radius">0.0</b><small>m</small></div></div>
        <div class="cell c-height"><label>HOOK HT</label><div class="cv"><b class="v-height">0.0</b><small>m</small></div></div>
        <div class="cell c-slew"><label>SLEW</label><div class="cv"><b class="v-slew">000</b><small>°</small></div></div>
        <div class="cell c-wind" data-state="ok"><label>WIND</label><div class="cv"><b class="v-wind">0.0</b><small>m/s</small></div><span class="sub v-windsub">0 km/h · gust 0.0</span></div>
        <div class="cell c-rpm"><label>SLEW RPM</label><div class="cv"><b class="v-rpm">0.00</b></div></div>
        <div class="cell c-hoist"><label>HOIST</label><div class="cv"><b class="v-hoist">0</b><small class="v-hoistmax">/ 0 m/min</small></div></div>
        <div class="cell c-trolley"><label>TROLLEY</label><div class="cv"><b class="v-trolley">0</b><small>m/min</small></div></div>
      </div>

      <div class="lmi-chartrow">
        <div class="chart">
          <canvas class="lmi-chart" aria-label="Load chart"></canvas>
          <span class="chart-cap">LOAD CHART · t / m</span>
        </div>
        <div class="levers" aria-hidden="true">
          <div class="lever lv-left"><i class="lv-cross"></i><i class="lv-dot"></i><span>L</span></div>
          <div class="lever lv-right"><i class="lv-cross"></i><i class="lv-dot"></i><span>R</span></div>
        </div>
      </div>

      <div class="lamps">${lamps}</div>

      <div class="lmi-load">
        <span class="ll-name">HOOK ONLY</span>
        <span class="ll-chip ll-wind" hidden></span>
        <span class="ll-chip ll-sling" hidden></span>
        <span class="ll-chip ll-state" hidden></span>
      </div>
    </div>
    <div id="hookmon" class="hookmon"><span class="hm-label"><i></i>HOOK CAM</span></div>
  </aside>
</div>

<div class="overlay" hidden>
  <section class="screen s-menu" data-screen="menu" hidden></section>
  <section class="screen s-jobs sheet" data-screen="jobs" hidden aria-label="Lift jobs"></section>
  <section class="screen s-settings sheet" data-screen="settings" hidden aria-label="Settings"></section>
  <section class="screen s-help sheet" data-screen="help" hidden aria-label="Controls"></section>
  <section class="screen s-pause sheet" data-screen="pause" hidden aria-label="Paused"></section>
  <section class="screen s-results sheet" data-screen="results" hidden aria-label="Results"></section>
</div>`;
  }

  _refs() {
    const q = (s) => this.root.querySelector(s);
    this.el = {
      game: q('.hud-game'),
      camBtn: q('.tb-cam'), camName: q('.tb-cam-name'), timer: q('.tb-timer'), time: q('.tb-time'), pauseBtn: q('.tb-pause'),
      job: q('.jobcard'), jcModule: q('.jc-module'), jcPar: q('.jc-par'), jcToggle: q('.jc-toggle'), jcTitle: q('.jc-title'),
      jcBrief: q('.jc-brief'), jcBlind: q('.jc-blind'), jcStep: q('.jc-step'), jcStepLabel: q('.jc-steplabel'),
      jcStepText: q('.jc-steptext'), jcProgress: q('.jc-progress'), jcProgressFill: q('.jc-progress i'),
      toasts: q('.toasts'), hints: q('.hints'), radio: q('.radio'), radioText: q('.radio-text'),
      lmi: q('.lmi'), falls: q('.lmi-falls'), mode: q('.lmi-mode'), pwr: q('.lmi-pwr'), pwrText: q('.pwr-text'),
      collapse: q('.lmi-collapse'),
      load: q('.v-load'), swl: q('.v-swl'), moment: q('.lmi-moment'), momentVal: q('.v-moment'), momentFill: q('.mo-fill'),
      cut: q('.mo-cut'),
      radius: q('.v-radius'), height: q('.v-height'), slew: q('.v-slew'), windCell: q('.c-wind'), wind: q('.v-wind'),
      windSub: q('.v-windsub'), rpm: q('.v-rpm'), hoist: q('.v-hoist'), hoistMax: q('.v-hoistmax'), trolley: q('.v-trolley'),
      chart: q('.lmi-chart'),
      lvLeft: q('.lv-left .lv-dot'), lvRight: q('.lv-right .lv-dot'),
      llName: q('.ll-name'), llWind: q('.ll-wind'), llSling: q('.ll-sling'), llState: q('.ll-state'),
      hookmon: q('#hookmon'),
      overlay: q('.overlay'),
    };
    this.lamps = {};
    for (const n of this.root.querySelectorAll('.lamp')) this.lamps[n.dataset.k] = n;
    this.screens = {};
    for (const n of this.root.querySelectorAll('.screen')) this.screens[n.dataset.screen] = n;
  }

  _bind() {
    const E = this.el;
    E.camBtn.addEventListener('click', () => {
      if (this.cb.onCameraClick) this.cb.onCameraClick(); else this._key('KeyC');
      E.camBtn.blur();
    });
    E.pwr.addEventListener('click', () => {
      if (this.cb.onPowerClick) this.cb.onPowerClick(); else this._key('KeyP');
      E.pwr.blur();
    });
    E.pauseBtn.addEventListener('click', () => {
      if (this.cb.onPauseClick) this.cb.onPauseClick(); else this._key('Escape');
      E.pauseBtn.blur();
    });
    E.jcToggle.addEventListener('click', () => {
      this._setBrief(!E.job.classList.contains('brief-open'));
      E.jcToggle.blur();
    });
    E.collapse.addEventListener('click', () => {
      const c = !E.lmi.classList.contains('collapsed');
      E.lmi.classList.toggle('collapsed', c);
      E.collapse.setAttribute('aria-expanded', String(!c));
      this._chartKey = null;
      E.collapse.blur();
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver((entries) => {
        for (const e of entries) {
          this._chartW = Math.round(e.contentRect.width);
          this._chartH = Math.round(e.contentRect.height);
        }
        this._chartKey = null;
      }).observe(E.chart);
    }
    // Esc inside a sub-screen (settings / controls / job list) steps back
    // instead of reaching the game's pause toggle.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || !this._screen) return;
      if (this._screen === 'jobs' || this._screen === 'settings' || this._screen === 'help') {
        e.stopImmediatePropagation();
        e.preventDefault();
        this.back();
      }
    }, true);
  }

  // synthesise a key press for input.js when main supplied no callback
  _key(code) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
    setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true })), 30);
  }

  // =========================================================== screen stack
  _set(name) {
    this._screen = name;
    for (const [k, node] of Object.entries(this.screens)) node.hidden = k !== name;
    const ov = this.el.overlay;
    ov.hidden = !name;
    ov.dataset.screen = name || '';
    const menuMode = name === 'menu' || this._stack[0] === 'menu';
    this.root.classList.toggle('menu-mode', !!name && menuMode);
    this.root.classList.toggle('modal-open', !!name);
    if (name) {
      ov.scrollTop = 0;
      const sc = this.screens[name];
      sc.scrollTop = 0;
      const f = sc.querySelector('[data-autofocus]') || sc.querySelector('button:not([disabled])');
      if (f) requestAnimationFrame(() => { if (this._screen === name) f.focus({ preventScroll: true }); });
    }
  }

  _push(name) {
    if (this._screen && this._screen !== name) this._stack.push(this._screen);
    this._set(name);
  }

  _root(name) {
    this._stack = [];
    this._set(name);
  }

  _closeAll() {
    this._stack = [];
    this._set(null);
    const a = document.activeElement;
    if (a && this.root.contains(a)) a.blur();
  }

  /** Step back to the screen that opened the current one (or close). Returns true if a screen was open. */
  back() {
    if (!this._screen) return false;
    const prev = this._stack.pop();
    if (prev) this._set(prev);
    else this._closeAll();
    return true;
  }

  _go(cbName, ...args) {
    this._closeAll();
    const fn = this.cb[cbName];
    if (fn) fn(...args);
  }

  _quit() {
    this._closeAll();
    if (this.cb.onQuit) this.cb.onQuit();
    if (!this._screen) this.showMenu();
  }

  get anyModalOpen() {
    return this._screen !== null;
  }

  // ================================================================ loading
  hideLoading() {
    const n = document.getElementById('loading');
    if (!n) return;
    n.classList.add('done');
    setTimeout(() => n.remove(), 500);
  }

  setTouchMode(on) {
    document.body.classList.toggle('touch', !!on);
  }

  // ================================================================== menu
  _buildMenu() {
    const s = this.screens.menu;
    s.innerHTML = `
<div class="menu-wrap">
  <div class="menu-brand">
    <div class="hazard"></div>
    <h1 class="menu-title">TOWER CRANE<br><span>SIMULATOR</span></h1>
    <p class="menu-sub">TC-6010 · 60 m jib · 8 t</p>
  </div>
  <div class="mach-sel" role="radiogroup" aria-label="Machine">
    <span class="ms-label">MACHINE</span>
    <button type="button" role="radio" class="ms-opt" data-mach="tower" aria-checked="true">${MACHINES.tower.label}</button>
    <button type="button" role="radio" class="ms-opt" data-mach="mobile" aria-checked="false">${MACHINES.mobile.label}</button>
  </div>
  <nav class="menu-nav">
    <button class="mbtn primary" type="button" data-act="free" data-autofocus>
      <span class="mb-t">Free Play</span><span class="mb-d mb-free">Open site, all loads, set your own weather</span>
    </button>
    <button class="mbtn" type="button" data-act="jobs">
      <span class="mb-t">Lift Jobs</span><span class="mb-d mb-jobs">${JOBS.length} scored training exercises</span>
    </button>
    <button class="mbtn" type="button" data-act="settings">
      <span class="mb-t">Settings</span><span class="mb-d">Graphics, weather, crane, audio</span>
    </button>
    <button class="mbtn" type="button" data-act="help">
      <span class="mb-t">Controls</span><span class="mb-d">Keyboard, gamepad and operating tips</span>
    </button>
  </nav>
  <p class="menu-foot">Keyboard · Gamepad · Touch &nbsp;—&nbsp; sound the horn before you move.</p>
</div>`;
    s.addEventListener('click', (e) => {
      const m = e.target.closest('[data-mach]');
      if (m) {
        // free-play machine (setting 'machine'); jobs carry their own machine
        const v = m.dataset.mach;
        this._settings.machine = v;
        if (this.cb.onSetting) this.cb.onSetting('machine', v);
        this._applyMenuMachine(v);
        return;
      }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'free') this._go('onFreePlay');
      else if (a === 'jobs') this.showJobs();
      else if (a === 'settings') this.showSettings();
      else if (a === 'help') this.showHelp();
    });
  }

  // menu branding + free-play text follow the selected machine
  _applyMenuMachine(id) {
    const live = this.cb.getSettings && this.cb.getSettings();
    if (!id && live) id = live.machine;
    const mid = id === 'mobile' ? 'mobile' : 'tower';
    const M = MACHINES[mid];
    const s = this.screens.menu;
    for (const b of s.querySelectorAll('[data-mach]')) {
      const on = b.dataset.mach === mid;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
    }
    const title = s.querySelector('.menu-title');
    if (title._m !== mid) { title._m = mid; title.innerHTML = M.title; }
    setText(s.querySelector('.menu-sub'), M.sub);
    const start = (live && live.mobileStart) || this._settings.mobileStart;
    setText(s.querySelector('.mb-free'), mid === 'tower'
      ? 'Open site, all loads, set your own weather'
      : start === 'road' ? 'Drive the AT-100 in from the public road and set it up' : 'AT-100 set up on pad P1 · 35 t counterweight');
    const n = (this._jobs || JOBS).filter((j) => (j.machine || 'tower') === mid).length;
    const total = (this._jobs || JOBS).length;
    setText(s.querySelector('.mb-jobs'), n === total ? `${total} scored training exercises` : `${total} scored training exercises · ${n} for this machine`);
  }

  showMenu() {
    const live = this.cb.getSettings && this.cb.getSettings();
    if (live) Object.assign(this._settings, live);
    this._applyMenuMachine(this._settings.machine);
    this.mobile?.closeDialogs();
    this._root('menu');
  }

  hideMenu() {
    if (this._screen === 'menu' || this._stack.includes('menu')) this._closeAll();
  }

  // ================================================================== jobs
  _buildJobs() {
    const s = this.screens.jobs;
    s.innerHTML = `
<header class="sh-head">
  <div><div class="sh-kicker">Training</div><h2>Lift Jobs</h2></div>
  <button class="btn ghost" type="button" data-act="back">Back</button>
</header>
<p class="sh-lead">Certification-style exercises scored on time, sway, collisions, LMI trips, test lifts and placement accuracy.</p>
<ol class="joblist"></ol>`;
    this.el.jobList = s.querySelector('.joblist');
    s.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="back"]')) { this.back(); return; }
      const j = e.target.closest('[data-job]');
      if (j) this._go('onStartJob', j.dataset.job);
    });
  }

  showJobs(jobs, bestFn) {
    if (jobs) this._jobs = jobs;
    if (bestFn) this._bestFn = bestFn;
    const list = this._jobs || [];
    // grouped by machine (a job carries its machine; starting it activates that
    // machine). The free-play machine's group comes first; one group = no header.
    const first = this._settings.machine === 'mobile' ? 'mobile' : 'tower';
    const groups = [first, first === 'tower' ? 'mobile' : 'tower']
      .map((mid) => ({ mid, jobs: list.filter((j) => (j.machine === 'mobile' ? 'mobile' : 'tower') === mid) }))
      .filter((g) => g.jobs.length);
    const item = (j, i, mid) => {
      let best = null;
      try { best = this._bestFn ? this._bestFn(j.id) : null; } catch { best = null; }
      const badge = best !== null && best !== undefined
        ? `<span class="jl-best ${gradeClass(best)}"><small>BEST</small>${Math.round(best)}</span>`
        : '<span class="jl-best none"><small>BEST</small>—</span>';
      return `
<li>
  <button class="jl-item${mid === 'mobile' ? ' jl-mobile' : ''}" type="button" data-job="${esc(j.id)}">
    <span class="jl-num">${mid === 'mobile' ? `M${i + 1}` : String(i + 1).padStart(2, '0')}</span>
    <span class="jl-body">
      <span class="jl-module">${esc(j.module)}${j.blind ? ' <em class="tag-blind">BLIND LIFT</em>' : ''}</span>
      <span class="jl-title">${esc(j.title)}</span>
      <span class="jl-brief">${esc(j.brief)}</span>
    </span>
    <span class="jl-side">${badge}<span class="jl-par">par ${fmtTime(j.par || 0)}</span></span>
  </button>
</li>`;
    };
    this.el.jobList.innerHTML = groups.map((g) =>
      (groups.length > 1 ? `<li class="jl-group" data-mach="${g.mid}">${esc(MACHINES[g.mid].group)}</li>` : '')
      + g.jobs.map((j, i) => item(j, i, g.mid)).join('')).join('');
    if (this._screen === 'jobs') this._set('jobs');
    else if (this._screen) this._push('jobs');
    else this._root('jobs');
  }

  // ============================================================== settings
  _buildSettings() {
    const s = this.screens.settings;
    const range = (key, label, min, max, step) => `
<label class="set-row">
  <span class="set-label">${label}</span>
  <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}">
  <output data-out="${key}"></output>
</label>`;
    const select = (key, label, opts) => `
<label class="set-row">
  <span class="set-label">${label}</span>
  <select data-key="${key}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
</label>`;
    const check = (key, label) => `
<label class="set-row set-check">
  <span class="set-label">${label}</span>
  <input type="checkbox" class="switch" data-key="${key}">
</label>`;
    s.innerHTML = `
<header class="sh-head">
  <div><div class="sh-kicker">Options</div><h2>Settings</h2></div>
  <button class="btn ghost" type="button" data-act="close">Close</button>
</header>
<div class="set-cols">
  <fieldset class="set-group">
    <legend>Graphics</legend>
    ${select('quality', 'Quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']])}
    ${range('hour', 'Time of day', 5, 21, 0.25)}
  </fieldset>
  <fieldset class="set-group">
    <legend>Weather</legend>
    ${select('weather', 'Sky', [['clear', 'Clear'], ['cloudy', 'Partly cloudy'], ['overcast', 'Overcast']])}
    ${range('windMean', 'Mean wind at jib height', 0, 25, 0.5)}
    ${range('gustiness', 'Gustiness', 0, 1, 0.05)}
    ${range('windDir', 'Wind direction', 0, 359, 1)}
  </fieldset>
  <fieldset class="set-group">
    <legend>Crane</legend>
    ${select('falls', 'Reeving', [['2', '2 falls (4 t)'], ['4', '4 falls (8 t)']])}
    ${select('slewMode', 'Slewing mode', [['0', 'SOFT'], ['1', 'NORMAL'], ['2', 'DYNAMIC']])}
    ${check('swayAssist', 'Sway Control assist')}
    ${check('zoneLimiter', 'Working-area limiter (road)')}
  </fieldset>
  <fieldset class="set-group">
    <legend>Mobile crane AT-100</legend>
    ${select('mobileStart', 'Free-play start', [['pad', 'On pad P1, set up (35 t)'], ['road', 'On the public road (drive in)']])}
    ${range('siteSpeedLimit', 'Site speed limit', 5, 20, 1)}
    ${check('timeWarp', 'Hold Z for ×4 time (no suspended load)')}
    ${check('quickBallast', 'Quick ballast (training, +120 s)')}
    ${check('allowBypass', 'Allow RCL emergency bypass (Ctrl+Shift+B)')}
  </fieldset>
  <fieldset class="set-group">
    <legend>Controls &amp; audio</legend>
    ${check('isoHoist', 'ISO hoist direction: ↑/stick forward = lower')}
    ${check('autoLook', 'Cab: head follows the load')}
    ${check('showHints', 'Show hints')}
    ${check('voice', 'Signaller radio voice')}
    ${range('volume', 'Volume', 0, 1, 0.05)}
  </fieldset>
</div>
<p class="set-note">Changes apply immediately. During a lift job the job's own wind conditions are used.</p>`;
    this._setInputs = {};
    for (const n of s.querySelectorAll('[data-key]')) this._setInputs[n.dataset.key] = n;
    this._setOutputs = {};
    for (const n of s.querySelectorAll('[data-out]')) this._setOutputs[n.dataset.out] = n;

    const read = (n) => {
      const k = n.dataset.key;
      if (n.type === 'checkbox') return n.checked;
      if (n.type === 'range') return Number(n.value);
      if (k === 'falls' || k === 'slewMode') return Number(n.value);
      return n.value;
    };
    const onChange = (e) => {
      const n = e.target;
      if (!n.dataset || !n.dataset.key) return;
      const k = n.dataset.key;
      const v = read(n);
      this._settings[k] = v;
      this._fmtOutput(k, v);
      if (this.cb.onSetting) this.cb.onSetting(k, v);
      // main may refuse a change (e.g. reeving with a load on the hook)
      const live = this.cb.getSettings && this.cb.getSettings();
      if (live && live[k] !== undefined && live[k] !== v) {
        this._settings[k] = live[k];
        this._fillSetting(k, live[k]);
      }
    };
    s.addEventListener('input', (e) => { if (e.target.type === 'range') onChange(e); });
    s.addEventListener('change', (e) => { if (e.target.type !== 'range') onChange(e); });
    s.addEventListener('click', (e) => { if (e.target.closest('[data-act="close"]')) this.back(); });
  }

  _fmtOutput(k, v) {
    const o = this._setOutputs[k];
    if (!o) return;
    let t = String(v);
    if (k === 'hour') t = fmtHour(v);
    else if (k === 'windMean') t = fmtWind(v);
    else if (k === 'gustiness' || k === 'volume') t = fmtPct(v);
    else if (k === 'windDir') t = fmtDir(v);
    else if (k === 'siteSpeedLimit') t = `${v} km/h`;
    o.textContent = t;
  }

  _fillSetting(k, v) {
    const n = this._setInputs[k];
    if (!n || v === undefined || v === null) return;
    if (n.type === 'checkbox') n.checked = !!v;
    else n.value = String(v);
    this._fmtOutput(k, v);
  }

  /** Keep the HUD's copy of the settings in sync without opening the panel. */
  setSettings(settings) {
    if (settings) Object.assign(this._settings, settings);
  }

  showSettings(settings) {
    const live = settings || (this.cb.getSettings && this.cb.getSettings());
    if (live) Object.assign(this._settings, live);
    for (const k of Object.keys(this._setInputs)) this._fillSetting(k, this._settings[k]);
    if (this._screen === 'settings') return;
    if (this._screen) this._push('settings');
    else this._root('settings');
  }

  // ================================================================== help
  _buildHelp() {
    const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join(' ');
    const row = (keys, text) => `<tr><th>${keys}</th><td>${text}</td></tr>`;
    this.screens.help.innerHTML = `
<header class="sh-head">
  <div><div class="sh-kicker">Operator manual</div><h2>Controls</h2></div>
  <button class="btn ghost" type="button" data-act="close">Close</button>
</header>
<div class="help-tabs" role="tablist">
  <button type="button" role="tab" class="ht" data-help="tower" aria-selected="true">${MACHINES.tower.label}</button>
  <button type="button" role="tab" class="ht" data-help="mobile" aria-selected="false">${MACHINES.mobile.label}</button>
</div>
<div class="help-cols help-pane" data-help="tower">
  <section>
    <h3>Keyboard</h3>
    <table class="keys">
      ${row(`${k('A')} ${k('D')} / ${k('←')} ${k('→')}`, 'Slew left / right')}
      ${row(`${k('W')} ${k('S')}`, 'Trolley out / in')}
      ${row(`${k('↑')} ${k('↓')} / ${k('I')} ${k('K')}`, 'Hoist up / down')}
      ${row(k('Shift'), 'Hold for Micromove (fine speed)')}
      ${row(k('P'), 'Power on — levers must be in neutral (zero-position interlock)')}
      ${row(k('Space'), 'Emergency stop')}
      ${row(k('H'), 'Horn — sound it before moving!')}
      ${row(k('R'), 'Hook on / release (release only when landed and slings are slack)')}
      ${row(`${k('Q')} ${k('E')}`, 'Tag line: rotate the load (only while it is low)')}
      ${row(k('C'), 'Change camera: cab / orbit / hook cam / signaller')}
      ${row('Mouse', 'Drag to look around, wheel to zoom')}
      ${row(k('M'), 'Slewing mode (SOFT / NORMAL / DYNAMIC)')}
      ${row(k('F'), 'Free slew — out-of-service weathervaning')}
      ${row(k('B'), 'Sway Control assist')}
      ${row(k('V'), 'Signaller voice')}
      ${row(k('Esc'), 'Pause')}
    </table>
  </section>
  <section>
    <h3>Gamepad</h3>
    <table class="keys">
      ${row('Left stick', 'Slew (↔) / trolley (↕)')}
      ${row('Right stick', 'Hoist')}
      ${row(k('A'), 'Hook on / release')}
      ${row(k('B'), 'Horn')}
      ${row(k('X'), 'Camera')}
      ${row(k('Y'), 'Power')}
      ${row(`${k('LB')} ${k('RB')}`, 'Tag line')}
      ${row(k('LT'), 'Micromove')}
      ${row(k('Back'), 'Emergency stop')}
      ${row(k('Start'), 'Pause')}
    </table>
    <h3>Operating tips</h3>
    <ul class="tips">
      <li><b>Test lift</b> every load: raise it 5–60 cm, hold 2 s, check brakes and rigging.</li>
      <li><b>Catch the swing:</b> drive the trolley or slew over the load at the end of its swing, then ease off.</li>
      <li><b>Watch the LMI:</b> pre-warning at ${Math.round(SAFETY.lmiWarn * 100)}%, cut-out at ${Math.round(SAFETY.lmiCutoff * 100)}% blocks hoist-up and trolley-out — hoist-down and trolley-in still work.</li>
      <li><b>Wind limits:</b> ${SAFETY.windWarn} m/s warning, ${SAFETY.windAlarm} m/s alarm, ${SAFETY.windStop} m/s stop. Large-area loads have lower limits.</li>
      <li><b>Jib spring-back:</b> the jib deflects under a heavy load and springs back when you trolley in — expect the load to bounce.</li>
    </ul>
  </section>
</div>
<div class="help-cols help-pane" data-help="mobile" hidden>
  <section>
    <h3>Crane cab (ISO 7752-2 cross-shift)</h3>
    <table class="keys">
      ${row(`${k('A')} ${k('D')}`, 'Slew left / right (left lever ↔)')}
      ${row(`${k('W')} ${k('S')}`, 'Telescope out / in (left lever away = extend)')}
      ${row(`${k('←')} ${k('→')}`, 'Luff up / down (right lever left = raise)')}
      ${row(`${k('↑')} ${k('↓')} / ${k('I')} ${k('K')}`, 'Hoist up / down (ISO setting inverts)')}
      ${row(k('Shift'), 'Micromove (10 %)')}
      ${row(k('P'), 'Power — levers in neutral; the RCL config opens')}
      ${row(k('L'), 'RCL configuration (enter the actual set-up)')}
      ${row(k('O'), 'Reeving / hook block (block landed, no load)')}
      ${row(`${k('T')} / ${k('F')}`, 'Turntable pin / free slew')}
      ${row(`${k('R')} / ${k('H')}`, 'Hook on / release (also releases the stowed block) / horn')}
      ${row(`${k('M')} / ${k('Q')} ${k('E')}`, 'Mute RCL horn / tag line')}
      ${row(`${k('Enter')} / ${k('Z')}`, 'Outrigger remote (SETUP) / hold for ×4 time')}
      ${row(`${k('Space')} / ${k('Tab')}`, 'Emergency stop / switch machine (free play)')}
    </table>
    <h3>Gamepad (crane)</h3>
    <table class="keys">
      ${row('Left stick', 'Slew (↔) / telescope (↕, up = out)')}
      ${row('Right stick', 'Luff (↔, left = up) / hoist (↕)')}
      ${row(`${k('A')} ${k('B')} ${k('X')} ${k('Y')}`, 'Hook / horn / camera / power')}
      ${row('D-pad', '↑ RCL config · ↓ setup · ← pin · → free slew')}
      ${row(`${k('LT')} / ${k('LB')} ${k('RB')} / ${k('R3')}`, 'Micromove / tag line / hold ×4')}
    </table>
  </section>
  <section>
    <h3>Driving (ROAD)</h3>
    <table class="keys">
      ${row(`${k('W')} ${k('S')} / ${k('A')} ${k('D')}`, 'Throttle / brake / steer (arrows too)')}
      ${row(`${k('X')} / ${k('K')}`, 'Gear D ↔ R (standstill) / steering ROAD → ALL → CRAB')}
      ${row(`${k('F')} / ${k('Shift')}`, 'Parking brake / crawl 5 km/h')}
      ${row(`${k('Enter')} / ${k('Space')}`, 'Set up here (stopped, parking brake) / engine')}
      ${row('Gamepad', 'LS steer · RT / LT throttle / brake · A gear · LB program · RB crawl · Y P-brake')}
    </table>
    <h3>Outrigger remote (SETUP)</h3>
    <table class="keys">
      ${row(`${k('1')}–${k('4')} / ${k('5')}`, 'Select FL · FR · RL · RR / all')}
      ${row(`${k('A')} ${k('D')}`, 'Beam in / out (stops at 0 / 50 / 100 % — hold to pass)')}
      ${row(`${k('W')} ${k('S')}`, 'Jack down (extend) / up')}
      ${row(`${k('X')} / ${k('G')}`, 'Mat / hold to auto-level')}
      ${row(`${k('B')} / ${k('T')}`, 'Hold: ballast raise-lower (pinned) / turntable pin')}
      ${row(`${k('Enter')} / ${k('⌫')}`, 'Crane cab / back to ROAD (travel interlock)')}
    </table>
    <h3>Operating tips</h3>
    <ul class="tips">
      <li><b>Enter the real set-up</b> in the RCL: it senses the beams but not the counterweight — a wrong CW is not caught until the crane tips.</li>
      <li><b>Mats, level, tyres clear:</b> set every float on a mat, level to ±0.3°, lift the tyres clear before the first lift.</li>
      <li><b>Extend first, then load:</b> telescoping under load is limited (TELE LOAD).</li>
      <li><b>Slew slowly</b> with long booms under load — watch the recommended rpm on the RCL.</li>
    </ul>
  </section>
</div>`;
    this.screens.help.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="close"]')) { this.back(); return; }
      const t = e.target.closest('[data-help]');
      if (t && t.classList.contains('ht')) this._helpTab(t.dataset.help);
    });
  }

  _helpTab(mid) {
    for (const n of this.screens.help.querySelectorAll('[data-help]')) {
      if (n.classList.contains('ht')) n.setAttribute('aria-selected', String(n.dataset.help === mid));
      else n.hidden = n.dataset.help !== mid;
    }
  }

  showHelp() {
    if (this._screen === 'help') return;
    // open on the machine being operated (from the menu: the free-play machine)
    this._helpTab(this._screen === 'menu' || !this._screen ? (this._settings.machine === 'mobile' ? 'mobile' : 'tower') : this._machine);
    if (this._screen) this._push('help');
    else this._root('help');
  }

  // ================================================================= pause
  _buildPause() {
    const s = this.screens.pause;
    s.innerHTML = `
<div class="pause-head"><div class="hazard small"></div><h2>Paused</h2><p>The crane is held. Levers are ignored while paused.</p></div>
<div class="btn-col">
  <button class="btn primary" type="button" data-act="resume" data-autofocus>Resume</button>
  <button class="btn" type="button" data-act="settings">Settings</button>
  <button class="btn" type="button" data-act="help">Controls</button>
  <button class="btn danger" type="button" data-act="quit">Quit to menu</button>
</div>`;
    s.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'resume') this._go('onResume');
      else if (a === 'settings') this.showSettings();
      else if (a === 'help') this.showHelp();
      else if (a === 'quit') this._quit();
    });
  }

  showPause(on) {
    if (on) this._root('pause');
    else if (this._screen === 'pause' || this._stack.includes('pause')) this._closeAll();
  }

  // =============================================================== results
  _buildResults() {
    const s = this.screens.results;
    s.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (a === 'retry') this._go('onRetry');
      else if (a === 'next') this._go('onNextJob');
      else if (a === 'jobs') this.showJobs();
      else if (a === 'free') this._go('onFreePlay');
      else if (a === 'menu') this._quit();
    });
  }

  // checklist: [{label, ok, value?}] — the mobile setup checklist (§8.5), shown as its own block;
  // critical: reason text of a critical failure (overturned, punch-through, …) → grade F badge
  showResults({ job, items = [], score = 0, grade = 'F', best = null, assisted = false, checklist = null, critical = null } = {}) {
    const s = this.screens.results;
    const newBest = best === null || best === undefined || score > best;
    const bestTxt = best === null || best === undefined ? 'First attempt' : `Previous best ${Math.round(best)}`;
    const rows = items.map((it) => {
      const pts = Number(it.pts) || 0;
      const cls = pts < 0 ? 'neg' : pts > 0 ? 'pos' : 'zero';
      const ptsTxt = pts === 0 ? '0' : pts > 0 ? `+${pts}` : `−${Math.abs(pts)}`;
      return `<tr class="${cls}"><th>${esc(it.label)}${it.note ? ` <em>${esc(it.note)}</em>` : ''}</th><td class="r-val">${esc(it.value)}</td><td class="r-pts">${ptsTxt}</td></tr>`;
    }).join('');
    const idx = job ? (this._jobs || JOBS).findIndex((j) => j.id === job.id) : -1;
    s.innerHTML = `
<header class="res-head">
  <div class="res-grade g-${esc(String(grade).toLowerCase())}" aria-label="Grade ${esc(grade)}">${esc(grade)}</div>
  <div class="res-sum">
    <div class="sh-kicker">Job complete${job && job.module ? ` · ${esc(job.module)}` : ''}</div>
    <h2>${esc(job ? job.title : 'Lift job')}</h2>
    <div class="res-score"><b>${Math.round(score)}</b><span>/100</span></div>
    <div class="res-badges">
      <span class="badge ${newBest && best !== null && best !== undefined ? 'good' : ''}">${newBest && best !== null && best !== undefined ? `New best · was ${Math.round(best)}` : esc(bestTxt)}</span>
      ${assisted ? '<span class="badge warn">Sway Control assisted</span>' : ''}
      ${critical ? `<span class="badge bad">CRITICAL · ${esc(critical)}</span>` : ''}
    </div>
  </div>
</header>
<div class="res-table-wrap">
  <table class="res-table">
    <thead><tr><th>KPI</th><th class="r-val">Result</th><th class="r-pts">Pts</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
${Array.isArray(checklist) && checklist.length ? `
<div class="res-check">
  <h3>Setup checklist</h3>
  <ul>${checklist.map((c) => `<li data-ok="${c.ok ? 1 : 0}"><i>${c.ok ? '✓' : '✗'}</i>${esc(c.label)}${c.value ? `<em>${esc(c.value)}</em>` : ''}</li>`).join('')}</ul>
</div>` : ''}
<div class="btn-row">
  <button class="btn primary" type="button" data-act="retry" data-autofocus>Retry</button>
  <button class="btn" type="button" data-act="next"${idx >= 0 && idx === (this._jobs || JOBS).length - 1 ? ' title="Back to the first job"' : ''}>Next job</button>
  <button class="btn" type="button" data-act="jobs">Job list</button>
  <button class="btn" type="button" data-act="free">Free play</button>
  <button class="btn ghost" type="button" data-act="menu">Main menu</button>
</div>`;
    this.progress(null);
    this._root('results');
  }

  // ============================================================= job card
  jobShow(job) {
    if (!job) return;
    const E = this.el;
    this._lastJob = job;
    E.jcModule.textContent = job.module || '';
    E.jcPar.textContent = job.par ? `PAR ${fmtTime(job.par)}` : '';
    E.jcTitle.textContent = job.title || '';
    E.jcBrief.textContent = job.brief || '';
    E.jcBlind.hidden = !job.blind;
    this._setBrief(!this._compact.matches);
    E.job.hidden = false;
  }

  jobHide() {
    this.el.job.hidden = true;
    this.progress(null);
    setText(this.el.jcStepLabel, 'STEP —');
    setText(this.el.jcStepText, '');
  }

  _setBrief(open) {
    this.el.job.classList.toggle('brief-open', open);
    this.el.jcToggle.setAttribute('aria-expanded', String(open));
  }

  jobStep(text, index, total) {
    const E = this.el;
    const n = Number.isFinite(index) ? index + 1 : 1;
    setText(E.jcStepLabel, total ? `STEP ${Math.min(n, total)}/${total}` : `STEP ${n}`);
    setText(E.jcStepText, text || '');
    if (n > 1 && E.job.classList.contains('brief-open')) this._setBrief(false);
    E.jcStep.classList.remove('flash');
    void E.jcStep.offsetWidth; // restart animation
    E.jcStep.classList.add('flash');
    this.progress(null);
  }

  progress(v) {
    const E = this.el;
    if (v === null || v === undefined || !Number.isFinite(v)) {
      setHidden(E.jcProgress, true);
      return;
    }
    setHidden(E.jcProgress, false);
    const f = Math.max(0, Math.min(1, v));
    const r = Math.round(f * 200) / 200;
    if (E.jcProgressFill._p !== r) {
      E.jcProgressFill._p = r;
      E.jcProgressFill.style.transform = `scaleX(${r})`;
    }
  }

  // =============================================================== toasts
  toast(text, kind = 'info') {
    const box = this.el.toasts;
    const existing = this._toasts.find((t) => t.text === text && !t.leaving);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this._dropToast(existing), 3500);
      existing.node.classList.remove('bump');
      void existing.node.offsetWidth;
      existing.node.classList.add('bump');
      return;
    }
    const k = ['good', 'warn', 'bad', 'info'].includes(kind) ? kind : 'info';
    const node = document.createElement('div');
    node.className = `toast t-${k}`;
    node.setAttribute('role', k === 'bad' ? 'alert' : 'status');
    node.textContent = text;
    box.appendChild(node);
    const t = { text, node, leaving: false, timer: 0 };
    t.timer = setTimeout(() => this._dropToast(t), 3500);
    this._toasts.push(t);
    const live = this._toasts.filter((x) => !x.leaving);
    if (live.length > 3) this._dropToast(live[0], true);
  }

  _dropToast(t, fast = false) {
    if (t.leaving) return;
    t.leaving = true;
    clearTimeout(t.timer);
    t.node.classList.add('out');
    setTimeout(() => {
      t.node.remove();
      this._toasts = this._toasts.filter((x) => x !== t);
    }, fast ? 180 : 380);
  }

  // ================================================================ radio
  radio(text) {
    const E = this.el;
    if (!text) return;
    E.radioText.textContent = text;
    E.radio.classList.remove('show');
    void E.radio.offsetWidth;
    E.radio.classList.add('show');
    clearTimeout(this._radioTimer);
    this._radioTimer = setTimeout(() => E.radio.classList.remove('show'), 4000);
  }

  // ======================================================== hook monitor
  hookMonitorRect() {
    if (!this._hookVisible || this.root.classList.contains('menu-mode')) return null;
    if (this._machine === 'mobile') return this.mobile.hookMonitorRect();
    const r = this.el.hookmon.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    return r;
  }

  setHookMonitorVisible(on) {
    on = !!on;
    this.mobile?.setHookMonitorVisible(on);
    if (on === this._hookVisible) return;
    this._hookVisible = on;
    this.el.hookmon.hidden = !on;
  }

  // ======================================================== machines
  /** Show the HUD of the active machine: 'tower' (LMI panel) or 'mobile' (AT-100 display). */
  setMachine(id) {
    const mob = id === 'mobile';
    const mid = mob ? 'mobile' : 'tower';
    if (mid === this._machine) return;
    this._machine = mid;
    this.root.classList.toggle('machine-mobile', mob);
    setHidden(this.el.lmi, mob);
    this.mobile.setVisible(mob);
    this._hintKey = null;
    this._chartKey = null;
  }

  get machine() { return this._machine; }

  // AT-100 dialogs (thin pass-throughs to this.mobile, see src/hudMobile.js)
  openConfigDialog(cfg, onOk, opts) { this.mobile.openConfigDialog(cfg, onOk, opts); }
  openReevingDialog(cur, onPick, opts) { this.mobile.openReevingDialog(cur, onPick, opts); }
  openBallastPanel(state) { this.mobile.openBallastPanel(state); }
  closeBallastPanel() { this.mobile.closeBallastPanel(); }
  closeMobileDialogs() { this.mobile.closeDialogs(); }
  setSetupChecklist(items) { this.mobile.setChecklist(items); }
  get mobileDialogOpen() { return this.mobile.dialogOpen; }

  // ============================================================ per-frame
  update(s) {
    if (!s) return;
    const now = performance.now();
    if (now - this._lastUpdate < UPDATE_INTERVAL) return;
    this._lastUpdate = now;
    const mobile = s.machine === 'mobile';
    // keep the settings copy roughly in sync with what the crane reports
    if (s.falls && !mobile) this._settings.falls = s.falls;
    if (typeof s.swayAssist === 'boolean' && !mobile) this._settings.swayAssist = s.swayAssist;
    if (typeof s.showHints === 'boolean') this._settings.showHints = s.showHints;
    if (this.root.classList.contains('menu-mode')) return;
    const E = this.el;

    // top bar
    setText(E.camName, s.cameraName || '—');
    setHidden(E.timer, !s.job);
    if (s.job) setText(E.time, fmtTime(s.jobTime || 0));

    if ((mobile ? 'mobile' : 'tower') !== this._machine) this.setMachine(mobile ? 'mobile' : 'tower');
    if (mobile) {
      this.mobile.update(s);
      this._updateHints(s);
      return;
    }

    // header
    setText(E.falls, `${s.falls || '—'} FALLS`);
    setText(E.mode, String(s.slewModeName || '—').toUpperCase());
    const pwrState = s.eStop ? 'estop' : s.power ? 'on' : 'off';
    setData(E.pwr, 's', pwrState);
    setText(E.pwrText, s.eStop ? 'E-STOP' : 'PWR');

    // load / SWL / moment
    const payload = Math.max(0, s.payload || 0);
    setText(E.load, (payload / 1000).toFixed(2));
    setText(E.swl, ((s.capacity || 0) / 1000).toFixed(2));
    const ratio = Math.max(0, s.ratio || 0);
    const lmiState = s.lmiState || 'ok';
    setText(E.momentVal, String(Math.round(ratio * 100)));
    setData(E.moment, 'state', lmiState);
    const f = Math.round((Math.min(ratio, 1.2) / 1.2) * 400) / 400;
    if (E.momentFill._f !== f) {
      E.momentFill._f = f;
      E.momentFill.style.transform = `scaleX(${f})`;
    }
    const cutText = lmiState === 'cut' ? 'CUT-OUT: HOIST ↑ / TROLLEY → BLOCKED' : s.maxLoadCut ? 'MAX LOAD: HOIST ↑ BLOCKED' : '';
    setHidden(E.cut, !cutText);
    if (cutText) setText(E.cut, cutText);

    // readouts
    setText(E.radius, (s.radius || 0).toFixed(1));
    setText(E.height, (s.hookHeight || 0).toFixed(1));
    let deg = Math.round(s.slewDeg || 0) % 360;
    if (deg < 0) deg += 360;
    setText(E.slew, String(deg).padStart(3, '0'));
    const wind = s.wind || 0;
    setText(E.wind, wind.toFixed(1));
    setText(E.windSub, `${Math.round(wind * 3.6)} km/h · gust ${(s.gustPeak || 0).toFixed(1)}`);
    setData(E.windCell, 'state', s.windState || 'ok');
    const hs = s.hoistSpeed || 0;
    setText(E.hoist, `${Math.abs(hs) >= 0.5 ? (hs > 0 ? '↑' : '↓') : ''}${Math.round(Math.abs(hs))}`);
    setText(E.hoistMax, `/ ${Math.round(s.hoistBandSpeed || 0)} m/min`);
    const ts = s.trolleySpeed || 0;
    setText(E.trolley, `${Math.abs(ts) >= 0.5 ? (ts > 0 ? '→' : '←') : ''}${Math.round(Math.abs(ts))}`);
    const rpm = s.slewRpm || 0;
    const ar = Math.abs(rpm);
    setText(E.rpm, `${ar >= 0.005 ? (rpm > 0 ? 'R ' : 'L ') : ''}${ar.toFixed(2)}`);

    // lamps
    const L = this.lamps;
    setData(L.pwr, 's', s.eStop ? 'blink' : s.power ? 'ok' : 'off');
    setData(L.brake, 's', s.brake ? 'on' : 'off');
    setData(L.lmi, 's', LMI_LAMP[lmiState] || 'ok');
    setData(L.maxload, 's', s.maxLoadCut ? 'bad' : 'off');
    setData(L.wind, 's', WIND_LAMP[s.windState] || 'off');
    setData(L.zone, 's', s.zoneActive ? 'warn' : 'off');
    setData(L.limit, 's', s.twoBlock ? 'bad' : 'off');
    setData(L.micro, 's', s.micro ? 'info' : 'off');
    setData(L.sway, 's', s.swayAssist ? 'ok' : 'off');
    setData(L.free, 's', s.freeSlew ? 'warn' : 'off');

    // lever position indicators
    const lv = s.levers || { slew: 0, trolley: 0, hoist: 0 };
    const q = (v) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 50) / 50;
    const lx = q(lv.slew), ly = q(lv.trolley), ry = q(lv.hoist);
    const lk = `${lx},${ly}`;
    if (E.lvLeft._k !== lk) {
      E.lvLeft._k = lk;
      E.lvLeft.style.transform = `translate(${lx * 15}px, ${-ly * 15}px)`;
      setClass(E.lvLeft, 'live', lx !== 0 || ly !== 0);
    }
    if (E.lvRight._k !== ry) {
      E.lvRight._k = ry;
      E.lvRight.style.transform = `translate(0px, ${-ry * 15}px)`;
      setClass(E.lvRight, 'live', ry !== 0);
    }

    // attached load
    if (s.loadName) {
      setText(E.llName, s.loadName);
      if (s.loadWindLimit !== null && s.loadWindLimit !== undefined) {
        setHidden(E.llWind, false);
        setText(E.llWind, `Wind limit ${Number(s.loadWindLimit).toFixed(1)} m/s`);
        setData(E.llWind, 's', wind > s.loadWindLimit ? 'bad' : wind > s.loadWindLimit * 0.85 ? 'warn' : 'ok');
      } else setHidden(E.llWind, true);
      if (s.slingAngle !== null && s.slingAngle !== undefined) {
        setHidden(E.llSling, false);
        setText(E.llSling, `Sling ${Math.round(s.slingAngle)}°`);
        setData(E.llSling, 's', s.slingAngle < 30 ? 'bad' : s.slingAngle < 45 ? 'warn' : 'ok');
      } else setHidden(E.llSling, true);
      setHidden(E.llState, false);
      setText(E.llState, s.grounded ? 'LANDED' : 'SUSPENDED');
      setData(E.llState, 's', s.grounded ? 'info' : 'ok');
    } else {
      setText(E.llName, 'HOOK ONLY');
      setHidden(E.llWind, true);
      setHidden(E.llSling, true);
      setHidden(E.llState, true);
    }

    // context hints
    this._updateHints(s);

    // load chart
    this._drawChart(s.falls || 4, s.radius || 0, payload, lmiState);
  }

  _updateHints(s) {
    const hints = [];
    if (s.showHints && s.machine === 'mobile') hints.push(...this.mobile.hints(s));
    else if (s.showHints) {
      const lv = s.levers || {};
      const neutral = Math.abs(lv.slew || 0) < 0.05 && Math.abs(lv.trolley || 0) < 0.05 && Math.abs(lv.hoist || 0) < 0.05;
      if (s.eStop) hints.push(['Space', 'E-STOP active — press P to reset', 'bad']);
      else if (!s.power) hints.push(['P', neutral ? 'power on' : 'levers to neutral, then power on', 'warn']);
      if (s.attachable) hints.push(['R', 'hook on', 'good']);
      if (s.canRelease) hints.push(['R', 'release', 'good']);
      if (s.twoBlock) hints.push(['', 'Upper hook limit — hoist down', 'warn']);
      if (s.lmiState === 'cut') hints.push(['', 'LMI cut-out — trolley in or hoist down', 'bad']);
      else if (s.maxLoadCut) hints.push(['', 'Max load — only hoist down allowed', 'bad']);
      if (s.windState === 'stop') hints.push(['', 'Wind stop — land the load, then free slew (F)', 'bad']);
      if (s.loadName && s.loadWindLimit !== null && s.loadWindLimit !== undefined && s.wind > s.loadWindLimit) {
        hints.push(['', 'Wind above this load’s limit — set it down', 'warn']);
      }
    }
    const key = hints.map((h) => h.join(':')).join('|');
    if (key === this._hintKey) return;
    this._hintKey = key;
    this.el.hints.innerHTML = hints.map(([k, t, kind]) =>
      `<span class="chip c-${kind}">${k ? `<kbd>${esc(k)}</kbd>` : ''}${esc(t)}</span>`).join('');
  }

  // ============================================================ load chart
  _drawChart(falls, radius, payload, state) {
    const cv = this.el.chart;
    let w = this._chartW, h = this._chartH;
    if (!w || !h) {
      if (typeof ResizeObserver !== 'undefined') return; // not laid out / hidden
      w = cv.clientWidth; h = cv.clientHeight;
      if (!w || !h) return;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const key = `${falls}|${w}|${h}|${dpr}`;
    if (key !== this._chartKey) {
      this._chartKey = key;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      this._chart = this._renderChartBase(falls, w, h, dpr);
      this._dotKey = null;
    }
    const dk = `${radius.toFixed(1)}|${(payload / 1000).toFixed(2)}|${state}`;
    if (dk === this._dotKey) return;
    this._dotKey = dk;
    const { base, X, Y, top, bottom, ymax } = this._chart;
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const col = STATE_COLOR[state] || STATE_COLOR.ok;
    const x = X(Math.max(0, Math.min(62, radius)));
    // radius cursor
    ctx.strokeStyle = 'rgba(200,255,220,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, top);
    ctx.lineTo(Math.round(x) + 0.5, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    // operating point
    const t = Math.min(ymax, payload / 1000);
    const y = Y(t);
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(x, y, payload > 5 ? 3.6 : 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (payload <= 5) {
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _renderChartBase(falls, w, h, dpr) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 18, padR = 6, padT = 6, padB = 13;
    const rMax = 62;
    const capMax = ratedCapacity(CRANE.trolleyMin, falls) / 1000;
    const ymax = capMax > 5 ? 9 : 4.5;
    const X = (r) => padL + (r / rMax) * (w - padL - padR);
    const Y = (t) => h - padB - (t / ymax) * (h - padT - padB);
    const top = padT, bottom = h - padB;

    // grid
    ctx.font = '600 8px "JetBrains Mono", ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(160,220,185,0.55)';
    ctx.strokeStyle = 'rgba(120,255,170,0.09)';
    ctx.lineWidth = 1;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let r = 0; r <= 60; r += 10) {
      const x = Math.round(X(r)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      if (r) ctx.fillText(String(r), x, bottom + 3);
    }
    const tStep = ymax > 5 ? 2 : 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let t = 0; t <= ymax + 1e-6; t += tStep) {
      const y = Math.round(Y(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      if (t) ctx.fillText(String(t), padL - 3, y);
    }

    // capacity curve
    const pts = [];
    for (let r = CRANE.trolleyMin; r <= CRANE.trolleyMax + 1e-6; r += 0.25) pts.push([r, ratedCapacity(r, falls) / 1000]);
    ctx.beginPath();
    ctx.moveTo(X(pts[0][0]), Y(0));
    for (const [r, t] of pts) ctx.lineTo(X(r), Y(t));
    ctx.lineTo(X(pts[pts.length - 1][0]), Y(0));
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, 'rgba(53,224,122,0.22)');
    g.addColorStop(1, 'rgba(53,224,122,0.03)');
    ctx.fillStyle = g;
    ctx.fill();

    // 90 % pre-warning line
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,176,32,0.6)';
    ctx.beginPath();
    pts.forEach(([r, t], i) => (i ? ctx.lineTo(X(r), Y(t * SAFETY.lmiWarn)) : ctx.moveTo(X(r), Y(t * SAFETY.lmiWarn))));
    ctx.stroke();
    ctx.setLineDash([]);

    // rated curve
    ctx.strokeStyle = '#35e07a';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach(([r, t], i) => (i ? ctx.lineTo(X(r), Y(t)) : ctx.moveTo(X(r), Y(t))));
    ctx.stroke();

    // datasheet points
    ctx.fillStyle = '#35e07a';
    for (const [r] of CHART_POINTS) {
      if (r < CRANE.trolleyMin || r > CRANE.trolleyMax) continue;
      ctx.beginPath();
      ctx.arc(X(r), Y(ratedCapacity(r, falls) / 1000), 1.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // axes
    ctx.strokeStyle = 'rgba(160,220,185,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL + 0.5, top);
    ctx.lineTo(padL + 0.5, bottom + 0.5);
    ctx.lineTo(w - padR, bottom + 0.5);
    ctx.stroke();

    return { base: c, X, Y, top, bottom, ymax };
  }
}

function gradeClass(score) {
  return score >= 90 ? 'g-a' : score >= 80 ? 'g-b' : score >= 70 ? 'g-c' : score >= 60 ? 'g-d' : 'g-f';
}
