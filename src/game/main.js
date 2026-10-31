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
import { FxPool, TELEGRAPH, MIST } from '../fx/FxPool.js';
import { Input } from '../player/Input.js';
import { TouchOverlay } from '../ui/TouchOverlay.js';
import { Hud } from '../ui/Hud.js';
import { Fullscreen } from '../ui/Fullscreen.js';
import { GameSim, GameState, HERO_STATE, DUEL_STATE, BRAIN_STATE, ART, WAVES, GAME_STATE_NAMES } from './GameSim.js';
import { HERO_DODGE, HERO_FINISHER_F, HERO_FINISHER_CLIP, STEP_DIR, STEP_CLIP, HERO_CHARGE } from './HeroSim.js';
import { buildQuickstep, quickstepClipTime } from '../shared/quickstep.js';
import { DUELIST } from './DuelistSim.js';
import { Inertializer, PoseJerk } from './Inertia.js';
import { smoothClips } from './ClipSmooth.js';
import { buildWarp } from './TimeWarp.js';

const ROOT = new URL('../../', import.meta.url).href;      // site root (works under a GitHub Pages sub-path)
const qs = new URLSearchParams(location.search);
const quality = resolveQuality(qs.get('q') || (matchMedia('(pointer: coarse)').matches ? 'medium' : 'high'));
const seed = Number(qs.get('seed') || SIM.SEED_DEFAULT) >>> 0;
const reducedMotion = qs.get('rm') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
// ?rec=1 recording mode: autopilot with full tactics, no cursor / credit / debug chrome, auto-start, letterboxed cine
const recMode = qs.get('rec') === '1';
const useBot = qs.get('bot') === '1' || recMode;
const OCC_ON = qs.get('occ') !== '0';   // C13 A/B switch (review only)
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
await world.init(ctx, { scene, renderer, quality, base: ROOT.slice(0, -1), blenderKit: qs.get('bk') !== '0', bkRocks: qs.get('bkrocks') === '1' });
gradeMaterials(world.materials, look.envRT.texture); hazeMaterials(world.materials); gradeWater(world.water);
systems.set('world', world);
const colliders = world.colliders;
progress(0.35);

// ------------------------------------------------------------------ actors
const loader = new GLTFLoader();
const [heroGltf, enemyGltf, bossGltf, bossManifest, timing, heroCombat, heroLunge] = await Promise.all([
  loader.loadAsync(ROOT + 'characters/hero/out/character_mh.glb'),
  loader.loadAsync(ROOT + 'characters/enemy/out/character.glb'),
  loader.loadAsync(ROOT + 'characters/boss/wyvern.glb'),
  fetch(ROOT + 'characters/boss/wyvern.manifest.json').then((r) => r.json()),
  fetch(ROOT + 'assets/attack-timing.json').then((r) => r.json()),
  fetch(ROOT + 'motion/mb/hero.combat.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch(ROOT + 'motion/mb/hero.lunge.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
]);
// C16: authored clips are 30 Hz LINEAR keys -> resample to 60 Hz monotone cubic (keys/extremes/holds kept exactly,
// velocity continuous through every key). ?smooth=0 keeps the raw tracks for A/B.
const SMOOTH_ON = qs.get('smooth') !== '0';
const clipSmooth = SMOOTH_ON ? [
  smoothClips(heroGltf.animations, { loops: new Set(['idle', 'walk', 'run']) }),
  smoothClips(enemyGltf.animations, { loops: new Set(['e_idle', 'e_walk', 'e_run', 'e_back']) }),
  smoothClips(bossGltf.animations, { loops: new Set(['idle', 'idle_low', 'walk', 'walk_up', 'fly', 'hover', 'glide', 'swoop_loop', 'fall_loop']) }),
] : [];
// C16: continuous attack clip-time warp per verb (same knots as attack-timing.json, rate continuous). ?warp=0 = old
const WARP_ON = qs.get('warp') !== '0';
const WARP = {}; for (const k in timing.verbs) WARP[k] = buildWarp(timing.verbs[k].phases);
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
  if (actor.inert) actor.inert.restore();
  const on = actor.on;
  for (let i = 0; i < on.length; i++) on[i].setEffectiveWeight(0);
  on.length = 0;
  const set = (c, w, t) => {
    const a = actor.actions[c] || actor.actions[actor.fallback]; if (!a || w <= 0) return;
    const d = Math.max(1e-3, a.getClip().duration);
    a.time = t >= d ? (a._loopPose ? t % d : d - 1e-3) : t; a.setEffectiveWeight(w); on.push(a);
  };
  actor.pc = c0; actor.pt = t0_;
  set(c0, w0, t0_); if (n > 1) set(c1, w1, t1); if (n > 2) set(c2, w2, t2);
  actor.mixer.update(0);
}
const LOOP_CLIPS = new Set(['idle', 'walk', 'run', 'e_idle', 'e_walk', 'e_run', 'e_back']);
function markLoops(actor) { for (const k in actor.actions) actor.actions[k]._loopPose = LOOP_CLIPS.has(k); }

