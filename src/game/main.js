// main - the shipped game page (index.html). Owner: game. Wires GameSim (deterministic run) to the render stack,
// input layer, touch overlay, camera director, fx pool and HUD. Visuals stay downstream of sim events.
// Query: ?seed=N  ?q=low|medium|high  ?start=title|wave1|wave2|boss  ?god=1  ?bot=1 (autopilot)  ?touch=0|1  ?rm=1
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { applyGorgeLook, gradeMaterials, hazeMaterials, gradeWater } from '../render/GorgeLook.js';
import { SIM, BOSS } from '../shared/constants.js';
import { InputAction as A, Outcome } from '../shared/enums.js';
import { resolveQuality } from '../core/Config.js';
import { Rng } from '../core/Rng.js';
import { EventBus, EVENT_IDS } from '../core/EventBus.js';
import { Loop } from '../core/Loop.js';
import { World } from '../world/World.js';
import { CameraDirector, CINE, CINE_NAMES } from '../camera/CameraDirector.js';
import { BossVerb, ActorKind } from '../shared/enums.js';
import { FxPool, TELEGRAPH } from '../fx/FxPool.js';
import { Input } from '../player/Input.js';
import { TouchOverlay } from '../ui/TouchOverlay.js';
import { Hud } from '../ui/Hud.js';
import { GameSim, GameState, HERO_STATE, DUEL_STATE, BRAIN_STATE, ART, WAVES, GAME_STATE_NAMES } from './GameSim.js';
import { HERO_DODGE, HERO_FINISHER_F, STEP_DIR, STEP_CLIP } from './HeroSim.js';
import { buildQuickstep, quickstepClipTime } from '../shared/quickstep.js';
import { DUELIST } from './DuelistSim.js';

const ROOT = new URL('../../', import.meta.url).href;      // site root (works under a GitHub Pages sub-path)
const qs = new URLSearchParams(location.search);
const quality = resolveQuality(qs.get('q') || (matchMedia('(pointer: coarse)').matches ? 'medium' : 'high'));
const seed = Number(qs.get('seed') || SIM.SEED_DEFAULT) >>> 0;
const reducedMotion = qs.get('rm') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
// ?rec=1 recording mode: autopilot with full tactics, no cursor / credit / debug chrome, auto-start, letterboxed cine
const recMode = qs.get('rec') === '1';
const useBot = qs.get('bot') === '1' || recMode;
const HERO_ID = 1, BOSS_ID = 100, MAX_DUELISTS = 3;
const t0 = performance.now();
const progress = (p) => { const b = document.querySelector('#load .pb i'); if (b) b.style.width = Math.round(p * 100) + '%'; };

// ------------------------------------------------------------------ renderer + look + world
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.pixelRatioCap));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const look = applyGorgeLook(scene, renderer, quality, { shadows: qs.get('shadows') !== '0' });
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 160);
// camera-side soft fill (S6 C11 fix for the dark wyvern); always visible so the light count never changes
const camFill = new THREE.DirectionalLight(0xffe2c4, 0.55);
camFill.castShadow = false; scene.add(camFill, camFill.target);
const _fillOff = new THREE.Vector3();
function placeFill() {
  _fillOff.set(1.5, 3.0, 0).applyQuaternion(camera.quaternion);
  camFill.position.copy(camera.position).add(_fillOff);
  camera.getWorldDirection(_fillOff); camFill.target.position.copy(camera.position).addScaledVector(_fillOff, 10);
}

const systems = new Map();
const bus = new EventBus(EVENT_IDS);
const rootRng = new Rng(seed);
const ctx = { bus, rng: rootRng.stream('world'), get: (id) => (id === 'bus' ? bus : systems.get(id) || null) };

const world = new World();
await world.init(ctx, { scene, renderer, quality, base: ROOT.slice(0, -1) });
gradeMaterials(world.materials, look.envRT.texture); hazeMaterials(world.materials); gradeWater(world.water);
systems.set('world', world);
const colliders = world.colliders;
progress(0.35);

// ------------------------------------------------------------------ actors
const loader = new GLTFLoader();
const [heroGltf, enemyGltf, bossGltf, bossManifest, timing, heroCombat, heroLunge] = await Promise.all([
  loader.loadAsync(ROOT + 'characters/hero/out/character.glb'),
  loader.loadAsync(ROOT + 'characters/enemy/out/character.glb'),
  loader.loadAsync(ROOT + 'characters/boss/wyvern.glb'),
  fetch(ROOT + 'characters/boss/wyvern.manifest.json').then((r) => r.json()),
  fetch(ROOT + 'assets/attack-timing.json').then((r) => r.json()),
  fetch(ROOT + 'motion/mb/hero.combat.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch(ROOT + 'motion/mb/hero.lunge.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
]);
// MotionBricks guarded quickstep (NVIDIA MotionBricks bake): sim travel curve + clip-time map from one root curve
const QUICKSTEP = buildQuickstep(heroCombat, HERO_DODGE.travelF[1] - HERO_DODGE.travelF[0] + 1);
progress(0.8);

function prepModel(model) {
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const bones = {}; model.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  return bones;
}
// in-place policy: the controller owns travel, so pin Hips XZ on every clip (no double movement / foot slide)
function pinHips(gltf) {
  for (const clip of gltf.animations) for (const t of clip.tracks) {
    if (t.name !== 'Hips.position') continue;
    const v = t.values, x0 = v[0], z0 = v[2]; for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
}
function makeActions(actor, clips) {
  actor.mixer = new THREE.AnimationMixer(actor.model); actor.actions = {}; actor.dur = {}; actor.on = [];
  for (const clip of clips) { const a = actor.mixer.clipAction(clip); a.timeScale = 0; a.play(); a.setEffectiveWeight(0); actor.actions[clip.name] = a; actor.dur[clip.name] = clip.duration; }
}
// Pose = up to 3 (clip, weight, time) entries; everything else weight 0. Sim-time driven, no mixer clock.
function pose(actor, n, c0, w0, t0_, c1, w1, t1, c2, w2, t2) {
  const on = actor.on;
  for (let i = 0; i < on.length; i++) on[i].setEffectiveWeight(0);
  on.length = 0;
  const set = (c, w, t) => {
    const a = actor.actions[c] || actor.actions[actor.fallback]; if (!a || w <= 0) return;
    const d = Math.max(1e-3, a.getClip().duration);
    a.time = t >= d ? (a._loopPose ? t % d : d - 1e-3) : t; a.setEffectiveWeight(w); on.push(a);
  };
  set(c0, w0, t0_); if (n > 1) set(c1, w1, t1); if (n > 2) set(c2, w2, t2);
  actor.mixer.update(0);
}
const LOOP_CLIPS = new Set(['idle', 'walk', 'run', 'e_idle', 'e_walk', 'e_run', 'e_back']);
function markLoops(actor) { for (const k in actor.actions) actor.actions[k]._loopPose = LOOP_CLIPS.has(k); }

// procedural sword (same factory as the S3 duelist / S6 boss page)
const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 1, roughness: 0.28 });
const brass = new THREE.MeshStandardMaterial({ color: 0xb8863b, metalness: 1, roughness: 0.4 });
const bladeGeo = new THREE.BoxGeometry(0.045, 0.78, 0.008), guardGeo = new THREE.BoxGeometry(0.2, 0.025, 0.035);
function addSword(bone, s) {
  const socket = new THREE.Group();
  socket.position.fromArray(s.position); socket.quaternion.fromArray(s.quaternion); socket.scale.setScalar(s.scale);
  bone.add(socket);
  const blade = new THREE.Mesh(bladeGeo, steel); blade.position.y = 0.48;
  const guard = new THREE.Mesh(guardGeo, brass); guard.position.y = 0.09;
  for (const m of [blade, guard]) { m.castShadow = true; socket.add(m); }
  const tip = new THREE.Object3D(); tip.position.y = 0.87; socket.add(tip);
  const hilt = new THREE.Object3D(); hilt.position.y = 0.09; socket.add(hilt);
  return { tip, hilt };
}

