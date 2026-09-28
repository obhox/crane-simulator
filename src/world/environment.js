import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { clamp, lerp, smoothstep } from '../util/math.js';
import { detailNoise } from './textures.js';
import { hdri, hdriInfo, loadHdri } from './assets.js';

// Sky, sun, image-based lighting, aerial perspective, shadows, time of day
// and weather.
//
//  - Sky: a camera-centred dome that cross-fades two photographed HDR skies
//    (Poly Haven, see assets.js) chosen by sun elevation + weather. Each HDRI
//    is rotated (and its elevations gently warped) so its own sun/glow sits on
//    the simulated sun; the photographed disk is removed and a physically sized
//    disk is drawn at the true sun position instead.
//  - IBL: the same dome (without the disk) is rendered into a small cube map
//    and PMREM-filtered whenever the sky changes, so reflections / ambient
//    always match what is on screen. The direct beam is a SunLight whose
//    colour and irradiance come from an air-mass transmittance model.
//  - Atmosphere: three's fog chunks are replaced with aerial perspective
//    (distance haze thickening into the horizon, low morning mist and sun-side
//    forward scattering) that uses the SAME colour as the dome's horizon band,
//    so the far city melts into the sky without a seam. Works for every
//    built-in material (Basic/Lambert/Phong/Standard/Physical/...).
//  - Shadows: 3 cascaded sun shadow maps (SunLight's atlas machinery with our
//    own fitting + sampling): ~3 cm texels next to the camera, the site from
//    the cab, and the surrounding city blocks out to ~900 m. Drifting cumulus
//    shadows on partly cloudy days.
//
// Units: light intensities are irradiance in three's physical units, scaled so
// noon sun ≈ 3.3 (sky ≈ 1.1-1.3) with renderer.toneMappingExposure ≈ 0.78 by
// day, rising to ≈1.9 at sunset (a camera adapting) and settling at ≈1.35 at
// night (moon 0.12, sky 0.03). Judge emissive windows / lamps against those.
//
// World orientation: +z = north, −x = east (the public road at z = −66 is the
// south side). Latitude 45°N, declination +10° (late April / mid August):
// sunrise ≈ 05:35, noon (12:15) at 55°, sunset ≈ 18:55, dark ≈ 20:30.

// Adds a tiling grey detail texture on top of a material's map so large
// surfaces don't look blurry up close.
export function addDetail(material, scale = 40, strength = 0.45) {
  const tex = detailNoise();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: tex };
    shader.uniforms.detailScale = { value: scale };
    shader.uniforms.detailStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nuniform float detailScale;\nuniform float detailStrength;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        #ifdef USE_MAP
          float dn = texture2D(detailMap, vMapUv * detailScale).r;
          float dn2 = texture2D(detailMap, vMapUv * detailScale * 0.137).r;
          diffuseColor.rgb *= mix(1.0 - detailStrength * 0.5, 1.0 + detailStrength * 0.5, dn * 0.6 + dn2 * 0.4);
        #endif`
      );
  };
  material.customProgramCacheKey = () => 'detail' + scale;
  return material;
}

// ------------------------------------------------------------------ constants
const DEG = Math.PI / 180;
const LATITUDE = 45 * DEG;
const DECLINATION = 10 * DEG;
const SOLAR_NOON = 12.25;
// Direct-beam optical depth at the zenith (Rayleigh + aerosol + ozone) for
// R/G/B: gives ~5500 K light at noon, gold at 10°, orange-red below 4°.
const TAU = [0.1, 0.165, 0.26];
const SUN_E0 = 4.0; // extra-atmospheric irradiance in scene units
const SUN_RADIUS = 0.35 * DEG; // a touch larger than the real 0.27° so it reads on screen
const MOON = { elevation: 17.1, compass: 160, irradiance: 0.15, color: new THREE.Color(0.58, 0.7, 1.0) };
const CASCADES = 3;
// Night fill (moonlit sky + light pollution). Far above the real ~0.001 lux-ish
// level, like night photography / GTA: the city stays readable in blue-grey.
const NIGHT_SKY_E = 0.028;

// weather presets: which HDRI family, how much sun gets through, sky
// brightness, haze (linear k1 / quadratic k2 extinction, 1/m), morning mist,
// cloud-shadow coverage and aerosol turbidity of the direct beam.
const WEATHER = {
  clear: { day: 'hdri_day_clear', am: 'hdri_dawn', pm: 'hdri_sunset', night: 'hdri_night', sun: 1.0, sky: 1.0, k1: 1.0e-4, k2: 1.4e-7, mist: 1.0, clouds: 0, turbidity: 1.0, glow: 1.0, moon: 1.0 },
  cloudy: { day: 'hdri_day_cloudy', am: 'hdri_dawn', pm: 'hdri_sunset', night: 'hdri_night', sun: 0.92, sky: 1.2, k1: 1.3e-4, k2: 1.6e-7, mist: 0.7, clouds: 0.42, turbidity: 1.25, glow: 1.3, moon: 0.8 },
  overcast: { day: 'hdri_overcast', am: 'hdri_overcast', pm: 'hdri_overcast', night: 'hdri_overcast', sun: 0.035, sky: 1.3, k1: 3.4e-4, k2: 3.2e-7, mist: 1.6, clouds: 0, turbidity: 2.0, glow: 3.0, moon: 0.12 },
};
export const WEATHER_TYPES = Object.keys(WEATHER);

// HDRIs to substitute when an optional one is missing (e.g. 'low' preset)
const HDRI_FALLBACK = {
  hdri_day_cloudy: 'hdri_day_clear', hdri_day_clear: 'hdri_day_cloudy', hdri_overcast: 'hdri_day_cloudy',
  hdri_sunset: 'hdri_day_clear', hdri_dawn: 'hdri_day_clear', hdri_night: 'hdri_day_clear',
};

// ------------------------------------------------------------------ sun model
// Solar position for the given clock hour → unit vector (world) + elevation (deg).
function solarPosition(hour, out) {
  const H = (hour - SOLAR_NOON) * 15 * DEG;
  const sinE = Math.sin(LATITUDE) * Math.sin(DECLINATION) + Math.cos(LATITUDE) * Math.cos(DECLINATION) * Math.cos(H);
  const e = Math.asin(sinE);
  // azimuth from north, clockwise through east
  const A = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LATITUDE) - Math.tan(DECLINATION) * Math.cos(LATITUDE)) + Math.PI;
  out.set(-Math.sin(A) * Math.cos(e), Math.sin(e), Math.cos(A) * Math.cos(e));
  return e / DEG;
}

