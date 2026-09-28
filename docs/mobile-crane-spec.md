# AT-100 5.1: all-terrain mobile crane build spec (v1.0)

This spec adds a fictional 100 t, 5-axle all-terrain crane (the "AT-100 5.1") to the TC-6010 tower crane simulator at /Users/obhox/Projects/Crane. The player drives it in from the public road, sets it up (outriggers, mats, levelling, counterweight, RCL) and operates it (slew, luff, telescope, hoist). The stability physics is real, so a crane that is set up or configured wrongly tips over.

The main reference machine is the Liebherr LTM 1100-5.2, with the Tadano ATF 110G-5 and Grove GMK5120L as cross-checks. No real brand name may appear in game text.

## 0. Conventions and tags

**Units**
- SI throughout.
- Code uses kg, N, m, s and rad. The UI shows t, kN, m/min, deg and km/h.
- Chart arrays are in kg (gross: hook block and rigging included).

**Source tags**

| Tag | Meaning |
|---|---|
| [S1] | Liebherr LTM 1100-5.2 technical data, https://eng.bms.dk/media/sj1lz5tj/100-ton-liebherr-ltm1100-52.pdf |
| [S2] | LTM 1100-5.2 product guide, https://cdn.allcrane.com/sitefinity/docs/default-source/resources/product-guides/liebherr-ltm-1100-5.2-product.pdf (turning radius 10.18 m, tail swing 3.84 m, jack stroke 650/700 mm, all axles steered, 60 t at 12 t/axle) |
| [S3] | WASEL LTM 1100-5.2 sheet, https://www.wasel-krane.de/_Resources/Persistent/b/4/f/e/b4fedc75e83676e2f8dc2253abdeee20cfe751ac/WASEL-LTM-1100-52.pdf (pivot 3.71 m high and 2.00 m from the slew centre, boom box 0.90 x 1.06 m, max outrigger force 75 t, mats 1.75 x 1.00 m) |
| [S4] | FleetFile LTM 1100-5.2, https://www.fleetfile.com/crane/specifications/type_id=299 (carrier 11,443 mm, total 13,643 mm, outer/inner turning radius 11,470/6,200 mm, bases 7,361 x 7,000 / 5,000 mm) |
| [S5] | Liebherr 2008 LTM 1100-5.2 data sheet, https://en.liebherr-club.com/manual_download.php?id=1021 (retracted / 5 x 7.36 / 7 x 7.36 m bases, 700 mm ram) |
| [S6] | Tadano ATF 110G-5 spec, https://www.allterrainservices.com.au/wp-content/uploads/2016/12/Specifications_EM_4_ATF_110G_5_01A_2016_07.compressed.pdf (0 t CW road config at 10 t/axle, rope 250 m, rear steer active up to 25/50 km/h) |
| [S7] | Grove GMK5120L guide, https://www.realmachinery.fi/downloads/products/t/tk00718/01-gmk5120l-00february2025.pdf (gear speeds, reverse 6.4/7.8 km/h) |
| [S8] | ISO 7752-2:2011 and Add.1:1986 control layout, https://cdn.standards.iteh.ai/samples/54058/754120907c3249c89663d1552df318f4/ISO-7752-2-2011.pdf |
| [S9] | ISO 10245-1/-2 (RCL thresholds and blocked motions), https://cdn.standards.iteh.ai/samples/60618/39dd15e549034b17b04dede21222b087/ISO-10245-2-2014.pdf and https://www.dgcrane.com/wp-content/uploads/2023/09/ISO-10245-1-2021.pdf |
| [S10] | ISO 4305:2014 (1.25P + 0.1F, tipping angles 4.0°/4.5°, backward stability 15 %), https://cdn.standards.iteh.ai/samples/57220/7626f8f3af2e413d8eab4eaf8b1ebf0f/ISO-4305-2014.pdf |
| [S11] | ASME B30.5 (85/75 % of tipping, level 1 %), https://normfile.com/asme/ASME%20B30.5%202021.pdf |
| [S12] | EN 13000:2010+A1 (outrigger position monitoring, 1.2 m²/t wind area, bypass 15 % / 30 min), https://cdn.standards.iteh.ai/samples/37098/f96d287f65394825afe549120753cabe/SIST-EN-13000-2010-kFprA1-2013.pdf |
| [S13] | FEM 5.014 RCL modes, https://www.fem-eur.com/wp-content/uploads/2016/03/CLE-5014.pdf |
| [S14] | Liebherr LTM 1130 operator manual (LICCON colours, 90/100 %, reconfiguration only when utilisation is under 20 % and load is 0.5 t or less, level ±0.3°, horn semantics), https://www.taylorcrane.com/wp-content/uploads/2021/07/Liebherr-LTM-1130-operators-manual.pdf |
| [S15] | LTM 1055-3.1 load chart manual (slew speed under load, wind by boom length), https://www.surfcitycranes.com.au/wp-content/uploads/2019/07/LTM-1055-3.1-Load-Chart-Manual-8.pdf |
| [S16] | Liebherr wind brochure (v_max = v_chart·sqrt(1.2·m/A)), https://www.liebherr.com/shared/media/mobile-and-crawler-cranes/brochures/wind-influences/liebherr-influence-of-wind-p403-e04-2017.pdf |
| [S17] | Liebherr VarioBase brochure, https://www.liebherr.com/shared/media/mobile-and-crawler-cranes/brochures/variobase/liebherr-brochure-variobase-p-411-02-e08-2020.pdf |
| [S18] | CICA / QLD Code of Practice 2024 ground pressure table, https://cica.com.au/wp-content/uploads/2025/02/QLD-mobile-crane-code-of-practice-2024.pdf |
| [S19] | Incidents: https://cranepedia.com/news/crane-overturns-in-blanchardstown-construction-site-operators-narrow-escape/, https://vertikal.net/en/news/story/31309/crane-overturn, https://arlweb.msha.gov/fatals/2003/ftl03m19.htm |
| [S20] | Liebherr TELEMATIK explainer (pins at 0/46/92/100 %), https://www.liebherr.com/en-us/mobile-and-crawler-cranes/customer-magazine/simply-explained/telematik-4407587 |
| [S21] | Simulator KPIs: https://cm-labs.com/en/simulation-curriculum/intellia-rough-terrain-crane-simulation-curriculum/, https://www.simlog.com/wp-content/uploads/2016/11/MCR3-Advanced-Brochure-En.pdf |

**Evidence tags**
- [F] = fitted. A rigid-body model rated to ISO 4305 was fitted to all five LTM 1100-5.2 360° charts (483 cells, pivot geometry from [S3]). RMS error is 1.3 % at 35 t CW, 4.2 % at 26 t, 5.9 % at 15 t, 6.8 % at 11.5 t and 11.3 % at 0 t. It under-predicts mid-length booms at 0 t CW by up to 50 %: this crane is a weaker 0 t crane than the LTM.
- [D] = derived by calculation from sourced values.
- [E] = estimate; tunable.

**Coordinate frames (all code must follow these)**
- **World.** three.js, +y up. The site text calls −z "south": the public road is at z = −66.
  - Turns are described by target heading, never left/right in compass terms, because this naming is mirrored relative to geometric handedness.
- **Carrier frame C.** Origin at the slew axis, at ground level in road stance. x_c = forward, y_c = left (= up × forward), z_c = up.
  - In three.js object space of the carrier group: +X = forward, +Y = up, +Z = right = −y_c.
  - Carrier yaw φ = the group's rotation.y. φ = 0 means forward = world +x. φ = −π/2 means forward = world +z.
- **Superstructure frame S.** C rotated about z_c by slew ψ.
  - ψ = 0 is the boom over the front; +ψ slews toward the left (counter-clockwise seen from above, which is three.js rotation.y = ψ).
  - Coordinates are u (horizontal along the boom) and z (up).
  - Lever "slew right" drives ψ negative, the same convention as the tower's θ.
- **Luff angle.** θ = boom angle relative to the superstructure deck (frame-relative). θ_g = gravity-referenced angle, which is what the RCL angle sensor reads.
- **Radius.** R = horizontal distance from the slew axis to the head sheave (the hook), including deflection.
- **Displayed slew angle** = (−ψ in degrees) mod 360: 0 = over front, 90 = over right, 180 = over rear, 270 = over left. This is the same clockwise convention as the tower HUD.
- **Tilt.** The carrier plane is z = z0 + a·x_c + b·y_c. Pitch = atan(a) (nose up positive) is three.js rotation.z. Roll = atan(b) (left side up positive) is rotation.x. Euler order 'YZX', i.e. R = Ry(φ)·Rz(pitch)·Rx(roll).

## 1. Vehicle and crane specification

### 1.1 Carrier

| Item | Value | Tag |
|---|---|---|
| Name / class | AT-100 5.1, 100 t nominal (82.6 t at 3 m 360°, 100 t at 2.7 m over rear only), 5 axles | [S1] |
| Carrier length | 11.45 m (front bumper x_c = +7.75, rear end −3.70) | [S4] 11.443; [E] split |
| Overall length, road trim | 13.8 m (boom head nose at x_c = +10.10) | [S4] 13.64; [D] |
| Width / height | 2.75 m / 3.95 m | [S1] |
| Axle positions x_c | +5.60, +2.90, +1.27, −0.28, −1.85 m | [E]: spacing after [S1] drawing, big gap at the front to house the front outrigger box; tyres clear both boxes by at least 0.09 m |
| Tyres | 10 × 385/95 R25 (Ø 1.37 m, width 0.385 m); tyre-centre track ±1.18 m | [S1]; [D] |
| Drive | 10×6 (axles 2, 4, 5 driven), all axles steered | [S1] [S2] |
| Carrier engine | 400 kW, 2,516 N·m, 6-cyl; idle 600 rpm, rated 1,800 rpm | [S1]; rpm [E] |
| Gearbox | 12 fwd + 2 rev automated | [S1] |
| Max speed | 80 km/h | [S1] |
| Turning (outer front corner) | 10.18 m (all-wheel program), 11.47 m (road program) | [S2] [S4] |
| Crane engine (superstructure) | 129 kW, 4-cyl; idle 750, max 1,900 rpm | [S1]; rpm [E] |
| Road trim mass | 47.0 t = 46.7 t basic crane + 0.25 t hook ball; **0 t CW on the road**; CG x_c +1.35 → axle loads about 8.4 / 9.1 / 9.5 / 9.9 / 10.2 t | Basic mass [F]; 0 t CW road config after [S6]; loads [D] |
| Ride height | Frame datum 1.30 m above ground on tyres | [E] |

### 1.2 Superstructure and boom