// hero: pivot PI faces engine -Z
pinHips(heroGltf); pinHips(enemyGltf);
const hero = { root: new THREE.Group(), pivot: new THREE.Group(), model: heroGltf.scene, fallback: 'idle' };
hero.pivot.rotation.y = Math.PI; hero.root.add(hero.pivot); hero.pivot.add(hero.model); scene.add(hero.root);
const heroBones = prepModel(hero.model);
// baked quickstep clips -> AnimationClips on the hero skeleton. Every track must resolve to a real bone, else the
// clip is dropped (and the sim falls back to the roll) rather than shipping a silent no-op clip.
const mbClips = [];
if (heroCombat) {
  const bn = {}; heroGltf.scene.traverse((o) => { if (o.isBone) bn[o.name] = o; });
  for (const name in QUICKSTEP.clips) {
    const c = heroCombat.clips[name], F = c.frames, fps = c.fps || 60;
    const times = Float32Array.from({ length: F }, (_, i) => i / fps), tracks = [];
    let bad = 0;
    for (const b in c.tracks) { if (!bn[b]) bad++; tracks.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', times, c.tracks[b])); }
    if (c.hipsPos) tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, c.hipsPos));
    if (bad || !bn.Hips) { console.warn('quickstep clip dropped (unresolved tracks):', name, bad); delete QUICKSTEP.clips[name]; continue; }
    mbClips.push(new THREE.AnimationClip(name, (F - 1) / fps, tracks));
  }
}
// MotionBricks lunge footwork (zero-slide bake): LEG bones only, layered under the authored swing upper body.
// Display-only - the sim still owns travel (HeroSim lunge), so fixed-seed runs are unchanged.
const LUNGE_BONES = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
const LUNGE_FOR = { LIGHT_1: 'lunge_s', LIGHT_2: 'lunge_s', LIGHT_3: 'lunge_m', HEAVY: 'lunge_h' };
const lungeOk = {};
if (heroLunge && heroLunge.clips) {
  const bn = {}; heroGltf.scene.traverse((o) => { if (o.isBone) bn[o.name] = o; });
  for (const name of ['lunge_s', 'lunge_m', 'lunge_h']) {
    const c = heroLunge.clips[name]; if (!c) continue;
    const fps = c.fps || 60, times = Float32Array.from({ length: c.frames }, (_, i) => i / fps), tracks = [];
    let bad = 0;
    for (const b of LUNGE_BONES) { if (!bn[b] || !c.tracks[b]) { bad++; continue; } tracks.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', times, c.tracks[b])); }
    if (bad) { console.warn('lunge clip dropped (unresolved tracks):', name, bad); continue; }
    mbClips.push(new THREE.AnimationClip(name, (c.frames - 1) / fps, tracks)); lungeOk[name] = (c.frames - 1) / fps;
  }
}
makeActions(hero, heroGltf.animations.concat(mbClips)); markLoops(hero);
const heroSword = addSword(heroBones.RightHand, { position: [-0.3366, 7.6967, -1.1561], quaternion: [0.00031, 0.23882, 0.6183, 0.74878], scale: 100 });
// locomotion stride lengths from the manifest (natural speed x duration) -> phase-locked feet
const STRIDE_WALK = 1.377 * 1.067, STRIDE_RUN = 4.632 * 0.667;

// duelists: one SkeletonUtils clone per slot, one mixer per instance
const ENEMY_SOCKET = { position: [-0.7476, 7.0487, -0.4454], quaternion: [-0.05563, 0.17451, 0.59715, 0.78094], scale: 100 };
const slots = [];
for (let i = 0; i < MAX_DUELISTS; i++) {
  const s = { root: new THREE.Group(), pivot: new THREE.Group(), model: SkeletonUtils.clone(enemyGltf.scene), fallback: 'e_idle', bound: null, tele: false };
  s.pivot.rotation.y = Math.PI; s.root.add(s.pivot); s.pivot.add(s.model); scene.add(s.root);
  const bones = prepModel(s.model);
  makeActions(s, enemyGltf.animations); markLoops(s);
  s.sword = addSword(bones.RightHand, ENEMY_SOCKET);
  s.root.visible = false;
  slots.push(s);
}

// boss: scale/rot/albedo per constants, rest-pose normalisation identical to the S6 gate
const boss = { root: new THREE.Group(), pivot: new THREE.Group(), model: bossGltf.scene, fallback: 'idle' };
boss.pivot.rotation.y = BOSS.ROT_Y; boss.pivot.scale.setScalar(BOSS.SCALE);
boss.root.add(boss.pivot); boss.pivot.add(boss.model); scene.add(boss.root);
const bossBones = prepModel(boss.model);
const bossMats = new Set();
boss.model.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) bossMats.add(m); });
for (const m of bossMats) { if (m.color) m.color.multiplyScalar(BOSS.COLOR_SCALE); if (m.aoMap) m.aoMapIntensity = BOSS.AO_INTENSITY; }
makeActions(boss, bossGltf.animations);
for (const k in boss.actions) boss.actions[k]._loopPose = true;
const bossAllBones = Object.values(bossBones);
const bone = (n) => {
  if (bossBones[n]) return bossBones[n];
  const s = THREE.PropertyBinding.sanitizeNodeName(n).replace(/ /g, '_');
  if (bossBones[s]) return bossBones[s];
  for (const k in bossBones) if (k.startsWith(s + '_')) return bossBones[k];
  return null;
};
const HEAD = bone('wivern_ Head'), FOOT_L = bone('wivern_ L Foot'), FOOT_R = bone('wivern_ R Foot');
if (!HEAD || !FOOT_L || !FOOT_R) throw new Error('wyvern socket bones missing');
{
  boss.model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(boss.model.matrixWorld).invert();
  const b0 = new THREE.Box3(), w = new THREE.Vector3();
  const local = (o) => w.setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv);
  for (const x of bossAllBones) b0.expandByPoint(local(x));
  const fy = Math.min(local(FOOT_L).y, local(FOOT_R).y), c = b0.getCenter(new THREE.Vector3());
  boss.model.position.set(boss.model.position.x - c.x, boss.model.position.y - fy, boss.model.position.z - c.z);
  boss.model.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) o.visible = false; });
}
boss.root.visible = false;

