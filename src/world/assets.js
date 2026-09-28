import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Asset registry: CC0 textures / HDRIs / models from Poly Haven and ambientCG
// stored under public/assets (fetched + processed by scripts/fetch-assets.py,
// credits in public/assets/CREDITS.md). Everything degrades gracefully: a
// missing asset gives null / a plain material, and loading never throws.
//
// API (stable; synchronous after `await loadAssets()`):
//   await loadAssets(onProgress(fraction, label), { renderer?, quality? })
//   textureSet(name)          → { map, normalMap, armMap, aoMap, roughnessMap, metalnessMap,
//                                 alphaMap?, emissiveMap? } | null   (shared base textures, repeat 1 —
//                                 clone() before changing repeat/offset)
//   pbrMaterial(name, opts)   → new THREE.MeshStandardMaterial (textures are clones sharing one GPU image)
//        opts: { worldSize: m | [u,v]   metres the geometry's UV 0..1 spans → repeat = worldSize / tile_m
//                repeat: n | [u,v]      explicit repeat (wins over worldSize)
//                color                  multiplies the colour map (tint)
//                albedo: 0..1           rescale so mean albedo (linear luminance) hits this value
//                normalScale: n | [x,y]
//                ...any MeshStandardMaterial params. roughness/metalness MULTIPLY the ARM map
//                (values >1 are fine: final roughness is clamped to 1 in the shader) }
//        Sets with an alpha map (chainlink, metal_grating) come back transparent + DoubleSide;
//        sets with an emissive map (facades) come back with emissive = black: set
//        mat.emissive.setScalar(1) and ramp emissiveIntensity after dusk for lit windows.
//   tileSize(name)            → metres one texture repeat covers (or 1)
//   hdri(name, { removeSun }) → THREE.DataTexture (equirect, linear, half float) | null
//   hdriInfo(name)            → { sunDir, elevationDeg, azimuthDeg, hasSun, sunColor, sunIntensity,
//                                 skyColor, skyIntensity, horizonColor, zenithColor, meanLuminance } | null
//        Units are the HDRI's own. Matched lighting with envIntensity k:
//          scene.background = hdri(n); scene.backgroundIntensity = k;
//          scene.environment = hdriEnvMap(n, renderer, { removeSun: true }); scene.environmentIntensity = k;
//          sun.color = sunColor; sun.intensity = sunIntensity * k; sun.position = sunDir * dist;
//          fog.color = horizonColor * k   (hasSun=false → overcast/dawn: use a weak sun or none)
//   hdriEnvMap(name, renderer, { removeSun }) → PMREM texture for scene.environment (cached)
//   loadHdri(name)            → Promise<DataTexture|null> (lazy-load one skipped on 'low')
//   model(name, { part })     → THREE.Object3D clone (shared geometry/materials, shadows on) | null
//   modelInfo(name)           → { size: Vector3, min, max, parts: [names], triangles } | null
//   listAssets()              → { textures:[], hdris:[], models:[] } (names actually loaded)
//   MANIFEST                  → metadata below (source, res, tile_m, maps, albedo …)