| Item | Value | Tag |
|---|---|---|
| Slew ring top | z = 2.25 m | [E] |
| Boom foot pivot | u = −2.00, z = 3.71 m (behind the slew axis, so max radius ≈ L − 2) | [S3] |
| Boom | Base + 5 telescopic sections, single cylinder, pinned at 0 / 46 / 92 / 100 % of an 8.10 m stroke; L = 11.5 + 8.1·Σe_i, range 11.5–52.0 m | [S1] [S20]; stroke [D] |
| Pinned (charted) lengths | 11.5, 15.2, 19.0, 22.7, 26.4, 30.1, 33.9, 37.6, 41.3, 45.0, 48.8, 52.0 m (k = 0..10 steps of 3.726 m, then all sections to 100 %) | [S1] |
| Telescoping sequence | Outer-first round-robin: 46 % steps T5, T4, T3, T2, T1, then 92 % steps T5..T1, then 100 % T5..T1. Retract in reverse. | [F] (best chart fit) |
| Boom box | Base 0.90 × 1.06 m; each inner section 0.07 m smaller per side | [S3]; [E] |
| Boom mass | 10.1 t = 6 × 1.625 t sections (each section 11.3 m long) + head 0.35 t | [F] |
| Luff range | −1.0° to +82°; 0 → 82° in about 40 s unloaded | [S1]; −1° [E] (Tadano −2° [S6]) |
| Luff cylinder | Anchor A = (u +1.60, z 2.00); boom attachment B at 5.6 m along the boom and 0.6 m below its axis; cylinder speed 0.132 m/s gives 2.4°/s at 0°, 1.9°/s at 20–45°, 2.6°/s at 82° | [D] from [S1] 40 s |
| Telescoping | 11.5 → 52 m in about 355 s: net cylinder speed 0.13 m/s plus 4.0 s pin/unpin pause per step | [S1] 360 s; [S14] 3–5 s pause |
| Slewing | 0–2.0 rpm, slewing gear lockable / free | [S1] |
| Hoist | 0–130 m/min single line (top layer), line pull 88 kN, rope 21 mm × 250 m, EA 2.0e7 N | [S1]; rope length [S6]; EA [E] |
| Hook limit | Hook-block top at least 2.0 m below the head sheave | [S1] (about 3.6 m to hook) |
| Tail swing | 3.84 m; CW CG at u −3.18, z 2.45 m | [S2]; [F] |
| Crane cab | Left of the boom, eye at S (u +1.00, y +1.45, z 3.55); tilts 0–20° | [E] |
| Driver cab | Front left, eye at C (x +6.95, y +0.70, z 2.85) | [E] |

### 1.3 Masses and CGs (stability model, all [F]; heights above ground in road stance)

| Body | Mass | Position |
|---|---|---|
| Carrier (incl. outrigger boxes, beams, jacks) | 19,100 kg | C (x +1.84, y 0, z 1.55) |
| Upper (turntable, cab, winch, engine, hydraulics, CW frame) | 15,900 kg | S (u −0.63, z 2.60); radius of gyration 2.0 m [E] |
| Luffing cylinder | 1,600 kg | S (u −0.60, z 3.00) |
| Boom section i (i = 0 base … 5 tip section) | 1,625 kg each | Centre at pivot + (p_i + 5.65 m) along the boom axis, where p_i = 8.1·Σ_{k≤i} e_k (p_0 = 0) |
| Boom head | 350 kg | At the head |
| Counterweight (superstructure) | 0 / 11,500 / 23,500 / 35,000 kg | S (u −3.18, z 2.45) |
| Slabs lying on the carrier deck | Slab mass | C (x −3.18, y 0, z 1.85 + stack height/2) |

- Basic crane = 46.7 t. This is consistent with [S1]: 60 t road weight including 11.5 t CW and about 1.8 t jib.
- ISO 4310 head-referred boom mass F = m_boom·d_cg/L is 4.4–5.2 t.

### 1.4 Hook blocks and reeving (gross ratings, masses [S1])

| id | Sheaves | Falls | Rated (kg) | Block mass (kg) | Block height (m) [E] | Hook collider half-size (m) [E] |
|---|---|---|---|---|---|---|
| ball | 0 | 1 | 8,800 | 250 | 1.00 | 0.22, 0.50, 0.22 |
| hb26 | 1 | 3 | 26,100 | 450 | 1.60 | 0.30, 0.80, 0.30 |
| hb60 | 3 | 7 | 59,100 | 500 | 1.90 | 0.35, 0.95, 0.35 |
| hb90 | 5 | 10 | 90,200 | 700 | 2.20 | 0.40, 1.10, 0.40 |

- The crane arrives with the hook ball stowed on the front bumper.
- Re-reeving is a dialog available only when the block is grounded and no load is attached. It takes 45 s to go to or from 3 falls and 90 s to go to 7 or 10 falls [E]. The riggers do the work.
- Rope bookkeeping limits falls × height. With 250 m of rope, 10 falls cannot reach the ground at long booms; this is realistic.

### 1.5 Counterweight

| Config (on superstructure) | Make-up | Tag |
|---|---|---|
| 0 t | — (road trim) | [S6] |
| 11.5 t | Slab A 11.5 t | Total 35 t [S1]; split [E] |
| 23.5 t | A + slab B 12.0 t | [E] |
| 35.0 t | A + B + slab C 11.5 t | [S1] |

- Each slab is 2.60 m wide (across the carrier) × 1.25 m deep × about 0.47–0.49 m high.
- Slabs are delivered on a ballast truck. They are placed with the crane's own hook onto the carrier rear deck (x_c −3.18, deck top z 1.85; boom over the rear, R ≈ 3.2 m with 11.5 m boom). They are then raised into the CW frame by the ballasting cylinders. See §6.6.

### 1.6 Outriggers

| Item | Value | Tag |
|---|---|---|
| Float lines | Front x_c +4.58, rear −2.79 (longitudinal base 7.37 m) | [S1] drawing [D] |
| Beam positions (single-stage, hydraulic, detents) | 100 % → float at y ±3.50 (7.0 m base); 50 % → ±2.50 (5.0 m); 0 % → ±1.25 (2.5 m) | [S4] [S5] |
| Beam speed | 0.20 m/s; detent capture ±0.02 m | [E] |
| Jack stroke | Front 0.65 m, rear 0.70 m | [S2] |
| Jack geometry | J0 = 0.90 m from frame datum to pad bottom with jack retracted. The pad is then 0.40 m above ground on tyres. | [E] |
| Jack speed | Extend 0.06 m/s free / 0.04 m/s under load; retract 0.06 m/s | [E] |
| Float pad | 0.55 × 0.55 m, effective bearing area 0.242 m² (80 %) | Ops research (Liebherr worked example) |
| Mats carried | 4 × 1.75 × 1.00 × 0.12 m (1.75 m²) | [S3] |
| Mats as site stock (jobs) | Composite 1.80 × 1.80 × 0.10 m (3.24 m²) | [E] |
| Max float reaction (design) | 75 t | [S3]. The model gives 61.6 t at 82.6 t @ 3 m. |

## 2. Load charts

- **Definition (self-consistent).** Chart(cfg, L, R) = floor_0.1t( min(STRUCT(L,R), P_stab(cfg, L, R)) ). Cells under 0.5 t are blank.
  - STRUCT is the structural and hook-block envelope. It is identical to the LTM 1100-5.2 35 t full-base 360° chart [S1].
  - P_stab is the ISO 4305 rating [S10] of the §1.3 body model: min over slew 0..355° (5° step) and over all edges of the support rectangle of min((P_tip − 0.1F)/1.25, the 4° tipping-angle criterion).
- **Consequence.** The real static tipping load is at least 1.25 × chart + 0.1F in every direction. A correctly configured crane only tips through dynamics, wind, out-of-level operation or ground failure. A wrong configuration can tip it before the RCL cuts out.
- **Stability-governed cells.** A cell is stability-governed exactly when chart < STRUCT. The HUD shows these cells in italics or with an S marker.
- **Verification.** The JS generator in §2.2 reproduces every table below cell for cell. This was verified in node against the Python reference: 3,240 cells, 0 differences.

### 2.1 Data (src/mobile/charts.js), JS-ready, kg gross, rows = [R m, [one value per LENGTHS entry]]

```js
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
// B100_CW23500, B100_CW0, B50_CW23500, B50_CW0 are built at module load with buildChart() (section 2.2).
// Spot values for tests (kg): B100_CW23500: 22.7@14 = 18600, 30.1@24 = 7500, 45.0@36 = 3200, 33.9@28 = 5600.
//                             B100_CW0: 22.7@12 = 11300, 11.5@8 = 21800, 52.0@16 = 4500.
```

- **Over-rear option** (Phase 3, optional; needs the hb100 block: 7 sheaves, 14 falls, 1,240 kg [S1]). OVER_REAR_115 = [[2.7,100000],[3,94400],[3.5,86100],[4,77900],[4.5,71100],[5,65300],[6,55000],[7,47100],[8,40900],[9,35800]]. It is valid only with CW 35 t, full base, L = 11.5 m and slew within ±5° of 180° [S1]. The load stays inside the rear tipping line (x_c −2.79), so the value is structural and consistent with §4.

### 2.2 Generator (verified; src/mobile/charts.js)

```js
const STAB = { pivot:{u:-2.00,z:3.71}, floatX:{front:4.58,rear:-2.79}, carrier:{m:19.1,x:1.84,z:1.55},
  upper:{m:15.9,u:-0.63,z:2.60}, luffCyl:{m:1.6,u:-0.60,z:3.00}, cw:{u:-3.18,z:2.45},
  boom:{baseLen:11.5,secLen:11.3,stroke:8.1,nTele:5,secMass:[1.625,1.625,1.625,1.625,1.625,1.625],headMass:0.35} }; // tonnes, m
export function sectionExt(L){ const B=STAB.boom, step=B.stroke*0.46, e=new Array(B.nTele).fill(0), d=L-B.baseLen;
  if(d<=0) return e; const top=2*B.nTele*step;
  if(d<=top+1e-9){ const k=d/step, full=Math.floor(k/B.nTele), rem=k-full*B.nTele;
    for(let j=0;j<B.nTele;j++) e[B.nTele-1-j]=0.46*full+0.46*Math.min(1,Math.max(0,rem-j)); return e; }
  const r=(d-top)/(B.stroke*0.08); for(let j=0;j<B.nTele;j++) e[B.nTele-1-j]=0.92+0.08*Math.min(1,Math.max(0,r-j)); return e; }
export function boomMassCG(L){ const B=STAB.boom, e=sectionExt(L); let s=B.secMass[0]*B.secLen/2, pos=0;
  for(let i=1;i<=B.nTele;i++){ pos+=e[i-1]*B.stroke; s+=B.secMass[i]*(pos+B.secLen/2); }
  s+=B.headMass*L; const m=B.secMass.reduce((a,b)=>a+b,0)+B.headMass; return {m, d:s/m}; }
export function bodies(cwT,L,R,psi){ const S=STAB,c=Math.cos(psi),s=Math.sin(psi),bm=boomMassCG(L),dx=R-S.pivot.u,dz=Math.sqrt(Math.max(L*L-dx*dx,0));
  const rot=[[S.upper.m,S.upper.u,S.upper.z],[S.luffCyl.m,S.luffCyl.u,S.luffCyl.z],[bm.m,S.pivot.u+bm.d*dx/L,S.pivot.z+bm.d*dz/L],[cwT,S.cw.u,S.cw.z]];
  const list=[[S.carrier.m,S.carrier.x,0,S.carrier.z]]; for(const [m,u,z] of rot) list.push([m,u*c,u*s,z]);
  return {list, F:bm.m*bm.d/L, zHead:S.pivot.z+dz}; }
export function ratedStability(cwT,L,R,psi,poly,k1=1.25,tipDeg=4.0){ if(R-STAB.pivot.u>L) return 0;
  const {list,F,zHead}=bodies(cwT,L,R,psi), hx=R*Math.cos(psi), hy=R*Math.sin(psi), t=Math.tan(tipDeg*Math.PI/180); let best=Infinity;
  for(let i=0;i<poly.length;i++){ const [x1,y1]=poly[i],[x2,y2]=poly[(i+1)%poly.length], ex=x2-x1, ey=y2-y1, lg=Math.hypot(ex,ey), nx=ey/lg, ny=-ex/lg;
    const dist=(x,y)=>(x-x1)*nx+(y-y1)*ny, dh=dist(hx,hy); let Ms=0,Mz=0;
    for(const [m,x,y,z] of list){ Ms-=m*dist(x,y); Mz+=m*z; }
    if(Ms<=0) return -1; if(dh<=0) continue;
    best=Math.min(best,(Ms/dh-0.1*F)/k1,(Ms-t*Mz)/(dh+t*zHead)); }
  return best; }
export const rect=(halfW,xf=4.58,xr=-2.79)=>[[xr,-halfW],[xf,-halfW],[xf,halfW],[xr,halfW]]; // CCW, carrier frame
export function rated360(cwT,L,R,poly,k1,tipDeg){ let m=Infinity; for(let d=0;d<360;d+=5) m=Math.min(m,ratedStability(cwT,L,R,d*Math.PI/180,poly,k1,tipDeg)); return m; }
export function buildChart(STRUCT,cwKg,halfW){ return STRUCT.map(([R,row])=>[R,row.map((s,i)=>{ if(s===null) return null;
  const p=rated360(cwKg/1000,LENGTHS[i],R,rect(halfW)); const v=Math.floor(Math.min(s/1000,p)*10+1e-6)/10; return v<0.5?null:Math.round(v*1000); })]); }
```

