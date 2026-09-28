// Fully synthesized sound (WebAudio): VFD drive motors with inverter whine,
// wind, horn, LMI pre-warning beeper vs overload siren, impacts, brake
// clunks, radio squelch. Starts on the first user gesture (autoplay rules).
//
// AT-100 mobile crane channel (updateMobile, spec §8.9): 6-cyl carrier and
// 4-cyl crane diesels (PeriodicWave firing harmonics, load-dependent
// combustion noise, turbo whistle, retarder), hydraulic pump whine and relief
// squeal, drive noises, outrigger beam/jack sounds, RCL beeper / long horn,
// float-light double beep, short warning horn, reverse alarm, air-brake psst,
// creak on float lift-off and the overturn crash. Mixed per camera (AUDIO_MIX).

import { AUDIO_MIX } from './mobile/config.js';

const ENGINE_HARM = { carrier: [1, 0.6, 0.45, 0.3, 0.2, 0.15], crane: [1, 0.5, 0.5, 0.25, 0.18, 0.1] };
const CYL = { carrier: 6, crane: 4 };

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
    this.muted = false;
    this.mix = { slew: 1, trolley: 0.5, hoist: 0.7, wind: 1 };
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w; // mix in some brown noise for body
      d[i] = w * 0.6 + b * 3;
    }

    this.slewV = this.motor(36, 0.9);
    this.trolleyV = this.motor(58, 0.7);
    this.hoistV = this.motor(44, 1.1);

    // wind
    const wsrc = this.noise();
    this.windBand = ctx.createBiquadFilter();
    this.windBand.type = 'bandpass';
    this.windBand.Q.value = 0.8;
    this.windBand.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wsrc.connect(this.windBand).connect(this.windGain).connect(this.master);
    const rsrc = this.noise();
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 140;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0.02;
    rsrc.connect(rlp).connect(this.rumbleGain).connect(this.master);

    // horn: two detuned square tones through a horn-ish filter
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const hf = ctx.createBiquadFilter();
    hf.type = 'lowpass';
    hf.frequency.value = 1800;
    for (const f of [412, 518]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(hf);
      o.start();
    }
    hf.connect(this.hornGain).connect(this.master);

    // LMI pre-warning beeper and overload siren (clearly different, per ISO 10245)
    this.beepGain = ctx.createGain();
    this.beepGain.gain.value = 0;
    const bo = ctx.createOscillator();
    bo.type = 'sine';
    bo.frequency.value = 2300;
    bo.connect(this.beepGain).connect(this.master);
    bo.start();
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'sawtooth';
    this.sirenOsc.frequency.value = 900;
    const sf = ctx.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 2500;
    this.sirenOsc.connect(sf).connect(this.sirenGain).connect(this.master);
    this.sirenOsc.start();
    this.t = 0;
  }

  noise() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.loopStart = Math.random();
    s.start(0, Math.random() * 1.5);
    return s;
  }

  motor(base, weight) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    lp.Q.value = 1.5;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    o1.connect(lp);
    o2.connect(g2).connect(lp);
    // gearbox noise
    const n = this.noise();
    const nb = ctx.createBiquadFilter();
    nb.type = 'bandpass';
    nb.frequency.value = 900;
    nb.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.value = 0.08;
    n.connect(nb).connect(ng).connect(lp);
    lp.connect(out);
    // inverter (PWM) whine — the signature sound of VFD crane drives
    const w = ctx.createOscillator();
    w.type = 'sine';
    const wg = ctx.createGain();
    wg.gain.value = 0;
    w.connect(wg).connect(this.master);
    out.connect(this.master);
    o1.start(); o2.start(); w.start();
    return { out, o1, o2, lp, w, wg, nb, base, weight, level: 0 };
  }

  setMotor(v, speed01, effort01, mixGain) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, Math.abs(speed01));
    const active = s > 0.004 || effort01 > 0.05;
    const target = active ? (0.05 + s * 0.12 + effort01 * 0.06) * v.weight * mixGain : 0;
    v.out.gain.setTargetAtTime(target, t, 0.08);
    const f = v.base * (0.6 + s * 1.9);
    v.o1.frequency.setTargetAtTime(f, t, 0.1);
    v.o2.frequency.setTargetAtTime(f * 0.5, t, 0.1);
    v.lp.frequency.setTargetAtTime(260 + s * 900 + effort01 * 300, t, 0.1);
    v.nb.frequency.setTargetAtTime(500 + s * 1400, t, 0.1);
    v.w.frequency.setTargetAtTime(700 + s * 2600, t, 0.08);
    v.wg.gain.setTargetAtTime(active ? (0.006 + s * 0.012) * mixGain : 0, t, 0.08);
  }

  update(dt, st) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.t += dt;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, t, 0.05);
    const m = this.mix;
    this.setMotor(this.slewV, st.slew, st.slewEffort, m.slew);
    this.setMotor(this.trolleyV, st.trolley, 0, m.trolley);
    this.setMotor(this.hoistV, st.hoist, st.hoistEffort, m.hoist);
    const wv = st.wind;
    this.windGain.gain.setTargetAtTime(Math.min(0.5, Math.pow(wv / 20, 1.6) * 0.45) * m.wind, t, 0.2);
    this.windBand.frequency.setTargetAtTime(250 + wv * 38, t, 0.3);
    this.rumbleGain.gain.setTargetAtTime(0.015 + Math.min(0.2, wv * 0.006) * m.wind, t, 0.3);
    this.hornGain.gain.setTargetAtTime(st.horn ? 0.16 : 0, t, 0.015);
    // beeper: 0.18 s on / 0.35 s off while in pre-warning
    const beepOn = st.lmi === 'warn' && (this.t % 0.53) < 0.18;
    this.beepGain.gain.setTargetAtTime(beepOn ? 0.07 : 0, t, 0.005);
    const siren = st.lmi === 'cut' || st.lmi === 'limit' || st.windAlarm;
    this.sirenGain.gain.setTargetAtTime(siren ? 0.05 : 0, t, 0.02);
    if (siren) this.sirenOsc.frequency.setTargetAtTime(900 + 500 * (0.5 + 0.5 * Math.sin(this.t * 7)), t, 0.01);
  }

  // ================================================================ mobile
  _initMobile() {
    const ctx = this.ctx;
    const m = (this.mob = { t: 0, shortT: 99, rclOn: false });
    const gain = (v = 0, dest = this.master) => { const g = ctx.createGain(); g.gain.value = v; g.connect(dest); return g; };
    const osc = (type, f, dest) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(dest); o.start(); return o; };
    const band = (type, f, q, dest) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.connect(dest); return b; };
    m.gain = gain; m.osc = osc; m.band = band;
    m.carrier = this._engineVoice(ENGINE_HARM.carrier);
    m.crane = this._engineVoice(ENGINE_HARM.crane);
    // retarder whoosh (exhaust brake / hydrodynamic retarder)
    m.retG = gain();
    this.noise().connect(band('bandpass', 220, 0.8, m.retG));
    // hydraulic pump: piston ripple whine + first harmonic
    m.pumpG = gain();
    m.pump1 = osc('sine', 200, m.pumpG);
    const p2g = gain(0.3, m.pumpG);
    m.pump2 = osc('triangle', 400, p2g);
    // relief valve squeal: narrow band noise at 2.4 kHz + a 1.1 kHz whistle
    m.reliefG = gain();
    this.noise().connect(band('bandpass', 2400, 9, m.reliefG));
    const rw = gain(0.25, m.reliefG);
    m.reliefO = osc('sine', 1100, rw);
    // drives: slew gear hum, winch motor, cylinder flow hiss (luff / tele)
    m.slewG = gain();
    m.slewO = osc('sawtooth', 55, band('lowpass', 260, 1, m.slewG));
    m.winchG = gain();
    m.winchO = osc('triangle', 60, band('lowpass', 500, 1.2, m.winchG));
    m.flowG = gain();
    m.flowB = band('bandpass', 1400, 1.6, m.flowG);
    this.noise().connect(m.flowB);
    m.teleG = gain();
    this.noise().connect(band('bandpass', 520, 1.4, m.teleG));
    // outriggers: beam slide (steel on wear pads) + jack hiss / groan
    m.beamG = gain();
    m.beamB = band('bandpass', 400, 1.3, m.beamG);
    this.noise().connect(m.beamB);
    m.jackG = gain();
    this.noise().connect(band('bandpass', 260, 1.1, m.jackG));
    const jg = gain(0.5, m.jackG);
    m.jackO = osc('sawtooth', 68, band('lowpass', 180, 2, jg));
    // RCL pre-warning beeper (0.18 s on / 0.35 s off) and float-light beeper
    m.beepG = gain();
    osc('sine', 2000, m.beepG);
    m.floatG = gain();
    osc('sine', 3100, m.floatG);
    // RCL long horn / short warning horn: harsh two-tone buzzer
    m.rclG = gain();
    const hf = band('lowpass', 2100, 0.7, m.rclG);
    osc('sawtooth', 440, hf); osc('sawtooth', 554, hf);
    // reverse alarm (1 kHz, 0.5 s on / off)
    m.revG = gain();
    osc('square', 1000, band('bandpass', 1000, 3, m.revG));
    // horns: truck air horn (ROAD) vs electric crane horn (cab)
    m.airHornG = gain();
    const ah = band('lowpass', 1500, 0.8, m.airHornG);
    osc('sawtooth', 285, ah); osc('sawtooth', 358, ah);
    m.elHornG = gain();
    const eh = band('lowpass', 1800, 0.7, m.elHornG);
    osc('square', 412, eh); osc('square', 518, eh);
  }

  // one diesel voice: firing-frequency PeriodicWave (+ detuned copy for the
  // cylinder-to-cylinder beat), combustion noise tracking the firing rate,
  // turbo whistle
  _engineVoice(harm) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    lp.Q.value = 0.8;
    lp.connect(out);
    const real = new Float32Array(harm.length + 1), imag = new Float32Array(harm.length + 1);
    harm.forEach((h, i) => { imag[i + 1] = h; });
    const wave = ctx.createPeriodicWave(real, imag);
    const o1 = ctx.createOscillator();
    o1.setPeriodicWave(wave);
    o1.connect(lp);
    const o2 = ctx.createOscillator();
    o2.setPeriodicWave(wave);
    const g2 = ctx.createGain();
    g2.gain.value = 0.45;
    o2.connect(g2).connect(lp);
    const nb = ctx.createBiquadFilter();
    nb.type = 'bandpass';
    nb.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    this.noise().connect(nb).connect(ng).connect(lp);
    const tw = ctx.createOscillator();
    tw.type = 'sine';
    const twg = ctx.createGain();
    twg.gain.value = 0;
    tw.connect(twg).connect(this.master);
    o1.start(); o2.start(); tw.start();
    return { out, lp, o1, o2, nb, ng, tw, twg };
  }

  _setEngine(v, rpm, cyl, load, mix) {
    const t = this.ctx.currentTime;
    const on = rpm > 50 && mix > 0;
    const f0 = Math.max(10, (rpm / 60) * (cyl / 2)); // 4-stroke firing frequency
    const r = Math.min(1.2, rpm / 1800);
    const L = Math.min(1, Math.max(0, load));
    v.o1.frequency.setTargetAtTime(f0, t, 0.06);
    v.o2.frequency.setTargetAtTime(f0 * 1.009, t, 0.06);
    v.lp.frequency.setTargetAtTime(150 + f0 * (3 + 6 * L), t, 0.1);
    v.nb.frequency.setTargetAtTime(f0 * 4, t, 0.1);
    v.ng.gain.setTargetAtTime(0.08 + 0.7 * L, t, 0.12);
    v.out.gain.setTargetAtTime(on ? (0.05 + 0.08 * r + 0.07 * L) * mix : 0, t, 0.15);
    v.tw.frequency.setTargetAtTime(2600 + 4200 * r, t, 0.3);
    v.twg.gain.setTargetAtTime(on ? 0.014 * r * r * L * mix : 0, t, 0.3);
  }

  // st = mobile.audioState(cameraMode, host):
  //   {engine{rpm,load,which:'carrier'|'crane'|'off',retarder?}, hyd{demand,relief}, slew, luff, tele, hoist (−1..1),
  //    outrigger{beam,jack,events[]}, rcl ('ok'|'warn'|'stop'|… or {state, muted}), warnings{wind,tilt,support,floatLight,muted?},
  //    reverse, horn, events[], active, menu?, cameraMode, mix?}
  // events are played once per call: audioState() must hand each one over only once.
  updateMobile(dt, st) {
    if (!this.ctx || !st) return;
    if (!this.mob) this._initMobile();
    const m = this.mob, t = this.ctx.currentTime;
    m.t += dt;
    const cam = AUDIO_MIX[st.cameraMode] || AUDIO_MIX.orbit;
    const mix = st.mix || cam;
    const live = !st.menu && st.active !== false; // the operated machine
    const idle = st.menu ? 0 : live ? 1 : 0.3; // a parked machine idles in the background
    const set = (g, v, tc = 0.06) => g.gain.setTargetAtTime(v, t, tc);
    const abs = (v) => Math.min(1, Math.abs(Number(v) || 0));

    // engines
    const e = st.engine || {};
    const which = e.which || 'crane';
    const rpm = e.rpm || 0;
    this._setEngine(m.carrier, which === 'carrier' || which === 'both' ? rpm : 0, CYL.carrier, e.load || 0, (mix.carrierEngine ?? 0.6) * idle);
    this._setEngine(m.crane, which === 'crane' || which === 'both' ? (e.craneRpm || rpm) : 0, CYL.crane, e.load || 0, (mix.craneEngine ?? 0.6) * idle);
    set(m.retG, abs(e.retarder) * 0.06 * (mix.carrierEngine ?? 0.6) * idle, 0.2);

    // hydraulics: pump whine ∝ flow demand, relief squeal when a drive stalls
    const hyd = st.hyd || {};
    const hMix = (mix.hydraulics ?? 0.6) * idle;
    const pf = Math.max(40, ((which === 'crane' ? (e.craneRpm || rpm) : rpm) / 60) * 9);
    m.pump1.frequency.setTargetAtTime(pf, t, 0.1);
    m.pump2.frequency.setTargetAtTime(pf * 2, t, 0.1);
    set(m.pumpG, rpm > 50 ? (0.004 + 0.03 * abs(hyd.demand)) * hMix : 0, 0.1);
    set(m.reliefG, hyd.relief && rpm > 50 ? 0.1 * hMix : 0, 0.03);
    m.reliefO.frequency.setTargetAtTime(1100 + 25 * Math.sin(m.t * 31), t, 0.01);

    // drives
    const sl = abs(st.slew), ho = abs(st.hoist), lu = abs(st.luff), te = abs(st.tele);
    m.slewO.frequency.setTargetAtTime(45 + 60 * sl, t, 0.1);
    set(m.slewG, sl > 0.002 ? (0.012 + 0.035 * sl) * hMix : 0, 0.1);
    m.winchO.frequency.setTargetAtTime(50 + 110 * ho, t, 0.1);
    set(m.winchG, ho > 0.002 ? (0.015 + 0.04 * ho) * hMix : 0, 0.1);
    m.flowB.frequency.setTargetAtTime(1100 + 900 * lu, t, 0.1);
    set(m.flowG, lu > 0.002 ? 0.03 * lu * hMix : 0, 0.08);
    set(m.teleG, te > 0.002 ? (0.01 + 0.035 * te) * hMix : 0, 0.08);

    // outriggers
    const o = st.outrigger || {};
    const bs = abs(o.beam), js = abs(o.jack);
    m.beamB.frequency.setTargetAtTime(300 + 600 * bs, t, 0.08);
    set(m.beamG, bs > 0.01 ? 0.08 * bs * hMix : 0, 0.06);
    m.jackO.frequency.setTargetAtTime(60 + 25 * js, t, 0.1);
    set(m.jackG, js > 0.01 ? 0.06 * js * hMix : 0, 0.06);

    // warnings (operator alarms: not camera-mixed, only silenced when not live)
    const rcl = typeof st.rcl === 'string' ? st.rcl : st.rcl?.state;
    const rclMuted = !!(st.rcl && typeof st.rcl === 'object' && st.rcl.muted);
    const w = st.warnings || {};
    const beepOn = live && rcl === 'warn' && (m.t % 0.53) < 0.18;
    set(m.beepG, beepOn ? 0.065 : 0, 0.005);
    const fp = m.t % 0.7;
    const floatOn = live && w.floatLight && (fp < 0.07 || (fp > 0.14 && fp < 0.21));
    set(m.floatG, floatOn ? 0.06 : 0, 0.004);
    // long horn while in STOP (continuous until released or muted); otherwise
    // a short 0.35 s horn every 5 s for tilt / wind / support-mismatch warnings
    const stop = live && (rcl === 'stop' || rcl === 'cut' || rcl === 'limit') && !rclMuted;
    const warnHorn = live && (w.tilt || w.wind || w.support) && !w.muted;
    if (warnHorn) m.shortT += dt; else m.shortT = 99;
    if (m.shortT > 5) m.shortT = 0;
    set(m.rclG, stop ? 0.075 : warnHorn && m.shortT < 0.35 ? 0.05 : 0, 0.01);
    const revOn = live && st.reverse && (m.t % 1.0) < 0.5;
    set(m.revG, revOn ? 0.05 * (st.cameraMode === 'driver' ? 0.5 : 1) : 0, 0.004);
    const horn = live && st.horn;
    set(m.airHornG, horn && which === 'carrier' ? 0.13 : 0, 0.015);
    set(m.elHornG, horn && which !== 'carrier' ? 0.14 : 0, 0.015);

    // one-shot events
    if (!st.menu) {
      const evMix = Math.max(0.35, hMix);
      if (st.events) for (const ev of st.events) this._mobileEvent(ev, evMix);
      if (o.events) for (const ev of o.events) this._mobileEvent(ev, evMix);
    }
  }

  _mobileEvent(ev, k = 1) {
    const type = typeof ev === 'string' ? ev : ev.type || ev.kind;
    const sp = (typeof ev === 'object' && Number(ev.speed)) || 0;
    switch (type) {
      case 'detent': this.clunk(0.18 * k); break;
      case 'beamEnd': this.clunk(0.3 * k); break;
      case 'jackEnd': this.clunk(0.14 * k); break;
      case 'touchdown': this.impact(Math.min(1.5, sp || 0.3) * k, 'thud', 6000); break;
      case 'mat': this.impact(0.25 * k, 'thud', 800); break;
      case 'pin': case 'unpin': case 'turntablePin': this.clunk(0.35 * k); this.impact(0.15 * k, 'metal', 300); break;
      case 'airBrake': case 'parkingBrake': case 'psst': this.psst(k); break;
      case 'brake': case 'slewBrake': this.clunk(0.12 * k); break;
      case 'gear': case 'shift': this.clunk(0.06 * k); break;
      case 'ballast': case 'cwClunk': this.clunk(0.4 * k); break;
      case 'hookRelease': case 'stow': this.clunk(0.2 * k); break;
      case 'liftoff': case 'creak': this.creak(1); break;
      case 'slam': this.impact(Math.min(3, sp || 1.5), 'metal', 60000); this.boom(0.6); break;
      case 'overturn': case 'crash': this.crash(); break;
      case 'collision': case 'boomContact': this.impact(Math.min(3, sp || 1), 'metal', 20000); break;
      case 'kerb': this.impact(ev.hard ? 1.2 : 0.5, 'thud', 10000); break;
      default: break;
    }
  }

  // air-brake release: short high-passed noise burst
  psst(level = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.14 * level, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(hp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.7);
  }

  // structural creak (a float lifting, the frame twisting): slow FM groan
  creak(level = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(95, t);
    o.frequency.linearRampToValueAtTime(70, t + 0.5);
    o.frequency.linearRampToValueAtTime(105, t + 0.9);
    o.frequency.linearRampToValueAtTime(80, t + 1.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12 * level, t + 0.15);
    g.gain.setValueAtTime(0.12 * level, t + 1.0);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
    o.connect(bp).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 1.6);
  }

  // low thump for heavy impacts (outrigger slam)
  boom(level = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.85);
  }

  // overturn: long debris noise, metal rings and a ground-shaking thud
  crash() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 2.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3.0);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 3.1);
    this.boom(1.4);
    this.impact(3, 'metal', 80000);
    setTimeout(() => this.impact(2, 'metal', 40000), 350);
    setTimeout(() => this.impact(1.2, 'metal', 20000), 900);
  }

  impact(speed, kind = 'thud', mass = 1000) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160 + Math.min(speed, 3) * 500;
    const g = ctx.createGain();
    const amp = Math.min(0.9, 0.15 + speed * 0.45) * Math.min(1.4, 0.6 + mass / 4000);
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35 + speed * 0.1);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.8);
    if (kind === 'metal') {
      for (const f of [420, 1130, 2210]) {
        const o = ctx.createOscillator();
        o.frequency.value = f * (0.95 + Math.random() * 0.1);
        const og = ctx.createGain();
        og.gain.setValueAtTime(amp * 0.12, t);
        og.gain.exponentialRampToValueAtTime(0.0005, t + 0.9);
        o.connect(og).connect(this.master);
        o.start(t);
        o.stop(t + 1);
      }
    }
  }

  clunk(level = 0.25) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.2);
  }

  squelch() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2000;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.2);
  }

  chime(ok = true) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const notes = ok ? [660, 880, 1320] : [440, 330];
    notes.forEach((f, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.11);
      g.gain.linearRampToValueAtTime(0.12, t + i * 0.11 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, t + i * 0.11 + 0.4);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.11);
      o.stop(t + i * 0.11 + 0.45);
    });
  }
}