// ------------------------------------------------------------------ manifest
// tile_m  : real-world metres one texture repeat covers (Poly Haven: published
//           scan size; ambientCG: published size or measured pattern period).
// albedo  : mean LINEAR RGB of the colour map (use with opts.albedo / tinting).
// maps    : color (sRGB) · normal (OpenGL +Y) · arm (R=AO G=rough B=metal) ·
//           alpha (opacity, read from .g) · emissive (night-lit windows, sRGB).
// Hero surfaces (2K colour/normal, 1K ARM) are the ones seen close from the cab.
export const MANIFEST = {
  textures: {
    // --- ground / hero (2K)
    gravel: { src: 'ph:gravel_floor_02', res: '2K', tile_m: 2.0, maps: ['color', 'normal', 'arm'], albedo: [0.4078, 0.3865, 0.3327], kb: 4006, note: 'crushed-stone hardstanding; roughness calibrated to ~0.85; bright scan - use albedo ~0.2-0.25' },
    dirt: { src: 'ph:brown_mud_dry', res: '2K', tile_m: 1.3, maps: ['color', 'normal', 'arm'], albedo: [0.1796, 0.1089, 0.0509], kb: 4109, note: 'dry excavated soil with pebbles; roughness calibrated to ~0.88' },
    mud: { src: 'ph:brown_mud_02', res: '2K', tile_m: 1.3, maps: ['color', 'normal', 'arm'], albedo: [0.0771, 0.0606, 0.0402], kb: 3122, note: 'wet mud: roughness remapped to ~0.5 so it catches the sky like real site mud' },
    asphalt: { src: 'ph:asphalt_04', res: '2K', tile_m: 4.04, maps: ['color', 'normal', 'arm'], albedo: [0.2371, 0.2216, 0.211], kb: 2719, note: 'bleached aged road; use albedo ~0.09-0.12 for city roads' },
    concrete_slab: { src: 'ph:concrete_floor_worn_001', res: '2K', tile_m: 3.0, maps: ['color', 'normal', 'arm'], albedo: [0.0928, 0.0947, 0.0886], kb: 1361, note: 'smooth floated slab, roughness ~0.7; dark scan - use albedo ~0.25' },
    concrete_rough: { src: 'ph:concrete_layers_02', res: '2K', tile_m: 2.0, maps: ['color', 'normal', 'arm'], albedo: [0.2071, 0.1959, 0.1763], kb: 1433, note: 'board-formed raw concrete (horizontal lifts)' },
    metal_painted: { src: 'acg:Paint004', res: '2K', tile_m: 1.0, maps: ['color', 'normal', 'arm'], albedo: [0.6035, 0.6035, 0.6035], kb: 1220, note: 'weathered paint, desaturated to neutral grey: set color to the paint colour' },
    // --- 1K
    grass: { src: 'ph:leafy_grass', res: '1K', tile_m: 2.0, maps: ['color', 'normal', 'arm'], albedo: [0.3137, 0.231, 0.1023], kb: 1137 },
    asphalt_worn: { src: 'ph:asphalt_02', res: '1K', tile_m: 3.0, maps: ['color', 'normal', 'arm'], albedo: [0.105, 0.1024, 0.0916], kb: 1191, note: 'cracked; long cracks repeat every 3 m - rotate/offset per road' },
    sidewalk_pavers: { src: 'ph:concrete_pavement', res: '1K', tile_m: 1.8, maps: ['color', 'normal', 'arm'], albedo: [0.2155, 0.1761, 0.1345], kb: 757, note: '300x600 mm concrete flags' },
    concrete_wall: { src: 'ph:concrete_wall_008', res: '1K', tile_m: 2.71, maps: ['color', 'normal', 'arm'], albedo: [0.2659, 0.2368, 0.1616], kb: 301 },
    brick_red: { src: 'ph:red_brick', res: '1K', tile_m: 1.4, maps: ['color', 'normal', 'arm'], albedo: [0.2758, 0.1372, 0.0844], kb: 632 },
    brick_old: { src: 'ph:brick_wall_006', res: '1K', tile_m: 3.0, maps: ['color', 'normal', 'arm'], albedo: [0.4255, 0.1846, 0.0942], kb: 850 },
    plaster: { src: 'ph:plastered_wall', res: '1K', tile_m: 2.0, maps: ['color', 'normal', 'arm'], albedo: [0.4353, 0.3925, 0.3377], kb: 558, note: 'near-white render, tint freely' },
    rusty_metal: { src: 'ph:rust_coarse_01', res: '1K', tile_m: 2.2, maps: ['color', 'normal', 'arm'], albedo: [0.1282, 0.0429, 0.0148], kb: 499 },
    galvanized_metal: { src: 'acg:Metal055A', res: '1K', tile_m: 1.0, maps: ['color', 'normal', 'arm'], albedo: [0.5157, 0.5161, 0.5162], kb: 193, note: 'metallic (B=1), roughness ~0.5; mottled weathered zinc' },
    corrugated_metal: { src: 'ph:corrugated_iron_02', res: '1K', tile_m: 2.7, maps: ['color', 'normal', 'arm'], albedo: [0.0995, 0.0978, 0.0828], kb: 471, note: 'corrugations run along V' },
    metal_grating: { src: 'acg:MetalWalkway006', res: '1K', tile_m: 0.5, maps: ['color', 'normal', 'arm', 'alpha'], albedo: [0.1191, 0.1202, 0.1363], kb: 783, note: '16x16 cells of ~31 mm (measured period)' },
    chainlink: { src: 'acg:Fence003', res: '1K', tile_m: 0.8, maps: ['color', 'normal', 'arm', 'alpha'], albedo: [0.3359, 0.3416, 0.3566], kb: 1004, note: '50 mm diamonds; ~8% coverage so it fades out with distance like the real thing' },
    plywood: { src: 'ph:plywood', res: '1K', tile_m: 0.5, maps: ['color', 'normal', 'arm'], albedo: [0.2106, 0.1201, 0.0525], kb: 582 },
    wood_planks: { src: 'ph:wood_planks', res: '1K', tile_m: 1.5, maps: ['color', 'normal', 'arm'], albedo: [0.1919, 0.0993, 0.0415], kb: 318, note: 'planks run along U' },
    roof_membrane: { src: 'ph:bitumen', res: '1K', tile_m: 20.0, maps: ['color', 'normal', 'arm'], albedo: [0.0435, 0.0375, 0.0351], kb: 217, note: 'bitumen felt with lap seams; 20 m tile = no visible repeat on roofs' },
    tiles_or_stone: { src: 'ph:large_square_pattern_01', res: '1K', tile_m: 3.0, maps: ['color', 'normal', 'arm'], albedo: [0.2043, 0.1905, 0.1573], kb: 667, note: '600 mm grey stone plaza slabs' },
    // --- extras
    metal_painted_worn: { src: 'acg:PaintedMetal012', res: '1K', tile_m: 1.5, maps: ['color', 'normal', 'arm'], albedo: [0.684, 0.6746, 0.6678], kb: 604, note: 'white paint with chips/rust' },
    container_side: { src: 'ph:container_side', res: '1K', tile_m: 1.94, maps: ['color', 'normal', 'arm'], albedo: [0.1092, 0.2478, 0.0819], kb: 186, note: 'green ISO container corrugated side' },
    osb: { src: 'ph:oriented_strand_board', res: '1K', tile_m: 2.51, maps: ['color', 'normal', 'arm'], albedo: [0.5026, 0.3142, 0.1686], kb: 816, note: 'OSB hoarding boards' },
    // --- building facades (floors x bays per tile; emissive = lit windows at night)
    facade_office_glass: { src: 'acg:Facade001', res: '1K', tile_m: 36, maps: ['color', 'normal', 'arm', 'emissive'], albedo: [0.0655, 0.0789, 0.0926], floors: 10, bays: 16, kb: 300, note: 'unitized glass curtain wall, 10 floors x 16 bays (3.6 m x 2.25 m); metallic glass; night map ~35% panels lit' },
    facade_office_ribbon: { src: 'acg:Facade006', res: '1K', tile_m: 28, maps: ['color', 'normal', 'arm'], albedo: [0.2382, 0.2621, 0.2625], floors: 8, bays: 10, kb: 261, note: 'ribbon windows + white spandrels, 8 floors x 10 bays (3.5 m x 2.8 m); no night map' },
    facade_brick_windows: { src: 'acg:Facade018A', res: '1K', tile_m: 20, maps: ['color', 'normal', 'arm', 'emissive'], albedo: [0.181, 0.1509, 0.1437], floors: 6, bays: 6, kb: 963, note: 'brick wall with punched windows, 6 floors x 6 bays (3.33 m); night map ~70% windows lit' },
    facade_concrete_windows: { src: 'acg:Facade019A', res: '1K', tile_m: 20, maps: ['color', 'normal', 'arm', 'emissive'], albedo: [0.1194, 0.1229, 0.1284], floors: 6, bays: 6, kb: 1004, note: 'dark piers + concrete floor bands, 6 floors x 6 bays; night map ~60% lit' },
    facade_residential_1: { src: 'acg:Facade020A', res: '1K', tile_m: 20, maps: ['color', 'normal', 'arm', 'emissive'], albedo: [0.1364, 0.1282, 0.1325], floors: 6, bays: 6, kb: 1022, note: 'brick piers + light bands, 6 floors x 6 bays; night map ~50% lit' },
    facade_residential_2: { src: 'acg:Facade012', res: '1K', tile_m: 112, maps: ['color', 'normal', 'arm', 'emissive'], albedo: [0.1531, 0.1272, 0.1117], floors: 32, bays: 32, kb: 944, note: 'high-rise residential, 32 floors x 32 bays (3.5 m) - for tall/far towers' },
    facade_far_office: { src: 'acg:Facade015', res: '1K', tile_m: 112, maps: ['color', 'normal', 'arm', 'emissive'], albedo: [0.2196, 0.2123, 0.2053], floors: 32, bays: 32, kb: 1045, note: 'grey office tower, 32 floors x 32 bays - far skyline' },
  },
  // Pure-sky HDRIs; lower hemisphere replaced by ground radiance (see fetch script).
  // Optional ones are skipped on the 'low' preset (use loadHdri() on demand).
  hdris: {
    hdri_day_cloudy: { src: 'ph:kloofendal_48d_partly_cloudy_puresky', res: '2K', sunElevationDeg: 47.9, optional: false, kb: 3027 },
    hdri_day_clear: { src: 'ph:kloofendal_43d_clear_puresky', res: '2K', sunElevationDeg: 42.9, optional: false, kb: 2535 },
    hdri_overcast: { src: 'ph:kloofendal_overcast_puresky', res: '2K', sunElevationDeg: 22.7, optional: true, kb: 2833, note: 'no distinct sun' },
    hdri_sunset: { src: 'ph:kloppenheim_06_puresky', res: '2K', sunElevationDeg: 5.9, optional: true, kb: 2451, note: 'sun at the horizon behind low cloud' },
    hdri_dawn: { src: 'ph:qwantani_dawn_puresky', res: '1K', sunElevationDeg: 8.3, optional: true, kb: 615, note: 'hazy pre-sunrise glow, no disk' },
    hdri_night: { src: 'ph:kloppenheim_02_puresky', res: '1K', sunElevationDeg: 17.1, optional: true, kb: 849, note: 'clear night; the bright disk is the moon' },
  },
  // Poly Haven glTF (1K textures). tris = triangles actually in the file.
  models: {
    jersey_barrier: { src: 'ph:concrete_road_barrier_02', file: 'models/jersey_barrier/concrete_road_barrier_02.gltf', tris: 23822, kb: 1161 },
    oil_drum: { src: 'ph:barrel_03', file: 'models/oil_drum/barrel_03.gltf', tris: 1473, kb: 584, note: 'blue steel 200 l drum' },
    plastic_drum: { src: 'ph:Barrel_02', file: 'models/plastic_drum/Barrel_02.gltf', tris: 2688, kb: 435 },
    wooden_crate: { src: 'ph:wooden_crate_02', file: 'models/wooden_crate/wooden_crate_02.gltf', tris: 5176, kb: 691, note: 'parts: crate, lid' },
    cement_bag: { src: 'ph:cement_bag', file: 'models/cement_bag/cement_bag.gltf', tris: 844, kb: 285, note: '25 kg bag lying flat' },
    generator: { src: 'ph:portable_generator', file: 'models/generator/portable_generator.gltf', tris: 26419, kb: 1640 },
    gas_cylinder: { src: 'ph:small_lpg_tank', file: 'models/gas_cylinder/small_lpg_tank.gltf', tris: 15042, kb: 1025 },
    utility_box: { src: 'ph:utility_box_02', file: 'models/utility_box/utility_box_02.gltf', tris: 6268, kb: 649, note: 'green street electrical cabinet' },
    manhole_cover: { src: 'ph:water_manhole_cover', file: 'models/manhole_cover/water_manhole_cover.gltf', tris: 6301, kb: 795 },
    aircon_unit: { src: 'ph:exterior_aircon_unit', file: 'models/aircon_unit/exterior_aircon_unit.gltf', tris: 18986, kb: 2904, variants: true, note: 'parts: clean + rusted (9.5k tris each)' },
    shrubs_large: { src: 'ph:shrub_02', file: 'models/shrubs_large/shrub_02.gltf', tris: 27254, kb: 1074, variants: true, note: '4 bushes 1-2 m (parts a-d)' },
    shrubs_small: { src: 'ph:shrub_03', file: 'models/shrubs_small/shrub_03.gltf', tris: 8287, kb: 630, variants: true, note: '4 low plants ~0.4 m (parts a-d)' },
  },
};