### 2.3 Lookup and interpolation rules

1. **Chart key.**
   - On outriggers: `B${base}_CW${cwKg}`, with base ∈ {100, 50, 0} and cwKg ∈ {0, 11500, 23500, 35000}.
   - On tyres: `TYRES_CW0`.
   - The CW value must match exactly; no interpolation between CW configs.
2. **Permitted configs.** Computed with the ISO 4305 backward-stability rule [S10]: the boom-side supports must carry at least 15 % of the total with the shortest boom at 82°, no load, worst slew.

   | Base | CW | Boom-side share | Permitted |
   |---|---|---|---|
   | 100 % | 0 / 11.5 / 23.5 / 35 t | 41.4 / 32.2 / 25.8 / 21.4 % | yes |
   | 50 % | 0 / 11.5 / 23.5 / 35 t | 40.2 / 29.5 / 22.2 / 17.1 % | yes |
   | 0 % | 0 t | 30.3 % | yes |
   | 0 % | 11.5 t | 9.1 % | NOT PERMITTED |
   | 0 % | 23.5 or 35 t | tips unloaded | NOT PERMITTED |
   | Tyres | 0 t | tipping angle 10.6° | yes (boom ≤ 19.0 m) |
   | Tyres | 11.5 t | tipping angle 2.6° (< 4.5°) | NOT PERMITTED |

   Asymmetric beams: the config must use the smallest actual beam position (360° chart).
3. **Boom length.**
   - Pinned: the boom state machine reports the step index k (0..11) → column k.
   - Unpinned (between pins): cap = min(col(k_lower, R), col(k_upper, R), T_tel(L)). The RCL shows "TELE / NOT PINNED".
4. **Radius.** Linear interpolation between adjacent valued rows of the column. In every table the valued rows in a column are contiguous.
   - R < first valued row (Rmin): use the first value, and the RCL blocks luff-up (working range).
   - R > last valued row (Rmax): capacity 0 → RCL STOP.
5. **Reeving cap.** cap = min(chart, HOOK_BLOCKS[block].ratedKg).
6. **Utilisation.** Ratio = gross / cap. Gross = HoistSystem.tensionFiltered / g, which includes the hook block, rigging and load.
7. **Rmin (m)** by boom length: 11.5 → 3; 15.2 → 3.5; 19.0 → 3.5; 22.7 → 4; 26.4 → 4.5; 30.1 → 5; 33.9 → 6; 37.6 → 6; 41.3 → 7; 45.0 → 8; 48.8 → 9; 52.0 → 10.
   - This corresponds to a maximum working angle of 64–78°; the mechanical luff stop is 82°.
   - Head height at Rmin: 14.1 m (11.5 m boom) up to 54.3 m (52 m boom).
8. **Telescopable load T_tel(L)** (gross, both directions) [E]:
   - L ≤ 22.7 m: 12,000 kg
   - L ≤ 33.9 m: 8,000 kg
   - L ≤ 45.0 m: 5,000 kg
   - L > 45.0 m: 3,000 kg

   Liebherr rule: extend first, then load.
9. **Permissible wind** (3-s gust at the boom head) [E, following the [S15] pattern]:
   - L ≤ 22.7 m: 14.3 m/s
   - L ≤ 37.6 m: 12.8 m/s
   - L ≤ 48.8 m: 11.1 m/s
   - L = 52.0 m: 9.0 m/s

   For large-area loads, v_max_load = min(v_perm(L), v_perm(L)·sqrt(1.2·m_t / A_face)) [S16].
10. **Sector option** (Phase 3, "SMART BASE", [S17]-like). cap(ψ) = min(STRUCT, ratedStability(cw, L, R, ψ, actualPolygon)) computed live.
    - Slew is permitted toward ψ ± 2° only while cap(ψ ± 2°) ≥ gross. Slewing slows linearly over the last 5 % margin.
    - v1 ships 360° charts only.

## 3. Kinematics and drives (run at 120 Hz, like the tower)

### 3.1 Geometry

- **Head sheave in S:**
  - u_h = −2.00 + L·cosθ + δv·sinθ
  - z_h = 3.71 + L·sinθ − δv·cosθ + (z_f − 1.30)
  - y_h = δl (left positive)
  - z_f is the frame datum height at the slew axis (§4.3). The carrier frame origin is lifted by (z_f − 1.30).
- **World:** p = T_carrier · Ry(ψ) · [u_h, z_h, −y_h] in three.js local coordinates.
- **R** = horizontal distance of p from the world slew axis.
- **RCL measured angle** θ_g = θ + atan(a·cosψ + b·sinψ). RCL radius = horizontal(p) (includes deflection [S14]).
- **Anemometer** is at the head: its own 3-s filter, v_anem += (wind.speedAt(headY) − v_anem)·(1 − exp(−dt/1.2)).

### 3.2 Slew (same pattern as src/crane/crane.js)

- **Inertia** I = 15,900·(0.63² + 2.0²) + 1,600·0.6² + m_cw·(3.18² + 0.69) + Σ_boomSections m_i·(u_i² + (11.3·cosθ)²/12), in kg·m². Examples [D]:
  - 35 t CW, 52 m boom at R 30: 3.4e6 kg·m²
  - 35 t CW, 11.5 m boom: 5.1e5 kg·m²
- **External torque** ext = τ_rope + τ_tilt + τ_wind(opt) − 1.5e5·ψ̇ (viscous [E]).
  - τ_rope = (s × F_rope)_y, where s = head − slew-axis point and F_rope = T·n (n = unit head → hook).
  - τ_tilt = g·(Σ_rot m_j·u_j)·(a·sinψ − b·cosψ). Positive means increasing ψ.
- **Drive:** speed-controlled, target = −lever·ω_max·micro·perm, ω_max = 2.0 rpm = 0.2094 rad/s [S1].
  - need = I·(target − ψ̇)/1.2 − ext, clamped to ±250 kN·m [E].
  - Lever released: decelerate with 0.8·τ_max until |ψ̇| < 0.0006 rad/s, then a holding brake of 350 kN·m [E] (clunk event).
- **Free-slew toggle:** brake and drive released (slewing gear free [S1]).
- **Micro:** 10 %.
- **Recommended slew speed under load** [S15] (used for the KPI and a HUD hint):
  - L = 11.5: 0.8 rpm
  - L = 15.2: 0.65 rpm
  - L 19.0–30.1: 0.5 rpm
  - L ≥ 33.9: 0.3 rpm
- **Turntable lock pin:** engages only when |ψ| < 0.5° and |ψ̇| = 0. When pinned, slew perm = 0.

### 3.3 Luff (cylinder-driven)

- **Geometry:** c(θ) = |B(θ) − A|, where B(θ) = P + 5.6·(cosθ, sinθ) + 0.6·(sinθ, −cosθ), P = (−2.00, 3.71) and A = (1.60, 2.00) in S (u, z).
- **Rate:** θ̇ = v_cyl / c′(θ), with c′ by central difference.
- **Cylinder speed:**
  - v_cyl_max = 0.132 m/s [D]
  - Up: × clamp(1.10 − 0.60·u, 0.40, 1.0)
  - Down: × clamp(1.00 − 0.30·u, 0.60, 1.0)
  - u = RCL utilisation. [E: "slower under load"]
- v_cyl changes at ≤ 0.35 m/s² [E]. End damping scales the speed by max(0.15, dist/3°) within 3° of −1° or 82°. Micro 10 %.

### 3.4 Telescope (single-cylinder, pinned)

- **State:** ext[5] (T1..T5 ∈ [0, 1]), stepIndex k, phase ∈ {'pinned', 'moving', 'pinning'}, activeSection, pinTimer.
- **Sequence:** SEQ is the ordered list of (section, from, to) for extension: 0 → 0.46 for T5..T1, then 0.46 → 0.92 for T5..T1, then 0.92 → 1.0 for T5..T1. Retraction walks SEQ backwards.
- **Moving:** the active section's extension changes at 0.13 m/s × |lever| (tele lever, perm-scaled). L = 11.5 + 8.1·Σext.
- **Step end:** phase 'pinning' for 4.0 s (L frozen), then k ± 1 and phase 'pinned'.
  - Releasing the lever mid-stroke leaves the boom unpinned and held by the cylinder.
  - Releasing during 'pinning' still completes the pin.
- **Pinned lengths:** k = 0..10 → 11.5 + 3.726·k m; k = 11 → 52.0 m.
- **Telescoping with load:** perm teleOut = teleIn = 0 when gross > T_tel(L) ("TELE LOAD").
- **Rope coupling:** see §3.5. Extending by ΔL raises the hook by ΔL/n, which can two-block; retracting lowers it [S14].
- **Optional "Hold Z = ×4 time"** is allowed only with no suspended load; job time uses sim time.

### 3.5 Hoist, reeving and HoistSystem reuse

**Rope bookkeeping**
- The winch controls S_paid (rope paid out from the drum). Dead length dead(L) = L + 1.5 m (winch near the pivot).
- Fall length ℓ = (S_paid − dead(L))/n. This is passed to HoistSystem.step as ropeLenTarget (sheave to hook distance, same semantics as the tower).
- Hoisting up: dS_paid/dt = −v_line.

**Drum**
- 250 m of 21 mm rope, barrel 0.50 m, 30 wraps per layer [E].
- Layer capacities (m): 49.1, 53.1, 57.0, 61.0, 64.9 (cumulative 49.1 / 102.2 / 159.2 / 220.2 / 285.1).
- Rope on drum D = 250 − S_paid. The current layer k is the layer containing D. Pitch diameter PD_k = 0.50 + (2k − 1)·0.021 m.

**Line speed**
- v_line_max = (130/60)·(PD_k/0.689)·min(1, 44e3/F_line) m/s, with F_line = tensionFiltered/n.
- Rated 130 m/min on the top layer [S1]; constant-power knee [E].
- Hook speed = v_line/n. Hook acceleration 0.6 m/s², deceleration 0.8 m/s² [E].

**Winch relief (stall)**
- If F_line > 88 kN × 1.1, hoist-up speed = 0, the relief squeal plays and the HUD shows "HOIST OVERLOAD".
- This is the only protection if the reeving is entered wrongly.

**Limits**
- Hook limit: ℓ ≥ 2.0 + blockHeight (slow zone 3 m, same as the tower).
- Lowering limit: D ≥ 4.9 m (3 wraps) [S9].

**HoistSystem (src/physics/rope.js).** Add an options argument that keeps the tower behaviour identical by default:
```js
new HoistSystem(world, wind, { hookMass = CRANE.hookMass, ropeEA = CRANE.ropeEA, deadLength = null /* ()=>m; default ()=>this.radius+22 */, hookHalf = [0.26,0.5,0.26] } = {})
// ropeStiffness = n*n*ropeEA / (n*ropeLen + (deadLength ? deadLength() : this.radius + 22))
// new: setHookBlock({mass, half}) (only when no load is attached)
```
- Mobile: ropeEA 2.0e7, deadLength = () => L + 1.5.
- Hook-block visual: block top = hook + up·blockHeight, as main.js does now.
- **ROAD mode (stowed):** hoist.stowed = true. The hook is pinned to the bumper anchor C(+7.95, 0, 1.2) and hoist.step is skipped. Action 'hook' while stowed = "release block": it hangs from the head with ℓ = current distance.

