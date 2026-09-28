import { fbm1, clamp } from '../util/math.js';
import { CRANE } from '../config.js';

// Gusty atmospheric wind with a logarithmic height profile.
// `mean` is the mean wind speed at jib height (what the anemometer shows on
// average); gusts rise fast and decay slowly, direction veers slowly.
const Z0 = 0.6; // roughness length for suburban / construction terrain
const REF_H = CRANE.mastTop + 3;

export class Wind {
  constructor() {
    this.mean = 4;
    this.gustiness = 0.5;
    this.baseDir = 0.6; // radians, direction the wind blows TOWARDS (xz plane)
    this.t = Math.random() * 1000;
    this.factor = 1;
    this.dir = this.baseDir;
    this.anemometer = this.mean;
    this.gustPeak = 0;
    this.ramp = null; // optional scripted change {from, to, duration, t}
  }

  setMean(v) { this.mean = Math.max(0, v); }

  update(dt) {
    this.t += dt;
    if (this.ramp) {
      this.ramp.t += dt;
      const k = clamp(this.ramp.t / this.ramp.duration, 0, 1);
      this.mean = this.ramp.from + (this.ramp.to - this.ramp.from) * k;
      if (k >= 1) this.ramp = null;
    }
    const t = this.t;
    const n = fbm1(t * 0.085, 3) * 0.6 + fbm1(t * 0.33 + 40, 3) * 0.3 + fbm1(t * 1.4 + 90, 2) * 0.1;
    // asymmetric: gusts spike above the mean more than lulls fall below it
    const g = n > 0 ? n * 2.1 : n * 0.9;
    this.factor = Math.max(0.05, 1 + this.gustiness * g);
    this.dir = this.baseDir + this.gustiness * 0.35 * fbm1(t * 0.03 + 300, 2);
    const atJib = this.speedAt(CRANE.mastTop + CRANE.catheadHeight);
    // 3-second gust averaging, like a real cup anemometer + display filter
    this.anemometer += (atJib - this.anemometer) * (1 - Math.exp(-dt / 1.2));
    this.gustPeak = Math.max(this.gustPeak * Math.exp(-dt / 20), this.anemometer);
  }

  speedAt(h) {
    const prof = Math.log(Math.max(h, 1.5) / Z0) / Math.log(REF_H / Z0);
    return this.mean * this.factor * prof;
  }

  // wind velocity vector at height h → out {x,z}
  velocityAt(h, out) {
    const s = this.speedAt(h);
    out.x = Math.cos(this.dir) * s;
    out.z = Math.sin(this.dir) * s;
    return out;
  }
}
