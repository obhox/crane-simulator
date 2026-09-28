// Fixed-time traffic signal controller shared by traffic, signal heads and
// pedestrians. Two stages per junction (traffic moving along x, then along z)
// with amber and all-red clearance, like a typical urban 2-phase plan. The
// offsets form a loose green wave (~40 km/h) along both road axes.
//
// state(node, axis) → 0 green · 1 amber · 2 red          (axis: 'x' | 'z')
// walk(node, axis)  → 0 walk · 1 flashing · 2 don't walk (pedestrians moving along axis)

export const CYCLE = 64;
const G_X = 27, A = 3, AR = 2;
const G_Z = CYCLE - G_X - 2 * A - 2 * AR; // 25

export class Signals {
  constructor(nodes) {
    this.t = 0;
    this.nodes = nodes.map((n, i) => ({ ...n, id: i, offset: ((n.x / 11 + n.z / 11) % CYCLE + CYCLE) % CYCLE }));
    this.byKey = new Map(this.nodes.map((n) => [key(n.x, n.z), n]));
    this.version = 0; // bumps whenever any stage changes (signal heads re-colour then)
    this._stage = new Int8Array(this.nodes.length).fill(-1);
  }

  get(x, z) { return this.byKey.get(key(x, z)) || null; }

  local(node) { return (this.t + node.offset) % CYCLE; }

  state(node, axis) {
    const u = this.local(node);
    if (axis === 'x') return u < G_X ? 0 : u < G_X + A ? 1 : 2;
    const z0 = G_X + A + AR;
    return u >= z0 && u < z0 + G_Z ? 0 : u >= z0 + G_Z && u < z0 + G_Z + A ? 1 : 2;
  }

  // amber + all-red for this axis: the moment queued left-turners clear the junction
  clearance(node, axis) {
    const u = this.local(node);
    if (axis === 'x') return u >= G_X && u < G_X + A + AR;
    return u >= CYCLE - A - AR;
  }

  walk(node, axis) {
    const u = this.local(node);
    const [g0, g] = axis === 'x' ? [0, G_X] : [G_X + A + AR, G_Z];
    const k = u - g0;
    if (k >= 0 && k < g * 0.55) return 0;
    if (k >= 0 && k < g) return 1;
    return 2;
  }

  // seconds until pedestrians moving along `axis` may start walking
  waitFor(node, axis) {
    const u = this.local(node);
    const g0 = axis === 'x' ? 0 : G_X + A + AR;
    return ((g0 - u) % CYCLE + CYCLE) % CYCLE;
  }

  update(dt) {
    this.t += dt;
    let changed = false;
    for (const n of this.nodes) {
      const u = this.local(n);
      // stage index 0..5 (x green, x amber, all red, z green, z amber, all red)
      const s = u < G_X ? 0 : u < G_X + A ? 1 : u < G_X + A + AR ? 2 : u < G_X + A + AR + G_Z ? 3 : u < CYCLE - AR ? 4 : 5;
      // pedestrian flashing toggles every 0.5 s → fold it into the stage id
      const w = (this.walk(n, 'x') === 1 || this.walk(n, 'z') === 1) ? (Math.floor(this.t * 2) & 1) : 0;
      const code = s * 2 + w;
      if (this._stage[n.id] !== code) { this._stage[n.id] = code; changed = true; }
    }
    if (changed) this.version++;
  }
}

export function key(x, z) { return `${Math.round(x)},${Math.round(z)}`; }
