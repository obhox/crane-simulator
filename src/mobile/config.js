// AT-100 5.1 all-terrain mobile crane: shared constants (build spec v1.0,
// docs/mobile-crane-spec.md). Phase-0 contract, READ-ONLY for every module:
// everything exported here is deep-frozen. Section numbers (§) point at the
// spec; source/evidence tags ([S1], [F], [D], [E]) are the spec's.
//
// Frames (§0): world three.js +y up, −z = "south" (public road at z = −66).
// Carrier frame C: origin on the slew axis at ground level in road stance,
// x_c forward, y_c left, z_c up; in three.js object space of the carrier
// group +X = forward, +Y = up, +Z = right = −y_c. Carrier yaw φ = group
// rotation.y (φ = 0 → forward = world +x, φ = −π/2 → forward = world +z).
// Superstructure S = C rotated by slew ψ about z_c (ψ = 0 boom over the
// front, +ψ toward the left = three.js rotation.y); coordinates (u, z).
// Tilt: carrier plane z = z0 + a·x_c + b·y_c, pitch = atan(a) (rotation.z),
// roll = atan(b) (rotation.x), Euler order 'YZX'.

const DEG = Math.PI / 180;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// ------------------------------------------------------------------ §1 spec
// Pinned (charted) boom lengths, k = 0..11 (§1.2). charts.js exports the same
// array as LENGTHS (§2.1); they must stay identical.
export const PINNED_LENGTHS = [11.5, 15.2, 19.0, 22.7, 26.4, 30.1, 33.9, 37.6, 41.3, 45.0, 48.8, 52.0];

// Axle positions x_c (m), front to rear (§1.1 [E]; big front gap houses the front outrigger box).
export const AXLES = [5.60, 2.90, 1.27, -0.28, -1.85];

// Outrigger float lines x_c (§1.6, longitudinal base 7.37 m [S1] drawing [D]).
export const FLOAT_X = { front: 4.58, rear: -2.79 };

// Beam position (% extension) → float centre |y_c| (m) (§1.6 [S4][S5]).
export const BASES = { 100: 3.5, 50: 2.5, 0: 1.25 };

// Float order used everywhere (arrays of 4): front-left, front-right, rear-left, rear-right.
export const FLOATS = [
  { id: 'FL', x: 4.58, side: +1 },
  { id: 'FR', x: 4.58, side: -1 },
  { id: 'RL', x: -2.79, side: +1 },
  { id: 'RR', x: -2.79, side: -1 },
];

