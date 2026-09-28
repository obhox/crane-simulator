// Oriented-box collision world (boxes may yaw about Y, no pitch/roll).
// Good enough for loads against slabs, columns, stacks, trucks and each other.

let nextId = 1;

export class Box {
  constructor(cx, cy, cz, hx, hy, hz, yaw = 0, tag = 'static') {
    this.id = nextId++;
    this.set(cx, cy, cz, hx, hy, hz, yaw);
    this.tag = tag;
    this.enabled = true;
  }
  set(cx, cy, cz, hx, hy, hz, yaw = 0) {
    this.cx = cx; this.cy = cy; this.cz = cz;
    this.hx = hx; this.hy = hy; this.hz = hz;
    this.setYaw(yaw);
  }
  setYaw(yaw) {
    this.yaw = yaw;
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
    this.r = Math.hypot(this.hx, this.hz);
  }
  get top() { return this.cy + this.hy; }
  get bottom() { return this.cy - this.hy; }
}

// SAT for two yawed rectangles in the XZ plane. Returns minimum translation
// that moves `a` out of `b` ({depth,nx,nz}) or null if separated.
const out = { depth: 0, nx: 0, nz: 0 };
export function obbXZ(a, b) {
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  if (dx * dx + dz * dz > (a.r + b.r) * (a.r + b.r)) return null;
  // local axes (three.js rotation.y convention)
  const axes = [
    a.c, -a.s, a.s, a.c,
    b.c, -b.s, b.s, b.c,
  ];
  let best = Infinity, bnx = 0, bnz = 0;
  for (let i = 0; i < 4; i++) {
    const nx = axes[i * 2], nz = axes[i * 2 + 1];
    const ra = a.hx * Math.abs(a.c * nx - a.s * nz) + a.hz * Math.abs(a.s * nx + a.c * nz);
    const rb = b.hx * Math.abs(b.c * nx - b.s * nz) + b.hz * Math.abs(b.s * nx + b.c * nz);
    const d = dx * nx + dz * nz;
    const o = ra + rb - Math.abs(d);
    if (o <= 0) return null;
    if (o < best) {
      best = o;
      const sgn = d > 0 ? -1 : 1;
      bnx = nx * sgn;
      bnz = nz * sgn;
    }
  }
  out.depth = best; out.nx = bnx; out.nz = bnz;
  return out;
}

export class ColliderWorld {
  constructor() {
    this.boxes = [];
  }
  add(box) {
    this.boxes.push(box);
    return box;
  }
  remove(box) {
    const i = this.boxes.indexOf(box);
    if (i >= 0) this.boxes.splice(i, 1);
  }

  // Resolve a moving box against the world. `body` is a Box whose centre is
  // the current (predicted) position; prevY is its centre y last substep.
  // Mutates body.cx/cy/cz. Returns contact info.
  resolve(body, prevY, ignore) {
    const info = { support: false, supportY: 0, lateral: false, ceiling: false, hitTag: null, nx: 0, nz: 0 };
    // ground
    if (body.cy - body.hy < 0) {
      body.cy = body.hy;
      info.support = true;
      info.supportY = 0;
    }
    const bottom = body.cy - body.hy, top = body.cy + body.hy;
    const pBottom = prevY - body.hy, pTop = prevY + body.hy;
    for (let i = 0; i < this.boxes.length; i++) {
      const c = this.boxes[i];
      if (!c.enabled || c === ignore || (ignore && ignore.has && ignore.has(c))) continue;
      if (body.cy - body.hy >= c.top || body.cy + body.hy <= c.bottom) continue;
      const hit = obbXZ(body, c);
      if (!hit) continue;
      if (pBottom >= c.top - 0.06) {
        body.cy = c.top + body.hy;
        info.support = true;
        info.supportY = Math.max(info.supportY, c.top);
        info.hitTag = c.tag;
      } else if (pTop <= c.bottom + 0.06) {
        body.cy = c.bottom - body.hy;
        info.ceiling = true;
        info.hitTag = c.tag;
      } else {
        body.cx += hit.nx * hit.depth;
        body.cz += hit.nz * hit.depth;
        info.lateral = true;
        info.nx = hit.nx;
        info.nz = hit.nz;
        info.hitTag = c.tag;
      }
    }
    void bottom; void top;
    return info;
  }

  // highest collider top under a point (for placing things / hook cam info)
  heightAt(x, z, skip) {
    let h = 0;
    const probe = new Box(x, 500, z, 0.05, 500, 0.05);
    for (const c of this.boxes) {
      if (!c.enabled || c === skip) continue;
      if (obbXZ(probe, c)) h = Math.max(h, c.top);
    }
    return h;
  }
}
