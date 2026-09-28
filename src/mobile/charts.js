// AT-100 5.1 load charts (spec §2): literal tables, the verified generator,
// and the lookup rules the RCL uses (§2.3). Pure module (no three.js), so the
// node tests import it directly.
//
// Definition (§2): Chart(cfg, L, R) = floor_0.1t(min(STRUCT(L, R), P_stab)),
// where P_stab is the ISO 4305 rating (1.25P + 0.1F and the 4° tipping-angle
// criterion, worst slew over the support rectangle) of the §1.3 body model.
// Because the charts come from the same body model as src/mobile/stability.js,
// a correctly configured crane only tips through dynamics, wind, tilt or ground
// failure — and a WRONG configuration can tip it before the RCL cuts out.
// All values are kg GROSS (hook block and rigging included). The data are the
// spec's own fitted fiction, not a manufacturer table.

import { HOOK_BLOCKS, CW_CONFIGS, RMIN, TELE_LOAD, WIND_PERM, SLEW_REC_RPM, tableLookup, AXLES, AT100 } from './config.js';

// ---------------------------------------------------------------- §2.1 data
export const LENGTHS = [11.5, 15.2, 19.0, 22.7, 26.4, 30.1, 33.9, 37.6, 41.3, 45.0, 48.8, 52.0];
export const STRUCT = [ // structural / hook-block envelope (= LTM-reference 35 t full-base chart) [S1]
  [3,[82600,null,null,null,null,null,null,null,null,null,null,null]],
  [3.5,[79500,65000,61500,null,null,null,null,null,null,null,null,null]],
  [4,[72600,65800,62000,60600,null,null,null,null,null,null,null,null]],
  [4.5,[66700,65300,62600,58700,51300,null,null,null,null,null,null,null]],
  [5,[61600,61600,61000,55500,49300,41800,null,null,null,null,null,null]],
  [6,[53000,53300,53100,52500,46000,39300,32800,27800,null,null,null,null]],
  [7,[45900,46300,46200,46000,43700,37100,31100,26600,22400,null,null,null]],
  [8,[39500,40200,39900,39700,40000,35200,29300,25300,21400,18800,null,null]],
  [9,[34500,35100,34900,35000,35100,33500,27600,24000,20400,18100,14500,null]],
  [10,[null,31200,30800,32000,31500,31200,25800,22600,19500,17300,14000,11500]],
  [12,[null,24800,25400,25600,25400,25100,22500,19800,17600,16000,13300,10800]],
  [14,[null,null,20900,21000,20800,20500,19900,17500,15700,14600,12600,10200]],
  [16,[null,null,17500,17500,17400,17000,17000,15600,14100,13200,11900,9600]],
  [18,[null,null,null,14900,14700,14400,14700,13900,12700,12000,11000,9200]],
  [20,[null,null,null,12800,12500,12900,12600,12200,11500,10900,10100,8600]],
  [22,[null,null,null,null,10900,11300,10900,10500,10300,9900,9200,8200]],
  [24,[null,null,null,null,9600,9900,9500,9500,9300,9000,8500,7700]],
  [26,[null,null,null,null,null,8700,8500,8500,8200,8200,7800,7100]],
  [28,[null,null,null,null,null,7600,7800,7500,7500,7500,7200,6500]],
  [30,[null,null,null,null,null,null,7000,6700,6700,6600,6300,6000]],
  [32,[null,null,null,null,null,null,null,6200,6000,5900,5600,5500]],
  [34,[null,null,null,null,null,null,null,5600,5400,5300,5000,5000]],
  [36,[null,null,null,null,null,null,null,null,4900,4800,4500,4500]],
  [38,[null,null,null,null,null,null,null,null,4500,4400,4100,4100]],
  [40,[null,null,null,null,null,null,null,null,null,4000,3700,3700]],
  [42,[null,null,null,null,null,null,null,null,null,3600,3300,3300]],
  [44,[null,null,null,null,null,null,null,null,null,null,2900,2900]],
  [46,[null,null,null,null,null,null,null,null,null,null,2600,2600]],
  [48,[null,null,null,null,null,null,null,null,null,null,null,2300]],
  [50,[null,null,null,null,null,null,null,null,null,null,null,2000]],
];
// Full base 7.0 x 7.37 m, 360 deg, CW 35 t
export const B100_CW35000 = [
  [3,[82600,null,null,null,null,null,null,null,null,null,null,null]],
  [3.5,[79500,65000,61500,null,null,null,null,null,null,null,null,null]],
  [4,[72600,65800,62000,60600,null,null,null,null,null,null,null,null]],
  [4.5,[66700,65300,62600,58700,51300,null,null,null,null,null,null,null]],
  [5,[61600,61600,61000,55500,49300,41800,null,null,null,null,null,null]],
  [6,[53000,53300,53100,52500,46000,39300,32800,27800,null,null,null,null]],
  [7,[45900,46300,46200,46000,43700,37100,31100,26600,22400,null,null,null]],
  [8,[39500,40200,39900,39700,40000,35200,29300,25300,21400,18800,null,null]],
  [9,[34500,35100,34900,35000,35100,33500,27600,24000,20400,18100,14500,null]],
  [10,[null,31200,30800,32000,31500,31200,25800,22600,19500,17300,14000,11500]],
  [12,[null,24800,25400,25600,25400,25100,22500,19800,17600,16000,13300,10800]],
  [14,[null,null,20900,21000,20800,20500,19900,17500,15700,14600,12600,10200]],
  [16,[null,null,17500,17500,17400,17000,17000,15600,14100,13200,11900,9600]],
  [18,[null,null,null,14900,14700,14400,14700,13900,12700,12000,11000,9200]],
  [20,[null,null,null,12800,12500,12900,12600,12200,11500,10900,10100,8600]],
  [22,[null,null,null,null,10900,11200,10900,10500,10300,9900,9200,8200]],
  [24,[null,null,null,null,9600,9700,9500,9500,9300,9000,8500,7700]],
  [26,[null,null,null,null,null,8500,8500,8500,8200,8200,7800,7100]],
  [28,[null,null,null,null,null,7500,7800,7500,7500,7500,7200,6500]],
  [30,[null,null,null,null,null,null,6900,6700,6700,6600,6300,6000]],
  [32,[null,null,null,null,null,null,null,6200,6000,5900,5600,5500]],
  [34,[null,null,null,null,null,null,null,5600,5400,5300,5000,5000]],
  [36,[null,null,null,null,null,null,null,null,4900,4800,4500,4500]],
  [38,[null,null,null,null,null,null,null,null,4500,4300,4000,4000]],
  [40,[null,null,null,null,null,null,null,null,null,3800,3600,3600]],
  [42,[null,null,null,null,null,null,null,null,null,3400,3100,3100]],
  [44,[null,null,null,null,null,null,null,null,null,null,2800,2800]],
  [46,[null,null,null,null,null,null,null,null,null,null,2400,2400]],
  [48,[null,null,null,null,null,null,null,null,null,null,null,2100]],
  [50,[null,null,null,null,null,null,null,null,null,null,null,1800]],
];
// Full base, CW 11.5 t
export const B100_CW11500 = [
  [3,[82600,null,null,null,null,null,null,null,null,null,null,null]],
  [3.5,[79500,65000,61500,null,null,null,null,null,null,null,null,null]],
  [4,[72600,65800,62000,60600,null,null,null,null,null,null,null,null]],
  [4.5,[66700,65300,62600,58700,51300,null,null,null,null,null,null,null]],
  [5,[61600,61600,59500,54800,49300,41800,null,null,null,null,null,null]],
  [6,[52200,49500,46300,43100,40000,36900,32800,27800,null,null,null,null]],
  [7,[41200,39800,37600,35300,32900,30600,29700,26600,22400,null,null,null]],
  [8,[32400,33200,31500,29700,27800,25900,25300,24500,21400,18800,null,null]],
  [9,[26400,27600,27000,25500,23900,22300,21900,21300,20400,18100,14500,null]],
  [10,[null,23200,23400,22300,20900,19400,19200,18700,18000,17200,14000,11500]],
  [12,[null,17300,17500,17300,16400,15200,15200,14900,14400,13700,12900,10800]],
  [14,[null,null,13700,13500,13100,12300,12300,12100,11700,11200,10500,10200]],
  [16,[null,null,11100,10900,10500,9900,10200,10100,9700,9300,8700,8500]],
  [18,[null,null,null,8900,8500,8000,8400,8500,8200,7800,7200,7100]],
  [20,[null,null,null,7400,7100,6600,6900,7100,6900,6500,6000,5900]],
  [22,[null,null,null,null,5900,5400,5800,5900,5900,5500,5100,5000]],
  [24,[null,null,null,null,4900,4500,4800,5000,4900,4700,4300,4200]],
  [26,[null,null,null,null,null,3700,4000,4200,4100,3900,3600,3500]],
  [28,[null,null,null,null,null,3000,3400,3500,3500,3300,3000,2900]],
  [30,[null,null,null,null,null,null,2800,2900,2900,2700,2400,2400]],
  [32,[null,null,null,null,null,null,null,2400,2400,2200,2000,1900]],
  [34,[null,null,null,null,null,null,null,2000,2000,1800,1500,1500]],
  [36,[null,null,null,null,null,null,null,null,1600,1400,1200,1200]],
  [38,[null,null,null,null,null,null,null,null,1300,1100,800,800]],
  [40,[null,null,null,null,null,null,null,null,null,800,500,500]],
  [42,[null,null,null,null,null,null,null,null,null,500,null,null]],
];
// Reduced base 5.0 x 7.37 m (beams 50 %), 360 deg, CW 35 t
export const B50_CW35000 = [
  [3,[82600,null,null,null,null,null,null,null,null,null,null,null]],
  [3.5,[79500,65000,61500,null,null,null,null,null,null,null,null,null]],
  [4,[72600,65800,62000,60600,null,null,null,null,null,null,null,null]],
  [4.5,[66700,65300,62600,58700,51300,null,null,null,null,null,null,null]],
  [5,[61600,61600,61000,55500,49300,41800,null,null,null,null,null,null]],
  [6,[53000,53300,53100,52500,46000,39300,32800,27800,null,null,null,null]],
  [7,[45900,46300,46200,46000,43400,37100,31100,26600,22400,null,null,null]],
  [8,[39500,40200,39900,39300,37100,34900,29300,25300,21400,18800,null,null]],
  [9,[34500,35100,34900,34100,32300,30400,27600,24000,20400,18100,14500,null]],
  [10,[null,31000,30800,30100,28500,26800,25800,22600,19500,17300,14000,11500]],
  [12,[null,23600,23800,23600,22800,21500,21300,19800,17600,16000,13300,10800]],
  [14,[null,null,19000,18800,18400,17700,17700,17400,15700,14600,12600,10200]],
  [16,[null,null,15700,15500,15100,14500,14900,14700,14100,13200,11900,9600]],
  [18,[null,null,null,13000,12600,12100,12500,12600,12300,11800,11000,9200]],
  [20,[null,null,null,11000,10700,10200,10500,10700,10600,10200,9700,8600]],
  [22,[null,null,null,null,9100,8700,9000,9200,9100,8900,8400,8200]],
  [24,[null,null,null,null,7900,7400,7800,7900,7900,7700,7400,7200]],
  [26,[null,null,null,null,null,6400,6800,6900,6800,6700,6400,6300]],
  [28,[null,null,null,null,null,5500,5900,6000,6000,5800,5500,5500]],
  [30,[null,null,null,null,null,null,5100,5300,5200,5000,4800,4800]],
  [32,[null,null,null,null,null,null,null,4600,4600,4400,4100,4100]],
  [34,[null,null,null,null,null,null,null,4100,4000,3900,3600,3600]],
  [36,[null,null,null,null,null,null,null,null,3500,3400,3100,3100]],
  [38,[null,null,null,null,null,null,null,null,3100,2900,2700,2700]],
  [40,[null,null,null,null,null,null,null,null,null,2500,2300,2300]],
  [42,[null,null,null,null,null,null,null,null,null,2200,1900,1900]],
  [44,[null,null,null,null,null,null,null,null,null,null,1600,1600]],
  [46,[null,null,null,null,null,null,null,null,null,null,1300,1300]],
  [48,[null,null,null,null,null,null,null,null,null,null,null,1100]],
  [50,[null,null,null,null,null,null,null,null,null,null,null,800]],
];
// Reduced base 5.0 m, CW 11.5 t
export const B50_CW11500 = [
  [3,[82600,null,null,null,null,null,null,null,null,null,null,null]],
  [3.5,[79500,65000,61500,null,null,null,null,null,null,null,null,null]],
  [4,[69100,63100,57100,51700,null,null,null,null,null,null,null,null]],
  [4.5,[56900,53000,48600,44400,40500,null,null,null,null,null,null,null]],
  [5,[48300,45500,42200,38800,35600,32500,null,null,null,null,null,null]],
  [6,[36700,35200,33100,30800,28400,26100,25300,24200,null,null,null,null]],
  [7,[29200,28500,27000,25300,23400,21600,21100,20300,19400,null,null,null]],
  [8,[23100,23800,22700,21300,19800,18200,17900,17300,16600,15700,null,null]],
  [9,[18800,19900,19400,18200,16900,15600,15400,15000,14400,13600,12700,null]],
  [10,[null,16800,16800,15900,14700,13500,13400,13100,12600,11900,11100,10800]],
  [12,[null,12400,12600,12400,11400,10400,10500,10300,9900,9300,8700,8400]],
  [14,[null,null,9800,9600,9100,8200,8300,8200,7900,7400,6800,6700]],
  [16,[null,null,7800,7600,7200,6500,6700,6600,6400,6000,5500,5300]],
  [18,[null,null,null,6100,5700,5200,5500,5400,5200,4800,4400,4200]],
  [20,[null,null,null,4900,4600,4100,4400,4500,4300,3900,3500,3400]],
  [22,[null,null,null,null,3700,3200,3500,3700,3500,3200,2700,2600]],
  [24,[null,null,null,null,2900,2400,2800,2900,2800,2500,2100,2000]],
  [26,[null,null,null,null,null,1800,2200,2300,2300,2000,1600,1500]],
  [28,[null,null,null,null,null,1300,1700,1800,1800,1500,1100,1100]],
  [30,[null,null,null,null,null,null,1300,1400,1300,1100,700,700]],
  [32,[null,null,null,null,null,null,null,1000,1000,800,null,null]],
  [34,[null,null,null,null,null,null,null,700,600,null,null,null]],
];
// Beams retracted (0 %, 2.5 m base), jacks down, CW 0 t only
export const B0_CW0 = [
  [3,[19000,null,null,null,null,null,null,null,null,null,null,null]],
  [3.5,[15400,15200,14000,null,null,null,null,null,null,null,null,null]],
  [4,[12700,12800,11900,10700,null,null,null,null,null,null,null,null]],
  [4.5,[10700,10900,10200,9200,8000,null,null,null,null,null,null,null]],
  [5,[9100,9400,8900,8000,6900,5700,null,null,null,null,null,null]],
  [6,[6700,7200,6800,6100,5200,4200,4300,4100,null,null,null,null]],
  [7,[5000,5600,5300,4700,3900,3000,3200,3100,2800,null,null,null]],
  [8,[3800,4400,4200,3700,3000,2100,2400,2300,2100,1700,null,null]],
  [9,[2800,3400,3300,2900,2200,1400,1700,1700,1400,1100,600,null]],
  [10,[null,2700,2600,2200,1600,800,1100,1100,900,600,null,null]],
  [12,[null,1600,1500,1200,600,null,null,null,null,null,null,null]],
  [14,[null,null,800,null,null,null,null,null,null,null,null,null]],
];
// On tyres (suspension locked, 1.33P+0.1F and 4.5 deg [S10]), 360 deg, CW 0 only, boom <= 19.0 m (columns 11.5 / 15.2 / 19.0)
export const TYRES_CW0 = [
  [3,[16200,null,null]],[3.5,[13200,13000,11900]],[4,[10900,11000,10100]],[4.5,[9200,9400,8700]],[5,[7800,8100,7600]],
  [6,[5700,6100,5800]],[7,[4200,4700,4500]],[8,[3100,3700,3500]],[9,[2300,2800,2700]],[10,[null,2200,2100]],[12,[null,1200,1100]],
];