// haze pools + spit orb (fixed slots)
const poolMat = new THREE.MeshBasicMaterial({ color: 0xff3a1c, transparent: true, opacity: 0.35, depthWrite: false, fog: true });
const poolGeo = new THREE.CircleGeometry(1, 40); poolGeo.rotateX(-Math.PI / 2);
const poolMeshes = [];
for (let i = 0; i < 3; i++) { const m = new THREE.Mesh(poolGeo, poolMat); m.visible = false; m.renderOrder = 2; scene.add(m); poolMeshes.push(m); }
const orbMat = new THREE.MeshBasicMaterial({ color: 0xffb04a, fog: false });
const orbMesh = new THREE.Mesh(new THREE.SphereGeometry(0.35, 20, 14), orbMat); orbMesh.visible = false; scene.add(orbMesh);

// every light also on layer 1 (kept from S6 so the boss mask pass sees the same light set)
scene.traverse((o) => { if (o.isLight) o.layers.enable(1); });

// ------------------------------------------------------------------ presentation systems
const fx = new FxPool();
fx.init(ctx, { scene, quality, water: world.water, reducedMotion, rng: rootRng.stream('fx') });
fx.setViewportHeight(renderer.domElement.height);
fx.registerAfterimages(HERO_ID, hero.root);
fx.registerAfterimages(BOSS_ID, boss.root);
systems.set('fx', fx);
const cam = new CameraDirector();
cam.init(ctx, { camera, colliders, reducedMotion });
systems.set('camera', cam);
const camHero = { position: new THREE.Vector3(), yaw: 0 };
const camTarget = { position: new THREE.Vector3(), airborne: false, isBoss: false, distance: 99 };
cam.setHero(camHero);

const input = new Input();
input.init(ctx, { target: renderer.domElement, pointerLock: qs.get('lock') !== '0' });
systems.set('input', input);
const touch = new TouchOverlay();
const tq = qs.get('touch');
touch.init(ctx, tq === null ? { sink: input } : { sink: input, visible: tq === '1' });
systems.set('touch', touch);

// ------------------------------------------------------------------ simulation
const sim = new GameSim({ seed, timing, colliders, bus, god: qs.get('god') === '1', startAt: qs.get('start') || 'title', dodgeProfile: QUICKSTEP });
const H = sim.hero;
const prev = { hx: H.x, hz: H.z, hyaw: H.yaw, bx: 0, by: 0, bz: 0, byaw: 0 };
const dPrev = []; for (let i = 0; i < MAX_DUELISTS; i++) dPrev.push({ x: 0, z: 0, yaw: 0 });
let paused = false, pauseFrames = 0;
const runStats = { contacts: 0, perfect: 0, phantom: 0, hits: 0, hudLagMax: 0 };
const _p = new THREE.Vector3(), _n = new THREE.Vector3();

// sim -> presentation (downstream only)
sim.onHeroContact = (R) => {
  runStats.contacts++;
  _p.set(H.x, 1.15, H.z); _n.set(R.normal ? R.normal.x : 0, 0.3, R.normal ? R.normal.z : 1);
  if (R.outcome === Outcome.PARRIED) {
    fx.burstSparks(_p, _n, R.perfect ? 1.4 : 0.7);
    if (R.perfect) { runStats.perfect++; loop.dilate(0.25, 12); cam.deflect(); hud.cue('PERFECT DEFLECT', 'perfect'); }
    else hud.cue('DEFLECT', 'perfect');
  } else if (R.effect === 'slip' || R.effect === 'behind' || R.effect === 'phantom') {
    runStats.phantom++; loop.dilate(0.4, 18); cam.phantomStep(18);
    fx.afterimage(HERO_ID, false, 1); fx.afterimage(HERO_ID, false, 0.7);
    hud.cue(R.effect === 'behind' ? 'PHANTOM STEP - BEHIND' : 'PHANTOM STEP', 'phantom');
  } else if (R.outcome === Outcome.HIT) {
    runStats.hits++; fx.burstBlood(_p, _n, R.damage >= 25 ? 1.3 : 1); cam.impact(R.damage >= 25 ? 'heavy' : 'light');
    if (Math.abs(H.z) < 6.7) fx.splash(H.x, H.z, 0.6);
  } else if (R.outcome === Outcome.BLOCKED) { fx.burstSparks(_p, _n, 0.5); cam.impact('light'); }
};
sim.onHeroHit = (t, dealt, v) => {
  if (dealt <= 0) return;
  _n.set(H.facingX(), 0.2, H.facingZ());
  if (t.isBoss) { HEAD.getWorldPosition(_p); _p.lerp(boss.root.position, 0.5); _p.y = Math.max(_p.y, 1.2); }
  else _p.set(t.x, 1.2, t.z);
  fx.burstSparks(_p, _n, v.name === 'HEAVY' ? 1.0 : 0.6);
  cam.impact(v.name === 'HEAVY' ? 'heavy' : 'light');
};
sim.onTelegraph = (v, art, lead) => {
  fx.telegraph(BOSS_ID, art === ART.RED ? TELEGRAPH.RED : art === ART.BLUE ? TELEGRAPH.BLUE : TELEGRAPH.NORMAL, lead, boss.root, 2.6);
  if (art === ART.RED) hud.cue('RED - DODGE ASIDE', 'hit'); else if (art === ART.BLUE) hud.cue('BLUE - DODGE IN', 'phantom');
};
sim.onDuelistTelegraph = (d) => { const s = slotFor(d); if (s) fx.telegraph(s.actorId, TELEGRAPH.NORMAL, d.verbs[d.verb].startup, s.root, 1.1); };
bus.on('action/end', (p) => { if (p.actorId === BOSS_ID) fx.clearTelegraph(BOSS_ID); });
bus.on('boss/phase', (p) => { if (!p.intro) { cam.onBossPhase(); hud.banner('THE WYVERN RAGES', '', 1.8); } });