function compassDir(compassDeg, elevDeg, out) {
  const A = compassDeg * DEG, e = elevDeg * DEG;
  return out.set(-Math.sin(A) * Math.cos(e), Math.sin(e), Math.cos(A) * Math.cos(e)).normalize();
}

// Kasten & Young relative air mass (finite at the horizon)
function airMass(elevDeg) {
  const e = Math.max(elevDeg, -0.8);
  return 1 / (Math.sin(e * DEG) + 0.50572 * Math.pow(e + 6.07995, -1.6364));
}

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// Horizontal irradiance from the clear sky dome (scene units). Below the
// horizon it decays through civil/nautical twilight; values are already
// "exposure compressed" (a camera adapts), physically they'd span 10^5.
function skyIrradiance(e) {
  // (falls faster than the direct beam towards the horizon, so low sun reads
  // as warm key light against a cooler, dimmer sky — golden hour contrast)
  if (e >= 0) return 0.2 * Math.exp(-e / 2) + 1.25 * Math.pow(Math.sin(e * DEG), 0.62);
  return 0.2 * Math.exp(e / 3.2);
}

// Camera exposure vs sun elevation: a photographer (or GTA's eye adaptation)
// almost fully compensates the dimming towards sunset, then lets the blue
// hour and night stay darker so street lights and windows read as lights.
const EXPOSURE_CURVE = [[-90, 1.3], [-10, 1.35], [-6, 1.5], [-3, 1.7], [0, 1.9], [2, 1.9], [5, 1.72], [10, 1.25], [15, 1.02], [30, 0.82], [55, 0.78], [90, 0.78]];
function exposureFor(e) {
  const c = EXPOSURE_CURVE;
  for (let i = 1; i < c.length; i++) {
    if (e <= c[i][0]) return lerp(c[i - 1][1], c[i][1], (e - c[i - 1][0]) / (c[i][0] - c[i - 1][0]));
  }
  return c[c.length - 1][1];
}

// ------------------------------------------------------------------ shader patches
// Shared uniform VALUE objects. three deep-copies Vector/Color uniforms per
// material, but plain {x,y,z,w} objects are copied by reference, so every
// material compiled from the patched ShaderLib sees these live.
const ATMO = {
  fogSunDir: { x: 0, y: 1, z: 0 },
  fogSunColor: { x: 0, y: 0, z: 0 },
  fogParams: { x: 0, y: 0, z: 0.05, w: 8 }, // x: quadratic extinction, y: mist density, z: 1/mist height, w: sun lobe exponent
  sunShadowParams: { x: 10, y: 0.05, z: 5, w: 0 }, // x: PCF taps, y: world softness (m), z: max kernel radius (texels)
  cloudParams: { x: 0, y: 0, z: 1 / 1600, w: 0 }, // x,y: drift (m), z: 1/tile size, w: strength
  cloudParams2: { x: 0.55, y: 0.035, z: 1400, w: 0 }, // x: coverage threshold (fBm median 0.49), y: edge softness, z: cloud base (m)
  cloudMap: null,
};

const CHUNK_SRC = {};
function patchChunk(name, fn) {
  const src = CHUNK_SRC[name] ?? (CHUNK_SRC[name] = THREE.ShaderChunk[name]);
  const out = fn(src);
  if (out === src) console.warn(`[environment] shader chunk '${name}' not patched (three changed?)`);
  THREE.ShaderChunk[name] = out;
}
function mustReplace(src, find, repl) {
  if (!src.includes(find)) return src;
  return src.replace(find, repl);
}

const FOG_PARS_FRAG = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldOffset;
	uniform vec3 fogSunDir;
	uniform vec3 fogSunColor;
	uniform vec4 fogParams;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

// Aerial perspective. Optical depth = k1·d (Koschmieder haze, visibility
// ~30 km) + k2·d² (the far city thickens into the horizon haze, hiding the
// world edge) + ground mist whose density falls off exponentially with
// height (integrated analytically along the view ray). The in-scattered
// colour is the sky's horizon colour plus a forward-scattering lobe towards
// the sun — the dome uses the identical formula for its horizon band.
const FOG_FRAG = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogDist = length( vFogWorldOffset );
		vec3 fogRay = vFogWorldOffset / max( fogDist, 1e-3 );
		float fogTau = fogDensity * fogDist + fogParams.x * fogDist * fogDist;
		if ( fogParams.y > 0.0 ) {
			float fogK = fogParams.z * vFogWorldOffset.y;
			float fogI = abs( fogK ) > 1e-3 ? ( 1.0 - exp( - fogK ) ) / fogK : 1.0 - 0.5 * fogK;
			fogTau += fogParams.y * fogDist * exp( - fogParams.z * max( cameraPosition.y, 0.0 ) ) * fogI;
		}
		float fogFactor = 1.0 - exp( - fogTau );
		vec3 fogTint = fogColor + fogSunColor * pow( max( dot( fogRay, fogSunDir ), 0.0 ), max( fogParams.w, 1.0 ) );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		vec3 fogTint = fogColor;
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
#endif
`;

// Sun cascades: the cascade is picked by the fragment's position inside each
// cascade's light-space tile (not by view depth), so any camera — including the
// hook-cam picture-in-picture — can reuse cascades fitted to the main view.
// Normal offset + depth bias scale with each cascade's texel size (no acne on
// the lattice close up, no peter-panning far away) and the PCF kernel is sized
// in metres so the penumbra doesn't jump between cascades.
const SUN_SHADOW_GLSL = /* glsl */`
	uniform vec4 sunShadowParams;
	#if defined( SHADOWMAP_TYPE_PCF )
		float getSunShadow( sampler2DShadow shadowMap, SunLightShadow sunLightShadow, int shadowIndex ) {
			int cascadeOffset = shadowIndex * SUN_LIGHT_CASCADES;
			vec2 texel = 1.0 / sunLightShadow.shadowMapSize;
			int taps = sunShadowParams.x > 0.5 ? int( sunShadowParams.x ) : 5;
			float softness = sunShadowParams.x > 0.5 ? sunShadowParams.y : 0.05;
			float maxRadius = sunShadowParams.x > 0.5 ? sunShadowParams.z : 4.0;
			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			float lit = 0.0;
			float remaining = 1.0;
			for ( int i = 0; i < SUN_LIGHT_CASCADES; i ++ ) {
				mat4 m = sunShadowMatrix[ cascadeOffset + i ];
				vec4 tile = sunShadowCascade[ cascadeOffset + i ]; // atlas uv bounds (min.xy, max.xy)
				float texelM = 1.0 / ( length( vec3( m[ 0 ][ 0 ], m[ 1 ][ 0 ], m[ 2 ][ 0 ] ) ) * sunLightShadow.shadowMapSize.x );
				float depthPerM = length( vec3( m[ 0 ][ 2 ], m[ 1 ][ 2 ], m[ 2 ][ 2 ] ) );
				float radius = clamp( softness / texelM, max( sunLightShadow.shadowRadius, 0.5 ), maxRadius );
				vec3 wp = vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * ( sunLightShadow.shadowNormalBias * texelM * max( 1.0, radius * 0.5 ) );
				vec4 sc = m * vec4( wp, 1.0 );
				vec2 t = ( sc.xy - tile.xy ) / ( tile.zw - tile.xy );
				if ( t.x <= 0.0 || t.x >= 1.0 || t.y <= 0.0 || t.y >= 1.0 || sc.z >= 1.0 ) continue;
				float edge = min( min( t.x, 1.0 - t.x ), min( t.y, 1.0 - t.y ) );
				float w = remaining * smoothstep( 0.0, 0.06, edge );
				if ( w <= 0.0 ) continue;
				float z = sc.z - sunLightShadow.shadowBias * texelM * depthPerM;
				vec2 lo = tile.xy + texel, hi = tile.zw - texel;
				float s = 0.0;
				for ( int k = 0; k < 32; k ++ ) {
					if ( k >= taps ) break;
					vec2 uv = clamp( sc.xy + vogelDiskSample( k, taps, phi ) * radius * texel, lo, hi );
					s += texture( shadowMap, vec3( uv, z ) );
				}
				lit += w * s / float( taps );
				remaining -= w;
				if ( remaining <= 0.001 ) break;
			}
			return mix( 1.0, lit + remaining, sunLightShadow.shadowIntensity );
		}
	#else
		float getSunShadow( sampler2D shadowMap, SunLightShadow sunLightShadow, int shadowIndex ) { return 1.0; }
	#endif