// Over-rear option (Phase 3, needs hb100; CW 35 t, full base, L 11.5 m, slew
// within ±5° of 180°). Structural; the load stays inside the rear tipping line.
export const OVER_REAR_115 = [[2.7, 100000], [3, 94400], [3.5, 86100], [4, 77900], [4.5, 71100], [5, 65300], [6, 55000], [7, 47100], [8, 40900], [9, 35800]];

// ------------------------------------------------------ §2.2 generator (verified)
// Stability body model in tonnes / m (§1.3, all [F]). Kept literal so the
// generator is bit-identical to the spec's node/Python reference; the test
// checks it against src/mobile/config.js.
export const STAB = {
  pivot: { u: -2.00, z: 3.71 }, floatX: { front: 4.58, rear: -2.79 }, carrier: { m: 19.1, x: 1.84, z: 1.55 },
  upper: { m: 15.9, u: -0.63, z: 2.60 }, luffCyl: { m: 1.6, u: -0.60, z: 3.00 }, cw: { u: -3.18, z: 2.45 },
  boom: { baseLen: 11.5, secLen: 11.3, stroke: 8.1, nTele: 5, secMass: [1.625, 1.625, 1.625, 1.625, 1.625, 1.625], headMass: 0.35 },
};

// Section extensions e[0..4] (T1..T5, 0..1) that give boom length L when the
// boom follows the §3.4 outer-first sequence (46 % T5..T1, 92 % T5..T1, 100 % T5..T1).
export function sectionExt(L) {
  const B = STAB.boom, step = B.stroke * 0.46, e = new Array(B.nTele).fill(0), d = L - B.baseLen;
  if (d <= 0) return e;
  const top = 2 * B.nTele * step;
  if (d <= top + 1e-9) {
    const k = d / step, full = Math.floor(k / B.nTele), rem = k - full * B.nTele;
    for (let j = 0; j < B.nTele; j++) e[B.nTele - 1 - j] = 0.46 * full + 0.46 * Math.min(1, Math.max(0, rem - j));
    return e;
  }
  const r = (d - top) / (B.stroke * 0.08);
  for (let j = 0; j < B.nTele; j++) e[B.nTele - 1 - j] = 0.92 + 0.08 * Math.min(1, Math.max(0, r - j));
  return e;
}