const BASE = ((import.meta.env && import.meta.env.BASE_URL) || '/') + 'assets/';

const cache = { textures: {}, hdris: {}, hdriInfo: {}, hdriNoSun: {}, envMaps: {}, models: {}, modelInfo: {} };
const state = { anisotropy: 8, maxSize: 4096, smallMaxSize: 4096, promise: null, quality: 'high' };

// ------------------------------------------------------------------ images
// Full-res: <img> + decode() — decoded off the main thread (no upload stall)
// and, unlike an ImageBitmap, the browser may purge the decoded pixels once
// they are on the GPU (~150 Mpx of textures would otherwise pin ~600 MB RAM).
// Downscaled ('low' preset): createImageBitmap resize; flipY is baked in
// there because WebGL ignores UNPACK_FLIP_Y for ImageBitmaps. Safari's
// ImageBitmap ignores imageOrientation on some versions → canvas resize.
// Data maps stay exact: three disables colour-space conversion on upload
// for NoColorSpace textures.
const isSafari = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

async function loadImageTexture(url, { srgb, maxSize }) {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode(); // rejects on 404 / bad data
  let tex;
  if (img.naturalWidth > maxSize) {
    const s = maxSize / img.naturalWidth;
    const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
    if (typeof createImageBitmap === 'function' && !isSafari) {
      const bmp = await createImageBitmap(img, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      tex = new THREE.Texture(bmp);
      tex.flipY = false; // already flipped
    } else {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      tex = new THREE.Texture(c);
    }
  } else {
    tex = new THREE.Texture(img);
  }
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = state.anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.name = url.slice(BASE.length);
  return tex;
}

async function loadTextureSet(name) {
  const m = MANIFEST.textures[name];
  const dir = `${BASE}textures/${name}/`;
  const hero = m.res === '2K';
  const maxSize = hero ? state.maxSize : state.smallMaxSize;
  const want = (k) => m.maps.includes(k);
  const [map, normalMap, armMap, alphaMap, emissiveMap] = await Promise.all([
    loadImageTexture(dir + 'color.jpg', { srgb: true, maxSize }),
    loadImageTexture(dir + 'normal.jpg', { srgb: false, maxSize }),
    // ARM is stored at 1K even for hero sets (roughness/AO are low-frequency)
    loadImageTexture(dir + 'arm.jpg', { srgb: false, maxSize: state.smallMaxSize }),
    want('alpha') ? loadImageTexture(dir + 'alpha.jpg', { srgb: false, maxSize }) : null,
    want('emissive') ? loadImageTexture(dir + 'emissive.jpg', { srgb: true, maxSize: state.smallMaxSize }) : null,
  ]);
  const set = { map, normalMap, armMap, aoMap: armMap, roughnessMap: armMap, metalnessMap: armMap };
  if (alphaMap) set.alphaMap = alphaMap;
  if (emissiveMap) set.emissiveMap = emissiveMap;
  cache.textures[name] = set;
}

// ------------------------------------------------------------------ HDRIs
const hdrLoader = new HDRLoader(); // HalfFloatType: half the VRAM of float, filterable everywhere
let HALF_LUT = null;
function halfLut() {
  if (!HALF_LUT) {
    HALF_LUT = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) HALF_LUT[i] = THREE.DataUtils.fromHalfFloat(i);
  }
  return HALF_LUT;
}
const LR = 0.2126, LG = 0.7152, LB = 0.0722;