### 3.6 Boom deflection [E, calibrated]

- **Vertical (luff plane):** δv̈ = ωv²·(δv_s − δv) − 2ζv·ωv·δv̇.
  - δv_s = F⊥·L³/(3·EIv), EIv = 1.7e9 N·m². F⊥ = rope-force component perpendicular to the boom in the luff plane (positive = bending down).
  - Calibration: 1.0 m tip deflection for 6 t at R 30 m on the 52 m boom. Gives 0.28 m for 12.8 t @ 20 m on 22.7 m, and 0.09 m for 40 t on 11.5 m.
  - ωv = sqrt(3·EIv/(L³·0.24·m_boom)), which gives a period of 1.6 s at 52 m. ζv = 0.03.
- **Lateral:** δl̈ = ωl²·(δl_s − δl) − 2ζl·ωl·δl̇ − 0.8·ψ̈·L.
  - δl_s = F_side·L³/(3·EIl), EIl = 1.0e9 N·m². ζl = 0.02.
  - Clamp δv to [−0.2, 2.5] m and δl to ±1.5 m.
- **Effect:** the head moves out by δv·sinθ, so a load swings away at lift-off and radius and utilisation grow; this happens automatically through the rope.
- **Side-pull warning:** if the rope's out-of-plane angle is > 3° while the load is grounded → "SIDE PULL" (KPI).

### 3.7 Boom contact

