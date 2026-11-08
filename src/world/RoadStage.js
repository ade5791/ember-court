// RoadStage (v2.20) - the walkable mountain pass between two bosses. Presentation only: the sim reads the collider doc
// from src/shared/road.js (makeRoadDoc), never this. Layout comes from the SAME functions (roadX, roadLanterns,
// roadBoulders), so the visuals cannot drift from the collision.
// Art: the CC-BY Sketchfab road kit packed in Blender (assets/road/road-kit.glb, credits in
// assets/sketchfab/road-kit-sources.json) + a procedural packed-earth road ribbon and ground. Repeated props are
// InstancedMesh (one draw per kit primitive). No lights are added: the 4 point-light slots are moved to the 4
// lanterns nearest the hero each frame (positions only, no recompile), and the sun shadow box follows the hero.
import * as THREE from 'three';
import { ROAD, roadX, roadLanterns, roadBoulders } from '../shared/road.js';

const GROUND_X = 46, GROUND_Z = 150;

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, rx, ry, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); t.anisotropy = 4;
  return t;
}

// Ground: tiled mountain scrub (dry grass, dirt, gravel, small stones). Albedo + bump from one height field.
function paintGround(rng, N) {
  const [ca, a] = canvas(N, N), [cb, b] = canvas(N, N);
  a.fillStyle = '#47472a'; a.fillRect(0, 0, N, N); b.fillStyle = '#808080'; b.fillRect(0, 0, N, N);
  for (let i = 0; i < 900; i++) {           // dry grass and dirt blotches
    const x = rng.float() * N, y = rng.float() * N, r = rng.range(6, 30), k = rng.range(-18, 18) | 0, g = rng.float() < 0.55;
    a.fillStyle = g ? 'rgba(' + (84 + k) + ',' + (86 + k) + ',' + (44 + k) + ',0.4)' : 'rgba(' + (62 + k) + ',' + (54 + k) + ',' + (40 + k) + ',0.3)';
    a.beginPath(); a.arc(x, y, r, 0, 6.283); a.fill();
  }
  for (let i = 0; i < N * N / 40; i++) {     // grit
    const x = rng.float() * N, y = rng.float() * N, k = rng.range(-40, 30) | 0;
    a.fillStyle = 'rgb(' + (80 + k) + ',' + (72 + k) + ',' + (58 + k) + ')'; a.fillRect(x, y, 1.5, 1.5);
    b.fillStyle = k > 0 ? '#9a9a9a' : '#606060'; b.fillRect(x, y, 1.5, 1.5);
  }
  for (let i = 0; i < 260; i++) {            // pebbles with a lit top and a contact shadow
    const x = rng.float() * N, y = rng.float() * N, r = rng.range(1.5, 4.5), k = rng.range(-20, 25) | 0;
    a.fillStyle = 'rgba(20,16,12,0.45)'; a.beginPath(); a.ellipse(x + 1, y + 1.5, r * 1.1, r * 0.8, 0, 0, 6.283); a.fill();
    a.fillStyle = 'rgb(' + (108 + k) + ',' + (102 + k) + ',' + (92 + k) + ')'; a.beginPath(); a.ellipse(x, y, r, r * 0.75, 0, 0, 6.283); a.fill();
    b.fillStyle = '#c8c8c8'; b.beginPath(); b.ellipse(x, y, r, r * 0.75, 0, 0, 6.283); b.fill();
  }
  for (let i = 0; i < 1400; i++) {           // grass strokes
    const x = rng.float() * N, y = rng.float() * N, l = rng.range(3, 9), k = rng.range(-20, 20) | 0;
    a.strokeStyle = 'rgba(' + (112 + k) + ',' + (104 + k) + ',' + (58 + k) + ',0.55)'; a.lineWidth = 1;
    a.beginPath(); a.moveTo(x, y); a.lineTo(x + rng.range(-2, 2), y - l); a.stroke();
  }
  return [ca, cb];
}