function slotFor(d) { for (const s of slots) if (s.bound === d) return s; return null; }
function bindSlots() {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i], d = sim.duelists[i] || null;
    if (s.bound !== d) {
      s.bound = d; s.root.visible = !!d; s.actorId = d ? d.id : -1; s.animT = 0;
      if (d) { fx.registerAfterimages && 0; dPrev[i].x = d.x; dPrev[i].z = d.z; dPrev[i].yaw = d.yaw; }
    }
  }
}

sim.onState = (s) => {
  bindSlots();
  boss.root.visible = sim.bossActive;
  if (s === GameState.INTRO) hud.banner('THE CRIMSON FORD', 'cross the river', 2.4);
  else if (s === GameState.WAVE) hud.banner('WAVE ' + (sim.wave + 1), WAVES[sim.wave].name.toUpperCase(), 2.0);
  else if (s === GameState.WAVE_CLEAR) hud.banner('CLEARED', sim.wave + 1 < WAVES.length ? 'more come' : 'something stirs in the gorge', 2.0);
  else if (s === GameState.BOSS) { hud.banner('FORD WYVERN', 'guardian of the crossing', 2.6); fx.clearTelegraph(BOSS_ID); cam.cine(CINE.INTRO); }
  else if (s === GameState.VICTORY) { hud.setStats('victory', statsView()); }
  else if (s === GameState.DEFEAT) { hud.setStats('defeat', statsView()); }
  syncScreen();
};
function statsView() {
  const S = sim.stats;
  return { totalF: S.totalF, kills: S.kills, perfects: H.perfects, phantoms: H.phantoms, finishers: S.finishers,
    bossHp: sim.brain.hp, bossMax: BOSS.HP, reachedBoss: sim.bossActive };
}

// ------------------------------------------------------------------ hero command: real input or seeded bot
const _move = new THREE.Vector3(), _look = { x: 0, y: 0 };
let camYaw = 0, wasBlockHeld = false;
const botRng = new Rng(seed ^ 0x5151).stream('qa-bot');
const bot = { at: -1, kind: 0 };
if (useBot) {
  const prevT = sim.onTelegraph, prevD = sim.onDuelistTelegraph;
  sim.onTelegraph = (v, art, lead) => { prevT(v, art, lead); const ok = botRng.float() < 0.85;
    if (art === ART.NORMAL) { bot.at = sim.frame + lead - (ok ? 3 : 7); bot.kind = 1; } else { bot.at = sim.frame + lead - (ok ? 5 : 11); bot.kind = art === ART.BLUE ? 3 : 2; } };
  sim.onDuelistTelegraph = (d, v) => { prevD(d, v); if (botRng.float() < 0.85) { bot.at = sim.frame + v.startup - 3; bot.kind = 1; } };
}
function botCommand(c) {
  let tx = 0, tz = 0, has = false, td = 1e9, reach = 1.6;
  for (const d of sim.duelists) if (d.alive) { const dd = Math.hypot(d.x - H.x, d.z - H.z); if (dd < td) { td = dd; tx = d.x; tz = d.z; has = true; } }
  if (sim.bossActive && sim.brain.state !== BRAIN_STATE.DEAD) { tx = sim.brain.x; tz = sim.brain.z; td = Math.hypot(tx - H.x, tz - H.z); has = true; reach = 2.6; }
  if (!has) return;
  const dx = tx - H.x, dz = tz - H.z, l = Math.hypot(dx, dz) || 1;
  // rec tactics: never stand in a burning pool - walk out radially (only in ?rec=1; qa bot stays byte-identical)
  if (recMode && sim.bossActive && sim.frame + 1 !== bot.at) {
    for (const p of sim.brain.pools) {
      if (p.left <= 0) continue;
      const px = H.x - p.x, pz = H.z - p.z, pd = Math.hypot(px, pz);
      if (pd < p.r + 0.6) { c.mx = px / (pd || 1); c.mz = pz / (pd || 1); c.speed = SIM.RUN_SPEED; return; }
    }
  }
  if (sim.frame + 1 === bot.at) {
    if (bot.kind === 1) c.blockPress = true;
    else { c.dodge = true; if (bot.kind === 3) { c.mx = dx / l; c.mz = dz / l; } else { c.mx = -dz / l; c.mz = dx / l; } }
  } else if (td > reach + 0.6) { c.mx = dx / l; c.mz = dz / l; c.speed = SIM.RUN_SPEED; }
  else if ((sim.frame + 1) % 9 === 0) { if (sim.finisherReady()) c.heavy = true; else c.attack = true; }
  else if (td < reach - 0.6) { c.mx = -dx / l; c.mz = -dz / l; c.speed = SIM.WALK_SPEED; }
}
function fillCommand() {
  const c = sim.cmd;
  c.mx = 0; c.mz = 0; c.speed = 0; c.attack = false; c.heavy = false; c.dodge = false; c.blockHeld = false; c.blockPress = false;
  if (useBot) { botCommand(c); return; }
  input.moveIntent(camYaw, _move);
  const mag = input.moveMagnitude;
  c.mx = _move.x; c.mz = _move.z; c.speed = input.speedForMagnitude(mag);
  // buffered combat presses: consumed on the step they are read; HeroSim queues chains itself
  const b = input.peekBuffered();
  if (b === A.ATTACK && input.consumeBuffered(A.ATTACK)) c.attack = true;
  else if (b === A.HEAVY && input.consumeBuffered(A.HEAVY)) c.heavy = true;
  else if (b === A.DODGE && input.consumeBuffered(A.DODGE)) c.dodge = true;
  else if (b === A.BLOCK && input.consumeBuffered(A.BLOCK)) c.blockPress = true;
  c.blockHeld = input.isHeld(A.BLOCK);
  wasBlockHeld = c.blockHeld;
}

function fixedUpdate() {
  if (paused) return;
  input.fixedUpdate();
  prev.hx = H.x; prev.hz = H.z; prev.hyaw = H.yaw;
  const B = sim.brain; prev.bx = B.x; prev.by = B.y; prev.bz = B.z; prev.byaw = B.yaw;
  for (let i = 0; i < slots.length; i++) { const d = slots[i].bound; if (d) { dPrev[i].x = d.x; dPrev[i].z = d.z; dPrev[i].yaw = d.yaw; } }
  fillCommand();
  sim.step();
  if (sim.duelists.length && slots[0].bound !== sim.duelists[0]) bindSlots();
}