export const AT100 = {
  name: 'AT-100 5.1',
  // §1.1 carrier
  nominalKg: 100000, // 100 t nominal
  rated360At3mKg: 82600, // 82.6 t at 3 m, 360° [S1]
  ratedOverRearAt2p7mKg: 100000, // 100 t at 2.7 m over rear only (needs hb100, Phase 3)
  axles: 5,
  carrier: {
    length: 11.45, frontX: 7.75, rearX: -3.70, // bumper / rear end in C [S4][E split]
    overallLengthRoad: 13.8, boomNoseX: 10.10, // road trim, boom head nose [D]
    width: 2.75, height: 3.95, // [S1]
    axleX: AXLES,
    tyre: { spec: '385/95 R25', count: 10, dia: 1.37, width: 0.385, trackY: 1.18 }, // tyre-centre track ±1.18 [S1][D]
    drive: '10x6', drivenAxles: [1, 3, 4], // axles 2, 4, 5 driven (0-based indices); all axles steered [S1][S2]
    engine: { kW: 400, torqueNm: 2516, cylinders: 6, idleRpm: 600, ratedRpm: 1800 }, // [S1]; rpm [E]
    gearbox: { forward: 12, reverse: 2, automated: true }, // [S1]
    maxKmh: 80, // [S1]
    turningRadius: { all: 10.18, road: 11.47 }, // outer front corner [S2][S4]
    roadMassKg: 47000, basicMassKg: 46700, hookBallKg: 250, // 0 t CW on the road [F][S6]
    roadCgX: 1.35, axleLoadsT: [8.4, 9.1, 9.5, 9.9, 10.2], // [D]
    rideHeight: 1.30, // frame datum above ground on tyres [E]
  },
  // §1.2 superstructure and boom
  craneEngine: { kW: 129, cylinders: 4, idleRpm: 750, maxRpm: 1900 }, // [S1]; rpm [E]
  slewRingZ: 2.25, // [E]
  pivot: { u: -2.00, z: 3.71 }, // boom foot pivot in S [S3]
  boom: {
    baseLen: 11.5, maxLen: 52.0, nTele: 5, // base + 5 telescopic sections [S1]
    stroke: 8.1, pins: [0, 0.46, 0.92, 1.0], // single cylinder, pinned at 0/46/92/100 % of the stroke [S20]
    lengths: PINNED_LENGTHS, stepLen: 3.726, // k = 0..10 steps, k = 11 → 52.0
    sequence: 'outer-first round-robin: 46 % T5..T1, 92 % T5..T1, 100 % T5..T1; retract in reverse', // [F]
    boxBase: [0.90, 1.06], boxStepPerSide: 0.07, // [S3]; [E]
    massKg: 10100, sectionMassKg: 1625, sectionLen: 11.3, headMassKg: 350, // 6 × 1.625 t + 0.35 t head [F]
    sectionCgOffset: 5.65, // section i CG at pivot + (p_i + 5.65) along the axis (§1.3)
  },
  luff: {
    minDeg: -1.0, maxDeg: 82, time0to82: 40, // [S1]; −1° [E]
    cylA: { u: 1.60, z: 2.00 }, // cylinder anchor A in S
    cylB: { along: 5.6, below: 0.6 }, // attachment B: 5.6 m along the boom, 0.6 m below its axis
    cylSpeed: 0.132, // m/s → 2.4°/s at 0°, 1.9°/s at 20–45°, 2.6°/s at 82° [D]
  },
  tele: { cylSpeed: 0.13, pinPause: 4.0, fullTime: 355 }, // 11.5 → 52 m ≈ 355 s [S1][S14]
  slew: { maxRpm: 2.0, lockable: true }, // [S1]
  hoist: {
    lineSpeedMpm: 130, // single line, top layer [S1]
    linePullN: 88e3, // [S1]
    ropeDia: 0.021, ropeLen: 250, ropeEA: 2.0e7, // [S1][S6]; EA [E]
    hookLimit: 2.0, // hook-block top ≥ 2.0 m below the head sheave [S1]
  },
  tailSwing: 3.84, // [S2]
  cwCg: { u: -3.18, z: 2.45 }, // [F]
  craneCab: { u: 1.00, y: 1.45, z: 3.55, tiltMaxDeg: 20 }, // eye in S, left of the boom [E]
  driverCab: { x: 6.95, y: 0.70, z: 2.85 }, // eye in C, front left [E]
  // §1.3 masses and CGs (stability model, all [F]; heights above ground in road stance)
  bodies: {
    carrier: { m: 19100, x: 1.84, y: 0, z: 1.55 }, // incl. outrigger boxes, beams, jacks (C)
    upper: { m: 15900, u: -0.63, z: 2.60, rg: 2.0 }, // turntable, cab, winch, engine, hydraulics, CW frame (S); r_g [E]
    luffCyl: { m: 1600, u: -0.60, z: 3.00 }, // (S)
    boomSection: { m: 1625, offset: 5.65 }, // each of 6, along the boom axis
    head: { m: 350 }, // at the head
    cw: { u: -3.18, z: 2.45 }, // superstructure counterweight (S), mass = cwKg
    deckSlabs: { x: -3.18, y: 0, z: 1.85 }, // slabs lying on the deck (C), z + stack height / 2
  },
  // §1.6 outriggers
  outriggers: {
    floatX: FLOAT_X,
    beamY: BASES, // 100 % → ±3.50, 50 % → ±2.50, 0 % → ±1.25 [S4][S5]
    beamSpeed: 0.20, detentCapture: 0.02, // m/s, ±m [E]
    jackStroke: { front: 0.65, rear: 0.70 }, // [S2]
    jackJ0: 0.90, // frame datum → pad bottom, jack retracted (pad 0.40 m above ground on tyres) [E]
    padClearanceOnTyres: 0.40,
    jackSpeed: { extendFree: 0.06, extendLoaded: 0.04, retract: 0.06 }, // [E]
    pad: { size: 0.55, area: 0.242 }, // 0.55 × 0.55 m, 80 % effective
    maxFloatKg: 75000, // design [S3]
  },
};

