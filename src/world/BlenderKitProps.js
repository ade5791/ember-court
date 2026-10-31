// BlenderKit CC0 set dressing (assets/blenderkit/PROVENANCE.json). Presentation only: no colliders are added or
// changed, so the simulation and its determinism hash are untouched. Placement uses a fixed integer hash, never
// Math.random, so every capture is reproducible.
//  - stone lanterns: the blockout lantern stacks (lantern_N_base/post/firebox/roof) are hidden and replaced by the
//    scanned Japanese Stone Lantern, scaled so its firebox sits at the existing light slot height (1.54 m). The
//    blk_lantern_glow lamp mesh stays as the visible flame inside the firebox.
//  - rock debris (OFF by default, ?bkrocks=1): two scanned rocks as InstancedMeshes. Four A/B passes judged them a
//    style clash (sharp quarry scans vs the river-worn boulders), so the shipped look keeps only the lanterns.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const BK_ASSETS = Object.freeze({
  lantern: '/assets/blenderkit/lantern_tall.glb',
  rockA: '/assets/blenderkit/rock_07.glb',
  rockB: '/assets/blenderkit/rock_09.glb',
});
const LANTERN_SCALE = 1.42;       // native 1.487 m -> 2.11 m; on the 0.22 m bank the firebox centre (0.93 m native) lands at the 1.54 m light slot
const BLOCKOUT_LANTERN = /^lantern_\d_(base|post|firebox|roof)$/;