// Boom mass (t) and CG distance d (m) from the pivot along the boom axis.
// ext: optional actual section extensions (TeleBoom.ext); default = sectionExt(L).
export function boomMassCG(L, ext = null) {
  const B = STAB.boom, e = ext || sectionExt(L);
  let s = B.secMass[0] * B.secLen / 2, pos = 0;
  for (let i = 1; i <= B.nTele; i++) { pos += e[i - 1] * B.stroke; s += B.secMass[i] * (pos + B.secLen / 2); }
  s += B.headMass * L;
  const m = B.secMass.reduce((a, b) => a + b, 0) + B.headMass;
  return { m, d: s / m };
}

// Body list [m (t), x_c, y_c, z_c] for CW cwT (t), boom L at head radius R
// (no deflection) and slew psi; F = ISO 4310 head-referred boom mass (t).
export function bodies(cwT, L, R, psi) {
  const S = STAB, c = Math.cos(psi), s = Math.sin(psi), bm = boomMassCG(L), dx = R - S.pivot.u, dz = Math.sqrt(Math.max(L * L - dx * dx, 0));
  const rot = [[S.upper.m, S.upper.u, S.upper.z], [S.luffCyl.m, S.luffCyl.u, S.luffCyl.z], [bm.m, S.pivot.u + bm.d * dx / L, S.pivot.z + bm.d * dz / L], [cwT, S.cw.u, S.cw.z]];
  const list = [[S.carrier.m, S.carrier.x, 0, S.carrier.z]];
  for (const [m, u, z] of rot) list.push([m, u * c, u * s, z]);
  return { list, F: bm.m * bm.d / L, zHead: S.pivot.z + dz };
}