// ------------------------------------------------------------------ presentation
function lerpAngle(a, b, t) { let d = b - a; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; return a + d * t; }
const loco = { phase: 0, lastX: H.x, lastZ: H.z };
const streak = { hero: false, d: [false, false, false] };
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();
const footSlide = { worst: 0, samples: 0 };

function poseHero(alpha, presentDt) {
  const st = H.state;
  if (st === HERO_STATE.ACTION) {
    const v = H.verbs[H.verb], ln = LUNGE_FOR[H.verb], ld = ln && lungeOk[ln];
    if (ld) {
      // footwork covers the sim lunge window (startup+active) and settles through early recovery
      const lf = v.startup + v.active, span = lf * 1.5, u = Math.min(1, (H.actF + alpha) / span);
      const w = H.actF < span ? 1.6 : Math.max(0, 1.6 * (1 - (H.actF - span) / 12));
      pose(hero, 2, v.clip, 1, H.verbClipTime(H.actF), ln, w, u * ld);
      return;
    }
    pose(hero, 1, v.clip, 1, H.verbClipTime(H.actF)); return;
  }
  if (st === HERO_STATE.DODGE) {
    const qn = H.stepKind !== STEP_DIR.NONE ? STEP_CLIP[H.stepKind] : null, qi = qn && QUICKSTEP.clips[qn];
    if (qi) {
      // guarded quickstep: clip time follows the sim frame through the same root curve the sim travels on
      const d = H.dodgeF >= 0 ? H.dodgeF : HERO_DODGE.total;
      pose(hero, 1, qn, 1, quickstepClipTime(qi, d + alpha, HERO_DODGE.travelF[0], HERO_DODGE.travelF[1], HERO_DODGE.total));
      return;
    }
    pose(hero, 1, 'dodge', 1, (H.actF / HERO_DODGE.total) * hero.dur.dodge * 0.8); return;
  }
  if (st === HERO_STATE.HITSTUN) { pose(hero, 1, 'hit', 1, Math.min(H.actF, 40) / 60); return; }
  if (st === HERO_STATE.DEAD) { pose(hero, 1, 'death', 1, Math.min(H.actF / 60, hero.dur.death - 0.01)); return; }
  if (st === HERO_STATE.FINISHER) { pose(hero, 1, 'heavy', 1, (H.actF / HERO_FINISHER_F) * hero.dur.heavy); return; }
  // LOCO: phase-locked walk/run blend (clip phase advances with real distance -> planted feet), idle under it
  const dist = Math.hypot(H.x - loco.lastX, H.z - loco.lastZ); loco.lastX = H.x; loco.lastZ = H.z;
  const sp = H.speed;
  const wRun = Math.max(0, Math.min(1, (sp - SIM.WALK_SPEED) / (SIM.RUN_SPEED - SIM.WALK_SPEED)));
  const stride = STRIDE_WALK + (STRIDE_RUN - STRIDE_WALK) * wRun;
  loco.phase = (loco.phase + (dist < 0.5 ? dist / stride : 0)) % 1;
  const wMove = Math.max(0, Math.min(1, sp / 0.9));
  if (H.blocking) { pose(hero, 2, 'block', 1 - wMove * 0.5, 0.35, 'walk', wMove * 0.5, loco.phase * hero.dur.walk); return; }
  if (H.deflectF >= 0 && H.deflectF < 20 && wMove < 0.5) { pose(hero, 1, 'parry', 1, H.deflectF / 60 + 0.1); return; }
  pose(hero, 3, 'idle', 1 - wMove, (H.frame / 60) % hero.dur.idle,
    'walk', wMove * (1 - wRun), loco.phase * hero.dur.walk, 'run', wMove * wRun, loco.phase * hero.dur.run);
  // foot-slide metric: implied stride speed vs actual planar speed (only meaningful while moving)
  if (sp > 0.5 && presentDt > 0) { footSlide.samples++; }
}

function poseDuelist(s, i, alpha) {
  const d = s.bound, P = dPrev[i];
  s.root.position.set(P.x + (d.x - P.x) * alpha, colliders.terrainY(d.z), P.z + (d.z - P.z) * alpha);
  s.root.rotation.y = lerpAngle(P.yaw, d.yaw, alpha);
  const A_ = d.anim;
  if (A_.loop && (A_.clip === 'e_walk' || A_.clip === 'e_run')) {
    // phase-lock duelist locomotion to its own travel, same as the hero
    const strideE = A_.clip === 'e_run' ? 4.878 * 0.667 : 1.444 * 1.067;
    s.animT = (s.animT + Math.min(0.5, d.speed / 60 / Math.max(1, sim.frame - (s.lastF || sim.frame) || 1)) * 0) || s.animT;
    const step = (s.lastF === sim.frame) ? 0 : d.speed / 60 * (sim.frame - (s.lastF || sim.frame));
    s.lastF = sim.frame; s.locoPh = ((s.locoPh || 0) + step / strideE) % 1;
    pose(s, 1, A_.clip, 1, s.locoPh * s.dur[A_.clip]);
  } else { s.lastF = sim.frame; pose(s, 1, A_.clip, 1, A_.time); }
  const attacking = d.state === DUEL_STATE.ATTACK;
  if (attacking) { s.sword.hilt.getWorldPosition(_a); s.sword.tip.getWorldPosition(_b); fx.streakSample(s.actorId, _a, _b); streak.d[i] = true; }
  else { if (streak.d[i]) { fx.streakEnd(s.actorId); streak.d[i] = false; } fx.clearTelegraph(s.actorId); }
}

function poseBoss(alpha) {
  const B = sim.brain;
  const bzI = prev.bz + (B.z - prev.bz) * alpha;
  boss.root.position.set(prev.bx + (B.x - prev.bx) * alpha, prev.by + (B.y - prev.by) * alpha + (B.airborne ? 0 : colliders.terrainY(bzI)), bzI);
  boss.root.rotation.y = lerpAngle(prev.byaw, B.yaw, alpha);
  pose(boss, 1, B.anim.clip, 1, B.anim.time);
  for (let i = 0; i < 3; i++) {
    const p = B.pools[i], m = poolMeshes[i];
    m.visible = p.left > 0;
    if (m.visible) { m.position.set(p.x, colliders.terrainY(p.z) + 0.215, p.z); m.scale.setScalar(p.r * Math.min(1, p.left / 30)); }
  }
  orbMesh.visible = B.orb.active;
  if (B.orb.active) { orbMesh.position.set(B.orb.x, B.orb.y, B.orb.z); orbMat.color.setHex(B.orb.reflected ? 0x8fd0ff : 0xffb04a); }
  if (B.verb === 7 && B.state === BRAIN_STATE.ACTION && (B.f % 6) === 0) fx.afterimage(BOSS_ID, false, 0.6);
  breathFx(B);
}