`;

// Drifting cumulus shadows: the sun ray through the fragment is traced up to
// the cloud base and a tiling fBm coverage map is looked up there.
const CLOUD_PARS_GLSL = /* glsl */`
#if NUM_SUN_LIGHTS > 0
	uniform sampler2D cloudShadowMap;
	uniform vec4 cloudParams;
	uniform vec4 cloudParams2;
	float cloudShadowFactor( vec3 viewPos ) {
		if ( cloudParams.w <= 0.0 ) return 1.0;
		vec3 wp = cameraPosition + ( vec4( viewPos, 0.0 ) * viewMatrix ).xyz;
		vec3 L = ( vec4( sunLights[ 0 ].direction, 0.0 ) * viewMatrix ).xyz;
		vec2 p = wp.xz + L.xz * ( ( cloudParams2.z - wp.y ) / max( L.y, 0.08 ) );
		float n = texture2D( cloudShadowMap, ( p + cloudParams.xy ) * cloudParams.z ).r;
		return 1.0 - cloudParams.w * smoothstep( cloudParams2.x - cloudParams2.y, cloudParams2.x + cloudParams2.y, n );
	}
#endif
`;

function installShaderPatches() {
  if (CHUNK_SRC.fog_fragment) return; // once per page
  patchChunk('fog_pars_vertex', () => '#ifdef USE_FOG\n\tvarying float vFogDepth;\n\tvarying vec3 vFogWorldOffset;\n#endif\n');
  patchChunk('fog_vertex', () => '#ifdef USE_FOG\n\tvFogDepth = - mvPosition.z;\n\tvFogWorldOffset = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;\n#endif\n');
  patchChunk('fog_pars_fragment', () => FOG_PARS_FRAG);
  patchChunk('fog_fragment', () => FOG_FRAG);
  patchChunk('shadowmap_pars_fragment', (s) => {
    let o = mustReplace(s, '#define SUN_LIGHT_CASCADES 2', `#define SUN_LIGHT_CASCADES ${CASCADES}`);
    o = mustReplace(o, 'float getSunShadow(', SUN_SHADOW_GLSL + '\n\t\tfloat getSunShadowBuiltin(');
    return o;
  });
  patchChunk('lights_pars_begin', (s) => s + CLOUD_PARS_GLSL);
  patchChunk('lights_fragment_begin', (s) => mustReplace(s, 'getSunLightInfo( sunLight, directLight );',
    'getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= cloudShadowFactor( geometryPosition );'));

  ATMO.cloudMap = cloudTexture();
  const fogU = () => ({ fogSunDir: { value: ATMO.fogSunDir }, fogSunColor: { value: ATMO.fogSunColor }, fogParams: { value: ATMO.fogParams } });
  const litU = () => ({
    sunShadowParams: { value: ATMO.sunShadowParams }, cloudParams: { value: ATMO.cloudParams },
    cloudParams2: { value: ATMO.cloudParams2 }, cloudShadowMap: { value: ATMO.cloudMap },
  });
  for (const lib of Object.values(THREE.ShaderLib)) {
    if (!lib || !lib.uniforms) continue;
    if (lib.uniforms.fogColor) Object.assign(lib.uniforms, fogU());
    if (lib.uniforms.sunLights) Object.assign(lib.uniforms, litU());
  }
  // custom ShaderMaterials that merge UniformsLib.fog / .lights pick these up too
  Object.assign(THREE.UniformsLib.fog, fogU());
  Object.assign(THREE.UniformsLib.lights, litU());
}

