// Shared city layout (read-only contract for terrain.js, city.js, streets.js).
// World units are metres, +y up, crane mast at the origin.
//
// Roads form a grid:
//   X_ROADS: roads running along the x axis, listed by their centre-line z
//   Z_ROADS: roads running along the z axis, listed by their centre-line x
// Each road has a carriageway of ROAD.width and a sidewalk of ROAD.sidewalk
// on both sides. Lots (building plots) are the rectangles between sidewalks.
// The construction site occupies part of the SITE_BLOCK lot; the rest of that
// lot is available for neighbouring buildings outside NEIGHBOUR_EXCLUDE.

import { SITE } from '../config.js';

export const ROAD = { width: 10, sidewalk: 3.5, laneWidth: 3.5, curbHeight: 0.15 };

// Existing public road south of the site is the X road at z = -66 (carriageway -71..-61).
export const X_ROADS = [-396, -286, -176, -66, 104, 214, 324, 434];
export const Z_ROADS = [-430, -320, -210, -100, 110, 220, 330, 440];

// Everything beyond this radius is only a low-detail skyline/backdrop.
export const CITY_EXTENT = 470;

const HALF = ROAD.width / 2 + ROAD.sidewalk;

// Lot rectangles between roads (inside the sidewalks).
export function lots() {
  const xs = [...Z_ROADS].sort((a, b) => a - b);
  const zs = [...X_ROADS].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const lot = {
        minX: xs[i] + HALF, maxX: xs[i + 1] - HALF,
        minZ: zs[j] + HALF, maxZ: zs[j + 1] - HALF,
      };
      lot.site = lot.minX < 0 && lot.maxX > 0 && lot.minZ < 0 && lot.maxZ > 0;
      out.push(lot);
    }
  }
  return out;
}

export const SITE_BLOCK = lots().find((l) => l.site);

// Area neighbours must not build in (site fence + 6 m clearance for the crane
// counter-jib/jib swing, hoarding and access).
export const NEIGHBOUR_EXCLUDE = {
  minX: SITE.fence.minX - 6, maxX: SITE.fence.maxX + 6,
  minZ: SITE.fence.minZ - 6, maxZ: SITE.fence.maxZ + 6,
};

// Road segments as rectangles (carriageway only), useful for terrain/streets.
export function roadRects() {
  const rects = [];
  const zMin = Math.min(...X_ROADS) - 60, zMax = Math.max(...X_ROADS) + 60;
  const xMin = Math.min(...Z_ROADS) - 60, xMax = Math.max(...Z_ROADS) + 60;
  for (const z of X_ROADS) rects.push({ axis: 'x', c: z, minX: xMin, maxX: xMax, minZ: z - ROAD.width / 2, maxZ: z + ROAD.width / 2 });
  for (const x of Z_ROADS) rects.push({ axis: 'z', c: x, minX: x - ROAD.width / 2, maxX: x + ROAD.width / 2, minZ: zMin, maxZ: zMax });
  return rects;
}

// Intersections (centre points) — for traffic lights, crossings.
export function intersections() {
  const out = [];
  for (const x of Z_ROADS) for (const z of X_ROADS) out.push({ x, z });
  return out;
}

export function insideRect(r, x, z, pad = 0) {
  return x > r.minX - pad && x < r.maxX + pad && z > r.minZ - pad && z < r.maxZ + pad;
}
