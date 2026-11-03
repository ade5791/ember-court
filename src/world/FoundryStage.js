// FoundryStage - procedural Frozen Foundry arena (docs/STAGE3_SPEC.md section 1). Zero art assets: every texture is
// painted on a canvas at load from the seeded 'foundry' stream, so two loads are pixel-identical.
// Layout matches assets/foundry-colliders.json (8 columns, 4 low wall slabs, 4 warm crystal light anchors).
// Outer hall wall and scaffolding stand at |x|,|z| >= 21.2, past the camera outer clamp (20.65), so the camera can
// never enter them. Presentation only: the sim reads the collider doc, never this.
// Materials are MeshStandardMaterial (same program family as the ford) plus additive MeshBasic shaft cards.
import * as THREE from 'three';

const C = Object.freeze({
  plate: '#8a93a6', gap: '#1a2038', snow: '#dde6f4', snowShade: '#3a4870',
  stripeY: '#d8b830', stripeK: '#22232a', steel: '#868a93', steelDark: '#2c3344',
  ice: '#6b6fa8', warmCore: '#8a1f33', warmGlow: '#d8304e',
});
const HALF = 16, FLOOR_EXT = 21.2, HALL = 21.2, ROOF_Y = 15.3, TRUSS_Y = 14.0;
export const FOUNDRY_COLUMNS = Object.freeze([[-11, -11], [11, -11], [-11, 11], [11, 11], [0, -14.5], [0, 14.5], [-14.5, 0], [14.5, 0]]);

