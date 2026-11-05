// Colliders - static arena collision from assets/court-colliders.v3.json (stage ford-32m).
// Game space (Y up, metres, north = -Z). Shapes: 'cyl' (vertical cylinder) and 'obb' (box, yaw about +Y,
// same sign as three.js rotation.y). Surfaces arrive by NAME and are resolved through the shared Surface
// table; an unknown name throws at load (never a silent default). All queries are allocation-free.
import { Surface } from '../shared/enums.js';

const STEP_UP = 0.25;     // max rise the capsule walks onto (shrine steps rise 0.20 m)

export class Colliders {
  constructor(doc) {
    if (!doc || !Array.isArray(doc.colliders)) throw new Error('Colliders: bad document');
    this.stage = doc.stage;
    this.arena = doc.arena;
    this.ford = doc.ford;
    const prof = doc.ground.heightProfile;
    if (prof.axis !== 'abs(z)' || prof.interp !== 'linear') throw new Error('Colliders: unsupported height profile');
    this.profZ = new Float32Array(prof.points.map((p) => p[0]));
    this.profY = new Float32Array(prof.points.map((p) => p[1]));
    this.half = doc.arena.half;
    // v2.20 per-axis bounds: the road is 18 x 120 m; square arenas leave halfX = halfZ = half
    this.halfX = doc.arena.halfX || this.half; this.halfZ = doc.arena.halfZ || this.half;
    const n = doc.colliders.length;
    this.count = n;
    this.names = doc.colliders.map((c) => c.name);
    this.kind = new Uint8Array(n);          // 0 cyl, 1 obb
    this.surface = new Uint8Array(n);
    this.cx = new Float32Array(n); this.cy = new Float32Array(n); this.cz = new Float32Array(n);
    this.hx = new Float32Array(n); this.hy = new Float32Array(n); this.hz = new Float32Array(n); // cyl: hx = radius
    this.cos = new Float32Array(n); this.sin = new Float32Array(n);
    this.walkTop = new Float32Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      const c = doc.colliders[i];
      const s = Surface[c.surface];
      if (s === undefined) throw new Error('Colliders: unknown surface ' + c.surface + ' on ' + c.name);
      this.surface[i] = s;
      this.cx[i] = c.center[0]; this.cy[i] = c.center[1]; this.cz[i] = c.center[2];
      if (c.kind === 'cyl') {
        this.kind[i] = 0; this.hx[i] = c.radius; this.hy[i] = c.halfHeight; this.hz[i] = c.radius;
        this.cos[i] = 1; this.sin[i] = 0;
      } else if (c.kind === 'obb') {
        this.kind[i] = 1; this.hx[i] = c.halfExtents[0]; this.hy[i] = c.halfExtents[1]; this.hz[i] = c.halfExtents[2];
        this.cos[i] = Math.cos(c.yaw || 0); this.sin[i] = Math.sin(c.yaw || 0);
      } else throw new Error('Colliders: unknown kind ' + c.kind + ' on ' + c.name);
      if (typeof c.walkTop === 'number') this.walkTop[i] = c.walkTop;
    }
    // ford stage: river band is WATER, banks SAND. Foundry (no ford block): flat floor of ground.surface with
    // optional diagonal zones (the X grating strips). Unknown surface names throw like the colliders do.
    this.waterTop = doc.ford ? doc.ford.waterTop : -1e9;
    this.wetHalfZ = doc.ford ? 6.7 : -1;   // ford.surfaces "abs(z)<6.7" -> WATER
    const gs = doc.ground.surface || 'SAND';
    if (Surface[gs] === undefined) throw new Error('Colliders: unknown ground surface ' + gs);
    this.drySurface = Surface[gs];
    const zones = doc.ground.zones || [];
    this.zoneHalf = new Float32Array(zones.length); this.zoneLimit = new Float32Array(zones.length); this.zoneSurf = new Uint8Array(zones.length);
    zones.forEach((zn, i) => {
      if (zn.shape !== 'diag') throw new Error('Colliders: unknown zone shape ' + zn.shape);
      if (Surface[zn.surface] === undefined) throw new Error('Colliders: unknown zone surface ' + zn.surface);
      this.zoneHalf[i] = zn.halfWidth; this.zoneLimit[i] = zn.limit ?? 1e9; this.zoneSurf[i] = Surface[zn.surface];
    });
    this.hit = { x: 0, z: 0, nx: 0, nz: 0, index: -1, surface: 0, pushed: false, y: 0 };
  }

  // Terrain height (sand banks + river bed) from the authored profile.
  terrainY(z) {
    const a = Math.abs(z), pz = this.profZ, py = this.profY;
    if (a <= pz[0]) return py[0];
    for (let i = 1; i < pz.length; i++) {
      if (a <= pz[i]) { const t = (a - pz[i - 1]) / (pz[i] - pz[i - 1]); return py[i - 1] + (py[i] - py[i - 1]) * t; }
    }
    return py[py.length - 1];
  }

  _insideXZ(i, x, z, pad) {
    const dx = x - this.cx[i], dz = z - this.cz[i];
    if (this.kind[i] === 0) { const r = this.hx[i] + pad; return dx * dx + dz * dz <= r * r; }
    const c = this.cos[i], s = this.sin[i];
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    return Math.abs(lx) <= this.hx[i] + pad && Math.abs(lz) <= this.hz[i] + pad;
  }

  // Ground under (x, z) for an actor whose feet are at footY: terrain, raised by any walkable top within STEP_UP.
  // Writes surface to this.hit.surface and returns the height.
  groundY(x, z, footY) {
    let y = this.terrainY(z);
    let surf = Math.abs(z) < this.wetHalfZ ? Surface.WATER : this.drySurface;
    for (let i = 0; i < this.zoneHalf.length; i++) {
      const lim = this.zoneLimit[i];
      if (Math.abs(x) > lim || Math.abs(z) > lim) continue;
      const hw = this.zoneHalf[i];
      if (Math.abs(x - z) * Math.SQRT1_2 <= hw || Math.abs(x + z) * Math.SQRT1_2 <= hw) { surf = this.zoneSurf[i]; break; }
    }
    for (let i = 0; i < this.count; i++) {
      const wt = this.walkTop[i];
      if (wt !== wt || wt <= y) continue;
      if (wt - footY > STEP_UP) continue;
      if (this._insideXZ(i, x, z, 0)) { y = wt; surf = this.surface[i]; }
    }
    this.hit.surface = surf; this.hit.y = y;
    return y;
  }

  isWater(x, z, footY) { this.groundY(x, z, footY); return this.hit.surface === Surface.WATER; }

  // Distance from point (x, y, z) to the nearest solid it could touch: every collider whose vertical span contains
  // y (XZ distance to the shape, negative inside), the arena wall faces (only below wallTop) and the terrain below.
  // Used by the camera (C5 margin) and boss bounds (C10). Allocation-free; index of the nearest in this.hit.index.
  clearance(x, y, z, wallTop = 1.12) {
    let best = y - this.terrainY(z), bi = -2;
    for (let i = 0; i < this.count; i++) {
      if (y > this.cy[i] + this.hy[i] || y < this.cy[i] - this.hy[i]) continue;
      const dx = x - this.cx[i], dz = z - this.cz[i];
      let d;
      if (this.kind[i] === 0) d = Math.sqrt(dx * dx + dz * dz) - this.hx[i];
      else {
        const c = this.cos[i], s = this.sin[i];
        const ax = Math.abs(c * dx - s * dz) - this.hx[i], az = Math.abs(s * dx + c * dz) - this.hz[i];
        const ox = ax > 0 ? ax : 0, oz = az > 0 ? az : 0;
        d = ox > 0 || oz > 0 ? Math.sqrt(ox * ox + oz * oz) : (ax > az ? ax : az);
      }
      if (d < best) { best = d; bi = i; }
    }
    if (y < wallTop) {
      const w = Math.min(this.halfX - Math.abs(x), this.halfZ - Math.abs(z));
      if (w < best) { best = w; bi = -1; }
    }
    this.hit.index = bi;
    return best;
  }

  // Push a vertical capsule (radius r, feet footY, height h) out of every solid it overlaps in XZ.
  // Walkable tops the actor can step onto are not walls. Result position in this.hit (x, z), last normal and index.
  resolveCapsule(x, z, r, footY, h) {
    const hit = this.hit; hit.pushed = false; hit.index = -1; hit.nx = 0; hit.nz = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.count; i++) {
        const top = this.cy[i] + this.hy[i], bot = this.cy[i] - this.hy[i];
        if (footY + h <= bot || footY >= top - 1e-4) continue;          // no vertical overlap
        const wt = this.walkTop[i];
        if (wt === wt && wt - footY <= STEP_UP) continue;                // a step, not a wall
        const dx = x - this.cx[i], dz = z - this.cz[i];
        if (this.kind[i] === 0) {
          const rr = this.hx[i] + r, d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr) continue;
          const d = Math.sqrt(d2);
          const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
          x = this.cx[i] + nx * rr; z = this.cz[i] + nz * rr;
          hit.nx = nx; hit.nz = nz; hit.index = i; hit.pushed = true;
        } else {
          const c = this.cos[i], s = this.sin[i];
          let lx = c * dx - s * dz, lz = s * dx + c * dz;
          const ex = this.hx[i], ez = this.hz[i];
          const qx = lx < -ex ? -ex : lx > ex ? ex : lx, qz = lz < -ez ? -ez : lz > ez ? ez : lz;
          let ox = lx - qx, oz = lz - qz;
          const d2 = ox * ox + oz * oz;
          let nlx, nlz;
          if (d2 > 1e-12) {
            if (d2 >= r * r) continue;
            const d = Math.sqrt(d2); nlx = ox / d; nlz = oz / d;
            lx = qx + nlx * r; lz = qz + nlz * r;
          } else {                                                       // centre inside: exit by the shallow axis
            const px = ex - Math.abs(lx), pz = ez - Math.abs(lz);
            if (px < pz) { nlx = lx < 0 ? -1 : 1; nlz = 0; lx = nlx * (ex + r); }
            else { nlx = 0; nlz = lz < 0 ? -1 : 1; lz = nlz * (ez + r); }
          }
          // local -> world: wx = c*lx + s*lz, wz = -s*lx + c*lz
          x = this.cx[i] + c * lx + s * lz; z = this.cz[i] - s * lx + c * lz;
          hit.nx = c * nlx + s * nlz; hit.nz = -s * nlx + c * nlz; hit.index = i; hit.pushed = true;
        }
      }
    }
    // arena walls (inner face at |x|,|z| = half)
    const lx = this.halfX - r, lz = this.halfZ - r;
    if (x > lx) { x = lx; hit.pushed = true; } else if (x < -lx) { x = -lx; hit.pushed = true; }
    if (z > lz) { z = lz; hit.pushed = true; } else if (z < -lz) { z = -lz; hit.pushed = true; }
    hit.x = x; hit.z = z;
    return hit;
  }
}