// §1.4 hook blocks and reeving (gross ratings, masses [S1]; heights / collider halves [E]).
// height = hook bowl → block top (rope entry); half = HoistSystem hook collider half-size.
export const HOOK_BLOCKS = {
  ball: { id: 'ball', name: 'Hook ball', sheaves: 0, falls: 1, ratedKg: 8800, massKg: 250, height: 1.00, half: [0.22, 0.50, 0.22] },
  hb26: { id: 'hb26', name: 'Hook block 26 t', sheaves: 1, falls: 3, ratedKg: 26100, massKg: 450, height: 1.60, half: [0.30, 0.80, 0.30] },
  hb60: { id: 'hb60', name: 'Hook block 60 t', sheaves: 3, falls: 7, ratedKg: 59100, massKg: 500, height: 1.90, half: [0.35, 0.95, 0.35] },
  hb90: { id: 'hb90', name: 'Hook block 90 t', sheaves: 5, falls: 10, ratedKg: 90200, massKg: 700, height: 2.20, half: [0.40, 1.10, 0.40] },
};
export const HOOK_BLOCK_IDS = ['ball', 'hb26', 'hb60', 'hb90'];
// Phase 3 option only (over-rear 100 t, §2.1): not offered in v1 dialogs.
export const HOOK_BLOCK_HB100 = { id: 'hb100', name: 'Hook block 100 t', sheaves: 7, falls: 14, ratedKg: 100000, massKg: 1240, height: 2.4, half: [0.45, 1.2, 0.45] };

// Re-reeving by the riggers (§1.4 [E]): 45 s to or from 3 falls, 90 s when 7
// or 10 falls are involved. Spec is ambiguous for e.g. 10 → 1; we use the
// bigger block (more sheaves to reeve or unreeve) to pick the time.
export const REEVE_TIME = { short: 45, long: 90 };
export function reeveTime(fromId, toId) {
  const f = Math.max(HOOK_BLOCKS[fromId]?.falls ?? 1, HOOK_BLOCKS[toId]?.falls ?? 1);
  return f >= 7 ? REEVE_TIME.long : REEVE_TIME.short;
}

// §1.5 counterweight: superstructure configs and slab make-up.
export const CW_CONFIGS = [0, 11500, 23500, 35000];
export const CW_SLABS = {
  A: { id: 'A', massKg: 11500, h: 0.47, loadType: 'cwA' },
  B: { id: 'B', massKg: 12000, h: 0.49, loadType: 'cwB' },
  C: { id: 'C', massKg: 11500, h: 0.47, loadType: 'cwC' },
};
export const CW_MAKEUP = { 0: [], 11500: ['A'], 23500: ['A', 'B'], 35000: ['A', 'B', 'C'] };
export const CW_SLAB_SIZE = { width: 2.60, depth: 1.25 }; // across the carrier × along; height per slab above
export const CW_DECK = { x: -3.18, y: 0, topZ: 1.85, tolPos: 0.15, tolYawDeg: 3 }; // deck landing zone (C) §6.6

// Mats (§1.6, §4.8).
export const MATS = {
  none: { id: 'none', size: [0.55, 0, 0.55], area: 0.242, thickness: 0 }, // bare pad
  carried: { id: 'carried', size: [1.75, 0.12, 1.00], area: 1.75, thickness: 0.12, count: 4 }, // [S3]
  composite: { id: 'composite', size: [1.80, 0.10, 1.80], area: 3.24, thickness: 0.10 }, // site stock (jobs) [E]
};
export const MAT_PLACE_TIME = 4.0; // s, auto-centres under the float (§4.8)