// Analyse an equirect half-float image: sun = weighted centroid of the
// brightest cap; sun/sky irradiance in the HDRI's own units, so a
// DirectionalLight(sunColor, sunIntensity * envIntensity) next to the
// sun-removed environment reproduces the photographed lighting exactly.
function analyseHdri(tex) {
  const { width: W, height: H, data } = tex.image;
  const lut = halfLut();
  const px = (x, y) => (y * W + x) * 4;
  // brightest pixel (luminance)
  let best = -1, bx = 0, by = 0;
  for (let y = 0; y < H >> 1; y++) { // sun/moon is above the horizon
    for (let x = 0; x < W; x++) {
      const i = px(x, y);
      const l = LR * lut[data[i]] + LG * lut[data[i + 1]] + LB * lut[data[i + 2]];
      if (l > best) { best = l; bx = x; by = y; }
    }
  }
  const elevOf = (y) => (0.5 - (y + 0.5) / H) * Math.PI;
  const azOf = (x) => ((x + 0.5) / W - 0.5) * 2 * Math.PI;
  const dirOf = (x, y, out) => {
    const e = elevOf(y), a = azOf(x), c = Math.cos(e);
    return out.set(c * Math.cos(a), Math.sin(e), c * Math.sin(a));
  };
  const peakDir = dirOf(bx, by, new THREE.Vector3());
  const tmp = new THREE.Vector3();
  const pixOmega = (2 * Math.PI / W) * (Math.PI / H);
  // window around the peak (8° radius)
  const R = 8 * Math.PI / 180;
  const rows = Math.ceil(R / Math.PI * H) + 1;
  const y0 = Math.max(0, by - rows), y1 = Math.min(H - 1, by + rows);
  const cosCap = Math.cos(3 * Math.PI / 180), cosRing0 = Math.cos(4 * Math.PI / 180), cosRing1 = Math.cos(8 * Math.PI / 180);
  const ring = [0, 0, 0]; let ringN = 0;
  const edge = [0, 0, 0]; let edgeN = 0; // 3-4° annulus: colour the sun cap is clamped to
  const ringLum = [];
  const visitWindow = (fn) => {
    for (let y = y0; y <= y1; y++) {
      const c = Math.max(Math.cos(elevOf(y)), 1e-3);
      const cols = Math.min(W >> 1, Math.ceil(R / (2 * Math.PI) * W / c) + 1);
      for (let dx = -cols; dx <= cols; dx++) {
        const x = (bx + dx + W) % W;
        const d = dirOf(x, y, tmp).dot(peakDir);
        fn(x, y, d, c);
      }
    }
  };
  visitWindow((x, y, d) => {
    if (d < cosRing0 && d > cosRing1) {
      const i = px(x, y);
      const r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]];
      ring[0] += r; ring[1] += g; ring[2] += b; ringN++;
      ringLum.push(LR * r + LG * g + LB * b);
    } else if (d >= cosRing0 && d < cosCap) {
      const i = px(x, y);
      edge[0] += lut[data[i]]; edge[1] += lut[data[i + 1]]; edge[2] += lut[data[i + 2]]; edgeN++;
    }
  });
  ringLum.sort((a, b) => a - b);
  const skyLevel = ringLum.length ? ringLum[ringLum.length >> 1] : best;
  const ringRGB = ringN ? ring.map((v) => v / ringN) : [skyLevel, skyLevel, skyLevel];
  const edgeRGB = edgeN ? edge.map((v) => v / edgeN) : ringRGB;
  const sunRGB = [0, 0, 0];
  const centroid = new THREE.Vector3();
  const capPixels = []; // every pixel within 3° (removeSun clamps them to edgeRGB)
  const sunPixels = new Set(); // the part that is brighter than the sky dome
  visitWindow((x, y, d, c) => {
    if (d < cosCap) return;
    const i = px(x, y);
    capPixels.push(i);
    const r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]];
    const l = LR * r + LG * g + LB * b;
    if (l <= skyLevel * 1.5) return;
    const w = pixOmega * c;
    sunRGB[0] += Math.max(0, r - ringRGB[0]) * w;
    sunRGB[1] += Math.max(0, g - ringRGB[1]) * w;
    sunRGB[2] += Math.max(0, b - ringRGB[2]) * w;
    centroid.addScaledVector(dirOf(x, y, tmp), (l - skyLevel) * w);
    sunPixels.add(i);
  });
  const sunDir = centroid.lengthSq() > 0 ? centroid.normalize() : peakDir.clone();
  // hemisphere integrals (sky only: sun pixels replaced by the ring level)
  const skyE = [0, 0, 0], hor = [0, 0, 0], zen = [0, 0, 0];
  let horN = 0, zenN = 0, lumSum = 0, omegaSum = 0;
  const step = W >= 2048 ? 2 : 1; // subsample big images (smooth sky)
  for (let y = 0; y < H >> 1; y += step) {
    const e = elevOf(y), s = Math.sin(e), c = Math.cos(e);
    const w = pixOmega * c * step * step;
    const deg = e * 180 / Math.PI;
    for (let x = 0; x < W; x += step) {
      const i = px(x, y);
      let r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]];
      if (sunPixels.has(i)) { r = ringRGB[0]; g = ringRGB[1]; b = ringRGB[2]; }
      skyE[0] += r * s * w; skyE[1] += g * s * w; skyE[2] += b * s * w;
      lumSum += (LR * r + LG * g + LB * b) * w; omegaSum += w;
      if (deg < 5) { hor[0] += r; hor[1] += g; hor[2] += b; horN++; }
      if (deg > 75) { zen[0] += r; zen[1] += g; zen[2] += b; zenN++; }
    }
  }
  const lum = (v) => LR * v[0] + LG * v[1] + LB * v[2];
  const norm = (v) => { const m = Math.max(v[0], v[1], v[2], 1e-9); return new THREE.Color(v[0] / m, v[1] / m, v[2] / m); };
  const sunLum = lum(sunRGB);
  const hasSun = sunLum > 0.25 * lum(skyE); // disk clearly separable from the sky dome
  return {
    sunDir,
    elevationDeg: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1))),
    azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(sunDir.z, sunDir.x)),
    hasSun,
    sunColor: norm(sunRGB),
    sunIntensity: Math.max(sunRGB[0], sunRGB[1], sunRGB[2]), // colour * this = normal-incidence irradiance
    skyColor: norm(skyE),
    skyIntensity: Math.max(skyE[0], skyE[1], skyE[2]), // horizontal irradiance from the sky dome only
    horizonColor: new THREE.Color(hor[0] / Math.max(horN, 1), hor[1] / Math.max(horN, 1), hor[2] / Math.max(horN, 1)),
    zenithColor: new THREE.Color(zen[0] / Math.max(zenN, 1), zen[1] / Math.max(zenN, 1), zen[2] / Math.max(zenN, 1)),
    meanLuminance: lumSum / Math.max(omegaSum, 1e-9),
    peakLuminance: best,
    _cap: { pixels: capPixels, fillRGB: edgeRGB },
  };
}

