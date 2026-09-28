// Crane specification and tuning constants.
// Figures are based on published data for 60 m jib / 8 t class hammerhead
// tower cranes (e.g. QTZ6013/TC6015 datasheets, ISO 7752-3, ISO 10245-3,
// BS EN 13001-2). The model itself ("TC-6010") is fictional.

export const G = 9.81;
export const AIR_DENSITY = 1.225;

export const CRANE = {
  model: 'TC-6010',
  mastSections: 15,
  mastSectionHeight: 3.0,
  mastWidth: 1.6,
  get mastTop() { return this.mastSections * this.mastSectionHeight; }, // 45 m

  // slewing part (local to the turntable, y=0 at slewing ring)
  turntableHeight: 1.2,
  jibRootX: 1.0,
  jibBottomY: 2.2, // bottom chord level above slewing ring
  jibHeight: 1.6,
  jibHalfWidth: 0.8,
  jibLength: 60.0,
  counterJibLength: 15.0,
  catheadHeight: 11.0,
  sheaveDrop: 0.42, // rope leaves the trolley sheaves (centre height) this far below the bottom chord

  // trolley
  trolleyMin: 3.0,
  trolleyMax: 60.0,
  trolleySlowZone: 3.0,
  trolleyMaxSpeed: 1.0, // 60 m/min
  trolleyAccel: 0.32,
  trolleyDecel: 0.4,
  trolleyMass: 380,

  // hoist
  hookMass: 300,
  hookBlockHeight: 0.95, // rope attach (block top) to hook bowl
  hookUpperClearance: 1.5, // limit switch: hook block top this far below sheave
  hoistSlowZone: 3.0,
  hoistAccel: 0.55,
  hoistDecel: 0.7,
  ropeEA: 1.05e7, // ~14 mm steel wire rope, N

  // slewing (torque driven against inertia)
  slewMaxSpeed: 0.7 * 2 * Math.PI / 60, // 0.7 rpm in rad/s
  slewTorque: 150e3, // N·m drive torque at slewing ring (2 slewing gears)
  slewBrakeTorque: 230e3,
  craneSlewInertia: 1.05e7, // kg·m², jib + counter-jib + ballast
  counterweight: 14000,

  // structure dynamics
  jibVertPeriod: 1.25,
  jibVertDamping: 0.045,
  jibCompliance: 0.8 / 60 / (1.6 * 60 * 1000 * G), // rad per N·m (0.8 m tip dip at rated tip moment)
  jibLatPeriod: 2.05,
  jibLatDamping: 0.03,
  jibLatGain: 4.0,
};

// Reeving configurations. Hoist speed bands follow the 2-fall/4-fall
// datasheet pattern (80/40 m/min for 2 falls, 40/20 m/min for 4 falls).
export const REEVING = {
  2: { falls: 2, maxLoad: 4000, bands: [{ upTo: 2000, speed: 80 / 60 }, { upTo: 4000, speed: 40 / 60 }] },
  4: { falls: 4, maxLoad: 8000, bands: [{ upTo: 4000, speed: 40 / 60 }, { upTo: 8000, speed: 20 / 60 }] },
};

// Load chart (payload in kg, 4 falls). Interpolated linearly in between.
const CHART_4 = [
  [3.0, 8000], [13.5, 8000], [20, 5200], [25, 4000], [30, 3200], [35, 2650],
  [40, 2200], [45, 1900], [50, 1650], [55, 1450], [60, 1300],
];

export function ratedCapacity(radius, falls) {
  const chart = CHART_4;
  let cap = chart[chart.length - 1][1];
  if (radius <= chart[0][0]) cap = chart[0][1];
  else {
    for (let i = 0; i < chart.length - 1; i++) {
      const [r0, c0] = chart[i];
      const [r1, c1] = chart[i + 1];
      if (radius >= r0 && radius <= r1) {
        cap = c0 + (c1 - c0) * (radius - r0) / (r1 - r0);
        break;
      }
    }
  }
  // two-fall reeving: lighter hook, capped at 4 t, slightly better at long radius
  if (falls === 2) cap = Math.min(4000, cap + 60);
  return cap;
}

export const CHART_POINTS = CHART_4;

export const SLEW_MODES = [
  { id: 1, name: 'SOFT', torque: 0.6, releaseBrake: 0.12 },
  { id: 2, name: 'NORMAL', torque: 1.0, releaseBrake: 0.45 },
  { id: 3, name: 'DYNAMIC', torque: 1.3, releaseBrake: 0.9 },
];

export const SAFETY = {
  lmiWarn: 0.9,
  lmiLimit: 1.0,
  lmiCutoff: 1.05,
  windWarn: 14,
  windAlarm: 17,
  windStop: 20,
};

export const PHYS = {
  rate: 120, // fixed steps per second
  substeps: 6,
};

// Site coordinates (metres). Crane mast at the origin, +y up.
export const SITE = {
  fence: { minX: -62, maxX: 66, minZ: -58, maxZ: 66 },
  road: { minZ: -71, maxZ: -61 },
  // hook must stay out of the public road/footway (working range limitation)
  zoneLimitZ: -55,
  building: { minX: 12, maxX: 42, minZ: 6, maxZ: 26, floor: 3.2, levels: 5, slab: 0.25 },
};

// Render quality presets. Post-processing / environment modules may read
// extra fields they add here (keep existing ones).
export const QUALITY = {
  low: { name: 'low', pixelRatio: 1, shadowMap: 2048, city: 0.45, hookCam: false, ao: false, antialias: false, post: false },
  medium: { name: 'medium', pixelRatio: 1.25, shadowMap: 4096, city: 0.75, hookCam: true, ao: false, antialias: true, post: true },
  high: { name: 'high', pixelRatio: 1.5, shadowMap: 4096, city: 1, hookCam: true, ao: true, antialias: true, post: true },
  ultra: { name: 'ultra', pixelRatio: 2, shadowMap: 8192, city: 1.25, hookCam: true, ao: true, antialias: true, post: true },
};
