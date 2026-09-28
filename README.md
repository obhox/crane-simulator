# Crane Simulator: TC-6010 tower crane and AT-100 5.1 mobile crane

A realistic, browser-based crane simulator built with three.js. It has two machines on the same construction site: a hammerhead tower crane and a 100 t all-terrain mobile crane that you drive in from the public road, set up and operate. Geometry and sound are procedural. Textures are either procedural or CC0 downloads (`scripts/fetch-assets.*`), so there is nothing to license.

## Run / build

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/ (relative paths, deploy anywhere)
npm run preview   # serve the production build locally
npm test          # plain-node tests: every scripts/test-*.mjs (scripts/run-tests.mjs)
```

`dist/` is a plain static site: upload it to Netlify, Vercel, Cloudflare Pages, GitHub Pages, S3, Coolify/nginx, etc. No server code is needed.

## Tower crane: what makes it realistic

The tower crane is a fictional **TC-6010**, specified from published data for 60 m / 8 t class hammerhead cranes:

- **Geometry:** 45 m under hook, 1.6 × 1.6 × 3 m mast sections, 60 m jib.
- **Load chart:** 8 t max; 1.3 t at the 60 m tip.
- **Hoist speeds:** 80/40 m/min (2 falls) or 40/20 m/min (4 falls), with the speed band chosen by the measured load.
- **Trolley and slew:** trolley 60 m/min, slewing 0.7 rpm.

### Physics

- The hoist is simulated with **XPBD** (extended position-based dynamics). It runs from the trolley sheave through an elastic multi-fall rope to a 300 kg hook block, then through the slings to the load. This gives a true double-pendulum sway and centrifugal outswing when slewing. It also gives slack rope, and rope stretch that makes heavy loads bounce on snatch lifts.
- The load cell reads the rope tension, so dynamic snatches show up on the LMI.
- The slewing drive is torque-limited against inertia, the rope reaction and wind. It has three modes (soft, normal, dynamic) and a holding brake that strong wind can overpower.
- Structural dynamics:
  - The jib dips at the tip under load and springs back when a heavy load is trolleyed in.
  - The jib vibrates sideways (~2 s period) after slewing.
- Wind:
  - Gusts rise fast and decay slowly, and the direction veers.
  - Speed follows a logarithmic height profile.
  - Drag acts on loads (area-dependent), the hook and the jib, so the jib can weathervane.
  - The anemometer reading is averaged over 3 seconds.
- Loads twist on the hook swivel. Tag lines work only while the load is low enough for a rigger to reach.

### Safety systems (ISO 10245-3 / EN 14439 behaviour)

- Load moment limiter:
  - 90 % pre-warning: amber light and beeper.
  - 105 % cut-out: siren. Hoist-up and trolley-out are blocked; hoist-down and trolley-in still work.
- Maximum-load limiter per reeving.
- Hoist upper limit (anti two-block) and trolley limits, each with a slow-down zone.
- Zero-position interlock at power-on, and an emergency stop.
- Anemometer thresholds: 14 m/s warning, 17 m/s alarm, 20 m/s hoist stop.
- Working-area limiter that keeps the hook out of the public road.

### Operator experience

- **Controls:** ISO 7752-3 layout.
  - Left lever: slew and trolley.
  - Right lever: hoist.
- **Cab view:** a floor window and a hook-camera monitor.
- **LMI display:** load, rated load (SWL), moment %, radius, hook height, slew angle, wind and a live load chart.
- **Signaller:** a radio signaller gives voice commands in the standard format (for example "Swing right, 10 … 5 … swing stop").
- **Sway Control assist:** optional, off by default.

## Controls (tower crane)

| Action | Keyboard | Gamepad |
|---|---|---|
| Slew left / right | A / D (or ← / →) | Left stick X |
| Trolley out / in | W / S | Left stick Y |
| Hoist up / down | ↑ / ↓ (I / K) | Right stick Y |
| Micromove (fine speed) | hold Shift | LT |
| Power on (levers in neutral) | P | Y |
| Emergency stop | Space | Back |
| Horn | H | B |
| Hook on / release | R | A |
| Tag line rotate | Q / E | LB / RB |
| Camera (cab / orbit / hook / ground) | C | X |
| Slewing mode | M | |
| Free slew (weathervane) | F | |
| Sway Control assist | B | |
| Signaller guidance | V | |
| Pause | Esc | Start |
| Switch machine (free play) | Tab | |

On phones and tablets, on-screen levers and buttons appear automatically.

The settings let you reverse the hoist key direction: in true ISO lever convention, pushing forward lowers the load.

## Lift jobs (tower crane)

The tower-crane jobs follow the modules of professional training simulators:

1. Load Control
2. Barrel Test
3. Executing Lifts
4. Steel Erection
5. Concrete Pour (form following)
6. Wind Challenge
7. Corridor Course

Each job is scored on:

- time;
- maximum sway;
- collisions;
- rough landings;
- upper-limit trips;
- LMI cut-outs;
- horn before moving;
- test lifts;
- placement accuracy;
- time spent above the load's wind limit.

Best scores are stored locally in the browser.

## Mobile crane: AT-100 5.1

The mobile crane is a fictional 100 t, 5-axle all-terrain crane. It is modelled on published data for the 100 t five-axle class. No real brand appears in the game, and its load charts come from the spec's own fitted rigid-body model. The full build spec is `docs/mobile-crane-spec.md`.

It has three working modes: ROAD, SETUP and CRANE. The HUD, input profile and cameras follow the mode.

- **ROAD: driving.**
  - Kinematic model of a multi-axle vehicle with three steering programmes: ROAD, ALL-wheel and CRAB.
  - Realistic performance: 12-speed gearbox, engine torque curve, brakes and retarder.
  - The terrain pose comes from all 10 wheels. Kerb strikes are detected.
  - It collides with the site, the street furniture colliders and live traffic.
  - Cars queue behind and in front of the crane. A banksman holds oncoming traffic at the gate, and a rolling closure holds the lane behind it.
  - Chevrons and HUD guidance lead from the road spawn through the gate and the wheel wash to pad P1.
- **SETUP: outrigger remote.**
  - Four single-stage beams with detents at 0, 50 and 100 %. A beam stops when a world object obstructs it.
  - Jacks with real strokes, carried or composite mats laid by riggers, and auto-level to ±0.3° with the tyres 0.10 m clear.
  - Interlock: a beam cannot move while its float is loaded.
  - Self-ballasting: land counterweight slabs on the carrier deck with the crane's own hook, pin the turntable, then hold B for 45 s.
  - Leaving the site in ROAD needs the travel interlock: beams in, jacks up, boom on its rest, turntable pinned, hook stowed, no counterweight.
- **CRANE: the lifting drives.**
  - Slew is torque-limited, with a holding brake, free slew and a turntable pin.
  - Luff is driven by a cylinder: about 2°/s, with load factors.
  - Telescoping uses a single cylinder with boom pins at 0, 46, 92 and 100 %. Each step takes a stroke plus a 4 s pin event.
  - The winch has drum layers and a constant-power knee. A relief valve protects it, and its holding brake slips if the hook snags.
  - The boom deflects vertically and sideways.
  - The boom can hit site objects. After a contact, only motions away from it are allowed.
- **RCL (rated capacity limiter).**
  - The configuration is confirmed at every power-on. It covers the support (outriggers or tyres), base, counterweight and hook block. Reconfiguration is refused above 20 % utilisation or 0.5 t on the hook.
  - Warning at 90 %, STOP at 100 %. STOP releases only below 98 % with the levers in neutral.
  - Working-range limiter: the head stays at or below 44.2 m within 63 m of the tower crane, and the head, hook and load stay out of the public road.
  - Bypass is an EN 13000 emergency bypass (Ctrl+Shift+B, only if the setting allows it).
  - Like a real RCL, it cannot see the counterweight or the reeving. If you enter the wrong configuration, it trusts you.
- **Stability.** It is computed from the bodies and the rope force at the head, every step:
  - The carrier rests on the hull of its floats or tyres. The display shows each float's reaction, its bearing pressure against the ground's allowable pressure, and settlement or punch-through.
  - A float that goes light or lifts off triggers a warning.
  - Past the tipping edge the crane rotates as a rigid body. Landing the load makes it slam back. Keeping the load up makes it overturn.
- **Hook blocks:** hook ball (1 fall), 26 t (3), 60 t (7) and 90 t (10). Re-reeving is done by the riggers: 45 or 90 s with the block on the ground.

### Controls (mobile crane)

| Mode | Keys |
|---|---|
| ROAD | W/↑ throttle · S/↓ brake · A/D steer · X gear D↔R (standstill) · K steering ROAD→ALL→CRAB · F parking brake · Shift crawl 5 km/h · Space engine · Enter → SETUP (stopped, parking brake on) |
| SETUP | 1–4 select FL/FR/RL/RR · 5 all · A/D beam in/out (hold at 50 % to pass the detent) · W/S jack down/up · X mat · hold G auto-level · hold B ballast raise/lower · T turntable pin · Enter → CRANE · Backspace → ROAD (travel interlock) · Space remote stop |
| CRANE | A/D slew · W/S telescope out/in · ←/→ luff up/down · ↑/↓ hoist · Shift micro · P power (levers neutral) · L RCL configuration · O reeving (block on the ground) · T pin · F free slew · M mute RCL horn · R hook on/release, or release the block from the bumper · Q/E tag line · Enter → SETUP · hold Z ×4 time (no suspended load) |

H is the horn, C the camera, V the signaller and Esc pause in every mode. Tab switches machine in free play. The gamepad and touch layouts follow the same profiles (see Help → Mobile in the game).

Cameras by mode: driver, chase and orbit in ROAD; setup (at the selected float), driver and chase in SETUP; cab (tilting with the boom angle), hook, ground, setup and orbit in CRANE. If the crane overturns, a cinematic orbit plays.

### Mobile lift jobs

| Job | What it trains |
|---|---|
| M1 Mobilise & Set Up | Drive from the road to P1 (gate, wheel wash, site speed limit), full-base set-up with mats and levelling, RCL, 5 t test lift |
| M2 Rooftop Plant | Self-ballasting 23.5 → 35 t (slab C from the ballast truck onto the deck), 45 m boom, HVAC unit onto the neighbour's roof under the tower-crane height limit |
| M3 Generator Set | Re-reeving to the 26 t block, 12 t lift at 75 % |
| M4 Precast Delivery | 33.9 m boom, three panels into a rack over the rear in 5 m/s gusty wind, tag lines |
| M5 Ballast Check | The trap: 11.5 t fitted, the RCL pre-set to 35 t. Trust it and the crane tips at R ≈ 23–24 m. Configure it correctly and the RCL stops you at R ≈ 20.6 m |
| M6 Substation Transformer | Barriers limit the left beams to 50 %, so the crane works on the B50 chart over the hoarding |

Mobile jobs add the §8.5 scoring: drive, set-up and operation KPIs, a set-up checklist, and critical failures (overturn, punch-through, traffic collision, RCL bypass).

In free play, the setting **Mobile start** chooses where the crane begins:

- `pad`: set up on P1 with 35 t, ball, 22.7 m boom.
- `road`: in road trim on the street, with the ballast truck carrying all three slabs at the pad.

## Machines

Both machines always exist in the world. In free play, **Tab** switches between them. The switch needs the current hook to have no suspended load. The machine you leave is parked:

- The tower trolleys in, raises the hook, powers off and weathervanes.
- The mobile powers off where it stands.

A job always runs on its own machine. The main menu's machine selector chooses the free-play machine.

`src/main.js` is the host. `src/machines/machine.js` defines the contract that each machine implements, and the host drives every machine through it:

- The host steps each machine at 120 Hz. The inactive machine gets neutral input.
- It routes the generic actions (hook on/release, camera, pause, switch) and passes everything else to the active machine.
- It keeps each machine's colliders registered in the collider world.
- It feeds the active machine's `hudState()` to the HUD and each machine's `audioState()` to the audio.
- It feeds the mobile's footprint to the street traffic and pedestrians.

The mobile's 120 Hz step runs in the spec §9.4 order:

1. mode logic
2. vehicle (ROAD)
3. outriggers and ballast
4. RCL snapshot, giving the permissions
5. drives
6. head, then the hoist rope
7. stability, giving the pose and TIPPING / OVERTURNED
8. collider boxes
9. KPIs and events

## Project layout

```
src/main.js                 host: bootstrap, fixed-step loop (120 Hz × 6 substeps), actions, rendering
src/machines/machine.js     Machine contract (JSDoc), MobileStart, NULL_INPUT
src/machines/towerMachine.js  the tower crane as a Machine (drives, LMI, sway assist, visuals, HUD/audio state)
src/machines/ropeRender.js  rope falls + slings (instanced), shared by both machines
src/mobile/config.js        AT-100 constants (spec §1 and more), read-only
src/mobile/mobileMachine.js the mobile crane as a Machine: assembles the modules below in the §9.4 step order
src/mobile/model.js, modelParts.js, hookBlocks.js   procedural AT-100 model and hook blocks
src/mobile/charts.js, boom.js, drives.js, rcl.js    load charts, telescope / luff geometry, drives, RCL
src/mobile/stability.js, outriggers.js, ground.js, ballast.js   support solver + tip-over, set-up, bearing, self-ballasting
src/mobile/vehicle.js, route.js                     carrier driving model, road → P1 route and guidance
src/mobile/jobs.js, jobProps.js                     jobs M1–M6 and their scenery
src/hudMobile.js            AT-100 displays (ROAD / SETUP / CRANE pages, RCL dialogs, cab screen)
src/config.js               tower crane spec, load chart, speed bands, limits
src/crane/                  model.js (procedural lattice), crane.js (drives + structure), safety.js
src/physics/                rope.js (XPBD hoist), collide.js (OBB world), wind.js
src/world/                  environment (sky, sun, shadows), site, city, procedural textures
src/loads.js                load catalogue
src/jobs.js                 lift jobs + scoring
src/signaller.js            radio voice protocol
src/input.js                keyboard / gamepad / touch → ISO levers
src/cameras.js, audio.js, hud.js
scripts/run-tests.mjs       test runner (npm test); scripts/test-*.mjs (contracts, charts, RCL, stability, vehicle, jobs, model, assembled machine)
```

### Debug hook

`window.__sim` exposes the simulation for QA scripts:

| Call | What it does |
|---|---|
| `view(pos, target, fov)` | Fixed debug camera. `view(null)` goes back to the normal cameras. |
| `hideHud(on)` | Hides or shows the HUD. |
| `startJob(id)`, `startFreePlay()` | Start a lift job or free play. |
| `stepPhysics(dt)` | Runs one physics step. |
| `advance(seconds)` | Runs fixed steps plus the job logic, without rendering. |
| `action(name)` | Processes one input action now, for example `'hook'` or `'power'`. |
| `machines`, `active`, `setMachine(id, {force})` | The machines, the active one, and a way to switch. |
| `crane`, `hoist`, `safety`, `parts` | The tower's objects (kept for back-compatibility). |
| `tower`, `mobile` | The two machines. For example, `mobile.drives`, `mobile.rcl`, `mobile.stab`, `mobile.outr`, `mobile.vehicle`, `mobile.ballast`, `mobile.hudState()`. |
| `state`, `input`, `jobs`, `loads`, `world`, `terrain`, `streets` | Host state, the live input, the job runner and the world. |