// ---------------------------------------------------------- §2.3 chart rules
export const RMIN = [3, 3.5, 3.5, 4, 4.5, 5, 6, 6, 7, 8, 9, 10]; // m, per PINNED_LENGTHS index (§2.3.7)
// Telescopable load (gross, both directions) [E] (§2.3.8): [maxLen, kg]
export const TELE_LOAD = [[22.7, 12000], [33.9, 8000], [45.0, 5000], [Infinity, 3000]];
// Permissible 3-s gust at the boom head [E] (§2.3.9): [maxLen, m/s]
export const WIND_PERM = [[22.7, 14.3], [37.6, 12.8], [48.8, 11.1], [Infinity, 9.0]];
// Recommended slew speed under load [S15] (§3.2): [maxLen, rpm]
export const SLEW_REC_RPM = [[11.5, 0.8], [15.2, 0.65], [30.1, 0.5], [Infinity, 0.3]];
export const tableLookup = (table, L) => { for (const [max, v] of table) if (L <= max + 1e-6) return v; return table[table.length - 1][1]; };

// ------------------------------------------------------- §3 drives (120 Hz)
export const DRIVES = {
  slew: {
    maxSpeed: 2.0 * 2 * Math.PI / 60, // 0.2094 rad/s
    viscous: 1.5e5, // N·m·s [E]
    torqueMax: 250e3, // N·m drive clamp [E]
    response: 1.2, // s: need = I·(target − ψ̇)/1.2 − ext
    releaseDecel: 0.8, // × torqueMax after lever release
    stopRate: 0.0006, // rad/s → holding brake engages (clunk)
    holdBrake: 350e3, // N·m [E]
    micro: 0.10,
    pinMaxDeg: 0.5, // turntable lock pin engages only when |ψ| < 0.5° and ψ̇ = 0
  },
  luff: {
    cylSpeed: 0.132, cylAccel: 0.35, // m/s, m/s² [D][E]
    upLoad: { a: 1.10, b: 0.60, min: 0.40, max: 1.0 }, // up × clamp(1.10 − 0.60·util, 0.40, 1)
    downLoad: { a: 1.00, b: 0.30, min: 0.60, max: 1.0 }, // down × clamp(1.00 − 0.30·util, 0.60, 1)
    endDampDeg: 3, endDampMin: 0.15, micro: 0.10,
  },
  tele: { speed: 0.13, pinPause: 4.0 },
  hoist: {
    lineSpeed: 130 / 60, // m/s single line on the top layer
    pdRef: 0.689, // pitch diameter of the top (5th) layer
    kneeN: 44e3, // constant-power knee: × min(1, 44 kN / F_line) [E]
    reliefN: 88e3 * 1.1, // winch relief: hoist-up stalls above this line pull
    hookAccel: 0.6, hookDecel: 0.8, // m/s² [E]
    slowZone: 3.0, // m before the hook limit (as the tower)
    deadExtra: 1.5, // dead(L) = L + 1.5 m (winch near the pivot)
    minDrumRope: 4.9, // lowering limit: 3 wraps stay on the drum [S9]
  },
  drum: { barrel: 0.50, wrapsPerLayer: 30, layers: [49.1, 53.1, 57.0, 61.0, 64.9] }, // m per layer [E]
  anemometerTau: 1.2, // s, head anemometer filter (§3.1)
};

// §3.6 boom deflection [E, calibrated]
export const DEFLECTION = {
  EIv: 1.7e9, EIl: 1.0e9, // N·m²
  modalMass: 0.24, // ωv = sqrt(3·EIv / (L³ · 0.24 · m_boom))
  zetaV: 0.03, zetaL: 0.02,
  slewCoupling: 0.8, // − 0.8·ψ̈·L in the lateral oscillator
  clampV: [-0.2, 2.5], clampL: 1.5,
  sidePullDeg: 3, // out-of-plane rope angle with the load grounded → SIDE PULL
};

// §3.7 boom contact
export const BOOM_CONTACT = { sample: 1.0, rPivot: 0.55, rHead: 0.35, lockout: 0.5 };