async function loadHdriInternal(name) {
  if (cache.hdris[name]) return cache.hdris[name];
  const tex = await hdrLoader.loadAsync(`${BASE}hdri/${name}.hdr`);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.name = name;
  cache.hdris[name] = tex;
  try {
    cache.hdriInfo[name] = analyseHdri(tex);
  } catch (e) {
    console.warn('[assets] HDRI analysis failed', name, e);
  }
  return tex;
}

// ------------------------------------------------------------------ models
const gltfLoader = new GLTFLoader();
async function loadModel(name) {
  const m = MANIFEST.models[name];
  const gltf = await gltfLoader.loadAsync(BASE + m.file);
  const root = gltf.scene;
  root.name = name;
  let triangles = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        if (mat[k]) mat[k].anisotropy = state.anisotropy;
      }
    }
  });
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  cache.models[name] = root;
  cache.modelInfo[name] = {
    size: box.getSize(new THREE.Vector3()), min: box.min.clone(), max: box.max.clone(),
    parts: root.children.map((c) => c.name), triangles,
  };
}

// ------------------------------------------------------------------ loading
export function loadAssets(onProgress = () => {}, opts = {}) {
  if (state.promise) return state.promise;
  const quality = typeof opts.quality === 'string' ? opts.quality : opts.quality?.name || 'high';
  state.quality = quality;
  if (opts.renderer?.capabilities) state.anisotropy = Math.min(16, opts.renderer.capabilities.getMaxAnisotropy() || 8);
  if (quality === 'low') { state.anisotropy = Math.min(state.anisotropy, 4); state.maxSize = 1024; state.smallMaxSize = 512; }

  const jobs = [];
  const add = (kind, name, kb, fn) => jobs.push({ kind, name, kb: kb || 200, fn });
  for (const [n, m] of Object.entries(MANIFEST.textures)) add('texture', n, m.kb, () => loadTextureSet(n));
  for (const [n, m] of Object.entries(MANIFEST.hdris)) {
    if (quality === 'low' && m.optional) continue;
    add('hdri', n, m.kb, () => loadHdriInternal(n));
  }
  for (const [n, m] of Object.entries(MANIFEST.models)) add('model', n, m.kb, () => loadModel(n));

  const total = jobs.reduce((s, j) => s + j.kb, 0) || 1;
  let done = 0;
  onProgress(0, 'assets');
  state.promise = Promise.all(jobs.map((j) => j.fn().catch((e) => {
    console.warn(`[assets] ${j.kind} '${j.name}' failed to load - using fallback`, e);
  }).finally(() => {
    done += j.kb;
    try { onProgress(Math.min(1, done / total), j.name); } catch { /* progress UI must not break loading */ }
  }))).then(() => { onProgress(1, 'ready'); });
  return state.promise;
}