// ISO 4305 rated load (t) over the polygon at slew psi: min over the edges the
// hook lies beyond of (P_tip − 0.1F)/k1 and the tipDeg tipping-angle criterion.
// −1 = the unloaded crane already tips over some edge.
export function ratedStability(cwT, L, R, psi, poly, k1 = 1.25, tipDeg = 4.0) {
  if (R - STAB.pivot.u > L) return 0;
  const { list, F, zHead } = bodies(cwT, L, R, psi), hx = R * Math.cos(psi), hy = R * Math.sin(psi), t = Math.tan(tipDeg * Math.PI / 180);
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length], ex = x2 - x1, ey = y2 - y1, lg = Math.hypot(ex, ey), nx = ey / lg, ny = -ex / lg;
    const dist = (x, y) => (x - x1) * nx + (y - y1) * ny, dh = dist(hx, hy);
    let Ms = 0, Mz = 0;
    for (const [m, x, y, z] of list) { Ms -= m * dist(x, y); Mz += m * z; }
    if (Ms <= 0) return -1;
    if (dh <= 0) continue;
    best = Math.min(best, (Ms / dh - 0.1 * F) / k1, (Ms - t * Mz) / (dh + t * zHead));
  }
  return best;
}
// Support rectangle in the carrier frame, CCW: float lines x_f / x_r, half-width halfW.
export const rect = (halfW, xf = 4.58, xr = -2.79) => [[xr, -halfW], [xf, -halfW], [xf, halfW], [xr, halfW]];
export function rated360(cwT, L, R, poly, k1, tipDeg) {
  let m = Infinity;
  for (let d = 0; d < 360; d += 5) m = Math.min(m, ratedStability(cwT, L, R, d * Math.PI / 180, poly, k1, tipDeg));
  return m;
}
export function buildChart(STRUCT, cwKg, halfW) {
  return STRUCT.map(([R, row]) => [R, row.map((s, i) => {
    if (s === null) return null;
    const p = rated360(cwKg / 1000, LENGTHS[i], R, rect(halfW));
    const v = Math.floor(Math.min(s / 1000, p) * 10 + 1e-6) / 10;
    return v < 0.5 ? null : Math.round(v * 1000);
  })]);
}