// Road band: packed earth along v (road length), two cart ruts, stones pressed in at the edges.
function paintRoad(rng, W, H) {
  const [ca, a] = canvas(W, H), [cb, b] = canvas(W, H);
  a.fillStyle = '#8f7656'; a.fillRect(0, 0, W, H); b.fillStyle = '#8a8a8a'; b.fillRect(0, 0, W, H);
  for (let i = 0; i < W * H / 30; i++) {
    const x = rng.float() * W, y = rng.float() * H, k = rng.range(-30, 24) | 0;
    a.fillStyle = 'rgb(' + (112 + k) + ',' + (92 + k) + ',' + (70 + k) + ')'; a.fillRect(x, y, 1.6, 1.6);
  }
  for (const u of [0.3, 0.7]) {              // ruts: darker, smoother, slightly sunken
    const g = a.createLinearGradient(W * (u - 0.07), 0, W * (u + 0.07), 0);
    g.addColorStop(0, 'rgba(48,34,24,0)'); g.addColorStop(0.5, 'rgba(48,34,24,0.36)'); g.addColorStop(1, 'rgba(48,34,24,0)');
    a.fillStyle = g; a.fillRect(W * (u - 0.07), 0, W * 0.14, H);
    const gb = b.createLinearGradient(W * (u - 0.07), 0, W * (u + 0.07), 0);
    gb.addColorStop(0, 'rgba(60,60,60,0)'); gb.addColorStop(0.5, 'rgba(60,60,60,0.8)'); gb.addColorStop(1, 'rgba(60,60,60,0)');
    b.fillStyle = gb; b.fillRect(W * (u - 0.07), 0, W * 0.14, H);
  }
  for (let i = 0; i < 160; i++) {            // edge stones
    const side = rng.float() < 0.5 ? rng.range(0.0, 0.14) : rng.range(0.86, 1.0);
    const x = side * W, y = rng.float() * H, r = rng.range(2, 6), k = rng.range(-16, 20) | 0;
    a.fillStyle = 'rgba(25,18,12,0.5)'; a.beginPath(); a.ellipse(x + 1, y + 2, r, r * 0.8, 0, 0, 6.283); a.fill();
    a.fillStyle = 'rgb(' + (120 + k) + ',' + (114 + k) + ',' + (104 + k) + ')'; a.beginPath(); a.ellipse(x, y, r, r * 0.75, 0, 0, 6.283); a.fill();
    b.fillStyle = '#d0d0d0'; b.beginPath(); b.ellipse(x, y, r, r * 0.75, 0, 0, 6.283); b.fill();
  }
  return [ca, cb];
}

