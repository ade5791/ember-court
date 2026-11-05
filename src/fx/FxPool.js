// FxPool - pooled combat VFX (CINEMATIC_SPEC section 4). Everything is allocated in init(); update() and every
// spawn path write into preallocated typed arrays and never allocate. Caps are the section 4 caps, further limited
// by the quality preset particle budget. Visuals are strictly downstream of resolved sim events (bus listeners).
//
// Pools: blade streaks (4), deflect spark bursts (3 x 24 velocity-stretched lines), ink-blood bursts (6 x 20 soft
// sprites), splash droplets (24 x 8), telegraph auras (4 actor slots: yellow = deflectable, RED art, BLUE art),
// afterimages (4 per registered actor; reduced motion: 1). Water stains and ripples are written into the water
// shader ring buffers (32 / 24 slots, owned by src/world/Water.js).
import * as THREE from 'three';
import { Outcome, Surface, FxKind } from '../shared/enums.js';

export const FX_CAPS = Object.freeze({ streaks: 4, streakSamples: 12, sparkBursts: 3, sparksPerBurst: 24,
  bloodBursts: 6, bloodPerBurst: 20, splashRings: 24, dropsPerSplash: 8, auras: 4, afterimagesPerActor: 4 });
export const TELEGRAPH = Object.freeze({ NORMAL: 0, RED: 1, BLUE: 2 });
export const TELEGRAPH_COLORS = Object.freeze([0xffd84a, 0xff2414, 0x2f7dff]);

const SPARK_LIFE = 0.25, BLOOD_LIFE = 0.5, DROP_LIFE = 0.8, STREAK_LIFE = 0.12, GHOST_LIFE = 0.3;
const GRAV = -9.81;
const QUAD_OFF = new Int8Array([0, 3, 9, 0, 9, 6]);
const QUAD_NEXT = new Uint8Array([0, 0, 1, 0, 1, 1]);
const QUAD_EDGE = new Uint8Array([0, 1, 1, 0, 1, 0]);   // 1 = tip side of the ribbon (offsets 3 and 9)
// v2.9 ink mist presets (rgb + peak alpha): WHITE dodge puff, VIOLET kill dissolve, JADE phantom vanish
// v2.15 CRIMSON: Ember Trigger aura - deep red, low alpha, so it frames the hero instead of washing the silhouette out
export const MIST = Object.freeze({ WHITE: 0, VIOLET: 1, JADE: 2, EMBER: 3, CRIMSON: 4 });
// v2.15: VIOLET darkened to an ink (0.40,0.20,0.62 a0.55 -> 0.26,0.11,0.40 a0.36): the old value read as a pale
// lavender wash over a hero standing next to the kill, measured +54 luminance on the hero box
const MIST_RGBA = new Float32Array([0.86, 0.89, 0.91, 0.40, 0.26, 0.11, 0.40, 0.36, 0.42, 0.86, 0.78, 0.34, 0.95, 0.30, 0.14, 0.42, 0.62, 0.06, 0.08, 0.30]);