// On tyres the support polygon is the tyre-contact rectangle: outer axles
// (1 and 5) and the ±1.18 m tyre-centre track; rated 1.33P + 0.1F and 4.5°
// [S10]. buildTyresChart() reproduces TYRES_CW0 (test).
export const TYRES_RECT = rect(AT100.carrier.tyre.trackY, AXLES[0], AXLES[AXLES.length - 1]);
export function buildTyresChart(cwKg = 0, cols = 3) {
  return STRUCT.map(([R, row]) => [R, row.slice(0, cols).map((s, i) => {
    if (s === null) return null;
    const p = rated360(cwKg / 1000, LENGTHS[i], R, TYRES_RECT, 1.33, 4.5);
    const v = Math.floor(Math.min(s / 1000, p) * 10 + 1e-6) / 10;
    return v < 0.5 ? null : Math.round(v * 1000);
  })]).filter(([, row]) => row.some((v) => v !== null));
}

// Charts not printed in §2.1 are built at module load (§2.2).
export const B100_CW23500 = buildChart(STRUCT, 23500, 3.5);
export const B100_CW0 = buildChart(STRUCT, 0, 3.5);
export const B50_CW23500 = buildChart(STRUCT, 23500, 2.5);
export const B50_CW0 = buildChart(STRUCT, 0, 2.5);

export const CHARTS = Object.freeze({
  B100_CW0, B100_CW11500, B100_CW23500, B100_CW35000,
  B50_CW0, B50_CW11500, B50_CW23500, B50_CW35000,
  B0_CW0, TYRES_CW0,
});

// Beam detent → float half-width (§1.6; same numbers as config BASES).
const HALF_W = { 100: 3.5, 50: 2.5, 0: 1.25 };
const TYRES_MAX_K = 2; // tyres chart has columns 11.5 / 15.2 / 19.0 only

// ----------------------------------------------------- column index (fast lookup)
// COLS[key][k] = { R:[], v:[], s:[] (stability governed), rmin, rmax }: the
// valued rows of column k (contiguous in every table, §2.3.4).
const COLS = {};
for (const [key, table] of Object.entries(CHARTS)) {
  const ncol = table[0][1].length;
  COLS[key] = [];
  for (let k = 0; k < ncol; k++) {
    const c = { R: [], v: [], s: [], rmin: 0, rmax: 0 };
    for (const [R, row] of table) {
      if (row[k] === null) continue;
      const st = STRUCT.find((r) => r[0] === R)?.[1][k] ?? null;
      c.R.push(R); c.v.push(row[k]); c.s.push(st !== null && row[k] < st);
    }
    if (c.R.length) { c.rmin = c.R[0]; c.rmax = c.R[c.R.length - 1]; }
    COLS[key].push(Object.freeze(c));
  }
}
const STRUCT_COLS = LENGTHS.map((_, k) => {
  const c = { R: [], v: [] };
  for (const [R, row] of STRUCT) if (row[k] !== null) { c.R.push(R); c.v.push(row[k]); }
  return c;
});