// Ribbon following roadX(z): 4 verts across, outer pair fades to alpha 0 so the band blends into the ground.
function roadRibbon() {
  const zs = []; for (let z = -GROUND_Z * 0.5; z <= GROUND_Z * 0.5 + 1e-6; z += 1) zs.push(z);
  const hw = ROAD.WIDTH * 0.5, xs = [-hw - 1.2, -hw + 0.3, hw - 0.3, hw + 1.2], us = [0, 0.1, 0.9, 1], al = [0, 1, 1, 0];
  const pos = [], uv = [], col = [], idx = [];
  zs.forEach((z, j) => {
    const cx = roadX(z), d = (roadX(z + 0.5) - roadX(z - 0.5)), n = Math.hypot(1, d), nx = 1 / n, nz = -d / n;
    for (let i = 0; i < 4; i++) {
      pos.push(cx + nx * xs[i], 0.012, z + nz * xs[i]); uv.push(us[i], z / 8); col.push(1, 1, 1, al[i]);
    }
    if (j) for (let i = 0; i < 3; i++) { const a = (j - 1) * 4 + i, b = j * 4 + i; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

export class RoadStage {
  // kit: the loaded road-kit gltf (scene with KIT_<name> roots); rng: a seeded stream
  build({ scene, quality, rng, kit, spire = null }) {
    this.root = new THREE.Group(); this.root.name = 'road'; this.root.visible = false;
    this.geometries = []; this.textures = []; this.materials = []; this.instanced = [];
    this.lanterns = roadLanterns();
    const R = rng, hi = quality && quality.name !== 'low';

    // ground + road ribbon
    const [ga, gb] = paintGround(R, hi ? 1024 : 512);
    const gMap = tex(ga, GROUND_X / 7, GROUND_Z / 7), gBump = tex(gb, GROUND_X / 7, GROUND_Z / 7, false);
    const gMat = new THREE.MeshStandardMaterial({ map: gMap, bumpMap: gBump, bumpScale: 1.2, roughness: 0.96, metalness: 0 });
    const gGeo = new THREE.PlaneGeometry(GROUND_X, GROUND_Z, 1, 1);
    const ground = new THREE.Mesh(gGeo, gMat); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.name = 'road_ground';
    this.root.add(ground);
    const [ra, rb] = paintRoad(R, 256, 1024);
    const rMap = tex(ra, 1, 1), rBump = tex(rb, 1, 1, false);
    const rMat = new THREE.MeshStandardMaterial({ map: rMap, bumpMap: rBump, bumpScale: 1.6, roughness: 0.92, metalness: 0,
      vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const rGeo = roadRibbon();
    const ribbon = new THREE.Mesh(rGeo, rMat); ribbon.receiveShadow = true; ribbon.renderOrder = 1; ribbon.name = 'road_band';
    this.root.add(ribbon);
    this.geometries.push(gGeo, rGeo); this.textures.push(gMap, gBump, rMap, rBump); this.materials.push(gMat, rMat);

    // kit placements (x, z, yaw, scale) per kit node; every list is deterministic from R
    const P = {}; const put = (name, x, z, yaw = 0, s = 1, y = 0, tilt = 0) => (P[name] || (P[name] = [])).push([x, z, yaw, s, y, tilt]);
    const side = (z, off) => roadX(z) + off;
    // walls of the pass: the camera's outer clamp is |x| = HALF_X + 4.65, so tall rock starts beyond 14.2
    for (let z = -64, i = 0; z <= 64; z += 17, i++) {
      for (const s of [-1, 1]) {
        const k = R.range(0.95, 1.25), yaw = (s > 0 ? -Math.PI / 2 : Math.PI / 2);
        put('KIT_rockface', s * R.range(17.5, 19.5), z + R.range(-3, 3), yaw + R.range(-0.3, 0.3), [k * R.range(0.8, 1.1), k * R.range(0.7, 1.35), k], -R.range(0.4, 2.2), R.range(-0.14, 0.14));
        // upper ridge, offset half a bay and lifted, so the skyline steps instead of running flat
        const k2 = R.range(1.1, 1.5);
        put('KIT_rockface', s * R.range(23, 26), z + 8.5 + R.range(-3, 3), yaw + Math.PI + R.range(-0.5, 0.5), [k2, k2 * R.range(0.9, 1.5), k2 * 0.8], R.range(1.0, 4.5), R.range(-0.2, 0.2));
        put('KIT_rockface', s * R.range(30, 36), z + 8 + R.range(-4, 4), yaw + R.range(-0.4, 0.4), [R.range(1.8, 2.4), R.range(1.6, 3.0), 2.0], -R.range(0, 3), R.range(-0.15, 0.15));
        // scree skirt at the wall foot (beyond the 14.2 m outer camera clamp, any height is fine)
        for (let j = 0; j < 3; j++) { const sc = R.range(1.2, 2.6);
          put(R.float() < 0.5 ? 'KIT_rocks_8' : R.float() < 0.5 ? 'KIT_rocks_3' : 'KIT_rocks_4', s * R.range(15.0, 17.2), z + R.range(-8, 8), R.range(0, 6.283), sc, -0.15 * sc, R.range(-0.3, 0.3)); }
      }
    }
    // end caps: rock behind the spawn and around the gate so the pass reads closed at both ends
    const cap = (cx, cz, yaw0, dir) => {
      for (const x of [-16, -7, 3, 13]) { const k = R.range(1.0, 1.4);
        put('KIT_rockface', cx + x + R.range(-2, 2), cz + dir * (R.range(0, 5) + Math.abs(x) * 0.15), yaw0 + R.range(-0.6, 0.6),
          [k * R.range(0.55, 0.9), k * R.range(0.8, 1.7), k], -R.range(0.5, 2.5), R.range(-0.22, 0.22)); }
      for (const x of [-10, 9]) { const k = R.range(1.4, 1.9);   // far peaks lift the skyline into steps
        put('KIT_rockface', cx + x + R.range(-4, 4), cz + dir * R.range(14, 20), yaw0 + Math.PI * 0.5 + R.range(-0.5, 0.5),
          [k * 0.6, k * R.range(1.5, 2.2), k * 0.7], R.range(0, 3), R.range(-0.2, 0.2)); }
    };
    cap(0, ROAD.SPAWN_Z + 12, Math.PI, 1);
    cap(roadX(ROAD.GATE_Z), ROAD.GATE_Z - 8, 0, -1);
    // fence along both edges of the walkable floor (|x| = HALF_X) - the visible reason the hero stops there
    for (let z = -58; z <= 58; z += 2.4) for (const s of [-1, 1]) if (R.float() < 0.78) put('KIT_fence', s * (ROAD.HALF_X + 0.35), z, Math.PI / 2 + R.range(-0.08, 0.08), R.range(0.9, 1.05));
    // trees and bamboo between the fence and the rock walls (camera can be here above 1.37 m: keep them beyond 14)
    for (let z = -60; z <= 60; z += 5.5) for (const s of [-1, 1]) {
      const x = s * R.range(14.4, 17), k = R.float();
      put(k < 0.42 ? 'KIT_pine' : k < 0.7 ? 'KIT_deadtree' : k < 0.86 ? 'KIT_deadtree2' : 'KIT_bamboo', x, z + R.range(-2, 2), R.range(0, 6.283), R.range(0.8, 1.2));
    }
    // short clutter inside the fence band and just outside it (under the camera's 1.37 m inner-clamp height)
    const smallRocks = [0, 1, 4, 5, 6, 7, 9, 10], grassN = 15;
    for (let i = 0; i < (hi ? 2600 : 1000); i++) {
      const z = R.range(-62, 62), s = R.float() < 0.5 ? -1 : 1, x = roadX(z) * (R.float() < 0.5 ? 1 : 0) + s * R.range(ROAD.WIDTH * 0.5 + 1.0, 15.5);
      if (Math.abs(x) > 15.5) continue;
      if (Math.abs(x - roadX(z)) < ROAD.WIDTH * 0.5 + 0.9) continue;
      put('KIT_grass_' + (R.int ? R.int(0, grassN - 1) : (R.float() * grassN | 0)), x, z, R.range(0, 6.283), R.range(0.9, 1.8));
    }
    for (let i = 0; i < (hi ? 900 : 360); i++) {
      const z = R.range(-62, 62), s = R.float() < 0.5 ? -1 : 1, x = roadX(z) + s * (ROAD.WIDTH * 0.5 + R.range(0.7, 2.0));
      if (Math.abs(x) > ROAD.HALF_X - 0.2) continue;
      put('KIT_grass_' + (R.float() * grassN | 0), x, z, R.range(0, 6.283), R.range(0.55, 1.2), -0.04);
    }
    for (let i = 0; i < 70; i++) {
      const z = R.range(-62, 62), s = R.float() < 0.5 ? -1 : 1, x = roadX(z) + s * R.range(ROAD.WIDTH * 0.5 + 1.2, 12), sc = R.range(0.8, 1.6);
      if (Math.abs(x) > 13.6) continue;
      put('KIT_rocks_' + smallRocks[R.float() * smallRocks.length | 0], x, z, R.range(0, 6.283), sc, -0.06 * sc, R.range(-0.25, 0.25));
    }
    // rock clusters along the fence line: breaks up the long empty shoulders between ambush spots
    for (let z = -56; z <= 56; z += 9) for (const s of [-1, 1]) if (R.float() < 0.6) {
      const cx = s * R.range(ROAD.HALF_X - 1.6, ROAD.HALF_X - 0.4), cz = z + R.range(-3, 3);
      for (let j = 0; j < 3; j++) { const sc = R.range(0.7, 1.3);
        put('KIT_rocks_' + [1, 4, 6, 7][R.float() * 4 | 0], cx + R.range(-0.7, 0.7), cz + R.range(-1, 1), R.range(0, 6.283), sc, -0.08 * sc, R.range(-0.3, 0.3)); }
    }
    // collider boulders: big kit rocks scaled to the collider radius (rocks_2 is 2.18 x 1.61 m footprint)
    for (const [x, z, r] of roadBoulders()) put(R.float() < 0.5 ? 'KIT_rocks_2' : 'KIT_rocks_3', x, z, R.range(0, 6.283), r / 0.9, -0.16 * r);
    // lanterns (collider cyl r 0.32), the broken wagon (collider obb yaw 0.35, long axis Z), signpost at the spawn
    for (const [x, z] of this.lanterns) put('KIT_lamp', x, z, R.range(0, 6.283), 1);
    { const cz = 9, cx = roadX(cz) - 2.9; put('KIT_wagon', cx, cz, 0.35 + Math.PI / 2, 0.92); }
    put('KIT_sign', roadX(ROAD.SPAWN_Z - 3) + 3.2, ROAD.SPAWN_Z - 3, -0.5, 1);
    // torii at the gate: pillars land on the COL_gate colliders (+-2.7 m)
    put('KIT_torii', roadX(ROAD.GATE_Z), ROAD.GATE_Z, 0, 0.74);
    // v2.22 S5: jagged Blender spires (assets/road/spire.glb, tools/blender/author_spire.py) on the cliff tops.
    // Drawn last from R so every earlier placement is unchanged. Between the lower wall and the upper ridge,
    // lifted onto the rock, leaning outward; all beyond the 14.2 m outer camera clamp.
    if (spire) {
      const SP = ['SPIRE_a', 'SPIRE_b', 'SPIRE_c'];
      for (let z = -60; z <= 60; z += 11) for (const s of [-1, 1]) {
        if (R.float() < 0.22) continue;
        const k = R.range(0.8, 1.35);
        put(SP[R.float() * 3 | 0], s * R.range(19.5, 27), z + R.range(-4, 4), R.range(0, 6.283), [k, k * R.range(0.85, 1.4), k], R.range(1.5, 5.5), s * R.range(-0.18, 0.02));
      }
      for (const cz of [ROAD.SPAWN_Z + 24, ROAD.GATE_Z - 24]) for (const x of [-14, 12]) {
        const k = R.range(1.1, 1.5);
        put(SP[R.float() * 3 | 0], roadX(cz) + x + R.range(-3, 3), cz + R.range(-3, 3), R.range(0, 6.283), [k, k * R.range(1.2, 1.7), k], R.range(2, 5), R.range(-0.12, 0.12));
      }
    }

    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    const _rel = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _qt = new THREE.Quaternion(), _ax = new THREE.Vector3(1, 0, 0);
    kit.scene.updateMatrixWorld(true);
    // spires share the kit's RocksStylized material (same program, no new shader permutation; box-projected UVs)
    let rockMat = null;
    { const r2 = kit.scene.getObjectByName('KIT_rocks_2'); if (r2) r2.traverse((o) => { if (!rockMat && o.isMesh) rockMat = Array.isArray(o.material) ? o.material[0] : o.material; }); }
    if (spire) { spire.scene.updateMatrixWorld(true);
      if (rockMat) spire.scene.traverse((o) => { if (o.isMesh) { const old = o.material; o.material = rockMat; if (old && old !== rockMat && old.dispose) old.dispose(); } });
      spire.scene.traverse((o) => { if (o.isMesh) this.geometries.push(o.geometry); }); }
    this.missing = [];
    for (const name in P) {
      const node = (/^SPIRE_/.test(name) && spire ? spire.scene : kit.scene).getObjectByName(name);
      if (!node) { this.missing.push(name); continue; }
      const list = P[name], big = /rockface|SPIRE|pine|deadtree|torii|wagon|lamp|bamboo|rocks_2|rocks_3/.test(name);
      _inv.copy(node.matrixWorld).invert();
      node.traverse((o) => {
        if (!o.isMesh) return;
        _rel.multiplyMatrices(_inv, o.matrixWorld);
        const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
        im.name = 'road_' + name.slice(4) + '_' + o.name;
        list.forEach(([x, z, yaw, s, y, tilt], i) => {
          _q.setFromAxisAngle(_up, yaw); if (tilt) _q.multiply(_qt.setFromAxisAngle(_ax, tilt));
          _p.set(x, y || 0, z); if (Array.isArray(s)) _s.set(s[0], s[1], s[2]); else _s.set(s, s, s);
          _m.compose(_p, _q, _s).multiply(_rel); im.setMatrixAt(i, _m);
        });
        im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere();
        im.castShadow = big; im.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m && /RocksStylized/i.test(m.name) && !m.userData.roadTint) { m.userData.roadTint = true; m.color.setRGB(0.50, 0.47, 0.42); m.roughness = Math.max(m.roughness, 0.9); }
          if (m && m.envMapIntensity !== undefined) m.envMapIntensity = 0.6; if (m && /grass/i.test(m.name)) { m.alphaTest = Math.max(m.alphaTest || 0, 0.4); m.side = THREE.DoubleSide; } }
        this.root.add(im); this.instanced.push(im);
      });
    }

    // lantern flames: small emissive cores so the lit lanterns read at distance (the light comes from the 4 slots)
    const fGeo = new THREE.SphereGeometry(0.11, 10, 8), fMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.62, 0.28).multiplyScalar(3.2), toneMapped: true, fog: true });
    const flames = new THREE.InstancedMesh(fGeo, fMat, this.lanterns.length);
    this.lanterns.forEach(([x, z], i) => { _m.makeTranslation(x, 1.55, z); flames.setMatrixAt(i, _m); });
    flames.instanceMatrix.needsUpdate = true; flames.computeBoundingSphere(); flames.name = 'road_flames';
    this.root.add(flames); this.geometries.push(fGeo); this.materials.push(fMat);

    // gate veil between the torii pillars: dim ember-red while the pass is held, bright gold once every ambush fell
    // v2.23: the veil was a flat additive card and read as an untextured slab once it went gold. Now it is a
    // heat-haze curtain: soft side/top falloff, bright at the ground, deterministic vertical streaks (from R)
    const VW = 64, VH = 128, vData = new Uint8Array(VW * VH * 4), streak = new Float32Array(VW);
    for (let x = 0; x < VW; x++) streak[x] = 0.55 + 0.45 * R.float();
    for (let x = 1; x < VW - 1; x++) streak[x] = (streak[x - 1] + streak[x] * 2 + streak[x + 1]) * 0.25;
    for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
      const u = x / (VW - 1), v = y / (VH - 1);                     // v = 0 at the ground
      const side = Math.pow(Math.sin(Math.PI * u), 0.8), top = Math.pow(1 - v, 1.6);
      const a = side * top * streak[x] * (0.75 + 0.25 * Math.sin(v * 21 + u * 9));
      const i = (y * VW + x) * 4, g = Math.round(255 * Math.max(0, Math.min(1, a)));
      vData[i] = g; vData[i + 1] = g; vData[i + 2] = g; vData[i + 3] = 255;
    }
    const vTex = new THREE.DataTexture(vData, VW, VH); vTex.magFilter = THREE.LinearFilter; vTex.minFilter = THREE.LinearFilter;
    vTex.needsUpdate = true; this.textures.push(vTex);
    const vGeo = new THREE.PlaneGeometry(5.0, 5.2), vMat = new THREE.MeshBasicMaterial({ color: 0xff3a1a, map: vTex, transparent: true, opacity: 0.18,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.veil = new THREE.Mesh(vGeo, vMat); this.veil.position.set(roadX(ROAD.GATE_Z), 2.6, ROAD.GATE_Z); this.veil.name = 'road_gate_veil';
    this.root.add(this.veil); this.geometries.push(vGeo); this.materials.push(vMat);
    this._veilOpen = new THREE.Color(1.0, 0.78, 0.35); this._veilShut = new THREE.Color(1.0, 0.23, 0.10); this._open = 0; this._t = 0;
    scene.add(this.root);
    return this;
  }

  setVisible(v) { this.root.visible = v; }

  // Per presented frame while on the road. rig: the arena light rig (points[4], sun); dir: unit sun direction.
  update(heroZ, cleared, dt, rig, sunDir, sunDist) {
    // lantern i always lives in slot i % 4: a window of 4 consecutive lanterns centred on the hero
    const L = this.lanterns, n = L.length;
    let near = 0, bd = 1e9; for (let i = 0; i < n; i++) { const d = Math.abs(L[i][1] - heroZ); if (d < bd) { bd = d; near = i; } }
    const start = Math.max(0, Math.min(n - 4, near - 1 - (L[near][1] < heroZ ? 0 : 1) + 1));
    for (let k = 0; k < 4 && k < rig.points.length; k++) {
      const i = start + k, p = rig.points[i % 4];
      if (L[i]) p.position.set(L[i][0], 1.7, L[i][1]);
    }
    // sun shadow box (48 m square) follows the hero down the 120 m road
    if (rig.sun && sunDir) {
      rig.sun.target.position.set(roadX(heroZ), 0, heroZ - 4);
      rig.sun.position.set(rig.sun.target.position.x + sunDir[0] * sunDist, sunDir[1] * sunDist, rig.sun.target.position.z + sunDir[2] * sunDist);
      rig.sun.target.updateMatrixWorld();
    }
    this._t += dt;
    const k = Math.min(1, dt * 2.5); this._open += ((cleared ? 1 : 0) - this._open) * k;
    const m = this.veil.material;
    m.color.copy(this._veilShut).lerp(this._veilOpen, this._open);
    m.opacity = 0.22 + this._open * (0.5 + 0.1 * Math.sin(this._t * 3.1));   // map now carries the falloff, so peak runs higher
  }

  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const im of this.instanced) im.dispose();
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
  }
}