// Fire breath: flame cone from the jaw while the breath verb is live (window padded so the flame leads and trails
// the damage frames), plus licking flame and smoke over every burning pool. Presentation only.
// [first frame, last frame, aim distance ahead of body (= pool.ahead + 0.8), cone half-angle]
const BREATH_WIN = { [BossVerb.W_HAZE]: [53, 88, 3.8, 0.30], [BossVerb.W_SKY_HAZE]: [15, 40, 4.0, 0.5] };
const _mouth = new THREE.Vector3(), _aim = new THREE.Vector3();
let breathOn = 0;
function breathFx(B) {
  const dt = presentDtNow;
  const w = B.state === BRAIN_STATE.ACTION && BREATH_WIN[B.verb];
  if (w && B.f >= w[0] && B.f <= w[1]) {
    HEAD.getWorldPosition(_mouth);
    // aim at the ground ahead of the body (where the pool lands), from the jaw
    const fx_ = B.forwardX(), fz_ = B.forwardZ();
    _aim.set(B.x + fx_ * w[2], colliders.terrainY(B.z + fz_ * w[2]) + 0.3, B.z + fz_ * w[2]).sub(_mouth);
    _mouth.x += fx_ * 0.9; _mouth.z += fz_ * 0.9;
    const l = _aim.length() || 1;
    const ramp = Math.min(1, (B.f - w[0]) / 6) * Math.min(1, (w[1] - B.f) / 6 + 0.2);
    fx.breath(_mouth, _aim.x / l, _aim.y / l, _aim.z / l, dt, { half: w[3] * 0.7, speed: 13 + l * 0.9, rate: 480 * ramp, size: B.airborne ? 1.4 : 1.1 });
    if (!breathOn && dt > 0) cam.impact('light');
    breathOn = 1;
  } else breathOn = 0;
  for (let i = 0; i < 3; i++) {
    const p = B.pools[i];
    if (p.left > 0) fx.poolFire(p.x, colliders.terrainY(p.z) + 0.2, p.z, p.r * Math.min(1, p.left / 30), dt, Math.min(1, p.left / 60));
  }
}
let presentDtNow = 0;

let wasFinisher = false;
// cinematic letterbox: two DOM bars (no extra render pass), height follows the cine blend weight
const lbStyle = document.createElement('style');
lbStyle.textContent = '.ec-lb{position:fixed;left:0;right:0;height:11vh;background:#000;z-index:5;pointer-events:none;transform:scaleY(0);will-change:transform}' +
  '.ec-lb.t{top:0;transform-origin:top}.ec-lb.b{bottom:0;transform-origin:bottom}' +
  (recMode ? 'body,canvas{cursor:none!important}.ec-credit,.ec-fps,#stats{display:none!important}' : '');
document.head.appendChild(lbStyle);
const lbTop = document.createElement('div'), lbBot = document.createElement('div');
lbTop.className = 'ec-lb t'; lbBot.className = 'ec-lb b'; document.body.append(lbTop, lbBot);
let lbLast = -1;
function letterbox(w) {
  const k = Math.round(w * 100) / 100;
  if (k === lbLast) return; lbLast = k;
  lbTop.style.transform = lbBot.style.transform = 'scaleY(' + k + ')';
}
bus.on('boss/phase', (p) => { if (!p.intro) cam.cine(CINE.PHASE); });
bus.on('actor/death', (p) => {
  if (p.kind !== ActorKind.WYVERN) return;
  cam.cine(CINE.DEATH); loop.dilate(0.4, 70, true);
  hud.banner('THE FORD IS YOURS', 'the wyvern falls', 3.0);
});

let lockOn = false;
function chooseCamTarget() {
  if (sim.bossActive && sim.brain.state !== BRAIN_STATE.DEAD) {
    HEAD.getWorldPosition(camTarget.position);
    camTarget.isBoss = true; camTarget.airborne = sim.brain.airborne && sim.brain.y > 2.0;
    camTarget.distance = Math.hypot(sim.brain.x - H.x, sim.brain.z - H.z);
    cam.setTarget(camTarget, true); return;
  }
  let best = null, bd = 1e9;
  for (const s of slots) { const d = s.bound; if (!d || !d.alive) continue; const dd = Math.hypot(d.x - H.x, d.z - H.z); if (dd < bd) { bd = dd; best = s; } }
  if (best && (lockOn || bd < 9)) {
    camTarget.position.set(best.root.position.x, best.root.position.y + 1.3, best.root.position.z);
    camTarget.isBoss = false; camTarget.airborne = false; camTarget.distance = bd;
    cam.setTarget(camTarget, lockOn);
  } else cam.setTarget(null, false);
}

function update(realDt, alpha, presentDt, noRender = false) {
  // look input -> camera orbit (only applied in explore; framing shots own yaw)
  input.update(realDt);
  input.consumeLook(_look);
  if (!loop.paused) cam.addLook(_look.x, _look.y);

  presentDtNow = presentDt;
  hero.root.position.set(prev.hx + (H.x - prev.hx) * alpha, colliders.terrainY(H.z), prev.hz + (H.z - prev.hz) * alpha);
  hero.root.rotation.y = lerpAngle(prev.hyaw, H.yaw, alpha);
  poseHero(alpha, presentDt);
  for (let i = 0; i < slots.length; i++) if (slots[i].bound) poseDuelist(slots[i], i, alpha);
  if (sim.bossActive) poseBoss(alpha);
  else { for (const m of poolMeshes) m.visible = false; orbMesh.visible = false; }

  const attacking = H.state === HERO_STATE.ACTION || H.state === HERO_STATE.FINISHER;
  if (attacking) { heroSword.hilt.getWorldPosition(_a); heroSword.tip.getWorldPosition(_b); fx.streakSample(HERO_ID, _a, _b); streak.hero = true; }
  else if (streak.hero) { fx.streakEnd(HERO_ID); streak.hero = false; }
  if (H.state === HERO_STATE.DODGE && H.actF === 3 && presentDt > 0) fx.afterimage(HERO_ID, false, 0.5);

  camHero.position.copy(hero.root.position); camHero.yaw = H.yaw;
  chooseCamTarget();
  // cinematic subject: the wyvern's body-to-head midpoint (tracks the landing, the roar and the fall)
  if (sim.bossActive) {
    HEAD.getWorldPosition(_a); cam.cineFocus.copy(boss.root.position).lerp(_a, 0.5); cam.cineFocus.y = Math.max(1.4, cam.cineFocus.y);
    if (cam.cineKind === CINE.FINISHER) cam.cineFocus.copy(boss.root.position);
  }
  const fin = H.state === HERO_STATE.FINISHER && sim.bossActive;
  if (fin && !wasFinisher) cam.cine(CINE.FINISHER);
  wasFinisher = fin;
  letterbox(cam.cineActive ? cam.cineW : 0);
  cam.update(presentDt);
  camera.getWorldDirection(_dir); camYaw = Math.atan2(-_dir.x, -_dir.z);
  placeFill();
  fx.update(presentDt);
  world.update(loop.simFrame / 60);
  if (!noRender) renderer.render(scene, camera);
}