// Lazy-load an HDRI that was skipped (quality 'low') or not yet needed.
export function loadHdri(name) {
  if (!MANIFEST.hdris[name]) return Promise.resolve(null);
  return loadHdriInternal(name).catch((e) => { console.warn('[assets] hdri failed', name, e); return null; });
}

// ------------------------------------------------------------------ access
export function textureSet(name) {
  return cache.textures[name] || null;
}

export function tileSize(name) {
  return MANIFEST.textures[name]?.tile_m || 1;
}

const pair = (v) => (Array.isArray(v) ? v : [v, v]);

export function pbrMaterial(name, opts = {}) {
  const { repeat, worldSize, color, albedo, normalScale, ...rest } = opts;
  const set = textureSet(name);
  if (!set) {
    return new THREE.MeshStandardMaterial({ color: color ?? 0x888888, roughness: 0.8, metalness: 0, ...rest });
  }
  const meta = MANIFEST.textures[name];
  let rep = [1, 1];
  if (repeat !== undefined) rep = pair(repeat);
  else if (worldSize !== undefined) rep = pair(worldSize).map((s) => s / meta.tile_m);
  const cl = (t) => {
    if (!t) return null;
    const c = t.clone(); // shares t.source → one GPU upload for every clone
    c.repeat.set(rep[0], rep[1]);
    return c;
  };
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 1, ...rest });
  mat.name = name;
  mat.map = cl(set.map);
  mat.normalMap = cl(set.normalMap);
  const arm = cl(set.armMap);
  mat.aoMap = arm; // R
  mat.roughnessMap = arm; // G
  mat.metalnessMap = arm; // B
  if (normalScale !== undefined) mat.normalScale.set(...pair(normalScale));
  const tint = new THREE.Color(color ?? 0xffffff);
  if (albedo !== undefined && meta.albedo) {
    const [r, g, b] = meta.albedo;
    const cur = LR * r * tint.r + LG * g * tint.g + LB * b * tint.b;
    tint.multiplyScalar(albedo / Math.max(cur, 1e-4));
  }
  mat.color.copy(tint);
  if (set.alphaMap) {
    // Thin wire / grating. Alpha-TESTING makes distant mesh vanish (mip-averaged
    // coverage of a 50 mm chain-link is ~8%), so blend instead: close up the
    // alpha is binary and crisp, far away it becomes the faint grey haze real
    // fences show. depthWrite stays on so fences don't sort-flicker.
    // (Tip: castShadow=false for chainlink — its mips shadow as a solid sheet.)
    mat.alphaMap = cl(set.alphaMap);
    if (rest.transparent === undefined) mat.transparent = true;
    if (rest.alphaTest === undefined) mat.alphaTest = 0.02;
    if (rest.depthWrite === undefined) mat.depthWrite = true;
    if (rest.side === undefined) mat.side = THREE.DoubleSide;
  }
  if (set.emissiveMap) {
    // night windows: off by default; raise mat.emissive / emissiveIntensity after dusk
    mat.emissiveMap = cl(set.emissiveMap);
    if (rest.emissive === undefined) mat.emissive.set(0x000000);
  }
  return mat;
}

