import { buildStreetLife } from './streets/index.js';

// Street life & furniture: moving traffic (lane graph, signals, IDM car
// following, buses serving stops), parked cars, LED street lights with night
// light pools, signal assemblies with animated lenses, road signs, bus
// shelters, benches, bins, bollards, hydrants, planters, street trees with
// wind sway and pedestrians — all laid out along the road grid from
// layout.js. Visual only: nothing here adds physics colliders, and nothing is
// placed inside the site fence or on the gate apron. Implementation lives in
// ./streets/*.js.
//
// buildStreets(scene, quality /* QUALITY preset */) → {
//   root,                      THREE.Group holding everything
//   update(dt, night),         night: 0 day … 1 night (env.nightFactor)
//   setWind(speed, dirRad),    optional: mean wind (m/s) + direction it blows towards (xz)
//   signals, traffic, peds …   debug / inspection handles
//   setObstacles(list),        mobile crane on the road: [{x, z, hx, hz, yaw, vx?, vz?}] for traffic + pedestrians (§7.1)
//   vehicleBoxes(qx, qz, r, out), car OBBs near a point (the carrier's collision test)
//   clearArea(box, pad),       remove moving cars from a rectangle (crane placed on the road)
// }
export function buildStreets(scene, quality = { name: 'high', city: 1 }) {
  return buildStreetLife(scene, quality);
}