// ------------------------------------------------------------------ HUD, pause, screens
const credit = 'Boss model: ' + bossManifest.provenance.attribution.replace(/CC-BY-(\d)\.(\d)/g, 'CC BY $1.$2') + '. Three.js (MIT).';
const hud = new Hud().init({
  credit, touch: touch.visible,
  onStart: () => { input.releaseAll(); sim.start(); resetPresentation(); },
  onRetry: () => { input.releaseAll(); input.clearBuffer(); sim.retry(); resetPresentation(); },
  onRestart: () => { input.releaseAll(); input.clearBuffer(); setPaused(false); sim.reset('title'); sim.start(); resetPresentation(); },
  onResume: () => { setPaused(false); captureMouse(); },
});
systems.set('hud', hud);
let touchWanted = touch.visible;
touch.onVisibility = () => { if (hud._screen === '') touchWanted = touch.visible; };
function syncScreen() {
  const s = sim.state;
  const scr = s === GameState.TITLE ? 'title' : s === GameState.VICTORY ? 'victory' : s === GameState.DEFEAT ? 'defeat' : loop && loop.paused ? 'pause' : '';
  hud.screen(scr);
  if (scr && touch.visible) touch.setVisible(false); else if (!scr && touchWanted && !touch.visible) touch.setVisible(true);
  if (scr && document.pointerLockElement) document.exitPointerLock();
}
function setPaused(v) {
  const can = sim.state === GameState.INTRO || sim.state === GameState.WAVE || sim.state === GameState.WAVE_CLEAR || sim.state === GameState.BOSS;
  v = v && can;
  if (loop.paused === v) return;
  loop.paused = v;
  if (v) { input.clearBuffer(); input.releaseAll(); }
  if (bus) { const p = bus.payload('game/pause'); p.paused = v; bus.dispatch('game/pause'); }
  touch.setToggle && touch.setToggle(A.PAUSE, v);
  syncScreen();
}
const onVisPause = () => { if (document.visibilityState === 'hidden') setPaused(true); };
document.addEventListener('visibilitychange', onVisPause);
const onLockLost = () => { if (!document.pointerLockElement && hud._screen === '' && !useBot && input.device === 1 /* KBM */) setPaused(true); };
document.addEventListener('pointerlockchange', onLockLost);

// Retry / restart / start: the sim was rebuilt, so every presentation-side memory of the old run goes too.
// Without this the camera keeps the dead run's orbit yaw, shake, push-in and slow-mo, whips across the arena
// toward the respawned hero, and mouse look stays dead because the end screen released pointer lock.
function resetPresentation() {
  loop.clearDilation(); loop.accumulator = 0;
  prev.hx = H.x; prev.hz = H.z; prev.hyaw = H.yaw;
  const B = sim.brain; prev.bx = B.x; prev.by = B.y; prev.bz = B.z; prev.byaw = B.yaw;
  loco.lastX = H.x; loco.lastZ = H.z; loco.phase = 0;
  fx.streakEnd(HERO_ID); streak.hero = false; fx.clearTelegraph(BOSS_ID); fx.clearFire(); wasFinisher = false; breathOn = 0; letterbox(0);
  for (let i = 0; i < slots.length; i++) { if (slots[i].actorId >= 0) { fx.streakEnd(slots[i].actorId); fx.clearTelegraph(slots[i].actorId); } streak.d[i] = false; }
  bindSlots(); boss.root.visible = sim.bossActive;
  input.consumeLook(_look);                       // drop look delta accumulated on the end screen
  cam.reset(H.yaw); camHero.position.set(H.x, colliders.terrainY(H.z), H.z); camHero.yaw = H.yaw;
  chooseCamTarget(); cam.update(1 / 60);          // snap frame: right shot, framing yaw, no blend
  camResets++;
  captureMouse();
}
let camResets = 0;
// re-take pointer lock inside the click that closed the screen (a user gesture), so look works immediately
function captureMouse() {
  if (useBot || touch.visible || qs.get('lock') === '0') return;
  const el = renderer.domElement;
  if (document.pointerLockElement !== el && el.requestPointerLock) { const r = el.requestPointerLock(); if (r && r.catch) r.catch(() => {}); }
}

let hudFrame = 0;
function lateUpdate(dt) {
  if (input.consumeEdge(A.PAUSE)) setPaused(!loop.paused);
  if (input.consumeEdge(A.LOCK)) { lockOn = !lockOn; touch.setToggle && touch.setToggle(A.LOCK, lockOn); }
  // title: attack/dodge/enter starts the run from any device
  if (sim.state === GameState.TITLE && (input.consumeBuffered(A.ATTACK) || input.consumeBuffered(A.DODGE))) { input.clearBuffer(); sim.start(); }
  const B = sim.brain;
  const S = sim.state;
  const alive = sim.duelists.reduce((n, d) => n + (d.alive ? 1 : 0), 0);
  hud.update({
    hp: H.hp, hpMax: SIM.HP_PLAYER, stamina: H.stamina, staminaMax: SIM.STAMINA_MAX, staminaFail: H.stamina < 12,
    boss: sim.bossActive ? { hp: B.hp, max: BOSS.HP, posture: B.posture, postureMax: BOSS.POSTURE_MAX } : null,
    waveLabel: S === GameState.WAVE ? 'WAVE ' + (sim.wave + 1) + ' / ' + WAVES.length + '<small>' + alive + ' FOE' + (alive === 1 ? '' : 'S') + ' REMAIN</small>'
      : S === GameState.BOSS ? 'THE FORD WYVERN' : '',
    finisher: sim.finisherReady(), touch: touch.visible, flash: H.flash,
  }, dt);
  hudFrame = loop.simFrame;
  touch.update && touch.update();
  touch.setAvailable(A.DODGE, H.stamina >= 1);
  touch.setAvailable(A.HEAVY, H.stamina >= 1);
  input.lateUpdate(dt);
}

