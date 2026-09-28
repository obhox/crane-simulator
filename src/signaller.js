import { wrapAngle } from './util/math.js';

// Radio signaller following the standard voice protocol:
//   function + direction → distance remaining → "<function> stop".
// Left/right are given from the operator's viewpoint. Uses the browser's
// speech synthesis where available; always shows a subtitle.
const THRESH = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50]; // ascending: pick the nearest callout
const TOWER_GEOM = { cx: 0, cz: 0, radialOut: 'Trolley out', radialIn: 'Trolley in' };

// Radial call words and the matching stop call ("Trolley stop" / "Boom stop").
const _words = new Map();
function radialWords(g) {
  const out = g.radialOut || 'Trolley out', inn = g.radialIn || 'Trolley in';
  const key = out + '|' + inn;
  let w = _words.get(key);
  if (!w) {
    w = { out, in: inn, stop: g.radialStop || `${out.split(' ')[0]} stop` };
    _words.set(key, w);
  }
  return w;
}

export class Signaller {
  constructor(audio, onText) {
    this.audio = audio;
    this.onText = onText;
    this.enabled = false;
    this.voiceOn = true;
    this.fn = null;
    this.lastCall = Infinity;
    this.cool = 0;
    this.voice = null;
    this.synth = window.speechSynthesis || null;
    if (this.synth) {
      const pick = () => {
        const vs = this.synth.getVoices();
        this.voice = vs.find((v) => /en-GB/i.test(v.lang) && /male|daniel|arthur/i.test(v.name))
          || vs.find((v) => /en-GB/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang)) || null;
      };
      pick();
      this.synth.onvoiceschanged = pick;
    }
  }

  say(text, urgent = false) {
    this.onText(text);
    this.audio.squelch();
    if (!this.voiceOn || !this.synth) return;
    if (urgent) this.synth.cancel();
    else if (this.synth.speaking || this.synth.pending) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.12;
    u.pitch = 0.92;
    u.volume = 0.9;
    this.synth.speak(u);
  }

  later(fn, ms) {
    clearTimeout(this._t);
    this._t = setTimeout(fn, ms);
  }

  reset() {
    clearTimeout(this._t);
    this.fn = null;
    this.lastCall = Infinity;
    if (this.synth) this.synth.cancel();
  }

  // geom: machine.signallerGeometry() = {cx, cz, radialOut, radialIn} (slew
  //   centre + radial words: 'Trolley out/in' for the tower, 'Boom down/up'
  //   for the luffing mobile boom). A legacy call passing the tower CraneSim
  //   (no numeric cx) means the tower: centre (0, 0), trolley words.
  // ref: current load (or hook) bottom-centre; target: {x,y,z} landing point (bottom-centre)
  // clearY: height the load must be above before travelling
  update(dt, geom, ref, target, clearY, swing) {
    if (!this.enabled || !target) return;
    this.cool -= dt;
    const g = geom && typeof geom.cx === 'number' ? geom : TOWER_GEOM;
    const cx = g.cx, cz = g.cz;
    const words = radialWords(g);
    const rNow = Math.hypot(ref.x - cx, ref.z - cz);
    const rT = Math.hypot(target.x - cx, target.z - cz);
    const thNow = Math.atan2(-(ref.z - cz), ref.x - cx);
    const thT = Math.atan2(-(target.z - cz), target.x - cx);
    const dth = wrapAngle(thT - thNow);
    const swingDist = Math.abs(dth) * Math.max(rT, 3);
    const dr = rT - rNow;
    const horiz = Math.hypot(target.x - ref.x, target.z - ref.z);
    const dh = ref.y - target.y;

    let fn, dist, dir;
    if (horiz > 2.5 && ref.y < clearY - 0.3) {
      fn = 'hoist'; dist = clearY - ref.y; dir = 'Hoist';
    } else if (swingDist > 0.8) {
      fn = dth > 0 ? 'swingL' : 'swingR'; dist = swingDist; dir = dth > 0 ? 'Swing left' : 'Swing right';
    } else if (Math.abs(dr) > 0.6) {
      fn = dr > 0 ? 'out' : 'in'; dist = Math.abs(dr); dir = dr > 0 ? words.out : words.in;
    } else if (dh > 0.12) {
      fn = 'lower'; dist = dh; dir = 'Lower';
    } else {
      fn = 'done'; dist = 0; dir = '';
    }

    if (fn !== this.fn) {
      const prev = this.fn;
      if (prev && prev !== 'done') {
        const stopWord = { hoist: 'Hoist stop', swingL: 'Swing stop', swingR: 'Swing stop', out: words.stop, in: words.stop, lower: 'Lower stop' }[prev];
        this.say(stopWord, true);
      }
      this.fn = fn;
      if (fn !== 'done') {
        const d = Math.round(dist);
        this.later(() => this.say(`${dir}${d >= 2 ? `, ${d} metres` : ', slowly'}`), prev ? 900 : 0);
      } else {
        this.later(() => this.say(this.pathStep ? 'That\'s good, next marker.' : 'All stop. Land it.'), 900);
      }
      this.lastCall = dist;
      this.cool = 1.4;
      return;
    }
    if (fn === 'done') return;
    if (this.cool <= 0) {
      const t = THRESH.find((x) => x < this.lastCall - 0.4 && dist <= x);
      if (t !== undefined) {
        this.lastCall = t;
        this.cool = 0.9;
        if (fn === 'lower' && t <= 2) this.say(`${t}, lower slowly`);
        else this.say(`${t}`);
      } else if (swing > 2.5 && this.cool < -6) {
        this.say('Watch your swing');
        this.cool = 2;
      }
    }
  }
}