export function hdri(name, opts = {}) {
  const tex = cache.hdris[name];
  if (!tex) return null;
  if (!opts.removeSun) return tex;
  if (cache.hdriNoSun[name]) return cache.hdriNoSun[name];
  const info = cache.hdriInfo[name];
  if (!info) return tex;
  // Copy with the sun disk (3° cap incl. glare core) clamped to the colour of
  // the sky just around it — for IBL when a DirectionalLight provides the sun
  // (otherwise the sun is counted twice). Not meant as a visible background.
  const src = tex.image.data;
  const data = new Uint16Array(src);
  const lut = halfLut();
  const fill = info._cap.fillRGB;
  const fillLum = LR * fill[0] + LG * fill[1] + LB * fill[2];
  const [r, g, b] = fill.map((v) => THREE.DataUtils.toHalfFloat(v));
  for (const i of info._cap.pixels) {
    if (LR * lut[src[i]] + LG * lut[src[i + 1]] + LB * lut[src[i + 2]] > fillLum) { data[i] = r; data[i + 1] = g; data[i + 2] = b; }
  }
  const out = new THREE.DataTexture(data, tex.image.width, tex.image.height, THREE.RGBAFormat, tex.type);
  out.mapping = THREE.EquirectangularReflectionMapping;
  out.colorSpace = tex.colorSpace;
  out.flipY = tex.flipY;
  out.minFilter = out.magFilter = THREE.LinearFilter;
  out.generateMipmaps = false;
  out.name = name + '_nosun';
  out.needsUpdate = true;
  cache.hdriNoSun[name] = out;
  return out;
}