// linear interpolation in a column; R below the first valued row → first value
// (the RCL blocks luff-up there), R beyond the last → 0 (§2.3.4)
function colInterp(c, R) {
  const n = c ? c.R.length : 0;
  if (!n) return 0;
  if (R <= c.R[0]) return c.v[0];
  if (R > c.R[n - 1] + 1e-9) return 0;
  for (let i = 0; i < n - 1; i++) {
    if (R <= c.R[i + 1]) return c.v[i] + (c.v[i + 1] - c.v[i]) * (R - c.R[i]) / (c.R[i + 1] - c.R[i]);
  }
  return c.v[n - 1];
}
function colGoverned(c, R) {
  const n = c ? c.R.length : 0;
  if (!n) return false;
  if (R <= c.R[0]) return c.s[0];
  for (let i = 0; i < n - 1; i++) if (R <= c.R[i + 1]) return c.s[i] || c.s[i + 1];
  return c.s[n - 1];
}

// ------------------------------------------------------------- §2.3 rules
// Geometric pinned lengths (11.5 + 3.726·k, k ≤ 10; 52.0) — the chart labels
// are these rounded to 0.1 m, so length matching uses a 5 cm tolerance.
export const PIN_GEOM = LENGTHS.map((_, k) => (k < 11 ? STAB.boom.baseLen + STAB.boom.stroke * 0.46 * k : 52.0));
const L_TOL = 0.05;

// Chart columns bracketing boom length L: {lo, hi, exact} (exact → lo === hi).
export function columnFor(L) {
  let lo = 0, hi = LENGTHS.length - 1;
  for (let k = 0; k < LENGTHS.length; k++) {
    if (Math.abs(L - PIN_GEOM[k]) <= L_TOL || Math.abs(L - LENGTHS[k]) <= L_TOL) return { lo: k, hi: k, exact: true };
    if (PIN_GEOM[k] < L) lo = k;
  }
  hi = Math.min(LENGTHS.length - 1, lo + (L > PIN_GEOM[lo] ? 1 : 0));
  return { lo, hi, exact: lo === hi };
}

// Chart label for a boom length: the pinned geometric lengths (15.226, 30.13,
// 45.034 m …) map to their labels (15.2, 30.1, 45.0), anything else stays L.
// The length-keyed tables (T_tel, v_perm, recommended slew) are keyed by the
// labels, so a pinned 45.034 m boom must read the "≤ 45.0 m" row, not the next.
export function nominalLength(L) {
  for (let k = 0; k < LENGTHS.length; k++) if (Math.abs(L - PIN_GEOM[k]) <= L_TOL || Math.abs(L - LENGTHS[k]) <= L_TOL) return LENGTHS[k];
  return L;
}

// Telescoping segment of a boom length: index of the pin at its UPPER end,
// i.e. the first pinned length ≥ L (a boom standing exactly on pin k — e.g.
// during the 4 s pin event — belongs to the stroke below it). The telescopable
// load is a property of the stroke (§2.3.8: "L ≤ 33.9 m: 8 t" = strokes up to
// 33.9 m), so it is constant over a stroke instead of stepping 2 cm after a pin.
export function teleSegment(L) {
  for (let k = 0; k < PIN_GEOM.length; k++) if (PIN_GEOM[k] >= L - 1e-6) return k;
  return PIN_GEOM.length - 1;
}

// 1. chart key: B{base}_CW{cwKg} on outriggers, TYRES_CW{cwKg} on tyres (only CW0 exists)
export function chartKey(cfg) {
  if (!cfg) return null;
  return cfg.mode === 'tyres' ? `TYRES_CW${cfg.cwKg}` : `B${cfg.base}_CW${cfg.cwKg}`;
}