// -------------------------------------------------------- §4 stability model
export const STABILITY = {
  floatK: 1, tyreK: 0.3, // relative support stiffness (§4.2)
  planeEps: 0.003, // m, solveSupport tolerance (§4.3)
  hullTol: 0.05, // supports within 5 cm of the plane form the hull for the margin
  groundK: 20e6, // N/m optional ground compliance on mats
  floatLightN: 20e3, // FLOAT_LIGHT below 20 kN while others carry load (§4.4)
  liftoffEps: 0.002, // plane − h > 2 mm on a set float → LIFTOFF
  tipDamping: 0.02, // c = 0.02·I_e s⁻¹ (§4.5)
  overturnDeg: 60, headMin: 1.0, farFloatMax: 3.0, // terminal conditions
  beamLockN: 5e3, // beam cannot move while its float carries > 5 kN (§6.4)
};
export const LEVEL = { okDeg: 0.3, warnDeg: 0.57, resolutionDeg: 0.1, axleClear: 0.10, floatClear: 0.02 }; // §4.7

// §4.8 ground bearing (allowable kPa [S18]; ultimate = 2.5 × allowable [E])
export const GROUND = {
  ultFactor: 2.5,
  p1: { minX: 50.5, maxX: 63.5, minZ: -19.5, maxZ: -2.5, kind: 'hardcore', allowKPa: 400 },
  site: { kind: 'fill', allowKPa: 200 }, // inside the fence
  road: { kind: 'asphalt', allowKPa: 200 }, // carriageways
  soft: { kind: 'lot', allowKPa: 100 }, // lots / sidewalks / grass
  settleRate: 0.004, // ṡ = 0.004·(p/allow − 1) m/s between allowable and ultimate
  punchRate: 0.25, punchMax: 0.40, // m/s until s ≥ 0.40 m or p < allow
};

// ------------------------------------------------------------ §5 RCL / LMI
export const RCL_T = {
  warn: 0.90, stop: 1.00, release: 0.98, // STOP releases below 0.98 with all levers neutral [S9]
  reconfigRatio: 0.20, reconfigKg: 500, // config change only when ratio < 0.20 and gross ≤ 500 kg [S14]
  blueRatio: 0.20, blueKg: 500, // 'blue' state (reconfigurable)
  beepOn: 0.18, beepOff: 0.35, // warn beeper
  hornMuteAfter: 5, // s
  bypassScale: 0.15, bypassMaxS: 30 * 60, // EN 13000 emergency bypass [S12]
  tiltWarnDeg: 0.57, sidePullDeg: 3,
};
export const RCL_COLOURS = { blue: '#3d8bff', ok: '#35c47a', warn: '#f0b40c', stop: '#ff3030' };

// §5.1 working-range limiter: tower-crane zone [D from src/config.js; 3 m clearance E]
export const TOWER_ZONE = {
  cx: 0, cz: 0, // mast axis
  r: 63.0, // head within 63 m horizontally of the mast …
  ceiling: 44.2, // … keeps its top (head sheave + 0.6 m) ≤ 44.2 m
  headTopAboveSheave: 0.6,
  band: 2.0, // luffUp / teleOut scaled by clamp((44.2 − headTop)/2.0, 0, 1)
  slewLookaheadDeg: 2,
};

// ----------------------------------------------------------- §6 controls
export const MODES = ['ROAD', 'SETUP', 'CRANE', 'TIPPING', 'OVERTURNED'];
export const MODE_PROFILE = { ROAD: 'mobile-drive', SETUP: 'mobile-setup', CRANE: 'mobile-crane', TIPPING: 'mobile-crane', OVERTURNED: 'mobile-crane' };
// Camera cycle (C) per mode, first = default (§8.7)
export const CAMERA_MODES = {
  ROAD: ['driver', 'chase', 'orbit'],
  SETUP: ['setup', 'driver', 'chase', 'orbit'],
  CRANE: ['cab', 'hook', 'ground', 'setup', 'orbit'],
  TIPPING: ['cab', 'orbit'],
  OVERTURNED: ['orbit'],
};
// §6.5 travel interlock: ROAD driving needs all of these
export const TRAVEL_INTERLOCK = { beams: 0, jacksRetracted: true, pinnedAtDeg: 0, maxLuffDeg: 1, boomLen: 11.5, stowed: true, cwKg: 0, deckSlabs: 0 };
export const TYRES_LIFT = { cwKg: 0, maxBoomLen: 19.0 }; // tyres-mode lifting (§6.5, §2.3)