// procedural sword (same factory as the S3 duelist / S6 boss page)
const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, metalness: 1, roughness: 0.28 });
const brass = new THREE.MeshStandardMaterial({ color: 0xb8863b, metalness: 1, roughness: 0.4 });
const bladeGeo = new THREE.BoxGeometry(0.045, 0.78, 0.008), guardGeo = new THREE.BoxGeometry(0.2, 0.025, 0.035);
// hero blade gets its own steel clone (same program key) so the charge glow never lights the duelists' swords
const heroSteel = steel.clone(); heroSteel.emissive = new THREE.Color(0, 0, 0);
function addSword(bone, s, bladeMat = steel) {
  const socket = new THREE.Group();
  socket.position.fromArray(s.position); socket.quaternion.fromArray(s.quaternion); socket.scale.setScalar(s.scale);
  bone.add(socket);
  const blade = new THREE.Mesh(bladeGeo, bladeMat); blade.position.y = 0.48;
  const guard = new THREE.Mesh(guardGeo, brass); guard.position.y = 0.09;
  for (const m of [blade, guard]) { m.castShadow = true; socket.add(m); }
  const tip = new THREE.Object3D(); tip.position.y = 0.87; socket.add(tip);
  const hilt = new THREE.Object3D(); hilt.position.y = 0.09; socket.add(hilt);
  return { tip, hilt, socket };
}
// v2.10 great sword: 1.36 m blade (+0.62 m over the standard blade, matching GREATSWORD.REACH in the sim), wide
// guard, long two-hand grip under the hand, ember inlay down the fuller. Socket units are metres, blade along +Y.
const gsBladeGeo = new THREE.BoxGeometry(0.25, 1.36, 0.035), gsInlayGeo = new THREE.BoxGeometry(0.05, 1.18, 0.04);
const gsGuardGeo = new THREE.BoxGeometry(0.52, 0.06, 0.07), gsGripGeo = new THREE.CylinderGeometry(0.022, 0.025, 0.34, 8);
const gsPommelGeo = new THREE.SphereGeometry(0.042, 8, 6), gsTipGeo = new THREE.ConeGeometry(0.177, 0.24, 4);
const leather = new THREE.MeshStandardMaterial({ color: 0x3a2418, metalness: 0, roughness: 0.85 });
const emberInlay = new THREE.MeshStandardMaterial({ color: 0x2a0d06, emissive: 0xff5a1a, emissiveIntensity: 1.2, metalness: 0.2, roughness: 0.6 });
function addGreatSword(parent, s, bladeMat = steel) {
  const socket = new THREE.Group();
  socket.position.fromArray(s.position); socket.quaternion.fromArray(s.quaternion); socket.scale.setScalar(s.scale);
  parent.add(socket);
  const blade = new THREE.Mesh(gsBladeGeo, bladeMat); blade.position.y = 0.8;
  const inlay = new THREE.Mesh(gsInlayGeo, emberInlay); inlay.position.y = 0.76;
  const point = new THREE.Mesh(gsTipGeo, bladeMat); point.position.y = 1.6; point.rotation.y = Math.PI / 4; point.scale.z = 0.24;
  const guard = new THREE.Mesh(gsGuardGeo, brass); guard.position.y = 0.1;
  const grip = new THREE.Mesh(gsGripGeo, leather); grip.position.y = -0.08;
  const pommel = new THREE.Mesh(gsPommelGeo, brass); pommel.position.y = -0.27;
  for (const m of [blade, inlay, point, guard, grip, pommel]) { m.castShadow = true; socket.add(m); }
  const tip = new THREE.Object3D(); tip.position.y = 1.6; socket.add(tip);
  const hilt = new THREE.Object3D(); hilt.position.y = 0.12; socket.add(hilt);
  return { tip, hilt, socket };
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
// C16: the lunge bake has 0.2-0.28 rad/frame^2 velocity kinks in the knees around the plant; a sigma=1.6 frame
// Gaussian (hemisphere-aligned, endpoints clamped) removes them. Legs are display-only here, so no sim change. ?lsmooth=0 = raw
const LUNGE_SMOOTH = qs.get('lsmooth') !== '0';
function gaussQuat(src, F, sigma) {
  const R = Math.ceil(sigma * 3), w = []; for (let o = -R; o <= R; o++) w.push(Math.exp(-(o * o) / (2 * sigma * sigma)));
  const q = Float32Array.from(src);
  for (let i = 1; i < F; i++) { const j = i * 4, p = j - 4; if (q[j] * q[p] + q[j + 1] * q[p + 1] + q[j + 2] * q[p + 2] + q[j + 3] * q[p + 3] < 0) for (let c = 0; c < 4; c++) q[j + c] = -q[j + c]; }
  const out = new Float32Array(q.length);
  for (let i = 0; i < F; i++) {
    let x = 0, y = 0, z = 0, ww = 0;
    for (let o = -R; o <= R; o++) { const s = Math.min(F - 1, Math.max(0, i + o)) * 4, g = w[o + R]; x += q[s] * g; y += q[s + 1] * g; z += q[s + 2] * g; ww += q[s + 3] * g; }
    const L = Math.hypot(x, y, z, ww) || 1, j = i * 4; out[j] = x / L; out[j + 1] = y / L; out[j + 2] = z / L; out[j + 3] = ww / L;
  }
  return out;
}
if (heroLunge && heroLunge.clips) {
  const bn = {}; heroGltf.scene.traverse((o) => { if (o.isBone) bn[o.name] = o; });
  for (const name of ['lunge_s', 'lunge_m', 'lunge_h']) {
    const c = heroLunge.clips[name]; if (!c) continue;
    const fps = c.fps || 60, times = Float32Array.from({ length: c.frames }, (_, i) => i / fps), tracks = [];
    let bad = 0;
    for (const b of LUNGE_BONES) { if (!bn[b] || !c.tracks[b]) { bad++; continue; } tracks.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', times, LUNGE_SMOOTH ? gaussQuat(c.tracks[b], c.frames, 1.6) : c.tracks[b])); }
    if (bad) { console.warn('lunge clip dropped (unresolved tracks):', name, bad); continue; }
    mbClips.push(new THREE.AnimationClip(name, (c.frames - 1) / fps, tracks)); lungeOk[name] = (c.frames - 1) / fps;
  }
}
makeActions(hero, heroGltf.animations.concat(mbClips)); markLoops(hero);
// C15 inertialization: every clip switch decays the old pose into the new one (presentation only, ?inert=0 disables)
const INERT_ON = qs.get('inert') !== '0';
const INERT_MODE = qs.get('inert') === 'decay' ? 'decay' : 'spring';
const INERT_HL = +(qs.get('ihl') || 0.6);
hero.inert = new Inertializer(hero.model, heroGltf.animations.concat(mbClips)); hero.inert.enabled = INERT_ON; hero.inert.mode = INERT_MODE; hero.inert.hlScale = INERT_HL;
const HERO_SOCKET = { position: [-0.3366, 7.6967, -1.1561], quaternion: [0.00031, 0.23882, 0.6183, 0.74878], scale: 100 };
const heroSwordStd = addSword(heroBones.RightHand, HERO_SOCKET, heroSteel);
const heroGreat = addGreatSword(heroBones.RightHand, HERO_SOCKET, heroSteel); heroGreat.socket.visible = false;
let heroSword = heroSwordStd;
function setHeroWeapon(w) { heroSword = w === 1 ? heroGreat : heroSwordStd; heroSwordStd.socket.visible = w !== 1; heroGreat.socket.visible = w === 1; }
// planted pickup: the same great sword, blade down in the ford beside the wyvern's landing, with a pulsing ember
// column so it reads from the hero spawn. No light (constant light count); additive basic material only.
const pickupRoot = new THREE.Group(); pickupRoot.visible = false; scene.add(pickupRoot);
const pickupSword = addGreatSword(pickupRoot, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, steel);
pickupSword.socket.rotation.set(Math.PI + 0.14, 0.6, 0.08);
const pickupBeamMat = new THREE.MeshBasicMaterial({ color: 0xff7a30, transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
const pickupBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.7, 7, 20, 1, true), pickupBeamMat); pickupBeam.position.y = 2.2; pickupRoot.add(pickupBeam);
const pickupGlow = { t: 0, ping: -1 };
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
  s.inert = new Inertializer(s.model, enemyGltf.animations); s.inert.enabled = INERT_ON; s.inert.mode = INERT_MODE; s.inert.hlScale = INERT_HL;
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
boss.inert = new Inertializer(boss.model, bossGltf.animations); boss.inert.enabled = INERT_ON; boss.inert.mode = INERT_MODE; boss.inert.hlScale = INERT_HL;
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
    if (R.perfect) { runStats.perfect++; loop.dilate(0.25, 12); cam.deflect(); hud.cue('PERFECT DEFLECT', 'perfect'); fx.shockwave(H.x, colliders.terrainY(H.z) + 0.22, H.z, 2.6, 0x9fd8ff, 0.9, 0.4); }
    else hud.cue('DEFLECT', 'perfect');
  } else if (R.effect === 'slip' || R.effect === 'behind' || R.effect === 'phantom') {
    runStats.phantom++; loop.dilate(0.4, 18); cam.phantomStep(18);
    fx.afterimage(HERO_ID, INK_ON ? INK.GHOST : false, 1); fx.afterimage(HERO_ID, INK_ON ? INK.GHOST : false, 0.7);
    if (INK_ON) fx.mist(H.x, colliders.terrainY(H.z) + 1.0, H.z, 0.6, MIST.JADE, 12, 0.5);
    hud.cue(R.effect === 'behind' ? 'PHANTOM STEP - BEHIND' : 'PHANTOM STEP', 'phantom');
  } else if (R.outcome === Outcome.HIT) {
    runStats.hits++; fx.burstBlood(_p, _n, R.damage >= 25 ? 1.5 : 1); cam.impact(R.damage >= 30 ? 'slam' : R.damage >= 22 ? 'heavy' : 'light');
    if (R.damage >= 22) loop.dilate(0.3, 2);       // hit-stop on big incoming hits (time only; sim outcomes unchanged)
    heroReact.amp = Math.min(1.5, 0.6 + R.damage / 30); heroReact.t = 0;
    heroReact.dx = R.normal ? -R.normal.x : -H.facingX(); heroReact.dz = R.normal ? -R.normal.z : -H.facingZ();
    if (Math.abs(H.z) < 6.7) fx.splash(H.x, H.z, 0.6);
  } else if (R.outcome === Outcome.BLOCKED) { fx.burstSparks(_p, _n, 0.5); cam.impact('light'); }
};
// v2.7 MH-style damage numbers: project the contact point to CSS px (presentation only, deterministic drift)
const _dproj = new THREE.Vector3(); let dmgSeq = 0;
function popDamageAt(p, amount, kind) {
  _dproj.copy(p).project(camera); if (_dproj.z > 1) return;
  const dx = ((dmgSeq++ * 37) % 7 - 3) * 9;
  hud.popDamage((_dproj.x * 0.5 + 0.5) * innerWidth, (-_dproj.y * 0.5 + 0.5) * innerHeight - 20, amount, kind, dx);
}
sim.onHeroHit = (t, dealt, v) => {
  if (dealt <= 0) return;
  { const hv = v.name === 'HEAVY', c = v.charge || 0; _a.set(t.x, 1.6, t.z); if (t.isBoss) { HEAD.getWorldPosition(_a); _a.lerp(boss.root.position, 0.4); _a.y = Math.max(_a.y, 1.8); }
    popDamageAt(_a, dealt, c > 0.5 || dealt >= 40 ? 'big' : hv ? '' : dealt < 12 ? 'weak' : '');
    if (hv && c > 0.5) hud.flash(reducedMotion ? 0.15 : 0.35); }
  _n.set(H.facingX(), 0.2, H.facingZ());
  if (t.isBoss) { HEAD.getWorldPosition(_p); _p.lerp(boss.root.position, 0.5); _p.y = Math.max(_p.y, 1.2); }
  else _p.set(t.x, 1.2, t.z);
  const heavy = v.name === 'HEAVY', ch = v.charge || 0, great = !!v.great;
  fx.burstSparks(_p, _n, (heavy ? 1.0 + 0.9 * ch : 0.6) * (great ? 1.4 : 1));
  if (heavy && !t.isBoss) fx.burstBlood(_p, _n, 0.8 + 0.6 * ch);
  if (ch > 0.5) fx.burstSparks(_p, _n, 0.8);
  cam.impact(ch > 0.5 ? 'slam' : heavy ? (great ? 'slam' : 'heavy') : great ? 'heavy' : 'light');
  // hit-stop: a short presentation+sim time dilation sells weight (outcomes are per-frame, so determinism holds)
  if (heavy) loop.dilate(ch > 0 ? 0.15 : 0.25, (ch > 0.5 ? 3 : 2) + (great ? 1 : 0)); else loop.dilate(0.35, great ? 2 : 1);
  // great sword lights still shove the water: a small ring at the target
  if (great && !heavy) { const gx = t.isBoss ? _p.x : t.x, gz = t.isBoss ? _p.z : t.z; fx.shockwave(gx, colliders.terrainY(gz) + 0.22, gz, 1.8, 0xff8a3a, 0.5, 0.35); }
  if (ch > 0.5) hud.cue('CHARGED STRIKE', 'perfect');
  // ground shockwave under heavy contacts (size and heat scale with the charge)
  if (heavy) { const gx = t.isBoss ? _p.x : t.x, gz = t.isBoss ? _p.z : t.z; fx.shockwave(gx, colliders.terrainY(gz) + 0.22, gz, 2.2 + 3.0 * ch, ch > 0.5 ? 0xffd080 : 0xff8a3a, 0.7 + 0.6 * ch, 0.45 + 0.2 * ch); }
  if (heavy && ch > 0.5) { _n.set(0, 1, 0); fx.burstSparks(_p, _n, 1.3); }
  if (heavy) fx.shockwave(t.x, colliders.terrainY(t.z) + 0.24, t.z, (t.isBoss ? 3.5 : 2.2) * (1 + 0.6 * ch), 0xffa040, 0.6 + 0.6 * ch, 0.4);
  if (t.isBoss) { bossReact.amp = Math.min(1.6, bossReact.amp * 0.4 + (heavy ? 1 : 0.5) * (1 + ch)); bossReact.t = 0; bossReact.dx = H.facingX(); bossReact.dz = H.facingZ(); bossReact.flash = Math.min(1, 0.5 + 0.5 * ch + (heavy ? 0.3 : 0)); }
};
sim.onEquip = (w) => {
  setHeroWeapon(w);
  if (w !== 1) return;
  const P = sim.pickup, gy = colliders.terrainY(P.z);
  _p.set(P.x, gy + 1.2, P.z); _n.set(0, 1, 0);
  fx.burstSparks(_p, _n, 1.6); fx.shockwave(P.x, gy + 0.22, P.z, 3.4, 0xffa040, 0.9, 0.55);
  cam.impact('light'); hud.cue('GREAT SWORD CLAIMED', 'perfect'); hud.flash(reducedMotion ? 0.08 : 0.2);
};
function pickupLayer(dt) {
  const P = sim.pickup, on = P.active && sim.bossActive;
  pickupRoot.visible = on;
  if (!on) return;
  const gy = colliders.terrainY(P.z);
  pickupRoot.position.set(P.x, gy + 1.38, P.z);
  pickupGlow.t += dt;
  const k = 0.5 + 0.5 * Math.sin(pickupGlow.t * 3.2);
  pickupBeamMat.opacity = 0.07 + 0.13 * k;
  emberInlay.emissiveIntensity = 0.8 + 1.6 * k;
  // ground ping every 1.25 s so it reads even when the column is behind the camera
  if (dt > 0 && sim.frame % 75 === 0 && pickupGlow.ping !== sim.frame) {
    pickupGlow.ping = sim.frame; fx.shockwave(P.x, gy + 0.22, P.z, 2.0, 0xffa040, 0.45, 0.6);
  }
}
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
  else if (s === GameState.BOSS) { hud.banner('FORD WYVERN', sim.pickup.active ? 'claim the great sword in the ford' : 'guardian of the crossing', 2.6); fx.clearTelegraph(BOSS_ID); cam.cine(CINE.INTRO); }
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
const bot = { at: -1, kind: 0, hold: 0, swings: 0 };
if (useBot) {
  const prevT = sim.onTelegraph, prevD = sim.onDuelistTelegraph;
  sim.onTelegraph = (v, art, lead) => { prevT(v, art, lead); const ok = botRng.float() < 0.85;
    if (art === ART.NORMAL) { bot.at = sim.frame + lead - (ok ? 3 : 7); bot.kind = 1; } else { bot.at = sim.frame + lead - (ok ? 5 : 11); bot.kind = art === ART.BLUE ? 3 : 2; } };
  sim.onDuelistTelegraph = (d, v) => { prevD(d, v); if (botRng.float() < 0.85) { bot.at = sim.frame + v.startup - 3; bot.kind = 1; } };
}
function botCommand(c) {
  let tx = 0, tz = 0, has = false, td = 1e9, reach = 1.6;
  for (const d of sim.duelists) if (d.alive) { const dd = Math.hypot(d.x - H.x, d.z - H.z); if (dd < td) { td = dd; tx = d.x; tz = d.z; has = true; } }
  if (sim.bossActive && sim.brain.state !== BRAIN_STATE.DEAD) { tx = sim.brain.x; tz = sim.brain.z; td = Math.hypot(tx - H.x, tz - H.z); has = true; reach = 3.2; }
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
  // great sword: go claim it first (it is the intended opening of the boss fight)
  if (sim.bossActive && sim.pickup.active && sim.frame + 1 !== bot.at) {
    const px = sim.pickup.x - H.x, pz = sim.pickup.z - H.z, pl = Math.hypot(px, pz) || 1;
    c.mx = px / pl; c.mz = pz / pl; c.speed = SIM.RUN_SPEED; return;
  }
  // rec showcase: hold a charged heavy through its wind-up (released by the dodge/block reflex or at full charge)
  if (recMode && bot.hold > 0 && sim.frame + 1 !== bot.at) { bot.hold--; c.heavyHeld = true; return; }
  if (sim.frame + 1 === bot.at) {
    bot.hold = 0;
    if (bot.kind === 1) c.blockPress = true;
    else { c.dodge = true; if (bot.kind === 3) { c.mx = dx / l; c.mz = dz / l; } else { c.mx = -dz / l; c.mz = dx / l; } }
  } else if (td > reach + 0.6) { c.mx = dx / l; c.mz = dz / l; c.speed = SIM.RUN_SPEED; }
  else if ((sim.frame + 1) % 9 === 0) {
    if (sim.finisherReady()) c.heavy = true;
    else if (recMode && H.state === HERO_STATE.LOCO && H.stamina >= 60 && ++bot.swings % 5 === 0 && (bot.at < sim.frame || bot.at - sim.frame > 70)) { c.heavy = true; c.heavyHeld = true; bot.hold = 62; }
    else c.attack = true;
  }
  else if (td < reach - 0.6) { c.mx = -dx / l; c.mz = -dz / l; c.speed = SIM.WALK_SPEED; }
}
function fillCommand() {
  const c = sim.cmd;
  c.mx = 0; c.mz = 0; c.speed = 0; c.attack = false; c.heavy = false; c.heavyHeld = false; c.dodge = false; c.roll = false; c.blockHeld = false; c.blockPress = false;
  if (useBot) { botCommand(c); return; }
  input.moveIntent(camYaw, _move);
  const mag = input.moveMagnitude;
  c.mx = _move.x; c.mz = _move.z; c.speed = input.speedForMagnitude(mag);
  // buffered combat presses: consumed on the step they are read; HeroSim queues chains itself
  const b = input.peekBuffered();
  if (b === A.ATTACK && input.consumeBuffered(A.ATTACK)) c.attack = true;
  else if (b === A.HEAVY && input.consumeBuffered(A.HEAVY)) c.heavy = true;
  else if (b === A.DODGE && input.consumeBuffered(A.DODGE)) c.dodge = true;
  else if (b === A.ROLL && input.consumeBuffered(A.ROLL)) c.roll = true;
  else if (b === A.BLOCK && input.consumeBuffered(A.BLOCK)) c.blockPress = true;
  c.blockHeld = input.isHeld(A.BLOCK);
  c.heavyHeld = input.isHeld(A.HEAVY);            // charge: the swing holds at the top of its wind-up while held
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
// v2.9 ink-blade pass (studied from Phantom Blade Zero's Drunken Sword footage): jade ink ribbons that linger as a
// brush wash, mist-vanish dodges with a jade afterimage trail, a loose drunken sway between attacks, violet kill
// dissolves and a lock-on reticle. Presentation only: nothing here reads back into the sim. Disable with ?ink=0.
const INK_ON = qs.get('ink') !== '0';
const INK = Object.freeze({ JADE: 0x14e09a, FIN: 0xffd27a, GHOST: 0x6ff0d0, LINGER: 0.34 });
const ink = { puffF: -1, ghostF: -1, swayT: 0, swayK: 0 };
function inkLayer(attacking, dt) {
  if (dt <= 0) return;
  if (H.state === HERO_STATE.DODGE) {
    // vanish puff at the start of the step, then a jade ghost every 4 f through the travel window (once per sim frame)
    if (H.actF === 2 && ink.puffF !== sim.frame) { ink.puffF = sim.frame; fx.mist(H.x, colliders.terrainY(H.z) + 0.9, H.z, 0.5, MIST.WHITE, 9, 0.4); }
    if (!reducedMotion && H.actF >= 3 && H.actF <= 20 && (H.actF % 4) === 3 && ink.ghostF !== sim.frame) { ink.ghostF = sim.frame; fx.afterimage(HERO_ID, INK.GHOST, 0.55); }
  }
}
// drunken sway: a slow, loose figure-eight in the spine and a lagging head while the hero is free (not attacking,
// blocking, dodging or hit). Fades in over ~0.4 s and out in ~0.1 s, so it never touches a swing or a contact frame.
function inkSway(dt, fx_, fz_) {
  if (!INK_ON || dt <= 0) return;
  const free = H.state === HERO_STATE.LOCO && !H.blocking && !H.charging;
  ink.swayK += ((free ? 1 : 0) - ink.swayK) * Math.min(1, dt * (free ? 2.5 : 12));
  if (ink.swayK < 1e-3) return;
  ink.swayT += dt;
  const slow = 1 - Math.min(1, H.speed / 5.5) * 0.55;          // less sway at a run
  const a = ink.swayK * slow, t = ink.swayT;
  const roll = (0.075 * Math.sin(t * 1.7) + 0.025 * Math.sin(t * 4.3 + 1.1)) * a;
  const pitch = (0.04 * Math.sin(t * 3.4 + 0.6)) * a;
  _ax2.set(fx_, 0, fz_); _ax.set(-fz_, 0, fx_);
  rotWorld(HB.sp, _ax2, roll * 0.6); rotWorld(HB.s1, _ax2, roll * 0.5); rotWorld(HB.neck, _ax2, -roll * 0.7);
  rotWorld(HB.s1, _ax, -pitch); rotWorld(HB.neck, _ax, pitch * 0.5);
  rotWorld(HB.s2, UP, 0.05 * Math.sin(t * 1.3 + 0.4) * a);
}
// lock-on reticle: a thin ring + dot on the current target, DOM only (pointer-events none), hidden with no target
const reticle = document.createElement('div'); reticle.className = 'ec-ret';
{ const st = document.createElement('style');
  st.textContent = '.ec-ret{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid rgba(60,240,170,.9);border-radius:50%;pointer-events:none;z-index:19;opacity:0;box-shadow:0 0 10px rgba(20,224,154,.7),inset 0 0 6px rgba(20,224,154,.4);will-change:transform,opacity}.ec-ret:after{content:"";position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:#eafff8}';
  document.head.appendChild(st); }
document.body.appendChild(reticle);
const _rp = new THREE.Vector3(); let retOn = -1;
function reticleLayer() {
  const show = INK_ON && (sim.state === GameState.WAVE || sim.state === GameState.BOSS) && H.alive && cam.target && (lockOn || camTarget.isBoss) && !cam.cineActive;
  if (!show) { if (retOn !== 0) { reticle.style.opacity = '0'; retOn = 0; } return; }
  _rp.copy(camTarget.position).project(camera);
  if (_rp.z > 1) { reticle.style.opacity = '0'; retOn = 0; return; }
  const s = 1 + 0.06 * Math.sin(sim.frame * 0.12);
  reticle.style.transform = 'translate(' + ((_rp.x * 0.5 + 0.5) * innerWidth).toFixed(1) + 'px,' + ((-_rp.y * 0.5 + 0.5) * innerHeight).toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
  if (retOn !== 1) { reticle.style.opacity = '0.9'; retOn = 1; }
}
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();
const footSlide = { worst: 0, samples: 0 };

// ------------------------------------------------------------------ procedural animation layer (presentation only)
// Additive world-axis bone rotations applied after the mixer writes the authored pose each frame. The mixer
// rewrites every bound bone on the next pose(), so nothing accumulates. Drives: charge wind-up tremble and
// coil, swing commitment lean, hero hit recoil, wyvern hit recoil + emissive flash, wyvern head tracking,
// and wyvern land/crash impacts. Never feeds back into the sim.
const _pq = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _ax = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
function rotWorld(b, axis, ang) {
  if (!b || !b.parent || Math.abs(ang) < 1e-4) return;
  b.parent.getWorldQuaternion(_pq); _rq.setFromAxisAngle(axis, ang);
  _rq2.copy(_pq).invert().multiply(_rq).multiply(_pq); b.quaternion.premultiply(_rq2);
}
const HB = { s1: heroBones.Spine01, s2: heroBones.Spine02, neck: heroBones.neck };
const BB = { s1: bone('wivern_ Spine1'), s2: bone('wivern_ Spine2'), n1: bone('wivern_ Neck1'), n3: bone('wivern_ Neck3'), n5: bone('wivern_ Neck5'), head: HEAD };
const heroReact = { amp: 0, t: 9, dx: 0, dz: 0 };
const bossReact = { amp: 0, t: 9, dx: 0, dz: 1, flash: 0, look: 0, lastClip: '' };
const chargeFx = { wasFull: false, glow: 0 };
const lean = { sp: 0, yaw: 0, p: 0, r: 0 }; const _ax2 = new THREE.Vector3();
HB.sp = heroBones.Spine;
// swing drive: the torso coils against the swing over the last 14 f of startup, whips through the active window and
// overshoots on a damped spring in recovery. Swing direction is measured from the blade tip's lateral travel during
// the active window (sign learned per verb), so the layer always amplifies the authored arc instead of fighting it.
const swing = { sign: { LIGHT_1: 0, LIGHT_2: 0, LIGHT_3: 0, HEAVY: 0 }, lat: 0, acc: 0, aid: -1, learned: false };
function swingDrive(dt, fx_, fz_) {
  if (H.state !== HERO_STATE.ACTION || H.charging || !(H.verb in swing.sign)) { swing.aid = -1; return; }
  const v = H.verbs[H.verb], a = v.startup, e = v.startup + v.active, f = H.actF;
  heroSword.tip.getWorldPosition(_b);
  const lat = (_b.x - hero.root.position.x) * -fz_ + (_b.z - hero.root.position.z) * fx_;   // + = hero's right
  if (swing.aid !== H.actionId) { swing.aid = H.actionId; swing.acc = 0; swing.lat = lat; swing.learned = false; }
  if (f >= a && f < e && dt > 0) swing.acc += lat - swing.lat;
  swing.lat = lat;
  if (f >= e && !swing.learned) { swing.learned = true; if (Math.abs(swing.acc) > 0.05) swing.sign[H.verb] = Math.sign(swing.acc); }
  const s = swing.sign[H.verb];
  if (!s) return;
  const heavy = H.verb === 'HEAVY';
  const amp = heavy ? 0.24 * (1 + 0.6 * H.chargeLvl) : H.verb === 'LIGHT_3' ? 0.20 : 0.15;
  let tw;
  const w0 = Math.max(0, a - 14);
  if (f < a) { const u = f < w0 ? 0 : (f - w0) / Math.max(1, a - w0); tw = 0.8 * u * u; }                 // coil (ease-in)
  else if (f < e) tw = 0.8 - 1.8 * Math.sin(((f - a) / Math.max(1, v.active)) * Math.PI * 0.5);           // whip +0.8 -> -1.0
  else { const t = (f - e) / 60; tw = -Math.exp(-t * 7) * Math.cos(t * 14); }                             // overshoot spring
  // tip moving to the right = clockwise from above = negative about UP; coil is the opposite of the drive
  const ang = s * amp * tw;
  rotWorld(HB.sp, UP, ang * 0.3); rotWorld(HB.s1, UP, ang * 0.35); rotWorld(HB.s2, UP, ang * 0.4);
  rotWorld(HB.neck, UP, -ang * 0.35);                                                                    // eyes stay on target
}

// wyvern secondary motion: tail lag + idle wave, breathing, bite anticipation (rear back, then snap), roar shake,
// foot stomps, knockback. Presentation only.
const TAIL = ['wivern_ Tail', 'wivern_ Tail1', 'wivern_ Tail2', 'wivern_ Tail3', 'wivern_ Tail4', 'wivern_ Tail5', 'wivern_ Tail6', 'wivern_ Tail7', 'wivern_ Tail8'].map(bone).filter(Boolean);
const bossAnim = { yawPrev: 0, lag: 0, t: 0, foot: [1, 1], lastF: -1, lastVerb: -1, kb: 0, kbx: 0, kbz: 0 };
const _bax = new THREE.Vector3();
function bossSecondary(B, dt) {
  bossAnim.t += dt;
  const fx_ = B.forwardX(), fz_ = B.forwardZ();
  _bax.set(-fz_, 0, fx_);                                   // + rears back
  const act = B.state === BRAIN_STATE.ACTION ? B.def : null, f = B.f;
  // tail: lags the body's turn rate and carries a slow travelling wave (authored tail sweeps own the tail)
  const dyaw = lerpAngle(0, B.yaw - bossAnim.yawPrev, 1); bossAnim.yawPrev = B.yaw;
  const rate = dt > 0 ? dyaw / dt : 0;
  bossAnim.lag += (Math.max(-0.35, Math.min(0.35, rate * 0.18)) - bossAnim.lag) * Math.min(1, dt * 5);
  const tailAuthored = act && act.shape === 'tail';
  const alive = B.state !== BRAIN_STATE.DEAD;
  for (let i = 0; i < TAIL.length; i++) {
    let r = -bossAnim.lag * (0.03 + 0.025 * i);
    if (!tailAuthored && alive) r += Math.sin(bossAnim.t * 1.7 - i * 0.7) * 0.03 * (0.3 + i / 8);
    rotWorld(TAIL[i], UP, tailAuthored ? r * 0.3 : r);
  }
  if (!alive) return;
  // breathing on grounded idle beats
  if (!act && !B.airborne) { const b = Math.sin(bossAnim.t * 1.4); rotWorld(BB.s2, _bax, b * 0.03); rotWorld(BB.n1, _bax, -b * 0.02); }
  // front strikes: rear back over the 18 f before contact, then snap through with a damped overshoot
  if (act && act.shape === 'front') {
    const a0 = act.active[0];
    let k = 0;
    if (f >= a0 - 18 && f < a0) { const u = (f - (a0 - 18)) / 18; k = 0.30 * u * u; }
    else if (f >= a0) { const t = (f - a0) / 60; k = -0.24 * Math.exp(-t * 9) * Math.cos(t * 12); }
    if (k !== 0) { rotWorld(BB.s2, _bax, k * 0.25); rotWorld(BB.n1, _bax, k * 0.45); rotWorld(BB.n3, _bax, k * 0.4); rotWorld(BB.head, _bax, k * 0.3); }
  }
  // roar: the head trembles through the bellow
  if (act && B.verb === BossVerb.W_ROAR && f > 16 && f < 66) { const e = Math.sin((f - 16) / 50 * Math.PI); rotWorld(BB.head, UP, Math.sin(bossAnim.t * 38) * 0.07 * e); rotWorld(BB.n5, _bax, Math.sin(bossAnim.t * 31) * 0.05 * e); }
  // tail sweep contact: ground shockwave the width of the sweep
  if (act && act.shape === 'tail' && bossAnim.lastVerb === B.verb && bossAnim.lastF < act.active[0] && f >= act.active[0]) {
    fx.shockwave(B.x, colliders.terrainY(B.z) + 0.22, B.z, act.reach + 0.6, 0xff7a2a, 0.7, 0.5); cam.impact('heavy');
  }
  bossAnim.lastF = f; bossAnim.lastVerb = B.verb;
  // foot stomps while grounded: hysteresis on foot height above the terrain
  if (!B.airborne && dt > 0) {
    const feet = [FOOT_L, FOOT_R];
    for (let i = 0; i < 2; i++) {
      feet[i].getWorldPosition(_b); const h = _b.y - colliders.terrainY(_b.z);
      if (bossAnim.foot[i] && h < 0.35) { bossAnim.foot[i] = 0; fx.splash(_b.x, _b.z, 0.7); fx.shockwave(_b.x, colliders.terrainY(_b.z) + 0.22, _b.z, 1.4, 0xb8a080, 0.25, 0.4); }
      else if (!bossAnim.foot[i] && h > 0.7) bossAnim.foot[i] = 1;
    }
  }
}
const BOSS_FLASH = new THREE.Color(1.0, 0.42, 0.16);
function heroLayer(dt) {
  hero.model.updateMatrixWorld(true);
  const fx_ = H.facingX(), fz_ = H.facingZ();
  _ax.set(-fz_, 0, fx_);                                   // hero right axis: + leans back, - leans forward
  // charged heavy: coil back while holding, tremble grows with the charge level; blade heats up
  const L = H.charging ? H.chargeLvl : 0;
  if (H.charging && H.chargeF > 0) {
    const tr = Math.sin(H.frame * 1.9) * 0.02 * L;
    rotWorld(HB.s1, _ax, 0.08 * L + tr); rotWorld(HB.s2, _ax, 0.06 * L - tr);
    rotWorld(HB.s1, UP, 0.12 * L);
  }
  // swing commitment: lean into the active window, heavier and longer for a charged release
  if (H.state === HERO_STATE.ACTION && !H.charging) {
    const v = H.verbs[H.verb], a = v.startup, e = v.startup + v.active, f = H.actF;
    const k = f < a ? 0 : f < e ? (f - a) / Math.max(1, v.active) : Math.max(0, 1 - (f - e) / 14);
    const depth = (H.verb === 'HEAVY' ? 0.16 * (1 + 0.8 * H.chargeLvl) : 0.07) * Math.sin(Math.min(1, k) * Math.PI * 0.5 + (f >= e ? Math.PI * 0.5 : 0));
    rotWorld(HB.s1, _ax, -depth); rotWorld(HB.s2, _ax, -depth * 0.6);
  }
  swingDrive(dt, fx_, fz_);
  inkSway(dt, fx_, fz_);
  // C15 locomotion weight: pitch into acceleration / back on braking, bank into turns (spring-smoothed, loco only)
  if (dt > 0) {
    const sp = H.speed, acc = (sp - lean.sp) / dt; lean.sp = sp;
    let dy = (dispYaw === null ? 0 : dispYaw) - lean.yaw; dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI; lean.yaw = dispYaw || 0;
    const loco = H.state === HERO_STATE.LOCO && !H.blocking;
    const wantP = loco ? Math.max(-0.12, Math.min(0.12, acc * 0.012)) + Math.min(0.06, sp * 0.009) : 0;
    const wantR = loco ? Math.max(-0.14, Math.min(0.14, (dy / dt) * sp * 0.006)) : 0;
    const k = Math.min(1, dt * 7);
    lean.p += (wantP - lean.p) * k; lean.r += (wantR - lean.r) * k;
    if (Math.abs(lean.p) > 1e-3) { rotWorld(HB.sp, _ax, -lean.p * 0.5); rotWorld(HB.s1, _ax, -lean.p * 0.5); }
    if (Math.abs(lean.r) > 1e-3) { _ax2.set(fx_, 0, fz_); rotWorld(HB.sp, _ax2, lean.r * 0.6); rotWorld(HB.neck, _ax2, -lean.r * 0.4); }
  }
  // incoming hit recoil: damped spring away from the hit
  heroReact.t += dt;
  if (heroReact.amp > 0.01) {
    const s = heroReact.amp * Math.exp(-heroReact.t * 8) * Math.cos(heroReact.t * 18);
    _ax.set(heroReact.dz, 0, -heroReact.dx);
    rotWorld(HB.s1, _ax, 0.16 * s); rotWorld(HB.neck, _ax, 0.12 * s);
    if (heroReact.t > 0.6) heroReact.amp = 0;
  }
  // blade heat: emissive only (no program change); full charge flashes once
  chargeFx.glow += ((L > 0 ? 0.25 + 1.6 * L : 0) - chargeFx.glow) * Math.min(1, dt * 14);
  heroSteel.emissive.setRGB(1.0 * chargeFx.glow, 0.38 * chargeFx.glow, 0.08 * chargeFx.glow);
  const full = H.charging && H.chargeF >= HERO_CHARGE.MAX_F;
  if (full && !chargeFx.wasFull) { heroSword.tip.getWorldPosition(_a); _n.set(0, 1, 0); fx.burstSparks(_a, _n, 0.9); cam.impact('light'); hud.cue('FULL CHARGE', 'perfect'); hud.flash(reducedMotion ? 0.08 : 0.18); }
  chargeFx.wasFull = full;
  if (L > 0.25 && dt > 0 && (H.frame % 7) === 0) { heroSword.tip.getWorldPosition(_a); _n.set(0, 1, 0); fx.burstSparks(_a, _n, 0.15 + 0.25 * L); }
}
function bossLayer(dt) {
  const B = sim.brain;
  boss.model.updateMatrixWorld(true);
  // land / crash: weight on the ground
  const clip = B.anim.clip;
  if (clip !== bossReact.lastClip) {
    if (clip === 'crash' || clip === 'land') { cam.impact('slam'); fx.splash(B.x, B.z, clip === 'crash' ? 2.2 : 1.4);
      fx.shockwave(B.x, colliders.terrainY(B.z) + 0.22, B.z, clip === 'crash' ? 7.5 : 5.5, 0xffb070, clip === 'crash' ? 1.2 : 0.9, 0.6); _a.set(B.x, colliders.terrainY(B.z) + 0.3, B.z); _n.set(0, 1, 0); fx.burstSparks(_a, _n, 0.8); fx.shockwave(B.x, colliders.terrainY(B.z) + 0.24, B.z, clip === 'crash' ? 7 : 5, 0xc8d8ff, 0.9, 0.55); }
    bossReact.lastClip = clip;
  }
  // head tracking toward the hero on grounded idle/hold beats (authored attacks keep their own aim)
  const idle = B.state === BRAIN_STATE.WAIT || B.state === BRAIN_STATE.HOLD || B.state === BRAIN_STATE.PREROLL;
  let want = 0;
  if (idle && !B.airborne) { const yawTo = Math.atan2(-(H.x - B.x), -(H.z - B.z)); want = Math.max(-0.55, Math.min(0.55, lerpAngle(0, yawTo - B.yaw, 1))); }
  bossReact.look += (want - bossReact.look) * Math.min(1, dt * 4);
  if (Math.abs(bossReact.look) > 1e-3) { rotWorld(BB.n1, UP, bossReact.look * 0.3); rotWorld(BB.n3, UP, bossReact.look * 0.35); rotWorld(BB.head, UP, bossReact.look * 0.35); }
  // hit recoil: the neck chain rears away from the blade, spine flinches; emissive flash on the hide
  bossReact.t += dt;
  if (bossReact.amp > 0.01) {
    const s = bossReact.amp * Math.exp(-bossReact.t * 6.5) * Math.cos(bossReact.t * 15);
    _ax.set(bossReact.dz, 0, -bossReact.dx);
    rotWorld(BB.s2, _ax, 0.06 * s); rotWorld(BB.n1, _ax, 0.10 * s); rotWorld(BB.n3, _ax, 0.10 * s); rotWorld(BB.n5, _ax, 0.08 * s);
    rotWorld(BB.s1, UP, 0.05 * s * Math.sin(bossReact.t * 9));
    if (bossReact.t > 0.9) bossReact.amp = 0;
  }
  bossSecondary(B, dt);
  bossReact.flash = Math.max(0, bossReact.flash - dt * 5);
  for (const m of bossMats) if (m.emissive) m.emissive.copy(BOSS_FLASH).multiplyScalar(0.55 * bossReact.flash * bossReact.flash);
}

const HERO_ACT_CLIPS = new Set(Object.values(H.verbs).map((v) => v.clip).concat(['heavy', 'mh_judgment', 'lunge_s', 'lunge_m', 'lunge_h']));
const HERO_LOCO_CLIPS = new Set(['idle', 'walk', 'run', 'block', 'parry']);
// blend windows (s): attacks enter fast so startup stays readable; recovery settles slowly into stance
function heroBlend(nc, oc) {
  if (nc === 'hit') return 0.07;
  if (nc === 'death') return 0.2;
  if (HERO_ACT_CLIPS.has(nc)) return HERO_ACT_CLIPS.has(oc) ? 0.09 : 0.11;
  if (HERO_LOCO_CLIPS.has(nc)) return HERO_ACT_CLIPS.has(oc) ? 0.26 : oc === 'hit' ? 0.2 : 0.16;
  return 0.1;                                                     // quickstep / roll entry
}
const jerk = { hero: new PoseJerk(hero.inert.bones), boss: new PoseJerk(boss.inert.bones) };
const jerkRaw = new PoseJerk(hero.inert.bones);
const trace = { on: false, rows: [] };
function poseHero(alpha, presentDt) {
  poseHeroBase(alpha, presentDt);
  if (trace.on && presentDt > 0) jerkRaw.sample();
  hero.inert.apply(hero.pc, hero.pt, LOOP_CLIPS.has(hero.pc), presentDt, heroBlend, contactDeadline());
  heroLayer(presentDt);
  if (presentDt > 0) jerk.hero.sample();
  if (trace.on && presentDt > 0) {
    const r = jerkRaw.na ? jerkRaw.acc[jerkRaw.na - 1] : null, f = jerk.hero.na ? jerk.hero.acc[jerk.hero.na - 1] : null;
    heroSword.tip.getWorldPosition(_b); trace.rows.push({ tip: [+_b.x.toFixed(4), +_b.y.toFixed(4), +_b.z.toFixed(4)], act: H.state === HERO_STATE.ACTION && H.actF >= H.verbs[H.verb].startup && H.actF < H.verbs[H.verb].startup + H.verbs[H.verb].active, raw: r, fin: f, bone: jerk.hero.accBone, rbone: jerkRaw.accBone, st: H.state, clip: hero.pc, verb: H.verb, f: H.actF });
  }
}
// seconds until the current swing's active window (pose must be exact there: no sword drift). Infinity otherwise.
function contactDeadline() {
  if (H.state !== HERO_STATE.ACTION || !H.verbs[H.verb]) return Infinity;
  const v = H.verbs[H.verb], f = H.actF;
  if (f >= v.startup + v.active) return Infinity;
  return Math.max(0, (v.startup - f) / 60);
}
function heroClipT() { const w = WARP_ON && WARP[H.verb]; return w ? w.clipTime(H.actF) : H.verbClipTime(H.actF); }
function poseHeroBase(alpha, presentDt) {
  const st = H.state;
  if (st === HERO_STATE.ACTION) {
    const v = H.verbs[H.verb], ln = LUNGE_FOR[H.verb], ld = ln && lungeOk[ln];
    if (ld) {
      // footwork covers the sim lunge window (startup+active) and settles through early recovery
      const lf = v.startup + v.active, span = lf * 1.5, u = Math.min(1, (H.actF + alpha) / span);
      const w = H.actF < span ? 1.6 : Math.max(0, 1.6 * (1 - (H.actF - span) / 12));
      pose(hero, 2, v.clip, 1, heroClipT(), ln, w, u * ld);
      return;
    }
    pose(hero, 1, v.clip, 1, heroClipT()); return;
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
  if (st === HERO_STATE.FINISHER) {
    const fc = HERO_FINISHER_CLIP, kn = fc.knots, f = Math.min(HERO_FINISHER_F, H.actF + alpha);
    if (hero.actions[fc.clip]) {
      let i = 0; while (i < kn.length - 2 && f > kn[i + 1][0]) i++;
      const u = (f - kn[i][0]) / (kn[i + 1][0] - kn[i][0]);
      pose(hero, 1, fc.clip, 1, (kn[i][1] + (kn[i + 1][1] - kn[i][1]) * Math.min(1, Math.max(0, u))) / 60); return;
    }
    pose(hero, 1, 'heavy', 1, (H.actF / HERO_FINISHER_F) * hero.dur.heavy); return;
  }
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

// duelist: seconds until the next ACTIVE phase from the timing table (pose exact at contact). Infinity when none ahead.
const DUEL_ACTIVE = {};
for (const k in timing.verbs) { let f = 0; DUEL_ACTIVE[k] = []; for (const p of timing.verbs[k].phases) { if (p.phase.startsWith('ACTIVE')) DUEL_ACTIVE[k].push(f); f += p.specF; } }
function duelDeadline(d) {
  if (d.state !== DUEL_STATE.ATTACK || !DUEL_ACTIVE[d.verb]) return Infinity;
  for (const a of DUEL_ACTIVE[d.verb]) if (d.f < a) return (a - d.f) / 60;
  return Infinity;
}
function poseDuelist(s, i, alpha) {  const d = s.bound, P = dPrev[i];
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
  } else { s.lastF = sim.frame; const w = WARP_ON && d.state === DUEL_STATE.ATTACK && WARP[d.verb]; pose(s, 1, A_.clip, 1, w ? w.clipTime(d.f) : A_.time); }
  s.inert.apply(s.pc, s.pt, LOOP_CLIPS.has(s.pc), presentDtNow, duelBlend, duelDeadline(d));
  const attacking = d.state === DUEL_STATE.ATTACK;
  if (attacking) { s.sword.hilt.getWorldPosition(_a); s.sword.tip.getWorldPosition(_b); fx.streakSample(s.actorId, _a, _b); streak.d[i] = true; }
  else { if (streak.d[i]) { fx.streakEnd(s.actorId); streak.d[i] = false; } fx.clearTelegraph(s.actorId); }
}

function bossBlend(nc, oc) { return nc === 'hit' || nc === 'crash' ? 0.12 : nc === 'death' ? 0.3 : 0.24; }
function duelBlend(nc, oc) { return /hit/.test(nc) ? 0.07 : /death/.test(nc) ? 0.18 : 0.14; }
function poseBoss(alpha) {
  const B = sim.brain;
  const bzI = prev.bz + (B.z - prev.bz) * alpha;
  boss.root.position.set(prev.bx + (B.x - prev.bx) * alpha, prev.by + (B.y - prev.by) * alpha + (B.airborne ? 0 : colliders.terrainY(bzI)), bzI);
  boss.root.rotation.y = lerpAngle(prev.byaw, B.yaw, alpha);
  pose(boss, 1, B.anim.clip, 1, B.anim.time);
  boss.inert.apply(boss.pc, boss.pt, !!B.anim.loop, presentDtNow, bossBlend);
  bossLayer(presentDtNow);
  if (presentDtNow > 0) jerk.boss.sample();
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
let dispYaw = null;

let wasFinisher = false, finHitShown = false;
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
  if (p.kind !== ActorKind.WYVERN) {
    // v2.9 ink kill: the duelist dissolves in violet mist; a short presentation-only slow-mo sells the final blow
    if (!INK_ON) return;
    for (const s of slots) if (s.bound && s.actorId === p.actorId) {
      const r = s.root.position, y = colliders.terrainY(r.z);
      fx.mist(r.x, y + 1.0, r.z, 0.7, MIST.VIOLET, 14, 0.9); fx.mist(r.x, y + 0.3, r.z, 0.9, MIST.WHITE, 6, 0.3);
      if (!reducedMotion) loop.dilate(0.45, 8, true);
      break;
    }
    return;
  }
  cam.cine(CINE.DEATH); loop.dilate(0.4, 70, true);
  { const B = sim.brain; fx.shockwave(B.x, colliders.terrainY(B.z) + 0.22, B.z, 9, 0xffc080, 1.4, 0.9); }
  hud.banner('THE FORD IS YOURS', 'the wyvern falls', 3.0);
});

let lockOn = false;
function chooseCamTarget() {
  if (sim.bossActive && sim.brain.state !== BRAIN_STATE.DEAD) {
    // C13: frame on the body column (root xz) at head height. Aiming at the head itself flipped the hero->target line
    // whenever the 3x wyvern's neck overhung a close hero, parking the camera behind the boss looking through its body.
    HEAD.getWorldPosition(camTarget.position);
    camTarget.position.x = boss.root.position.x; camTarget.position.z = boss.root.position.z;
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
  // C15: the sim snap-turns on attack assist / parry / finisher; the body turns into it over ~5 frames instead of
  // popping. Small steady turns pass straight through (no lag on locomotion).
  { const tY = lerpAngle(prev.hyaw, H.yaw, alpha);
    if (!INERT_ON || presentDt <= 0 || dispYaw === null) dispYaw = tY;
    else { let e = tY - dispYaw; e -= Math.round(e / (2 * Math.PI)) * 2 * Math.PI; const ae = Math.abs(e);
      const k = ae < 0.12 ? 1 : 1 - Math.exp(-presentDt * (ae > 1.2 ? 26 : 34)); dispYaw += e * k; }
    hero.root.rotation.y = dispYaw; }
  poseHero(alpha, presentDt);
  for (let i = 0; i < slots.length; i++) if (slots[i].bound) poseDuelist(slots[i], i, alpha);
  if (sim.bossActive) poseBoss(alpha);
  else { for (const m of poolMeshes) m.visible = false; orbMesh.visible = false; }
  pickupLayer(presentDt);

  const attacking = H.state === HERO_STATE.ACTION || H.state === HERO_STATE.FINISHER;
  if (attacking) { heroSword.hilt.getWorldPosition(_a); heroSword.tip.getWorldPosition(_b);
    const finisher = H.state === HERO_STATE.FINISHER;
    fx.streakSample(HERO_ID, _a, _b, INK_ON ? (finisher ? INK.FIN : INK.JADE) : 0xff1f14, INK_ON ? INK.LINGER : undefined); streak.hero = true; }
  else if (streak.hero) { fx.streakEnd(HERO_ID); streak.hero = false; }
  if (INK_ON) inkLayer(attacking, presentDt);
  else if (H.state === HERO_STATE.DODGE && H.actF === 3 && presentDt > 0) fx.afterimage(HERO_ID, false, 0.5);
  reticleLayer();

  camHero.position.copy(hero.root.position); camHero.yaw = H.yaw;
  chooseCamTarget();
  // cinematic subject: the wyvern's body-to-head midpoint (tracks the landing, the roar and the fall)
  // C13 occluder: the wyvern body centre (pelvis->chest), only while grounded near the hero
  cam.occluder.active = sim.bossActive && !sim.brain.airborne; cam.occAvoid = OCC_ON;
  if (cam.occluder.active) { BB.s2.getWorldPosition(cam.occluder.position); }
  if (sim.bossActive) {
    HEAD.getWorldPosition(_a); cam.cineFocus.copy(boss.root.position).lerp(_a, 0.5); cam.cineFocus.y = Math.max(1.4, cam.cineFocus.y);
    if (cam.cineKind === CINE.FINISHER) cam.cineFocus.copy(boss.root.position);
  }
  const fin = H.state === HERO_STATE.FINISHER && sim.bossActive;
  if (fin && !wasFinisher) cam.cine(CINE.FINISHER);
  // finisher blow lands on brain frame 60 (WyvernBrain FINISHER_HIT_F): flash + giant number, once per finisher
  if (fin && sim.brain.finisherF >= 60 && !finHitShown) {
    finHitShown = true; HEAD.getWorldPosition(_a); hud.popDamage(innerWidth * 0.5, innerHeight * 0.42, 160, 'fin', 0);
    hud.flash(reducedMotion ? 0.2 : 0.7); fx.shockwave(boss.root.position.x, colliders.terrainY(boss.root.position.z) + 0.25, boss.root.position.z, 6.5, 0xffd080, 1.2, 0.6);
    _n.set(0, 1, 0); fx.burstSparks(_a, _n, 1.6);
  }
  if (!fin) finHitShown = false;
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
const credit = 'Boss model: ' + bossManifest.provenance.attribution.replace(/CC-BY-(\d)\.(\d)/g, 'CC BY $1.$2').replace(/\.+\s*$/, '') + '. Three.js (MIT).';
// Fullscreen: corner button + F key always; BEGIN (a user gesture) also enters it unless ?fs=0. Hidden while recording.
const fullscreen = new Fullscreen().init({ visible: !recMode });
const FS_ON_BEGIN = !recMode && qs.get('fs') !== '0';
const hud = new Hud().init({
  credit, touch: touch.visible,
  onStart: () => { if (FS_ON_BEGIN) fullscreen.request(); input.releaseAll(); sim.start(); resetPresentation(); },
  onRetry: () => { input.releaseAll(); input.clearBuffer(); sim.retry(); resetPresentation(); },
  onRestart: () => { input.releaseAll(); input.clearBuffer(); setPaused(false); sim.reset('title'); sim.start(); resetPresentation(); },
  onResume: () => { setPaused(false); captureMouse(); },
});
systems.set('hud', hud);
fullscreen.mountMenu(hud.slot('fs'));
let touchWanted = touch.visible;
touch.onVisibility = () => { if (hud._screen === '') touchWanted = touch.visible; };
function syncScreen() {
  const s = sim.state;
  const scr = s === GameState.TITLE ? 'title' : s === GameState.VICTORY ? 'victory' : s === GameState.DEFEAT ? 'defeat' : loop && loop.paused ? 'pause' : '';
  hud.screen(scr);
  fullscreen.setMenu(scr === 'title');
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
  fx.streakEnd(HERO_ID); streak.hero = false; fx.clearTelegraph(BOSS_ID); fx.clearFire(); wasFinisher = false; finHitShown = false; hud.clearFx(); breathOn = 0; letterbox(0);
  hero.inert.reset(); boss.inert.reset(); for (const s of slots) s.inert.reset(); dispYaw = null; lean.sp = 0; lean.p = 0; lean.r = 0; lean.yaw = H.yaw;
  swing.aid = -1; bossAnim.lag = 0; bossAnim.foot[0] = bossAnim.foot[1] = 1; bossAnim.lastF = -1; bossAnim.lastVerb = -1; bossAnim.yawPrev = sim.brain.yaw;
  heroReact.amp = 0; bossReact.amp = 0; bossReact.flash = 0; bossReact.look = 0; bossReact.lastClip = ''; chargeFx.glow = 0; chargeFx.wasFull = false;
  heroSteel.emissive.setRGB(0, 0, 0); for (const m of bossMats) if (m.emissive) m.emissive.setRGB(0, 0, 0);
  for (let i = 0; i < slots.length; i++) { if (slots[i].actorId >= 0) { fx.streakEnd(slots[i].actorId); fx.clearTelegraph(slots[i].actorId); } streak.d[i] = false; }
  bindSlots(); boss.root.visible = sim.bossActive;
  setHeroWeapon(H.weapon); pickupGlow.t = 0; pickupGlow.ping = -1; pickupRoot.visible = sim.pickup.active && sim.bossActive;
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
  if (sim.state === GameState.TITLE && (input.consumeBuffered(A.ATTACK) || input.consumeBuffered(A.DODGE) || input.consumeBuffered(A.ROLL))) { input.clearBuffer(); sim.start(); }
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
  touch.setAvailable(A.ROLL, H.stamina >= 1);
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
  pickupRoot.visible = true; pickupRoot.position.set(4.2, 1.4, -4.6); heroGreat.socket.visible = true;
  lbTop.style.transform = 'scaleY(0)';
  renderer.setRenderTarget(null);
  await renderer.compileAsync(scene, camera, scene);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  await world.water.prewarm(renderer, scene, camera);
  fx.prewarmEnd();
  for (const m of poolMeshes) m.visible = false; orbMesh.visible = false;
  setHeroWeapon(H.weapon); pickupRoot.visible = sim.pickup.active && sim.bossActive;
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
  dbgOcc() { const o = cam.occluder.position, r = (v) => +v.toFixed(2);
    return { o: [r(o.x), r(o.y), r(o.z)], cam: [r(camera.position.x), r(camera.position.y), r(camera.position.z)], hero: [r(H.x), r(H.y), r(H.z)],
      boss: [r(boss.root.position.x), r(boss.root.position.y), r(boss.root.position.z)], on: cam.occluder.active, avoid: cam.occAvoid, cine: cam.cineKind }; },
  // body footprint probe (QA): every boss bone below 3.2 m as (forward, right, height) in boss root space, plus hero
  dbgBody() {
    const R = boss.root, out = [], p = new THREE.Vector3(), fx = sim.brain.forwardX(), fz = sim.brain.forwardZ();
    R.updateMatrixWorld(true);
    R.traverse((o) => { if (!o.isBone) return; o.getWorldPosition(p); const dx = p.x - R.position.x, dz = p.z - R.position.z;
      out.push([o.name, +(dx * fx + dz * fz).toFixed(2), +(dx * -fz + dz * fx).toFixed(2), +(p.y - R.position.y).toFixed(2)]); });
    const hx = H.x - sim.brain.x, hz = H.z - sim.brain.z;
    return { bones: out, hero: [+(hx * fx + hz * fz).toFixed(2), +(hx * -fz + hz * fx).toFixed(2)], heroDist: +Math.hypot(hx, hz).toFixed(2),
      verb: sim.brain.verb, f: sim.brain.f, state: sim.brain.state, stance: sim.brain.stance, y: +sim.brain.y.toFixed(2) };
  },
  state() {
    return { frame: loop.simFrame, simFrame: sim.frame, state: GAME_STATE_NAMES[sim.state], wave: sim.wave, paused: loop.paused,
      screen: hud._screen, hash: sim.hash(), heroHp: H.hp, heroState: H.state, stamina: H.stamina, bossHp: sim.brain.hp,
      duelists: sim.duelists.map((d) => ({ hp: d.hp, alive: d.alive })), stats: { ...sim.stats }, run: { ...runStats },
      backDot: H.maxBackwardDot, camMin: cam.minClearance, camResets, quickstep: Object.keys(QUICKSTEP.clips),
      cam: { shot: cam.shot, trauma: cam.trauma, push: cam.push, phantom: cam.phantom, orbitYaw: cam.orbitYaw, heroYaw: H.yaw, timeScale: loop.timeScale,
        dist: Math.hypot(camera.position.x - H.x, camera.position.z - H.z), occFrames: cam.occFrames, occYaw: cam.occYaw, occOn: cam.occluder.active },
      cine: { kind: CINE_NAMES[cam.cineKind], w: cam.cineW, log: cam.cineLog.slice() }, fx: fx.counts(), rec: recMode, lunge: Object.keys(lungeOk),
      step: { kind: H.stepKind, dodgeF: H.dodgeF, clip: hero.on.length ? hero.on[0].getClip().name : '' }, programs: { start: progStart, now: renderer.info.programs.length },
      weapon: H.weapon, heroXZ: [+H.x.toFixed(2), +H.z.toFixed(2), +H.yaw.toFixed(3)], pickup: { x: sim.pickup.x, z: sim.pickup.z, active: sim.pickup.active, takenF: sim.pickup.takenF, shown: pickupRoot.visible },
      dropped: loop.droppedSteps, touch: touch.visible, fs: { supported: fullscreen.supported, mode: fullscreen.mode, active: fullscreen.active, requests: fullscreen.requests }, hud: { hp: hud.el.hpI.style.transform, boss: hud.el.boss.style.display } };
  },
  // camera framing probe (QA): hero chest in NDC + camera forward bearing, read straight off the rendered camera
  camProbe() {
    const v = new THREE.Vector3(H.x, colliders.terrainY(H.z) + 1.2, H.z).project(camera), f = new THREE.Vector3();
    camera.getWorldDirection(f);
    return { nx: v.x, ny: v.y, nz: v.z, yaw: Math.atan2(f.x, f.z), fov: camera.fov, boom: cam.cur.boom, pulledIn: cam.pulledIn, dist: camera.position.distanceTo(new THREE.Vector3(H.x, camera.position.y, H.z)), shot: cam.shot, trauma: cam.trauma, timeScale: loop.timeScale, state: GAME_STATE_NAMES[sim.state], cine: cam.cineActive ? cam.cineW : 0 };
  },
  jerk() { return { inert: INERT_ON, smooth: clipSmooth, heroKeys: hero.actions.light_1.getClip().tracks.map((t) => t.times.length).slice(0, 3), hero: jerk.hero.report(), boss: jerk.boss.report(), blends: { hero: hero.inert.blends, boss: boss.inert.blends } }; },
  dbgInert() { const r = []; for (const b of hero.inert.bones) { const q = b.quaternion; r.push([b.name, +q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)]); } return { r, t: hero.inert.t, dur: hero.inert.dur, clip: hero.inert.clip, st: H.state }; },
  resetJerk() { jerk.hero.reset(); jerk.boss.reset(); return true; },
  dbgTrace(n) { trace.on = true; trace.rows.length = 0; jerkRaw.reset(); jerk.hero.reset(); for (let i = 0; i < n; i++) loop.advance(1 / 60); trace.on = false; return trace.rows.slice(); },
  frames() { const n = Math.min(ftN, ft.length); return Array.from(ft.subarray(0, n)); },
  resetFrames() { ftN = 0; lastNow = 0; },
  layout: () => touch.layoutReport(),
  // ink probe (QA): live streak slots as owner / tint / life / sample count / guard->tip span of the newest sample
  dbgStreaks() { const r = [], S = 10, Hh = fx.stHist; for (let s = 0; s < 4; s++) { if (fx.stLife[s] <= 0) continue; const b = s * S * 6;
    r.push({ owner: fx.stOwner[s], hero: fx.stOwner[s] === HERO_ID, active: fx.stActive[s], life: +fx.stLife[s].toFixed(3), n: fx.stCount[s],
      tint: [+fx.stTint[s * 3].toFixed(2), +fx.stTint[s * 3 + 1].toFixed(2), +fx.stTint[s * 3 + 2].toFixed(2)],
      tipToHero: +Math.hypot(Hh[b + 3] - H.x, Hh[b + 5] - H.z).toFixed(2) }); } return r; },
  // Recorder lockstep: stop RAF, then each advance(n) runs n exact 1/60 s frames (sim + render), so captured
  // footage is a true 60 fps regardless of how slow the capture itself is.
  lockstep() { loop.stop(); return true; },
  world: () => ({ stats: world.stats, programs: renderer.info.programs.length, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
  // review camera (QA screenshots only): stops the loop, places the camera, renders one frame
  reviewCam(p, t) { loop.stop(); camera.position.set(p[0], p[1], p[2]); camera.lookAt(t[0], t[1], t[2]); placeFill(); renderer.render(scene, camera); return true; },
  forceBossVerb(name) { const v = BossVerb[name]; if (v === undefined) return false; sim.brain.forceNext = v; return true; },
  advance(n = 1) { for (let i = 0; i < n; i++) { loop.advance(1 / 60); } return { state: GAME_STATE_NAMES[sim.state], frame: sim.frame, cine: CINE_NAMES[cam.cineKind] }; },
  begin() { if (sim.state === GameState.TITLE) { input.releaseAll(); sim.start(); resetPresentation(); } return GAME_STATE_NAMES[sim.state]; },
  pump(n) { const p = loop.paused; loop.paused = false; for (let i = 0; i < n; i++) loop.step(); loop.paused = p; update(0, 1, 0); return sim.frame; },
  dispose() {
    loop.dispose(); removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisPause); document.removeEventListener('pointerlockchange', onLockLost);
    sim.dispose(); hud.dispose(); fullscreen.dispose(); touch.dispose(); input.dispose(); fx.dispose(); cam.dispose(); world.dispose(); look.dispose(); bus.dispose();
    for (const a of [hero, boss, ...slots]) a.mixer.stopAllAction();
    scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); for (const m of [].concat(o.material)) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); } } });
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  },
};
