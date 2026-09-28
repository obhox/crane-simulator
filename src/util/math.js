export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const approach = (v, target, rate) => {
  if (v < target) return Math.min(v + rate, target);
  return Math.max(v - rate, target);
};
export const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

// Deterministic PRNG (mulberry32) so the procedural world is identical for everyone.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth 1D value noise, -1..1
const PERM = (() => {
  const r = rng(1337);
  const p = new Float32Array(512);
  for (let i = 0; i < 512; i++) p[i] = r() * 2 - 1;
  return p;
})();
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const a = PERM[i & 511];
  const b = PERM[(i + 1) & 511];
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}
export function fbm1(x, oct = 4) {
  let v = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += noise1(x * freq + i * 17.3) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return v / norm;
}