// soft round sprite with per-particle colour/alpha/size (one program for blood and droplets)
const SPRITE_VS = `
attribute vec4 aColor; attribute float aSize;
varying vec4 vColor;
uniform float uScale;
void main(){
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // v2.15 near fade: a puff within ~1.8 m of the lens fades out instead of filling the screen with a clipped,
  // hard-edged sprite (the QA "pale rectangle"); size is also capped so it never hits the GPU point-size clamp
  vColor.a *= smoothstep(0.7, 1.8, -mv.z);
  gl_PointSize = min(aSize * uScale / max(0.1, -mv.z), 360.0);
  gl_Position = projectionMatrix * mv;
}`;
const SPRITE_FS = `
varying vec4 vColor;
void main(){
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;
  if (r > 1.0 || vColor.a <= 0.0) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - r));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// v2.17 shared value noise (no textures, no clock: animation comes from a per-particle seed the CPU drifts)
const NOISE_GLSL = `
float fxh(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fxn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxh(i), fxh(i + vec2(1.0, 0.0)), f.x), mix(fxh(i + vec2(0.0, 1.0)), fxh(i + vec2(1.0, 1.0)), f.x), f.y); }
`;

// v2.17 sword ribbon: Catmull-Rom subdivided (RIB_SUB per raw sample) so fast swings draw a curved arc instead of
// facets; brush fibres along the stroke and a dry-brush tail that breaks up as the stroke ages
const RIB_SUB = 4;
const RIBBON_VS = `
attribute float aA; attribute vec3 aC; attribute float aE; attribute float aU;
varying float vA; varying vec3 vC; varying float vE; varying float vU;
void main(){ vA = aA; vC = aC; vE = aE; vU = aU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RIBBON_FS = `
varying float vA; varying vec3 vC; varying float vE; varying float vU;
${NOISE_GLSL}
void main(){
  if (!(vA > 0.0)) discard;
  float ve = clamp(vE, 0.0, 1.0), e = ve * ve;
  // bristle streaks run ALONG the stroke (low freq in vU, high freq across the width ve), so the wash reads as
  // separate hair lines; the dry-brush mask bites in from the tail and from the guard edge
  // v2.17c: coarser fibres and a filled wash body. At 0.35 hair floor / 34-83 freq the stroke read as a few hair
  // lines around an empty middle; now the body is a solid ink wash with soft bristle variation on top
  float fib = fxn(vec2(vU * 4.0, ve * 16.0)) * 0.6 + fxn(vec2(vU * 9.0 + 3.1, ve * 38.0)) * 0.4;
  float dry = smoothstep(0.0, 0.22, fib + 0.70 - vU * 1.2 - (1.0 - ve) * 0.25);
  float core = pow(ve, 10.0), rim = smoothstep(0.80, 0.97, ve) * (1.0 - smoothstep(0.97, 1.0, ve));
  float hair = 0.68 + 0.32 * smoothstep(0.25, 0.75, fib);
  vec3 c = vC * (0.5 + 0.5 * e) * (0.75 + 0.45 * fib) + mix(vC, vec3(1.0), 0.55) * (core * 0.9 + rim * 0.25);
  // v2.17e: the guard-side edge kept 42% alpha, so the inner border of the stroke was a hard straight line and the
  // ribbon read as a flat panel; feather it to 0 and let the ink body build from the middle outward
  float inner = smoothstep(0.0, 0.45, ve) * (0.8 + 0.2 * fib);
  float a = vA * (0.42 + 0.58 * e) * dry * hair * inner;
  gl_FragColor = vec4(c * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// fire breath: additive flame sprites (blackbody ramp) + normal-blended smoke, fixed pools.
// v2.17: each sprite carries a seed; the fragment erodes the disc with noise into a ragged tongue / billow, and the
// CPU drifts the seed so the shape boils. Flame pool also carries embers (flameJet 2). Aged breath tongues shed
// soot puffs into the smoke pool, so the stream leaves a dark rolling trail instead of vanishing.
const FLAME_N = 384, SMOKE_N = 192, FLAME_LIFE = 0.55, SMOKE_LIFE = 1.4, EMBER_LIFE = 1.3;
const FIRE_VS = `
attribute vec4 aColor; attribute float aSize; attribute float aSeed;
varying vec4 vColor; varying float vSeed;
uniform float uScale;
void main(){
  vColor = aColor; vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vColor.a *= smoothstep(0.7, 1.8, -mv.z);
  gl_PointSize = min(aSize * uScale / max(0.1, -mv.z), 360.0);
  gl_Position = projectionMatrix * mv;
}`;
const FLAME_FS = `
varying vec4 vColor; varying float vSeed;
${NOISE_GLSL}
void main(){
  vec2 p = gl_PointCoord - 0.5; float r = dot(p, p) * 4.0;
  if (r > 1.0 || vColor.a <= 0.0) discard;
  float an = vSeed * 6.2831, cs = cos(an), sn = sin(an);
  vec2 q = mat2(cs, -sn, sn, cs) * p;
  // embers carry a negative seed: plain hot disc, no erosion (they are 2-6 px and must stay a clean point)
  float n = 1.0;
  // stretch the erosion upward (q.y * 0.6) so tongues read as vertical licks, and bite harder at the rim so the
  // disc outline never shows; the dense centre of each tongue gets a white-gold hot core on top of the ramp
  vec2 qs = vec2(q.x, q.y * 0.6);
  // v2.17d: harder erosion (1.6 -> 2.3) and finer second octave so each sprite breaks into 2-3 licks instead of a
  // soft billow; the stream gets gaps and tongues instead of reading as one cloud
  if (vSeed >= 0.0) n = fxn(qs * 6.0 + vec2(vSeed * 41.0, vSeed * 17.0)) * 0.6 + fxn(qs * 21.0 - vec2(vSeed * 23.0, vSeed * 31.0)) * 0.4;
  float k = clamp((1.0 - r) * 2.4 - (1.0 - n) * 2.3, 0.0, 1.0);
  if (k <= 0.002) discard;
  // v2.17b: dense additive overlap was saturating the stream to a peach-white smear. Each tongue now only adds a
  // little light, its thin eroded edges are deep red, and only the very core of a tongue is gold, so the stream
  // keeps a red rim / orange body / gold core read even where 30+ tongues stack
  float hot = smoothstep(0.55, 1.0, k);
  // v2.17c: frames still read pastel peach (gold 62%, red 0%). Hot core cut to a small gold kick, wider deep-red
  // edge band, less light per tongue so overlap stays orange instead of climbing to white
  vec3 col = mix(vec3(0.80, 0.07, 0.01), vColor.rgb, smoothstep(0.18, 0.75, k)) + vec3(0.55, 0.28, 0.04) * hot * hot;
  // v2.17d: premultiplied "glow with a backing": rgb adds light, alpha dims what is behind (ONE, ONE_MINUS_SRC_ALPHA).
  // Pure additive over the grey-beige ford fog read peach no matter the ramp; dimming the fog under each tongue lets
  // the orange body stay saturated. Embers keep alpha 0 (pure additive points).
  gl_FragColor = vec4(col * vColor.a * k * (vSeed < 0.0 ? 1.0 : 0.42), vSeed < 0.0 ? 0.0 : k * vColor.a * 0.45);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const SMOKE_FS = `
varying vec4 vColor; varying float vSeed;
${NOISE_GLSL}
void main(){
  vec2 p = gl_PointCoord - 0.5; float r = dot(p, p) * 4.0;
  if (r > 1.0 || vColor.a <= 0.0) discard;
  float an = vSeed * 6.2831, cs = cos(an), sn = sin(an);
  vec2 q = mat2(cs, -sn, sn, cs) * p;
  float n = fxn(q * 3.5 + vec2(vSeed * 13.0, vSeed * 7.0)) * 0.6 + fxn(q * 7.5 + vec2(vSeed * 29.0, -vSeed * 11.0)) * 0.4;
  // v2.17e: dense soot overlap made a hard-edged dark dome; each puff now feathers to 0 well inside the sprite and
  // the noise bites deeper, so the envelope of many puffs stays ragged instead of tracing one ellipse
  float k = smoothstep(0.0, 0.6, (1.0 - r) - (0.6 - n) * 1.1) * (1.0 - smoothstep(0.35, 1.0, r));
  if (k <= 0.002) discard;
  // light from above (gl_PointCoord y grows downward): tops brighter, undersides shadowed; mean stays below 1 so
  // the v2.15 hero-wash budget for mist is not exceeded
  float lit = 0.72 - p.y * 0.5 + (n - 0.5) * 0.3;
  gl_FragColor = vec4(vColor.rgb * lit, vColor.a * k);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class FxPool {
  static id = 'fx';
  static deps = ['world'];

  init(ctx, { scene, quality, water = null, reducedMotion = false, rng }) {
    this.ctx = ctx; this.scene = scene; this.water = water; this.reducedMotion = reducedMotion;
    this.rng = rng;                      // presentation stream (fx randomness never touches the sim streams)
    const C = FX_CAPS;
    const budget = quality ? quality.particles : 1500;
    // particle budget split: sparks are lines, blood + drops are sprites; scale per-burst counts if over budget
    const want = C.sparkBursts * C.sparksPerBurst + C.bloodBursts * C.bloodPerBurst + C.splashRings * C.dropsPerSplash;
    const k = Math.min(1, budget / want);
    this.sparksPerBurst = Math.max(8, Math.floor(C.sparksPerBurst * k));
    this.bloodPerBurst = Math.max(8, Math.floor(C.bloodPerBurst * k));
    this.dropsPerSplash = Math.max(4, Math.floor(C.dropsPerSplash * k));
    this.group = new THREE.Group(); this.group.name = 'fx';
    scene.add(this.group);
    this._initSparks(); this._initSprites(); this._initStreaks(); this._initAuras(); this._initShock(); this._initChevrons(); this._initFlame(); this._initFlares(); this._initRifts();
    this.ghostOwners = [];               // { meshes:[{src, ghosts:[...]}], next, life:Float32Array, tint }
    this.stats = { sparks: 0, blood: 0, drops: 0, streaks: 0, ghosts: 0, auras: 0, stains: 0, ripples: 0, flame: 0, chevrons: 0 };
    this.maxSeen = { sparkBursts: 0, bloodBursts: 0, splashes: 0, streaks: 0, ghostsPerActor: 0, auras: 0, flame: 0, chevrons: 0 };
    const bus = ctx && ctx.get ? ctx.get('bus') : null;
    this.bus = bus;
    if (bus) {
      this._l = {
        contact: (p) => this.onContact(p), parry: (p) => this.burstSparks(p.pos, null, 1.0),
        step: (p) => { if (p.surface === Surface.WATER) this.splash(p.pos.x, p.pos.z, 0.35); },
        req: (p) => this.request(p.kind, p.pos, p.normal, p.scale),
      };
      bus.on('combat/contact', this._l.contact); bus.on('combat/parry', this._l.parry);
      bus.on('world/footstep', this._l.step); bus.on('fx/request', this._l.req);
    }
    return this;
  }

  // ---------- sparks: LineSegments, head = pos, tail = pos - vel * stretch ----------
  _initSparks() {
    const n = FX_CAPS.sparkBursts * this.sparksPerBurst;
    this.spN = n;
    this.spPos = new Float32Array(n * 3); this.spVel = new Float32Array(n * 3); this.spLife = new Float32Array(n);
    this.spBurstT = new Float32Array(FX_CAPS.sparkBursts).fill(-1); this.spNext = 0;
    const g = new THREE.BufferGeometry();
    this.spLinePos = new Float32Array(n * 6); this.spLineCol = new Float32Array(n * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.spLinePos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.spLineCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
    this.sparkMesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    this.sparkMesh.frustumCulled = false; this.sparkMesh.name = 'fx_sparks'; this.sparkMesh.renderOrder = 10;
    this.group.add(this.sparkMesh);
  }

  burstSparks(pos, normal, scale = 1) {
    if (!pos) return;
    const b = this.spNext; this.spNext = (this.spNext + 1) % FX_CAPS.sparkBursts;
    this.spBurstT[b] = 0;
    const per = this.sparksPerBurst, r = this.rng;
    const nx = normal ? normal.x : 0, ny = normal ? normal.y : 0.4, nz = normal ? normal.z : 0;
    for (let j = 0; j < per; j++) {
      const i = b * per + j, o = i * 3;
      // radial fan biased along the normal
      const a = r.float() * Math.PI * 2, e = r.range(-0.3, 0.9), sp = r.range(4, 11) * scale;
      const ce = Math.cos(e);
      let vx = Math.cos(a) * ce + nx * 0.8, vy = Math.sin(e) + ny * 0.8 + 0.3, vz = Math.sin(a) * ce + nz * 0.8;
      const l = Math.hypot(vx, vy, vz) || 1;
      this.spPos[o] = pos.x; this.spPos[o + 1] = pos.y; this.spPos[o + 2] = pos.z;
      this.spVel[o] = vx / l * sp; this.spVel[o + 1] = vy / l * sp; this.spVel[o + 2] = vz / l * sp;
      this.spLife[i] = SPARK_LIFE * r.range(0.6, 1.0);
    }
  }

  _updateSparks(dt) {
    let live = 0;
    for (let b = 0; b < FX_CAPS.sparkBursts; b++) if (this.spBurstT[b] >= 0) { this.spBurstT[b] += dt; if (this.spBurstT[b] > SPARK_LIFE) this.spBurstT[b] = -1; else live++; }
    if (live > this.maxSeen.sparkBursts) this.maxSeen.sparkBursts = live;
    const P = this.spPos, V = this.spVel, L = this.spLinePos, Cc = this.spLineCol;
    let count = 0;
    for (let i = 0; i < this.spN; i++) {
      const o = i * 3, o6 = i * 6;
      if (this.spLife[i] <= 0) { L[o6] = L[o6 + 3] = 0; L[o6 + 1] = L[o6 + 4] = -100; L[o6 + 2] = L[o6 + 5] = 0; continue; }
      this.spLife[i] -= dt;
      V[o + 1] += GRAV * dt;
      P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
      const t = Math.max(0, this.spLife[i] / SPARK_LIFE), st = 0.018;
      L[o6] = P[o]; L[o6 + 1] = P[o + 1]; L[o6 + 2] = P[o + 2];
      L[o6 + 3] = P[o] - V[o] * st; L[o6 + 4] = P[o + 1] - V[o + 1] * st; L[o6 + 5] = P[o + 2] - V[o + 2] * st;
      // hot white-orange head, deep orange tail, fading (HDR > 1 so bloom picks it up when post is on)
      Cc[o6] = 3.0 * t; Cc[o6 + 1] = 1.6 * t; Cc[o6 + 2] = 0.5 * t;
      Cc[o6 + 3] = 1.2 * t; Cc[o6 + 4] = 0.35 * t; Cc[o6 + 5] = 0.05 * t;
      count++;
    }
    this.stats.sparks = count;
    this.sparkMesh.visible = count > 0;
    if (count > 0) { this.sparkMesh.geometry.attributes.position.needsUpdate = true; this.sparkMesh.geometry.attributes.color.needsUpdate = true; }
  }

  // ---------- sprites: ink-blood (normal blending, dark) and splash droplets share one Points object ----------
  _initSprites() {
    const nb = FX_CAPS.bloodBursts * this.bloodPerBurst, nd = FX_CAPS.splashRings * this.dropsPerSplash;
    this.bN = nb; this.dN = nd; const n = nb + nd;
    this.prPos = new Float32Array(n * 3); this.prVel = new Float32Array(n * 3); this.prLife = new Float32Array(n);
    this.prMax = new Float32Array(n).fill(1);
    this.prCol = new Float32Array(n * 4); this.prSize = new Float32Array(n);
    this.bBurstT = new Float32Array(FX_CAPS.bloodBursts).fill(-1); this.bNext = 0;
    this.dBurstT = new Float32Array(FX_CAPS.splashRings).fill(-1); this.dNext = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.prPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.prCol, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.prSize, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
    this.spriteMat = new THREE.ShaderMaterial({ vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS, transparent: true,
      depthWrite: false, uniforms: { uScale: { value: 300 } } });
    this.sprites = new THREE.Points(g, this.spriteMat);
    this.sprites.frustumCulled = false; this.sprites.name = 'fx_sprites'; this.sprites.renderOrder = 9;
    this.group.add(this.sprites);
  }

  setViewportHeight(px) { this.spriteMat.uniforms.uScale.value = px * 0.55; }

  burstBlood(pos, normal, scale = 1) {
    if (!pos) return;
    const b = this.bNext; this.bNext = (this.bNext + 1) % FX_CAPS.bloodBursts; this.bBurstT[b] = 0;
    const per = this.bloodPerBurst, r = this.rng;
    const nx = normal ? normal.x : 0, ny = normal ? normal.y : 0.2, nz = normal ? normal.z : 1;
    for (let j = 0; j < per; j++) {
      const i = b * per + j, o = i * 3;
      // cone along the hit normal (35 deg)
      const sx = r.range(-0.6, 0.6), sy = r.range(-0.3, 0.7), sz = r.range(-0.6, 0.6), sp = r.range(2, 6) * scale;
      let vx = nx + sx, vy = ny + sy + 0.25, vz = nz + sz; const l = Math.hypot(vx, vy, vz) || 1;
      this.prPos[o] = pos.x; this.prPos[o + 1] = pos.y; this.prPos[o + 2] = pos.z;
      this.prVel[o] = vx / l * sp; this.prVel[o + 1] = vy / l * sp; this.prVel[o + 2] = vz / l * sp;
      const life = BLOOD_LIFE * r.range(0.6, 1.0); this.prLife[i] = life; this.prMax[i] = life;
      this.prSize[i] = r.range(0.08, 0.22) * scale;
    }
  }

  splash(x, z, strength = 1) {
    const b = this.dNext; this.dNext = (this.dNext + 1) % FX_CAPS.splashRings; this.dBurstT[b] = 0;
    const per = this.dropsPerSplash, r = this.rng, base = this.bN;
    for (let j = 0; j < per; j++) {
      const i = base + b * per + j, o = i * 3;
      const a = (j / per) * Math.PI * 2 + r.range(-0.3, 0.3), sp = r.range(0.8, 2.0) * strength;
      this.prPos[o] = x; this.prPos[o + 1] = 0.2; this.prPos[o + 2] = z;
      this.prVel[o] = Math.cos(a) * sp; this.prVel[o + 1] = r.range(1.5, 3.2) * strength; this.prVel[o + 2] = Math.sin(a) * sp;
      const life = DROP_LIFE * r.range(0.5, 0.8); this.prLife[i] = life; this.prMax[i] = life;
      this.prSize[i] = r.range(0.04, 0.09);
    }
    if (this.water) { this.water.addRipple(x, z, 0.4 + 0.6 * strength); this.stats.ripples++; }
  }

  _updateSprites(dt) {
    let lb = 0, ld = 0;
    for (let b = 0; b < FX_CAPS.bloodBursts; b++) if (this.bBurstT[b] >= 0) { this.bBurstT[b] += dt; if (this.bBurstT[b] > BLOOD_LIFE) this.bBurstT[b] = -1; else lb++; }
    for (let b = 0; b < FX_CAPS.splashRings; b++) if (this.dBurstT[b] >= 0) { this.dBurstT[b] += dt; if (this.dBurstT[b] > DROP_LIFE) this.dBurstT[b] = -1; else ld++; }
    if (lb > this.maxSeen.bloodBursts) this.maxSeen.bloodBursts = lb;
    if (ld > this.maxSeen.splashes) this.maxSeen.splashes = ld;
    const P = this.prPos, V = this.prVel, Cc = this.prCol, n = this.bN + this.dN;
    let nb = 0, nd = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 3, o4 = i * 4;
      if (this.prLife[i] <= 0) { Cc[o4 + 3] = 0; continue; }
      this.prLife[i] -= dt;
      const blood = i < this.bN;
      V[o + 1] += GRAV * dt * (blood ? 0.8 : 1);
      if (blood) { V[o] *= 0.97; V[o + 2] *= 0.97; }
      P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
      if (P[o + 1] < 0.19) {                       // hit the water / ground: stop; blood on water leaves a stain
        P[o + 1] = 0.19; V[o] = V[o + 1] = V[o + 2] = 0;
        if (blood && this.prLife[i] > 0.05 && this.water && (i % this.bloodPerBurst) === 0 && Math.abs(P[o + 2]) < 6.7) {
          this.water.addStain(P[o], P[o + 2], 0.45); this.stats.stains++;
        }
        if (!blood) this.prLife[i] = Math.min(this.prLife[i], 0.05);
      }
      const t = Math.max(0, this.prLife[i] / this.prMax[i]);
      if (blood) { // dark red -> black
        Cc[o4] = 0.32 * t + 0.03; Cc[o4 + 1] = 0.01; Cc[o4 + 2] = 0.015; Cc[o4 + 3] = Math.min(1, t * 1.6) * 0.95; nb++;
      } else {
        Cc[o4] = 0.75; Cc[o4 + 1] = 0.8; Cc[o4 + 2] = 0.82; Cc[o4 + 3] = t * 0.7; nd++;
      }
    }
    this.stats.blood = nb; this.stats.drops = nd;
    this.sprites.visible = nb + nd > 0;
    if (nb + nd > 0) { const a = this.sprites.geometry.attributes; a.position.needsUpdate = true; a.aColor.needsUpdate = true; a.aSize.needsUpdate = true; }
  }

  // ---------- blade streaks: ribbon from guard->tip sample history (6 samples), additive crimson ----------
  _initStreaks() {
    const S = FX_CAPS.streakSamples, n = FX_CAPS.streaks;
    this.stHist = new Float32Array(n * S * 6);   // per sample: guard xyz, tip xyz
    this.stCount = new Uint8Array(n); this.stLife = new Float32Array(n); this.stActive = new Uint8Array(n);
    this.stOwner = new Int32Array(n).fill(-1);
    const SEG = (S - 1) * RIB_SUB;             // v2.17: smoothed sub-segments per streak
    const verts = n * SEG * 6;                  // 2 tris per sub-segment
    this.stSm = new Float32Array(n * (SEG + 1) * 6);   // Catmull-Rom smoothed guard/tip points (scratch, reused)
    this.stPos = new Float32Array(verts * 3); this.stAlpha = new Float32Array(verts);
    this.stCol = new Float32Array(verts * 3); this.stEdge = new Float32Array(verts); this.stU = new Float32Array(verts);
    this.stTint = new Float32Array(n * 3); this.stLifeMax = new Float32Array(n).fill(STREAK_LIFE);
    for (let v = 0; v < verts; v++) this.stEdge[v] = QUAD_EDGE[v % 6];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.stPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(this.stAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aC', new THREE.BufferAttribute(this.stCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aE', new THREE.BufferAttribute(this.stEdge, 1));
    g.setAttribute('aU', new THREE.BufferAttribute(this.stU, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
    // v2.9 ink ribbon: per-owner tint, hot leading (tip) edge, soft wash fading toward the guard
    // v2.17: smoothed arc, brush fibres, dry-brush tail (RIBBON_VS / RIBBON_FS)
    const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: RIBBON_VS, fragmentShader: RIBBON_FS });
    this.streakMesh = new THREE.Mesh(g, m); this.streakMesh.frustumCulled = false; this.streakMesh.name = 'fx_streaks'; this.streakMesh.renderOrder = 11;
    this.group.add(this.streakMesh);
  }

  // Called per frame while an ACTIVE window is open for ownerId with the blade guard/tip world positions.
  // tint: 0xRRGGBB (default crimson), linger: seconds the ribbon persists after the window closes (ink wash)
  streakSample(ownerId, guard, tip, tint = 0xff1f14, linger = STREAK_LIFE) {
    const S = FX_CAPS.streakSamples;
    let s = -1;
    for (let i = 0; i < FX_CAPS.streaks; i++) if (this.stActive[i] && this.stOwner[i] === ownerId) { s = i; break; }
    if (s < 0) {
      for (let i = 0; i < FX_CAPS.streaks; i++) if (!this.stActive[i] && this.stLife[i] <= 0) { s = i; break; }
      if (s < 0) return;                         // cap reached: drop (decorative, never gameplay)
      this.stActive[s] = 1; this.stOwner[s] = ownerId; this.stCount[s] = 0;
    }
    // HDR tint, scaled so the brightest channel lands at 1.25: bright enough to read as light, low enough that the
    // tonemap keeps the hue (x1.6 on every channel pushed jade past 1.0 on two channels and washed it to white)
    const tr = ((tint >> 16) & 255) / 255, tg = ((tint >> 8) & 255) / 255, tb = (tint & 255) / 255, k = 1.25 / Math.max(tr, tg, tb, 1e-3);
    this.stTint[s * 3] = tr * k; this.stTint[s * 3 + 1] = tg * k; this.stTint[s * 3 + 2] = tb * k;
    this.stLifeMax[s] = linger;
    const H = this.stHist, base = s * S * 6;
    H.copyWithin(base + 6, base, base + (S - 1) * 6);
    H[base] = guard.x; H[base + 1] = guard.y; H[base + 2] = guard.z; H[base + 3] = tip.x; H[base + 4] = tip.y; H[base + 5] = tip.z;
    if (this.stCount[s] < S) this.stCount[s]++;
    this.stLife[s] = linger;
  }

  streakEnd(ownerId) { for (let i = 0; i < FX_CAPS.streaks; i++) if (this.stActive[i] && this.stOwner[i] === ownerId) this.stActive[i] = 0; }

  _updateStreaks(dt) {
    const S = FX_CAPS.streakSamples, SEG = (S - 1) * RIB_SUB, H = this.stHist, M = this.stSm;
    const P = this.stPos, A = this.stAlpha, C = this.stCol, T = this.stTint, U = this.stU;
    let v = 0, live = 0;
    for (let s = 0; s < FX_CAPS.streaks; s++) {
      if (!this.stActive[s]) this.stLife[s] -= dt;
      const c = this.stCount[s], on = this.stLife[s] > 0 && c >= 2;
      if (on) live++;
      // ease-out fade: the ink wash hangs, then dissolves
      const u = on ? Math.min(1, this.stLife[s] / this.stLifeMax[s]) : 0, fade = u * (2 - u);
      const tr = T[s * 3], tg = T[s * 3 + 1], tb = T[s * 3 + 2];
      const hb = s * S * 6, mb = s * (SEG + 1) * 6, lastJ = (c - 1) * RIB_SUB;
      // v2.17 Catmull-Rom through the raw guard/tip history: a fast swing that moved 40 deg between two samples now
      // draws a curved arc instead of a flat facet (endpoints clamped, so the curve passes through every sample)
      if (on) for (let j = 0; j <= lastJ; j++) {
        const k = Math.min(c - 2, (j / RIB_SUB) | 0), t = (j - k * RIB_SUB) / RIB_SUB, t2 = t * t, t3 = t2 * t;
        const i0 = hb + Math.max(0, k - 1) * 6, i1 = hb + k * 6, i2 = hb + (k + 1) * 6, i3 = hb + Math.min(c - 1, k + 2) * 6, o = mb + j * 6;
        for (let q = 0; q < 6; q++) {
          const p0 = H[i0 + q], p1 = H[i1 + q], p2 = H[i2 + q], p3 = H[i3 + q];
          M[o + q] = 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
        }
      }
      const inv = lastJ > 0 ? 1 / lastJ : 0;
      for (let j = 0; j < SEG; j++) {
        const a = mb + j * 6, valid = on && j < lastJ;
        // quadratic falloff along the history so the tail tapers like a brush stroke
        const u0 = j * inv, u1 = (j + 1) * inv;   // 0 at the blade, 1 at the oldest live sample (dry-brush tail)
        // v2.17e: taper over the LIVE history (u), not the full buffer: a short stroke (charge wind-up, first frames
        // of a swing) used to end at ~50% alpha and showed a hard straight tail edge, so the ribbon read as a card
        const q0 = 1 - u0, q1 = 1 - u1;
        const al0 = valid ? fade * q0 * q0 : 0, al1 = valid ? fade * q1 * q1 : 0;
        // quad (g0, t0, t1) (g0, t1, g1); offsets from a: g0 0, t0 3, g1 6, t1 9 (static tables, no allocation)
        for (let jj = 0; jj < 6; jj++) {
          const src = valid ? a + QUAD_OFF[jj] : a;   // dead quads collapse to one point (no stray overdraw)
          P[v * 3] = M[src]; P[v * 3 + 1] = M[src + 1]; P[v * 3 + 2] = M[src + 2];
          const nx = QUAD_NEXT[jj]; A[v] = nx ? al1 : al0; U[v] = nx ? u1 : u0;
          C[v * 3] = tr; C[v * 3 + 1] = tg; C[v * 3 + 2] = tb; v++;
        }
      }
    }
    this.stats.streaks = live;
    if (live > this.maxSeen.streaks) this.maxSeen.streaks = live;
    this.streakMesh.visible = live > 0;
    if (live > 0) { const at = this.streakMesh.geometry.attributes; at.position.needsUpdate = true; at.aA.needsUpdate = true; at.aC.needsUpdate = true; at.aU.needsUpdate = true; }
  }

  // ---------- telegraph auras: additive ground ring + inner disc per actor slot, colour = art ----------
  _initAuras() {
    this.auras = [];
    const ringG = new THREE.RingGeometry(0.82, 1.0, 64, 1); ringG.rotateX(-Math.PI / 2);
    const discG = new THREE.CircleGeometry(0.82, 48); discG.rotateX(-Math.PI / 2);
    this._auraGeos = [ringG, discG];
    for (let i = 0; i < FX_CAPS.auras; i++) {
      const g = new THREE.Group(); g.name = 'fx_aura_' + i; g.visible = false;
      const rm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      const dm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      const ring = new THREE.Mesh(ringG, rm), disc = new THREE.Mesh(discG, dm);
      ring.renderOrder = disc.renderOrder = 8;
      g.add(ring, disc); this.group.add(g);
      this.auras.push({ g, rm, dm, owner: -1, mode: 0, lead: 0, t: 0, radius: 1, follow: null });
    }
  }

  // Start a telegraph on actorId: mode TELEGRAPH.*, leadFrames until contact, follow = Object3D (ground position)
  telegraph(actorId, mode, leadFrames, follow, radius = 1.2) {
    let a = null;
    for (const x of this.auras) if (x.owner === actorId) { a = x; break; }
    if (!a) for (const x of this.auras) if (x.owner < 0) { a = x; break; }
    if (!a) return;
    a.owner = actorId; a.mode = mode; a.lead = Math.max(1, leadFrames) / 60; a.t = 0; a.follow = follow; a.radius = radius;
    a.rm.color.setHex(TELEGRAPH_COLORS[mode]); a.dm.color.setHex(TELEGRAPH_COLORS[mode]);
    a.g.visible = true;
  }

  clearTelegraph(actorId) { for (const a of this.auras) if (a.owner === actorId) { a.owner = -1; a.g.visible = false; } }

  // ---------- impact shockwaves: expanding additive ground ring + core disc (4 slots, round-robin) ----------
  _initShock() {
    this.shocks = [];
    const ringG = new THREE.RingGeometry(0.86, 1.0, 64, 1); ringG.rotateX(-Math.PI / 2);
    this._auraGeos.push(ringG);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
      const r = new THREE.Mesh(ringG, m); r.name = 'fx_shock_' + i; r.visible = false; r.renderOrder = 9;
      this.group.add(r); this.shocks.push({ r, m, t: -1, life: 0.45, rad: 3, k: 1 });
    }
    this.shockNext = 0;
  }
  // pos on the ground, radius = final radius (m), color hex, k = brightness
  shockwave(x, y, z, radius = 3, color = 0xffa040, k = 1, life = 0.45) {
    const s = this.shocks[this.shockNext]; this.shockNext = (this.shockNext + 1) % this.shocks.length;
    s.t = 0; s.life = life; s.rad = radius; s.k = this.reducedMotion ? k * 0.5 : k;
    s.r.position.set(x, y, z); s.m.color.setHex(color); s.r.visible = true; s.r.scale.setScalar(0.2);
  }
  _updateShock(dt) {
    for (const s of this.shocks) {
      if (s.t < 0) continue;
      s.t += dt; const u = s.t / s.life;
      if (u >= 1) { s.t = -1; s.r.visible = false; continue; }
      const e = 1 - (1 - u) * (1 - u) * (1 - u);          // ease-out: fast burst, slow settle
      s.r.scale.setScalar(0.2 + s.rad * e);
      s.m.opacity = 1.6 * s.k * (1 - u) * (1 - u);
    }
  }

  // ---------- just-guard chevrons (Stage 3 spec section 6): cyan double-V that punches in on the hero's guard
  // point, billboarded to the camera at spawn, cap 4 round-robin. Built at init so the prewarm compiles it.
  _initChevrons() {
    this.chevrons = [];
    // one V = two bars meeting at the bottom point; a second, smaller V nested above reads as a chevron stack
    const p = [], idx = []; let n = 0;
    const bar = (x0, y0, x1, y1, w) => {
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy), nx = -dy / l * w, ny = dx / l * w;
      p.push(x0 + nx, y0 + ny, 0, x0 - nx, y0 - ny, 0, x1 - nx, y1 - ny, 0, x1 + nx, y1 + ny, 0);
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3); n += 4;
    };
    bar(-0.5, 0.42, 0, -0.08, 0.07); bar(0, -0.08, 0.5, 0.42, 0.07);
    bar(-0.32, 0.62, 0, 0.3, 0.045); bar(0, 0.3, 0.32, 0.62, 0.045);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(idx);
    this._chevGeo = g; this._auraGeos.push(g);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshBasicMaterial({ color: 0x40e0ff, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, opacity: 0 });
      const mesh = new THREE.Mesh(g, m); mesh.name = 'fx_chevron_' + i; mesh.visible = false; mesh.renderOrder = 12;
      this.group.add(mesh); this.chevrons.push({ g: mesh, m, t: -1, life: 0.42, k: 1 });
    }
    this.chevNext = 0;
  }
  // pos = guard point (world), quat = camera quaternion at the contact frame, perfect = brighter + larger
  chevron(pos, quat, perfect = false) {
    const c = this.chevrons[this.chevNext]; this.chevNext = (this.chevNext + 1) % this.chevrons.length;
    c.t = 0; c.life = perfect ? 0.5 : 0.4; c.k = perfect ? 1.6 : 1.0;
    c.g.position.copy(pos); c.g.quaternion.copy(quat); c.g.visible = true;
    c.m.color.setHex(perfect ? 0x9ff4ff : 0x40e0ff);
  }
  _updateChevrons(dt) {
    let n = 0;
    for (const c of this.chevrons) {
      if (c.t < 0) continue;
      c.t += dt; const u = c.t / c.life;
      if (u >= 1) { c.t = -1; c.g.visible = false; continue; }
      n++;
      const pop = this.reducedMotion ? 1 : u < 0.18 ? 1.5 - 2.6 * u : 1.03 + 0.25 * u;   // punch in, then drift open
      c.g.scale.setScalar(0.55 * c.k * pop);
      c.g.position.y += dt * 0.6;
      c.m.opacity = 2.2 * (1 - u) * (1 - u);
    }
    this.stats.chevrons = n;
    if (n > this.maxSeen.chevrons) this.maxSeen.chevrons = n;
  }

  // ---------- v2.13 contact flares: a short HDR star-burst billboard at every blade contact (4-slot ring).
  // Gives outgoing hits and deflects the brightest, sharpest read on screen (FX hierarchy: contact > telegraph > floor).
  _initFlares() {
    this.flares = []; this.flareNext = 0;
    const g = new THREE.PlaneGeometry(1, 1); this._flareGeo = g;
    for (let i = 0; i < 4; i++) {
      const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
        uniforms: { uC: { value: new THREE.Color(1, 0.6, 0.3) }, uA: { value: 0 }, uRot: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv - 0.5; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);' +
          ' vec3 s = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), 1.0); mv.xy += position.xy * s.xy; gl_Position = projectionMatrix * mv; }',
        fragmentShader: 'uniform vec3 uC; uniform float uA, uRot; varying vec2 vUv; void main(){' +
          ' float c = cos(uRot), s = sin(uRot); vec2 p = mat2(c, -s, s, c) * vUv * 2.0; float r = length(p);' +
          ' float core = exp(-r * r * 40.0); float halo = exp(-r * 5.0) * 0.35;' +
          ' float star = exp(-abs(p.x) * 38.0) * exp(-abs(p.y) * 2.4) + exp(-abs(p.y) * 38.0) * exp(-abs(p.x) * 2.4);' +
          ' float k = core * 3.0 + halo + star * 1.4; if (k < 0.004) discard; vec3 col = mix(uC, vec3(1.0), clamp(core, 0.0, 1.0)) * k * uA;' +
          ' gl_FragColor = vec4(col, clamp(k * uA, 0.0, 1.0));\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}' });
      const mesh = new THREE.Mesh(g, m); mesh.name = 'fx_flare_' + i; mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 13;
      this.group.add(mesh); this.flares.push({ g: mesh, m, t: -1, life: 0.16, k: 1 });
    }
  }
  flare(pos, k = 1, color = 0xff9040) {
    if (!pos) return;
    const f = this.flares[this.flareNext]; this.flareNext = (this.flareNext + 1) % this.flares.length;
    f.t = 0; f.k = k; f.life = 0.12 + 0.06 * Math.min(k, 2);
    f.g.position.copy(pos); f.g.visible = true; f.m.uniforms.uC.value.setHex(color);
    f.m.uniforms.uRot.value = this.rng.range(-0.5, 0.5);
  }
  // ---------- v2.21 rift slashes (Ember Rift space-cuts): 16 view-aligned hairline blades, round-robin. Each one
  // snaps open along its length in ~40 ms (white core, coloured edge), holds, then thins out. One program, built at
  // init so prewarm compiles it. Reduced motion: shorter, dimmer, no length overshoot.
  _initRifts() {
    this.rifts = []; this.riftNext = 0;
    const g = new THREE.PlaneGeometry(1, 1); this._riftGeo = g;
    const mat = (i) => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uC: { value: new THREE.Color(0.6, 0.9, 1.0) }, uA: { value: 0 }, uRot: { value: 0 }, uOpen: { value: 0 }, uW: { value: 1 } },
      vertexShader: 'uniform float uRot, uOpen; varying vec2 vUv; void main(){ vUv = uv - 0.5; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);' +
        ' vec3 s = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), 1.0); vec2 q = position.xy * s.xy; q.x *= uOpen;' +
        ' float c = cos(uRot), n = sin(uRot); mv.xy += vec2(c * q.x - n * q.y, n * q.x + c * q.y); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform vec3 uC; uniform float uA, uW; varying vec2 vUv; void main(){' +
        ' float ax = abs(vUv.x) * 2.0; float taper = 1.0 - ax * ax; float y = abs(vUv.y) * 2.0 / max(0.05, uW * taper);' +
        ' float core = exp(-y * y * 30.0); float edge = exp(-y * 3.2) * 0.45; float k = (core * 2.4 + edge) * taper; if (k < 0.004) discard;' +
        ' vec3 col = mix(uC, vec3(1.0), clamp(core, 0.0, 1.0)) * k * uA;' +
        ' gl_FragColor = vec4(col, clamp(k * uA, 0.0, 1.0));\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}' });
    for (let i = 0; i < 16; i++) {
      const m = mat(i), mesh = new THREE.Mesh(g, m); mesh.name = 'fx_rift_' + i; mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 14;
      this.group.add(mesh); this.rifts.push({ g: mesh, m, t: -1, life: 0.32, len: 4, delay: 0 });
    }
  }
  // pos = blade centre (world), len = blade length (m), rot = screen-space angle (rad), delay = seconds before it opens
  riftSlash(pos, len = 4, rot = 0, color = 0x9fe8ff, delay = 0, life = 0.32) {
    if (!pos) return;
    const r = this.rifts[this.riftNext]; this.riftNext = (this.riftNext + 1) % this.rifts.length;
    r.t = -delay - 1e-4; r.delay = delay; r.len = this.reducedMotion ? len * 0.8 : len; r.life = this.reducedMotion ? life * 0.7 : life;
    r.g.position.copy(pos); r.g.visible = false; r.m.uniforms.uC.value.setHex(color); r.m.uniforms.uRot.value = rot; r.m.uniforms.uA.value = 0;
    r.live = true;
  }
  clearRifts() { for (const r of this.rifts) { r.live = false; r.t = -1; r.g.visible = false; } }
  _updateRifts(dt) {
    let n = 0;
    for (const r of this.rifts) {
      if (!r.live) continue;
      r.t += dt;
      if (r.t < 0) continue;
      const u = r.t / r.life;
      if (u >= 1) { r.live = false; r.g.visible = false; continue; }
      n++; r.g.visible = true;
      const open = Math.min(1, r.t / 0.04), U = r.m.uniforms;
      U.uOpen.value = this.reducedMotion ? open : open * (1 + 0.08 * Math.max(0, 1 - u * 3));
      U.uW.value = Math.max(0.15, 1 - u * 0.85);
      U.uA.value = (u < 0.15 ? 3.0 : 3.0 * (1 - (u - 0.15) / 0.85)) * (this.reducedMotion ? 0.55 : 1);
      r.g.scale.set(r.len, 0.09 * r.len, 1);
    }
    this.stats.rifts = n;
  }

  _updateFlares(dt) {
    let n = 0;
    for (const f of this.flares) {
      if (f.t < 0) continue;
      f.t += dt; const u = f.t / f.life;
      if (u >= 1) { f.t = -1; f.g.visible = false; continue; }
      n++;
      const grow = this.reducedMotion ? 1 : 0.7 + 0.6 * Math.sqrt(u);
      f.g.scale.set(1.5 * f.k * grow, 1.5 * f.k * grow, 1);
      f.m.uniforms.uA.value = 2.4 * (1 - u) * (1 - u) * (this.reducedMotion ? 0.6 : 1);
    }
    this.stats.flares = n;
  }

  _updateAuras(dt) {
    let n = 0;
    for (const a of this.auras) {
      if (a.owner < 0) continue;
      a.t += dt; n++;
      const u = Math.min(1, a.t / a.lead);
      if (a.follow) a.g.position.set(a.follow.position.x, 0.205, a.follow.position.z);
      // ring contracts toward the actor as contact approaches; intensity ramps (HDR so it reads through haze)
      const s = a.radius * (1.6 - 0.6 * u);
      a.g.scale.set(s, 1, s);
      const pulse = this.reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(a.t * 24);
      a.rm.opacity = (0.55 + 0.45 * u) * pulse; a.dm.opacity = (a.mode === TELEGRAPH.NORMAL ? 0.10 : 0.22) * (0.5 + 0.5 * u);
      if (a.t > a.lead + 0.15) { a.owner = -1; a.g.visible = false; }
    }
    this.stats.auras = n;
    if (n > this.maxSeen.auras) this.maxSeen.auras = n;
  }

  // ---------- afterimages: frozen-pose ghosts of a skinned actor (shared geometry, copied bone matrices) ----------
  registerAfterimages(actorId, root) {
    const per = this.reducedMotion ? 1 : FX_CAPS.afterimagesPerActor;
    const srcs = [];
    root.traverse((o) => { if (o.isSkinnedMesh) srcs.push(o); });
    const owner = { id: actorId, srcs, ghosts: [], next: 0, life: new Float32Array(per), per };
    for (let k = 0; k < per; k++) {
      const set = [];
      for (const src of srcs) {
        const skel = new THREE.Skeleton(src.skeleton.bones, src.skeleton.boneInverses);
        skel.update = noop;                     // pose is frozen at snapshot time
        const mat = new THREE.MeshBasicMaterial({ color: 0x6fb4ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
        const g = new THREE.SkinnedMesh(src.geometry, mat);
        g.bind(skel, src.bindMatrix); g.bindMode = THREE.DetachedBindMode;
        g.matrixAutoUpdate = false; g.matrixWorldAutoUpdate = false; g.frustumCulled = false; g.visible = false;
        g.name = 'fx_ghost_' + actorId + '_' + k; g.renderOrder = 7;
        this.group.add(g);
        set.push({ g, skel, src, mat });
      }
      owner.ghosts.push(set);
    }
    this.ghostOwners.push(owner);
    return owner;
  }

  afterimage(actorId, red = false, strength = 1) {
    const o = this._ghostOwner(actorId); if (!o) return;
    const k = o.next; o.next = (o.next + 1) % o.per; o.life[k] = GHOST_LIFE;
    for (const e of o.ghosts[k]) {
      const sb = e.src.skeleton;
      if (!sb.boneMatrices) continue;
      if (!e.skel.boneMatrices || e.skel.boneMatrices.length !== sb.boneMatrices.length) e.skel.boneMatrices = new Float32Array(sb.boneMatrices.length);
      e.skel.boneMatrices.set(sb.boneMatrices);
      if (e.skel.boneTexture) e.skel.boneTexture.needsUpdate = true;
      e.g.matrixWorld.copy(e.src.matrixWorld);
      e.g.bindMatrix.copy(e.src.bindMatrix); e.g.bindMatrixInverse.copy(e.src.bindMatrixInverse);
      e.mat.color.setHex(typeof red === 'number' ? red : red ? 0xff3a2a : 0x6fb4ff);
      e.mat.userData.peak = 0.55 * strength;
      e.g.visible = true;
    }
  }

  _ghostOwner(id) { for (const o of this.ghostOwners) if (o.id === id) return o; return null; }

  _updateGhosts(dt) {
    let live = 0, maxPer = 0;
    for (const o of this.ghostOwners) {
      let per = 0;
      for (let k = 0; k < o.per; k++) {
        if (o.life[k] <= 0) continue;
        o.life[k] -= dt;
        const t = Math.max(0, o.life[k] / GHOST_LIFE);
        for (const e of o.ghosts[k]) { e.mat.opacity = (e.mat.userData.peak || 0.5) * t; e.g.visible = t > 0; }
        if (t > 0) { live++; per++; }
      }
      if (per > maxPer) maxPer = per;
    }
    this.stats.ghosts = live;
    if (maxPer > this.maxSeen.ghostsPerActor) this.maxSeen.ghostsPerActor = maxPer;
  }

  // ---------- fire breath: flame cone + embers + smoke (two Points objects, ring-allocated, no per-frame alloc) ----------
  _initFlame() {
    const mk = (n, fs, additive, name, order) => {
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n), seed = new Float32Array(n);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1).setUsage(THREE.DynamicDrawUsage));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
      const m = new THREE.ShaderMaterial({ vertexShader: FIRE_VS, fragmentShader: fs, transparent: true, depthWrite: false,
        blending: additive ? THREE.CustomBlending : THREE.NormalBlending, uniforms: { uScale: this.spriteMat.uniforms.uScale } });
      // flame: premultiplied glow with backing (see FLAME_FS); blend factors are GL state, not part of the program key
      if (additive) { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; }
      const p = new THREE.Points(g, m); p.frustumCulled = false; p.name = name; p.renderOrder = order; p.visible = false;
      this.group.add(p);
      return { p, pos, col, size, seed, vel: new Float32Array(n * 3), life: new Float32Array(n), max: new Float32Array(n).fill(1), n, next: 0 };
    };
    this.flame = mk(FLAME_N, FLAME_FS, true, 'fx_flame', 12);
    this.smoke = mk(SMOKE_N, SMOKE_FS, false, 'fx_smoke', 6);
    this.flameSoot = new Uint8Array(FLAME_N);  // 1 once a breath tongue has shed its soot puff
    this.flameAcc = 0; this.smokeAcc = 0; this.breathHeat = 0;
    // per-particle smoke tint (rgb + peak alpha); breath/pool smoke writes the soot default, mist() writes presets
    this.smokeTint = new Float32Array(SMOKE_N * 4);
    this.smokeDrag = new Float32Array(SMOKE_N);
    this.mistLive = 0;
    this.flameJet = new Uint8Array(FLAME_N);   // 1 = breath stream particle (low drag, widening), 0 = pool lick
  }

  // Emit breath this frame: origin (mouth), unit dir, cone half-angle, speed, rate (particles/s). dt = presentation dt.
  breath(origin, dx, dy, dz, dt, { half = 0.22, speed = 10, rate = 220, size = 1 } = {}) {
    if (dt <= 0) return;
    const F = this.flame, r = this.rng;
    this.breathHeat = 1;
    this.flameAcc += rate * dt;
    // orthonormal basis around dir (no allocation)
    let ux = -dz, uy = 0, uz = dx; let ul = Math.hypot(ux, uz); if (ul < 1e-4) { ux = 1; uz = 0; ul = 1; } ux /= ul; uz /= ul;
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    while (this.flameAcc >= 1) {
      this.flameAcc -= 1;
      const i = F.next; F.next = (F.next + 1) % F.n; const o = i * 3;
      const a = r.float() * Math.PI * 2, s = Math.tan(half) * Math.sqrt(r.float()), sp = speed * r.range(0.75, 1.15);
      let ex = dx + (ux * Math.cos(a) + vx * Math.sin(a)) * s, ey = dy + (uy * Math.cos(a) + vy * Math.sin(a)) * s, ez = dz + (uz * Math.cos(a) + vz * Math.sin(a)) * s;
      const l = Math.hypot(ex, ey, ez) || 1;
      F.pos[o] = origin.x + r.range(-0.1, 0.1); F.pos[o + 1] = origin.y + r.range(-0.1, 0.1); F.pos[o + 2] = origin.z + r.range(-0.1, 0.1);
      F.vel[o] = ex / l * sp; F.vel[o + 1] = ey / l * sp; F.vel[o + 2] = ez / l * sp;
      const life = FLAME_LIFE * r.range(0.7, 1.0); F.life[i] = life; F.max[i] = life;
      F.size[i] = r.range(0.16, 0.28) * size; this.flameJet[i] = 1; F.seed[i] = r.range(0.05, 8); this.flameSoot[i] = 0;
      // v2.17 embers: ~1 in 9 stream particles is a long-lived hot point thrown wide off the cone
      if (r.float() < 0.11) this._ember(F.pos[o], F.pos[o + 1], F.pos[o + 2], F.vel[o] * 0.55 + r.range(-1.5, 1.5), F.vel[o + 1] * 0.55 + r.range(0.5, 2.5), F.vel[o + 2] * 0.55 + r.range(-1.5, 1.5));
    }
    // embers at the mouth (velocity-stretched spark lines, shared spark pool)
    if (r.float() < dt * 8) { _ex.set(dx * 0.6, dy * 0.6 + 0.3, dz * 0.6); this.burstSparks(origin, _ex, 0.45); }
  }

  // Low licking flames over a burning pool (called per frame per live pool, rate scales with remaining life).
  poolFire(x, y, z, radius, dt, k = 1) {
    if (dt <= 0 || this.reducedMotion && k < 0.5) return;
    const F = this.flame, S = this.smoke, r = this.rng;
    this.smokeAcc += 5 * k * dt;
    let n = r.float() < 22 * k * dt ? 1 : 0;
    while (n-- > 0) {
      const i = F.next; F.next = (F.next + 1) % F.n; const o = i * 3;
      const a = r.float() * Math.PI * 2, d = Math.sqrt(r.float()) * radius * 0.85;
      F.pos[o] = x + Math.cos(a) * d; F.pos[o + 1] = y + 0.05; F.pos[o + 2] = z + Math.sin(a) * d;
      F.vel[o] = r.range(-0.2, 0.2); F.vel[o + 1] = r.range(1.2, 2.4); F.vel[o + 2] = r.range(-0.2, 0.2);
      const life = 0.55 * r.range(0.6, 1.0); F.life[i] = life; F.max[i] = life; F.size[i] = r.range(0.25, 0.5); this.flameJet[i] = 0;
      F.seed[i] = r.range(0.05, 8); this.flameSoot[i] = 1;
      if (r.float() < 0.25) this._ember(F.pos[o], F.pos[o + 1] + 0.1, F.pos[o + 2], r.range(-0.6, 0.6), r.range(1.5, 3.2), r.range(-0.6, 0.6));
    }
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      const i = S.next; S.next = (S.next + 1) % S.n; const o = i * 3;
      const a = r.float() * Math.PI * 2, d = Math.sqrt(r.float()) * radius * 0.7;
      S.pos[o] = x + Math.cos(a) * d; S.pos[o + 1] = y + 0.4; S.pos[o + 2] = z + Math.sin(a) * d;
      S.vel[o] = r.range(-0.15, 0.15); S.vel[o + 1] = r.range(0.6, 1.1); S.vel[o + 2] = r.range(-0.15, 0.15);
      const life = SMOKE_LIFE * r.range(0.7, 1.0); S.life[i] = life; S.max[i] = life; S.size[i] = r.range(0.8, 1.4); S.seed[i] = r.range(0.05, 8);
      const o4 = i * 4; this.smokeTint[o4] = 0.09; this.smokeTint[o4 + 1] = 0.07; this.smokeTint[o4 + 2] = 0.065; this.smokeTint[o4 + 3] = 0.45; this.smokeDrag[i] = 0;
    }
  }

  // v2.9 ink mist: a soft burst of billowing puffs (dodge vanish, kill dissolve). Shares the smoke pool, so no new
  // program. x,y,z = centre, radius = spawn spread, preset = MIST.*, n = puff count, up = rise speed.
  mist(x, y, z, radius = 0.6, preset = MIST.WHITE, n = 10, up = 0.6) {
    const S = this.smoke, r = this.rng, T = this.smokeTint, p4 = preset * 4;
    if (this.reducedMotion) n = Math.max(2, n >> 1);
    for (let j = 0; j < n; j++) {
      const i = S.next; S.next = (S.next + 1) % S.n; const o = i * 3, o4 = i * 4;
      const a = r.float() * Math.PI * 2, d = Math.sqrt(r.float()) * radius, h = r.range(-0.4, 0.6) * radius;
      S.pos[o] = x + Math.cos(a) * d; S.pos[o + 1] = y + h; S.pos[o + 2] = z + Math.sin(a) * d;
      const out = r.range(0.8, 2.2);
      S.vel[o] = Math.cos(a) * out; S.vel[o + 1] = up * r.range(0.6, 1.4); S.vel[o + 2] = Math.sin(a) * out;
      const life = r.range(0.7, 1.15); S.life[i] = life; S.max[i] = life; S.size[i] = r.range(0.5, 0.9) * (0.6 + radius); S.seed[i] = r.range(0.05, 8);
      T[o4] = MIST_RGBA[p4]; T[o4 + 1] = MIST_RGBA[p4 + 1]; T[o4 + 2] = MIST_RGBA[p4 + 2]; T[o4 + 3] = MIST_RGBA[p4 + 3]; this.smokeDrag[i] = 1;
    }
    this.mistLive++;
    if (this.mistCalls) this.mistCalls[preset] += n;   // QA attribution: puffs emitted per preset since boot
  }

  // v2.17 ember: a hot point in the flame pool (flameJet 2, negative seed = no erosion), gravity + drag, long life
  _ember(x, y, z, vx, vy, vz) {
    const F = this.flame, r = this.rng, i = F.next; F.next = (F.next + 1) % F.n; const o = i * 3;
    F.pos[o] = x; F.pos[o + 1] = y; F.pos[o + 2] = z; F.vel[o] = vx; F.vel[o + 1] = vy; F.vel[o + 2] = vz;
    const life = EMBER_LIFE * r.range(0.5, 1.0); F.life[i] = life; F.max[i] = life;
    F.size[i] = r.range(0.07, 0.12); F.seed[i] = -1; this.flameJet[i] = 2; this.flameSoot[i] = 1;
  }

  // v2.17 soot: one dark puff shed from an aged breath tongue (normal-blended, so it occludes rather than glows)
  _soot(x, y, z, vx, vy, vz, sz) {
    const S = this.smoke, r = this.rng, T = this.smokeTint, i = S.next; S.next = (S.next + 1) % S.n; const o = i * 3, o4 = i * 4;
    S.pos[o] = x; S.pos[o + 1] = y; S.pos[o + 2] = z; S.vel[o] = vx * 0.35; S.vel[o + 1] = Math.max(0.5, vy * 0.35) + 0.4; S.vel[o + 2] = vz * 0.35;
    // v2.17c: soot hangs ~2-2.5 s (was ~1 s, gone before the aftermath read) and is a touch denser
    const life = SMOKE_LIFE * r.range(1.4, 1.8); S.life[i] = life; S.max[i] = life; S.size[i] = Math.max(0.85, sz * 1.5); S.seed[i] = r.range(0.05, 8);
    // v2.17e: per-puff density varies (0.32-0.55) and puffs rise a little faster so the trail thins and breaks up
    T[o4] = 0.06; T[o4 + 1] = 0.045; T[o4 + 2] = 0.04; T[o4 + 3] = r.range(0.32, 0.55); this.smokeDrag[i] = 1;
    S.vel[o + 1] += r.range(0.2, 0.7);
  }

  _updateFlame(dt) {
    const F = this.flame, S = this.smoke;
    let nf = 0;
    const dJet = Math.exp(-1.1 * dt), dLick = Math.exp(-2.8 * dt), dEmb = Math.exp(-0.9 * dt);   // time-based drag
    const sootOK = !this.reducedMotion;
    for (let i = 0; i < F.n; i++) {
      const o = i * 3, o4 = i * 4;
      if (F.life[i] <= 0) { F.col[o4 + 3] = 0; continue; }
      F.life[i] -= dt;
      if (this.flameJet[i] === 2) {                  // ember: ballistic, flickers, cools white-gold -> deep red
        F.vel[o] *= dEmb; F.vel[o + 2] *= dEmb; F.vel[o + 1] = F.vel[o + 1] * dEmb - 2.4 * dt;
        F.pos[o] += F.vel[o] * dt; F.pos[o + 1] += F.vel[o + 1] * dt; F.pos[o + 2] += F.vel[o + 2] * dt;
        if (F.pos[o + 1] < 0.05) { F.pos[o + 1] = 0.05; F.vel[o + 1] = 0; F.life[i] -= dt * 3; }
        const t = Math.max(0, F.life[i] / F.max[i]), fl = 0.75 + 0.25 * Math.sin(F.life[i] * 47 + i);
        F.col[o4] = 2.2 * fl; F.col[o4 + 1] = (0.25 + 0.9 * t) * fl; F.col[o4 + 2] = 0.08 * t; F.col[o4 + 3] = Math.min(1, t * 3);
        if (F.life[i] <= 0) { F.col[o4 + 3] = 0; F.size[i] = 0; } else nf++;
        continue;
      }
      F.seed[i] += dt * 2.6;                         // boil: the noise field slides through the sprite
      const jet = this.flameJet[i], dr = jet ? dJet : dLick, ag = 1 - Math.max(0, F.life[i] / F.max[i]);
      // aged breath tongues shed a soot puff at ~70% age (max one per tongue, ~1 in 2 tongues)
      // v2.17d: shed earlier (0.62 -> 0.4) so dark soot sits along the stream and backs the flame against the fog
      if (sootOK && !this.flameSoot[i] && ag > 0.4) { this.flameSoot[i] = 1; if ((i % 3) !== 0) this._soot(F.pos[o], F.pos[o + 1], F.pos[o + 2], F.vel[o], F.vel[o + 1], F.vel[o + 2], F.size[i]); }
      F.vel[o] *= dr; F.vel[o + 2] *= dr; F.vel[o + 1] = F.vel[o + 1] * dr + (jet ? (ag > 0.45 ? 3.0 : 0.4) : 2.2) * dt;   // drag + late buoyancy
      F.pos[o] += F.vel[o] * dt; F.pos[o + 1] += F.vel[o + 1] * dt; F.pos[o + 2] += F.vel[o + 2] * dt;
      if (F.pos[o + 1] < 0.25) {                     // flame hits the ford: spreads flat, licks upward
        F.pos[o + 1] = 0.25; const sp = Math.hypot(F.vel[o], F.vel[o + 2]);
        F.vel[o + 1] = Math.max(F.vel[o + 1], 0.8); if (sp > 4) { F.vel[o] *= 1.15; F.vel[o + 2] *= 1.15; }
      }
      const t = Math.max(0, F.life[i] / F.max[i]), age = 1 - t;
      // v2.17 blackbody ramp: white-gold at the mouth -> orange -> deep red, then cooled to near-black at the
      // end of life (soot takes over the read), HDR so bloom treats the young flame as a light source
      const hot = Math.max(0, 1 - age * 2.2);
      // v2.17c: green/blue pulled down so the body sits in orange and the tail in red (was peach/gold at mid-stream)
      // v2.17d: additive orange over the grey-beige fog still read peach; the body now drops to red by mid-life
      // (G 0.36 -> 0 by age 0.45) so it stays saturated after the fog lifts it
      F.col[o4] = 1.7 - 0.8 * age; F.col[o4 + 1] = Math.max(0.0, 0.36 - 0.8 * age) + 0.24 * hot; F.col[o4 + 2] = 0.06 * hot * hot;
      // v2.17e: per-tongue flicker (seed drifts, so it pulses) breaks the uniform tube into brighter and dimmer licks
      const flick = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(F.seed[i] * 4.7 + i * 1.37));
      F.col[o4 + 3] = Math.min(1, t * 2.0) * Math.min(1, age * 6 + 0.35) * 0.6 * flick;
      F.size[i] = F.size[i] + dt * (jet ? 2.6 : 1.2);  // jet widens down the cone, licks billow gently
      if (F.life[i] <= 0) { F.col[o4 + 3] = 0; F.size[i] = 0; } else nf++;
    }
    let ns = 0;
    for (let i = 0; i < S.n; i++) {
      const o = i * 3, o4 = i * 4;
      if (S.life[i] <= 0) { S.col[o4 + 3] = 0; continue; }
      S.life[i] -= dt; S.seed[i] += dt * 0.7;       // slow roll: billows turn over as they rise
      if (this.smokeDrag[i]) { const dr = Math.exp(-3.2 * dt); S.vel[o] *= dr; S.vel[o + 2] *= dr; S.vel[o + 1] *= Math.exp(-1.2 * dt); }
      S.pos[o] += S.vel[o] * dt; S.pos[o + 1] += S.vel[o + 1] * dt; S.pos[o + 2] += S.vel[o + 2] * dt;
      const t = Math.max(0, S.life[i] / S.max[i]), T = this.smokeTint;
      S.col[o4] = T[o4]; S.col[o4 + 1] = T[o4 + 1]; S.col[o4 + 2] = T[o4 + 2]; S.col[o4 + 3] = Math.min(1, (1 - t) * 3) * t * T[o4 + 3] * (this.smokeDrag[i] ? 2.2 : 1);
      S.size[i] += dt * (this.smokeDrag[i] ? 1.6 : 0.9);
      if (S.life[i] > 0) ns++;
    }
    this.breathHeat = Math.max(0, this.breathHeat - dt * 4);
    this.stats.flame = nf; if (nf > this.maxSeen.flame) this.maxSeen.flame = nf;
    F.p.visible = nf > 0; S.p.visible = ns > 0;
    if (nf > 0) { const a = F.p.geometry.attributes; a.position.needsUpdate = true; a.aColor.needsUpdate = true; a.aSize.needsUpdate = true; a.aSeed.needsUpdate = true; }
    if (ns > 0) { const a = S.p.geometry.attributes; a.position.needsUpdate = true; a.aColor.needsUpdate = true; a.aSize.needsUpdate = true; a.aSeed.needsUpdate = true; }
  }

  // ---------- event routing ----------
  onContact(p) {
    if (p.outcome === Outcome.HIT || p.outcome === Outcome.GUARDBREAK) {
      if (p.surface === Surface.BLADE || p.surface === Surface.ARMOR) this.burstSparks(p.pos, p.normal, 0.6);
      else this.burstBlood(p.pos, p.normal, p.damage >= 25 ? 1.3 : 1);
      if (this.wet !== false && p.pos && p.pos.y < 1.2 && Math.abs(p.pos.z) < 6.7) this.splash(p.pos.x, p.pos.z, 0.6);
    } else if (p.outcome === Outcome.BLOCKED) this.burstSparks(p.pos, p.normal, 0.5);
  }

  request(kind, pos, normal, scale = 1) {
    switch (kind) {
      case FxKind.SPARK: case FxKind.PARRY_FLASH: this.burstSparks(pos, normal, scale); break;
      case FxKind.BLOOD_DUST: this.burstBlood(pos, normal, scale); break;
      case FxKind.DUST_PUFF: if (pos) this.splash(pos.x, pos.z, scale); break;
      case FxKind.EMBER_BURST: this.burstSparks(pos, normal, scale * 1.4); break;
      default: break;
    }
  }

  // dt = presentation dt (Loop passes dt * presentScale)
  update(dt) {
    if (dt <= 0) return;
    this._updateSparks(dt); this._updateSprites(dt); this._updateStreaks(dt); this._updateAuras(dt); this._updateShock(dt); this._updateChevrons(dt); this._updateFlares(dt); this._updateRifts(dt); this._updateGhosts(dt);
    this._updateFlame(dt);
  }

  // Clear every live flame/smoke particle (retry / restart).
  clearFire() {
    for (const P of [this.flame, this.smoke]) { P.life.fill(0); P.col.fill(0); P.p.visible = false; }
    this.flameAcc = this.smokeAcc = 0; this.breathHeat = 0;
    for (const s of this.shocks) { s.t = -1; s.r.visible = false; }
    for (const c of this.chevrons) { c.t = -1; c.g.visible = false; }
    for (const f of this.flares) { f.t = -1; f.g.visible = false; }
    this.clearRifts();
  }

  // Make every pooled object visible for one compileAsync pass (three compiles only traverseVisible), then restore.
  prewarmBegin() {
    this._pw = [];
    this.group.traverse((o) => { if (o !== this.group) { this._pw.push(o, o.visible); o.visible = true; } });
  }
  prewarmEnd() { for (let i = 0; i < this._pw.length; i += 2) this._pw[i].visible = this._pw[i + 1]; this._pw = null; }

  counts() { if (!this.mistCalls) this.mistCalls = new Int32Array(5); return { ...this.stats, maxSeen: { ...this.maxSeen }, mist: Array.from(this.mistCalls) }; }
  resetMax() { for (const k in this.maxSeen) this.maxSeen[k] = 0; }

  dispose() {
    if (this.bus && this._l) {
      this.bus.off('combat/contact', this._l.contact); this.bus.off('combat/parry', this._l.parry);
      this.bus.off('world/footstep', this._l.step); this.bus.off('fx/request', this._l.req);
    }
    const geos = new Set(this._auraGeos), mats = new Set();
    for (const m of [this.sparkMesh, this.sprites, this.streakMesh, this.flame.p, this.smoke.p]) { geos.add(m.geometry); mats.add(m.material); }
    for (const a of this.auras) { mats.add(a.rm); mats.add(a.dm); }
    for (const s of this.shocks || []) mats.add(s.m);
    for (const c of this.chevrons || []) mats.add(c.m);
    for (const f of this.flares || []) mats.add(f.m); if (this._flareGeo) geos.add(this._flareGeo);
    for (const r of this.rifts || []) mats.add(r.m); if (this._riftGeo) geos.add(this._riftGeo);
    for (const o of this.ghostOwners) for (const set of o.ghosts) for (const e of set) { mats.add(e.mat); if (e.skel.boneTexture) e.skel.boneTexture.dispose(); }
    geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose());
    this.scene.remove(this.group);
    this.ghostOwners = []; this.auras = [];
  }
}

function noop() {}
const _ex = new THREE.Vector3();