function hash(i, k) {             // deterministic [0,1)
  let h = (i * 374761393 + k * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function firstMesh(root) { let m = null; root.traverse((o) => { if (!m && o.isMesh) m = o; }); return m; }

export async function addBlenderKitProps({ scene, root, doc, colliders, base, anisotropy, rocks: withRocks = false }) {
  const L = new GLTFLoader();
  const [lg, ra, rb] = await Promise.all([BK_ASSETS.lantern, ...(withRocks ? [BK_ASSETS.rockA, BK_ASSETS.rockB] : [])]
    .map((u) => L.loadAsync(base + u)));
  const group = new THREE.Group(); group.name = 'blenderkit_props';
  const fixTex = (m) => {
    m.name = m.name.replace(/\.\d+$/, '');                       // Blender export suffixes; GorgeLook grades by name
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
      const t = m[k]; if (!t) continue; t.anisotropy = anisotropy; t.needsUpdate = true;
    }
  };

  // lanterns - one shared geometry/material, 4 meshes at the collider centres (constant draw cost, cast shadows)
  let hidden = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (BLOCKOUT_LANTERN.test(o.name)) { o.visible = false; hidden++; }
    else if (/^lantern_\d_lamp$/.test(o.name)) o.scale.multiplyScalar(0.55);   // flame card sits inside the scanned firebox
  });
  const lm = firstMesh(lg.scene); fixTex(lm.material);
  const lanterns = doc.colliders.filter((c) => /^COL_lantern_\d$/.test(c.name));
  lanterns.forEach((c, i) => {
    const m = new THREE.Mesh(lm.geometry, lm.material);
    m.name = 'bk_lantern_' + i;
    m.position.set(c.center[0], colliders.terrainY(c.center[2]), c.center[2]);
    m.scale.setScalar(LANTERN_SCALE);
    m.rotation.y = Math.atan2(-c.center[0], -c.center[2]);      // face the arena centre
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  });

  // rock debris (review-only)
  const spots = [];
  let rocks = [], inst = [], rockMat = null;
  if (withRocks) {
  const boulders = doc.colliders.filter((c) => /^COL_boulder_\d$/.test(c.name));
  boulders.forEach((b, bi) => {
    const a0 = hash(bi, 99) * Math.PI * 2;                       // one cluster arc per boulder
    for (let k = 0; k < 8; k++) {                                 // full ring, mixed sizes: 2 large, 6 small, varied radius
      const a = a0 + k * 0.785 + (hash(bi, k) - 0.5) * 0.5, r = b.radius * (1.15 + 0.5 * hash(bi, k + 9));   // stand clear of the flank: never fuse into the boulder
      spots.push([b.center[0] + Math.cos(a) * r, b.center[2] + Math.sin(a) * r, (k % 4 === 0 ? 2.2 : 1.1) + 1.0 * hash(bi, k + 17)]);
    }
  });
  const half = doc.arena.half;
  for (let i = 0; i < 28; i++) {           // rim band 0.6-1.6 m inside the walls
    const side = i % 4, u = (hash(100 + i, 1) * 2 - 1) * (half - 1.5), d = half - 0.6 - hash(100 + i, 2);
    const p = side === 0 ? [u, d] : side === 1 ? [u, -d] : side === 2 ? [d, u] : [-d, u];
    spots.push([p[0], p[1], 3.5 + 4.0 * hash(100 + i, 3)]);
  }
  rocks = [firstMesh(ra.scene), firstMesh(rb.scene)];
  for (const r of rocks) r.geometry.computeBoundingBox();
  const counts = [0, 0];
  spots.forEach((_, i) => counts[i % 2]++);
  // palette: the scans' own albedo is warm brown and read as dirt against the pale boulders, so the scanned SHAPES are
  // rendered with the arena's graded ford_rock material (same program as the boulders: no new shader permutation)
  root.traverse((o) => { if (!rockMat && o.isMesh && o.material.name === 'ford_rock') rockMat = o.material; });
  inst = rocks.map((src, j) => {
    fixTex(src.material);
    const im = new THREE.InstancedMesh(src.geometry, rockMat || src.material, counts[j]);
    im.name = 'bk_rocks_' + j; im.castShadow = true; im.receiveShadow = true;
    return im;
  });
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), S = new THREE.Vector3(), P = new THREE.Vector3();
  const fill = [0, 0];
  spots.forEach((s, i) => {
    const j = i % 2, sc = s[2] * (j === 1 ? 1.5 : 1);           // rock_09 is a flat 0.14 m chip: scaled + thickened below
    E.set((hash(i, 40) - 0.5) * 0.5, hash(i, 41) * Math.PI * 2, (hash(i, 42) - 0.5) * 0.5);
    Q.setFromEuler(E); S.set(sc, sc * (0.8 + 0.4 * hash(i, 43)) * (j === 1 ? 3 : 1), sc);   // thicken the flat chip
    // ground by the geometry's real base; in the ford the bed sits under the water, so lift bed stones until ~45% of
    // their height clears the surface (the opaque water hides the lifted base) - otherwise only the tallest chip shows
    const g = rocks[j].geometry.boundingBox, h = (g.max.y - g.min.y) * S.y;
    let y = colliders.terrainY(s[1]);
    if (Math.abs(s[1]) < doc.ford.riverHalfZ) y = Math.max(y, doc.ford.waterTop - 0.55 * h);
    P.set(s[0], y - g.min.y * S.y - 0.06 * h, s[1]);
    M.compose(P, Q, S); inst[j].setMatrixAt(fill[j]++, M);
  });
  for (const im of inst) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); group.add(im); }
  }

  scene.add(group);
  const mats = new Set([lm.material, ...(rockMat ? [] : rocks.map((r) => r.material))]);   // rocks = [] when off
  if (rockMat) for (const r of rocks) { for (const k in r.material) { const v = r.material[k]; if (v && v.isTexture) v.dispose(); } r.material.dispose(); }
  return {
    group, materials: mats, stats: { lanterns: lanterns.length, hiddenBlockout: hidden, rocks: spots.length },
    dispose() {
      scene.remove(group);
      for (const g of [lm.geometry, ...rocks.map((r) => r.geometry)]) g.dispose();
      for (const m of mats) { for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose(); }
      for (const im of inst) im.dispose();
    },
  };
}