// ------------------------------------------------------------ §7 driving
export const VEHICLE = {
  programs: {
    ROAD: { xRef: 1.27, kappaMax: 1 / 8.09, fadeTo: { xRef: -0.29, kappaMax: 1 / 10.6, atKmh: 50 }, fadeFromKmh: 25 },
    ALL: { xRef: 2.085, kappaMax: 1 / 7.08, maxKmh: 20 },
    CRAB: { maxDeg: 15, maxKmh: 10 },
  },
  lateralLimit: 2.5, // |κ| ≤ 2.5 / v² (high CG) [E]
  steerLockToLock: 3.0, // s
  wheelPowerW: 340e3, tractionShare: 0.6, mu: 0.7, // F_drive = throttle·min(340e3/max(|v|,1), 0.7·0.6·m·g)
  shiftPause: 0.4, // s without drive force per gear change
  crr: { asphalt: 0.009, site: 0.025 }, cdA: 8.0, rho: 1.225,
  brakeDecel: 4.5, retarderDecel: 0.3, maxAccel: 1.2, // m/s²
  reverseMaxKmh: 8, reverseGears: [6.5, 8.0],
  gearTopKmh: [6.7, 8.5, 10.7, 13.5, 17.0, 21.4, 27.0, 34.0, 42.8, 54.0, 68.0, 80.0], // at 1,800 rpm [E]
  upshiftRpm: 1700, downshiftRpm: 1050, idleRpm: 600, ratedRpm: 1800,
  kerb: { dh: 0.10, window: 0.2, minSpeed: 1.5, hardSpeed: 4.0 }, // m, s, m/s
  body: { cx: 2.025, hx: 5.725, hz: 1.375, y0: 0.3, y1: 3.95 }, // body OBB in C
  nose: { x0: 7.75, x1: 10.10, hz: 0.5, y0: 2.4, y1: 3.9 }, // boom-nose box in C
  obstacleMinTop: 0.35, // world boxes lower than this are ignored
  collideSpeed: 0.5, trafficCriticalSpeed: 1.0, // m/s
  // the fence collider is continuous across the gate; the vehicle ignores it
  // and uses these two south-fence segments instead (§7)
  fenceGate: { ignore: { tag: 'fence', cz: -58, tol: 0.2, minHx: 30 }, segments: [[-62, -34], [-26, 66]], z: -58 },
  stowedHook: { x: 7.95, y: 0, z: 1.2 }, // bumper anchor in C (x_c, y_c, z_c)
};
export const SPEED_LIMITS = { siteKmh: 10, siteKpiKmh: 11, roadKmh: 50, gateKmh: 5 };
// No-parking zone on both kerbs along the approach (§7.1)
export const CRANE_APPROACH = { minX: -100, maxX: -20, minZ: -72, maxZ: -56 };

// ------------------------------------------------------------ §8 gameplay
// §8.1 spawn: slew axis in the lane next to the site (road centre z −66, LANE 1.75)
export const SPAWN = { x: -82.0, z: -64.25, yaw: 0, mode: 'ROAD', engine: true };

