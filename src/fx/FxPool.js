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

export const FX_CAPS = Object.freeze({ streaks: 4, streakSamples: 6, sparkBursts: 3, sparksPerBurst: 24,
  bloodBursts: 6, bloodPerBurst: 20, splashRings: 24, dropsPerSplash: 8, auras: 4, afterimagesPerActor: 4 });
export const TELEGRAPH = Object.freeze({ NORMAL: 0, RED: 1, BLUE: 2 });
export const TELEGRAPH_COLORS = Object.freeze([0xffd84a, 0xff2414, 0x2f7dff]);

const SPARK_LIFE = 0.25, BLOOD_LIFE = 0.5, DROP_LIFE = 0.8, STREAK_LIFE = 0.12, GHOST_LIFE = 0.3;
const GRAV = -9.81;
const QUAD_OFF = new Int8Array([0, 3, 9, 0, 9, 6]);
const QUAD_NEXT = new Uint8Array([0, 0, 1, 0, 1, 1]);

// soft round sprite with per-particle colour/alpha/size (one program for blood and droplets)
const SPRITE_VS = `
attribute vec4 aColor; attribute float aSize;
varying vec4 vColor;
uniform float uScale;
void main(){
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
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

// fire breath: additive flame sprites (hot core -> orange -> deep red) + normal-blended smoke, fixed pools
const FLAME_N = 320, SMOKE_N = 64, FLAME_LIFE = 0.55, SMOKE_LIFE = 1.4;
const FLAME_FS = `
varying vec4 vColor;
void main(){
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;
  if (r > 1.0 || vColor.a <= 0.0) discard;
  float k = (1.0 - r); k *= k;
  gl_FragColor = vec4(vColor.rgb * vColor.a * k, 1.0);
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
    this._initSparks(); this._initSprites(); this._initStreaks(); this._initAuras(); this._initFlame();
    this.ghostOwners = [];               // { meshes:[{src, ghosts:[...]}], next, life:Float32Array, tint }
    this.stats = { sparks: 0, blood: 0, drops: 0, streaks: 0, ghosts: 0, auras: 0, stains: 0, ripples: 0, flame: 0 };
    this.maxSeen = { sparkBursts: 0, bloodBursts: 0, splashes: 0, streaks: 0, ghostsPerActor: 0, auras: 0, flame: 0 };
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
    const verts = n * (S - 1) * 6;              // 2 tris per segment
    this.stPos = new Float32Array(verts * 3); this.stAlpha = new Float32Array(verts);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.stPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aA', new THREE.BufferAttribute(this.stAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
    const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: 'attribute float aA; varying float vA; void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vA; void main(){ if (vA <= 0.0) discard; gl_FragColor = vec4(vec3(1.6,0.12,0.08) * vA, vA);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}' });
    this.streakMesh = new THREE.Mesh(g, m); this.streakMesh.frustumCulled = false; this.streakMesh.name = 'fx_streaks'; this.streakMesh.renderOrder = 11;
    this.group.add(this.streakMesh);
  }

  // Called per frame while an ACTIVE window is open for ownerId with the blade guard/tip world positions.
  streakSample(ownerId, guard, tip) {
    const S = FX_CAPS.streakSamples;
    let s = -1;
    for (let i = 0; i < FX_CAPS.streaks; i++) if (this.stActive[i] && this.stOwner[i] === ownerId) { s = i; break; }
    if (s < 0) {
      for (let i = 0; i < FX_CAPS.streaks; i++) if (!this.stActive[i] && this.stLife[i] <= 0) { s = i; break; }
      if (s < 0) return;                         // cap reached: drop (decorative, never gameplay)
      this.stActive[s] = 1; this.stOwner[s] = ownerId; this.stCount[s] = 0;
    }
    const H = this.stHist, base = s * S * 6;
    H.copyWithin(base + 6, base, base + (S - 1) * 6);
    H[base] = guard.x; H[base + 1] = guard.y; H[base + 2] = guard.z; H[base + 3] = tip.x; H[base + 4] = tip.y; H[base + 5] = tip.z;
    if (this.stCount[s] < S) this.stCount[s]++;
    this.stLife[s] = STREAK_LIFE;
  }

  streakEnd(ownerId) { for (let i = 0; i < FX_CAPS.streaks; i++) if (this.stActive[i] && this.stOwner[i] === ownerId) this.stActive[i] = 0; }

  _updateStreaks(dt) {
    const S = FX_CAPS.streakSamples, H = this.stHist, P = this.stPos, A = this.stAlpha;
    let v = 0, live = 0;
    for (let s = 0; s < FX_CAPS.streaks; s++) {
      if (!this.stActive[s]) this.stLife[s] -= dt;
      const on = this.stLife[s] > 0 && this.stCount[s] >= 2;
      if (on) live++;
      const fade = on ? Math.min(1, this.stLife[s] / STREAK_LIFE) : 0;
      for (let k = 0; k < S - 1; k++) {
        const a = s * S * 6 + k * 6, b = a + 6, valid = on && k + 1 < this.stCount[s];
        const al0 = valid ? fade * (1 - k / (S - 1)) : 0, al1 = valid ? fade * (1 - (k + 1) / (S - 1)) : 0;
        // quad (g0, t0, t1) (g0, t1, g1); offsets from a: g0 0, t0 3, g1 6, t1 9 (static tables, no allocation)
        for (let j = 0; j < 6; j++) {
          const src = a + QUAD_OFF[j]; P[v * 3] = H[src]; P[v * 3 + 1] = H[src + 1]; P[v * 3 + 2] = H[src + 2];
          A[v] = QUAD_NEXT[j] ? al1 : al0; v++;
        }
      }
    }
    this.stats.streaks = live;
    if (live > this.maxSeen.streaks) this.maxSeen.streaks = live;
    this.streakMesh.visible = live > 0;
    if (live > 0) { this.streakMesh.geometry.attributes.position.needsUpdate = true; this.streakMesh.geometry.attributes.aA.needsUpdate = true; }
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
      e.mat.color.setHex(red ? 0xff3a2a : 0x6fb4ff);
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
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 64);
      const m = new THREE.ShaderMaterial({ vertexShader: SPRITE_VS, fragmentShader: fs, transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, uniforms: { uScale: this.spriteMat.uniforms.uScale } });
      const p = new THREE.Points(g, m); p.frustumCulled = false; p.name = name; p.renderOrder = order; p.visible = false;
      this.group.add(p);
      return { p, pos, col, size, vel: new Float32Array(n * 3), life: new Float32Array(n), max: new Float32Array(n).fill(1), n, next: 0 };
    };
    this.flame = mk(FLAME_N, FLAME_FS, true, 'fx_flame', 12);
    this.smoke = mk(SMOKE_N, SPRITE_FS, false, 'fx_smoke', 6);
    this.flameAcc = 0; this.smokeAcc = 0; this.breathHeat = 0;
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
      F.size[i] = r.range(0.16, 0.28) * size; this.flameJet[i] = 1;
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
    }
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      const i = S.next; S.next = (S.next + 1) % S.n; const o = i * 3;
      const a = r.float() * Math.PI * 2, d = Math.sqrt(r.float()) * radius * 0.7;
      S.pos[o] = x + Math.cos(a) * d; S.pos[o + 1] = y + 0.4; S.pos[o + 2] = z + Math.sin(a) * d;
      S.vel[o] = r.range(-0.15, 0.15); S.vel[o + 1] = r.range(0.6, 1.1); S.vel[o + 2] = r.range(-0.15, 0.15);
      const life = SMOKE_LIFE * r.range(0.7, 1.0); S.life[i] = life; S.max[i] = life; S.size[i] = r.range(0.8, 1.4);
    }
  }

  _updateFlame(dt) {
    const F = this.flame, S = this.smoke;
    let nf = 0;
    const dJet = Math.exp(-1.1 * dt), dLick = Math.exp(-2.8 * dt);   // time-based drag (frame-rate independent)
    for (let i = 0; i < F.n; i++) {
      const o = i * 3, o4 = i * 4;
      if (F.life[i] <= 0) { F.col[o4 + 3] = 0; continue; }
      F.life[i] -= dt;
      const jet = this.flameJet[i], dr = jet ? dJet : dLick, ag = 1 - Math.max(0, F.life[i] / F.max[i]);
      F.vel[o] *= dr; F.vel[o + 2] *= dr; F.vel[o + 1] = F.vel[o + 1] * dr + (jet ? (ag > 0.45 ? 3.0 : 0.4) : 2.2) * dt;   // drag + late buoyancy
      F.pos[o] += F.vel[o] * dt; F.pos[o + 1] += F.vel[o + 1] * dt; F.pos[o + 2] += F.vel[o + 2] * dt;
      if (F.pos[o + 1] < 0.25) {                     // flame hits the ford: spreads flat, licks upward
        F.pos[o + 1] = 0.25; const sp = Math.hypot(F.vel[o], F.vel[o + 2]);
        F.vel[o + 1] = Math.max(F.vel[o + 1], 0.8); if (sp > 4) { F.vel[o] *= 1.15; F.vel[o + 2] *= 1.15; }
      }
      const t = Math.max(0, F.life[i] / F.max[i]), age = 1 - t;
      // white-yellow core -> orange -> deep red, HDR so the grade and bloom read it as a light source
      F.col[o4] = 1.5 - 0.6 * age; F.col[o4 + 1] = Math.max(0.05, 0.7 - 1.1 * age); F.col[o4 + 2] = Math.max(0.0, 0.16 - 0.5 * age);
      F.col[o4 + 3] = Math.min(1, t * 2.0) * Math.min(1, age * 6 + 0.35) * 0.55;
      F.size[i] = F.size[i] + dt * (jet ? 2.6 : 1.2);  // jet widens down the cone, licks billow gently
      if (F.life[i] <= 0) { F.col[o4 + 3] = 0; F.size[i] = 0; } else nf++;
    }
    let ns = 0;
    for (let i = 0; i < S.n; i++) {
      const o = i * 3, o4 = i * 4;
      if (S.life[i] <= 0) { S.col[o4 + 3] = 0; continue; }
      S.life[i] -= dt;
      S.pos[o] += S.vel[o] * dt; S.pos[o + 1] += S.vel[o + 1] * dt; S.pos[o + 2] += S.vel[o + 2] * dt;
      const t = Math.max(0, S.life[i] / S.max[i]);
      S.col[o4] = 0.09; S.col[o4 + 1] = 0.07; S.col[o4 + 2] = 0.065; S.col[o4 + 3] = Math.min(1, (1 - t) * 3) * t * 0.45;
      S.size[i] += dt * 0.9;
      if (S.life[i] > 0) ns++;
    }
    this.breathHeat = Math.max(0, this.breathHeat - dt * 4);
    this.stats.flame = nf; if (nf > this.maxSeen.flame) this.maxSeen.flame = nf;
    F.p.visible = nf > 0; S.p.visible = ns > 0;
    if (nf > 0) { const a = F.p.geometry.attributes; a.position.needsUpdate = true; a.aColor.needsUpdate = true; a.aSize.needsUpdate = true; }
    if (ns > 0) { const a = S.p.geometry.attributes; a.position.needsUpdate = true; a.aColor.needsUpdate = true; a.aSize.needsUpdate = true; }
  }

  // ---------- event routing ----------
  onContact(p) {
    if (p.outcome === Outcome.HIT || p.outcome === Outcome.GUARDBREAK) {
      if (p.surface === Surface.BLADE || p.surface === Surface.ARMOR) this.burstSparks(p.pos, p.normal, 0.6);
      else this.burstBlood(p.pos, p.normal, p.damage >= 25 ? 1.3 : 1);
      if (p.pos && p.pos.y < 1.2 && Math.abs(p.pos.z) < 6.7) this.splash(p.pos.x, p.pos.z, 0.6);
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
    this._updateSparks(dt); this._updateSprites(dt); this._updateStreaks(dt); this._updateAuras(dt); this._updateGhosts(dt);
    this._updateFlame(dt);
  }

  // Clear every live flame/smoke particle (retry / restart).
  clearFire() {
    for (const P of [this.flame, this.smoke]) { P.life.fill(0); P.col.fill(0); P.p.visible = false; }
    this.flameAcc = this.smokeAcc = 0; this.breathHeat = 0;
  }

  // Make every pooled object visible for one compileAsync pass (three compiles only traverseVisible), then restore.
  prewarmBegin() {
    this._pw = [];
    this.group.traverse((o) => { if (o !== this.group) { this._pw.push(o, o.visible); o.visible = true; } });
  }
  prewarmEnd() { for (let i = 0; i < this._pw.length; i += 2) this._pw[i].visible = this._pw[i + 1]; this._pw = null; }

  counts() { return { ...this.stats, maxSeen: { ...this.maxSeen } }; }
  resetMax() { for (const k in this.maxSeen) this.maxSeen[k] = 0; }

  dispose() {
    if (this.bus && this._l) {
      this.bus.off('combat/contact', this._l.contact); this.bus.off('combat/parry', this._l.parry);
      this.bus.off('world/footstep', this._l.step); this.bus.off('fx/request', this._l.req);
    }
    const geos = new Set(this._auraGeos), mats = new Set();
    for (const m of [this.sparkMesh, this.sprites, this.streakMesh, this.flame.p, this.smoke.p]) { geos.add(m.geometry); mats.add(m.material); }
    for (const a of this.auras) { mats.add(a.rm); mats.add(a.dm); }
    for (const o of this.ghostOwners) for (const set of o.ghosts) for (const e of set) { mats.add(e.mat); if (e.skel.boneTexture) e.skel.boneTexture.dispose(); }
    geos.forEach((g) => g.dispose()); mats.forEach((m) => m.dispose());
    this.scene.remove(this.group);
    this.ghostOwners = []; this.auras = [];
  }
}

function noop() {}
const _ex = new THREE.Vector3();