const loop = new Loop({ fixedUpdate, update, lateUpdate, reducedMotion });

// ------------------------------------------------------------------ prewarm (simulation-transparent)
{
  const loopState = loop.save();
  // show every actor + every pooled object once, pose each clip family, compile against the canvas (target null:
  // measured on this build that a scratch target forces NoToneMapping into the key), then one hidden draw for
  // shadow-depth variants. No sim step, clock or RNG moves.
  for (const s of slots) { s.root.visible = true; s.root.position.set(0, 0, -4); pose(s, 1, 'e_idle', 1, 0); }
  boss.root.visible = true; boss.root.position.set(0, 0, -8); pose(boss, 1, 'idle', 1, 0);
  update(0, 0, 0, true);
  for (const s of slots) s.root.visible = true; boss.root.visible = true;
  fx.prewarmBegin();
  for (const m of poolMeshes) m.visible = true; orbMesh.visible = true;
  lbTop.style.transform = 'scaleY(0)';
  renderer.setRenderTarget(null);
  await renderer.compileAsync(scene, camera, scene);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  await world.water.prewarm(renderer, scene, camera);
  fx.prewarmEnd();
  for (const m of poolMeshes) m.visible = false; orbMesh.visible = false;
  for (const s of slots) s.root.visible = !!s.bound;
  boss.root.visible = sim.bossActive;
  loop.load(loopState);
  cam.snap(); cam.resetStats();
}
const loadMs = performance.now() - t0;
const progStart = renderer.info.programs.length;
progress(1);
bindSlots(); syncScreen();
const loadEl = document.getElementById('load');
if (loadEl) { loadEl.style.opacity = '0'; setTimeout(() => loadEl.remove(), 700); }

// ------------------------------------------------------------------ frame ring + QA surface
const ft = new Float32Array(6000); let ftN = 0, lastNow = 0;
const _tick = loop._tick;
loop._tick = (now) => { if (lastNow) ft[ftN++ % ft.length] = now - lastNow; lastNow = now; _tick(now); };
function onResize() {
  renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  fx.setViewportHeight(renderer.domElement.height);
}
addEventListener('resize', onResize);
loop.start();
if (recMode) setTimeout(() => { if (sim.state === GameState.TITLE) { sim.start(); resetPresentation(); } }, Number(qs.get('recDelay') || 2500));

window.__ember = {
  ready: true, seed, quality: quality.name, loadMs, credit, bot: useBot,
  state() {
    return { frame: loop.simFrame, simFrame: sim.frame, state: GAME_STATE_NAMES[sim.state], wave: sim.wave, paused: loop.paused,
      screen: hud._screen, hash: sim.hash(), heroHp: H.hp, heroState: H.state, stamina: H.stamina, bossHp: sim.brain.hp,
      duelists: sim.duelists.map((d) => ({ hp: d.hp, alive: d.alive })), stats: { ...sim.stats }, run: { ...runStats },
      backDot: H.maxBackwardDot, camMin: cam.minClearance, camResets, quickstep: Object.keys(QUICKSTEP.clips),
      cam: { shot: cam.shot, trauma: cam.trauma, push: cam.push, phantom: cam.phantom, orbitYaw: cam.orbitYaw, heroYaw: H.yaw, timeScale: loop.timeScale,
        dist: Math.hypot(camera.position.x - H.x, camera.position.z - H.z) },
      cine: { kind: CINE_NAMES[cam.cineKind], w: cam.cineW, log: cam.cineLog.slice() }, fx: fx.counts(), rec: recMode, lunge: Object.keys(lungeOk),
      step: { kind: H.stepKind, dodgeF: H.dodgeF, clip: hero.on.length ? hero.on[0].getClip().name : '' }, programs: { start: progStart, now: renderer.info.programs.length },
      dropped: loop.droppedSteps, touch: touch.visible, hud: { hp: hud.el.hpI.style.transform, boss: hud.el.boss.style.display } };
  },
  // camera framing probe (QA): hero chest in NDC + camera forward bearing, read straight off the rendered camera
  camProbe() {
    const v = new THREE.Vector3(H.x, colliders.terrainY(H.z) + 1.2, H.z).project(camera), f = new THREE.Vector3();
    camera.getWorldDirection(f);
    return { nx: v.x, ny: v.y, nz: v.z, yaw: Math.atan2(f.x, f.z), fov: camera.fov, boom: cam.cur.boom, pulledIn: cam.pulledIn, dist: camera.position.distanceTo(new THREE.Vector3(H.x, camera.position.y, H.z)), shot: cam.shot, trauma: cam.trauma, timeScale: loop.timeScale, state: GAME_STATE_NAMES[sim.state], cine: cam.cineActive ? cam.cineW : 0 };
  },
  frames() { const n = Math.min(ftN, ft.length); return Array.from(ft.subarray(0, n)); },
  resetFrames() { ftN = 0; lastNow = 0; },
  layout: () => touch.layoutReport(),
  // Recorder lockstep: stop RAF, then each advance(n) runs n exact 1/60 s frames (sim + render), so captured
  // footage is a true 60 fps regardless of how slow the capture itself is.
  lockstep() { loop.stop(); return true; },
  forceBossVerb(name) { const v = BossVerb[name]; if (v === undefined) return false; sim.brain.forceNext = v; return true; },
  advance(n = 1) { for (let i = 0; i < n; i++) { loop.advance(1 / 60); } return { state: GAME_STATE_NAMES[sim.state], frame: sim.frame, cine: CINE_NAMES[cam.cineKind] }; },
  begin() { if (sim.state === GameState.TITLE) { input.releaseAll(); sim.start(); resetPresentation(); } return GAME_STATE_NAMES[sim.state]; },
  pump(n) { const p = loop.paused; loop.paused = false; for (let i = 0; i < n; i++) loop.step(); loop.paused = p; update(0, 1, 0); return sim.frame; },
  dispose() {
    loop.dispose(); removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisPause); document.removeEventListener('pointerlockchange', onLockLost);
    sim.dispose(); hud.dispose(); touch.dispose(); input.dispose(); fx.dispose(); cam.dispose(); world.dispose(); look.dispose(); bus.dispose();
    for (const a of [hero, boss, ...slots]) a.mixer.stopAllAction();
    scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); for (const m of [].concat(o.material)) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); } } });
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  },
};