// §8.1 route for the reference point (ref = slew axis + x_ref·fwd), corridor
// 3.5 m wide, rendered as ground chevrons. yaw: 0 = heading +x, −π/2 = +z.
export const ROUTE = {
  width: 3.5,
  legs: [
    { kind: 'lane', text: 'Move into the far lane and kerb strip', to: { x: -37.08, z: -69.35 }, byX: -40, yaw: 0 },
    { kind: 'turn', text: 'ALL-wheel steer: turn into the site gate', program: 'ALL', icr: { x: -37.08, z: -62.27 }, from: { x: -37.08, z: -69.35 }, to: { x: -30.0, z: -62.3 }, yaw0: 0, yaw1: -Math.PI / 2 },
    { kind: 'straight', text: 'Straight through the gate and the wheel wash', from: { x: -30.0, z: -62.3 }, to: { x: -30.0, z: -43.1 }, yaw: -Math.PI / 2, walls: [-31.7, -28.3] },
    { kind: 'turn', text: 'ALL-wheel steer: turn along the haul road', program: 'ALL', icr: { x: -22.9, z: -43.1 }, from: { x: -30.0, z: -43.1 }, to: { x: -22.9, z: -36.0 }, yaw0: -Math.PI / 2, yaw1: 0 },
    { kind: 'straight', text: 'Along the haul road (z −36)', from: { x: -22.9, z: -36.0 }, to: { x: 48.9, z: -36.0 }, yaw: 0 },
    { kind: 'turn', text: 'ROAD steer: turn toward pad P1', program: 'ROAD', icr: { x: 48.9, z: -27.9 }, from: { x: 48.9, z: -36.0 }, to: { x: 57.0, z: -27.9 }, yaw0: 0, yaw1: -Math.PI / 2 },
    { kind: 'straight', text: 'Straight along x = 57 onto P1', from: { x: 57.0, z: -27.9 }, to: { x: 57.0, z: -12.0 }, yaw: -Math.PI / 2, targetIsSlewAxis: true },
  ],
};

// §8.2 setup pad P1 (slew-axis target; left side = +x toward the east fence)
export const P1 = {
  x: 57, z: -12, yaw: -Math.PI / 2, tolPos: 0.5, tolYawDeg: 5,
  floats: [[60.5, -7.42], [53.5, -7.42], [60.5, -14.79], [53.5, -14.79]], // FL, FR, RL, RR at full base (world x, z)
  matMaxX: 61.4, groundKPa: 400, towerDist: 58.2,
};

// Ballast / reeving / misc timings (§6.6, §1.4)
export const BALLAST = { raiseTime: 45, quickPenalty: 120 };

// §8.6 settings (defaults; main.js owns persistence)
export const MOBILE_SETTINGS = { machine: 'tower', mobileStart: 'pad', siteSpeedLimit: 10, quickBallast: false, allowBypass: false, timeWarp: true };
export const TIME_WARP = 4; // hold Z: ×4 time (§3.4 rules)

// §3.2 / §8.5 slewing faster than recommended for the boom with a real load on: live RCL warning
// 'slewSpeed' (the same test as the jobs' KPI), a toast after toastAfter s, at most every toastEvery s
export const SLEW_OVERSPEED = { loadRatio: 0.25, marginRpm: 0.02, toastAfter: 0.3, toastEvery: 12 };

// §8.6 / §8.10 MobileStart presets (see src/machines/machine.js for the shape;
// use makeMobileStart() there to get a mutable copy)
export const MOBILE_STARTS = {
  // 'pad': at P1, set up: 35 t, full base, carried mats, level, hook ball, 22.7 m boom
  pad: {
    mode: 'CRANE', pos: { x: P1.x, z: P1.z }, yaw: P1.yaw,
    beams: [1, 1, 1, 1], jacksSet: true, mats: ['carried', 'carried', 'carried', 'carried'], levelled: true,
    cwKg: 35000, deckSlabs: [], rcl: { mode: 'outriggers', base: 100, cwKg: 35000, block: 'ball', confirmed: false },
    block: 'ball', boomK: 3, luffDeg: 55, slewDeg: 0, ropeLen: 12, attach: null, siteTravel: false,
  },
  // 'road': at the spawn in the public road, road trim (0 t CW, ball stowed, boom on its rest)
  road: {
    mode: 'ROAD', pos: { x: SPAWN.x, z: SPAWN.z }, yaw: SPAWN.yaw,
    beams: [0, 0, 0, 0], jacksSet: false, mats: ['none', 'none', 'none', 'none'], levelled: false,
    cwKg: 0, deckSlabs: [], rcl: { mode: 'outriggers', base: 100, cwKg: 0, block: 'ball', confirmed: false },
    block: 'ball', boomK: 0, luffDeg: 0, slewDeg: 0, ropeLen: null, attach: null, siteTravel: false,
  },
};