// Tileable fBm value noise → cumulus coverage map (R channel), 256².
function cloudTexture() {
  const N = 256;
  const lattice = new Float32Array(64 * 64 + 1024); // finest octave: 64² cells, + per-octave offsets
  let s = 12345;
  for (let i = 0; i < lattice.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; lattice[i] = s / 4294967296; }
  const vnoise = (x, y, per, o) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const L = (a, b) => lattice[o + (((a % per) + per) % per) * per + (((b % per) + per) % per)];
    const a = L(xi, yi), b = L(xi + 1, yi), c = L(xi, yi + 1), d = L(xi + 1, yi + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let v = 0, amp = 0.55, per = 4, norm = 0;
      for (let o = 0; o < 5; o++) {
        v += vnoise((x / N) * per, (y / N) * per, per, o * 131) * amp;
        norm += amp; amp *= 0.5; per *= 2;
      }
      const i = (y * N + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round((v / norm) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ cascaded sun shadow
const _zero = new THREE.Vector3();
const _lightDir = new THREE.Vector3();
const _negDir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _rotT = new THREE.Matrix4();
const _tmp = new THREE.Vector3();
const _nearV = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _pts = Array.from({ length: 40 }, () => new THREE.Vector3());
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
const quantize = (v) => Math.pow(2, Math.ceil(Math.log2(Math.max(v, 1)) * 4) / 4); // quarter-octave steps

// Shadow-caster culling for a cascade: besides the frustum test, objects too
// small to cover a couple of texels are skipped (the far cascade has ~0.7 m
// texels, so site props would only cost draw calls there).
class CasterFrustum extends THREE.Frustum {
  constructor() {
    super();
    this.minRadius = 0;
  }

  intersectsObject(object) {
    // geometry.boundingSphere is the size of ONE instance for an InstancedMesh,
    // so city-wide instanced props (bins, bollards, people) drop out too
    if (this.minRadius > 0 && object.geometry && !object.isSkinnedMesh) {
      const g = object.geometry;
      if (g.boundingSphere === null) g.computeBoundingSphere();
      if (g.boundingSphere.radius * object.matrixWorld.getMaxScaleOnAxis() < this.minRadius) return false;
    }
    return super.intersectsObject(object);
  }
}

// Three nested cascades fitted to the view frustum [near, split] clipped to
// the height band that can receive shadows, in a light-space AABB (much
// tighter than bounding spheres for a camera looking down from the cab),
// snapped to texels with size hysteresis so edges don't crawl or pump.
class CascadedSunShadow extends THREE.LightShadow {
  constructor() {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.isSunLightShadow = true;
    this.mapSize.set(2048, 2048);
    this.splits = [0, 30, 140, 900]; // view depths (m) where cascades end
    this.receivers = [-2, 160]; // world heights that can receive shadows
    this.casterTop = 220; // tallest shadow caster (m)
    this._cameras = [];
    this._matrices = [];
    this._frustums = [];
    this._cascadeData = [];
    this._ext = [];
    this._viewportCount = CASCADES;
    this._frameExtents.set(CASCADES, 1);
    this._viewports.length = 0;
    for (let i = 0; i < CASCADES; i++) {
      this._cameras.push(new THREE.OrthographicCamera());
      this._matrices.push(new THREE.Matrix4());
      this._frustums.push(new CasterFrustum());
      this._cascadeData.push(new THREE.Vector4());
      this._viewports.push(new THREE.Vector4());
      this._ext.push({ w: 0, h: 0 });
    }
  }

  getCamera(i = 0) { return this._cameras[i]; }
  getMatrix(i = 0) { return this._matrices[i]; }
  getFrustum(i = 0) { return this._frustums[i]; }

  updateMatrices(light, viewCamera) {
    if (!viewCamera || !viewCamera.isCamera) return;
    // a reflection/cube-map render that happens to come first in the frame keeps
    // the previous (main view) fit instead of refitting to a 90° cube face
    const cubeFace = viewCamera.isPerspectiveCamera && viewCamera.fov === 90 && viewCamera.aspect === 1;
    if ((cubeFace || viewCamera.userData.noShadowFit) && this._fitted) return;
    this._fitted = true;
    const res = this.mapSize.x;
    const inset = Math.min(0.05, (ATMO.sunShadowParams.z + 2) / res);
    const tileRes = res * (1 - 2 * inset);
    const [y0, y1] = this.receivers;

    _lightDir.setFromMatrixPosition(light.matrixWorld).normalize(); // towards the light
    _up.set(0, 1, 0);
    if (Math.abs(_lightDir.y) > 0.99) _up.set(0, 0, 1);
    _rot.lookAt(_zero, _negDir.copy(_lightDir).negate(), _up); // +z points at the light
    _rotT.copy(_rot).transpose();
    const reach = Math.min(4000, (this.casterTop - y0) / Math.max(_lightDir.y, 0.05));

    const persp = viewCamera.isPerspectiveCamera;
    const near = viewCamera.near;
    for (let c = 0; c < 4; c++) {
      _nearV[c].set(c === 0 || c === 3 ? 1 : -1, c < 2 ? 1 : -1, -1).applyMatrix4(viewCamera.projectionMatrixInverse);
    }

    for (let i = 0; i < CASCADES; i++) {
      const far = Math.max(near + 0.1, Math.min(this.splits[i + 1], viewCamera.far));
      for (let c = 0; c < 4; c++) {
        _corners[c].copy(_nearV[c]);
        if (persp) _corners[c + 4].copy(_nearV[c]).multiplyScalar(far / near);
        else _corners[c + 4].set(_nearV[c].x, _nearV[c].y, -far);
        _corners[c].applyMatrix4(viewCamera.matrixWorld);
        _corners[c + 4].applyMatrix4(viewCamera.matrixWorld);
      }
      // clip the frustum slice to the receiver height band
      let n = 0;
      for (const p of _corners) if (p.y >= y0 && p.y <= y1) _pts[n++].copy(p);
      for (const [a, b] of EDGES) {
        const A = _corners[a], B = _corners[b];
        for (let k = 0; k < 2; k++) {
          const y = k ? y1 : y0;
          if ((A.y - y) * (B.y - y) < 0) _pts[n++].lerpVectors(A, B, (y - A.y) / (B.y - A.y));
        }
      }
      if (n === 0) for (const p of _corners) _pts[n++].copy(p);

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < n; k++) {
        _tmp.copy(_pts[k]).applyMatrix4(_rotT);
        if (_tmp.x < minX) minX = _tmp.x; if (_tmp.x > maxX) maxX = _tmp.x;
        if (_tmp.y < minY) minY = _tmp.y; if (_tmp.y > maxY) maxY = _tmp.y;
        if (_tmp.z < minZ) minZ = _tmp.z; if (_tmp.z > maxZ) maxZ = _tmp.z;
      }
      const ext = this._ext[i];
      const w = (maxX - minX) * 1.02 + 1, h = (maxY - minY) * 1.02 + 1;
      if (w > ext.w || w < ext.w * 0.62) ext.w = quantize(w * 1.1);
      if (h > ext.h || h < ext.h * 0.62) ext.h = quantize(h * 1.1);
      const tx = ext.w / tileRes, ty = ext.h / tileRes;
      const cx = Math.round((minX + maxX) / 2 / tx) * tx;
      const cy = Math.round((minY + maxY) / 2 / ty) * ty;
      const zTop = maxZ + reach;

      const cam = this._cameras[i];
      cam.position.set(cx, cy, zTop).applyMatrix4(_rot);
      cam.quaternion.setFromRotationMatrix(_rot);
      cam.left = -ext.w / 2; cam.right = ext.w / 2;
      cam.top = ext.h / 2; cam.bottom = -ext.h / 2;
      cam.near = 0; cam.far = zTop - minZ + 2;
      cam.coordinateSystem = this.camera.coordinateSystem;
      cam._reversedDepth = this.camera.reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();

      this._viewports[i].set(i + inset, inset, 1 - 2 * inset, 1 - 2 * inset);
      this._updateMatrix(cam, this._matrices[i], this._frustums[i], this._viewports[i]);
      // far cascade: people, bins, bollards… (< 1.5 m) would cast 2-3 texel smudges
      this._frustums[i].minRadius = i === CASCADES - 1 ? Math.max(1.5, 3.5 * Math.max(tx, ty)) : 0;
      this._cascadeData[i].set((i + inset) / CASCADES, inset, (i + 1 - inset) / CASCADES, 1 - inset);
    }
  }
}

// ------------------------------------------------------------------ sky dome
const DOME_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = position;
    // rotation only (dome always centred on the camera), pushed to the far plane
    vec4 p = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
    gl_Position = vec4( p.xy, p.w * 0.99999, p.w );
  }`;

const DOME_FRAG = /* glsl */`
  uniform sampler2D mapA, mapB;
  uniform vec4 xfA, xfB;     // x: azimuth offset, y: warp target elevation, z: warp source elevation (rad)
  uniform vec3 colA, colB;   // radiance scale (irradiance-normalised) × tint
  uniform float mixAB;
  uniform vec3 sunDir;
  uniform vec4 sunDisk;      // rgb radiance, w = cos(angular radius)
  uniform vec3 hazeCol, hazeSunCol;
  uniform vec4 hazeParams;   // x: sun lobe exponent, y: horizon band scale (rad), z: band strength
  uniform vec3 groundCol;
  uniform vec3 glowCol;      // city light pollution
  varying vec3 vDir;

  const float PI = 3.141592653589793;
  const float HALF_PI = 1.5707963267948966;

  vec3 sampleSky( sampler2D map, vec3 d, vec4 xf ) {
    float e = asin( clamp( d.y, -1.0, 1.0 ) );
    if ( xf.y > 0.0 && e > 0.0 ) {
      e = e < xf.y ? e * xf.z / xf.y : xf.z + ( e - xf.y ) * ( HALF_PI - xf.z ) / ( HALF_PI - xf.y );
    }
    float a = atan( d.z, d.x ) + xf.x;
    vec2 uv = vec2( fract( a / ( 2.0 * PI ) + 0.5 ), e / PI + 0.5 );
    return texture2D( map, uv ).rgb;
  }

  void main() {
    vec3 d = normalize( vDir );
    float e = asin( clamp( d.y, -1.0, 1.0 ) );
    vec3 dh = normalize( vec3( d.x, max( d.y, 0.002 ), d.z ) );
    vec3 sky = mix( sampleSky( mapA, dh, xfA ) * colA, sampleSky( mapB, dh, xfB ) * colB, mixAB );
    sky += glowCol * ( exp( - max( e, 0.0 ) * 5.0 ) + 0.14 ); // light pollution: horizon glow + a veil over the whole sky
    float mu = max( dot( d, sunDir ), 0.0 );
    vec3 haze = hazeCol + hazeSunCol * pow( mu, max( hazeParams.x, 1.0 ) );
    float band = hazeParams.z * exp( - max( e, 0.0 ) / hazeParams.y );
    vec3 col = mix( sky, haze, clamp( band, 0.0, 1.0 ) );
    // below the horizon: whatever lies beyond the modelled world is kilometres
    // away and fully hazed; only steep downward directions (IBL) see the ground
    if ( e < 0.0 ) col = mix( haze, groundCol, smoothstep( 0.0, -0.4, e ) );
    #ifdef SHOW_SUN
      float c = dot( d, sunDir );
      if ( c > sunDisk.w && e > -0.01 ) {
        float r = clamp( sqrt( max( 0.0, 1.0 - c * c ) ) / sqrt( 1.0 - sunDisk.w * sunDisk.w ), 0.0, 1.0 );
        float limb = 1.0 - 0.55 * ( 1.0 - sqrt( max( 0.0, 1.0 - r * r ) ) ); // limb darkening
        col += sunDisk.rgb * limb * ( 1.0 - smoothstep( 0.85, 1.0, r ) );
      }
    #endif
    gl_FragColor = vec4( col, 1.0 );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

function domeUniforms() {
  return {
    mapA: { value: null }, mapB: { value: null },
    xfA: { value: new THREE.Vector4() }, xfB: { value: new THREE.Vector4() },
    colA: { value: new THREE.Vector3(1, 1, 1) }, colB: { value: new THREE.Vector3(1, 1, 1) },
    mixAB: { value: 0 },
    sunDir: { value: new THREE.Vector3(0, 1, 0) },
    sunDisk: { value: new THREE.Vector4(0, 0, 0, Math.cos(SUN_RADIUS)) },
    hazeCol: { value: new THREE.Vector3() }, hazeSunCol: { value: new THREE.Vector3() },
    hazeParams: { value: new THREE.Vector4(8, 0.06, 1, 0) },
    groundCol: { value: new THREE.Vector3() },
    glowCol: { value: new THREE.Vector3() },
  };
}

function makeDome(showSun) {
  const mat = new THREE.ShaderMaterial({
    uniforms: domeUniforms(),
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    defines: showSun ? { SHOW_SUN: '' } : {},
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1e6;
  mesh.name = showSun ? 'skyDome' : 'skyDomeEnv';
  return mesh;
}

// ------------------------------------------------------------------ environment
const _c = new THREE.Color();
const _v = new THREE.Vector3();

export class Environment {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.hour = 10.5;
    this.weather = 'cloudy';
    this.sunDir = new THREE.Vector3(0, 1, 0); // towards the sun (even when below the horizon)
    this.moonDir = compassDir(MOON.compass, MOON.elevation, new THREE.Vector3());
    this.keyDir = new THREE.Vector3(0, 1, 0); // direction of the active key light (sun or moon)
    this.sunElevation = 0;
    this.nightFactor = 0;
    this.wetness = 0; // reserved for rain (0 = dry)
    this.state = {}; // last computed lighting state (debug / other modules)

    installShaderPatches();

    // renderer: physically based tone mapping is owned here (post reads it)
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // hardware PCF; the kernel is ours (see SUN_SHADOW_GLSL)
    renderer.shadowMap.autoUpdate = false; // re-rendered once per frame in update(), reused by the PiP
    renderer.shadowMap.needsUpdate = true;

    // sky
    this.dome = makeDome(true);
    scene.add(this.dome);
    scene.background = null;
    this.envScene = new THREE.Scene();
    this.envDome = makeDome(false);
    this.envScene.add(this.envDome);
    this.fallbackSky = null;

    // image-based lighting from the dome (cube → PMREM, regenerated on change)
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envSize = 256;
    this._makeEnvTargets();
    this.envDirty = true;
    this.envTimer = 0;

    // key light: the sun by day, the moon at night
    this.sun = new SunLight(0xffffff, 3);
    this.sun.shadow = new CascadedSunShadow();
    this.sun.castShadow = true; // never toggled: that would recompile every material
    this.sun.shadow.bias = 0.9; // texels (see SUN_SHADOW_GLSL)
    this.sun.shadow.normalBias = 1.3; // texels
    this.sun.shadow.radius = 1.0; // minimum PCF radius, texels
    // lets code that looks for a DirectionalLight (post-fx sun flare) find it:
    // three's WebGLLights tests isSunLight first, so this changes nothing there
    this.sun.isDirectionalLight = true;
    this.sunTarget = new THREE.Object3D(); // SunLight shines towards the origin
    this.sun.target = this.sunTarget;
    scene.add(this.sunTarget);
    scene.add(this.sun);

    scene.fog = new THREE.FogExp2(0xaebdcc, 1.2e-4);

    // HDRI bookkeeping
    this.skies = {};
    this._requested = new Set();
    this.cloudDrift = new THREE.Vector2(6.5, 2.4); // m/s at cloud base

    this.setShadowMapSize(4096);
    this._prepareWeather(this.weather);
    this.setTime(this.hour);
  }

  // Prepare (sun-removed copies) and upload every HDRI a weather preset can
  // use, so dragging the time slider across dawn/dusk never stalls on a 16 MB upload.
  _prepareWeather(w) {
    const W = WEATHER[w];
    if (!W) return;
    for (const name of new Set([W.day, W.am, W.pm, W.night])) {
      const s = this._resolve(name);
      if (!s) continue;
      for (const t of [s.bg, s.env]) {
        try { this.renderer.initTexture(t); } catch { /* uploaded lazily on first use instead */ }
      }
    }
  }

  _makeEnvTargets() {
    if (this.cubeRT) this.cubeRT.dispose();
    if (this.pmremRT) this.pmremRT.dispose();
    this.cubeRT = new THREE.WebGLCubeRenderTarget(this.envSize, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(0.1, 100, this.cubeRT);
    this.pmremRT = null;
  }

  // Quality hook: the preset's shadowMap size (2048 low … 8192 ultra) sets the
  // per-cascade resolution (atlas = 3 × size/2), PCF taps and env-map size.
  setShadowMapSize(size) {
    const cascade = size >= 8192 ? 4096 : size >= 4096 ? 2048 : 1024;
    this.sun.shadow.mapSize.set(cascade, cascade);
    ATMO.sunShadowParams.x = size >= 8192 ? 16 : size >= 4096 ? 10 : 5;
    ATMO.sunShadowParams.z = size >= 4096 ? 5 : 3;
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    const envSize = size >= 4096 ? 256 : 128;
    if (envSize !== this.envSize) {
      this.envSize = envSize;
      this._makeEnvTargets();
      this.envDirty = true;
    }
    this.renderer.shadowMap.needsUpdate = true;
  }

  setWeather(w) {
    if (!WEATHER[w]) return;
    this.weather = w;
    this._prepareWeather(w);
    this.setTime(this.hour);
  }

  // ---------------------------------------------------------------- HDRIs
  // Prepared sky: background texture, IBL texture (sun/moon removed), info.
  _sky(name) {
    if (this.skies[name]) return this.skies[name];
    const info = hdriInfo(name);
    const orig = hdri(name);
    if (!orig || !info) {
      if (!this._requested.has(name)) {
        this._requested.add(name);
        loadHdri(name).then((t) => { if (t) { this.setTime(this.hour); } });
      }
      return null;
    }
    const noSun = info.hasSun ? hdri(name, { removeSun: true }) || orig : orig;
    for (const t of [orig, noSun]) {
      if (t.wrapS !== THREE.RepeatWrapping) { t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true; }
    }
    const isNight = name === 'hdri_night';
    const s = {
      name, info,
      // background: the photographed moon stays; the sun disk is drawn procedurally
      bg: isNight ? orig : noSun,
      env: noSun,
      az: Math.atan2(info.sunDir.z, info.sunDir.x),
      elev: Math.max(info.elevationDeg, 1) * DEG,
      skyE: Math.max(info.skyIntensity, 1e-4),
      horizon: info.horizonColor.clone(),
    };
    this.skies[name] = s;
    return s;
  }

  _resolve(name) {
    return this._sky(name) || this._sky(HDRI_FALLBACK[name]) || this._sky('hdri_day_cloudy') || this._sky('hdri_day_clear');
  }

  // ---------------------------------------------------------------- time of day
  setTime(hour) {
    this.hour = hour;
    const W = WEATHER[this.weather] || WEATHER.cloudy;
    const e = solarPosition(hour, this.sunDir);
    this.sunElevation = e;
    const morning = hour < SOLAR_NOON;
    this.nightFactor = 1 - smoothstep(-8, 4, e);

    // --- direct sun: air-mass transmittance per channel (turbidity scales the aerosol part)
    const m = airMass(e);
    const aer = (W.turbidity - 1) * 0.1;
    const tr = Math.exp(-m * (TAU[0] + aer)), tg = Math.exp(-m * (TAU[1] + aer)), tb = Math.exp(-m * (TAU[2] + aer * 1.1));
    const tmax = Math.max(tr, tg, tb, 1e-6);
    const sunColor = _c.setRGB(tr / tmax, tg / tmax, tb / tmax).clone();
    const sunE = SUN_E0 * luminance(tr, tg, tb) * smoothstep(-0.9, 0.7, e) * W.sun;

    // --- sky dome irradiance and moon
    const skyE = (skyIrradiance(e) + NIGHT_SKY_E) * W.sky;
    const moonUp = 1 - smoothstep(-12, -4, e);
    const moonE = MOON.irradiance * moonUp * W.moon;

    // --- key light (sun until it has set, then the moon)
    const useSun = e > -1.5;
    this.keyDir.copy(useSun ? this.sunDir : this.moonDir);
    this.sun.position.copy(this.keyDir).multiplyScalar(300);
    if (useSun) {
      this.sun.color.copy(sunColor);
      this.sun.intensity = sunE;
    } else {
      this.sun.color.copy(MOON.color);
      this.sun.intensity = moonE;
    }
    // overcast: no crisp shadows, the little direct light that is left is diffuse
    this.sun.shadow.intensity = lerp(1, 0.35, smoothstep(0.3, 0.05, W.sun));

    // --- which photographed skies (A → B blend)
    const golden = morning ? W.am : W.pm;
    let nA = W.day, nB = W.day, t = 0;
    if (e >= 18) { nA = nB = W.day; }
    else if (e >= 7) { nA = W.day; nB = golden; t = smoothstep(18, 7, e); }
    else if (e >= -3) { nA = nB = golden; }
    else if (e >= -11) { nA = golden; nB = W.night; t = smoothstep(-3, -11, e); }
    else { nA = nB = W.night; }
    const A = this._resolve(nA), B = this._resolve(nB);
    this.skyState = { a: A && A.name, b: B && B.name, t };

    // --- city light pollution (sodium/LED orange, much stronger under cloud)
    // (it only shows once the twilight has faded)
    const glowK = (1 - smoothstep(-11, -4, e)) * 0.022 * W.glow;
    // blue hour: sky shifts to deep blue, an orange afterglow hugs the horizon where the sun set
    const twilight = smoothstep(1.5, -2.5, e) * (1 - smoothstep(-7, -12, e));
    const glow = new THREE.Vector3(1.0, 0.56, 0.28).multiplyScalar(glowK);

    // --- haze / fog colours
    const hazeCol = new THREE.Vector3();
    const hazeSun = new THREE.Vector3();
    const sunAz = Math.atan2(this.sunDir.z, this.sunDir.x);
    const moonAz = Math.atan2(this.moonDir.z, this.moonDir.x);

    const setSlot = (u, slot, sky, which, wanted) => {
      // returns the radiance scale used for this slot
      const scale = skyE / sky.skyE;
      const isNight = sky.name === 'hdri_night';
      const isGolden = sky.name === 'hdri_sunset' || sky.name === 'hdri_dawn';
      const isOver = sky.name === 'hdri_overcast';
      const tint = new THREE.Vector3(1, 1, 1);
      // substitutes for missing optional HDRIs: push the colour where it should be
      if (wanted === 'hdri_night' && !isNight && !isOver) tint.set(0.3, 0.42, 1.0);
      if ((wanted === 'hdri_sunset' || wanted === 'hdri_dawn') && !isGolden) tint.set(1.25, 0.85, 0.6);
      if (!isOver) tint.multiply(_v.set(lerp(1, 0.72, twilight), lerp(1, 0.86, twilight), lerp(1, 1.3, twilight)));
      // moonlit night sky: keep a readable navy gradient (and a little more moonlit-sky fill)
      if (isNight) tint.multiply(_v.set(1.5, 1.7, 2.1));
      if (isOver) {
        // overcast by night: cloud base lit orange-grey by the city
        const n = this.nightFactor;
        tint.set(lerp(1, 0.9, n), lerp(1, 0.75, n), lerp(1, 0.62, n));
        // and a warm cast while the (hidden) sun is low
        const g = 1 - smoothstep(2, 14, e);
        tint.x *= 1 + 0.12 * g; tint.z *= 1 - 0.12 * g;
      }
      u[slot === 'A' ? 'mapA' : 'mapB'].value = which === 'env' ? sky.env : sky.bg;
      const xf = u[slot === 'A' ? 'xfA' : 'xfB'].value;
      if (isNight) {
        xf.set(sky.az - moonAz, 0, 0, 0);
      } else if (isOver) {
        xf.set(sky.az - sunAz, 0, 0, 0);
      } else {
        const lo = isGolden ? 2.5 : 12, hi = isGolden ? sky.elev / DEG : 70;
        const target = clamp(e, lo, Math.max(lo, hi)) * DEG;
        xf.set(sky.az - sunAz, target, sky.elev, 0);
      }
      u[slot === 'A' ? 'colA' : 'colB'].value.copy(tint).multiplyScalar(scale);
      return { scale, tint };
    };

    const diskVis = (sky) => (!sky ? 0 : sky.name === 'hdri_overcast' || sky.name === 'hdri_night' ? 0 : sky.name === 'hdri_day_clear' || sky.name === 'hdri_day_cloudy' ? 1 : 0.8);

    let sA = null, sB = null;
    if (A && B) {
      for (const [dome, which] of [[this.dome, 'bg'], [this.envDome, 'env']]) {
        const u = dome.material.uniforms;
        sA = setSlot(u, 'A', A, which, nA);
        sB = setSlot(u, 'B', B, which, nB);
        u.mixAB.value = t;
      }
      // horizon (haze) colour: the photographed horizon radiance, same scale
      const ha = A.horizon, hb = B.horizon;
      hazeCol.set(
        lerp(ha.r * sA.scale * sA.tint.x, hb.r * sB.scale * sB.tint.x, t),
        lerp(ha.g * sA.scale * sA.tint.y, hb.g * sB.scale * sB.tint.y, t),
        lerp(ha.b * sA.scale * sA.tint.z, hb.b * sB.scale * sB.tint.z, t),
      ).multiplyScalar(1.55); // the long low path over a city is brighter than the photo's 0-5° band

      this._useFallbackSky(false);
    } else {
      this._useFallbackSky(true);
      hazeCol.set(0.55, 0.6, 0.68).multiplyScalar(skyE * 0.35);
    }
    hazeCol.addScaledVector(glow, 0.9);

    // forward-scattering lobe towards the sun: strongest when the sun is low
    const low = 1 - smoothstep(3, 35, e);
    const lobe = sunE * (0.015 + 0.22 * low * low) * (this.weather === 'overcast' ? 0.2 : 1);
    hazeSun.set(sunColor.r, sunColor.g, sunColor.b).multiplyScalar(lobe);
    if (this.weather !== 'overcast') hazeSun.add(_v.set(1.0, 0.42, 0.17).multiplyScalar(1.1 * skyE * twilight));

    // ground seen below the horizon (and the lower hemisphere of the IBL)
    const groundE = sunE * Math.max(this.sunDir.y, 0) + skyE + moonE * Math.max(this.moonDir.y, 0) * (useSun ? 0 : 1);
    const ground = new THREE.Vector3(0.16, 0.15, 0.13).multiplyScalar(groundE / Math.PI).addScaledVector(glow, 0.6);

    const dv = (sky) => diskVis(sky);
    const disk = sunE / (Math.PI * SUN_RADIUS * SUN_RADIUS) * lerp(dv(A), dv(B), t);
    for (const dome of [this.dome, this.envDome]) {
      const u = dome.material.uniforms;
      u.sunDir.value.copy(this.sunDir);
      u.sunDisk.value.set(sunColor.r * disk, sunColor.g * disk, sunColor.b * disk, Math.cos(SUN_RADIUS));
      u.hazeCol.value.copy(hazeCol);
      u.hazeSunCol.value.copy(hazeSun);
      u.hazeParams.value.set(7, 0.045 + 0.03 * (W.k1 / 1.0e-4 - 1), 1.0, 0);
      u.groundCol.value.copy(ground);
      u.glowCol.value.copy(glow);
    }

    // --- fog (aerial perspective) — must agree with the dome's horizon band
    const fog = this.scene.fog;
    fog.color.setRGB(hazeCol.x, hazeCol.y, hazeCol.z);
    // evening/morning air carries more visible haze (and it glows against the low sun)
    fog.density = W.k1 * (1 + 0.7 * low + 0.6 * this.nightFactor);
    ATMO.fogParams.x = W.k2;
    // low morning mist that burns off by ~09:30, a little at night
    const mistAM = smoothstep(4.5, 5.8, hour) * (1 - smoothstep(7.2, 9.6, hour));
    const mistNight = this.nightFactor * 0.35;
    ATMO.fogParams.y = 0.0045 * W.mist * Math.max(mistAM, mistNight);
    ATMO.fogParams.z = 1 / 26;
    ATMO.fogParams.w = 7;
    ATMO.fogSunDir.x = this.sunDir.x; ATMO.fogSunDir.y = this.sunDir.y; ATMO.fogSunDir.z = this.sunDir.z;
    ATMO.fogSunColor.x = hazeSun.x; ATMO.fogSunColor.y = hazeSun.y; ATMO.fogSunColor.z = hazeSun.z;

    // --- cumulus shadows (partly cloudy only, fade out with the sun)
    // (cumulus pass 25-35 % of the beam: shade, not darkness)
    ATMO.cloudParams.w = W.clouds > 0 ? 0.7 * smoothstep(2, 12, e) : 0;
    ATMO.cloudParams2.x = 0.6 - W.clouds * 0.12; // 0.42 → ~30 % of the ground under cloud

    // --- exposure: a camera that mostly — not fully — adapts
    const clearTotal = SUN_E0 * luminance(Math.exp(-m * TAU[0]), Math.exp(-m * TAU[1]), Math.exp(-m * TAU[2])) * smoothstep(-0.9, 0.7, e) * Math.max(this.sunDir.y, 0) + skyIrradiance(e) + NIGHT_SKY_E;
    const total = sunE * Math.max(this.sunDir.y, 0) + skyE;
    let exposure = exposureFor(e);
    // dull weather: the camera opens up, but not all the way (overcast should still look grey)
    exposure *= clamp(Math.pow(clearTotal / Math.max(total, 1e-4), 0.45), 1, 1.7);
    this.renderer.toneMappingExposure = exposure;

    this.state = { hour, elevation: e, sunE, skyE, moonE, exposure, weather: this.weather, sky: this.skyState };
    this.envDirty = true;
    this.renderer.shadowMap.needsUpdate = true;
  }

  // three's procedural Sky as a last resort when no HDRI could be loaded
  _useFallbackSky(on) {
    if (on && !this.fallbackSky) {
      const mk = () => {
        const s = new Sky();
        s.scale.setScalar(900);
        const u = s.material.uniforms;
        u.turbidity.value = 3.2; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.0045; u.mieDirectionalG.value = 0.82;
        return s;
      };
      this.fallbackSky = mk();
      this.fallbackEnvSky = mk();
      this.scene.add(this.fallbackSky);
      this.envScene.add(this.fallbackEnvSky);
    }
    if (this.fallbackSky) {
      this.fallbackSky.visible = this.fallbackEnvSky.visible = on;
      this.dome.visible = this.envDome.visible = !on;
      if (on) {
        _v.copy(this.sunDir).multiplyScalar(1000);
        this.fallbackSky.material.uniforms.sunPosition.value.copy(_v);
        this.fallbackEnvSky.material.uniforms.sunPosition.value.copy(_v);
        this.fallbackSky.position.set(0, 0, 0);
      }
    }
  }

  _renderEnv() {
    const r = this.renderer;
    this.cubeCam.update(r, this.envScene);
    this.pmremRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT);
    this.scene.environment = this.pmremRT.texture;
    this.scene.environmentIntensity = 1;
  }

  update(dt, time) {
    // cumulus drift
    ATMO.cloudParams.x = (ATMO.cloudParams.x + this.cloudDrift.x * dt) % 16000;
    ATMO.cloudParams.y = (ATMO.cloudParams.y + this.cloudDrift.y * dt) % 16000;
    if (this.fallbackSky && this.fallbackSky.visible && this.fallbackSky.material.uniforms.time) {
      this.fallbackSky.material.uniforms.time.value = time;
    }
    // shadows: rendered once per frame by the first render call (main view)
    this.renderer.shadowMap.needsUpdate = true;
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      this._renderEnv();
      this.envDirty = false;
      this.envTimer = 0.2;
    }
  }
}