function canvas(n) { const c = document.createElement('canvas'); c.width = c.height = n; return [c, c.getContext('2d')]; }
function tex(c, { srgb = true, repeat = 1, aniso = 1 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}
// value noise on a coarse lattice, bilinear: deterministic from rng, used for snow masks and grime
function noiseField(rng, cells) {
  const g = new Float32Array((cells + 1) * (cells + 1));
  for (let i = 0; i < g.length; i++) g[i] = rng.float();
  for (let i = 0; i <= cells; i++) { g[i * (cells + 1) + cells] = g[i * (cells + 1)]; g[cells * (cells + 1) + i] = g[i]; }
  return (u, v) => {
    const x = u * cells, y = v * cells, ix = Math.min(cells - 1, x | 0), iy = Math.min(cells - 1, y | 0), fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), w = cells + 1;
    const a = g[iy * w + ix], b = g[iy * w + ix + 1], c = g[(iy + 1) * w + ix], d = g[(iy + 1) * w + ix + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// Floor: one 2048 canvas over the full 2*FLOOR_EXT square (about 48 px/m). Riveted 2 m plates, the X grating strips
// (3 m wide, crossing at the centre), the caution ring at |x| or |z| in [13.8, 15.0] and the column base rings,
// then a snow drift layer thicker near walls and column bases. Returns albedo, roughness and bump canvases.
function paintFloor(rng, N) {
  const [ca, a] = canvas(N), [cr, r] = canvas(N), [cb, b] = canvas(N);
  const S = N / (FLOOR_EXT * 2), P = (m) => (m + FLOOR_EXT) * S;      // metres -> px
  // base plates
  a.fillStyle = C.plate; a.fillRect(0, 0, N, N); r.fillStyle = 'rgb(0,122,0)'; r.fillRect(0, 0, N, N); b.fillStyle = '#808080'; b.fillRect(0, 0, N, N);
  for (let gx = -FLOOR_EXT; gx < FLOOR_EXT; gx += 2) for (let gz = -FLOOR_EXT; gz < FLOOR_EXT; gz += 2) {
    const k = rng.range(-14, 14) | 0, x = P(gx), z = P(gz), w = 2 * S;
    a.fillStyle = 'rgb(' + (138 + k) + ',' + (147 + k) + ',' + (166 + k) + ')'; a.fillRect(x + 1, z + 1, w - 2, w - 2);
    r.fillStyle = 'rgb(0,' + (150 + rng.range(-30, 30) | 0) + ',0)'; r.fillRect(x + 1, z + 1, w - 2, w - 2);
    // seams
    a.fillStyle = 'rgba(26,32,56,0.85)'; a.fillRect(x, z, w, 2); a.fillRect(x, z, 2, w);
    b.fillStyle = '#404040'; b.fillRect(x, z, w, 2); b.fillRect(x, z, 2, w);
    // rivets along each edge
    for (let i = 1; i < 8; i++) for (const [rx, rz] of [[x + i * w / 8, z + 5], [x + 5, z + i * w / 8]]) {
      a.fillStyle = 'rgba(210,218,232,0.9)'; a.beginPath(); a.arc(rx, rz, 1.8, 0, 6.283); a.fill();
      b.fillStyle = '#d0d0d0'; b.beginPath(); b.arc(rx, rz, 2.2, 0, 6.283); b.fill();
    }
    // diamond tread scuffs
    a.fillStyle = 'rgba(40,46,64,0.10)';
    for (let i = 0; i < 6; i++) a.fillRect(x + rng.float() * w, z + rng.float() * w, rng.range(6, 30), rng.range(1, 3));
  }
  // X grating strips (3 m wide) to the caution ring: dark gaps under a bar grid
  a.save(); r.save(); b.save();
  for (const ang of [Math.PI / 4, -Math.PI / 4]) for (const g of [a, r, b]) {
    g.save(); g.translate(P(0), P(0)); g.rotate(ang);
    const L = 13.8 * Math.SQRT2 * S, hw = 1.5 * S;
    g.beginPath(); g.rect(-L, -hw, 2 * L, 2 * hw); g.clip();
    g.fillStyle = g === a ? C.gap : g === r ? 'rgb(0,224,0)' : '#101010'; g.fillRect(-L, -hw, 2 * L, 2 * hw);
    g.fillStyle = g === a ? '#a4adbf' : g === r ? 'rgb(0,118,255)' : '#b0b0b0';
    for (let t = -L; t < L; t += 0.12 * S) g.fillRect(t, -hw, 0.035 * S, 2 * hw);
    for (let t = -hw; t < hw; t += 0.5 * S) g.fillRect(-L, t, 2 * L, 0.05 * S);
    g.fillStyle = g === a ? '#7a8296' : g === r ? 'rgb(0,140,255)' : '#909090'; g.fillRect(-L, -hw, 2 * L, 0.12 * S); g.fillRect(-L, hw - 0.12 * S, 2 * L, 0.12 * S);
    g.restore();
  }
  a.restore(); r.restore(); b.restore();
  // caution ring: 0.5 m diagonal bands in the [13.8, 15.0] border on each side
  const stripes = (g, clip) => {
    g.save(); clip(g); g.clip();
    g.fillStyle = C.stripeK; g.fillRect(0, 0, N, N); g.fillStyle = C.stripeY;
    for (let t = -N; t < 2 * N; t += 1.0 * S) { g.beginPath(); g.moveTo(t, 0); g.lineTo(t + 0.5 * S, 0); g.lineTo(t + 0.5 * S + N, N); g.lineTo(t + N, N); g.fill(); }
    g.restore();
  };
  const ring = (g) => { g.beginPath(); g.rect(P(-15), P(-15), 30 * S, 30 * S); g.rect(P(13.8), P(-13.8), -27.6 * S, 27.6 * S); };
  stripes(a, ring);
  for (const [cx, cz] of FOUNDRY_COLUMNS.slice(0, 4)) stripes(a, (g) => { g.beginPath(); g.arc(P(cx), P(cz), 1.7 * S, 0, 6.283); g.arc(P(cx), P(cz), 1.05 * S, 0, 6.283, true); });
  r.fillStyle = 'rgba(0,120,0,0.8)'; ring(r); r.fill('evenodd');
  return { ca, cr, cb, a, r, b, S, P };
}

// Snow/ice drift over the painted floor: soft noise mask, thicker toward the walls and the column bases.
// Snow is bright, rougher and slightly raised in the bump map.
function paintSnow(rng, F, N) {
  const { a, r, b, S, P } = F;
  const n1 = noiseField(rng, 24), n2 = noiseField(rng, 96);
  const img = a.getImageData(0, 0, N, N), rim = r.getImageData(0, 0, N, N), bim = b.getImageData(0, 0, N, N);
  const sn = [221, 230, 244];
  for (let py = 0; py < N; py += 1) {
    const z = py / S - FLOOR_EXT;
    for (let px = 0; px < N; px += 1) {
      const x = px / S - FLOOR_EXT;
      const edge = Math.max(Math.abs(x), Math.abs(z));
      let drift = Math.max(0, (edge - 14.6) / 1.0);   // against the parapet, outside the caution ring                          // walls
      for (let i = 0; i < 8; i++) { const c = FOUNDRY_COLUMNS[i], d = Math.hypot(x - c[0], z - c[1]); if (d < 3.2) drift = Math.max(drift, (3.2 - d) / 2.2); }
      const n = n1(px / N, py / N) * 0.7 + n2(px / N, py / N) * 0.3;
      let m = drift * 1.25 + (n - 0.62) * 1.6;
      if (edge < 9) m = Math.max(m, (n2(px / N, py / N) - 0.80) * 3.0);    // sparse dust in the middle
      if (m <= 0) continue;
      m = Math.min(1, m);
      const o = (py * N + px) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = img.data[o + k] * (1 - m) + sn[k] * m;
      rim.data[o + 1] = rim.data[o + 1] * (1 - m) + 225 * m; rim.data[o + 2] *= 1 - m;   // G roughness, B metalness
      bim.data[o] = bim.data[o + 1] = bim.data[o + 2] = Math.min(255, bim.data[o] + 70 * m);
    }
  }
  a.putImageData(img, 0, 0); r.putImageData(rim, 0, 0); b.putImageData(bim, 0, 0);
}

// Tileable brushed/riveted steel for columns, beams and walls (512, 1 m per tile).
function paintSteel(rng, N) {
  const [ca, a] = canvas(N), [cr, r] = canvas(N);
  a.fillStyle = C.steel; a.fillRect(0, 0, N, N); r.fillStyle = '#6a6a6a'; r.fillRect(0, 0, N, N);
  for (let i = 0; i < 900; i++) {           // vertical brush streaks
    const x = rng.float() * N, l = rng.range(20, 160), y = rng.float() * N, k = rng.range(-22, 22) | 0;
    a.fillStyle = 'rgba(' + (126 + k) + ',' + (130 + k) + ',' + (140 + k) + ',0.35)'; a.fillRect(x, y, 1, l);
    r.fillStyle = 'rgba(0,' + (100 + k * 2) + ',0,0.3)'; r.fillRect(x, y, 1, l);
  }
  for (const y of [N * 0.06, N * 0.94]) for (let x = N / 16; x < N; x += N / 8) {   // rivet rows at the panel seams
    a.fillStyle = 'rgba(200,208,224,0.85)'; a.beginPath(); a.arc(x, y, 4, 0, 6.283); a.fill();
  }
  a.fillStyle = 'rgba(30,36,52,0.9)'; a.fillRect(0, 0, N, 3); a.fillRect(0, N - 3, N, 3);
  const g = a.createLinearGradient(0, N, 0, N * 0.55); g.addColorStop(0, 'rgba(26,32,56,0.45)'); g.addColorStop(1, 'rgba(26,32,56,0)');
  a.fillStyle = g; a.fillRect(0, 0, N, N);   // grime pools low on each tile
  return { ca, cr };
}

// Ice crystal cluster: hexagonal prisms with pointed tips, jittered from the seeded stream.
function crystalCluster(rng, mat, count, scale) {
  const grp = new THREE.Group(), geo = new THREE.CylinderGeometry(0.0, 0.16, 1, 6, 1); geo.translate(0, 0.5, 0);
  const body = new THREE.CylinderGeometry(0.16, 0.18, 1, 6, 1); body.translate(0, 0.5, 0);
  for (let i = 0; i < count; i++) {
    const h = rng.range(0.5, 1.6) * scale, w = rng.range(0.7, 1.4) * scale;
    const p = new THREE.Group();
    const m1 = new THREE.Mesh(body, mat); m1.scale.set(w, h, w);
    const m2 = new THREE.Mesh(geo, mat); m2.scale.set(w, h * 0.45, w); m2.position.y = h;
    p.add(m1, m2);
    p.position.set(rng.range(-0.35, 0.35) * scale, 0, rng.range(-0.35, 0.35) * scale);
    p.rotation.set(rng.range(-0.45, 0.45), rng.range(0, 6.283), rng.range(-0.45, 0.45));
    for (const m of [m1, m2]) { m.castShadow = true; m.receiveShadow = true; }
    grp.add(p);
  }
  return grp;
}

export class FoundryStage {
  static id = 'foundry';

  // opts: { scene, renderer, quality, rng (Rng instance; the 'foundry' stream is forked from it), doc (collider doc) }
  build({ scene, quality, rng, doc }) {
    const R = rng.stream('foundry'), aniso = quality.anisotropy || 4;
    const root = this.root = new THREE.Group(); root.name = 'foundry_arena'; root.visible = false;
    const mats = this.materials = new Set(), texs = this.textures = new Set(), geos = this.geometries = new Set();
    const T = (t) => { texs.add(t); return t; }, M = (m) => { mats.add(m); return m; }, G = (g) => { geos.add(g); return g; };

    // ---- floor (one plane, 42.4 m, single 2048 painted set)
    const N = quality.name === 'low' ? 1024 : 2048;
    const F = paintFloor(R, N); paintSnow(R, F, N);
    const floorMat = M(new THREE.MeshStandardMaterial({ name: 'fd_floor', map: T(tex(F.ca, { aniso })), roughnessMap: T(tex(F.cr, { srgb: false, aniso })),
      bumpMap: T(tex(F.cb, { srgb: false, aniso })), bumpScale: 1.6, metalness: 1.0, roughness: 1.0 }));
    floorMat.metalnessMap = floorMat.roughnessMap;   // one ORM-style canvas: G roughness, B metalness (bars metal, paint/snow dielectric)
    const floor = new THREE.Mesh(G(new THREE.PlaneGeometry(FLOOR_EXT * 2, FLOOR_EXT * 2)), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; floor.name = 'fd_floor'; root.add(floor);

    // ---- steel family
    const st = paintSteel(R, 512);
    const steelMap = T(tex(st.ca, { aniso })), steelRough = T(tex(st.cr, { srgb: false, aniso }));
    // columns, parapets and hall are painted steel (dielectric paint); flanges and scaffold are bare steel
    const steel = M(new THREE.MeshStandardMaterial({ name: 'fd_steel', map: steelMap, roughnessMap: steelRough, metalness: 0.0, roughness: 1.0, color: 0xffffff }));
    const steelDark = M(new THREE.MeshStandardMaterial({ name: 'fd_steel_dark', color: 0xa9adb6, metalness: 1.0, roughness: 0.55 }));
    const stripeMat = M(new THREE.MeshStandardMaterial({ name: 'fd_stripe', color: C.stripeY, metalness: 0.0, roughness: 0.55 }));

    // columns: radius 0.9 to the truss line, flanged base and capital, snow cap on the base flange
    const colGeo = G(new THREE.CylinderGeometry(0.9, 0.9, TRUSS_Y, 20, 1)); colGeo.translate(0, TRUSS_Y / 2, 0);
    const flangeGeo = G(new THREE.CylinderGeometry(1.15, 1.25, 0.45, 20, 1)); flangeGeo.translate(0, 0.225, 0);
    const bandGeo = G(new THREE.CylinderGeometry(0.93, 0.93, 0.35, 20, 1, true));
    for (const [x, z] of FOUNDRY_COLUMNS) {
      const c = new THREE.Mesh(colGeo, steel); c.position.set(x, 0, z); c.castShadow = c.receiveShadow = true; root.add(c);
      const f = new THREE.Mesh(flangeGeo, steelDark); f.position.set(x, 0, z); f.castShadow = f.receiveShadow = true; root.add(f);
      const cap = new THREE.Mesh(flangeGeo, steelDark); cap.position.set(x, TRUSS_Y - 0.45, z); root.add(cap);
      const band = new THREE.Mesh(bandGeo, stripeMat); band.position.set(x, 1.4, z); root.add(band);
    }

    // low wall slabs (collider COL_wall_*): 1.1 m steel parapet with a caution top rail
    const wallGeo = G(new THREE.BoxGeometry(1, 1, 1));
    for (const c of doc.colliders) if (c.kind === 'obb' && c.name.startsWith('COL_wall')) {
      const w = new THREE.Mesh(wallGeo, steel);
      w.position.set(c.center[0], c.center[1], c.center[2]); w.scale.set(c.halfExtents[0] * 2, c.halfExtents[1] * 2, c.halfExtents[2] * 2);
      w.castShadow = w.receiveShadow = true; root.add(w);
      const rail = new THREE.Mesh(wallGeo, stripeMat);
      rail.position.set(c.center[0], c.halfExtents[1] * 2 + 0.04, c.center[2]); rail.scale.set(c.halfExtents[0] * 2 + 0.02, 0.08, c.halfExtents[2] * 2 + 0.02);
      root.add(rail);
    }

    // ---- outer hall (at 21.2 m, outside the camera's 20.65 m clamp): tall walls, two-level X-braced scaffold bays
    const hallMat = M(new THREE.MeshStandardMaterial({ name: 'fd_hall', map: steelMap, roughnessMap: steelRough, color: 0x6c7488, metalness: 0.8, roughness: 0.85 }));
    const hallGeo = G(new THREE.PlaneGeometry(HALL * 2, ROOF_Y));
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2, w = new THREE.Mesh(hallGeo, hallMat);
      w.position.set(Math.sin(a) * HALL, ROOF_Y / 2, Math.cos(a) * HALL); w.rotation.y = a + Math.PI; w.receiveShadow = true; root.add(w);
    }
    // scaffold beams as one InstancedMesh (unit box scaled per instance): posts, two decks, X braces
    const beams = [];
    const beam = (x0, y0, z0, x1, y1, z1, t) => beams.push([x0, y0, z0, x1, y1, z1, t]);
    const IN = 18.6, OUT = 20.4;                    // bay depth between 18.6 and 20.4 m from centre
    for (let side = 0; side < 4; side++) {
      const ca = Math.cos(side * Math.PI / 2), sa = Math.sin(side * Math.PI / 2);
      const P = (u, y, d) => [u * ca + d * sa, y, -u * sa + d * ca];
      for (let u = -18; u <= 18; u += 4) for (const d of [IN, OUT]) { const a = P(u, 0, d), b = P(u, 5.2, d); beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.14); }
      for (const y of [2.5, 5.0]) {
        for (const d of [IN, OUT]) { const a = P(-18, y, d), b = P(18, y, d); beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.12); }
        for (let u = -18; u <= 18; u += 4) { const a = P(u, y, IN), b = P(u, y, OUT); beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.10); }
      }
      for (let u = -18; u < 18; u += 4) for (const [y0, y1] of [[0, 2.5], [2.5, 5.0]]) {
        const a = P(u, y0, IN), b = P(u + 4, y1, IN), c = P(u + 4, y0, IN), e = P(u, y1, IN);
        beam(a[0], a[1], a[2], b[0], b[1], b[2], 0.07); beam(c[0], c[1], c[2], e[0], e[1], e[2], 0.07);
      }
    }
    // roof trusses at 14 m along Z (span X), with the three open shafts along X left clear between chords
    for (let x = -18; x <= 18; x += 6) {
      beam(x, TRUSS_Y, -HALL, x, TRUSS_Y, HALL, 0.32); beam(x, TRUSS_Y + 1.3, -HALL, x, TRUSS_Y + 1.3, HALL, 0.22);
      for (let z = -HALL; z < HALL; z += 3) beam(x, TRUSS_Y, z, x, TRUSS_Y + 1.3, z + 3, 0.08);
    }
    for (const z of [-12, -4, 4, 12]) beam(-HALL, TRUSS_Y + 1.3, z, HALL, TRUSS_Y + 1.3, z, 0.18);
    const bGeo = G(new THREE.BoxGeometry(1, 1, 1));
    const inst = new THREE.InstancedMesh(bGeo, steelDark, beams.length); inst.name = 'fd_scaffold';
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    beams.forEach((b, i) => {
      dir.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]); const len = dir.length(); dir.multiplyScalar(1 / len);
      q.setFromUnitVectors(up, dir); pos.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2); scl.set(b[6], len, b[6]);
      inst.setMatrixAt(i, m4.compose(pos, q, scl));
    });
    inst.castShadow = true; inst.receiveShadow = true; root.add(inst);
    this.beamCount = beams.length;

    // roof: dark slabs between the three open shafts (shafts along X at z = -8, 0, +8, 2.4 m wide)
    const roofMat = M(new THREE.MeshStandardMaterial({ name: 'fd_roof', map: steelMap, roughnessMap: steelRough, color: 0x9aa2b8, metalness: 0.0, roughness: 1.0 }));
    const sh = doc.foundry.shafts, sw = doc.foundry.shaftWidth;
    const edges = [-HALL]; for (const z of sh) edges.push(z - sw / 2, z + sw / 2); edges.push(HALL);
    for (let i = 0; i < edges.length; i += 2) {
      const z0 = edges[i], z1 = edges[i + 1], s = new THREE.Mesh(G(new THREE.BoxGeometry(HALL * 2, 0.4, z1 - z0)), roofMat);
      s.position.set(0, ROOF_Y + 0.2, (z0 + z1) / 2); s.castShadow = true; root.add(s);
    }
    return this._buildIce(R, doc, M, G);
  }

  _buildIce(R, doc, M, G) {
    const root = this.root;
    // blue-violet ice: low roughness with a fresnel rim (transmission-free, spec section 1). The rim is injected via
    // onBeforeCompile with a stable cache key so the program is shared by every cluster.
    const ice = M(new THREE.MeshStandardMaterial({ name: 'fd_ice', color: C.ice, metalness: 0.0, roughness: 0.15, emissive: 0x1a1c3a, emissiveIntensity: 1.0 }));
    ice.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  { float fr = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 3.0);\n    totalEmissiveRadiance += vec3(0.55, 0.62, 1.0) * fr * 0.9; }');
    };
    ice.customProgramCacheKey = () => 'fd_ice_rim_v1';
    const warm = M(new THREE.MeshStandardMaterial({ name: 'fd_crystal_warm', color: C.warmCore, emissive: C.warmGlow, emissiveIntensity: 0.85, metalness: 0, roughness: 0.3 }));
    // clusters at the wall bases (between columns) and on scaffold decks
    const spots = [];
    for (let i = 0; i < 4; i++) for (const u of [-7, 6]) {
      const a = i * Math.PI / 2, d = 15.35 + R.range(-0.1, 0.2), uu = u + R.range(-1.5, 1.5);
      spots.push([uu * Math.cos(a) + d * Math.sin(a), 0, -uu * Math.sin(a) + d * Math.cos(a), R.range(0.9, 1.3)]);
    }
    for (let i = 0; i < 10; i++) { const a = R.range(0, 6.283), d = 19.4; spots.push([Math.sin(a) * d, 5.1, Math.cos(a) * d, R.range(0.8, 1.2)]); }
    for (const s of spots) {
      const c = crystalCluster(R, ice, 5 + (R.float() * 4 | 0), s[3]);
      c.position.set(Math.max(-20, Math.min(20, s[0])), s[1], Math.max(-20, Math.min(20, s[2]))); root.add(c);
    }
    // 4 warm crystal clusters = the 4 point-light anchors (doc.foundry.lightSlots; collider COL_crystal_*)
    for (const p of doc.foundry.lightSlots) {
      const c = crystalCluster(R, warm, 8, 1.35); c.position.set(p[0], 0, p[2]); root.add(c);
    }
    // roof light shafts: additive vertical cards under each open shaft, faint so the stage reads without them.
    // Six full-hall cards stack along the view axis (6 x 0.075 = 0.45 of white over the upper frame, measured as the
    // main wash); 0.02 keeps a visible beam while the stack stays under 0.12.
    const shaftMat = this.shaftMat = M(new THREE.MeshBasicMaterial({ name: 'fd_shaft', color: 0xb8ccff, transparent: true, opacity: 0.02,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
    const sGeo = G(new THREE.PlaneGeometry(HALL * 2, ROOF_Y));
    for (const z of doc.foundry.shafts) for (const off of [-0.6, 0.6]) {
      const s = new THREE.Mesh(sGeo, shaftMat);
      // tilted toward the key direction (+0.35, 1, -0.2): the shaft leans along -Z as it falls
      s.position.set(0, ROOF_Y / 2, z + off - 0.2 * ROOF_Y / 2); s.rotation.x = Math.atan2(0.2, 1); root.add(s);
    }
    this.stats = { meshes: 0, materials: this.materials.size, textures: this.textures.size, beams: this.beamCount, crystals: spots.length + 4 };
    root.traverse((o) => { if (o.isMesh) this.stats.meshes++; });
    return this;
  }

  setVisible(v) { this.root.visible = v; }

  dispose() {
    if (!this.root) return;
    this.root.removeFromParent();
    this.root.traverse((o) => { if (o.isMesh) this.geometries.add(o.geometry); });
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
    this.root = null;
  }
}
