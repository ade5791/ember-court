// ShrineStage - procedural Stage 2 Dusk Shrine courtyard (docs/STAGE2_SPEC.md section 4). Zero art assets: every
// texture is painted on a canvas at load from the seeded 'shrine' stream, so two loads are pixel-identical.
// Layout matches assets/shrine-colliders.json (4 lacquered pillars, 4 low stone parapets, 4 corner stone lanterns
// that anchor the 4 point-light slots). Backdrop (main hall, gate, maples, cedar line) stands at |x|,|z| >= 21.2,
// past the camera outer clamp (20.65), so the camera can never enter it. Presentation only: the sim reads the
// collider doc, never this. Materials are MeshStandardMaterial (same program family as the ford and foundry).
import * as THREE from 'three';

const HALF = 16, FLOOR_EXT = 21.2;
export const SHRINE_PILLARS = Object.freeze([[-11, -11], [11, -11], [-11, 11], [11, 11]]);

function canvas(n) { const c = document.createElement('canvas'); c.width = c.height = n; return [c, c.getContext('2d')]; }
function tex(c, { srgb = true, repeat = 1, aniso = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Floor: one canvas over the full 2*FLOOR_EXT square. Running-bond granite flagstones inside the parapet, a raked
// gravel band at the edge, a darker inlaid duel circle at the centre, moss in the joints and fallen maple leaves.
function paintFloor(rng, N) {
  const [ca, a] = canvas(N), [cr, r] = canvas(N), [cb, b] = canvas(N);
  const S = N / (FLOOR_EXT * 2), P = (m) => (m + FLOOR_EXT) * S;
  // gravel everywhere first (outside the flagstones and in the edge band)
  a.fillStyle = '#5d5650'; a.fillRect(0, 0, N, N); r.fillStyle = 'rgb(0,235,0)'; r.fillRect(0, 0, N, N); b.fillStyle = '#7a7a7a'; b.fillRect(0, 0, N, N);
  for (let i = 0; i < N * N / 60; i++) {
    const x = rng.float() * N, y = rng.float() * N, k = rng.range(-30, 30) | 0, s = rng.range(1, 2.6);
    a.fillStyle = 'rgb(' + (96 + k) + ',' + (89 + k) + ',' + (82 + k) + ')'; a.fillRect(x, y, s, s);
    b.fillStyle = k > 0 ? '#9a9a9a' : '#5a5a5a'; b.fillRect(x, y, s, s);
  }
  // raked lines in the gravel band (concentric squares)
  a.strokeStyle = 'rgba(30,26,24,0.35)'; a.lineWidth = Math.max(1, 0.05 * S);
  for (let d = 13.8; d < FLOOR_EXT; d += 0.35) a.strokeRect(P(-d), P(-d), 2 * d * S, 2 * d * S);
  // flagstones (running bond, rows along X) inside |x|,|z| < 13.6
  const L0 = -13.6, L1 = 13.6;
  for (let z = L0, row = 0; z < L1; z += 1.2, row++) {
    let x = L0 - (row % 2 ? 0.7 : 0);
    while (x < L1) {
      const w = rng.range(1.2, 2.2), x0 = Math.max(L0, x), x1 = Math.min(L1, x + w), z1 = Math.min(L1, z + 1.2);
      const k = rng.range(-16, 16) | 0, warm = rng.range(-6, 6) | 0;
      a.fillStyle = 'rgb(' + (118 + k + warm) + ',' + (112 + k) + ',' + (106 + k - warm) + ')';
      a.fillRect(P(x0) + 2, P(z) + 2, (x1 - x0) * S - 4, (z1 - z) * S - 4);
      r.fillStyle = 'rgb(0,' + (178 + rng.range(-24, 24) | 0) + ',0)'; r.fillRect(P(x0) + 2, P(z) + 2, (x1 - x0) * S - 4, (z1 - z) * S - 4);
      b.fillStyle = '#a0a0a0'; b.fillRect(P(x0) + 2, P(z) + 2, (x1 - x0) * S - 4, (z1 - z) * S - 4);
      // speckle + chips on each stone
      for (let i = 0; i < 26; i++) {
        const px = P(x0) + rng.float() * (x1 - x0) * S, pz = P(z) + rng.float() * (z1 - z) * S, kk = rng.range(-30, 20) | 0;
        a.fillStyle = 'rgba(' + (110 + kk) + ',' + (104 + kk) + ',' + (98 + kk) + ',0.6)'; a.fillRect(px, pz, rng.range(1, 4), rng.range(1, 4));
      }
      x += w;
    }
  }
  // moss in the joints near the parapet and pillars (green-black smudges along the gaps)
  // (v2: thin elongated streaks, axis-aligned with the joints, instead of round dots that tiled as polka dots)
  for (let i = 0; i < 1100; i++) {
    const x = rng.range(L0, L1), z = rng.range(L0, L1), edge = Math.max(Math.abs(x), Math.abs(z));
    if (edge < 9 && rng.float() > 0.18) continue;
    a.fillStyle = 'rgba(42,54,32,' + rng.range(0.14, 0.38).toFixed(2) + ')';
    const l = rng.range(0.08, 0.34) * S, w = rng.range(0.012, 0.035) * S;
    if (rng.float() < 0.5) a.fillRect(P(x), P(z), l, w); else a.fillRect(P(x), P(z), w, l);
  }
  // inlaid duel circle: two dark granite rings with a compass of eight short spokes
  for (const [rad, w] of [[6.0, 0.22], [5.55, 0.08]]) {
    a.strokeStyle = 'rgba(36,32,32,0.85)'; a.lineWidth = w * S; a.beginPath(); a.arc(P(0), P(0), rad * S, 0, 6.283); a.stroke();
    b.strokeStyle = '#505050'; b.lineWidth = w * S; b.beginPath(); b.arc(P(0), P(0), rad * S, 0, 6.283); b.stroke();
  }
  a.strokeStyle = 'rgba(36,32,32,0.75)'; a.lineWidth = 0.08 * S;
  for (let i = 0; i < 8; i++) { const t = i * Math.PI / 4; a.beginPath(); a.moveTo(P(Math.cos(t) * 5.0), P(Math.sin(t) * 5.0)); a.lineTo(P(Math.cos(t) * 6.4), P(Math.sin(t) * 6.4)); a.stroke(); }
  // fallen maple leaves, thicker under the corner maples and against the parapet
  for (let i = 0; i < 2600; i++) {
    let x = rng.range(-FLOOR_EXT, FLOOR_EXT), z = rng.range(-FLOOR_EXT, FLOOR_EXT);
    const edge = Math.max(Math.abs(x), Math.abs(z)); if (edge < 7 && rng.float() > 0.15) continue;
    const s = rng.range(0.05, 0.11) * S, rot = rng.range(0, 6.283), k = rng.range(0, 1);
    a.save(); a.translate(P(x), P(z)); a.rotate(rot);
    a.fillStyle = k < 0.6 ? 'rgb(' + (120 + rng.range(-20, 30) | 0) + ',18,16)' : k < 0.85 ? 'rgb(150,52,18)' : 'rgb(78,20,18)';
    a.beginPath(); for (let j = 0; j < 5; j++) { const t = j * 1.2566 - 1.57; a.lineTo(Math.cos(t) * s, Math.sin(t) * s); a.lineTo(Math.cos(t + 0.63) * s * 0.42, Math.sin(t + 0.63) * s * 0.42); } a.closePath(); a.fill();
    a.restore();
  }
  return { ca, cr, cb };
}

// weathered granite for parapets, lanterns and steps (512, tileable): blotchy value noise + lichen + grime at the base
function paintStone(rng, N) {
  const [ca, a] = canvas(N);
  a.fillStyle = '#7d7670'; a.fillRect(0, 0, N, N);
  for (let i = 0; i < 2200; i++) {
    const x = rng.float() * N, y = rng.float() * N, k = rng.range(-26, 22) | 0, s = rng.range(2, 18);
    a.fillStyle = 'rgba(' + (122 + k) + ',' + (116 + k) + ',' + (110 + k) + ',0.35)'; a.beginPath(); a.arc(x, y, s, 0, 6.283); a.fill();
  }
  for (let i = 0; i < 120; i++) { a.fillStyle = 'rgba(70,86,52,0.35)'; a.beginPath(); a.arc(rng.float() * N, rng.float() * N, rng.range(3, 14), 0, 6.283); a.fill(); }
  const g = a.createLinearGradient(0, N, 0, N * 0.5); g.addColorStop(0, 'rgba(24,20,18,0.55)'); g.addColorStop(1, 'rgba(24,20,18,0)');
  a.fillStyle = g; a.fillRect(0, 0, N, N);
  return ca;
}

// cinnabar lacquer for pillars and the gate: vertical brush streaks, worn to black at edges and the base
function paintLacquer(rng, N) {
  const [ca, a] = canvas(N);
  a.fillStyle = '#8e2016'; a.fillRect(0, 0, N, N);
  for (let i = 0; i < 700; i++) {
    const x = rng.float() * N, l = rng.range(20, 200), y = rng.float() * N, k = rng.range(-30, 20) | 0;
    a.fillStyle = 'rgba(' + (150 + k) + ',' + (34 + (k >> 1)) + ',' + (22 + (k >> 2)) + ',0.30)'; a.fillRect(x, y, rng.range(1, 3), l);
  }
  for (let i = 0; i < 90; i++) { a.fillStyle = 'rgba(28,10,8,0.45)'; a.fillRect(rng.float() * N, rng.float() * N, rng.range(4, 30), rng.range(1, 3)); }
  const g = a.createLinearGradient(0, N, 0, N * 0.7); g.addColorStop(0, 'rgba(18,8,6,0.8)'); g.addColorStop(1, 'rgba(18,8,6,0)');
  a.fillStyle = g; a.fillRect(0, 0, N, N);
  return ca;
}

// lime plaster for the hall walls (512): warm off-white with dark timber posts/rails painted in (so a single box
// reads as a framed wall), rain streaks from the eave, and grime rising from the plinth
function paintPlaster(rng, N) {
  const [ca, a] = canvas(N);
  a.fillStyle = '#a99a86'; a.fillRect(0, 0, N, N);
  for (let i = 0; i < 1600; i++) {
    const k = rng.range(-18, 14) | 0; a.fillStyle = 'rgba(' + (172 + k) + ',' + (158 + k) + ',' + (138 + k) + ',0.28)';
    a.beginPath(); a.arc(rng.float() * N, rng.float() * N, rng.range(2, 14), 0, 6.283); a.fill();
  }
  for (let i = 0; i < 160; i++) { a.fillStyle = 'rgba(60,48,40,' + rng.range(0.05, 0.16).toFixed(2) + ')'; a.fillRect(rng.float() * N, 0, rng.range(1, 4), rng.range(N * 0.2, N * 0.7)); }
  const g = a.createLinearGradient(0, N, 0, N * 0.6); g.addColorStop(0, 'rgba(40,30,24,0.6)'); g.addColorStop(1, 'rgba(40,30,24,0)');
  a.fillStyle = g; a.fillRect(0, 0, N, N);
  a.fillStyle = '#2e211a';
  for (let x = 0; x < N; x += N / 4) a.fillRect(x, 0, N * 0.035, N);           // posts
  a.fillRect(0, N * 0.30, N, N * 0.03); a.fillRect(0, N * 0.86, N, N * 0.05);   // head rail + sill
  return ca;
}

// hip roof with a slight eave flare: a 4-sided cone (rotated so its faces align with the walls) squashed flat,
// stacked twice. Shared geometry, scaled per building.
function roofGeo() { const g = new THREE.ConeGeometry(Math.SQRT2 * 0.5, 1, 4, 1); g.rotateY(Math.PI / 4); g.translate(0, 0.5, 0); return g; }

export class ShrineStage {
  static id = 'shrine';

  // opts: { scene, quality, rng (Rng; the 'shrine' stream is forked from it), doc (collider doc) }
  build({ quality, rng, doc }) {
    const R = rng.stream('shrine'), aniso = quality.anisotropy || 4;
    const root = this.root = new THREE.Group(); root.name = 'shrine_arena'; root.visible = false;
    const mats = this.materials = new Set(), texs = this.textures = new Set(), geos = this.geometries = new Set();
    const T = (t) => { texs.add(t); return t; }, M = (m) => { mats.add(m); return m; }, G = (g) => { geos.add(g); return g; };
    const add = (geo, mat, x, y, z, sx = 1, sy = 1, sz = 1, ry = 0, cast = true) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.scale.set(sx, sy, sz); m.rotation.y = ry;
      m.castShadow = cast; m.receiveShadow = true; root.add(m); return m;
    };

    // ---- floor
    const N = quality.name === 'low' ? 1024 : 2048;
    const F = paintFloor(R, N);
    const floorMat = M(new THREE.MeshStandardMaterial({ name: 'sh_floor', map: T(tex(F.ca, { aniso })), roughnessMap: T(tex(F.cr, { srgb: false, aniso })),
      bumpMap: T(tex(F.cb, { srgb: false, aniso })), bumpScale: 1.2, metalness: 0.0, roughness: 1.0 }));
    const floor = add(G(new THREE.PlaneGeometry(FLOOR_EXT * 2, FLOOR_EXT * 2)), floorMat, 0, 0, 0, 1, 1, 1, 0, false);
    floor.rotation.x = -Math.PI / 2; floor.name = 'sh_floor';
    // far ground beyond the floor so the backdrop never floats on the void
    const farMat = M(new THREE.MeshStandardMaterial({ name: 'sh_far', color: 0x2a221e, roughness: 1, metalness: 0 }));
    const far = add(G(new THREE.PlaneGeometry(140, 140)), farMat, 0, -0.02, 0, 1, 1, 1, 0, false); far.rotation.x = -Math.PI / 2;

    // ---- material family
    const stoneMap = T(tex(paintStone(R, 512), { aniso }));
    const stone = M(new THREE.MeshStandardMaterial({ name: 'sh_stone', map: stoneMap, roughness: 0.92, metalness: 0 }));
    const lacquer = M(new THREE.MeshStandardMaterial({ name: 'sh_lacquer', map: T(tex(paintLacquer(R, 512), { aniso })), roughness: 0.48, metalness: 0 }));
    const wood = M(new THREE.MeshStandardMaterial({ name: 'sh_wood', color: 0x3a2a22, roughness: 0.8, metalness: 0 }));
    const roofMat = M(new THREE.MeshStandardMaterial({ name: 'sh_roof', color: 0x24262c, roughness: 0.62, metalness: 0.3 }));
    const plasterMap = T(tex(paintPlaster(R, 512), { aniso })); plasterMap.repeat.set(3, 1);
    const plaster = M(new THREE.MeshStandardMaterial({ name: 'sh_plaster', map: plasterMap, roughness: 0.95, metalness: 0 }));
    const brass = M(new THREE.MeshStandardMaterial({ name: 'sh_brass', color: 0xb08a4a, roughness: 0.35, metalness: 1.0 }));
    const glow = M(new THREE.MeshStandardMaterial({ name: 'sh_lantern_glow', color: 0x2a1408, emissive: 0xffa04a, emissiveIntensity: 2.4, roughness: 0.9, metalness: 0 }));
    const paper = M(new THREE.MeshStandardMaterial({ name: 'sh_paper', color: 0x401a0e, emissive: 0xff6a2a, emissiveIntensity: 1.3, roughness: 0.9, metalness: 0 }));
    const box = G(new THREE.BoxGeometry(1, 1, 1)), cyl = G(new THREE.CylinderGeometry(0.5, 0.5, 1, 16, 1)), roof = G(roofGeo());

    // ---- 4 lacquered pillars (COL_pillar_*): stone footing, red shaft, bronze cap, kasagi crossbeam stub
    for (const [x, z] of SHRINE_PILLARS) {
      add(box, stone, x, 0.18, z, 1.3, 0.36, 1.3, Math.PI / 4);
      add(cyl, lacquer, x, 3.0, z, 1.0, 6.0, 1.0);
      add(cyl, brass, x, 0.5, z, 1.06, 0.12, 1.06);
      add(cyl, brass, x, 5.9, z, 1.06, 0.12, 1.06);
      add(box, roofMat, x, 6.15, z, 1.6, 0.3, 1.6);
      // shimenawa rope band with paper streamers (thin dark torus approximated by a squat cylinder)
      add(cyl, wood, x, 4.6, z, 1.12, 0.14, 1.12, 0, false);
    }

    // ---- low stone parapets (COL_wall_*) with a capstone lip
    for (const c of doc.colliders) if (c.kind === 'obb' && c.name.startsWith('COL_wall')) {
      add(box, stone, c.center[0], c.center[1], c.center[2], c.halfExtents[0] * 2, c.halfExtents[1] * 2, c.halfExtents[2] * 2);
      add(box, stone, c.center[0], c.halfExtents[1] * 2 + 0.06, c.center[2], c.halfExtents[0] * 2 + 0.16, 0.12, c.halfExtents[2] * 2 + 0.16);
    }

    // ---- 4 corner stone lanterns (toro) = the 4 point-light anchors (doc.shrine.lightSlots)
    for (const p of doc.shrine.lightSlots) {
      const [x, , z] = p;
      add(box, stone, x, 0.15, z, 1.1, 0.3, 1.1);
      add(cyl, stone, x, 0.75, z, 0.42, 0.9, 0.42);
      add(box, stone, x, 1.3, z, 0.9, 0.2, 0.9);
      add(box, glow, x, 1.62, z, 0.56, 0.44, 0.56, 0, false);
      add(roof, stone, x, 1.84, z, 1.25, 0.42, 1.25);
      add(box, stone, x, 2.3, z, 0.18, 0.16, 0.18);
    }

    // ---- backdrop: main hall to the north (behind the warden from the default camera)
    const HZ = -27;
    add(box, stone, 0, 0.6, HZ, 18, 1.2, 9);                                     // raised stone podium
    for (let i = 0; i < 5; i++) add(box, stone, 0, 0.12 + i * 0.24, HZ + 4.5 + 0.4 * (5 - i), 6, 0.24, 0.4); // front steps
    for (let i = -3; i <= 3; i++) add(cyl, lacquer, i * 2.4, 3.6, HZ + 3.6, 0.6, 4.8, 0.6);                 // veranda columns
    add(box, plaster, 0, 3.6, HZ - 0.6, 15, 4.8, 6.4);                            // walls
    for (let i = -2; i <= 2; i++) add(box, wood, i * 2.8, 3.6, HZ + 2.62, 0.18, 4.8, 0.1, 0, false);  // timber frame
    add(box, wood, 0, 5.95, HZ + 0.4, 17.4, 0.3, 9.4);                           // eave beam
    add(roof, roofMat, 0, 6.1, HZ + 0.2, 24, 3.6, 13);                           // lower roof
    add(roof, roofMat, 0, 8.5, HZ + 0.2, 13, 3.4, 7.4);                          // upper roof
    add(box, brass, 0, 11.95, HZ + 0.2, 6.5, 0.22, 0.3);                         // ridge
    for (const x of [-4.8, -1.6, 1.6, 4.8]) add(box, paper, x, 5.25, HZ + 4.4, 0.42, 0.62, 0.42, 0, false);  // hanging lanterns

    // ---- torii gate to the south (behind the player spawn)
    const TZ = 24;
    for (const x of [-4.2, 4.2]) { add(cyl, lacquer, x, 4.2, TZ, 0.85, 8.4, 0.85); add(cyl, roofMat, x, 0.35, TZ, 1.0, 0.7, 1.0); }
    add(box, lacquer, 0, 7.1, TZ, 10.6, 0.45, 0.6);                              // nuki
    add(box, roofMat, 0, 8.55, TZ, 12.6, 0.5, 0.95);                             // kasagi
    add(box, lacquer, 0, 8.15, TZ, 11.4, 0.35, 0.75);
    add(box, lacquer, 0, 7.8, TZ, 0.5, 0.9, 0.5);                                // gakuzuka

    // ---- side halls (east / west), lower, so the courtyard reads enclosed
    for (const sx of [-1, 1]) {
      const X = sx * 27;
      add(box, stone, X, 0.4, -4, 7, 0.8, 22);
      add(box, plaster, X, 2.6, -4, 5.6, 3.6, 20);
      add(roof, roofMat, X, 4.4, -4, 9, 2.6, 24);
      for (let z = -13; z <= 5; z += 3) add(box, paper, X - sx * 3.1, 3.7, z, 0.34, 0.5, 0.34, 0, false);
    }

    // ---- maples (crimson canopies) and the dark cedar line, instanced
    const leafMat = M(new THREE.MeshStandardMaterial({ name: 'sh_maple', color: 0x8a1a12, roughness: 0.85, metalness: 0, flatShading: true }));
    const cedarMat = M(new THREE.MeshStandardMaterial({ name: 'sh_cedar', color: 0x2a2236, roughness: 0.95, metalness: 0, flatShading: true }));
    const trunkMat = M(new THREE.MeshStandardMaterial({ name: 'sh_trunk', color: 0x2a1e18, roughness: 0.95, metalness: 0 }));
    const clump = G(new THREE.IcosahedronGeometry(1, 1)), cone = G(new THREE.ConeGeometry(1, 1, 7, 1)); cone.translate(0, 0.5, 0);
    const trunk = G(new THREE.CylinderGeometry(0.14, 0.24, 1, 7, 1)); trunk.translate(0, 0.5, 0);
    const maples = [], cedars = [], trunks = [];
    const mapleAt = (x, z, s) => {
      trunks.push([x, 0, z, s * 1.2, s * 3.4, s * 1.2]);
      for (let i = 0; i < 7; i++) {
        const a = R.range(0, 6.283), d = R.range(0, 1.6) * s;
        maples.push([x + Math.cos(a) * d, s * R.range(3.2, 4.6), z + Math.sin(a) * d, s * R.range(1.1, 1.7), s * R.range(0.8, 1.2), s * R.range(1.1, 1.7)]);
      }
    };
    for (const [x, z] of [[-19.5, -19.5], [19.5, -19.5], [-19.5, 19.5], [19.5, 19.5], [-12, -23], [12, -23], [-22.5, 9], [22.5, 9], [-9, 22.5], [9, 22.5]]) mapleAt(x, z, R.range(0.9, 1.25));
    for (let i = 0; i < 46; i++) {
      // low, distant cedar silhouette: tall enough to close the horizon behind the halls, short enough that the
      // sunset gradient stays readable above it from the play camera (was 12-19 m at 33-40 m and walled off the sky)
      const a = (i / 46) * 6.283 + R.range(-0.05, 0.05), d = R.range(42, 50);
      cedars.push([Math.sin(a) * d, 0, Math.cos(a) * d, R.range(2.0, 3.0), R.range(7, 11), R.range(2.0, 3.0)]);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const inst = (geo, mat, list, name, cast) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length); im.name = name;
      list.forEach((b, i) => { e.set(0, R.range(0, 6.283), 0); q.setFromEuler(e); p.set(b[0], b[1], b[2]); s.set(b[3], b[4], b[5]); im.setMatrixAt(i, m4.compose(p, q, s)); });
      im.castShadow = cast; im.receiveShadow = true; root.add(im); return im;
    };
    inst(clump, leafMat, maples, 'sh_maples', true);
    inst(trunk, trunkMat, trunks, 'sh_trunks', true);
    inst(cone, cedarMat, cedars, 'sh_cedars', false);
    this.leafMat = leafMat;

    this.stats = { meshes: 0, materials: mats.size, textures: texs.size, maples: maples.length, cedars: cedars.length };
    root.traverse((o) => { if (o.isMesh) this.stats.meshes++; });
    return this;
  }

  setVisible(v) { this.root.visible = v; }

  dispose() {
    if (!this.root) return;
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.root = null;
  }
}