export function hdriInfo(name) {
  const i = cache.hdriInfo[name];
  if (!i) return null;
  const { _cap, ...pub } = i;
  for (const k of Object.keys(pub)) if (pub[k]?.clone) pub[k] = pub[k].clone(); // callers may mutate
  return pub;
}

// PMREM-filtered environment for scene.environment (cached per name/options).
export function hdriEnvMap(name, renderer, opts = {}) {
  const key = name + (opts.removeSun ? ':nosun' : '');
  if (cache.envMaps[key]) return cache.envMaps[key];
  const src = hdri(name, opts);
  if (!src || !renderer) return null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(src);
  pmrem.dispose();
  if (opts.removeSun && src !== cache.hdris[name]) { src.dispose(); delete cache.hdriNoSun[name]; }
  cache.envMaps[key] = rt.texture;
  return rt.texture;
}

export function model(name, opts = {}) {
  const src = cache.models[name];
  if (!src) return null;
  if (opts.part === undefined) return src.clone(true); // shares geometry + materials
  const part = typeof opts.part === 'number' ? src.children[opts.part] : src.getObjectByName(opts.part);
  if (!part) return null;
  // variant sets are laid out side by side: recentre the part on the origin, base at y=0
  const c = part.clone(true);
  c.position.set(0, 0, 0);
  c.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(c);
  const g = new THREE.Group();
  g.name = `${name}:${part.name}`;
  c.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  g.add(c);
  return g;
}

export function modelInfo(name) {
  const i = cache.modelInfo[name];
  if (!i) return null;
  return { size: i.size.clone(), min: i.min.clone(), max: i.max.clone(), parts: [...i.parts], triangles: i.triangles };
}

export function listAssets() {
  return {
    textures: Object.keys(cache.textures),
    hdris: Object.keys(cache.hdris),
    models: Object.keys(cache.models),
  };
}