// 2. permitted configs, derived with the same body model (ISO 4305 backward
// stability [S10]): the boom-side supports must carry ≥ 15 % of the total with
// the shortest boom at 82°, no load, worst slew. Equal-stiffness plane sharing
// over the 4 floats reproduces the §2.3 table (41.4 / 32.2 / 25.8 / 21.4 %, …).
export const BACKWARD_MIN_SHARE = 0.15;
export const TYRES_MIN_TIP_DEG = 4.5;
function unloadedCoG(cwKg, psi) {
  const L = STAB.boom.baseLen, R = STAB.pivot.u + L * Math.cos(82 * Math.PI / 180);
  const { list } = bodies(cwKg / 1000, L, R, psi);
  let W = 0, X = 0, Y = 0, Z = 0;
  for (const [m, x, y, z] of list) { W += m; X += m * x; Y += m * y; Z += m * z; }
  return { W, X: X / W, Y: Y / W, Z: Z / W };
}
// worst-slew boom-side share (0..1) of the unloaded crane on floats at `base`
export function boomSideShare(cwKg, base) {
  const hw = HALF_W[base], xf = STAB.floatX.front, xr = STAB.floatX.rear, xc = (xf + xr) / 2;
  const P = [[xf, hw], [xf, -hw], [xr, hw], [xr, -hw]], sx = 4 * (xf - xc) ** 2, sy = 4 * hw * hw;
  let worst = Infinity;
  for (let d = 0; d < 360; d++) {
    const psi = d * Math.PI / 180, g = unloadedCoG(cwKg, psi), bx = Math.cos(psi), by = Math.sin(psi);
    const Rr = P.map(([x, y]) => Math.max(0, 0.25 + (g.X - xc) * (x - xc) / sx + g.Y * y / sy));
    const idx = [0, 1, 2, 3].sort((a, b) => (P[b][0] * bx + P[b][1] * by) - (P[a][0] * bx + P[a][1] * by));
    const tot = Rr.reduce((a, b) => a + b, 0);
    worst = Math.min(worst, tot > 0 ? (Rr[idx[0]] + Rr[idx[1]]) / tot : 0);
  }
  return worst;
}
// worst tipping angle (deg) of the unloaded crane on tyres (CoG margin / CoG height)
export function tyresTipAngleDeg(cwKg) {
  let worst = Infinity;
  const poly = TYRES_RECT;
  for (let d = 0; d < 360; d++) {
    const g = unloadedCoG(cwKg, d * Math.PI / 180);
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length], ex = x2 - x1, ey = y2 - y1, lg = Math.hypot(ex, ey);
      const inside = -((g.X - x1) * ey / lg + (g.Y - y1) * -ex / lg);
      worst = Math.min(worst, Math.atan2(inside, g.Z) * 180 / Math.PI);
    }
  }
  return worst;
}
const PERMIT_CACHE = new Map();
export function permitted(cfg) {
  if (!cfg) return { ok: false, reason: 'NO CONFIG' };
  const key = `${cfg.mode}|${cfg.base}|${cfg.cwKg}|${cfg.block}`;
  let r = PERMIT_CACHE.get(key);
  if (r) return r;
  if (!HOOK_BLOCKS[cfg.block]) r = { ok: false, reason: 'UNKNOWN HOOK BLOCK' };
  else if (!CW_CONFIGS.includes(cfg.cwKg)) r = { ok: false, reason: 'CW NOT IN CHART' };
  else if (cfg.mode === 'tyres') {
    const tip = tyresTipAngleDeg(cfg.cwKg);
    r = tip < TYRES_MIN_TIP_DEG ? { ok: false, reason: `CONFIG NOT PERMITTED: tipping angle ${tip.toFixed(1)}° < ${TYRES_MIN_TIP_DEG}° on tyres`, tipDeg: tip }
      : !CHARTS[chartKey(cfg)] ? { ok: false, reason: 'CONFIG NOT PERMITTED: no tyres chart for this CW' }
        : { ok: true, reason: '', tipDeg: tip };
  } else if (cfg.mode !== 'outriggers' || !(cfg.base in HALF_W)) r = { ok: false, reason: 'UNKNOWN SUPPORT BASE' };
  else {
    const share = boomSideShare(cfg.cwKg, cfg.base);
    r = share < BACKWARD_MIN_SHARE
      ? { ok: false, reason: share <= 1e-6 ? 'CONFIG NOT PERMITTED: tips backward unloaded' : `CONFIG NOT PERMITTED: backward stability ${(share * 100).toFixed(1)} % < 15 %`, share }
      : !CHARTS[chartKey(cfg)] ? { ok: false, reason: 'CONFIG NOT PERMITTED: no chart', share }
        : { ok: true, reason: '', share };
  }
  r = Object.freeze(r);
  PERMIT_CACHE.set(key, r);
  return r;
}

function cols(cfg) { return permitted(cfg).ok ? COLS[chartKey(cfg)] : null; }
const colAt = (cs, cfg, k) => (!cs || (cfg.mode === 'tyres' && k > TYRES_MAX_K) ? null : cs[k] || null);