// §8.9 audio mix per camera (mobile)
export const AUDIO_MIX = {
  cab: { craneEngine: 0.8, hydraulics: 1, carrierEngine: 0.2 },
  driver: { craneEngine: 0.2, hydraulics: 0.4, carrierEngine: 1 },
  chase: { craneEngine: 0.6, hydraulics: 0.6, carrierEngine: 0.6 },
  orbit: { craneEngine: 0.6, hydraulics: 0.6, carrierEngine: 0.6 },
  setup: { craneEngine: 0.6, hydraulics: 0.8, carrierEngine: 0.6 },
  hook: { craneEngine: 0.4, hydraulics: 0.5, carrierEngine: 0.3 },
  ground: { craneEngine: 0.4, hydraulics: 0.4, carrierEngine: 0.4 },
};

// §8.7 camera mounts
export const CAMERAS = {
  cab: { u: 1.00, y: 1.45, z: 3.55 }, driver: { x: 6.95, y: 0.70, z: 2.85 },
  chase: { back: 16, up: 7, ahead: 4 }, setup: { eye: 1.7, dist: 6 },
};

// ---------------------------------------------------------- frame helpers
// Carrier frame (x_c, y_c) → world (x, z) for a carrier at pos {x,z} with yaw φ
// (yaw-only; tilt handled by the stability pose). out = {x, z}.
export function carrierToWorld(pos, yaw, xc, yc, out = { x: 0, z: 0 }) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = pos.x + xc * c - yc * s;
  out.z = pos.z - xc * s - yc * c;
  return out;
}
// World (x, z) → carrier (x_c, y_c). out = {x, y}.
export function worldToCarrier(pos, yaw, x, z, out = { x: 0, y: 0 }) {
  const c = Math.cos(yaw), s = Math.sin(yaw), dx = x - pos.x, dz = z - pos.z;
  out.x = dx * c - dz * s;
  out.y = -dx * s - dz * c;
  return out;
}
// Displayed slew angle (§0): (−ψ in degrees) mod 360; 0 front, 90 right, 180 rear, 270 left.
export const slewDisplayDeg = (psi) => ((((-psi / DEG) % 360) + 360) % 360);
// Boom length for a pinned step k = 0..11.
export const pinnedLength = (k) => PINNED_LENGTHS[Math.max(0, Math.min(11, Math.round(k)))];

deepFreeze(PINNED_LENGTHS); deepFreeze(AXLES); deepFreeze(FLOAT_X); deepFreeze(BASES); deepFreeze(FLOATS);
deepFreeze(AT100); deepFreeze(HOOK_BLOCKS); deepFreeze(HOOK_BLOCK_IDS); deepFreeze(HOOK_BLOCK_HB100); deepFreeze(REEVE_TIME);
deepFreeze(CW_CONFIGS); deepFreeze(CW_SLABS); deepFreeze(CW_MAKEUP); deepFreeze(CW_SLAB_SIZE); deepFreeze(CW_DECK);
deepFreeze(MATS); deepFreeze(RMIN); deepFreeze(TELE_LOAD); deepFreeze(WIND_PERM); deepFreeze(SLEW_REC_RPM);
deepFreeze(DRIVES); deepFreeze(DEFLECTION); deepFreeze(BOOM_CONTACT); deepFreeze(STABILITY); deepFreeze(LEVEL); deepFreeze(GROUND);
deepFreeze(RCL_T); deepFreeze(RCL_COLOURS); deepFreeze(TOWER_ZONE); deepFreeze(MODES); deepFreeze(MODE_PROFILE); deepFreeze(CAMERA_MODES);
deepFreeze(TRAVEL_INTERLOCK); deepFreeze(TYRES_LIFT); deepFreeze(VEHICLE); deepFreeze(SPEED_LIMITS); deepFreeze(CRANE_APPROACH);
deepFreeze(SPAWN); deepFreeze(ROUTE); deepFreeze(P1); deepFreeze(BALLAST); deepFreeze(MOBILE_SETTINGS); deepFreeze(MOBILE_STARTS);
deepFreeze(AUDIO_MIX); deepFreeze(CAMERAS); deepFreeze(SLEW_OVERSPEED);
