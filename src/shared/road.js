// Campaign road (v2.20) - the walkable pass between two bosses. Pure data + pure functions, no THREE/DOM, so the
// sim (GameSim), the world builder (RoadStage) and the QA fixtures all read ONE definition.
// Game space: Y up, metres, the road runs from +Z (spawn, the boss just beaten) to -Z (the gate to the next boss).
// The playable floor is |x| < HALF_X, |z| < HALF_Z; cliffs stand outside the camera clamp (see RoadStage).
export const ROAD = Object.freeze({
  HALF_X: 9.0, HALF_Z: 60.0,
  SPAWN_Z: 54.0, GATE_Z: -54.0,
  GATE_R: 3.0,            // hero within this of the gate centre (after every ambush) -> next stage
  WIDTH: 5.2,             // packed-earth road band (presentation; the whole floor is walkable)
  LANTERN_EVERY: 12.0, LANTERN_OFF: 3.7,
});

// Gentle S-curve so the pass never reads as a corridor. Amplitude keeps the road band inside |x| < 6.
export function roadX(z) { return 3.4 * Math.sin(z * 0.055) + 1.2 * Math.sin(z * 0.13 + 1.1); }

// Ambushes, triggered in order as the hero crosses z. Spawns are offsets from (roadX(z), z): ahead (-dz) and a
// flanker behind (+dz) so every ambush is a pincer at normal camera distance.
// order matters: an n-foe ambush uses the first n, so the flanker sits second (every ambush is a pincer)
const SP = Object.freeze([[-2.4, -7.5], [0.6, 6.5], [2.4, -7.0]]);
export const ROAD_AMBUSH = Object.freeze([
  Object.freeze([
    Object.freeze({ name: 'Pass Bandits', z: 32, n: 2, tokens: 1, aggression: 1.1, hp: 80 }),
    Object.freeze({ name: 'Ridge Ambush', z: 4, n: 3, tokens: 1, aggression: 1.2, hp: 80 }),
    Object.freeze({ name: 'Shrine Gate Watch', z: -26, n: 3, tokens: 2, aggression: 1.35, hp: 85 }),
  ]),
  Object.freeze([
    Object.freeze({ name: 'Frost Raiders', z: 32, n: 2, tokens: 1, aggression: 1.25, hp: 95 }),
    Object.freeze({ name: 'Chrome Scouts', z: 4, n: 3, tokens: 2, aggression: 1.35, hp: 95 }),
    Object.freeze({ name: 'Foundry Gate Watch', z: -26, n: 3, tokens: 2, aggression: 1.5, hp: 100 }),
  ]),
]);
export const AMBUSH_SPAWNS = SP;
// leg -> where it leads (labels for HUD / trail)
export const ROAD_LEGS = Object.freeze([
  Object.freeze({ from: 'THE CRIMSON FORD', to: 'THE DUSK SHRINE' }),
  Object.freeze({ from: 'THE DUSK SHRINE', to: 'THE FROZEN FOUNDRY' }),
]);

// Fixed integer hash -> [0,1). Used for collider placement so the doc is identical everywhere (no RNG state).
export function rhash(i, k) {
  let h = (i * 374761393 + k * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Lantern posts (also the 4 point-light slot candidates). Alternating sides of the road.
export function roadLanterns() {
  const out = [];
  let i = 0;
  for (let z = ROAD.SPAWN_Z - 4; z > ROAD.GATE_Z + 4; z -= ROAD.LANTERN_EVERY, i++) {
    const s = i % 2 ? 1 : -1;
    out.push([roadX(z) + s * ROAD.LANTERN_OFF, z]);
  }
  return out;
}

// Boulders beside the road (cyl colliders). Kept off the road band and off ambush spawn points.
export function roadBoulders() {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const z = ROAD.SPAWN_Z - 8 - i * 7.4 - rhash(i, 1) * 3;
    if (z < ROAD.GATE_Z + 8) break;
    const side = rhash(i, 2) < 0.5 ? -1 : 1;
    let x = roadX(z) + side * (ROAD.WIDTH * 0.5 + 1.6 + rhash(i, 3) * 2.4);
    x = Math.max(-ROAD.HALF_X + 1.2, Math.min(ROAD.HALF_X - 1.2, x));
    out.push([x, z, 0.55 + rhash(i, 4) * 0.7]);
  }
  return out;
}

// The collider document for Colliders (same schema as the arena docs). Built, not fetched: one definition.
export function makeRoadDoc() {
  const col = [];
  roadLanterns().forEach(([x, z], i) => col.push({ name: 'COL_rlantern_' + i, kind: 'cyl', center: [x, 0.9, z], radius: 0.32, halfHeight: 0.9, surface: 'STONE_LANTERN' }));
  roadBoulders().forEach(([x, z, r], i) => col.push({ name: 'COL_rboulder_' + i, kind: 'cyl', center: [x, 0.6, z], radius: r, halfHeight: 0.6 + r * 0.4, surface: 'ROCK' }));
  // broken cart at the second ambush (cover), gate pillars at the end
  const cz = 9, cx = roadX(cz) - 2.9;
  col.push({ name: 'COL_cart', kind: 'obb', center: [cx, 0.55, cz], halfExtents: [0.8, 0.55, 1.4], yaw: 0.35, surface: 'WOOD_PLANK' });
  const gx = roadX(ROAD.GATE_Z);
  col.push({ name: 'COL_gate_l', kind: 'cyl', center: [gx - 2.7, 2.5, ROAD.GATE_Z], radius: 0.38, halfHeight: 2.5, surface: 'WOOD_BARK' });
  col.push({ name: 'COL_gate_r', kind: 'cyl', center: [gx + 2.7, 2.5, ROAD.GATE_Z], radius: 0.38, halfHeight: 2.5, surface: 'WOOD_BARK' });
  return {
    space: 'game (three.js Y-up, metres, north = -Z)', source: 'src/shared/road.js makeRoadDoc()', stage: 'road-120m',
    ground: { y: 0, heightProfile: { axis: 'abs(z)', points: [[0, 0], [80, 0]], interp: 'linear' }, surface: 'SAND', zones: [] },
    arena: { half: ROAD.HALF_Z, halfX: ROAD.HALF_X, halfZ: ROAD.HALF_Z, size: ROAD.HALF_Z * 2, flightCeiling: 11, playerSpawn: [roadX(ROAD.SPAWN_Z), 0, ROAD.SPAWN_Z] },
    colliders: col,
  };
}