// 7. Rmin by boom length (§2.3.7), linear between pinned lengths
export function rminFor(L) {
  const { lo, hi } = columnFor(L);
  if (lo === hi) return RMIN[lo];
  const t = (L - PIN_GEOM[lo]) / (PIN_GEOM[hi] - PIN_GEOM[lo]);
  return RMIN[lo] + (RMIN[hi] - RMIN[lo]) * Math.min(1, Math.max(0, t));
}
// Rmax = last valued row of the column (the conservative min between pins); 0 = no chart
export function rmaxFor(cfg, L, pinnedK = null) {
  const cs = cols(cfg);
  if (!cs) return 0;
  const { lo, hi } = pinnedK === null || pinnedK === undefined ? columnFor(L) : { lo: pinnedK, hi: pinnedK };
  const a = colAt(cs, cfg, lo), b = colAt(cs, cfg, hi);
  return Math.min(a ? a.rmax : 0, b ? b.rmax : 0);
}
// 8. telescopable load (gross, both directions) [E]; 9. permissible wind (3-s gust at the head) [E]
// (looked up by the chart label: a pinned 45.034 m boom is the "≤ 45.0 m" row)
export const telescopableLoad = (L) => tableLookup(TELE_LOAD, nominalLength(L));
export const windPerm = (L) => tableLookup(WIND_PERM, nominalLength(L));
// T_tel of the stroke that contains L (between pins; see teleSegment)
export const segmentTeleLoad = (L) => tableLookup(TELE_LOAD, LENGTHS[teleSegment(L)]);
// Telescopable load per direction {out, in} (kg gross) at boom length L.
//   pinned at column k: out = the stroke k → k+1 (T_tel(L_{k+1})), in = the stroke k−1 → k (T_tel(L_k)).
//   between pins: both = the stroke the boom is in. A real RCL checks the load for the stroke
//   it is about to start BEFORE the pins are pulled, so a boom never unpins with an over-limit load.
export function teleLoads(L, pinnedK = null) {
  if (pinnedK === null || pinnedK === undefined) { const t = segmentTeleLoad(L); return { out: t, in: t }; }
  const k = Math.max(0, Math.min(LENGTHS.length - 1, pinnedK));
  return {
    out: tableLookup(TELE_LOAD, LENGTHS[Math.min(k + 1, LENGTHS.length - 1)]),
    in: tableLookup(TELE_LOAD, LENGTHS[k]),
  };
}
// large-area loads [S16]: v_max = min(v_perm, v_perm·sqrt(1.2·m_t / A_face))
export function windPermLoad(L, massKg, faceArea) {
  const v = windPerm(L);
  if (!(massKg > 0) || !(faceArea > 0)) return v;
  return Math.min(v, v * Math.sqrt((1.2 * massKg / 1000) / faceArea));
}
// recommended slew speed under load [S15] (rpm), by chart label (a pinned 30.13 m boom → 0.5 rpm)
export const slewRecRpm = (L) => tableLookup(SLEW_REC_RPM, nominalLength(L));

// Raw chart value (kg) at boom L / radius R. pinnedK = the pinned chart column
// (0..11) or null when the boom is between pins: then the conservative
// min(col(k_lo), col(k_hi), T_tel) applies (§2.3.3, RCL "TELE / NOT PINNED"),
// with T_tel of the stroke the boom is in (constant over the stroke).
export function chartCapacity(cfg, L, R, pinnedK = null) {
  const cs = cols(cfg);
  if (!cs) return 0;
  if (pinnedK !== null && pinnedK !== undefined) return colInterp(colAt(cs, cfg, pinnedK), R);
  const { lo, hi } = columnFor(L);
  return Math.min(colInterp(colAt(cs, cfg, lo), R), colInterp(colAt(cs, cfg, hi), R), segmentTeleLoad(L));
}

// RCL capacity (kg gross): chart value capped by the reeved block rating (§2.3.5).
export function capacity(cfg, L, R, pinnedK = null) {
  const c = chartCapacity(cfg, L, R, pinnedK);
  const b = HOOK_BLOCKS[cfg?.block];
  return b ? Math.min(c, b.ratedKg) : 0;
}

// Full lookup for the RCL / HUD: what limits the capacity and why.
// governedBy: 'block' | 'tele' | 'range' (beyond Rmax / no chart) | 'chart';
// stability = the chart value is stability-governed here (HUD "S" marker).
export function lookup(cfg, L, R, pinnedK = null) {
  const pinned = pinnedK !== null && pinnedK !== undefined;
  const { lo, hi } = pinned ? { lo: pinnedK, hi: pinnedK } : columnFor(L);
  const cs = cols(cfg), perm = permitted(cfg);
  const a = colAt(cs, cfg, lo), b = colAt(cs, cfg, hi);
  const ca = colInterp(a, R), cb = colInterp(b, R);
  // unpinned: T_tel of the current stroke caps the capacity; pinned: informational (label row)
  const teleKg = pinned ? telescopableLoad(L) : segmentTeleLoad(L);
  let chartKg = Math.min(ca, cb), governedBy = 'chart';
  if (!pinned && teleKg < chartKg) { chartKg = teleKg; governedBy = 'tele'; }
  const blockKg = HOOK_BLOCKS[cfg?.block]?.ratedKg ?? 0;
  let cap = Math.min(chartKg, blockKg);
  if (chartKg <= 0) governedBy = 'range';
  else if (blockKg < chartKg) governedBy = 'block';
  const stability = governedBy === 'chart' && ((ca <= cb && colGoverned(a, R)) || (cb < ca && colGoverned(b, R)));
  if (!perm.ok) cap = 0;
  return {
    key: chartKey(cfg), ok: perm.ok, reason: perm.reason, pinned, kLo: lo, kHi: hi,
    capKg: cap, chartKg, blockKg, teleKg, governedBy, stability,
    rmin: rminFor(L), rmax: Math.min(a ? a.rmax : 0, b ? b.rmax : 0), structKg: Math.min(colInterp(STRUCT_COLS[lo], R), colInterp(STRUCT_COLS[hi], R)),
  };
}

// Column k of the configured chart for the HUD mini chart: [{R, kg, s}] (s = stability governed).
export function chartColumn(cfg, k) {
  const c = colAt(cols(cfg), cfg, k);
  return c ? c.R.map((R, i) => ({ R, kg: c.v[i], s: c.s[i] })) : [];
}
// Is the chart cell (column k, radius R) stability-governed (chart < STRUCT)?
export const stabilityGoverned = (cfg, k, R) => colGoverned(colAt(cols(cfg), cfg, k), R);