- Every step, sample points every 1.0 m from pivot to head. Radius is 0.55 m at the pivot, tapering to 0.35 m at the head.
- Test them against enabled world boxes (excluding the mobile's own boxes and attached loads; box extents inflated by the radius, point-in-OBB test in XZ plus y range).
- **On contact:** event 'boomContact' {tag, speed}. All crane motions stop. For 0.5 s after the contact clears, only lever directions opposite to the last motion are permitted. KPI −15.

## 4. Stability model (src/mobile/stability.js, pure functions, deterministic)

### 4.1 Forces (every step)

- **Body list** from §1.3 in world coordinates: carrier bodies transform with the carrier pose; rotating bodies with ψ, θ and the tele state; deck slabs are carrier bodies.
- **Load:** not a body. The rope force F_rope = tension·n acts at the head point. This captures swing, snatch and slack rope.
- **Optional (Phase 3):** wind on the boom, F = 0.5·ρ·1.6·v²·(0.9·L)·|sin(angle between wind and boom plane)| at mid-boom.
- **Centre of pressure in C.** For every force (vertical component W_k downward, horizontal H_k at height z_k):
  - X = Σ(W_k·x_k + H_x,k·z_k)/ΣW_k
  - Y = Σ(W_k·y_k + H_y,k·z_k)/ΣW_k
  - Here load = {W: ΣW_k, X, Y}.

### 4.2 Supports

- **Floats i ∈ {FL, FR, RL, RR}:**
  - x = +4.58 / −2.79; y = ±(1.25 + 2.25·ext_i); stiffness k = 1.
  - h_i = G_i + 0.90 + e_i, where G_i = ground height under the float + mat thickness − settlement_i.
- **Tyres (10):** x = axle positions, y = ±1.18, k = 0.3, h = ground(wheel) + 1.30 (suspension locked outside ROAD).
- **Optional ground compliance:** lower h_i by R_i,prev/k_g with k_g = 20 MN/m on mats (one-step lag). This gives a visible slight roll as loads shift.

### 4.3 Pose and reactions: reference implementation

Verified in node. For example, 35 t CW, 22.7 m boom, 12.8 t at 20 m:

| Slew | FL | FR | RL | RR |
|---|---|---|---|---|
| ψ = 0 | 34.5 | 34.5 | 12.7 | 12.7 |
| ψ = 90° (left) | 35.3 | 5.3 | 42.0 | 12.0 |
| ψ = 135° | 20.4 | 0.0 | 48.1 | 26.0 |
| ψ = 180° | 6.0 | 6.0 | 41.2 | 41.2 |

Values in t. A jack 5 cm short makes the crane rock onto the diagonal as it slews (tilt about 0.4°).

```js
// supports [{id,x,y,h,k}] (carrier frame, h = frame height that support imposes); load {W,X,Y}
export function solveSupport(supports, load, eps = 0.003) {
  const n = supports.length; let best = null;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const p = supports[i], q = supports[j], r = supports[k];
    const ux = q.x - p.x, uy = q.y - p.y, uz = q.h - p.h, vx = r.x - p.x, vy = r.y - p.y, vz = r.h - p.h;
    const nz = ux * vy - uy * vx; if (Math.abs(nz) < 1e-9) continue;
    const a = -(uy * vz - uz * vy) / nz, b = -(uz * vx - ux * vz) / nz, z0 = p.h - a * p.x - b * p.y;
    let ok = true; for (const s of supports) if (s.h > z0 + a * s.x + b * s.y + eps) { ok = false; break; }
    if (!ok) continue;
    const d = (q.y - r.y) * (p.x - r.x) + (r.x - q.x) * (p.y - r.y);
    const l1 = ((q.y - r.y) * (load.X - r.x) + (r.x - q.x) * (load.Y - r.y)) / d;
    const l2 = ((r.y - p.y) * (load.X - r.x) + (p.x - r.x) * (load.Y - r.y)) / d;
    if (l1 < -1e-9 || l2 < -1e-9 || 1 - l1 - l2 < -1e-9) continue;          // CoP must be inside this facet
    const zc = z0 + a * load.X + b * load.Y;
    if (!best || zc < best.zc - 1e-9) best = { zc, z0, a, b };              // lowest resting plane = upper-hull facet under CoP
  }
  if (!best) return { ok: false };                                         // CoP outside all support facets -> TIPPING
  const { z0, a, b } = best;
  let act = supports.filter((s) => z0 + a * s.x + b * s.y - s.h < eps);
  for (;;) { // equal-strain (plane) sharing with stiffness weights, drop tensile supports
    const S = [[0,0,0],[0,0,0],[0,0,0]];
    for (const s of act) { const v = [1, s.x, s.y]; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += s.k * v[r] * v[c]; }
    const c = solve3(S, [load.W, load.W * load.X, load.W * load.Y]);
    const R = act.map((s) => s.k * (c[0] + c[1] * s.x + c[2] * s.y));
    let mi = -1, mv = 0; R.forEach((v, i) => { if (v < mv) { mv = v; mi = i; } });
    if (mi < 0) { const out = {}; supports.forEach((s) => { out[s.id] = 0; }); act.forEach((s, i) => { out[s.id] = R[i]; });
      return { ok: true, plane: { z0, a, b }, active: act.map((s) => s.id), R: out }; }
    act = act.filter((_, i) => i !== mi); if (act.length < 3) return { ok: false };
  }
}
// solve3 = 3x3 Gauss-Jordan with partial pivoting. margin = signed distance (m) of CoP to the convex hull of all supports whose h is within 0.05 m of the plane (>0 inside).
```

- Cost: 14 supports → 364 triples, well under 0.1 ms at 120 Hz.
- **Outputs:** carrier pose z_f = z0, pitch = atan(a), roll = atan(b); float reactions (N); tyre contact flags; margin (m); CoP.

### 4.4 States and warnings

State progression: 'STABLE' → 'FLOAT_LIGHT' → 'LIFTOFF' → 'TIPPING' → 'OVERTURNED'.

| State or warning | Condition | Response |
|---|---|---|
| FLOAT_LIGHT | Any set float R < 20 kN while others carry load | HUD "OUTRIGGER LIGHT" + fast double beep |
| LIFTOFF | A float that was set now has plane − h > 2 mm | KPI −15; metal creak audio |
| TIPPING | solveSupport ok = false | Start §4.5 |
| TYRES NOT CLEAR | Mode 'outriggers' and any tyre active | Warning |

Stability readout for the HUD = margin (m) and "tip utilisation" = 1 − margin/margin_unloaded (info only; not an RCL function).

### 4.5 Tip-over dynamics (deterministic)

**Setup at trigger**
- Tipping edge = the hull edge of all supports that the CoP lies furthest beyond: pivot point p0 on the ground and unit axis e along the edge, oriented so positive φ tips outward.
- φ = 0, φ̇ = 0.
- The whole machine (carrier, superstructure, boom) rotates rigidly about (p0, e). Its render transform = T(p0)·R(e, φ)·T(−p0)·T_carrier.

**Equation of motion**
- I_e·φ̈ = g·Σ m_i·d_i(φ) + ((p_head(φ) − p0) × F_rope)·e − c·φ̇
- d_i(φ) = horizontal lever of body i beyond the edge after rotating by φ: d0_i·cosφ + h_i·sinφ.
- I_e = Σ m_i·|r_i⊥|² + m_boom·L²/12, evaluated once at the trigger.
- c = 0.02·I_e s⁻¹ [E].
- Semi-implicit Euler at 120 Hz.
- The HoistSystem keeps stepping with the rotated head as the sheave target. If the load lands, the rope goes slack and the crane can fall back.
- Model: W = 90.7 t, CG height 9.0 m, I_e ≈ 36,500 t·m² for 35 t CW and 52 m boom. τ = sqrt(I_e/(W·g·h)) ≈ 1.5–2.1 s [D].

**Recovery**
- If φ ≤ 0 with φ̇ < 0: set φ = 0, emit event 'slam' {speed = |φ̇|·arm} (thud, camera shake, KPI "near tip-over" −25), state = STABLE.
- Operators may still lower the hook, telescope in or luff up (RCL rules apply). ISO advice is to set the load down.

**Terminal**
- OVERTURNED when φ ≥ 60°, or head height ≤ 1 m, or the carrier's far float height > 3 m.
- Physics freezes except the hook and load, which keep falling. Crash audio plays. The job fails (grade F). A cinematic orbit camera runs.

### 4.6 Backward stability

- Handled by the physics: the CW-side edge is just another hull edge.
- Model reference values (unloaded, 11.5 m boom at 82°, worst slew), CoP margin in m:

  | Base | 0 t CW | 11.5 t | 23.5 t | 35 t |
  |---|---|---|---|---|
  | 100 % | — | — | — | +1.58 |
  | 50 % | — | — | — | +0.86 |
  | 0 % | +0.76 | +0.23 | −0.14 → tips backward unloaded | −0.39 → tips backward unloaded |
  | Tyres | +0.69 | +0.16 | — | — |

  This reproduces the short-rig backward overturn in [S19].
- Asymmetric trap: left beam 0 % and right 100 %, 35 t CW, 22.7 m boom at R 8, CW over the 0 % side. Static margin +0.04 m, so slew deceleration or wind tips it.

### 4.7 Level and inclinometer

- Tilt = (pitch, roll) from the pose. Display resolution 0.1° (accuracy ±0.1° [S12]).
- Tolerances:
  - OK: |tilt| ≤ 0.3° [S14]
  - Amber: > 0.3°
  - RCL warning triangle: > 0.57° (1 %) [S11]
- The physics effect is automatic: CGs shift horizontally by about z·tan(tilt), and the head radius grows by about z_head·sin(tilt). Reference: 52 m boom, 35 t CW, R 30 over the side; 1° costs 6 % and 3° costs 16 % of tipping load [D].
- **Auto-level** (hold key) [S2]:
  - z* = max( max_axles(ground_axle) + 1.30 + 0.10, max_i(G_i) + 0.90 + 0.02 ).
  - e_i* = z* − G_i − 0.90, driven at jack speed.
  - If any e_i* exceeds its stroke (0.65 front / 0.70 rear): "LEVEL RANGE EXCEEDED — use cribbing".
  - Requires all beams at a detent and the floats above their mat/ground.
  - Flat ground with carried mats: e* = 0.36 m.

### 4.8 Ground bearing, mats and sinking (src/mobile/ground.js)

**Bearing zones.** groundAt(x, z) → {kind, allowKPa, ultKPa = 2.5·allow [E]}. Allowable values from [S18]:

| Zone | Area | Allowable (kPa) |
|---|---|---|
| P1 prepared hardcore | x 50.5..63.5, z −19.5..−2.5 | 400 |
| Site default (compacted fill) | inside the fence | 200 |
| Asphalt road | carriageways | 200 |
| Lots / sidewalks / grass | — | 100 |
| Job zones | addZone(rect, props) / clearZones() | as defined |

**Pressure.** p_i = R_i/A_eff:
- pad only: A = 0.242 m²
- carried mat: A = 1.75 m²
- composite mat: A = 3.24 m²

Example: the worst float of 61.6 t → 345 kPa on a carried mat, 186 kPa on composite, 2.5 MPa on the bare pad.

**Settlement** (per float, permanent) [E]:
- p ≤ allow: rate 0.
- allow < p < ult: ṡ = 0.004·(p/allow − 1) m/s.
- p ≥ ult: punch-through, ṡ = 0.25 m/s until s ≥ 0.40 m or p < allow.
- Settlement lowers h_i, so the carrier tilts: RCL tilt warning, capacity loss and possible tip.
- KPI: max settlement > 20 mm → −5; > 50 mm → −15; punch-through → critical.

**Mat placement.** Only when the beam is at a detent and the float is not in contact. The mat auto-centres under the float and takes 4 s. Mat choice: carried × 4, composite if the job provides stock.

**Beam and float obstruction.** The float footprint (pad or mat) is an OBB tested against world boxes; on overlap the beam extension stops with "OBSTRUCTED". This is how job M6 forces 50 %.

### 4.9 Reference test values (scripts/test-mobile-stability.mjs)

Static tipping loads (t), full base:

| CW | Boom | R | Over front | Over side | Over rear | Rated 360° |
|---|---|---|---|---|---|---|
| 35 t | 52 m | 30 m | 12.4 | 9.9 | 8.8 | 6.6 |
| 11.5 t | 30.1 m | 22 / 23 / 24 m | — | — | 7.33 / 6.71 / 6.15 | — |

Other checks:
- 8.5 t over rear at 52 m / R 30 stands (margin 0.085 m); 9.5 t tips.
- M6 case, 11.5 t CW, 22.7 m boom, R 13.5 over the left: left 50 % → 13.2 t; left 0 % → 5.9 t; both 100 % → 20.4 t.
- Worst float, 82.6 t @ 3 m, 35 t CW: front 46.4 t, rear 61.6 t. Unloaded with 35 t CW: 31.1 / 36.2 t.

## 5. RCL / LMI (src/mobile/rcl.js)

**Config**
```js
{ mode:'outriggers'|'tyres', base:100|50|0, cwKg:0|11500|23500|35000, block:'ball'|'hb26'|'hb60'|'hb90', confirmed:bool }
```
- Short code shown, e.g. "OR B100 CW35.0 n1 BALL".
- **Power-on:** the config dialog opens pre-filled with the last config (possibly wrong). OK / ENTER confirms. Until confirmed, state 'noconfig' blocks all motions except lower and tele-in.
- **Changing the config** is allowed only when ratio < 0.20 AND gross ≤ 500 kg [S14]. Non-permitted configs (§2.3) are refused with "CONFIG NOT PERMITTED".

**Measured quantities**
- gross = tensionFiltered/g
- net = gross − configured block mass
- R and θ_g (§3.1), L and pinned state, head height, slew angle, wind (head anemometer)

**States and colours** [S14]:

| State | Condition | Colour |
|---|---|---|
| blue | ratio < 0.20 or gross < 500 kg | reconfigurable |
| ok | < 0.90 | green |
| warn | 0.90 ≤ ratio < 1.00 | yellow; intermittent beeper 0.18 s on / 0.35 s off |
| stop | ratio ≥ 1.00 | red; long horn; LMB STOP |

- STOP releases only when ratio < 0.98 AND all levers are neutral [S9].
- Horn is mutable after 5 s and re-arms on a new event.
- Thresholds are within ISO 10245-2 (warning 90–97.5 %, limiter 100–110 %) [S9].

**Permission matrix.** perm ∈ [0, 1] multiplies the lever. 1 = allowed, 0 = blocked.

| Condition | hoistUp | lower | luffUp | luffDown | teleOut | teleIn | slew |
|---|---|---|---|---|---|---|---|
| STOP (ratio ≥ 1) [S9] | 0 | 1 | 1 if load suspended, 0 if grounded | 0 | 0 | 1* | 1 (360° charts) |
| Gross > block rating | 0 | 1 | as STOP | 0 | 0 | 1* | 1 |
| Hook limit (anti-two-block) [S14] | 0 | 1 | 1 | 0 | 0 | 1 | 1 |
| Lowering limit (3 wraps) | 1 | 0 | 1 | 1 | 1 | 1 | 1 |
| R > Rmax(cfg, L) | capacity 0 → STOP | 1 | 1 | 0 | 0 | 1 | 1 |
| R < Rmin(L) | 1 | 1 | 0 | 1 | 1 | 1 | 1 |
| Luff stops | — | — | 0 at 82° | 0 at −1° | — | — | — |
| Tower zone (§5.1) | 1 | 1 | 0/scaled | 1 | 0/scaled | 1 | Blocked toward entering the zone above the ceiling (2° lookahead) |
| Road zone (hook, head and load z ≥ SITE.zoneLimitZ = −55, if the zoneLimiter setting is on) | As the tower Safety zone logic, applied to the head and load positions | | | | | | |
| gross > T_tel(L) | — | — | — | — | 0 | 0 | — |
| Not confirmed / power off / e-stop / mode ≠ CRANE | 0 | 0 (1 if confirmed but not configured) | 0 | 0 | 0 | 0 | 0 |
| Config not permitted | 0 | 1 | 1 | 0 | 0 | 1 | 1 |
| Turntable pinned | — | — | — | — | — | — | 0 |
| Emergency bypass (Ctrl+Shift+B, needs setting "allowBypass") [S12] | 0.15× on all motions; RCL ignored; hook limit and mechanical limits still active; auto-reset after 30 min sim time or engine stop; recorded as KPI critical | | | | | | |

\* tele-in is 0 if gross > T_tel.

Luff-up while the load is grounded is blocked because lifting a grounded load by luffing must not be permitted [S9].

**Monitored mismatches** (warnings only, never blocking [S12]):
- SUPPORT ≠ CONFIG: smallest actual beam detent < configured base, or any beam off-detent. Visual stays; audible can be muted.
- TILT > 0.57°.
- WIND > v_perm(L). Short horn [S14], no cut-off.
- TYRES NOT CLEAR.
- FLOAT LIGHT / LIFTED. This is a sim aid shown on the support-force page.

**NOT monitored (by design, as on real cranes [S12]):**
- Counterweight actually fitted: no plausibility check. This is the Blanchardstown case [S19].
- Number of falls actually reeved: only the winch relief protects.
- Mats and ground.

### 5.1 Working-range limiter

- **Tower-crane zone** [D from src/config.js: jib 60 m, jib bottom chord 45 + 2.2 = 47.2 m; 3 m clearance E]: while the horizontal distance of the head to the mast axis (0, 0) is < 63.0 m, head top height (head sheave + 0.6 m) ≤ 44.2 m.
  - Scale luffUp and teleOut by clamp((44.2 − headTop)/2.0, 0, 1).
  - Consequence: with ≥ 45 m boom on site, steep angles are capped. For example, a 45 m boom cannot work below R 17.6 m within the zone.
- **Slew toward the zone:** blocked if the head is above 44.2 m and outside the zone, moving toward it.

### 5.2 Counters and events

- Counters: lmiTrips (entries into STOP), twoBlockCount, warnTime, bypassUsed, configChanges, mismatchWarnTime, firstLiftSnapshot.
- Events: 'lmiTrip', 'upperLimit', 'configChanged', 'mismatch', 'bypass'.

## 6. Controls

### 6.1 Modes and input profiles

| Machine mode | input.profile |
|---|---|
| Tower | 'tower' (unchanged) |
| Mobile ROAD | 'mobile-drive' |
| Mobile SETUP | 'mobile-setup' |
| Mobile CRANE | 'mobile-crane' |

**Output shape**
```js
input.levers = {slew,trolley,hoist}                 // tower (unchanged)
input.levers = {slew, tele, luff, hoist}            // mobile-crane: slew +right, tele +out, luff +up, hoist +up
input.drive  = {throttle 0..1, brake 0..1, steer -1..1 (+right)}
input.setup  = {beam -1..1 (+extend), jack -1..1 (+extend = float down)}
```
- Zero-position interlock at power-on, as for the tower [S8, ISO 7752-1].

### 6.2 Crane controls: ISO 7752-2 cross-shift mapping [S8], Liebherr-like [S14]

| Function | ISO lever | Keyboard | Gamepad | Touch |
|---|---|---|---|---|
| Slew L/R | Left lever left/right | A / D | LS-X | Left stick X |
| Telescope out/in (selector on lever 1 fore/aft) | Left lever away = extend | W / S | LS-Y (up = out) | Left stick Y |
| Luff up/down | Right lever left = raise, right = lower | ← / → (and J / L) | RS-X (left = up) | Right stick X |
| Hoist up/down | Right lever back = raise | ↑ / ↓ (and I / K); the isoHoist setting inverts | RS-Y | Right stick Y |
| Micro (10 %) | — | Shift | LT | MICRO button |

**Other crane-mode keys**

| Key | Action |
|---|---|
| R | Hook on/off; release stowed block |
| H | Horn |
| P | Power |
| Space | E-stop |
| C | Camera |
| L | RCL config dialog |
| O | Reeving dialog |
| T | Turntable pin |
| F | Free slew |
| M | Mute RCL horn |
| Q / E | Tag line |
| V | Signaller |
| Enter | To SETUP |
| Tab | Switch machine (free play only) |
| Z | Hold for ×4 time (§3.4 rules) |
| Esc | Pause |

- Gamepad extras: A hook, B horn, X camera, Y power, Back e-stop, Start pause, LB/RB tag, D-pad up config, D-pad down SETUP, D-pad left pin, D-pad right free-slew.

### 6.3 Driving (mobile-drive)

| Key | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake |
| A / D, ← / → | Steer |
| X | Gear D ↔ R (only at standstill) |
| K | Steering program ROAD → ALL → CRAB |
| F | Parking brake |
| Shift | Crawl limiter 5 km/h |
| H | Horn |
| C | Camera |
| Enter | To SETUP (needs v = 0 and parking brake on) |
| Space | Engine stop |
| Tab, Esc | As above |

- Gamepad: LS-X steer, RT throttle, LT brake, A gear, LB program, RB crawl, Y parking brake, X camera, D-pad down SETUP.
- Touch: left stick X steer, right stick Y throttle/brake, plus buttons.

### 6.4 Setup (mobile-setup, a hand-held-remote-like terminal [S2])

| Key | Action |
|---|---|
| 1 / 2 / 3 / 4 | Select FL / FR / RL / RR |
| 5 | Select all |
| A / D (← / →) | Beam retract / extend (stops at detents 0/50/100 %; hold to pass a detent) |
| W / S (↑ / ↓) | Jack extend (float down) / retract |
| X | Cycle mat (none → carried → composite if available) |
| G (hold) | Auto-level |
| B (hold) | Ballast raise/lower (§6.6) |
| T | Turntable pin |
| Enter | To CRANE (enter cab) |
| Backspace | To ROAD (only if the §6.5 travel interlock is satisfied) |
| C, Z, Esc | As above |

- **Interlocks:** a beam cannot move while its float carries more than 5 kN ("RETRACT JACK FIRST"). Jacks and beams need the carrier engine running and the parking brake on.

### 6.5 Interlocks

- **Driving (ROAD)** is allowed only if all hold (else "TRAVEL INTERLOCK: <reason>"):
  - all beams at 0 % and all jacks fully retracted
  - turntable pinned at 0°
  - luff ≤ 1° and L = 11.5 m (boom on its rest)
  - hook block stowed
  - superstructure CW = 0 kg
  - no slabs on the deck
- **Crane motions** only in CRANE mode with power on. Vehicle drive is disabled in CRANE and SETUP (no lifting while driving and no pick-and-carry).
- **Tyres mode lifting** needs RCL config 'tyres', 0 t CW, L ≤ 19.0 m and no float in contact.

### 6.6 Flows

**Counterweight (after the [S14] Liebherr self-ballasting sequence, simplified)**
1. The RCL must be configured for the CW currently on the superstructure.
2. Pick slabs from the ballast truck (4-leg slings) and land them on the deck zone: carrier (x −3.18, y 0), boom over the rear, tolerance ±0.15 m and ±3°. Releasing there absorbs the Load into ballast.deckStack; the mesh moves to the deck and the mass becomes a carrier body.
3. Slew to 0°, press T to pin, hold B: the ballasting cylinders raise the stack in 45 s [E], and deckStack moves to superstructure CW. Hold B again to lower: this reverses (demobilisation).
4. Unpin and reconfigure the RCL.

- No ballast motion unless pinned [S14].
- Setting "quickBallast" (training): instant, with a time penalty of 120 s.

**Reeving:** O opens the dialog when the block is grounded and no load is attached. Choose ball / hb26 / hb60 / hb90; the timer runs (45 or 90 s); hoist.setHookBlock(); the RCL flags "REEVING CHANGED — CONFIRM CONFIG".

**Power / zero interlock:** as the tower (P with all levers neutral).

## 7. Driving model (src/mobile/vehicle.js)

**State:** pos (slew-axis point, world x/z), yaw φ, v (m/s, + forward), κ (1/m, + = left), gear, program, rpm, parkingBrake, wheelSteer[5] (rad per axle, centreline), wheelSpin.

**Kinematics (low-speed bicycle with an ICR reference point)**
- fwd = (cosφ, −sinφ) in (x, z).
- Reference point ref = pos + x_ref·fwd.
- Integrate: ref += v·dt·fwd; φ += v·κ·dt; then pos = ref − x_ref·fwd(φ). Keep pos continuous when x_ref changes.
- κ = −steer·κ_max(program, v), because steer + = right.
- CRAB: κ = 0 and the velocity direction is fwd rotated by −steer·15° (≤ 10 km/h).

**Steering programs** [D from S2/S4/S6]:

| Program | x_ref | κ_max | Front inner wheel | Axle 5 | Speed limit |
|---|---|---|---|---|---|
| ROAD, v ≤ 25 km/h | +1.27 (axle 3) | 1/8.09 m⁻¹ | 32.1° | −24° | — |
| ROAD, fading | Blend to x_ref −0.29 and κ_max 1/10.6 at 50 km/h (rear steer fades [S6]) | | | | — |
| ALL | +2.085 | 1/7.08 m⁻¹ | 30.8° | −33.7° | ≤ 20 km/h, else auto-switch to ROAD with a toast |

- ROAD at low speed gives an outer front-corner radius of 11.47 m [S4]. ALL gives 10.18 m [S2].
- Lateral limit |κ| ≤ 2.5/v² (high CG) [E].
- Steering rate: lock to lock in 3.0 s.
- Axle visual angle: δ_j = atan((x_j − x_ref)·κ), with Ackermann per side using y = ±1.18.

**Longitudinal**
- m = actual mass (47.0 t road trim).
- F_drive = throttle·min(340e3/max(|v|, 1), 0.7·0.6·m·g); 400 kW × 0.85 [S1]; 10×6 traction share 0.6 [E]. The driving force is zero for 0.4 s during each gear shift.
- F_res = m·g·C_rr + 0.5·1.225·8.0·v², with C_rr = 0.009 on asphalt and 0.025 on site [E].
- Brake: up to 4.5 m/s² [E]; coast retarder 0.3 m/s²; parking brake holds.
- Accelerations are clamped to 1.2 m/s² (traction and comfort).
- Check: 0 → 50 km/h in about 25 s; 0 → 80 in about 75 s [D].
- Reverse: max 8 km/h. Gear R speeds 6.5 / 8.0 km/h [S7].

**Gearbox (audio and HUD)**
- Top speed per gear at 1,800 rpm: 6.7, 8.5, 10.7, 13.5, 17.0, 21.4, 27.0, 34.0, 42.8, 54.0, 68.0, 80.0 km/h [E; first gear matches [S7] 6.4].
- Up-shift at 1,700 rpm, down-shift at 1,050 rpm.
- rpm = max(600, 1,800·|v|/v_top(gear)).

**Terrain**
- Wheel heights from terrain.heightAt(x, z): 0 on roads and site, 0.15 on sidewalks and lots.
- Carrier pose (y, pitch, roll) from a plane fit through the 10 wheel points.
- Kerb strike: a wheel's height changes ≥ 0.10 m within 0.2 s at |v| > 1.5 m/s (KPI −3). At > 4 m/s it is "hard" (−8).

**Collisions**
- The body OBB (centre x_c +2.025, half-length 5.725, half-width 1.375, y 0.3–3.95) plus the boom-nose box (x_c +7.75..+10.10, ±0.5, y 2.4–3.9) are tested with obbXZ against world boxes whose top > 0.35 m.
- The fence colliders are continuous across the gate, so the vehicle ignores the south perimeter box (tag 'fence', |cz − (−58)| < 0.2, hx > 30). It uses two segments instead: x −62..−34 and −26..66 at z −58.
- Response: push out along the normal. Impact speed > 0.5 m/s → v = 0 and 'collision' event (KPI −10). Otherwise slide along ("scrape", KPI −2 per contact).
- Traffic vehicles (§7.1): contact > 1 m/s is a critical 'trafficCollision'.

**Speed limits**
- Site (inside the fence): 10 km/h [E]. KPI for time above 11 km/h.
- Road: 50 km/h.
- Gate and wheel wash: advisory 5 km/h.

### 7.1 Streets API (additions)

- **Traffic obstacles:** `traffic.setObstacles([{x, z, hx, hz, yaw}])`. IDM vehicles treat any obstacle intersecting their lane corridor (lane centre ± 1.6 m) within 60 m ahead as a stopped leader at its near edge.
- **Traffic boxes:** `traffic.vehicleBoxes(qx, qz, r, out)` returns car OBBs.
- **Pedestrians:** `peds.setObstacles(list)`. Pedestrians within 1.5 m of an obstacle stop and wait.
- **No-parking zone:** add CRANE_APPROACH = {minX: −100, maxX: −20, minZ: −72, maxZ: −56} to `blocked()` in streets/common.js. No parked cars or furniture on either kerb along the approach.

## 8. Gameplay

### 8.1 Spawn and route (M1 / free-play "road" start)

- **Spawn:** slew-axis point (−82.0, −64.25) in the lane next to the site (road centre z = −66, LANE 1.75), yaw φ = 0 (heading +x), mode ROAD, engine running.
- **Route (ref-point corridor, 3.5 m wide, rendered as ground chevrons):**
  1. Move into the far lane and kerb strip at z ≈ −69.35 by x ≈ −40. Oncoming traffic queues via the obstacle API.
  2. With the ALL program, turn to heading +z around ICR (−37.08, −62.27), ending with the ref point at (−30.0, −62.3) and the crane straight.
     - Clearances: gate post 0.4 m; leaves about 1 m.
  3. Straight at x = −30 through the gate and the wheel wash. Wash walls are at x −31.7 and −28.3, leaving 0.32 m per side; scraping is allowed but costs KPI.
  4. From ref (−30, −43.1), turn to heading +x (ALL, ICR (−22.9, −43.1)) and run along z = −36.0. The mixer truck clears by 1.6 m and the drum by 1.0 m.
  5. At ref (48.9, −36.0), turn to heading +z (ROAD, ICR (48.9, −27.9)); the stack at (40, −31) is clear. Then straight along x = 57.0 until the slew axis is at P1.

### 8.2 Setup pad P1

- **Slew-axis target:** (57.0, −12.0), yaw −π/2 (forward = +z; left side = +x toward the east fence at x = 66). Tolerance ±0.5 m and ±5°.
- **Full-base float centres:** (60.5, −7.42), (53.5, −7.42), (60.5, −14.79), (53.5, −14.79). Carried mats stay at x ≤ 61.4.
- **Ground:** prepared hardcore, 400 kPa.
- **Distance to the mast** is 58.2 m, so the tower-zone ceiling of 44.2 m applies over the site. Nothing within 10 m of the carrier.
- **Reachable targets:**

  | Target | Position | R | ψ |
  |---|---|---|---|
  | Neighbour flat roof | x 87.5..100.5, z −19.9..−5.9, roof 16.4, parapet top 17.3 (from planCity(): "modern, 5 floors") | 36 m | +90° |
  | Building SE area | — | 13–20 m | — |
  | South-east laydown | — | 24–29 m | — |

- **Visual:** painted X and float squares. The collider world ground stays at y = 0.
- **Coexistence:** it does not clash with the tower jobs' areas (yard x −40..−14, barrel ring, corridor, lay-down B at (3, 55)).

### 8.3 Tower crane while the mobile is active

tower.park():
- Only if no load is attached; otherwise the switch is refused with "Land the load first".
- Trolley in to 3 m and hook to the upper limit (animated, ≤ 30 s), power off, freeSlew on (weathervanes; out of service).
- Its jib (≥ 47.2 m) cannot meet the mobile head, which is capped at 44.2 m. The tower mast box is a boom-contact obstacle.

### 8.4 Jobs (src/mobile/jobs.js, merged into JOBS with machine: 'mobile')

**New step kinds for jobs.js**

| Kind | Fields | Completes when |
|---|---|---|
| drive | target {x, z, yaw}, tol {pos, yawDeg} | Slew axis within tolerance, v = 0, parking brake on |
| setup | require {beams: [min detent per float], mats: bool, levelDeg: 0.3, tyresClear: bool} | All satisfied and ENTER pressed; stores a snapshot |
| ballast | cwKg | Superstructure CW reaches cwKg |
| reeve | block | Reeving changed to block |
| config | match: 'actual' | Confirmed config equals reality |

- Existing kinds: attach, deliver, path, hover.
- `def.events: [{t, run(J)}]` for timed spawns.
- `def.start` is a MobileStart (§9.2).

**Load definitions (src/loads.js)**

| Key | Mass (kg) | Size [x, y, z] (m) | Sling points | Sling (m) | cd | Wind limit (m/s) |
|---|---|---|---|---|---|---|
| testBlock5 | 5,000 | [1.6, 1.25, 1.0] | 4 at [±0.6, ±0.35] | 1.6 | — | 20 |
| hvac | 3,000 | [4.2, 2.1, 2.2] | 4 at [±1.9, ±0.95] | 3.2 | 1.2 | 9.0 [S16 formula] |
| generator | 11,500 | [6.0, 2.6, 2.3] | 4 at [±2.7, ±1.0] | 3.4 | — | 13 |
| precast | 4,200 | [4.0, 2.1, 0.2] | 2 at [±1.2, 0] | 2.4 | — | 11 |
| steelBundle | 6,000 | [8.0, 0.6, 1.0] | 2 at [±2.6, 0] | 3.6 | — | 17 |
| transformer | 7,500 | [2.4, 2.2, 1.6] | 4 at [±1.0, ±0.6] | 2.0 | — | 14 |
| cwA | 11,500 | [2.6, 0.47, 1.25] | 4 at [±1.0, ±0.45] | 1.8 | — | 20 |
| cwB | 12,000 | [2.6, 0.49, 1.25] | 4 at [±1.0, ±0.45] | 1.8 | — | 20 |
| cwC | 11,500 | [2.6, 0.47, 1.25] | 4 at [±1.0, ±0.45] | 1.8 | — | 20 |

| Job | Start | Steps and targets | Design numbers | Par |
|---|---|---|---|---|
| **M1 Mobilise & Set Up** | Road spawn, 0 t CW, ball | drive P1 → setup (all 100 %, carried mats, ≤ 0.3°, tyres clear) → config → attach testBlock5 at (47.5, −8.0) (R 10.3) → test lift → deliver (48.5, −20.0) (R 11.7), 22.7 m boom | B100_CW0 22.7 @ 12 = 11.3 t; gross 5.25 t → 46 % | 540 s |
| **M2 Rooftop Plant** | At P1, set up, 23.5 t on superstructure, RCL 23.5, ball, L 11.5. Ballast truck at (50.0, −12.0) along z carrying cwC at (50.0, −8.5, bed 1.40). HVAC truck at (44.0, −25.0) along z. | lift cwC onto deck (R 5.5, 11.5 m boom) → ballast 35,000 → config → telescope to 45.0 m → attach hvac (R 18.4) → deliver to roof curb (93.0, 16.7, −13.0), yaw 0 ±5°, tol 0.4 m, clearY 19.5 | 45 m @ 36: 35 t → 4.8 t (68 % for 3.25 t gross); 23.5 t → 3.2 t (STOP). A 41.3 m boom fouls the parapet (boom axis 17.6 m vs parapet 17.3 m), so the player must plan ≥ 45 m. Pick at R ≥ 17.6 because of the tower-zone ceiling. Job adds the roof slab collider (top 16.4), 4 parapet boxes (0.25 × 0.9 m) and a 0.3 m curb, derived at runtime from planCity() (parcel containing (94, −13)); fallback: job-owned box. | 900 s |
| **M3 Generator Set** | At P1, 23.5 t, RCL 23.5, ball, L 22.7. Low-loader at (46.0, −24.5) (bed 0.9 m). | reeve hb26 → config → attach generator at (46.0, −23.0) (R 15.6, ψ −135°) → test lift → deliver plinth (46.5, 0.3 top, −4.0) (R 13.2, ψ −53°), yaw ±5°, tol 0.3 m | Gross 11.95 t: 23.5 t CW @ R 15.6 → 15.9 t (75 %); 11.5 t CW → 11.4 t (105 % STOP); 1 fall 8.8 t is insufficient | 600 s |
| **M4 Precast Delivery** | At P1, 23.5 t, ball, L 22.7; wind 5 m/s, gust 0.7. A-frame trailer at (44.0, −25.0) with 3 precast panels upright. | ×3: attach (R about 18.4) → deliver into rack slots at (50.0 + 0/0.5/1.0, 0, −40.0), yaw 0 ±4°, tol 0.25 m (R 28.9, ψ ≈ −166°); tag lines | Needs ≥ 33.9 m boom (30.1 max R 28). 33.9 @ 28.9, 23.5 t → 5.3 t (84 %). KPI: slew overspeed > 0.3 rpm with load; wind limit 11 m/s | 780 s |
| **M5 Ballast Check (trap)** | At P1, actual 11.5 t CW, RCL pre-filled 35 t (left by the "previous shift"), ball, L 30.1. Flatbed with steelBundle at (46.0, −20.0) (R 13.6). At t = 90 s the ballast truck with cwB arrives at (50.0, −12.0). | attach → deliver laydown C (57.0, 0, −36.0) (R 24, over the rear) | Real P_tip over rear 6.15 t at R 24 (7.33 at R 22) vs gross 6.25 t → tips at R ≈ 23.8. The wrong RCL shows 64 % (9.7 t chart). Correct path: set the config to 11.5 t (STOP at about R 20.7), install cwB → 23.5 t (7.5 t → 83 %). KPI: config matched reality at first lift. | 780 s |
| **M6 Substation Transformer (short rig)** | P1 in ROAD stance at the pad, 11.5 t CW mounted (site travel exception flag), ball, L 11.5. Job barriers Box(60.9, 0.5, z, 0.5, 0.5, 1.5) at z −16.5 / −13.5 / −10.5 / −7.5 block the left beams at 100 %. Truck at (46.0, −12.0). | setup (left 50 %, right 100 %) → config B50 → L 22.7 → attach transformer (R 11, ψ −90°) → deliver onto neighbour substation plinth (70.5, 0.6 top, −12.0) over the hoarding (R 13.5, ψ +90°), clearY 3.5 | B50_CW11500 22.7 @ 13.5 = 10.3 t → 75 % for 7.75 t. Left left at 0 % with RCL set to 100 % → P_tip 5.9 t < 7.75 t → tips while slewing past about 60° left; mismatch warning shown. | 720 s |

### 8.5 KPIs and scoring (100 − deductions, same results UI; best score key 'tcsim.best.' + id)

**Existing KPIs (tower rules)**
- Time over par: −1 per 5 s, max −20
- Max sway
- Collisions: −8
- Rough landings: −5
- Anti-two-block: −5
- RCL trips: −10
- Horn before first motion: −5
- Test lift: −5
- Placement accuracy
- Wind exposure

**Drive KPIs**

| KPI | Deduction |
|---|---|
| Collision | −10 |
| Scrape | −2 |
| Kerb strike | −3 / hard −8 |
| Site speeding | −1 per s above 11 km/h, max −15 |
| Traffic collision | CRITICAL |
| Pad error | Position > 0.5 m or yaw > 5° → step not complete |

**Setup KPIs** (snapshot at the first lift-off: the load goes from grounded to suspended for the first time)

| KPI | Deduction |
|---|---|
| Beam not at a detent | −10 each |
| Missing mat | −5 each |
| Level > 0.3° | −5 |
| Level > 0.57° | −15 |
| Tyres not clear | −10 |
| Floats not all set | −10 |
| Config exact | 0 |
| Config conservative mismatch | −5 |
| Config unconservative (configured base or CW > actual) | −30 and flag CRITICAL-RISK |
| Reeving mismatch | −10 |
| Mismatch warning active > 5 s | −10 |

**Operation KPIs**

| KPI | Deduction |
|---|---|
| Slew overspeed with gross > 25 % of capacity | −1 per 2 s, max −10 |
| Side pull | −5 |
| Boom contact | −15 |
| Outrigger light | −5 |
| Float lift-off | −15 |
| Near tip-over (slam) | −25 |
| Settlement > 20 mm / > 50 mm | −5 / −15 |
| Time in RCL warn > 30 s | info |
| Bypass | −30 CRITICAL |

- **Critical → grade F, job ends:** overturned, punch-through ≥ 0.3 m, traffic collision, bypass.
- The results list shows a setup checklist (✓/✗) as its own block.

### 8.6 Machine switching

- **Main menu:** "Machine: Tower TC-6010 | Mobile AT-100 5.1" (setting `machine`) chooses the free-play machine. The job list is grouped by machine; starting a job activates its machine.
- **In play (free play only):** Tab switches, which requires the current hook to have no suspended load.
- **Both machines always exist in the world.** The inactive one is parked but its physics keeps stepping with zero input.
- **Settings:**
  - mobileStart 'pad' | 'road' (default 'pad': 35 t, full base, mats, level, ball, L 22.7)
  - siteSpeedLimit (10)
  - quickBallast (false)
  - allowBypass (false)
  - timeWarp key enabled (true)

### 8.7 Cameras (per machine and mode; C cycles)

| Camera | Mount | Available in |
|---|---|---|
| cab | Crane cab eye, S (+1.0, +1.45, 3.55); rotates with slew; drag look, autoLook like the tower; cab tilt 0–20° | CRANE |
| driver | Driver eye, C (+6.95, +0.70, 2.85) | ROAD, SETUP |
| chase | Behind and above the carrier: 16 m back, 7 m up, smoothed, looking 4 m ahead | ROAD, SETUP |
| setup | Ground, 1.7 m eye, 6 m diagonal from the selected float | SETUP (default there), CRANE |
| hook | Gimballed at the head, looking down; PIP monitor as the tower | CRANE |
| ground | Signaller logic as now, focus on the load | CRANE |
| orbit | Existing; target crane or hook | All modes |

- On OVERTURNED: a scripted cinematic orbit.

### 8.8 HUD (new src/hudMobile.js, hosted by hud.js via setMachine)

**ROAD**
- Speed (km/h) with a limit roundel (10 on site / 50 road)
- Gear (D1..D12 / N / R1..R2) and rpm
- Steering program icon
- Parking brake
- Travel-interlock message
- Guidance: distance to P1 and the next manoeuvre text

**SETUP (hand-held-remote page)**
- Carrier top view with 4 beams: %, detent lamp, OBSTRUCTED
- Jack stroke (mm / max)
- Per float: contact, force (t), pressure (kPa) vs allowable (green / amber / red), mat icon
- Selected float
- Level bubble: pitch and roll in 0.1° with a ±0.3° ring
- Tyres-clear lamp
- Auto-level status
- Turntable pin
- CW: on superstructure, deck stack, raise progress

**CRANE (RCL page)**
- Short code and state colour bar (blue / green / yellow / red), gross and net vs cap (t), utilisation %
- R (incl. deflection), θ_g, L with 5 section % digits and PIN/TELE, head and hook height
- Slew angle and sector label (FRONT / REAR / LEFT / RIGHT)
- Wind: head, 3-s gust vs v_perm(L), and v_max for the attached load
- Hoist speed (m/min), line pull (kN / 88), falls and block
- Recommended slew speed vs actual
- STOP icons: LMB, hook limit, working range, tele load
- Warning triangles: support ≠ config, tilt, wind, tyres
- Mini chart: the current L column with an R marker; S-marked cells are stability-governed
- Side-view working-range sketch with the 44.2 m ceiling line inside the tower zone
- Optional support-force bars

**Other HUD content**
- Dialogs: RCL config, reeving, ballast.
- The same content is drawn at 4 Hz to the crane-cab screen canvas.
- Job checklist panel for setup steps.

### 8.9 Audio (src/audio.js additions; WebAudio synthesis like the rest)

**Engines**
- Carrier engine, 6-cyl: firing f0 = rpm/60·3. PeriodicWave harmonics 1–6 [1, .6, .45, .3, .2, .15]. Low-passed noise gain ∝ load. Turbo whistle ∝ rpm²·load. Retarder whoosh.
- Crane engine, 4-cyl: f0 = rpm/60·2. rpm = 750 + 1,150·max|lever|·(0.5 + 0.5·demand), ramp 0.8 s (engine speed follows lever deflection [S14]).

**Hydraulics**
- Pump whine sine at rpm/60·9, gain ∝ flow demand.
- Relief squeal (band noise at 2.4 kHz plus a 1.1 kHz sine) when a drive is stalled or blocked with the lever deflected.

**Outriggers**
- Beam slide (band noise 300–900 Hz ∝ speed).
- Detent and end clunks (clunk()); jack hiss/groan; float touchdown thud (impact()).

**Warnings**
- RCL warn beeper (existing pattern); RCL STOP long horn (continuous until neutral; mute M after 5 s).
- Float-light fast double beep; short horn every 5 s for tilt / wind / support mismatch.
- Reverse alarm (1 kHz, 0.5 s on/off).
- Air-brake psst; turntable-pin clunk; creak when a float lifts; crash on overturn.

**Mix per camera:** cab: crane engine 0.8, hydraulics 1, carrier engine 0.2; driver: carrier engine 1; chase/orbit 0.6; ground 0.4.

### 8.10 Free play (mobile)

- Start per mobileStart.
- Extra loads near P1: testBlock5 at (47.5, −8.0), precast × 2 at (44.0, −25.0) on a trailer, generator on the low-loader.
- The ballast truck with cwA/cwB/cwC is at (50.0, −12.0) when mobileStart = 'road'.

## 9. Architecture and implementation plan

### 9.1 Machine interface (src/machines/machine.js, JSDoc contract; frozen after Phase 0)

```js
/** @interface Machine
 * id:'tower'|'mobile'; label; root:THREE.Object3D; hoist:HoistSystem; power:boolean
 * inputProfile(): 'tower'|'mobile-drive'|'mobile-setup'|'mobile-crane'
 * cameraModes(): string[]                  // cycle list for the current state
 * cameraRig(): { cab:{parent,headPos,baseYaw}, driver?, hook:{parent}, chaseTarget(out,dt), focus(out) }
 * colliders: Box[]                          // owned boxes, kept in world by main; updated in step()
 * counters: { twoBlockCount, lmiTrips }     // used by jobs (existing KPIs)
 * hoistSpeed: number                        // m/s, + up (for test-lift detection)
 * reset(start)                              // tower: {slew,trolley,ropeLen,attach}; mobile: MobileStart
 * park(); activate()
 * handleAction(action, api) -> boolean      // api = {toast, loads, world, audio, spawnLoad, removeLoad}
 * step(dt, input)                           // 120 Hz; input zeroed when inactive/paused
 * updateVisuals(dt, t, night)
 * onRelease(load) -> boolean                // true = absorbed (ballast slab)
 * hudState() -> object                      // common fields (payload, capacity, ratio, lmiState, radius, hookHeight, slewDeg, wind, power, eStop, levers, cameraName...) + machine:'tower'|'mobile' + mobile:{...§8.8}
 * audioState(cameraMode) -> object
 * signallerGeometry() -> { cx, cz, radialOut:'Trolley out'|'Boom down', radialIn:'Trolley in'|'Boom up' }
 */
/** MobileStart = { mode:'ROAD'|'SETUP'|'CRANE', pos:{x,z}, yaw, beams:[4 x 0|0.5|1], jacksSet:bool, mats:[4 x 'none'|'carried'|'composite'],
 *   levelled:bool, cwKg, deckSlabs:[], rcl:{mode,base,cwKg,block,confirmed}, block, boomK (0..11), luffDeg, slewDeg, ropeLen, attach, siteTravel:bool } */
```

### 9.2 main.js as host

- `machines = { tower: new TowerMachine(ctx), mobile: new MobileMachine(ctx) }`, where ctx = {scene, world, wind, terrain, streets, audio, hud, settings, site, loads}.
- `sim.machine` = the active machine (jobs use it). Keep sim.crane/hoist/safety getters for the tower for back-compatibility during migration.
- **stepPhysics:** for each machine, `m.step(dt, m === active && state === 'play' ? input : NULL_INPUT)`, then wind.update.
- **Generic actions:** 'hook' uses active.hoist, findAttachable and canRelease, with the release path calling active.onRelease then jobs.onRelease. 'camera', 'pause' and 'switchMachine' are generic. Everything else goes to active.handleAction.
- **Rope and sling rendering** moves to src/machines/ropeRender.js (RopeRenderer.update(hoist, fallsTopPoints[], blockTop, load)), used by both machines.
- **Other per-frame calls:**
  - hud.update(active.hudState())
  - cameras.update(dt, active)
  - audio.update(dt, tower.audioState(...)) and audio.updateMobile(dt, mobile.audioState(...)), with inactive mixes at idle or 0
  - streets obstacle feed: `traffic.setObstacles(mobile.vehicleObstacles())`

### 9.3 Reused modules

**Unchanged**
- src/physics/collide.js (ColliderWorld, Box, obbXZ)
- src/physics/wind.js (speedAt, velocityAt)
- src/crane/* (wrapped by TowerMachine)
- src/world/terrain.js (heightAt)
- src/world/buildings/planner.js (planCity, read-only)
- src/crane/kit.js helpers and createCraneMaterials (read-only imports for the mobile model)

**Extended, backward compatible**
- rope.js (options)
- jobs.js (machine-aware and new step kinds)
- signaller.js (geometry arg; a legacy call without cx means the tower)
- input.js (profiles)
- cameras.js (attach(rig), new modes)
- hud.js (setMachine)
- audio.js (updateMobile)
- loads.js and loadModels.js (new types)
- streets traffic / common / pedestrians (APIs)

### 9.4 Module interfaces (new files)

- **src/mobile/config.js** (Phase 0, frozen): AT100 (all §1 numbers), HOOK_BLOCKS, CW_CONFIGS, BASES = {100: 3.5, 50: 2.5, 0: 1.25}, FLOAT_X, AXLES, MATS, RCL_T = {warn: 0.90, stop: 1.00, release: 0.98, reconfigRatio: 0.20, reconfigKg: 500}, TOWER_ZONE = {r: 63.0, ceiling: 44.2}, P1 = {x: 57, z: −12, yaw: −π/2, tolPos: 0.5, tolYawDeg: 5}, SPAWN, ROUTE.
- **charts.js:** LENGTHS, STRUCT, CHARTS, sectionExt, boomMassCG, bodies, ratedStability, rated360, rect, buildChart, chartKey(cfg), permitted(cfg) → {ok, reason}, capacity(cfg, L, R, pinnedK|null) → kg, rminFor(L), rmaxFor(cfg, L), telescopableLoad(L), windPerm(L).
- **boom.js:** `class TeleBoom {ext[5], k, phase, activeSection, get length, update(dt, cmd, perm)}` plus luff helpers `cylLen(θ)`, `luffRate(θ, vCyl)` and `headLocal(L, θ, dv, dl, lift) → {u, z, y}`.
- **drives.js:** `class MobileDrives {psi, psiDot, theta, thetaDot, sPaid, hookVel, dv, dvDot, dl, dlDot, freeSlew, pinned, brakeSlew; update(dt, levers, perm, ctx:{inertia, extTorque, tension, falls, gross, util}); fallLength(L, n); get ropeLenMin}`.
- **rcl.js:** `class RCL {config, state, ratio, capKg, grossKg, perm:{hoistUp, lower, luffUp, luffDown, teleOut, teleIn, slewL, slewR}, warnings:Set, stops:Set, counters; configure(cfg) → {ok, reason}; confirm(); update(dt, snap)}`, where snap = {grossKg, R, L, pinnedK, thetaG, headPos, loadPos, loadGrounded, twoBlock, drumRope, beamsActual, tiltDeg, wind, levers, tyresActive, floats}.
- **stability.js:** `solveSupport`, `hullMargin`, `class Stability {state, margin, R, cop, tilt, phi, phiDot, edge; update(dt, bodiesWorld, ropeForce, headWorld, supports); rootTransform(outMatrix)}`.
- **outriggers.js:** `class Outriggers {beams[4]:{ext, target, detent, obstructed}, jacks[4]:{e, max}, mats[4], selected, autoLevel; update(dt, setupInput, actions, world, groundFn); supports(carrierPose) → support list; tyresClear; floatsSet; detentMin()}`.
- **ground.js:** `groundAt(x, z)`, `addZone(rect, props)`, `clearZones()`, `class Settlement {s[4]; update(dt, reactionsN, areas, zones) → events}`.
- **ballast.js:** `class Ballast {superKg, deckStack[], raising; canAbsorb(load, pose) → bool; absorb(load); startRaise(pinned); update(dt)}`.
- **vehicle.js:** `class Vehicle {pos, yaw, v, gear, program, rpm, parkingBrake, wheelSteer[5], wheelSpin; update(dt, drive, actions, env:{terrain, world, traffic, siteRect}) → events[]; obb()}`.
- **route.js:** `buildRouteMarkers(scene)`, `guidance(pos, yaw) → {distance, text, bearingDeg}`.
- **model.js:** `buildMobileCrane(mats) → parts {root, carrier, wheels[5][2], beams[4], jacks[4], floats[4], matSlots[4], upper (slew group), craneCab (with leftStick, rightStick, screen canvas), driverCab, boomPivot, sections[6], head (sheave, anemometer, headCam mount), luffCyl {barrel, rod}, cwSlabs {A, B, C}, deckSlabs group, bumperAnchor, lights {beacons, work}}`, plus `buildMobileHookBlock(id)`.
  - Budget: ≤ 70 draw calls (merge per material as in crane/model.js).
  - Section i translates along the boom local +X by p_i.
- **mobileMachine.js** (integration) owns the ordering inside step():
  1. mode logic
  2. vehicle (ROAD)
  3. outriggers and ballast (SETUP / CRANE)
  4. RCL snapshot → perms
  5. drives
  6. head position → hoist.step
  7. stability (pose → next step)
  8. collider boxes
  9. KPI counters

### 9.5 Phases

- **Phase 0 (INT):** contracts (config.js, machine.js), TowerMachine extraction with zero behaviour change, ropeRender, main host loop, stub MobileMachine (box carrier) and test harness.
  - Exit criteria: all 7 tower jobs play identically and `node scripts/run-tests.mjs` runs.
- **Phase 1 (parallel):** MODEL, PHYS, STAB, DRIVE, UI, JOBS, each against the contracts with node tests.
- **Phase 2 (INT):** assemble mobileMachine.js and play M1–M6 end to end. Tune [E] values within the ranges stated.
- **Phase 3 (optional):** boom wind load, SMART BASE sector mode, over-rear 100 t with hb100, demobilisation job.

### 9.6 Tests (plain node, no framework; `npm test` → scripts/run-tests.mjs)

- **test-mobile-charts.mjs:** buildChart reproduces the §2.1 literals exactly; spot values in §2.1; permitted() table; capacity() interpolation and unpinned rules.
- **test-mobile-stability.mjs:** §4.3 and §4.9 reference values (±0.1 t, ±0.02 m); backward-margin table; tip dynamics τ ≈ 1.5–2.1 s.
- **test-mobile-rcl.mjs:** permission matrix; STOP hysteresis with the neutral requirement; reconfiguration gate (< 20 % and ≤ 500 kg).
- **test-mobile-vehicle.mjs:** outer front-corner radius 11.47 ± 0.1 m (ROAD) and 10.18 ± 0.1 m (ALL); 0–50 km/h in 25 ± 3 s; travel interlock.

## 10. Open items (do not block v1)

- **Chart fit:** it is a fitted fiction. At 0 t CW on mid-length booms the fictional crane is up to 50 % weaker than the LTM. Accepted, because the charts are internally consistent with the physics.
- **Geometry estimates:** axle positions and outrigger box placement relative to the axles; cab positions; luff-cylinder geometry. The stroke ratio is > 1, so draw a 2-stage cylinder.
- **Ground and deflection constants:** allowable/ultimate ratio, settlement rates, boom EI values and telescopable loads are all estimates.
- **ISO 7752-2:2025:** could not confirm whether the left-stick fore/aft direction changed. The spec follows 2011 / EN 13000 ("away = extend").
- **EN 13000 RCL clause text:** not verified. ISO 10245-2 and FEM 5.014 were used as proxies.
- **Neighbour roof:** comes from planCity(). If the planner changes, M2 falls back to its own roof box.
