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
import { Colliders } from '../world/Colliders.js';
import { FoundryStage } from '../world/FoundryStage.js';
import { makeFoundryEnvironment, setFoundryLook, restoreGorgeLook } from '../render/FoundryLook.js';
import { ShrineStage } from '../world/ShrineStage.js';
import { makeShrineEnvironment, setShrineLook } from '../render/ShrineLook.js';
import { CameraDirector, CINE, CINE_NAMES } from '../camera/CameraDirector.js';
import { BossVerb, ActorKind } from '../shared/enums.js';
import { FxPool, TELEGRAPH, MIST, FX_CAPS } from '../fx/FxPool.js';
import { WardenMotion } from './WardenMotion.js';
import { AmbientMotes } from '../fx/AmbientMotes.js';
import { PostStack } from '../render/PostStack.js';
import { STAGE_RIM, makeRimUniform, addRimToModel } from '../render/Rim.js';
import { Input } from '../player/Input.js';
import { TouchOverlay } from '../ui/TouchOverlay.js';
import { Hud } from '../ui/Hud.js';
import { Fullscreen } from '../ui/Fullscreen.js';
import { GameSim, GameState, HERO_STATE, DUEL_STATE, BRAIN_STATE, ART, WAVES, GAME_STATE_NAMES, WARDEN_ID, ROUTE, FLOW_F } from './GameSim.js';
import { WYVERN_STRING } from '../boss/WyvernBrain.js';
// v2.36 ?wstr=0 restores single wyvern attacks (no strings); read before any sim is built
if (new URLSearchParams(location.search).get('wstr') === '0') WYVERN_STRING.on = false;
import { RoadMap } from '../ui/RoadMap.js';
import { RoadStage } from '../world/RoadStage.js';
import { makeRoadEnvironment, setRoadLook, roadSunDir, ROAD_LOOK } from '../render/RoadLook.js';
import { ROAD, ROAD_AMBUSH, roadX, makeRoadDoc } from '../shared/road.js';
import { HERO_DODGE, HERO_FINISHER_F, HERO_FINISHER_CLIP, STEP_DIR, STEP_CLIP, HERO_CHARGE, GREATSWORD, scalePhases, HERO_SNATCH, HERO_TRIGGER, HERO_RIFT, WEAPONS, HERO_SWEEP, GREAT_NO_EVADE, setAttackSteer, GS_COIL, HERO_GREAT_X, greatPhases, HERO_FLASH, setFlow, HERO_JUMP } from './HeroSim.js';
import { STYLE_RANKS, STYLE_TITLES } from './StyleMeter.js';
const SNATCH_SPAN = HERO_SNATCH.STARTUP + HERO_SNATCH.TRAVEL_MAX + HERO_SNATCH.RECOVER;
import { buildQuickstep, quickstepClipTime } from '../shared/quickstep.js';
import { DUELIST, WARDEN } from './DuelistSim.js';
import { Inertializer, PoseJerk } from './Inertia.js';
import { smoothClips } from './ClipSmooth.js';
import { buildWarp } from './TimeWarp.js';
import { GauntletView, GAUNTLET_ID } from './GauntletView.js';
import { GAUNTLET } from '../shared/constants.js';
import { G_STATE } from '../boss/GauntletBrain.js';
import { makeRetargeter } from './Retarget.js';
import { loadWeaponMeshes, fitWeapon, dressRig } from './WeaponMeshes.js';
import { Choreo } from './Choreo.js';

const ROOT = new URL('../../', import.meta.url).href;      // site root (works under a GitHub Pages sub-path)
const qs = new URLSearchParams(location.search);
if (qs.get('steer') === '0') setAttackSteer(false);   // v2.29 attack aim + move-cancel (on by default)
if (qs.get('flow') === '0') setFlow(false);           // v2.34 flash step + looser attack steer (on by default)
const quality = resolveQuality(qs.get('q') || (matchMedia('(pointer: coarse)').matches ? 'medium' : 'high'));
const seed = Number(qs.get('seed') || SIM.SEED_DEFAULT) >>> 0;
const reducedMotion = qs.get('rm') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches;
// ?rec=1 recording mode: autopilot with full tactics, no cursor / credit / debug chrome, auto-start, letterboxed cine
const recMode = qs.get('rec') === '1';
// v2.24 playable character (?char=hero|vesper|kael, else the last pick). Chosen at boot; the title picker reloads.
const CHAR_IDS = ['hero', 'vesper', 'kael'];
const CHAR = CHAR_IDS.includes(qs.get('char')) ? qs.get('char') : (() => { try { const c = localStorage.getItem('ec.char'); return CHAR_IDS.includes(c) ? c : 'hero'; } catch (e) { return 'hero'; } })();
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
// Stage 3 Frozen Foundry: built once at load (hidden), so entering it never compiles or allocates mid-run.
// `colliders` is the ACTIVE doc for presentation queries (terrainY etc.) and flips with the arena.
const fordColliders = world.colliders;
const foundryDoc = await (await fetch(ROOT + 'assets/foundry-colliders.json')).json();
const foundryColliders = new Colliders(foundryDoc);
const foundry = new FoundryStage().build({ scene, quality, rng: rootRng, doc: foundryDoc });
scene.add(foundry.root);
// Stage 2 Dusk Shrine: same pattern (built hidden at load, own colliders, own look on the same light slots).
const shrineDoc = await (await fetch(ROOT + 'assets/shrine-colliders.json')).json();
const shrineColliders = new Colliders(shrineDoc);
const shrine = new ShrineStage().build({ scene, quality, rng: rootRng, doc: shrineDoc });
scene.add(shrine.root);
// v2.20 road between bosses: CC-BY Sketchfab kit packed in Blender (tools/road/bl_pack.py), built hidden at load.
// ?road=0 keeps the old direct stage jump (sim never enters ROAD without the road colliders).
const ROAD_ON = qs.get('road') !== '0';
const roadColliders = ROAD_ON ? new Colliders(makeRoadDoc()) : null;
let roadStage = null;
if (ROAD_ON) {
  const roadKit = await new GLTFLoader().loadAsync(ROOT + 'assets/road/road-kit.glb');
  const roadSpire = await new GLTFLoader().loadAsync(ROOT + 'assets/road/spire.glb').catch(() => null);   // v2.22 S5
roadStage = new RoadStage().build({ scene, quality, rng: rootRng.stream('road-art'), kit: roadKit, spire: roadSpire });
  if (roadStage.missing.length) console.warn('road kit nodes missing', roadStage.missing);
}
const arenaRig = { scene, renderer, sun: look.sun, hemi: look.hemi, points: world.lights, slots: foundryDoc.foundry.lightSlots,
  shrineSlots: shrineDoc.shrine.lightSlots, sky: look.sky, envRT: makeFoundryEnvironment(renderer), shrineEnv: makeShrineEnvironment(renderer),
  roadEnv: ROAD_ON ? makeRoadEnvironment(renderer) : null };
const ARENA_COLLIDERS = { ford: fordColliders, shrine: shrineColliders, foundry: foundryColliders, road: roadColliders };
let colliders = fordColliders, arena = 'ford';
var stageFinish = null;   // set once the post stack + rim exist (v2.13 finish)
const STAGE_FILL = { ford: [0xffe2c4, 0.55], shrine: [0xd6d2ff, 0.34], foundry: [0xffe6cc, 0.46], road: [0xffe8d0, 0.42] };
function setArena(name) {
  if (name === arena) return;
  arena = name; const fd = name === 'foundry', sh = name === 'shrine', ford = name === 'ford', rd = name === 'road';
  world.root.visible = ford; if (world.water) world.water.mesh.visible = ford; if (world.props) world.props.group.visible = ford;
  foundry.setVisible(fd); shrine.setVisible(sh); if (roadStage) roadStage.setVisible(rd); colliders = ARENA_COLLIDERS[name];
  cam.colliders = colliders;   // camera clearance must test the active arena (setArena is only called after cam init)
  if (typeof fx !== 'undefined') fx.wet = ford;   // no river splashes on stone or steel
  restoreGorgeLook(arenaRig); for (const L of world.lights) L.position.copy(L.userData.fordPos);
  if (fd) setFoundryLook(arenaRig); else if (sh) setShrineLook(arenaRig); else if (rd) setRoadLook(arenaRig);
  renderer.shadowMap.needsUpdate = true;
  if (stageFinish) stageFinish(name);   // var (not a hoisted function): post/rim do not exist yet during early setArena
}
for (const L of world.lights) L.userData.fordPos = L.position.clone();
progress(0.35);

// ------------------------------------------------------------------ actors
const loader = new GLTFLoader();
const [heroGltf, enemyGltf, bossGltf, bossManifest, timing, heroCombat, heroLunge, gauntletGltf, gauntletManifest, heroAttacks] = await Promise.all([
  // v2.33 character_v233 = v232 with the crotch cloak panel reweighted (skin weights only, mesh/bones/clips identical):
  // great-sword panel stretch 21% -> 8% of edges over 30%. ?cloak=0 loads the v232 weights to compare.
  loader.loadAsync(ROOT + 'characters/hero/out/' + (qs.get('var') === '0' ? 'character_v222.glb' : qs.get('cloak') === '0' ? 'character_v232.glb' : 'character_v233.glb')),   // v2.22 gs set + gs_sweep / gs_sweep_rev / gs_rift; v2.32 adds gs_l1a..gs_l3c
  loader.loadAsync(ROOT + 'characters/enemy/out/character.glb'),
  loader.loadAsync(ROOT + 'characters/boss/wyvern.glb'),
  fetch(ROOT + 'characters/boss/wyvern.manifest.json').then((r) => r.json()),
  fetch(ROOT + 'assets/attack-timing.json').then((r) => r.json()),
  fetch(ROOT + 'motion/mb/hero.combat.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  fetch(ROOT + 'motion/mb/hero.lunge.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  loader.loadAsync(ROOT + 'characters/gauntlet/gauntlet.glb'),
  fetch(ROOT + 'characters/gauntlet/gauntlet.manifest.json').then((r) => r.json()),
  fetch(ROOT + 'motion/mb/hero.v222.attacks.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
]);
// v2.24: Vesper / Kael share the hero's 24-bone skeleton but not its rest pose; the hero clip set is retargeted onto
// their rest (src/game/Retarget.js) so every verb, warp and IK path below runs unchanged. Built here, at rest.
const charGltf = CHAR !== 'hero' ? await loader.loadAsync(ROOT + 'characters/' + CHAR + '/out/character.glb') : null;
const RETARGET = charGltf ? makeRetargeter(heroGltf.scene, charGltf.scene) : null;
// v2.25: generated weapon meshes (?meshwpn=0 keeps the procedural blades)
const MESH_WPN = qs.get('meshwpn') !== '0';
const WPN = MESH_WPN ? await loadWeaponMeshes(loader, ROOT).catch((e) => { console.warn('[wpn]', e); return {}; }) : {};
if (RETARGET) console.info('[char]', CHAR, JSON.stringify(RETARGET.report));
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
// v2.11 great sword clip set (presentation only): with the great sword equipped, LIGHT_1 and HEAVY both play the
// two-handed overhead chop (Meshy 4): LIGHT_1 enters at the overhead peak (f50), HEAVY plays the full raised
// wind-up from f30 (charged vs uncharged chop). Same sim phase lengths as the timing table; only the clip frame
// knots differ. Active = f66-71: blade comes forward at f67 and is forward/down by f69 (gs-review.py side view),
// tip peak 32.3 m/s at f66 (attack-probe.py). Meshy 128 (Heavy_Hammer_Swing) was rejected: the left hand never
// joins the grip and the blade only drives down at f104. Block / parry use Two_Handed_Parry (149).
// v2.12: every great-sword swing is the authored two-handed chop. The v2.12 rig run (Meshy 237/92/199/202/240/85/
// 335/560/550/551) was measured with scan-grip.py and none of those clips keeps both fists together (fist gap < 25 cm
// on <= 3% of frames; Double_Combo_Attack is sword-and-shield), so they are not shipped. Combo variety comes from
// different entry frames plus a per-verb diagonal torso roll (gsCutRoll) that tilts the whole two-handed cut.
const GS_SET = {
  LIGHT_1: { clip: 'gs_overhead', clipF: [[50, 66], [66, 71], [71, 96]], roll: 0 },
  LIGHT_2: { clip: 'gs_overhead', clipF: [[46, 66], [66, 71], [71, 96]], roll: -0.42 },
  LIGHT_3: { clip: 'gs_overhead', clipF: [[36, 66], [66, 72], [72, 104]], roll: 0.38 },
  HEAVY: { clip: 'gs_overhead', clipF: [[30, 66], [66, 72], [72, 104]], roll: 0 },
  // v2.30 (ref #12): WAVE = the chop rolled hard to a flat right-to-left cut (low fan); LEAP = the full raised chop
  // from the ready pose, so the blade wheels over the top during the airborne arc and lands on the first ACTIVE frame.
  WAVE: { clip: 'gs_overhead', clipF: [[24, 66], [66, 71], [71, 104]], roll: 0.95 },
  LEAP: { clip: 'gs_overhead', clipF: [[8, 66], [66, 72], [72, 104]], roll: 0 },
};
// coil verbs: split STARTUP into the long wind-up (coil[2] frames over clip coil[0]->coil[1]) and the fast release
function gsWarpPhases(k, ph) {
  const s = greatPhases(k, ph).map((p, i) => ({ ...p, clipF: GS_SET[k].clipF[i] })), c = GS_COIL[k];
  if (!c) return s;
  return [{ phase: 'COIL', specF: c.coil[2], clipF: [c.coil[0], c.coil[1]] }, { ...s[0], specF: s[0].specF - c.coil[2], clipF: [c.coil[1], s[0].clipF[1]] }].concat(s.slice(1));
}
// great-sword finisher: the full raised chop, blade lands (clip f67) on the boss hit frame (sim f60)
const GS_FINISHER_CLIP = { clip: 'gs_overhead', knots: [[0, 14], [60, 67], [96, 104]] };
// v2.12: the sim stretches every great-sword verb by GREATSWORD.SWING, so the warps use the same stretched phases
// (same clip knots, played slower). WARP_GS covers the verbs that keep their one-hand clip (LIGHT_2/3).
const GS_WARP = {}, WARP_GS = {};
for (const k in timing.verbs) WARP_GS[k] = buildWarp(greatPhases(k, timing.verbs[k].phases));
for (const k in GS_SET) {
  if (HERO_GREAT_X[k]) {   // v2.30 sim-owned great verbs: phases straight from HERO_GREAT_X
    const X = HERO_GREAT_X[k], ph = [{ specF: X.startup }, { specF: X.active }, { specF: X.total - X.startup - X.active }];
    GS_WARP[k] = buildWarp(ph.map((p, i) => ({ ...p, clipF: GS_SET[k].clipF[i] }))); continue;
  }
  const ph = timing.verbs[k] && timing.verbs[k].phases;
  if (!ph || ph.length !== GS_SET[k].clipF.length) { console.warn('great sword clip set skipped (phase mismatch):', k); continue; }
  GS_WARP[k] = buildWarp(gsWarpPhases(k, ph));
}
// v2.32 two-handed light variants, three authored arcs per light verb (see heroLightVar)
const GS_LIGHT_VAR = { LIGHT_1: ['gs_l1a', 'gs_l1b', 'gs_l1c'], LIGHT_2: ['gs_l2a', 'gs_l2b', 'gs_l2c'], LIGHT_3: ['gs_l3a', 'gs_l3b', 'gs_l3c'] };
const GS_GUARD = { clip: 'gs_guard', blockT: 16 / 60, parryT0: 3 / 60 };
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
function pose(actor, n, c0, w0, t0_, c1, w1, t1, c2, w2, t2, c3, w3, t3, c4, w4, t4) {
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
  set(c0, w0, t0_); if (n > 1) set(c1, w1, t1); if (n > 2) set(c2, w2, t2); if (n > 3) set(c3, w3, t3); if (n > 4) set(c4, w4, t4);
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
  return { tip, hilt, socket, blade, inlay, point, guard };
}
// QA helper: tip world position (hero at origin, yaw 0) and speed per clip frame for a given blade rig; also the hilt
// so the caller can read the blade direction. Rows: [f, speed m/s, tipX, tipY, tipZ, hiltX, hiltY, hiltZ].
function tipScanWith(a, clip, blade) {
  const n = Math.floor(a.getClip().duration * 60), out = [], p = new THREE.Vector3(), q = new THREE.Vector3(), h = new THREE.Vector3();
  const r0 = hero.root.position.clone(), y0 = hero.root.rotation.y;
  hero.root.position.set(0, 0, 0); hero.root.rotation.y = 0; hero.root.updateMatrixWorld(true);
  for (let f = 0; f <= n; f++) {
    pose(hero, 1, clip, 1, f / 60); hero.root.updateMatrixWorld(true); blade.tip.getWorldPosition(p); blade.hilt.getWorldPosition(h);
    out.push([f, +(f ? p.distanceTo(q) * 60 : 0).toFixed(2), +p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3), +h.x.toFixed(3), +h.y.toFixed(3), +h.z.toFixed(3)]); q.copy(p);
  }
  hero.root.position.copy(r0); hero.root.rotation.y = y0; hero.root.updateMatrixWorld(true); return out;
}
// v2.19 boss-drop blades: the same great-sword rig (same grip, same left-hand IK target, same programs) re-dressed
// per weapon - blade length follows the sim's REACH delta, colours only (no new maps, so no new program keys).
// len: blade metres; steel/inlay/guard: albedo / emissive colours. Index = HeroSim WEAPON id.
const BLADE_LOOK = [
  null,
  { len: 1.36, width: 1.0, steel: 0xc9ccd2, inlay: 0xff5a1a, guard: 0xb8863b },   // GREAT SWORD
  { len: 1.41, width: 1.18, steel: 0x8c8a86, inlay: 0xff3010, guard: 0x5a2a1c },  // WYVERN FANG: scorched bone-grey, hotter core
  { len: 1.66, width: 0.72, steel: 0xd8dce4, inlay: 0xa070ff, guard: 0x2a1a30 },  // DUSK ODACHI: long thin blade, violet edge
  { len: 1.51, width: 1.05, steel: 0xe4eef8, inlay: 0x58c8ff, guard: 0x8aa0b8 },  // FROSTBRAND: chrome, ice-blue core
];
function dressGreatSword(s, w, steelMat, inlayMat, guardMat) {
  const L = BLADE_LOOK[w] || BLADE_LOOK[1], k = L.len / 1.36;
  s.blade.scale.set(L.width, k, 1); s.blade.position.y = 0.12 + 0.68 * k;
  s.inlay.scale.set(1, k, 1); s.inlay.position.y = 0.12 + 0.64 * k;
  s.point.position.y = 0.12 + 1.48 * k; s.point.scale.x = L.width; s.tip.position.y = 0.12 + 1.48 * k;
  if (steelMat) steelMat.color.setHex(L.steel);
  if (inlayMat) inlayMat.emissive.setHex(L.inlay);
  if (guardMat) guardMat.color.setHex(L.guard);
  showGen(s, w);
}
// v2.25 generated meshes on the great-sword rig: one fitted mesh per boss blade, the matching one shown, tip moved to
// the mesh's real tip. The procedural parts stay in the socket (hidden) as the ?meshwpn=0 fallback.
const GEN_GREAT = ['', 'great_sword', 'wyvern_fang', 'dusk_odachi', 'frostbrand'];
const genMats = { hero: [] };
function genMat(id, owner) {
  const W = WPN[id]; if (!W) return null;
  const m = W.mat.clone(); m.emissive = new THREE.Color(0, 0, 0);
  if (owner === 'hero') genMats.hero.push(m);
  return m;
}
function addGenGreat(rig, owner) {
  if (!MESH_WPN) return;
  rig.gen = {};
  for (let w = 1; w < GEN_GREAT.length; w++) {
    const W = WPN[GEN_GREAT[w]]; if (!W) continue;
    const f = fitWeapon(W, genMat(GEN_GREAT[w], owner)); f.mesh.visible = false; rig.socket.add(f.mesh); rig.gen[w] = f;
  }
  if (Object.keys(rig.gen).length) for (const c of [rig.blade, rig.inlay, rig.point, rig.guard]) c.visible = false;
  else rig.gen = null;
}
function showGen(rig, w) {
  if (!rig.gen) return;
  const f = rig.gen[w] || rig.gen[1];
  for (const k in rig.gen) rig.gen[k].mesh.visible = rig.gen[k] === f;
  if (f) rig.tip.position.set(f.tipX, f.tipY, f.tipZ);
}
function dressGen(rig, id, owner) {
  if (!MESH_WPN || !WPN[id]) return null;
  return dressRig(rig, WPN[id], genMat(id, owner));
}

// v2.24 Cinder Sabre (Vesper): slim curved one-hander, 0.92 m (standard blade +0.2 m = CHARACTERS.vesper.one.REACH),
// ember edge along the cutting side, crescent guard. Curve = 4 stacked segments with increasing tilt (shared geo).
// Same steel / brass / emberInlay programs as the other blades, so no new program keys.
const sabreSegGeo = new THREE.BoxGeometry(0.052, 0.24, 0.008), sabreEdgeGeo = new THREE.BoxGeometry(0.012, 0.24, 0.011);
const sabreGuardGeo = new THREE.TorusGeometry(0.06, 0.012, 5, 10, Math.PI), sabreGripGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.15, 8);
function addSabre(bone, s) {
  const socket = new THREE.Group();
  socket.position.fromArray(s.position); socket.quaternion.fromArray(s.quaternion); socket.scale.setScalar(s.scale);
  bone.add(socket);
  const edgeMat = emberInlay.clone();   // own clone: the charge glow pulses it, never the drop / pickup inlays
  const parts = [];
  let y = 0.11, x = 0, a = 0;
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Group(); seg.position.set(x, y, 0); seg.rotation.z = a;
    const b = new THREE.Mesh(sabreSegGeo, heroSteel); b.position.y = 0.12; b.scale.x = 1 - i * 0.16;   // tapers to the point
    const e = new THREE.Mesh(sabreEdgeGeo, edgeMat); e.position.set(0.026 * (1 - i * 0.16), 0.12, 0);
    seg.add(b, e); socket.add(seg); parts.push(b, e);
    y += 0.235 * Math.cos(a); x -= 0.235 * Math.sin(a); a += 0.13;
  }
  const guard = new THREE.Mesh(sabreGuardGeo, brass); guard.position.y = 0.1; guard.rotation.z = Math.PI;
  const grip = new THREE.Mesh(sabreGripGeo, leather); grip.position.y = 0.02;
  for (const m of [...parts, guard, grip]) m.castShadow = true;
  socket.add(guard, grip);
  const tip = new THREE.Object3D(); tip.position.set(x, y, 0); socket.add(tip);
  const hilt = new THREE.Object3D(); hilt.position.y = 0.09; socket.add(hilt);
  return { tip, hilt, socket, edgeMat };
}
// v2.24 Astral Glaive (Kael): 2.3 m polearm - long dark-steel shaft with a two-hand grip below the hand, a broad
// crescent head with an indigo ember core, butt spike. Blade length matches WEAPONS[5].REACH (great sword +0.4 m).
const glShaftGeo = new THREE.CylinderGeometry(0.022, 0.026, 1.7, 8), glHeadGeo = new THREE.BoxGeometry(0.17, 0.6, 0.03);
const glCoreGeo = new THREE.BoxGeometry(0.04, 0.5, 0.036), glTipGeo = new THREE.ConeGeometry(0.12, 0.26, 4);
const glCollarGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.08, 8), glButtGeo = new THREE.ConeGeometry(0.03, 0.14, 6);
const glCrescentGeo = (() => {   // 2D outline in the socket XY plane (blade along +Y), extruded 2.6 cm
  const s = new THREE.Shape(); s.moveTo(-0.02, 0); s.lineTo(0.03, 0);
  s.bezierCurveTo(0.26, 0.2, 0.28, 0.62, 0.05, 0.9);      // convex cutting edge out to the point
  s.bezierCurveTo(0.1, 0.6, 0.04, 0.28, -0.02, 0.1);      // concave spine back to the socket
  s.lineTo(-0.02, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1, curveSegments: 10 });
  g.translate(0, 0, -0.013); return g;
})();
const glShaftMat = new THREE.MeshStandardMaterial({ color: 0x23262e, metalness: 1, roughness: 0.42 });
function addGlaive(bone, s) {
  const socket = new THREE.Group();
  socket.position.fromArray(s.position); socket.quaternion.fromArray(s.quaternion); socket.scale.setScalar(s.scale);
  bone.add(socket);
  const coreMat = emberInlay.clone(); coreMat.emissive.setHex(0x6a7dff);
  const glSteel = heroSteel.clone(); glSteel.color.setHex(0xd6dbe6);
  const shaft = new THREE.Mesh(glShaftGeo, glShaftMat); shaft.position.y = 0.45;
  const grip = new THREE.Mesh(gsGripGeo, leather); grip.position.y = -0.08;
  const collar = new THREE.Mesh(glCollarGeo, brass); collar.position.y = 1.3;
  // crescent head: one extruded single-edged blade (convex cutting edge, concave spine), indigo core inset, spur hook
  const head = new THREE.Mesh(glCrescentGeo, glSteel); head.position.set(0, 1.32, 0);
  const core = new THREE.Mesh(glCrescentGeo, coreMat); core.position.set(0.012, 1.36, 0); core.scale.set(0.32, 0.72, 1.12);
  const point = new THREE.Object3D();
  const spur = new THREE.Mesh(glTipGeo, glShaftMat); spur.position.set(-0.07, 1.42, 0); spur.rotation.z = 1.9; spur.scale.set(0.5, 0.6, 0.2);
  const butt = new THREE.Mesh(glButtGeo, brass); butt.position.y = -0.47; butt.rotation.x = Math.PI;
  for (const m of [shaft, grip, collar, head, core, spur, butt]) { m.castShadow = true; socket.add(m); }
  socket.visible = false;
  const tip = new THREE.Object3D(); tip.position.set(0.05, 2.22, 0); socket.add(tip);
  const hilt = new THREE.Object3D(); hilt.position.y = 0.12; socket.add(hilt);
  return { tip, hilt, socket, coreMat };
}

// hero: pivot PI faces engine -Z
pinHips(heroGltf); pinHips(enemyGltf);
const hero = { root: new THREE.Group(), pivot: new THREE.Group(), model: charGltf ? charGltf.scene : heroGltf.scene, fallback: 'idle' };
hero.pivot.rotation.y = Math.PI; hero.root.add(hero.pivot); hero.pivot.add(hero.model); scene.add(hero.root);
const heroBones = prepModel(hero.model);
// v2.37: rest (bind) leg pose, captured before any clip is applied. The air body layer blends the legs to it and
// then tucks, so every air cut shares one jump silhouette instead of the stance of the standing clip it borrows.
const AIR_LEGS = ['LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'];
const airLegRest = AIR_LEGS.map((n) => (heroBones[n] ? heroBones[n].quaternion.clone() : null));
const _alA = new THREE.Vector3(), _alB = new THREE.Vector3();
const HERO_STATE_NAMES_QA = {};
const AIR_AXIS_SIGN = 1;   // right hip - left hip = the body's right axis (airProbe checks it against the sim right in idle)
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
// v2.12 great-sword carry: arms-only static pose sampled from the authored two-handed low-ready (gs_overhead f0).
// Layered over idle/walk/run with a dominant weight while the great sword is equipped, so the legs keep the
// phase-locked locomotion and both hands stay on the grip. Presentation only.
// Spine bones come along too: the idle/run torso twists the right shoulder forward and leaves the hilt 0.85 m from
// the left shoulder (reach is 0.58 m), so the carry takes the authored two-handed chest as well; hips and legs stay loco.
const CARRY_BONES = ['Spine02', 'Spine01', 'Spine', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'];
// v2.30 (ref #12): gs_drag = the same arms+chest taken from the gs_rift settle (f77: clip tip ~0.4 m off the floor, blade
// out to the right and ~5 deg behind, both hands on the grip; f73 at 0.18 m sank under the floor on the walk bob). Locomotion blends ready -> drag with move speed, and the
// last GS_HOLD_F frames of great-sword recoveries ease into it (recovery hold). Measured: qa/game/probe-gs-low.json.
const GS_DRAG = { clip: 'gs_rift', f: 77 };
function staticArmClip(name, srcName, f) {
  const src = heroGltf.animations.find((c) => c.name === srcName); if (!src) return;
  const tracks = [];
  for (const b of CARRY_BONES) {
    const t = src.tracks.find((k) => k.name === b + '.quaternion'); if (!t) continue;
    const q = t.createInterpolant().evaluate(f / 60);
    tracks.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', [0, 1], [q[0], q[1], q[2], q[3], q[0], q[1], q[2], q[3]]));
  }
  if (tracks.length === CARRY_BONES.length) mbClips.push(new THREE.AnimationClip(name, 1, tracks));
  else console.warn(name + ' dropped (unresolved arm tracks):', tracks.length);
}
staticArmClip('gs_carry', 'gs_overhead', 0);
staticArmClip('gs_drag', GS_DRAG.clip, GS_DRAG.f);
// One continuous carry track avoids PropertyMixer changing quaternion blend
// hemispheres as two dominant static arm layers exchange their weights.
{
  const ready = mbClips.find((c) => c.name === 'gs_carry');
  const drag = mbClips.find((c) => c.name === 'gs_drag');
  if (ready && drag) {
    const tracks = ready.tracks.map((t) => {
      const d = drag.tracks.find((k) => k.name === t.name);
      return new THREE.QuaternionKeyframeTrack(t.name, [0, 1], [...t.values.slice(0, 4), ...d.values.slice(0, 4)]);
    });
    mbClips.push(new THREE.AnimationClip('gs_carry_move', 1, tracks));
  }
}
// v2.22 layered attacks (MotionBricks contact-IK lower body + Blender-authored two-handed upper body), full skeleton
// at 60 Hz. Hips.position carries the bake's vertical only (rootXZ is applied by the sim via src/shared/attackFoot.js,
// so the bones carry no XZ travel). Every track must resolve, else the clip is dropped and the verb uses its gs_* clip.
const AT_OK = {};
// v2.27 dance set (one-handed combo steps): same layered format, merged into the attack clip table
const DANCE_ON = qs.get('dance') !== '0';
// v2.29: the dance strikes use Gemini Omni 1.2 video mocap for the torso and arms over the same MotionBricks footwork
// (tools/video/layer_video.py). ?mocap=0 plays the previous authored arcs.
const MOCAP_ON = qs.get('mocap') !== '0';
const heroDance = DANCE_ON ? await fetch(ROOT + (MOCAP_ON ? 'motion/mb/hero.dance.attacks.video.json' : 'motion/mb/hero.dance.attacks.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
if (heroDance && heroDance.clips && heroAttacks && heroAttacks.clips) Object.assign(heroAttacks.clips, heroDance.clips);
// v2.32 variants: a repeated light never replays its last animation. Two-handers cycle three authored arcs per light
// (tools/blender/author_v232.py, 1:1 with the sim frame data); the dance lights alternate with a second sword arc
// over the same footwork (tools/mb/run_dance_var.ps1). ?var=0 restores v2.31 (one animation per verb).
const VAR_ON = qs.get('var') !== '0';
const heroDanceVar = VAR_ON && heroDance ? await fetch(ROOT + 'motion/mb/hero.dance.attacks.var.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
if (heroDanceVar && heroDanceVar.clips && heroDance) { Object.assign(heroAttacks.clips, heroDanceVar.clips); Object.assign(heroDance.clips, heroDanceVar.clips); }
// v2.38 QUICK standing string: new authored arcs over the dance footwork (tools/mb/run_dance_quick.ps1)
const QUICK_ON = qs.get('quick') !== '0';
const heroDanceQuick = QUICK_ON && heroDance ? await fetch(ROOT + 'motion/mb/hero.dance.attacks.quick.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
if (heroDanceQuick && heroDanceQuick.clips && heroDance) { Object.assign(heroAttacks.clips, heroDanceQuick.clips); Object.assign(heroDance.clips, heroDanceQuick.clips); }
// v2.39 great sword light string on its own weighted MotionBricks footwork (tools/mb/run_great_layer.ps1): gl_1a..gl_3c
// = gf_1..gf_3 lower body + the v2.32 two-handed arcs. ?gfoot=0 restores v2.38 (arcs over the flat lunge slide).
const GFOOT_ON = qs.get('gfoot') !== '0';
const heroGreatFoot = GFOOT_ON && heroAttacks && heroAttacks.clips ? await fetch(ROOT + 'motion/mb/hero.great.attacks.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
if (heroGreatFoot && heroGreatFoot.clips) Object.assign(heroAttacks.clips, heroGreatFoot.clips);
const GREAT_FOOT_CLIPS = heroGreatFoot && heroGreatFoot.clips ? Object.keys(heroGreatFoot.clips) : [];
const DANCE_CLIPS = heroDance && heroDance.clips ? Object.keys(heroDance.clips) : [];
if (heroAttacks && heroAttacks.clips) {
  const bn = {}; heroGltf.scene.traverse((o) => { if (o.isBone) bn[o.name] = o; });
  for (const name in heroAttacks.clips) {
    const c = heroAttacks.clips[name], F = c.frames, fps = c.fps || 60;
    const times = Float32Array.from({ length: F }, (_, i) => i / fps), tracks = [];
    let bad = 0;
    for (const b in c.tracks) {
      if (!bn[b]) { bad++; continue; }
      // Remove single-frame capture/retarget kinks in dance upper bodies at
      // load time only. The contact-IK hips, feet and sim root stay untouched.
      const soften = qs.get('feel') !== '0' && DANCE_CLIPS.includes(name) && b !== 'Hips' && !LUNGE_BONES.includes(b);
      tracks.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', times, soften ? gaussQuat(c.tracks[b], F, 1.2) : c.tracks[b]));
    }
    if (c.hipsPos) tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, c.hipsPos));   // XZ already 0 in the bake
    if (bad || !bn.Hips) { console.warn('v222 attack clip dropped (unresolved tracks):', name, bad); continue; }
    mbClips.push(new THREE.AnimationClip(name, (F - 1) / fps, tracks)); AT_OK[name] = (F - 1) / fps;
  }
}
const HERO_CLIPS = RETARGET ? RETARGET.clips(heroGltf.animations.concat(mbClips)) : heroGltf.animations.concat(mbClips);
makeActions(hero, HERO_CLIPS); markLoops(hero);
// C15 inertialization: every clip switch decays the old pose into the new one (presentation only, ?inert=0 disables)
const INERT_ON = qs.get('inert') !== '0';
const INERT_MODE = qs.get('inert') === 'decay' ? 'decay' : 'spring';
const INERT_HL = +(qs.get('ihl') || 0.6);
hero.inert = new Inertializer(hero.model, HERO_CLIPS); hero.inert.enabled = INERT_ON; hero.inert.mode = INERT_MODE; hero.inert.hlScale = INERT_HL;
if (qs.get('plant') !== '0') hero.inert.setPlant(['at_sweep', 'at_sweep_rev', 'at_rift_plant'].concat(DANCE_CLIPS, GREAT_FOOT_CLIPS),
  ['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']);
const HERO_SOCKET0 = { position: [-0.3366, 7.6967, -1.1561], quaternion: [0.00031, 0.23882, 0.6183, 0.74878], scale: 100 };
const HERO_SOCKET = RETARGET ? RETARGET.socket(HERO_SOCKET0) : HERO_SOCKET0;
const heroSwordStd = addSword(heroBones.RightHand, HERO_SOCKET, heroSteel);
const heroGreat = addGreatSword(heroBones.RightHand, HERO_SOCKET, heroSteel); heroGreat.socket.visible = false;
let heroSword = heroSwordStd;
// v2.24 signature weapons: Vesper's Cinder Sabre replaces the standard blade, Kael's Astral Glaive the two-hander.
const heroSabre = CHAR === 'vesper' ? addSabre(heroBones.RightHand, HERO_SOCKET) : null;
const heroGlaive = CHAR === 'kael' ? addGlaive(heroBones.RightHand, HERO_SOCKET) : null;
if (heroSabre) { heroSwordStd.socket.visible = false; heroSword = heroSabre; }
// v2.25 generated meshes: hero blade, every boss blade on the two-hander, Vesper's sabre, Kael's glaive
dressGen(heroSwordStd, 'ember_sword', 'hero'); addGenGreat(heroGreat, 'hero');
if (heroSabre) dressGen(heroSabre, 'cinder_sabre', 'hero');
if (heroGlaive) dressGen(heroGlaive, 'astral_glaive', 'hero');
// hero two-hander gets its own inlay + guard materials (same program keys as emberInlay / brass) so the pickup
// pulse and the boss-drop colours never bleed into each other
const heroInlay = emberInlay.clone(), heroGuard = brass.clone();
heroGreat.inlay.material = heroInlay; heroGreat.guard.material = heroGuard;
function setHeroWeapon(w) {
  const one = heroSabre || heroSwordStd, two = w === 5 && heroGlaive ? heroGlaive : heroGreat;
  heroSword = w >= 1 ? two : one;
  heroSwordStd.socket.visible = w < 1 && !heroSabre; if (heroSabre) heroSabre.socket.visible = w < 1;
  heroGreat.socket.visible = w >= 1 && two === heroGreat; if (heroGlaive) heroGlaive.socket.visible = w >= 1 && two === heroGlaive;
  if (two === heroGreat) dressGreatSword(heroGreat, w >= 1 ? w : 1, heroSteel, heroInlay, heroGuard);
}
// v2.19 boss drop in the world: a second great-sword rig planted blade-down at sim.drop, own materials, no light.
const dropRoot = new THREE.Group(); dropRoot.visible = false; scene.add(dropRoot);
const dropSteel = steel.clone(), dropInlay = emberInlay.clone(), dropGuard = brass.clone();
const dropSword = addGreatSword(dropRoot, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, dropSteel);
dropSword.inlay.material = dropInlay; dropSword.guard.material = dropGuard;
dropSword.socket.rotation.set(Math.PI - 0.1, 0.4, -0.06); addGenGreat(dropSword, 'drop');
const dropGlow = { t: 0, ping: -1, w: 0 };
// planted pickup: the same great sword, blade down in the ford beside the wyvern's landing, with a pulsing ember
// column so it reads from the hero spawn. No light (constant light count); additive basic material only.
const pickupRoot = new THREE.Group(); pickupRoot.visible = false; scene.add(pickupRoot);
const pickupSword = addGreatSword(pickupRoot, { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: 1 }, steel);
pickupSword.socket.rotation.set(Math.PI + 0.14, 0.6, 0.08); addGenGreat(pickupSword, 'pickup'); showGen(pickupSword, 1);
const pickupBeamMat = new THREE.MeshBasicMaterial({ color: 0xff7a30, transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
// v2.17c: vertical fade baked into vertex colours (additive, so black = no light): bright at the sword, gone by the
// top. A uniform-opacity open cylinder read as a hard orange slab in the wyvern frames
// v2.17d: a cylinder silhouette is always a hard vertical line, so the beam is now 3 crossed planes faded to black
// at both sides as well as the top (soft from every view angle). Same MeshBasicMaterial, same program.
const pickupBeamGeo = (() => {
  const parts = [];
  for (let j = 0; j < 3; j++) {
    const g = new THREE.PlaneGeometry(1.3, 7, 6, 8); g.rotateY(j * Math.PI / 3);
    const P = g.attributes.position, C = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      const t = (P.getY(i) + 3.5) / 7, side = Math.hypot(P.getX(i), P.getZ(i)) / 0.65;
      const k = Math.pow(Math.max(0, 1 - t), 1.6) * Math.min(1, t * 8 + 0.3) * Math.pow(Math.max(0, 1 - side), 1.5);
      C[i * 3] = C[i * 3 + 1] = C[i * 3 + 2] = k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(C, 3)); parts.push(g);
  }
  const out = new THREE.BufferGeometry(); let n = 0; for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), idx = []; let o = 0;
  for (const g of parts) { pos.set(g.attributes.position.array, o * 3); col.set(g.attributes.color.array, o * 3); for (const v of g.index.array) idx.push(v + o); o += g.attributes.position.count; g.dispose(); }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('color', new THREE.BufferAttribute(col, 3)); out.setIndex(idx);
  pickupBeamMat.vertexColors = true; return out;
})();
const pickupBeam = new THREE.Mesh(pickupBeamGeo, pickupBeamMat); pickupBeam.position.y = 2.2; pickupRoot.add(pickupBeam);
const pickupGlow = { t: 0, ping: -1 };
const dropBeamMat = pickupBeamMat.clone();
const dropBeam = new THREE.Mesh(pickupBeamGeo, dropBeamMat); dropBeam.position.y = 2.2; dropRoot.add(dropBeam);
// fist centres in hand-bone space: centroid of the bind-pose vertices skinned mostly to each hand bone
const FIST = { L: new THREE.Vector3(), R: new THREE.Vector3() };
{
  let sk = null; hero.model.traverse((o) => { if (!sk && o.isSkinnedMesh) sk = o; });
  if (sk) {
    const bones = sk.skeleton.bones, pos = sk.geometry.attributes.position, si = sk.geometry.attributes.skinIndex, sw = sk.geometry.attributes.skinWeight;
    const v = new THREE.Vector3();
    for (const [side, key] of [['LeftHand', 'L'], ['RightHand', 'R']]) {
      const bi = bones.findIndex((b) => b.name === side); if (bi < 0) continue;
      let n = 0; const acc = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        let w = 0; for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === bi) w += sw.getComponent(i, k);
        if (w < 0.6) continue;
        v.fromBufferAttribute(pos, i).applyMatrix4(sk.bindMatrix).applyMatrix4(sk.skeleton.boneInverses[bi]); acc.add(v); n++;
      }
      if (n) FIST[key].copy(acc.multiplyScalar(1 / n));
    }
  }
}
// v2.12 two-hand grip: where the left hand sits on the great sword (socket-local position + rotation), measured
// once from the authored two-handed hold (gs_overhead f0). leftGripIK() pins the left hand there every frame.
const GRIP = { on: false, p: new THREE.Vector3(), q: new THREE.Quaternion(), w: 0, n: 0, far: 0, err: 0, errMax: 0 };
if (hero.actions.gs_overhead && heroBones.LeftHand && heroBones.LeftArm && heroBones.LeftForeArm) {
  const qs_ = new THREE.Quaternion(), ql = new THREE.Quaternion(), pw = new THREE.Vector3();
  pose(hero, 1, 'gs_overhead', 1, 0); hero.model.updateMatrixWorld(true);
  heroBones.LeftHand.getWorldPosition(pw); GRIP.p.copy(heroGreat.socket.worldToLocal(pw)); GRIP.auth = GRIP.p.toArray();
  heroBones.RightHand.getWorldPosition(pw); GRIP.r = heroGreat.socket.worldToLocal(pw).toArray();
  heroGreat.socket.getWorldQuaternion(qs_); heroBones.LeftHand.getWorldQuaternion(ql);
  GRIP.q.copy(qs_).invert().multiply(ql); GRIP.on = true;
  // left fist target: the authored left FIST on the hilt in the two-handed hold (reachable by construction)
  pw.copy(FIST.L).applyMatrix4(heroBones.LeftHand.matrixWorld); GRIP.fist = heroGreat.socket.worldToLocal(pw).clone();
  pose(hero, 1, 'idle', 1, 0);
}
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
  s.sword = addSword(bones.RightHand, ENEMY_SOCKET); s.bones = bones;
  if (MESH_WPN && WPN.ember_sword) dressRig(s.sword, WPN.ember_sword);   // shared material, same program
  s.root.visible = false;
  slots.push(s);
}
// Stage 2 Shadow Warden: slot 0 restyled while he is bound (scale x1.12, ink-dark tint). Materials are cloned once
// per slot here so the tint never leaks to the shared wave duelist materials; colour change is a uniform, no recompile.
// QA frame review: an ink-dark warden vanished against the dusk stone, so he reads as pale ash with a faint cold
// emissive lift instead (emissive colour is a uniform on the standard material - no new program).
// v2.13 A/B: a mid-ash retint (0.80,0.76,0.88) sank him into the pillar shadow bands - pale ash stays.
const wardenTint = new THREE.Color(1.05, 1.0, 1.12), wardenGlow = new THREE.Color(0.035, 0.045, 0.08);
// ?wglow=r,g,b (recording only): stronger cold emissive so the pale warden reads as a deliberate spectral boss against
// the orange dusk instead of an untextured grey figure (ad-cut review). Uniform only - same programs.
if (qs.get('rec') === '1' && qs.get('wglow')) { const g = qs.get('wglow').split(',').map(Number); if (g.length === 3 && g.every(Number.isFinite)) wardenGlow.setRGB(g[0], g[1], g[2]); }
const slot0Mats = [];
slots[0].model.traverse((o) => { if (o.isMesh && o.material && o.material.color) { o.material = o.material.clone(); slot0Mats.push({ m: o.material, base: o.material.color.clone(), em: o.material.emissive ? o.material.emissive.clone() : null }); } });
function styleWarden(on) {
  const s = slots[0]; s.root.scale.setScalar(on ? WARDEN.SCALE : 1);
  for (const e of slot0Mats) {
    e.m.color.copy(e.base); if (on) e.m.color.multiply(wardenTint);
    if (e.em) { e.m.emissive.copy(e.em); if (on) e.m.emissive.add(wardenGlow); }
  }
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

// Stage 3 boss (Chrome Gauntlet): built at load, hidden; GauntletView owns pose, blades and hazard meshes
const gview = new GauntletView().build({ gltf: gauntletGltf, scene, Inertializer, inertOpts: { enabled: INERT_ON, mode: INERT_MODE, hlScale: INERT_HL } });
const gstat = { prevState: -1, prevPhase: 1, finHit: false, wasFin: false };
function gauntletBlend(nc) { return nc === 'g_rest' ? 0.14 : nc === 'g_swipe' || nc === 'g_pounce' ? 0.1 : 0.2; }

// v2.31 hero contact shadow. The sun shadow is a soft overcast penumbra (radius 4), so the hero had no readable
// ground contact and the leap wheel read as grounded. An unlit soft blob under the feet: depthWrite off, no shadow
// cast, never toggled during play (compiled by the prewarm, no lit-program or light-count change). It shrinks and
// fades with the lower foot's height, so airborne frames separate from the floor on screen. ?blob=0 disables it.
const BLOB_ON = qs.get('blob') !== '0';
// v2.31b: base 0.55 -> 0.85 and a denser core; A/B measured only a 6% luminance drop at 0.55 because the spot already
// sits in the sun-shadow of the gorge wall. Height follows walkable tops (groundY) so the disc is not buried under planks.
const BLOB = Object.freeze({ footRest: 0.12, liftFull: 1.0, base: 0.85, fadeAir: 0.6, shrinkAir: 0.35, rMin: 0.40, rSpread: 0.35, spreadCap: 0.8, lift: 0.03 });
const heroBlob = (() => {
  const N = 64, d = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1, r = Math.min(1, Math.sqrt(x * x + y * y));
    d[(j * N + i) * 4 + 3] = Math.round(255 * Math.pow(1 - r * r, 1.1));   // dense core, soft edge, 0 at the rim
  }
  const tex = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, map: tex, transparent: true, opacity: BLOB.base, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat); mesh.name = 'heroBlob'; mesh.renderOrder = 1; mesh.frustumCulled = false;
  mesh.castShadow = false; mesh.receiveShadow = false; mesh.visible = BLOB_ON; scene.add(mesh);
  return { mesh, mat, tex, geo, lift: 0, r: 0, a: 0 };
})();
const _blL = new THREE.Vector3(), _blR = new THREE.Vector3(), _blH = new THREE.Vector3();
// Render-surface probe: plank meshes sit up to 12 cm above the collider terrain (measured plank_25 top 0.34 vs
// terrainY 0.22), which buried half the disc. One downward ray per frame against plank meshes only; scratch reused.
const _blRay = new THREE.Raycaster(), _blHits = [], _blOrig = new THREE.Vector3(), _blDown = new THREE.Vector3(0, -1, 0);
let _blPlanks = null;
function blobPlankTop(x, z, footY) {
  if (!_blPlanks) { _blPlanks = []; scene.traverse((o) => { if (o.isMesh && /^plank/.test(o.name)) _blPlanks.push(o); }); }
  if (!_blPlanks.length) return -Infinity;
  _blOrig.set(x, footY + 0.6, z); _blRay.set(_blOrig, _blDown); _blRay.far = 1.2; _blHits.length = 0;
  _blRay.intersectObjects(_blPlanks, false, _blHits);
  for (let i = 0; i < _blHits.length; i++) if (_blHits[i].object.visible) return _blHits[i].point.y;
  return -Infinity;
}
function heroBlobLayer() {
  if (!BLOB_ON) return;
  const B = heroBlob, Lf = heroBones.LeftFoot, Rf = heroBones.RightFoot, Hp = heroBones.Hips;
  let cx = hero.root.position.x, cz = hero.root.position.z, spread = 0, lift = 0;
  if (Lf && Rf) {
    Lf.getWorldPosition(_blL); Rf.getWorldPosition(_blR);
    cx = (_blL.x + _blR.x) * 0.5; cz = (_blL.z + _blR.z) * 0.5;
    if (Hp) { Hp.getWorldPosition(_blH); cx = cx * 0.6 + _blH.x * 0.4; cz = cz * 0.6 + _blH.z * 0.4; }
    spread = Math.hypot(_blL.x - _blR.x, _blL.z - _blR.z);
  }
  // presentation-only ground probe: snapshot colliders.hit so gameplay readers never see the blob's query
  const h = colliders.hit, hs = h.surface, hy = h.y;
  const gy0 = colliders.groundY(cx, cz, hero.root.position.y + 0.3);
  h.surface = hs; h.y = hy;
  const gy = Math.max(gy0, blobPlankTop(cx, cz, gy0));
  if (Lf && Rf) { B.raw = Math.min(_blL.y, _blR.y) - gy - BLOB.footRest; lift = Math.max(0, B.raw); }
  const t = Math.min(1, lift / BLOB.liftFull);
  const r = (BLOB.rMin + BLOB.rSpread * Math.min(spread, BLOB.spreadCap)) * (1 - BLOB.shrinkAir * t);
  B.mesh.visible = hero.root.visible && hero.model.visible && !B.qaHide;
  B.mesh.position.set(cx, gy + BLOB.lift, cz);
  B.mesh.scale.set(r * 2, 1, r * 2);
  B.mat.opacity = BLOB.base * (1 - BLOB.fadeAir * t);
  B.lift = lift; B.r = r; B.a = B.mat.opacity;
}

// every light also on layer 1 (kept from S6 so the boss mask pass sees the same light set)
scene.traverse((o) => { if (o.isLight) o.layers.enable(1); });

// ------------------------------------------------------------------ presentation systems
const fx = new FxPool();
fx.init(ctx, { scene, quality, water: world.water, reducedMotion, rng: rootRng.stream('fx') });
fx.setViewportHeight(renderer.domElement.height);
fx.registerAfterimages(HERO_ID, hero.root);
fx.registerAfterimages(BOSS_ID, boss.root);

// v2.13 finish: post chain (bloom + per-stage grade), stage atmosphere motes, character rim light.
// All three only move uniforms when the stage changes; programs are built by the prewarm below.
const post = new PostStack(renderer, scene, camera, quality, { enabled: qs.get('post') !== 'off' });
const motesRng = rootRng.stream('motes');
const motes = { shrine: new AmbientMotes('shrine', { rng: motesRng, quality, reducedMotion }),
  foundry: new AmbientMotes('foundry', { rng: motesRng, quality, reducedMotion }),
  road: new AmbientMotes('road', { rng: motesRng, quality, reducedMotion }) };
shrine.root.add(motes.shrine.points); foundry.root.add(motes.foundry.points);
if (roadStage) roadStage.root.add(motes.road.points);
for (const k in motes) motes[k].setViewportHeight(renderer.domElement.height);
const TRAILER_LOOK = qs.get('rec') === '1' && qs.get('trailer') === '1';
const TRL_FOG = +(qs.get('fogs') || 0.55); let trlFogSet = -1;
const heroRim = makeRimUniform(), foeRim = makeRimUniform();
const RIM_ON = qs.get('rim') !== '0';
if (RIM_ON) { addRimToModel(hero.model, heroRim); for (const s of slots) addRimToModel(s.model, foeRim); }
// ?brim=<gain> (ad takes): warm sun-side rim on the wyvern so its silhouette lifts off the dusk walls. Same shared
// 'rim' program as the hero, attached before the prewarm, so no new variant appears mid-play.
const BOSS_RIM = +(qs.get('brim') || 0);
if (RIM_ON && BOSS_RIM > 0) { const bossRim = makeRimUniform(); addRimToModel(boss.model, bossRim); bossRim.value.setRGB(1.0 * BOSS_RIM, 0.46 * BOSS_RIM, 0.16 * BOSS_RIM); }
stageFinish = function applyStageFinish(name) {
  post.setStage(name);
  const R = STAGE_RIM[name] || STAGE_RIM.ford;
  heroRim.value.setRGB(R.hero[0], R.hero[1], R.hero[2]); foeRim.value.setRGB(R.foe[0], R.foe[1], R.foe[2]);
  // ?frimk=K (promo recording only): scale the foe rim so bosses carry a glowing spectral edge; uniform only
  if (TRAILER_LOOK && qs.get('frimk')) foeRim.value.multiplyScalar(Math.max(0, +qs.get('frimk') || 1));
  // art review: the warm camera fill flattened the dusk duel - cooler and weaker there so the rim carries separation
  const F = STAGE_FILL[name] || STAGE_FILL.ford; camFill.color.setHex(F[0]); camFill.intensity = F[1];
  if (TRAILER_LOOK && post.enabled) {
    // promo grade (?trailer=1): more contrast and saturation, warm highlights over cool shadows, heavier vignette.
    // Uniforms only - no program changes. Gameplay builds never take this path.
    const u = post.grade.uniforms;
    u.uSat.value *= 1.16; u.uContrast.value *= 1.12;
    u.uShadow.value.x += 0.000; u.uShadow.value.y += 0.004; u.uShadow.value.z += 0.016;
    u.uHigh.value.x += 0.030; u.uHigh.value.y += 0.012; u.uHigh.value.z -= 0.010;
    u.uVig.value.x = Math.min(0.6, u.uVig.value.x + 0.14);
    post.bloom.strength *= 1.25;
    // v2.26: hue keep - hot strikes stay coloured instead of clipping to white under AgX (?keep=0 disables)
    u.uKeep.value.set(+(qs.get('knee') || 1.2), +(qs.get('keep') || 0.85), 0.6);
    // QA t7: the overcast ford read flat grey in the promo; extra punch there only (warm high, teal low)
    if (name === 'ford') {
      // ?dusk=1 (ad takes): low warm sun under a darkening sky instead of the grey overcast - colours only, the
      // same lights and programs, so nothing recompiles; restoreGorgeLook resets it on the next arena change
      if (qs.get('dusk') === '1') {
        const D = { sun: [1.0, 0.58, 0.32], hz: [0.34, 0.15, 0.075], zn: [0.035, 0.04, 0.085] };
        look.sun.color.setRGB(D.sun[0], D.sun[1], D.sun[2]); look.sun.intensity *= +(qs.get('dsun') || 1.12);
        look.hemi.color.setRGB(0.48, 0.46, 0.66); look.hemi.groundColor.setRGB(0.09, 0.045, 0.03);
        const su = look.sky.material.uniforms; su.uH.value.setRGB(D.hz[0], D.hz[1], D.hz[2]); su.uZ.value.setRGB(D.zn[0], D.zn[1], D.zn[2]);
        if (scene.fog) scene.fog.color.setRGB(D.hz[0] * 0.8, D.hz[1] * 0.8, D.hz[2] * 0.8);
        // camera-side fill: lights the hero's back in the chase shot, so a saturated cool fill turned the dark-cloaked
        // hero into a flat blue cutout; ?dfill=<hex>&dfilli=<k> tune it, default a near-neutral cool white
        camFill.color.setHex(parseInt(qs.get('dfill') || 'dfe4ff', 16)); camFill.intensity = +(qs.get('dfilli') || 0.62);
      }
      u.uSat.value *= 1.12; u.uContrast.value *= 1.08;
      u.uShadow.value.y += 0.006; u.uShadow.value.z += 0.012; u.uHigh.value.x += 0.02; u.uHigh.value.y += 0.006;
    }
  }
};
stageFinish(arena);
fx.registerAfterimages(GAUNTLET_ID, gview.root);
// v2.18: warden attack layer (authored torso channels + violet ink afterimages, slot 0 only, presentation only)
const WARDEN_GHOST_ID = 9001; fx.registerAfterimages(WARDEN_GHOST_ID, slots[0].root);
const WMO_ON = qs.get('wmo') !== '0';
const WMO_HOLD = qs.get('wmohold') === '1', WMO_STRIKE = { E_SLASH: 22, E_THRUST: 28, E_COMBO: 39, C_CHARGED: 40, C_SLAM: 46 }, wmoHeld = {};
window.__wmoRelease = () => { window.__wmoHold = null; loop.paused = false; };
const wardenMotion = new WardenMotion({ fx, mistPreset: MIST.VIOLET, reducedMotion, colliders: { terrainY: (z) => colliders.terrainY(z) } });
systems.set('fx', fx);
const cam = new CameraDirector();
const TRAILER = recMode && qs.get('trailer') === '1';   // promo footage: closer lens, HUD stripped to numbers + banners
cam.init(ctx, { camera, colliders, reducedMotion, boomScale: TRAILER ? +(qs.get('boom') || 0.78) : 1, fovScale: TRAILER ? +(qs.get('fovs') || 0.92) : 1,
  bossBoomScale: TRAILER ? +(qs.get('bboom') || 0.72) : 1, bossLook: TRAILER ? +(qs.get('blook') || 0.22) : 0.35,
  bossPitchK: TRAILER ? +(qs.get('bpitch') || 0.85) : 1 });
if (TRAILER) {
  // profile two-shot: orbit ~60 deg off the hero->boss line, frame between them, lower pivot (the boss reads huge)
  cam.bossSide = +(qs.get('bside') || 1.0); cam.occRadiusK = +(qs.get('occk') || 1.5);
  cam.bossBias = +(qs.get('bbias') || 1.05); cam.bossHeight = +(qs.get('bheight') || 1.7);
  // bossLook is set once here (the cam.init default above is only the non-profile fallback)
  cam.bossLook = +(qs.get('blook') || 0.45);
  // ?ad=1 social cut: authored boss shots (phase roar, death) stay tight instead of cutting to a 10 m wide
  cam.cineDistK = +(qs.get('cinek') || (qs.get('ad') === '1' ? 0.62 : 1));
  cam.bossPitchBias = +(qs.get('bpb') || 0);
  // ?cines=intro,death : only these authored shots play (unlisted beats stay on the gameplay two-shot)
  if (qs.get('cines') !== null) cam.cineMask = qs.get('cines').split(',').reduce((m, n) => { const k = CINE_NAMES.indexOf(n.trim().toUpperCase()); return k > 0 ? m | (1 << k) : m; }, 0);
}
// ?finfx=0.4 (trailer): scales the finisher blow's flash, colour kick and spark burst (QA: sparkles washed the frame)
const TRL_FINFX = TRAILER && qs.get('finfx') ? Math.max(0, +qs.get('finfx')) : 1;
const TRL_RIMG = +(qs.get('rimg') || 0.55);
const TRL_HRIM = qs.get('hrim') ? parseInt(qs.get('hrim'), 16) : -1;
const TRL_GHOST = qs.get('ghost') !== '0';
if (TRAILER) fx.auraGain = +(qs.get('aura') || 0.5);   // telegraph rings stay readable but stop reading as debug decals
// v2.26 trailer: flares, rift cuts and blade ribbons keep their own hue in the hot core (no white strikes);
// uniform only, same programs. ?hot=1 restores the white core for A/B.
if (TRAILER) { fx.hotCore = +(qs.get('hot') || 0); if (fx.streakMesh) fx.streakMesh.material.uniforms.uHot.value = fx.hotCore; }
// v2.27 ad pass: additive cuts and flares stacked past 1.0 per channel and bloomed to near white. ?lcap caps each
// channel of a flare/cut so the hue survives tonemapping; ?sgain thins spark bursts; ?shead dims spark heads;
// ?corek sets how far a strike core lifts toward white. Uniform/presentation only, same programs, sim untouched.
if (TRAILER && qs.get('lcap')) fx.lightCap = +qs.get('lcap');
if (TRAILER && qs.get('sgain')) fx.sparkGain = Math.min(1, Math.max(0, +qs.get('sgain')));
if (TRAILER && qs.get('shead')) fx.sparkHead = +qs.get('shead');
const TRL_COREK = TRAILER && qs.get('corek') ? +qs.get('corek') : 0.35;
if (TRAILER && qs.get('scap')) fx.shockCap = +qs.get('scap');
if (TRAILER && qs.get('fscale')) fx.flareGain = Math.min(1, Math.max(0.2, +qs.get('fscale')));
// ?emb=<n>: trigger-aura ember every n frames (0 = none; QA t8: gold ember squares carpeted the boss-death frames)
const TRL_EMB = TRAILER && qs.get('emb') !== null ? Math.max(0, Math.round(+qs.get('emb'))) : 6;
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
const sim = new GameSim({ seed, timing, colliders: fordColliders, stage3Colliders: foundryColliders, stage2Colliders: shrineColliders, roadColliders, bus, god: qs.get('god') === '1',
  character: CHAR, startAt: qs.get('start') || 'title', dodgeProfile: QUICKSTEP, stage3: qs.get('stage3') === '1', weapon: +(qs.get('wpn') || 0) });
const arenaFor = () => sim.roadActive ? 'road' : sim.stage3Active ? 'foundry' : sim.stage2Active ? 'shrine' : 'ford';
setArena(arenaFor());
const H = sim.hero;
setHeroWeapon(H.weapon);   // v2.24: Kael starts with the glaive in hand
const prev = { hx: H.x, hz: H.z, hyaw: H.yaw, bx: 0, by: 0, bz: 0, byaw: 0 };
const dPrev = []; for (let i = 0; i < MAX_DUELISTS; i++) dPrev.push({ x: 0, z: 0, yaw: 0 });
let paused = false, pauseFrames = 0;
const runStats = { contacts: 0, perfect: 0, phantom: 0, hits: 0, hudLagMax: 0 };
const _p = new THREE.Vector3(), _n = new THREE.Vector3();

// sim -> presentation (downstream only)
sim.onHeroContact = (R) => {
  runStats.contacts++;
  _p.set(H.x, 1.15, H.z); _n.set(R.normal ? R.normal.x : 0, 0.3, R.normal ? R.normal.z : 1);
  if (R.effect === 'jg' || (sim.stage3Active && (R.effect === 'chip' || R.effect === 'break'))) { gauntletGuardFx(R); return; }
  if (R.outcome === Outcome.PARRIED) {
    fx.burstSparks(_p, _n, R.perfect ? 1.4 : 0.7);
    if (!reducedMotion) { post.kick(R.perfect ? 0.32 : 0.12, 0xbfe6ff); if (R.perfect) post.impactBlur(_p, 0.6); } fx.flare(_p, R.perfect ? 1.6 : 0.9, 0x9fd8ff);
    if (R.perfect) { runStats.perfect++; loop.dilate(0.25, 12); cam.deflect(); hud.cue('PERFECT DEFLECT', 'perfect'); fx.shockwave(H.x, colliders.terrainY(H.z) + 0.22, H.z, 2.6, 0x9fd8ff, 0.9, 0.4); }
    else hud.cue('DEFLECT', 'perfect');
  } else if (R.effect === 'slip' || R.effect === 'behind' || R.effect === 'phantom') {
    runStats.phantom++; loop.dilate(0.4, 18); cam.phantomStep(18);
    fx.afterimage(HERO_ID, INK_ON ? INK.GHOST : false, 1); fx.afterimage(HERO_ID, INK_ON ? INK.GHOST : false, 0.7);
    if (INK_ON) fx.mist(H.x, colliders.terrainY(H.z) + 1.0, H.z, 0.6, MIST.JADE, 12, 0.5);
    hud.cue(R.effect === 'behind' ? 'PHANTOM STEP - BEHIND' : 'PHANTOM STEP', 'phantom');
  } else if (R.outcome === Outcome.HIT) {
    if (!reducedMotion) { post.kick(R.damage >= 22 ? 0.2 : 0.1, 0xff3020); if (R.damage >= 22) post.impactBlur(_p, 0.4); }
    runStats.hits++; fx.burstBlood(_p, _n, R.damage >= 25 ? 1.5 : 1); cam.impact(R.damage >= 30 ? 'slam' : R.damage >= 22 ? 'heavy' : 'light');
    if (R.damage >= 22) loop.dilate(0.3, 2);       // hit-stop on big incoming hits (time only; sim outcomes unchanged)
    heroReact.amp = Math.min(1.5, 0.6 + R.damage / 30); heroReact.t = 0;
    heroReact.dx = R.normal ? -R.normal.x : -H.facingX(); heroReact.dz = R.normal ? -R.normal.z : -H.facingZ();
    if (arena === 'ford' && Math.abs(H.z) < 6.7) fx.splash(H.x, H.z, 0.6);
  } else if (R.outcome === Outcome.BLOCKED) { fx.burstSparks(_p, _n, 0.5); cam.impact('light'); }
};
// Stage 3 guard feedback (spec section 5/6): JG = cyan chevron on the guard point + white sparks + 6 f hit-stop,
// perfect JG adds the deflect push-in; late/held block = chip cue + small sparks; dome on a held block = guard break.
const _gfx = new THREE.Vector3();
function gauntletGuardFx(R) {
  _gfx.set(H.x + H.facingX() * 0.55, colliders.terrainY(H.z) + 1.3, H.z + H.facingZ() * 0.55);
  if (R.effect === 'jg') {
    runStats.jg = (runStats.jg || 0) + 1;
    fx.chevron(_gfx, camera.quaternion, R.perfect);
    if (!reducedMotion) post.kick(R.perfect ? 0.34 : 0.14, 0xa8f4ff); fx.flare(_gfx, R.perfect ? 1.7 : 1.0, 0x40e0ff);
    fx.burstSparks(_gfx, _n, R.perfect ? 1.5 : 0.9);
    loop.dilate(0.12, R.perfect ? 8 : 6);
    if (R.perfect) { runStats.perfect++; if (!reducedMotion) cam.deflect(); fx.shockwave(H.x, colliders.terrainY(H.z) + 0.22, H.z, 2.8, 0x40e0ff, 1.0, 0.4); hud.cue('PERFECT JUST GUARD', 'perfect'); }
    else { cam.impact('light'); hud.cue('JUST GUARD', 'perfect'); }
    gview.hit(-H.facingX(), -H.facingZ(), R.perfect ? 0.9 : 0.5);
  } else if (R.effect === 'chip') {
    fx.burstSparks(_gfx, _n, 0.5); cam.impact('light'); hud.cue('BLOCKED - TOO LATE', 'hit');
  } else {
    fx.burstSparks(_gfx, _n, 1.1); cam.impact('heavy'); hud.cue('GUARD BROKEN', 'hit');
    heroReact.amp = 1.2; heroReact.t = 0; heroReact.dx = R.normal ? -R.normal.x : -H.facingX(); heroReact.dz = R.normal ? -R.normal.z : -H.facingZ();
  }
}
// v2.7 MH-style damage numbers: project the contact point to CSS px (presentation only, deterministic drift)
const _dproj = new THREE.Vector3(); let dmgSeq = 0;
// v2.24 trailer spectacle (?rec=1&trailer=1 only, never in play or QA): a blade-glint cut across every contact,
// a crossed ember cut on big hits, doubled sparks, a hotter flare, a touch more hit-stop, and a faster Trigger gauge
// so the Ember Trigger and Ember Rift fire several times per capture. Reads _p/_n as set by onHeroHit.
// Cuts are tinted by the weapon in hand (each blade has a signature colour on screen) and their angle cycles so
// consecutive hits never look identical. No extra flare: QA showed the starburst covering the contact point.
let trlCut = 0;
// QA t7: Kael's pale periwinkle read as blue-white once bloomed; a deeper electric blue-violet keeps its hue
const TRL_EDGE = { kael: +('0x' + (qs.get('kcol') || '5a5cff')), vesper: 0xff5a1a };
function trailerEdge() {
  if (H.weapon === 5 || CHAR === 'kael') return TRL_EDGE.kael;
  if (H.weapon >= 1) return (BLADE_LOOK[H.weapon] || BLADE_LOOK[1]).inlay;
  return CHAR === 'vesper' ? TRL_EDGE.vesper : 0xff3a1a;
}
const trlTip = { prev: new THREE.Vector3(), cur: new THREE.Vector3(), f: -9, live: 0 };
const _ts0 = new THREE.Vector3(), _ts1 = new THREE.Vector3();
// screen angle of the blade tip's last motion (falls back to a cycled angle when the tip history is stale)
function trailerSwingAngle() {
  if (trlTip.live >= 1 && sim.frame - trlTip.f <= 2) {
    _ts0.copy(trlTip.prev).project(camera); _ts1.copy(trlTip.cur).project(camera);
    const dx = (_ts1.x - _ts0.x) * camera.aspect, dy = _ts1.y - _ts0.y;
    if (dx * dx + dy * dy > 1e-6) return Math.atan2(dy, dx);
  }
  return ((trlCut * 1.37) % 1.6) - 0.45;
}
// v2.26 trailer: no white anywhere in a strike. The hot core is the edge colour lifted 35% toward white (keeps its
// hue), so every cut reads as coloured light; the screen pulse on contact is the same hue.
const _tcA = new THREE.Color(), _tcB = new THREE.Color();
function trailerCore(hex, k = TRL_COREK) { return _tcA.setHex(hex).lerp(_tcB.setRGB(1, 1, 1), k).getHex(); }
function trailerHitFx(heavy, ch, great, dealt) {
  const big = heavy || great || ch > 0.5, edge = trailerEdge(), core = trailerCore(edge);
  const rot = trailerSwingAngle(); trlCut++;
  // one cut along the swing direction: a lifted-hue core over the weapon-coloured edge, offset 2 frames so it reads
  // as the blade passing through; big hits add a wide second arc and an upward shard burst. No crosses (reticles).
  // QA t7: full-length cuts crossed the hero's body from the over-shoulder lens; ~0.7x keeps them on the target
  fx.riftSlash(_p, big ? 3.1 + 1.3 * ch : 1.9, rot, core, 0, big ? 0.26 : 0.16);
  fx.riftSlash(_p, big ? 3.9 + 1.4 * ch : 2.3, rot + 0.04, edge, 0.033, big ? 0.36 : 0.22);
  if (big) { fx.riftSlash(_p, 5.2 + 1.8 * ch, rot - 0.1, edge, 0.05, 0.42); _n.set(0, 1, 0); fx.burstSparks(_p, _n, 1.3); fx.flare(_p, 1.2 + 0.6 * ch, edge); }
  if (!reducedMotion) { post.kick(big ? 0.2 + 0.1 * ch : 0.08, edge); if (big) loop.dilate(0.12, 5 + (ch > 0.5 ? 2 : 0)); }
  H.addGauge(dealt * 0.8);
}
// v2.26 trailer hero aura: a low coloured haze curling off the feet plus tinted afterimages while the hero moves or
// swings (the colour of the blade in hand). Bright tint at low alpha so it glows instead of reading as muddy smoke.
const _auraC = new THREE.Color();
const _scrV = new THREE.Vector3();
function _scrX(x, y, z) { _scrV.set(x, y, z).project(camera); return Math.min(1, Math.max(0, _scrV.x * 0.5 + 0.5)); }
let trlTint = -1; const _sparkTint = [1, 1, 1];
function trailerAura(gy) {
  if (presentDtNow <= 0 || reducedMotion) return;
  const edge = trailerEdge(), on = H.triggerF > 0, f = sim.frame;
  _auraC.setHex(edge);
  if (edge !== trlTint) {   // sparks + full-screen flash follow the blade colour (QA: white starbursts read as generic)
    trlTint = edge; _sparkTint[0] = _auraC.r; _sparkTint[1] = _auraC.g; _sparkTint[2] = _auraC.b; fx.sparkTint = _sparkTint;
    hud.setFlashColor('#' + _auraC.clone().lerp(_tcB.setRGB(1, 1, 1), 0.25).getHexString());
  }
  // QA t6: the foot haze piled into a cloud that hid the hero. Sparser, lower, and always on the far side of the
  // hero from the camera so it backlights the silhouette instead of covering it.
  if ((f % (on ? 7 : 11)) === 0) {
    camera.getWorldDirection(_dir);
    const a = (f * 0.61) % (Math.PI * 2), r = 0.3, bx = _dir.x * 0.7, bz = _dir.z * 0.7;
    fx.mistRGBA(H.x + bx + Math.cos(a) * r, gy + 0.15, H.z + bz + Math.sin(a) * r, 0.28, _auraC.r, _auraC.g, _auraC.b, on ? 0.2 : 0.12, on ? 2 : 1, on ? 1.3 : 0.8);
  }
  const moving = H.speed > 2.2 || H.state === HERO_STATE.ACTION || H.state === HERO_STATE.DODGE || H.state === HERO_STATE.RIFT;
  // t12: during the launcher string the ghosts stacked on the body and the hero read as see-through; no ghosts
  // off the ground or inside an air verb
  const airV = (H.y || 0) > 0.05 || (H.state === HERO_STATE.ACTION && AIR_BODY[H.verb]);
  // ?ghost=0 (film): no hero ghosts while he attacks; review t12 read the additive ghosts over the body as a
  // see-through hero. Runs and dodges keep theirs.
  if (moving && !airV && (TRL_GHOST || H.state !== HERO_STATE.ACTION) && (f % 4) === 0) fx.afterimage(HERO_ID, edge, on ? 0.45 : 0.3);
  if (on && TRL_EMB > 0 && (f % TRL_EMB) === 0) { _a.set(H.x, gy + 1.0, H.z); fx._ember(H.x + Math.sin(f) * 0.4, gy + 0.4, H.z + Math.cos(f) * 0.4, 0, 2.2, 0); }
}
// v2.26 trailer boss spectacle: every verb gets a colour-coded read on startup and a big contact beat on its active
// frame (red = unblockable, blue = air, amber = normal), charge and swoop leave afterimage trails, the roar blasts a
// ring. Presentation only, keyed on (actionId, frame) so each beat fires exactly once.
const ART_COL = [0xffa040, 0xff3a1a, 0x4aa8ff];
const trlBoss = { act: -1, mask: 0, roar: 0 };
const _bh = new THREE.Vector3(), _bt = new THREE.Vector3();
function trailerBossFx(B) {
  if (presentDtNow <= 0) return;
  const gy = colliders.terrainY(B.z);
  const roaring = B.state === BRAIN_STATE.ROAR || (B.verb === BossVerb.W_ROAR && B.state === BRAIN_STATE.ACTION);
  if (roaring && B.f >= 18 && !trlBoss.roar) {
    trlBoss.roar = 1; HEAD.getWorldPosition(_bh);
    fx.shockwave(B.x, gy + 0.2, B.z, 10, 0xff3a1a, 1.4, 0.9); fx.shockwave(B.x, gy + 0.25, B.z, 6, 0xffa040, 1.1, 0.6);
    fx.flare(_bh, 2.4, 0xff4a2a); fx.mistRGBA(B.x, gy + 0.4, B.z, 2.5, 0.9, 0.35, 0.15, 0.3, 14, 1.2);
    if (!reducedMotion) { post.kick(0.3, 0xff3a1a); cam.impact('slam'); }
  } else if (!roaring) trlBoss.roar = 0;
  const d = B.def;
  if (!d || (B.state !== BRAIN_STATE.ACTION && B.state !== BRAIN_STATE.PREROLL)) return;
  if (B.actionId !== trlBoss.act) { trlBoss.act = B.actionId; trlBoss.mask = 0; }
  const col = ART_COL[d.art] || ART_COL[0], fxX = B.forwardX(), fxZ = B.forwardZ(), v = B.verb;
  HEAD.getWorldPosition(_bh);
  // startup read: a flare at the jaw in the attack's colour (red/blue verbs also flash a ground ring)
  if (!(trlBoss.mask & 1)) {
    trlBoss.mask |= 1; fx.flare(_bh, d.art === 0 ? 0.9 : 1.6, col);
    if (d.art) fx.shockwave(B.x, gy + 0.2, B.z, 3.2, col, 0.8, 0.5);
  }
  const act = B.state === BRAIN_STATE.ACTION;
  // trails during travel verbs
  if (act && (v === BossVerb.W_CHARGE || v === BossVerb.W_SWOOP) && (B.f % 3) === 0) {
    fx.afterimage(BOSS_ID, col, 0.55);
    if (!B.airborne) fx.mistRGBA(B.x - fxX * 1.5, gy + 0.3, B.z - fxZ * 1.5, 0.9, 0.55, 0.42, 0.34, 0.32, 3, 0.7);
  }
  if (act && B.f >= d.active[0] && !(trlBoss.mask & 2)) {
    trlBoss.mask |= 2;
    const tail = v === BossVerb.W_TAIL_L || v === BossVerb.W_TAIL_R;
    if (tail) {
      const s = d.side || 1; _bt.set(B.x - fxX * 2.2 - fxZ * s * 2.0, gy + 1.0, B.z - fxZ * 2.2 + fxX * s * 2.0);
      fx.riftSlash(_bt, 8.5, s * 0.12, col, 0, 0.45); fx.riftSlash(_bt, 6.0, s * 0.12 + 0.05, trailerCore(col), 0.03, 0.32);
      fx.shockwave(B.x, gy + 0.2, B.z, 6.0, col, 1.2, 0.6);
      if (!reducedMotion) { cam.impact('slam'); post.kick(0.2, col); }
    } else if (v === BossVerb.W_SWOOP || v === BossVerb.W_LAND) {
      fx.shockwave(B.x, gy + 0.2, B.z, v === BossVerb.W_LAND ? 7.5 : 6.5, col, 1.4, 0.7);
      _bt.set(B.x, gy + 1.2, B.z); fx.riftSlash(_bt, 7.5, -0.5, col, 0, 0.4); fx.flare(_bt, 2.0, col);
      fx.mistRGBA(B.x, gy + 0.3, B.z, 2.4, 0.6, 0.55, 0.5, 0.3, 12, 0.9);
      if (!reducedMotion) { cam.impact('slam'); post.kick(0.22, col); loop.dilate(0.25, 4); }
    } else if (v === BossVerb.W_HAZE || v === BossVerb.W_SKY_HAZE) {
      const ah = d.pool ? d.pool.ahead : 3; fx.shockwave(B.x + fxX * ah, colliders.terrainY(B.z + fxZ * ah) + 0.2, B.z + fxZ * ah, 4.5, col, 1.2, 0.7);
      if (!reducedMotion) { post.kick(0.18, 0xff5a20); cam.impact('heavy'); }
    } else if (v === BossVerb.W_SPIT) {
      fx.flare(_bh, 1.8, 0xffa040); fx.burstSparks(_bh, _n.set(fxX, 0.3, fxZ), 1.0);
    } else {   // bite / lunge / charge: a jaw-snap arc in the attack colour + ground ring
      _bt.set(_bh.x + fxX * 1.2, Math.max(_bh.y - 0.4, gy + 0.8), _bh.z + fxZ * 1.2);
      fx.riftSlash(_bt, v === BossVerb.W_CHARGE ? 7.0 : 5.0, 0.35, col, 0, 0.36); fx.riftSlash(_bt, v === BossVerb.W_CHARGE ? 5.0 : 3.6, -0.25, trailerCore(col), 0.04, 0.28);
      fx.shockwave(_bt.x, colliders.terrainY(_bt.z) + 0.2, _bt.z, v === BossVerb.W_CHARGE ? 5.0 : 3.2, col, 1.0, 0.5);
      if (!reducedMotion) { cam.impact(v === BossVerb.W_CHARGE ? 'slam' : 'heavy'); post.kick(v === BossVerb.W_CHARGE ? 0.2 : 0.1, col); }
    }
  }
}
function popDamageAt(p, amount, kind) {
  _dproj.copy(p).project(camera); if (_dproj.z > 1) return;
  const dx = ((dmgSeq++ * 37) % 7 - 3) * 9;
  hud.popDamage((_dproj.x * 0.5 + 0.5) * innerWidth, (-_dproj.y * 0.5 + 0.5) * innerHeight - 20, amount, kind, dx);
}
sim.onHeroHit = (t, dealt, v) => {
  if (dealt <= 0) return;
  const gH = t.id === GAUNTLET_ID, bHead = gH ? gview.HEAD : HEAD, bRoot = gH ? gview.root : boss.root;
  { const hv = v.name === 'HEAVY' || !!v.heavy, c = v.charge || 0; _a.set(t.x, 1.6, t.z); if (t.isBoss) { bHead.getWorldPosition(_a); _a.lerp(bRoot.position, 0.4); _a.y = Math.max(_a.y, 1.8); }
    popDamageAt(_a, dealt, c > 0.5 || dealt >= 40 ? 'big' : hv ? '' : dealt < 12 ? 'weak' : '');
    if (hv && c > 0.5) hud.flash(reducedMotion ? 0.1 : 0.16); }   // v2.17c: 0.35 -> 0.16, stacked with the grade lift it washed the frame
  _n.set(H.facingX(), 0.2, H.facingZ());
  if (t.isBoss) { bHead.getWorldPosition(_p); _p.lerp(bRoot.position, 0.5); _p.y = Math.max(_p.y, 1.2); }
  else _p.set(t.x, 1.2, t.z);
  if (v.rift) { riftHitFx(t, v); return; }
  const heavy = v.name === 'HEAVY' || !!v.heavy || (!!v.wave && !v.great), ch = v.charge || 0, great = !!v.great;   // v2.37b: the one-handed crescent lands as a heavy
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
  // v2.13 FX hierarchy: outgoing contact is the loudest read on screen (grade flash + hot ember flare at contact)
  // v2.17c: grade flash on heavies lowered (0.22+0.25ch -> 0.14+0.14ch): stacked with the impact blur it washed the
  // whole frame sepia; the blur now carries the weight, the flash is only a tint pulse
  if (!reducedMotion) post.kick(heavy ? 0.14 + 0.14 * ch : great ? 0.11 : 0.08, ch > 0.5 ? 0xffe0a0 : 0xffb070);
  // v2.17 impact blur: only heavies and great-sword hits smear the frame (lights stay crisp so combos read)
  if (!reducedMotion && (heavy || great)) post.impactBlur(_p, heavy ? 0.55 + 0.45 * ch : 0.35);
  if (!TRAILER) fx.flare(_p, heavy ? 1.3 + 0.8 * ch : great ? 1.0 : 0.7, ch > 0.5 ? 0xffe0a0 : 0xff9040);
  if (TRAILER) trailerHitFx(heavy, ch, great, dealt);
  if (t.isBoss && t.id === GAUNTLET_ID) gview.hit(H.facingX(), H.facingZ(), (heavy ? 1 : 0.5) * (1 + ch));
  else if (t.isBoss) { bossReact.amp = Math.min(1.6, bossReact.amp * 0.4 + (heavy ? 1 : 0.5) * (1 + ch) * (v.wave && !great ? 3 : v.air ? 2.2 : 1)); bossReact.t = 0; bossReact.dx = H.facingX(); bossReact.dz = H.facingZ(); bossReact.flash = Math.min(1, 0.5 + 0.5 * ch + (heavy ? 0.3 : 0)); }
};
sim.onEquip = (w, src) => {
  setHeroWeapon(w);
  if (src === 'drop') {
    const D = sim.drop, gy = colliders.terrainY(D.z), L = BLADE_LOOK[w];
    _p.set(D.auto ? H.x : D.x, gy + 1.2, D.auto ? H.z : D.z); _n.set(0, 1, 0);
    fx.burstSparks(_p, _n, 2.0); fx.shockwave(_p.x, gy + 0.22, _p.z, 4.2, L.inlay, 1.0, 0.6); fx.flare(_p, 1.4, L.inlay);
    cam.impact('heavy'); hud.cue(WEAPONS[w].name + ' CLAIMED', 'perfect'); hud.flash(reducedMotion ? 0.08 : 0.22);
    if (!reducedMotion) post.kick(0.12, L.inlay);
    return;
  }
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
  pickupBeamMat.opacity = 0.12 + 0.16 * k;   // v2.17c: higher peak, the vertex fade removes most of the column
  emberInlay.emissiveIntensity = 0.8 + 1.6 * k;
  // ground ping every 1.25 s so it reads even when the column is behind the camera
  if (dt > 0 && sim.frame % 75 === 0 && pickupGlow.ping !== sim.frame) {
    pickupGlow.ping = sim.frame; fx.shockwave(P.x, gy + 0.22, P.z, 2.0, 0xffa040, 0.45, 0.6);
  }
}
// boss drop: rises out of the corpse's blood-pool, then pulses in its weapon colour until claimed
function dropLayer(dt) {
  const D = sim.drop, on = D.active && sim.state === GameState.LOOT;
  dropRoot.visible = on;
  if (!on) return;
  if (dropGlow.w !== D.weapon) { dropGlow.w = D.weapon; dropGlow.t = 0; dressGreatSword(dropSword, D.weapon, dropSteel, dropInlay, dropGuard); dropBeamMat.color.setHex(BLADE_LOOK[D.weapon].inlay); }
  const gy = colliders.terrainY(D.z);
  dropGlow.t += dt;
  const rise = reducedMotion ? 1 : Math.min(1, dropGlow.t / 0.9), e = 1 - (1 - rise) * (1 - rise);
  dropRoot.position.set(D.x, gy + 1.38 - 1.6 * (1 - e), D.z);
  dropRoot.rotation.y = reducedMotion ? 0 : dropGlow.t * 0.6;
  const k = 0.5 + 0.5 * Math.sin(dropGlow.t * 3.6);
  dropBeamMat.opacity = (0.14 + 0.18 * k) * e;
  dropInlay.emissiveIntensity = 1.0 + 1.8 * k;
  if (dt > 0 && sim.frame % 60 === 0 && dropGlow.ping !== sim.frame) {
    dropGlow.ping = sim.frame; fx.shockwave(D.x, gy + 0.22, D.z, 2.4, BLADE_LOOK[D.weapon].inlay, 0.5, 0.6);
  }
}
sim.onTelegraph = (v, art, lead) => {
  fx.telegraph(BOSS_ID, art === ART.RED ? TELEGRAPH.RED : art === ART.BLUE ? TELEGRAPH.BLUE : TELEGRAPH.NORMAL, lead, boss.root, 2.6);
  // v2.23: with a two-hander there is no roll - the cue tells the player to step out / guard instead
  const heavy = H.wp && GREAT_NO_EVADE;
  if (art === ART.RED) hud.cue(heavy ? 'RED - STEP ASIDE' : 'RED - DODGE ASIDE', 'hit'); else if (art === ART.BLUE) hud.cue(heavy ? 'BLUE - GUARD' : 'BLUE - DODGE IN', 'phantom');
};
sim.onDuelistTelegraph = (d) => {
  const s = slotFor(d); if (!s) return;
  const v = d.verbs[d.verb], red = v.art === ART.RED;
  fx.telegraph(s.actorId, red ? TELEGRAPH.RED : TELEGRAPH.NORMAL, v.startup, s.root, d.elite ? 1.4 : 1.1);
  if (d.elite && red) hud.banner('', H.wp && GREAT_NO_EVADE ? 'CHARGE - STEP ASIDE' : 'CHARGE - DODGE', 0.9);
  else if (d.elite && d.verb === 'C_SLAM') hud.banner('', 'SLAM - DEFLECT OR STEP OUT', 0.9);
};
// Gauntlet: lightning is unguardable (red ring + cue); the dome breaks a held block (blue ring + cue)
const G_CUES = ['', '', '', '', 'LIGHTNING - KEEP MOVING', 'DOME - DO NOT HOLD BLOCK', '', ''];
sim.onGauntletTelegraph = (v, unguardable, lead) => {
  fx.telegraph(GAUNTLET_ID, unguardable ? TELEGRAPH.RED : v === 5 ? TELEGRAPH.BLUE : TELEGRAPH.NORMAL, lead, gview.root, 3.0);
  if (G_CUES[v]) hud.cue(G_CUES[v], unguardable ? 'hit' : 'phantom');
};
bus.on('action/end', (p) => { if (p.actorId === BOSS_ID || p.actorId === GAUNTLET_ID) fx.clearTelegraph(p.actorId); });
bus.on('boss/phase', (p) => {
  if (p.actorId !== GAUNTLET_ID) return;
  if (p.intro) { cam.cine(CINE.INTRO); return; }
  cam.onBossPhase(); hud.banner('THE GAUNTLET BURNS', 'it moves faster now', 1.8);
  fx.shockwave(sim.gauntlet.x, colliders.terrainY(sim.gauntlet.z) + 0.22, sim.gauntlet.z, 7, 0xff6a4a, 1.2, 0.7);
});
bus.on('boss/phase', (p) => { if (p.actorId === WARDEN_ID) { cam.onBossPhase(); hud.banner('THE WARDEN UNSHEATHES HIS RAGE', '', 1.8); return; } if (p.actorId !== GAUNTLET_ID && !p.intro) { cam.onBossPhase(); hud.banner('THE WYVERN RAGES', '', 1.8); } });

function slotFor(d) { for (const s of slots) if (s.bound === d) return s; return null; }
function bindSlots() {
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i], d = sim.duelists[i] || null;
    if (s.bound !== d) {
      s.bound = d; s.root.visible = !!d; s.actorId = d ? d.id : -1; s.animT = 0;
      if (i === 0) styleWarden(!!(d && d.elite));
      if (d) { fx.registerAfterimages && 0; dPrev[i].x = d.x; dPrev[i].z = d.z; dPrev[i].yaw = d.yaw; }
    }
  }
}

// v2.20 road: banner per leg, banner per ambush; the sim spawns the ambush, the view just names it
const ROAD_TITLE = [['THE CEDAR PASS', 'the shrine lies beyond the torii'], ['THE IRON ROAD', 'the foundry lies beyond the torii']];
sim.onAmbush = (i, A) => { bindSlots(); hud.banner('AMBUSH', A.name.toUpperCase(), 1.0, true); };
bus.on('wave/clear', () => { if (sim.roadActive) { if (sim.roadCleared) hud.banner('THE PASS IS CLEAR', 'walk on to the torii gate', 2.2, true); else hud.banner('', 'the road goes on', 1.2, true); } });
sim.onState = (s) => {
  bindSlots();
  // GATE keeps the shrine (the warden corpse is still there); STAGE3 swaps to the foundry; title/retry resolve from flags
  if (s !== GameState.GATE && s !== GameState.DOOR) setArena(arenaFor());
  boss.root.visible = sim.bossActive;
  gview.root.visible = sim.stage3Active; if (!sim.stage3Active) gview.hideHazards();
  if (sim.stage3Active) { const G = sim.gauntlet; gview.prev.x = G.x; gview.prev.y = G.y; gview.prev.z = G.z; gview.prev.yaw = G.yaw; }
  if (s === GameState.INTRO) hud.banner('THE CRIMSON FORD', 'cross the river', 2.4);
  else if (s === GameState.WAVE) hud.banner('WAVE ' + (sim.wave + 1), WAVES[sim.wave].name.toUpperCase(), 2.0);
  else if (s === GameState.WAVE_CLEAR) hud.banner('CLEARED', sim.wave + 1 < WAVES.length ? 'more come' : 'something stirs in the gorge', 2.0);
  else if (s === GameState.BOSS) { hud.banner('FORD WYVERN', sim.pickup.active ? 'claim the great sword in the ford' : 'guardian of the crossing', 2.6); fx.clearTelegraph(BOSS_ID); cam.cine(CINE.INTRO); }
  else if (s === GameState.LOOT) { const R = ROUTE[sim.lootLeg]; hud.banner(R.boss + ' FALLS', 'claim the ' + WEAPONS[sim.drop.weapon].name.toLowerCase(), 2.6); fx.clearTelegraph(BOSS_ID); }
  else if (s === GameState.DOOR) hud.clearBanner();
  else if (s === GameState.STAGE2) { hud.banner('THE SHADOW WARDEN', 'a blade in the dusk', 2.6); fx.clearTelegraph(BOSS_ID); cam.cine(CINE.INTRO); }
  else if (s === GameState.GATE) hud.clearBanner();
  else if (s === GameState.STAGE3) { hud.banner('THE FROZEN FOUNDRY', 'chrome gauntlet', 2.6); fx.clearTelegraph(BOSS_ID); }
  else if (s === GameState.ROAD) { const T = ROAD_TITLE[sim.roadLeg] || ROAD_TITLE[0]; hud.banner(T[0], T[1], 2.6); fx.clearTelegraph(BOSS_ID); cam.snap(); }
  else if (s === GameState.VICTORY) { hud.clearBanner(); hud.setVictoryLine(sim.lootLeg === 2 ? 'THE ROAD IS WALKED' : 'THE FORD IS QUIET'); hud.setStats('victory', statsView()); }
  else if (s === GameState.DEFEAT) { hud.clearBanner(); hud.setStats('defeat', statsView()); }
  if (s === GameState.DOOR || s === GameState.GATE) roadMap.show(s === GameState.DOOR ? 0 : 1, sim.claimed);
  else roadMap.hide();
  syncScreen();
};
function statsView() {
  const S = sim.stats;
  return { totalF: S.totalF, kills: S.kills, perfects: H.perfects, phantoms: H.phantoms, finishers: S.finishers,
    bossHp: sim.stage3Active ? sim.gauntlet.hp : sim.brain.hp, bossMax: sim.stage3Active ? GAUNTLET.HP : BOSS.HP,
    reachedBoss: sim.bossActive || sim.stage3Active, bossName: sim.stage3Active ? 'GAUNTLET' : 'WYVERN' };
}

// ------------------------------------------------------------------ hero command: real input or seeded bot
const _move = new THREE.Vector3(), _look = { x: 0, y: 0 };
let camYaw = 0, wasBlockHeld = false;
const botRng = new Rng(seed ^ 0x5151).stream('qa-bot');
const bot = { at: -1, kind: 0, hold: 0, swings: 0, sweepN: 0, trigN: 0, trigAt: -1e9, pat: 0, cur: '' };
// DMC verbs for the bot: on in ?rec=1 (showcase) or ?dmc=1 (QA); off otherwise so the legacy bot runs stay byte-identical
const botDmc = recMode || qs.get('dmc') === '1';
const botSweep = qs.get('sweep') === '1';   // v2.22 QA: the bot opens every third swing with a sweep (great sword only)
if (useBot) {
  const prevT = sim.onTelegraph, prevD = sim.onDuelistTelegraph;
  sim.onTelegraph = (v, art, lead) => { prevT(v, art, lead); if (choreo) choreo.onTelegraph(lead); const ok = botRng.float() < 0.85 || DANCE;   // dance takes: every parry lands
    if (art === ART.NORMAL) { bot.at = sim.frame + lead - (ok ? 3 : 7); bot.kind = 1; } else { bot.at = sim.frame + lead - (ok ? 5 : 11); bot.kind = art === ART.BLUE ? 3 : 2; } };
  // red warden charge: the bot dodges it (kind 2 = sidestep), everything else it deflects
  sim.onDuelistTelegraph = (d, v) => { prevD(d, v); const ok = botRng.float() < 0.85 || DANCE;   // dance takes: every parry lands
    if (v.art === ART.RED) { bot.at = sim.frame + v.startup - (ok ? 5 : 11); bot.kind = 2; }
    else if (ok) { bot.at = sim.frame + v.startup - 3; bot.kind = 1; } };
  // gauntlet: just-guard (block press) the guardable verbs; dodge the lightning (sideways) and the dome (away).
  // Lightning columns land 'lead' frames after each placement, the bot sidesteps the last one.
  const prevG = sim.onGauntletTelegraph;
  sim.onGauntletTelegraph = (v, ung, lead) => { prevG(v, ung, lead); const ok = botRng.float() < 0.85 || DANCE;   // dance takes: every parry lands
    if (v === 4) { bot.at = -1; bot.kind = 0; }        // columns are walked out of (botCommand), not timed
    else if (v === 5) { bot.at = sim.frame + lead - (ok ? 4 : 10); bot.kind = 4; }
    else { bot.at = sim.frame + lead - (ok ? 3 : 7); bot.kind = 1; } };
}
function botCommand(c) {
  if (H.triggers !== bot.trigN) { bot.trigN = H.triggers; bot.trigAt = sim.frame; }
  let tx = 0, tz = 0, has = false, td = 1e9, reach = 1.6;
  for (const d of sim.duelists) if (d.alive) { const dd = Math.hypot(d.x - H.x, d.z - H.z); if (dd < td) { td = dd; tx = d.x; tz = d.z; has = true; } }
  if (sim.bossActive && sim.brain.state !== BRAIN_STATE.DEAD) { tx = sim.brain.x; tz = sim.brain.z; td = Math.hypot(tx - H.x, tz - H.z); has = true; reach = 3.2; }
  if (sim.stage3Active && sim.gauntlet.state !== G_STATE.DEAD) { tx = sim.gauntlet.x; tz = sim.gauntlet.z; td = Math.hypot(tx - H.x, tz - H.z); has = true; reach = GAUNTLET.BODY_RADIUS + 1.2; }
  // boss drop: walk into it (the run auto-claims it after FLOW_F.LOOT_AUTO anyway)
  if (sim.state === GameState.LOOT && sim.drop.active) {
    const px = sim.drop.x - H.x, pz = sim.drop.z - H.z, pl = Math.hypot(px, pz) || 1;
    if (sim.stateF > 50) { c.mx = px / pl; c.mz = pz / pl; c.speed = SIM.RUN_SPEED; } return;
  }
  if (!has && sim.roadActive) {
    const tz2 = Math.max(ROAD.GATE_Z, H.z - 4), tx2 = roadX(tz2), rx = tx2 - H.x, rz = tz2 - H.z, rl = Math.hypot(rx, rz) || 1;
    c.mx = rx / rl; c.mz = rz / rl; c.speed = SIM.RUN_SPEED; return;
  }
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
  // lightning: run out of any marked column before it strikes (perpendicular to the boss line so we stay in range)
  if (sim.stage3Active && sim.frame + 1 !== bot.at) {
    for (const col of sim.gauntlet.cols) {
      if (col.left <= 0 || sim.frame >= col.at + col.def.cols.len) continue;
      const px = H.x - col.x, pz = H.z - col.z, pd = Math.hypot(px, pz);
      if (pd < col.def.reach + 1.0) { const s = (px * -dz + pz * dx) >= 0 ? 1 : -1; c.mx = -dz / l * s + px / (pd || 1) * 0.5; c.mz = dx / l * s + pz / (pd || 1) * 0.5;
        const ml = Math.hypot(c.mx, c.mz) || 1; c.mx /= ml; c.mz /= ml; c.speed = SIM.RUN_SPEED; return; }
    }
  }
  // great sword: go claim it first (it is the intended opening of the boss fight)
  if (sim.bossActive && sim.pickup.active && sim.frame + 1 !== bot.at) {
    const px = sim.pickup.x - H.x, pz = sim.pickup.z - H.z, pl = Math.hypot(px, pz) || 1;
    c.mx = px / pl; c.mz = pz / pl; c.speed = SIM.RUN_SPEED; return;
  }
  // rec showcase: hold a charged heavy through its wind-up (released by the dodge/block reflex or at full charge)
  if (recMode && bot.hold > 0 && sim.frame + 1 !== bot.at) { bot.hold--; c.heavyHeld = true; return; }
  // v2.23: a two-hander cannot roll, so the bot answers every telegraph it would have dodged by walking out of the
  // contact line for a short window (sidestep 2/3 = perpendicular, dome 4 = away). Guardable hits stay just-guards.
  if (H.wp && GREAT_NO_EVADE && bot.kind >= 2 && sim.frame + 1 >= bot.at - 14 && sim.frame + 1 <= bot.at + 8) {
    const s = bot.kind === 4 ? 0 : 1;
    c.mx = s ? -dz / l : -dx / l; c.mz = s ? dx / l : -dz / l; c.speed = SIM.RUN_SPEED;
    if (sim.frame + 1 === bot.at && bot.kind === 3) c.blockPress = true;   // blue: guard on contact as well
    return;
  }
  if (sim.frame + 1 === bot.at) {
    bot.hold = 0;
    if (bot.kind === 1) c.blockPress = true;
    else if (bot.kind === 4) { c.dodge = true; c.mx = -dx / l; c.mz = -dz / l; }
    else { c.dodge = true; if (bot.kind === 3) { c.mx = dx / l; c.mz = dz / l; } else { c.mx = -dz / l; c.mz = dx / l; } }
  } else if (DANCE && danceStep(c, dx / l, dz / l, td, reach)) { /* footwork beat between strings */ }
  else if (botDmc && H.gauge >= 50 && !H.triggered && H.state === HERO_STATE.LOCO && td < reach + 2) { c.trigger = true; }
  // trailer showcase: cash the trigger into an Ember Rift ~1.3 s after it lights (the QA bot waits for the tail end)
  else if (TRAILER && H.triggerF >= HERO_RIFT.MIN_LEFT && sim.frame - bot.trigAt > 80 && H.state === HERO_STATE.LOCO && td < HERO_RIFT.RANGE - 1) { c.trigger = true; }
  else if (botDmc && H.triggerF >= HERO_RIFT.MIN_LEFT && H.triggerF < HERO_RIFT.MIN_LEFT + 120 && H.state === HERO_STATE.LOCO && td < HERO_RIFT.RANGE - 1) { c.trigger = true; }
  else if (botDmc && td > reach + 2.2 && td < 10.5 && H.snatchCd === 0 && H.state === HERO_STATE.LOCO && H.stamina >= 40 && (bot.at < sim.frame || bot.at - sim.frame > 40)) { c.snatch = true; }
  else if (botDmc && H.state === HERO_STATE.SNATCH) { c.attack = true; }
  else if (botCombo && qs.get('combo') === '3' && H.state === HERO_STATE.ACTION && bot.seq) combo10Press(c);   // keep a 10-move string fed every frame
  else if (td > reach + 0.6) { c.mx = dx / l; c.mz = dz / l; c.speed = SIM.RUN_SPEED; }
  else if ((sim.frame + 1) % 9 === 0) {
    if (sim.finisherReady()) c.heavy = true;
    else if (botCombo) comboPress(c);
    else if (recMode && H.state === HERO_STATE.LOCO && H.stamina >= 60 && ++bot.swings % 5 === 0 && (bot.at < sim.frame || bot.at - sim.frame > 70)) { c.heavy = true; c.heavyHeld = true; bot.hold = 62; }
    else if (botSweep && H.wp && H.stamina >= 40 && ++bot.sweepN % 3 === 0) c.sweep = true;
    else c.attack = true;
  }
  else if (td < reach - 0.6) { c.mx = -dx / l; c.mz = -dz / l; c.speed = SIM.WALK_SPEED; }
}
// ?rec=1&combo=1 promo showcase: the bot plays whole strings instead of single swings - 3-hit light chain, sweep ->
// reverse sweep (two-handers), light chain again, charged heavy - and waits for stamina so every string lands in full.
const botCombo = recMode && ['1', '2', '3'].includes(qs.get('combo'));
// combo=2 (v2.26 promo): mixed strings so a two-hander never repeats one chop - 'M' = overhead LIGHT_1 -> horizontal
// SWEEP -> reverse SWEEP_REV (three different cut planes in one string), then a charged heavy. combo=1 keeps v2.25.
const COMBO_PAT = qs.get('combo') === '2' ? ['M', 'H', 'M', 'L', 'H'] : ['L', 'S', 'L', 'H'];
// combo=3 (v2.23): 10-move strings from the COMBO_ROUTE tree. Each letter is one button press, sent once per verb as
// soon as it starts (A light, B heavy, S sweep); the sim plays the routed verb when the chain window opens.
const COMBO10 = qs.get('combo') === '3';
const COMBO10_PAT = [['A', 'A', 'A', 'A', 'B', 'A', 'A', 'A', 'S', 'B'], ['A', 'B', 'S', 'S', 'A', 'A', 'B', 'A', 'A', 'B'],
  ['A', 'A', 'A', 'A', 'A', 'B', 'A', 'B', 'A', 'A'], ['A', 'A', 'B', 'A', 'A', 'B', 'A', 'A', 'B', 'A'],
  // v2.30 great sword: L1 L2 L3 WAVE LEAP | L1 L2 L3 SWEEP LEAP (?combo=3&gsx=1 plays only these two)
  ['A', 'A', 'A', 'B', 'B', 'A', 'A', 'A', 'S', 'B']];
const COMBO10_GSX = qs.get('gsx') === '1';
function combo10Press(c) {
  if (H.state === HERO_STATE.LOCO) {
    if (H.stamina < 90) return;
    bot.seq = COMBO10_GSX ? COMBO10_PAT[COMBO10_PAT.length - 1] : COMBO10_PAT[(bot.pat++) % COMBO10_PAT.length]; bot.lastAid = -1; bot.danceLeft = 2;
    c.attack = true; return;
  }
  if (H.state !== HERO_STATE.ACTION || !bot.seq || H.actionId === bot.lastAid || H.comboN >= bot.seq.length) return;
  bot.lastAid = H.actionId;
  const k = bot.seq[H.comboN];
  if (k === 'A') c.attack = true; else if (k === 'B') c.heavy = true; else if (H.wp) c.sweep = true; else c.attack = true;
}
// ?rec=1&dance=1 (film k16, one-hand hero only): after every string the bot dances two footwork beats before the next
// one - guarded quickstep left / right / in / out around the foe, or an evasive roll through the flank - so the clip
// shows travel and spacing instead of a planted swing loop. Never fires near a telegraph (the parry reflex owns that).
const DANCE = recMode && qs.get('dance') === '1';
const DANCE_PAT = ['R', 'L', 'ROLL_R', 'F', 'L', 'B', 'ROLL_L', 'R'];
function danceStep(c, ux, uz, td, reach) {
  if (H.wp || H.state !== HERO_STATE.LOCO || !(bot.danceLeft > 0) || sim.frame < (bot.danceAt || 0)) return false;
  if (td > reach + 2.5 || H.stamina < 30 || (bot.at >= sim.frame && bot.at - sim.frame < 30)) return false;
  const k = DANCE_PAT[(bot.danceI = (bot.danceI || 0) + 1) % DANCE_PAT.length];
  const px = -uz, pz = ux;                       // perpendicular to the foe line
  if (k === 'R') { c.mx = px; c.mz = pz; c.dodge = true; }
  else if (k === 'L') { c.mx = -px; c.mz = -pz; c.dodge = true; }
  else if (k === 'F') { c.mx = ux; c.mz = uz; c.dodge = true; }
  else if (k === 'B') { c.mx = -ux; c.mz = -uz; c.dodge = true; }
  else { const s = k === 'ROLL_R' ? 1 : -1, rx = px * s + ux * 0.35, rz = pz * s + uz * 0.35, rl = Math.hypot(rx, rz) || 1;
    c.mx = rx / rl; c.mz = rz / rl; c.roll = true; }
  c.speed = SIM.RUN_SPEED; bot.danceLeft--; bot.danceAt = sim.frame + 34;
  return true;
}
function comboPress(c) {
  if (COMBO10) { combo10Press(c); return; }
  if (H.state === HERO_STATE.LOCO) {
    if (H.stamina < 58) return;
    let k = COMBO_PAT[bot.pat++ % COMBO_PAT.length]; if ((k === 'S' || k === 'M') && !H.wp) k = 'L';
    bot.cur = k;
    if (k === 'L' || k === 'M') c.attack = true; else if (k === 'S') c.sweep = true; else { c.heavy = true; c.heavyHeld = true; bot.hold = 62; }
  } else if (H.state === HERO_STATE.ACTION) {
    if (bot.cur === 'L') c.attack = true; else if (bot.cur === 'S' || bot.cur === 'M') c.sweep = true;
  }
}
const VERB_IDX = { LIGHT_1: 1, LIGHT_2: 2, LIGHT_3: 3, HEAVY: 4, SWEEP: 5, SWEEP_REV: 6, D_L1: 7, D_L2: 8, D_L3: 9, D_L4: 10, D_L5: 11, D_H1: 12, D_H2: 13, WAVE: 14, LEAP: 15, J_LIGHT: 16, J_HEAVY: 17, JUMP_IN: 18, STEP_CUT: 19, J_LIGHT2: 20, J_LIGHT3: 21, RISER: 22, BACK_CUT: 23, Q_L1: 24, Q_L2: 25, Q_L3: 26, Q_L4: 27, Q_L5: 28 };
// v2.36 Vesper has no jump clip: the air verbs reuse existing clips (clip, clip-time window in s) sampled across the verb
// v2.37: every cut in the air string samples a different clip, so no two cuts in a row share an animation.
// 4th value = the clip time of the strike itself (measured with tipScanStd: where the blade tip actually travels),
// pinned to the first active frame. Before this the windows were sampled linearly and the blade came through
// 8-20 frames after the hit (mh_slam hit at f35 of a 46-frame plunge whose contact is f14).
// QA sheet t5: mh_slam is a two-hander clip whose tip ends 0.39 m under the floor (the sabre vanished on landing), so
// the plunge stops at 1.74 s (tip 0.4 m up); dz_l4 comes DOWN from 0.43 s to 0.75 s, so the crescent leaves at 0.64 s.
const AIR_POSE = { J_LIGHT: ['rising_slash', 0.78, 1.5, 1.1], J_HEAVY: ['mh_slam', 0.8, 1.8, 1.74], JUMP_IN: ['mh_slam', 0.6, 1.8, 1.74], STEP_CUT: ['phantom_spin', 0.0, 1.15, 0.5],
  RISER: ['rising_slash', 0.72, 1.5, 1.12], J_LIGHT2: ['phantom_spin', 0.2, 1.0, 0.5], J_LIGHT3: ['mh_judgment', 0.72, 1.5, 1.08], BACK_CUT: ['dz_l4', 0.16, 1.0, 0.75] };   // t6: pinned at 0.64 the blade was still coming down 6 frames after the release
const JUMP_POSE = ['mh_rising', 0.35, 1.25];   // take-off crouch -> rise -> tuck, held through the fall
// v2.37 air body + air cut crescents (presentation only, ?airbody=0 turns the body layer off). The air verbs borrow
// standing clips, so off the ground the knees tuck, the trunk commits (pitch, + = back) and the spin cut turns the
// whole body once inside its cancel window. Each air cut also throws one crescent from the blade (AIR_FX: tilt of
// the chord against the facing direction on screen, length in metres, bow depth, two = mirrored pair = a ring).
const AIR_ON = qs.get('airbody') !== '0';
// v2.37b (ref #17 sheets 02/03): the air string changes the body line on every cut - an upright twisting rise, a
// laid-out corkscrew toward the foe (cork: one roll about the facing axis inside the cancel window, legs trailing),
// a diagonal chop with the legs still out, then the tucked plunge. ?cork=0 restores the upright spin.
const CORK_ON = qs.get('cork') !== '0';
const AIR_BODY = { RISER: { pitch: 0.34, tuck: 0.95, lead: 1, drive: 1 }, J_LIGHT: { pitch: 0.1, tuck: 0.7, lead: 1 },
  J_LIGHT2: CORK_ON ? { pitch: -1.35, tuck: 0.1, cork: 1, lay: 1, lead: -1, fix: 1, split: 1 } : { pitch: 0, tuck: 0.9, spin: 1, lead: -1 },
  // t7: the plunge strode in the air (one knee up); sym = both legs fold back under the body, trunk dives
  // t12: the second and third air cuts both read as a laid-out plank; the third is now an upright diagonal chop,
  // lead knee driven up and the rear leg long (ref #17 sheet 02 row 3 tile 5), so the body line changes on every cut
  J_LIGHT3: { pitch: -0.28, tuck: 0.85, lead: 1, drive: 1 }, J_HEAVY: { pitch: 0, tuck: 1.05, lead: 1, flip: 1, knees: 1 } };   // z11: knelt in the air; now one tucked forward flip into the slam
// v2.37b back flip (ref #17: flip back out of reach, land, throw the crescent). The one-handed back quickstep tucks
// and turns once over its travel frames with a small hop. Presentation only: the sim step, its i-frames and its
// travel are unchanged, and the camera does not follow the hop. ?bflip=0 turns it off.
const BFLIP_ON = qs.get('bflip') !== '0';
const _chp = new THREE.Vector3();   // film camera subject: the hero with the air height damped
const BFLIP = { F0: 2, F1: 27, HOP: 0.95, TUCK: 1.1 };   // a1: lands on the cancel frame, straight into the cut
const bflip = { u: 0, on: false, h: 0 };
function bflipPhase(alpha) {
  bflip.on = BFLIP_ON && H.weapon < 1 && H.state === HERO_STATE.DODGE && H.stepKind === STEP_DIR.B && H.dodgeF >= 0;
  bflip.u = bflip.on ? Math.min(1, Math.max(0, (H.dodgeF + alpha - BFLIP.F0) / (BFLIP.F1 - BFLIP.F0))) : 0;
  return (bflip.h = bflip.on ? BFLIP.HOP * Math.sin(Math.PI * bflip.u) : 0);
}
// QA sheet t1: a mirrored pair read as a flat lens over the hero and 0.85 m ahead still covered the body from the
// over-shoulder lens, so every crescent is single and sits 1.35 m toward the target
// t12: lengths cut by about a fifth; at the closer air lens a 2.9 m arc ran past the frame edge
const AIR_FX = { RISER: { tilt: 1.1, len: 2.3, bend: 1 }, J_LIGHT: { tilt: -0.35, len: 2.1, bend: 0.9 }, J_LIGHT2: { tilt: -0.08, len: 2.1, bend: 0.8 },
  J_LIGHT3: { tilt: -0.75, len: 2.3, bend: 1 }, J_HEAVY: { tilt: 0, len: 2.8, bend: 1, slam: 1, lead: 5 }, STEP_CUT: { tilt: 1.0, len: 2.2, bend: 0.7 }, JUMP_IN: { tilt: 0.1, len: 2.5, bend: 1 } };
const airBody = { t: 0, p: 0, spin: 0, l: 1, ax: 1 };
function airSpinYaw(alpha) {
  airBody.spin = 0; airBody.a = alpha || 0;
  if (!AIR_ON || H.state !== HERO_STATE.ACTION) return 0;
  const A = AIR_BODY[H.verb]; if (!A || !A.spin) return 0;
  const u = Math.min(1, (H.actF + alpha) / Math.max(1, H.verbs[H.verb].chain[0]));
  return (airBody.spin = -2 * Math.PI * A.spin * u * u * (3 - 2 * u));
}
let qaPress = null;
let choreo = null;   // film v14 scripted-fight player (recording only, built by __ember.choreo)
function fillCommand() {
  const c = sim.cmd;
  c.mx = 0; c.mz = 0; c.speed = 0; c.attack = false; c.heavy = false; c.heavyHeld = false; c.dodge = false; c.roll = false; c.blockHeld = false; c.blockPress = false;
  c.snatch = false; c.trigger = false; c.sweep = false; c.jump = false;
  if (qaPress) { c[qaPress] = true; qaPress = null; return; }   // QA one-shot press (__ember.press), deterministic review states
  if (choreo && choreo.steps) { if (choreo.active) choreo.fill(c); return; }   // scripted take: the beat sheet owns the command
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
  else if (b === A.SNATCH && input.consumeBuffered(A.SNATCH)) c.snatch = true;
  else if (b === A.TRIGGER && input.consumeBuffered(A.TRIGGER)) c.trigger = true;
  else if (b === A.SWEEP && input.consumeBuffered(A.SWEEP)) c.sweep = true;
  else if (b === A.JUMP && input.consumeBuffered(A.JUMP)) c.jump = true;
  c.blockHeld = input.isHeld(A.BLOCK);
  c.heavyHeld = input.isHeld(A.HEAVY);            // charge: the swing holds at the top of its wind-up while held
  wasBlockHeld = c.blockHeld;
}

function fixedUpdate() {
  if (paused) return;
  input.fixedUpdate();
  prev.hx = H.x; prev.hz = H.z; prev.hy = H.y; prev.hyaw = H.yaw; prev.pdx = H.plantDX; prev.pdz = H.plantDZ;
  const B = sim.brain; prev.bx = B.x; prev.by = B.y; prev.bz = B.z; prev.byaw = B.yaw;
  { const G = sim.gauntlet, gp = gview.prev; gp.x = G.x; gp.y = G.y; gp.z = G.z; gp.yaw = G.yaw; }
  for (let i = 0; i < slots.length; i++) { const d = slots[i].bound; if (d) { dPrev[i].x = d.x; dPrev[i].z = d.z; dPrev[i].yaw = d.yaw; } }
  fillCommand();
  sim.step();
  if (sim.duelists.length && slots[0].bound !== sim.duelists[0]) bindSlots();
}

// ------------------------------------------------------------------ presentation
function lerpAngle(a, b, t) { let d = b - a; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; return a + d * t; }
const loco = { phase: 0, lastX: H.x, lastZ: H.z, gsHoldEnd: 0 };
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
    // trailer: no vanish puff (QA t6: dodge puffs stacked into a cloud that hid the hero); the ghosts carry the read
    if (!TRAILER && H.actF === 2 && ink.puffF !== sim.frame) { ink.puffF = sim.frame; fx.mist(H.x, colliders.terrainY(H.z) + 0.9, H.z, 0.5, MIST.WHITE, 9, 0.4); }
    if (!reducedMotion && H.actF >= 3 && H.actF <= 20 && (H.actF % 4) === 3 && ink.ghostF !== sim.frame) { ink.ghostF = sim.frame; fx.afterimage(HERO_ID, INK.GHOST, 0.55); }
  }
}
// v2.14 DMC layer presentation (studied from DMC5 Nero/Vergil + Shadow Zero Blade footage, docs/STYLE_SPEC.md).
// Read-only off the sim: snatch = a red streak of afterimages along the pull plus a landing ring; Ember Trigger =
// crimson aura motes + afterimage echoes while active, a shockwave burst on activation; rank-up = small warm flare.
// Edges are taken from sim counters (once per sim frame), so a render-rate change can never double-spawn.
const DMC = Object.freeze({ RED: 0xff3a20, AURA: 0xff5a2a, EMBER: 0xffb070 });
const dmc = { snatch: 0, trig: 0, trigF: -1, flash: -999, landF: -1, ghostF: -1, rimK: 0, rift: 0, riftFin: -1, riftLb: 0, wave: 0, waveSeg: 0, leapUp: -1, leapDn: -1,
  airFx: -1, airSlam: -1, wv: null, wvGen: -1, wvHits: 0, wvLive: false, wvX: 0, wvZ: 0, wvRot: 0, wvCol: 0xff6a2a };
const dmcView = {
  trigger: { on: false, gauge: 0, max: HERO_TRIGGER.MAX, cost: HERO_TRIGGER.COST, left: 0 },
  style: { rank: 0, letter: STYLE_RANKS[0], title: STYLE_TITLES[0], frac: 0, flashF: -999 },
};
const _dp = new THREE.Vector3();
// v2.21 Ember Rift presentation (Jessica13007 reference: Judgment-Cut-End). Space-cuts open as hairline blades on
// the target, crossed at deterministic angles (golden-angle walk on the cut index, no RNG); the finale is a
// sheathe click: everything still in range splits at once. Visuals only follow resolved hits (hitSink).
// trailer: the pale-cyan cut bloomed to near white in the ad review; a saturated cyan keeps the warm/cool split
const RIFT_COL = Object.freeze({ CUT: TRAILER ? 0x22b8ff : 0x9fe8ff, EDGE: 0xff4a2a, END: 0xffffff });
const _rv = new THREE.Vector3();
function riftHitFx(t, v) {
  const fin = v.name === 'RIFT_END', k = H.riftCuts;
  const sz = t.isBoss ? 4.2 : 2.6, n = fin ? 4 : 2;
  for (let i = 0; i < n; i++) {
    const a = (k * 2.39996 + i * (Math.PI / n)) % Math.PI;
    _rv.set(_p.x + Math.cos(a * 3.1) * 0.3, _p.y + (i - (n - 1) / 2) * 0.25, _p.z + Math.sin(a * 2.3) * 0.3);
    fx.riftSlash(_rv, sz * (fin ? 1.4 : 1), a - Math.PI / 2, i === 0 ? RIFT_COL.CUT : RIFT_COL.EDGE, fin ? i * 0.02 : i * 0.03, fin ? 0.5 : 0.3);
  }
  _n.set(0, 1, 0);
  fx.burstSparks(_p, _n, fin ? 1.4 : 0.5);
  if (!t.isBoss) fx.burstBlood(_p, _n, fin ? 1.3 : 0.6);
  fx.flare(_p, fin ? 1.8 : 0.8, fin ? (TRAILER ? trailerEdge() : RIFT_COL.END) : RIFT_COL.CUT);
  if (fin) {
    fx.shockwave(t.x, colliders.terrainY(t.z) + 0.24, t.z, t.isBoss ? 4.5 : 2.6, RIFT_COL.CUT, 1.0, 0.5);
    if (!reducedMotion) post.impactBlur(_p, 0.7);
  }
  if (t.isBoss && t.id === GAUNTLET_ID) gview.hit(H.facingX(), H.facingZ(), fin ? 1.2 : 0.35);
}
// v2.30 great sword wave slash + leap wheel presentation (state-driven, downstream of the sim; ref #12 colour roles:
// cyan-white fan and ground line for the wave, ember ring for the leap landing). Spawn caps: one fan per wave, one
// line segment every WAVE_SEG sim frames (<= 8 per wave, inside the 16-slot rift pool).
const WAVE_COL = { FAN: 0xbff4ff, LINE: 0x8fe6ff };
const WAVE_SEG = 3;
const WAVE_Y = 1.05;   // one-handed crescent rides at chest height
const _wv = new THREE.Vector3(), _vd = new THREE.Vector3();
const _afH = new THREE.Vector3(), _afT = new THREE.Vector3(), _afM = new THREE.Vector3(), _afA = new THREE.Vector3(), _afB = new THREE.Vector3();
const airTip = { p: new THREE.Vector3(), q: new THREE.Vector3(), f: -9, cont: false };   // blade tip, this sim frame and the last
const airCres = { id: -1, a: null, ga: -1, b: null, gb: -1, off: new THREE.Vector3() };   // the live air arc pair and its offset from the blade
// View-plane angle of a world ground direction (what FxPool cuts rotate in); a direction that points along the lens
// has no screen angle, so it falls back to up-right.
function viewBow(dx, dz) {
  _vd.set(dx, 0, dz).transformDirection(camera.matrixWorldInverse);
  return _vd.x * _vd.x + _vd.y * _vd.y < 0.04 ? 0.5 : Math.atan2(_vd.y, _vd.x);
}
// v2.37 air cuts: one crescent per air / step-in cut on its first active frame (<= 3 slots of the 16-slot pool);
// the plunge lands with an ember ring and a vertical cut. One-handed blades only.
function airFxLayer(dt) {
  if (dt <= 0 || H.weapon >= 1 || H.state !== HERO_STATE.ACTION) return;
  const v = H.verbs[H.verb], A = AIR_FX[H.verb];
  // lead: the plunge draws its arc while the hero is still falling, not after the landing
  if (!v || !A) return;
  const fxh = H.facingX(), fzh = H.facingZ(), gy = colliders.terrainY(H.z), col = TRAILER ? trailerEdge() : 0xff6a2a;
  const px = H.x + fxh * 1.6, pz = H.z + fzh * 1.6;   // QA sheet t4: at 1.35 m the spin and chop arcs still opened on the shoulder
  // t12 (review of takes t11/t12): the arcs opened 1.6 m ahead of the hero at an authored angle, so from a side lens
  // they floated beside him. Each arc now opens ON the blade: centred on its outer half, chord along the tip's own
  // travel on screen, bowed away from the body. A pinned clip whose tip is still falls back to the authored tilt.
  heroSword.hilt.getWorldPosition(_afH); heroSword.tip.getWorldPosition(_afT);
  if (airTip.f !== sim.frame) { airTip.cont = sim.frame - airTip.f <= 2; airTip.q.copy(airTip.p); airTip.p.copy(_afT); airTip.f = sim.frame; }
  if (H.actF >= v.startup - (A.lead || 0) + (A.slam ? 0 : 1) && dmc.airFx !== H.actionId) {
    dmc.airFx = H.actionId;
    let rot = viewBow(fxh, fzh) - Math.PI / 2 + A.tilt; dmc.cresD = 0.5;
    _afM.copy(_afH).lerp(_afT, 0.7);
    _afA.copy(airTip.q).project(camera); _afB.copy(airTip.p).project(camera);
    const sdx = (_afB.x - _afA.x) * camera.aspect, sdy = _afB.y - _afA.y;
    if (airTip.cont && sdx * sdx + sdy * sdy > 1.5e-4) {
      rot = Math.atan2(sdy, sdx); dmc.cresD = 1;
      if (heroBones.Hips) { heroBones.Hips.getWorldPosition(_afA).project(camera); _afB.copy(_afM).project(camera);
        if (-Math.sin(rot) * (_afB.x - _afA.x) * camera.aspect + Math.cos(rot) * (_afB.y - _afA.y) < 0) rot += Math.PI; }
    }
    // the bowed arc peaks 0.15 len from the quad centre: pull the quad back so the peak sits on the blade
    _afA.setFromMatrixColumn(camera.matrixWorld, 0); _afB.setFromMatrixColumn(camera.matrixWorld, 1);
    const off = -0.15 * A.len * A.bend;
    _wv.copy(_afM).addScaledVector(_afA, -Math.sin(rot) * off).addScaledVector(_afB, Math.cos(rot) * off);
    const c0 = fx.crescent(_wv, A.len, rot, col, 0, A.slam ? 0.24 : 0.18, A.bend, 3.2);   // t12: shorter, thicker, gone before the next cut
    const c1 = fx.crescent(_wv, A.len * 0.78, rot, TRAILER ? trailerCore(col) : 0xffd9a8, 0.016, 0.14, A.bend, 1.6);
    airCres.id = H.actionId; airCres.a = c0 || null; airCres.ga = c0 ? c0.gen : -1; airCres.b = c1 || null; airCres.gb = c1 ? c1.gen : -1; airCres.off.copy(_wv).sub(_afM);
  }
  // t12b: the hero travels up to 2 m while an arc is alive, so a world-anchored arc was left hanging beside him.
  // For its first 0.1 s the arc rides the blade; after that (or once the next cut starts) it stays where it is.
  if (airCres.id === H.actionId) {
    _afM.copy(_afH).lerp(_afT, 0.7).add(airCres.off);
    if (airCres.a && airCres.a.gen === airCres.ga && airCres.a.live && airCres.a.t < 0.1) airCres.a.g.position.copy(_afM);
    if (airCres.b && airCres.b.gen === airCres.gb && airCres.b.live && airCres.b.t < 0.1) airCres.b.g.position.copy(_afM);
  }
  // the plunge lands: ember ring + sparks on its first active frame
  if (A.slam && H.actF >= v.startup && dmc.airSlam !== H.actionId) {
    dmc.airSlam = H.actionId;
    // t12: the landing read as one flat ring beside the hero. The ring now opens under the blade tip itself, a
    // wider slower ring follows it out, and the strike point gets a flare and a larger spark burst.
    const sx = _afT.x, sz = _afT.z;
    fx.shockwave(sx, gy + 0.06, sz, 2.2, col, 0.7, 0.4); fx.shockwave(sx, gy + 0.05, sz, 3.6, col, 0.4, 0.62);
    _wv.set(sx, gy + 0.2, sz); _n.set(0, 1, 0); fx.burstSparks(_wv, _n, 2.0); fx.flare(_wv, 1.3, col);
    cam.impact('heavy');
  }
}
function greatXLayer(dt) {
  if (dt <= 0) return;
  const W = H.wave;
  if (H.waves !== dmc.wave) {
    dmc.wave = H.waves; const gy = colliders.terrainY(W.z);
    _wv.set(H.x + W.dx * 0.9, gy + 0.35, H.z + W.dz * 0.9);
    // v2.37: the one-handed BACK_CUT crescent is ember coloured and smaller than the two-hander wave
    const one = H.weapon < 1; dmc.waveFan = one ? 0xffb078 : WAVE_COL.FAN; dmc.waveLine = one ? 0xff6a2a : WAVE_COL.LINE; dmc.waveK = one ? 0.7 : 1;
    if (one) {
      // a standing crescent that leaves the blade and flies: one held slot rides the sim wave, a hot inner arc
      // marks the release, and a fading copy is dropped every WAVE_SEG frames as its wake
      const col = TRAILER ? trailerEdge() : 0xff6a2a; dmc.wvCol = col; dmc.wvRot = viewBow(W.dx, W.dz) - Math.PI / 2;
      // QA sheet t2: it popped in a body-width ahead; it now opens at the blade (0.35 m) and is 3.4 m tall
      // t7: it still popped in half a body-width ahead at chest height. It now opens ON the sword tip: the offset
      // from the sim wave line to the tip is kept and fades out over the first 2.5 m of flight. The smaller hot
      // inner arc read as a second crescent beside the first, so it is gone.
      heroSword.tip.getWorldPosition(_wv);
      dmc.wvOx = _wv.x - H.x; dmc.wvOz = _wv.z - H.z; dmc.wvOy = Math.max(-0.5, Math.min(0.9, _wv.y - (gy + WAVE_Y)));
      _wv.set(H.x + dmc.wvOx, gy + WAVE_Y + dmc.wvOy, H.z + dmc.wvOz); dmc.wvHits = H.waveHits;
      // QA sheet t4: 3.4 m read as twice the hero; a thrown crescent is about 1.4 hero heights
      dmc.wv = fx.crescent(_wv, 3.1, dmc.wvRot, col, 0, 0.3, 1, 3.0); dmc.wvGen = dmc.wv ? dmc.wv.gen : -1; fx.flare(_wv, 1.0, col);
      fx.shockwave(H.x + W.dx * 0.35, gy + 0.06, H.z + W.dz * 0.35, 1.1, col, 0.4, 0.3);
    } else {
      fx.riftSlash(_wv, 3.4 * dmc.waveK, 0.08, dmc.waveFan, 0, 0.3); fx.riftSlash(_wv, 2.4 * dmc.waveK, 0.1, 0xffffff, 0.02, 0.2);
      fx.shockwave(_wv.x, gy + 0.06, _wv.z, 1.6 * dmc.waveK, dmc.waveLine, 0.5, 0.35);
    }
    cam.impact(one ? 'light' : 'heavy'); dmc.waveSeg = sim.frame;
  }
  if (W.live) {
    const px = W.x + W.dx * W.d, pz = W.z + W.dz * W.d, gy = colliders.terrainY(pz), one = dmc.waveK < 1;
    if (one && dmc.wv && dmc.wv.live && dmc.wv.gen === dmc.wvGen) {
      dmc.wvRot = viewBow(W.dx, W.dz) - Math.PI / 2;
      const ok = Math.max(0, 1 - W.d / 2.5);   // blade-tip offset fades out as it flies
      dmc.wv.g.position.set(px + (dmc.wvOx || 0) * ok, gy + WAVE_Y + (dmc.wvOy || 0) * ok, pz + (dmc.wvOz || 0) * ok); dmc.wv.hold = 0.08; dmc.wv.m.uniforms.uRot.value = dmc.wvRot;
    }
    // the crescent bites: flare + sparks + a crossed cut on the frame the sim wave first touches a target
    if (one && H.waveHits !== dmc.wvHits) {
      dmc.wvHits = H.waveHits; _wv.set(px, gy + WAVE_Y + 0.2, pz);
      fx.flare(_wv, 1.5, dmc.wvCol); _n.set(0, 1, 0); fx.burstSparks(_wv, _n, 1.3);
      fx.riftSlash(_wv, 3.2, dmc.wvRot + 0.6, dmc.wvCol, 0, 0.24); fx.shockwave(px, gy + 0.08, pz, 2.6, dmc.wvCol, 0.9, 0.4); cam.impact('heavy'); if (!reducedMotion) post.kick(0.1, dmc.wvCol);
    }
    if (sim.frame - dmc.waveSeg >= WAVE_SEG) {
      dmc.waveSeg = sim.frame;
      // t6: the wake copies read as three separate arcs, so the one-handed crescent flies alone (splash only)
      if (!one) { _wv.set(px, gy + 0.12, pz); fx.riftSlash(_wv, 1.9 * (dmc.waveK || 1), 0.02, dmc.waveLine || WAVE_COL.LINE, 0, 0.4); }
      if (!reducedMotion) fx.splash(px, pz, 0.35);
    }
    dmc.wvLive = one; dmc.wvX = px; dmc.wvZ = pz;
  } else if (dmc.wvLive) {
    // the crescent lands (or runs out of range): a crossed cut and sparks where it stopped
    // v2.37: the one-handed crescent stops on the first foe it bites, so the sim line is already dead on the hit
    // frame and the bite is drawn here (QA sheet t5: bite + landing both fired and the arc hung on the wing for 10 frames)
    dmc.wvLive = false;
    const ex = W.x + W.dx * W.d, ez = W.z + W.dz * W.d; _wv.set(ex, colliders.terrainY(ez) + WAVE_Y, ez);
    if (dmc.wv && dmc.wv.live && dmc.wv.gen === dmc.wvGen) { dmc.wv.g.position.copy(_wv); dmc.wv.hold = 0; dmc.wv.t = Math.max(dmc.wv.t, dmc.wv.life * 0.6); }
    if (H.waveHits !== dmc.wvHits) {
      dmc.wvHits = H.waveHits; _wv.y += 0.2;
      fx.riftSlash(_wv, 2.8, dmc.wvRot + 0.55, dmc.wvCol, 0, 0.16); fx.riftSlash(_wv, 2.8, dmc.wvRot - 0.55, 0xffffff, 0.02, 0.12);
      fx.flare(_wv, 1.6, dmc.wvCol); _n.set(0, 1, 0); fx.burstSparks(_wv, _n, 1.6); fx.shockwave(ex, _wv.y - WAVE_Y - 0.12, ez, 2.6, dmc.wvCol, 0.9, 0.4); cam.impact('heavy'); if (!reducedMotion) post.kick(0.1, dmc.wvCol);
    } else fx.flare(_wv, 0.7, dmc.wvCol);
  }
  // leap: dust ring on take-off, ember ring + slam on landing (first ACTIVE frame)
  if (H.state === HERO_STATE.ACTION && H.verb === 'LEAP') {
    const v = H.verbs.LEAP, a0 = v.startup - v.leap.air;
    if (H.actF === a0 + 1 && dmc.leapUp !== H.actionId) { dmc.leapUp = H.actionId; fx.shockwave(H.x, colliders.terrainY(H.z) + 0.05, H.z, 1.2, 0xc8b8a0, 0.35, 0.3); }
    if (H.actF === v.startup && dmc.leapDn !== H.actionId) {
      dmc.leapDn = H.actionId; const gy = colliders.terrainY(H.z);
      fx.shockwave(H.x + H.facingX() * 1.2, gy + 0.06, H.z + H.facingZ() * 1.2, 2.6, 0xff8a3a, 0.8, 0.45);
      cam.impact('slam'); if (!reducedMotion) post.kick(0.12, 0xffb070);
    }
  }
}
// state-driven layer: dark settle on activation, cut ticks, sheathe finale (flash, slam, ring, freeze), letterbox
function riftLayer(dt) {
  const R = HERO_RIFT, on = H.state === HERO_STATE.RIFT;
  if (H.rifts !== dmc.rift) {
    dmc.rift = H.rifts;
    const gy = colliders.terrainY(H.z);
    hud.cue('EMBER RIFT', 'perfect');
    fx.shockwave(H.x, gy + 0.08, H.z, R.RANGE, RIFT_COL.CUT, 0.6, 0.6);
    // v2.21 QA: a chest-height 14-puff mist washed over both targets. v2.22 QA: the low ankle puff that replaced it
    // put its camera-facing sprites through the ground plane (hard straight bottom edge) - removed; the shockwave
    // ring already marks the plant.
    if (!reducedMotion) { post.kick(0.2, 0x2a3c60); loop.dilate(0.2, 8, true); cam.triggerPush(); }
  }
  if (on && H.riftF === R.FINALE && dmc.riftFin !== sim.frame && dt > 0) {
    dmc.riftFin = sim.frame;
    const gy = colliders.terrainY(H.z);
    // the clean sheathe: a ring of cuts around the hero (reads as "everything in range splits"), one white pulse
    for (let i = 0; i < 6; i++) {
      const a = i * (Math.PI * 2 / 6) + 0.4, rr = R.RANGE * 0.55;
      _rv.set(H.x + Math.cos(a) * rr, gy + 1.0 + (i % 2) * 0.6, H.z + Math.sin(a) * rr);
      fx.riftSlash(_rv, 5.5, a * 1.7, i % 2 ? RIFT_COL.EDGE : RIFT_COL.CUT, 0.03 + i * 0.015, 0.45);
    }
    fx.shockwave(H.x, gy + 0.08, H.z, R.RANGE + 1, TRAILER ? RIFT_COL.CUT : RIFT_COL.END, 1.2, 0.55);
    if (TRAILER) {   // v2.26 trailer: the sheathe pulse is the blade's colour, plus a second ring and a slower freeze
      const ec = trailerEdge(); fx.shockwave(H.x, gy + 0.1, H.z, R.RANGE * 0.6, ec, 1.4, 0.7);
      for (let i = 0; i < 3; i++) { _rv.set(H.x, gy + 1.1 + i * 0.35, H.z); fx.riftSlash(_rv, 11 + i * 2, -0.35 + i * 0.4, i === 1 ? RIFT_COL.CUT : ec, 0.06 + i * 0.03, 0.55); }
      if (!reducedMotion) { post.kick(0.4, ec); post.impactBlur(_rv, 0.8); loop.dilate(0.05, 14, true); cam.impact('slam'); }
    } else {
    hud.flash(reducedMotion ? 0.1 : 0.3);
    if (!reducedMotion) { post.kick(0.36, 0xdff4ff); loop.dilate(0.05, 10, true); cam.impact('slam'); }
    }
  }
  // letterbox weight eases in over the startup and out after the finale (read by the per-frame letterbox call)
  const want = on && H.riftF < R.FINALE + 10 ? 1 : 0;
  if (dt > 0) dmc.riftLb += (want - dmc.riftLb) * Math.min(1, dt * (want ? 10 : 5));
  if (dmc.riftLb < 0.01) dmc.riftLb = 0;
}
function dmcLayer(dt) {
  riftLayer(dt); greatXLayer(dt); airFxLayer(dt);
  // HUD view (allocation-free)
  const T = dmcView.trigger, Sm = sim.style, V = dmcView.style;
  T.on = H.triggerF > 0; T.gauge = H.gauge;
  if (T.on && dmc.trigF < 0) dmc.trigF = H.triggerF;           // full duration at activation, for the drain bar
  if (!T.on) dmc.trigF = -1;
  T.left = T.on ? H.triggerF / Math.max(1, dmc.trigF) : 0;
  V.rank = Sm.rank; V.letter = Sm.letter; V.title = Sm.title; V.frac = Sm.frac; V.flashF = Sm.flashF;
  if (dt <= 0) return;
  const gy = colliders.terrainY(H.z);
  // snatch start: a red flare at the hero, afterimage streak every 3 sim frames through the travel window
  if (H.snatches !== dmc.snatch) { dmc.snatch = H.snatches; _dp.set(H.x, gy + 1.0, H.z); fx.flare(_dp, 0.7, DMC.RED); }
  // v2.34 flash step: warm afterimage streak every 2 sim frames through the dash (presentation only)
  if (!reducedMotion && H.flashF > HERO_FLASH.STARTUP && (H.flashF % 2) === 0 && dmc.flashGhostF !== sim.frame) { dmc.flashGhostF = sim.frame; fx.afterimage(HERO_ID, 0xffb050, 0.6); }
  if (H.state === HERO_STATE.SNATCH) {
    const tf = H.snatchF - HERO_SNATCH.STARTUP;
    if (!reducedMotion && tf >= 0 && tf <= HERO_SNATCH.TRAVEL_MAX && (tf % 3) === 0 && dmc.ghostF !== sim.frame) { dmc.ghostF = sim.frame; fx.afterimage(HERO_ID, DMC.RED, 0.7); }
    if (tf === HERO_SNATCH.TRAVEL_MAX + 1 && dmc.landF !== sim.frame) {
      // landing (frame study C/E5): ground ring + white-core spark at chest height + a 4-frame presentation hitstop
      dmc.landF = sim.frame; fx.shockwave(H.x, gy + 0.06, H.z, 1.6, DMC.RED, 0.7, 0.3);
      _dp.set(H.x, gy + 1.2, H.z); fx.flare(_dp, 0.6, 0xff8a2a);
      if (!reducedMotion) { loop.dilate(0.1, 4, true); cam.impact('light'); }
    }
  }
  // trigger activation (frame study B/E4): white-crimson flash, 6-frame near-freeze, camera push-in, burst ring
  if (H.triggers !== dmc.trig) {
    dmc.trig = H.triggers;
    fx.shockwave(H.x, gy + 0.08, H.z, HERO_TRIGGER.BURST_R + 1.3, 0xc8102e, 1.2, 0.5);
    // flare sits behind the hero's shoulder line (not on the torso) and stays small, so the activation frame
    // keeps the legs and stance readable; the screen kick is a short crimson tint, not a white-out
    _dp.set(H.x, gy + 1.9, H.z); fx.flare(_dp, 0.75, 0xff9a7a);
    if (!reducedMotion) { post.kick(0.28, 0xff6a50); loop.dilate(0.05, 6, true); cam.triggerPush(); }
  }
  // aura while active: sparse low-alpha crimson puffs at the hip line (cap ~1.3x hero height), so the
  // silhouette and stance stay readable; the rim (below) carries the "powered up" read on the body itself
  if (H.triggerF > 0) {
    // trailer: no hip puffs (they read as muddy smoke at the promo lens); the rim + afterimages carry the read
    if (!TRAILER && (sim.frame % 8) === 0 && dmc.ghostF !== sim.frame) { dmc.ghostF = sim.frame; fx.mist(H.x, gy + 1.0, H.z, 0.32, MIST.CRIMSON, 2, 0.8); }
    if (!reducedMotion && H.speed > 2.5 && (sim.frame % 6) === 1) fx.afterimage(HERO_ID, 0xc8202e, 0.3);
  }
  // crimson rim on the hero while the trigger runs (uniform only - same program, no recompile)
  // ?trim=0 (trailer only, visual): keep the standing rim during the trigger - in vertical ad crops the crimson
  // rim read as a second, red hero cutting in (review 11-07); the trigger sim itself is unchanged
  const rk = H.triggerF > 0 && !(TRAILER && qs.get('trim') === '0') ? 1 : 0;
  if (RIM_ON && rk !== dmc.rimK) {
    dmc.rimK = rk;
    if (rk) heroRim.value.setRGB(1.1, 0.10, 0.05);
    else { const R = (STAGE_RIM[arena] || STAGE_RIM.ford).hero; heroRim.value.setRGB(R[0], R[1], R[2]); }
  }
  // v2.26 trailer: a standing rim + foot haze in the blade's colour so the hero always reads as powered and lit
  if (TRAILER) {
    // QA ad takes: the dark-cloaked hero sank into the brown wyvern at 0.55; ?rimg= sets the standing rim gain
    // ?hrim=<hex> gives the standing rim its own colour (the slash hue stays on trailerEdge)
  if (RIM_ON && !rk) { _auraC.setHex(TRL_HRIM >= 0 ? TRL_HRIM : trailerEdge()); heroRim.value.setRGB(_auraC.r * TRL_RIMG, _auraC.g * TRL_RIMG, _auraC.b * TRL_RIMG); dmc.rimK = -1; }
    trailerAura(gy);
  }
  // rank up: small warm flare over the hero's shoulder
  if (Sm.flashF !== dmc.flash) { dmc.flash = Sm.flashF; if (Sm.rank >= 3) { _dp.set(H.x, gy + 2.0, H.z); fx.flare(_dp, 0.5 + Sm.rank * 0.1, DMC.EMBER); } }
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
  const show = INK_ON && (sim.state === GameState.WAVE || sim.state === GameState.BOSS || sim.state === GameState.STAGE2) && H.alive && cam.target && (lockOn || camTarget.isBoss) && !cam.cineActive;
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
const bossReact = { amp: 0, t: 9, dx: 0, dz: 1, flash: 0, look: 0, rear: 0, side: 1, lastClip: '' };
const chargeFx = { wasFull: false, glow: 0 };
const lean = { sp: 0, yaw: 0, p: 0, r: 0 }; const _ax2 = new THREE.Vector3();
HB.sp = heroBones.Spine;
// swing drive: the torso coils against the swing over the last 14 f of startup, whips through the active window and
// overshoots on a damped spring in recovery. Swing direction is measured from the blade tip's lateral travel during
// the active window (sign learned per verb), so the layer always amplifies the authored arc instead of fighting it.
const swing = { sign: { LIGHT_1: 0, LIGHT_2: 0, LIGHT_3: 0, HEAVY: 0 }, lat: 0, acc: 0, aid: -1, learned: false };
function swingDrive(dt, fx_, fz_) {
  // Full-body authored arcs already coil and release. A sign learned from the
  // previous variant can oppose the next cut, so do not add a second drive.
  if (H.state !== HERO_STATE.ACTION || H.charging || !(H.verb in swing.sign) ||
      (qs.get('feel') !== '0' && heroLightVar())) { swing.aid = -1; return; }
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
    // great sword combo variety: roll the torso about the facing axis so the same two-handed chop lands as a
    // diagonal cut (LIGHT_2 right-high to left-low, LIGHT_3 the mirror). Arms and blade ride the spine; the grip IK
    // runs after this, so both hands stay on the hilt. Presentation only.
    const g = H.weapon >= 1 && GS_SET[H.verb];
    if (g && g.roll && !heroLightVar()) {   // v2.32 variant arcs are authored diagonals already
      const ramp = f < a ? f / Math.max(1, a) : f < e + 6 ? 1 : Math.max(0, 1 - (f - e - 6) / 20);
      const r = g.roll * Math.sin(Math.min(1, ramp) * Math.PI * 0.5);
      _ax2.set(fx_, 0, fz_); rotWorld(HB.s2, _ax2, r * 0.45); rotWorld(HB.s1, _ax2, r * 0.55);
    }
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
  // v2.37 air body: off the ground the trunk commits and the knees tuck (lead knee up, rear heel back), eased in
  // and out with height, so an air cut no longer reads as a standing clip lifted off the floor
  if (AIR_ON) {
    const A = H.state === HERO_STATE.ACTION ? AIR_BODY[H.verb] : null, up = Math.min(1, Math.max(0, (H.y || 0) / (A && A.drive ? 0.12 : 0.45)));
    const k = dt > 0 ? Math.min(1, dt * 16) : 0;
    const fT = bflip.on ? BFLIP.TUCK * Math.min(1, 2.4 * Math.sin(Math.PI * Math.min(1, bflip.u / 0.9))) : 0;   // t10: tucked by 15% of the flip, held to 85%
    airBody.t += ((A ? A.tuck * up : fT) - airBody.t) * k; airBody.p += ((A ? A.pitch * up : 0) - airBody.p) * k;
    airBody.lay = (airBody.lay || 0) + ((A && A.lay ? A.lay * up : 0) - (airBody.lay || 0)) * (A && A.lay ? k : Math.min(1, k * 2));   // t10: the plunge opened laid out flat
    // the spin cut turns the whole model, so the tuck axis turns with it (else the legs splay sideways mid-spin)
    // QA sheet t5: the borrowed clips yaw the hips away from the sim facing (the chop stood in a wide A-stance, the
    // spin strode), so the tuck axis is the body's own right axis: hip joint to hip joint, read from the posed skeleton
    _ax2.copy(_ax);
    if (A && heroBones.LeftUpLeg && heroBones.RightUpLeg) {
      heroBones.LeftUpLeg.getWorldPosition(_alA); heroBones.RightUpLeg.getWorldPosition(_alB);
      _alB.sub(_alA).multiplyScalar(AIR_AXIS_SIGN); if (_alB.lengthSq() > 1e-6) _ax2.copy(_alB.normalize());
    } else if (airBody.spin) _ax2.applyAxisAngle(UP, airBody.spin);
    airBody.ax = _ax2.x * _ax.x + _ax2.z * _ax.z;
    if (Math.abs(airBody.p) > 0.005) rotWorld(heroBones.Hips, A && A.fix ? _ax : _ax2, airBody.p);
    // lead leg: each cut names the knee that comes up, so the legs scissor between cuts instead of freezing
    airBody.l += ((A ? (A.lead || 1) : airBody.l) - airBody.l) * k;
    airBody.s = (airBody.s || 0) + ((A && A.sym ? 1 : 0) - (airBody.s || 0)) * k;
    const t = airBody.t;
    if (t > 0.01 || airBody.lay > 0.01) {
      const w = Math.max(airBody.lay || 0, Math.min(1, t / 0.5)); let sL = (airBody.l + 1) * 0.5, sR = 1 - sL;
      sL += (0.12 - sL) * airBody.s; sR += (0.12 - sR) * airBody.s;
      for (let i = 0; i < 4; i++) { const b = heroBones[AIR_LEGS[i]]; if (b && airLegRest[i]) b.quaternion.slerp(airLegRest[i], w); }
      const bw = (airBody.b = (airBody.b || 0) + ((bflip.on || (A && A.knees) ? 1 : 0) - (airBody.b || 0)) * Math.min(1, k * 1.5)), nb = 1 - bw;
      const dv = (airBody.d = (airBody.d || 0) + ((A && A.drive ? 1 : 0) - (airBody.d || 0)) * k);   // a2: the launcher's legs just hung
      const uL = -0.3 + (1.35 + 0.55 * dv) * sL, uR = -0.3 + (1.35 + 0.55 * dv) * sR, lL = -1.1 - 0.4 * sL + 0.8 * dv * (1 - sL), lR = -1.1 - 0.4 * sR + 0.8 * dv * (1 - sR);
      rotWorld(heroBones.LeftUpLeg, _ax2, (uL * nb + 2.1 * bw) * t); rotWorld(heroBones.LeftLeg, _ax2, (lL * nb - 2.3 * bw) * t);
      rotWorld(heroBones.RightUpLeg, _ax2, (uR * nb + 2.1 * bw) * t); rotWorld(heroBones.RightLeg, _ax2, (lR * nb - 2.3 * bw) * t);
      // t12: the laid-out corkscrew flew with both legs together like a plank; ref #17 scissors them into a V
      // (lead thigh forward, rear thigh back with the heel folded)
      const sv = (airBody.v = (airBody.v || 0) + ((A && A.split ? A.split : 0) - (airBody.v || 0)) * k) * (airBody.lay || 0);
      if (sv > 0.01) { rotWorld(heroBones.LeftUpLeg, _ax2, (1.15 * sL - 0.5) * sv); rotWorld(heroBones.LeftLeg, _ax2, -0.9 * (1 - sL) * sv);
        rotWorld(heroBones.RightUpLeg, _ax2, (1.15 * sR - 0.5) * sv); rotWorld(heroBones.RightLeg, _ax2, -0.9 * (1 - sR) * sv); }
      if (bw > 0.02) { const c = bw * Math.min(1, t); rotWorld(HB.sp, _ax2, -0.2 * c); rotWorld(HB.s1, _ax2, -0.4 * c); rotWorld(HB.s2, _ax2, -0.4 * c); }
    }
    // corkscrew: one roll about the line to the foe, done by the cancel frame so the next cut starts square
    if (A && A.cork) { const u = Math.min(1, (H.actF + (airBody.a || 0)) / Math.max(1, H.verbs[H.verb].chain[0]));
      _alA.set(0, 1, 0).applyAxisAngle(_ax, airBody.p); rotWorld(heroBones.Hips, _alA, 2 * Math.PI * A.cork * u * u * (3 - 2 * u)); }
    // plunge flip: one forward turn about the hips between the hang and the landing, square again 2 frames before the floor
    if (A && A.flip) { const vv = H.verbs[H.verb], u = Math.min(1, Math.max(0, (H.actF + (airBody.a || 0) - 1) / Math.max(1, vv.startup - 3)));
      if (u > 0 && u < 1) { _ax.set(-fz_, 0, fx_); rotWorld(heroBones.Hips, _ax, -2 * Math.PI * A.flip * (0.4 * u + 0.6 * u * u * (3 - 2 * u))); } }
  }
  // v2.37b back flip: one backward turn about the hips over the travel frames of the back quickstep
  if (bflip.on && bflip.u > 0 && bflip.u < 0.85) { const u = Math.min(1, bflip.u / 0.85), sm = u * u * (3 - 2 * u); _ax.set(-fz_, 0, fx_); rotWorld(heroBones.Hips, _ax, 2 * Math.PI * (0.45 * u + 0.55 * sm));
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
  for (let i = 0; i < genMats.hero.length; i++) genMats.hero[i].emissive.setRGB(0.6 * chargeFx.glow, 0.22 * chargeFx.glow, 0.05 * chargeFx.glow);
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
  // t13 (bodyprobe on the film15 plunge): the hero lands at the wyvern's feet and its low tracking head sat inside
  // the crouched hero (head bones 0.09 m apart on the landing hold). On grounded idle beats the neck rears up and
  // back while the hero is under the head, and the head tips back down to keep its eyes on him. Presentation only.
  let rearW = 0;
  if (idle && !B.airborne && HEAD) {
    HEAD.getWorldPosition(_a);   // this frame's authored pose, read before the look / yield layers move it
    const hx = H.x - B.x, hz = H.z - B.z;
    const reach = Math.hypot(_a.x - B.x, _a.z - B.z), hdist = Math.hypot(hx, hz);
    // the look layer swings the head onto the hero's bearing, so what matters is how close he is to the head's reach
    const hd = Math.abs(want) < 0.54 ? Math.abs(hdist - reach) : Math.hypot(_a.x - H.x, _a.z - H.z);
    if (_a.y < colliders.terrainY(H.z) + (H.y || 0) + 2.6) rearW = Math.max(0, Math.min(1, (2.1 - hd) / 0.8));
    // side: the one that carries the head off the hero ON SCREEN. World clearance alone was not enough: at 0.7 m the
    // head still sat between the film camera and the crouched hero and hid his face.
    if (bossReact.rear < 0.02 && rearW > 0) {
      BB.n1.getWorldPosition(_b); _dir.setFromMatrixColumn(camera.matrixWorld, 0);
      const lat = (_a.x - H.x) * _dir.x + (_a.z - H.z) * _dir.z;        // head left / right of the hero on screen
      const mv = (_a.z - _b.z) * _dir.x - (_a.x - _b.x) * _dir.z;       // screen-x travel of the head per +yaw (UP x neck)
      bossReact.side = ((Math.abs(lat) > 0.1 ? lat : 1) * mv) >= 0 ? 1 : -1;
    }
  }
  bossReact.rear += (rearW - bossReact.rear) * Math.min(1, dt * (rearW > bossReact.rear ? 10 : 6));
  if (bossReact.rear > 1e-3) {
    const r = bossReact.rear * bossReact.rear * (3 - 2 * bossReact.rear), sd = bossReact.side;
    // the neck swings aside (about 1.3 m at the head) and lifts a little; the head turns back to keep its eyes on him
    rotWorld(BB.n1, UP, 0.34 * r * sd); rotWorld(BB.n3, UP, 0.34 * r * sd); rotWorld(BB.n5, UP, 0.18 * r * sd); rotWorld(BB.head, UP, -0.66 * r * sd);
    _ax.set(-B.forwardZ(), 0, B.forwardX()); rotWorld(BB.n1, _ax, 0.2 * r); rotWorld(BB.n3, _ax, 0.16 * r);
  }
  // hit recoil: the neck chain rears away from the blade, spine flinches; emissive flash on the hide
  bossReact.t += dt;
  if (bossReact.amp > 0.01) {
    const s = bossReact.amp * Math.exp(-bossReact.t * 6.5) * Math.cos(bossReact.t * 15);
    _ax.set(bossReact.dz, 0, -bossReact.dx);
    // t7: at fight distance the 0.05 rad flinch was invisible (QA: "the dragon shows no reaction"), gains x1.7
    rotWorld(BB.s2, _ax, 0.10 * s); rotWorld(BB.n1, _ax, 0.17 * s); rotWorld(BB.n3, _ax, 0.17 * s); rotWorld(BB.n5, _ax, 0.14 * s);
    rotWorld(BB.s1, UP, 0.08 * s * Math.sin(bossReact.t * 9));
    if (bossReact.t > 0.9) bossReact.amp = 0;
  }
  bossSecondary(B, dt);
  bossReact.flash = Math.max(0, bossReact.flash - dt * 5);
  for (const m of bossMats) if (m.emissive) m.emissive.copy(BOSS_FLASH).multiplyScalar((TRAILER ? 0.22 : 0.55) * bossReact.flash * bossReact.flash);
}

const HERO_ACT_CLIPS = new Set(Object.values(H.verbs).map((v) => v.clip).concat(Object.values(GS_LIGHT_VAR).flat(), ['heavy', 'mh_judgment', 'lunge_s', 'lunge_m', 'lunge_h', 'at_sweep', 'at_sweep_rev', 'at_rift_plant', 'gs_sweep', 'gs_sweep_rev', 'gs_rift'], DANCE_CLIPS, Object.values(GS_SET).map((g) => g.clip)));
const HERO_LOCO_CLIPS = new Set(['idle', 'walk', 'run', 'block', 'parry', GS_GUARD.clip]);
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
  tipFloorGuard();
  leftGripIK(presentDt);
  tipFloorPost();
  if (presentDt > 0) jerk.hero.sample();
  if (trace.on && presentDt > 0) {
    const r = jerkRaw.na ? jerkRaw.acc[jerkRaw.na - 1] : null, f = jerk.hero.na ? jerk.hero.acc[jerk.hero.na - 1] : null;
    heroSword.tip.getWorldPosition(_b); trace.rows.push({ tip: [+_b.x.toFixed(4), +_b.y.toFixed(4), +_b.z.toFixed(4)], act: H.state === HERO_STATE.ACTION && H.actF >= H.verbs[H.verb].startup && H.actF < H.verbs[H.verb].startup + H.verbs[H.verb].active, raw: r, fin: f, bone: jerk.hero.accBone, rbone: jerkRaw.accBone, st: H.state, clip: hero.pc, verb: H.verb, f: H.actF });
  }
}
// v2.12 two-hand grip IK (presentation only, ?grip=0 disables): with the great sword equipped the left hand is
// pinned to the grip below the right hand in every state except death - loco, every swing (including the one-hand
// mh clips), guard, dodge, finisher. Two-bone analytic IK on LeftArm/LeftForeArm with the elbow pole out to the
// hero's left and down, then the hand takes the measured grip orientation. Runs last, after every additive layer,
// so it follows the socket wherever the swing / sway put it. Nothing is read back into the sim.
const GRIP_ON = qs.get('grip') !== '0';
const GRIP_GROSS = 0.08;   // m past left-arm reach that justifies moving the sword arm inside a strike window
const _ga = new THREE.Vector3(), _gb = new THREE.Vector3(), _gc = new THREE.Vector3(), _gt = new THREE.Vector3(), _ge = new THREE.Vector3();
const _gd = new THREE.Vector3(), _gp = new THREE.Vector3(), _gu = new THREE.Vector3(), _gv = new THREE.Vector3();
const _gq = new THREE.Quaternion(), _gq2 = new THREE.Quaternion(), _gq3 = new THREE.Quaternion();
const _gw = new THREE.Vector3(), _gx = new THREE.Vector3();
// Transport the solved elbow and arm frames, rather than re-solving a shortest
// arc from a fresh authored pose each frame (singular on rising cuts).
const GRIP_STABLE = qs.get('gripstable') !== '0';
const gripFrame = { valid: false, dir: new THREE.Vector3(), pole: new THREE.Vector3(),
  arm: new THREE.Quaternion(), fore: new THREE.Quaternion() };
const _gfq = new THREE.Quaternion(), _gfp = new THREE.Vector3();
function alignGripFrame(b, child, target, previous) {
  _gfq.copy(previous);
  _gu.copy(child.position).applyQuaternion(_gfq).normalize();
  _gv.copy(target).normalize();
  _gq.setFromUnitVectors(_gu, _gv); _gfq.premultiply(_gq);
  b.parent.getWorldQuaternion(_gq2);
  b.quaternion.copy(_gq2.invert().multiply(_gfq)); b.updateMatrixWorld(true);
}
// v2.22 blade floor guard (presentation only, ?tipguard=0 disables): the low sweeps and the rift finale carry the
// 1.6 m great-sword tip to within a few cm of the ground, and the hips drop of the planted-foot bake can push it under.
// If the tip is below TIP_CLEAR the socket is pitched about the right fist by exactly the angle that lifts it back
// (a 6 cm lift on a 1.6 m blade is about 2 degrees). Runs before leftGripIK, so the off hand follows the grip.
const TIP_GUARD_ON = qs.get('tipguard') !== '0', TIP_CLEAR = 0.04;
const tipGuard = { base: new Map(), n: 0 };   // v2.24: base pose per socket (great sword, glaive, sabre)
const _tg0 = new THREE.Vector3(), _tg1 = new THREE.Vector3(), _tgq = new THREE.Quaternion(), _tgp = new THREE.Quaternion(), _tgu = new THREE.Vector3(0, 1, 0);
function tipFloorGuard() {
  // v2.24: guards whichever blade is in hand; the default hero's one-hand sword stays unguarded (unchanged v2.23)
  const W = heroSword, S = W.socket;
  if (!tipGuard.base.has(S)) tipGuard.base.set(S, S.quaternion.clone());
  S.quaternion.copy(tipGuard.base.get(S));
  // v2.27: dance verbs guard the one-hand sword too (dz_l2's rising wind-up dragged the tip 12 cm under the floor)
  const danceAct = H.state === HERO_STATE.ACTION && H.verb && H.verb.charCodeAt(0) === 68 && H.verb.charCodeAt(1) === 95;   // 'D_'
  if (!TIP_GUARD_ON || (H.weapon < 1 && !heroSabre && !danceAct)) return;
  for (let it = 0; it < 3; it++) if (!tipLiftPass(W, S)) break;   // v2.24: iterate; one pass undershoots on the 1.9 m glaive
}
// v2.24: the grip IK pull-in rotates RightArm after the guard ran, which can re-sink the 1.9 m glaive by a few cm.
// A second, non-resetting pass after leftGripIK fixes it; the socket pivots about the right fist, so the off-hand
// target (one hand-width down the grip) moves under 4 mm. New characters only: the default hero stays v2.23-exact.
function tipFloorPost() {
  if (!TIP_GUARD_ON || (CHAR === 'hero' && !(H.weapon >= 1 && gsDragW > 0))) return;   // v2.30: hero drag carry too
  for (let it = 0; it < 3; it++) if (!tipLiftPass(heroSword, heroSword.socket)) break;
}
function tipLiftPass(W, S) {
  hero.model.updateMatrixWorld(true);
  S.getWorldPosition(_tg0); W.tip.getWorldPosition(_tg1);
  const floor = colliders.terrainY(_tg1.z) + TIP_CLEAR + 0.002;
  if (_tg1.y >= floor - 0.002) return false;
  _tg1.sub(_tg0); const L = _tg1.length(); if (L < 1e-3) return false;
  const yNow = _tg1.y / L, yWant = Math.min(1, (floor - _tg0.y) / L);
  const a = Math.asin(Math.max(-1, Math.min(1, yWant))) - Math.asin(Math.max(-1, Math.min(1, yNow)));
  if (!(a > 0)) return false;
  _tg0.crossVectors(_tg1, _tgu); if (_tg0.lengthSq() < 1e-8) return false; _tg0.normalize().negate();   // axis lifting the tip
  _tgq.setFromAxisAngle(_tg0, -a);
  // world rotation about the socket origin -> local: q_local' = inv(parentWorld) * dq * parentWorld * q_local
  S.parent.getWorldQuaternion(_tgp);
  const dq = _tgq.premultiply(_tgp.clone().invert()).multiply(_tgp);
  S.quaternion.premultiply(dq); tipGuard.n++;
  return true;
}
function alignBone(bone, from, to) {   // rotate bone in world space so world direction `from` points along `to`
  _gu.copy(from).normalize(); _gv.copy(to).normalize();
  if (_gu.dot(_gv) > 0.999999) return;
  _gq.setFromUnitVectors(_gu, _gv); bone.parent.getWorldQuaternion(_gq2);
  _gq3.copy(_gq2).invert().multiply(_gq).multiply(_gq2); bone.quaternion.premultiply(_gq3);
  bone.updateMatrixWorld(true);
}
function leftGripIK(dt) {
  // the off hand lets go only for a roll / dodge, a hit reaction or death (those clips throw the arms wide);
  // loco, every swing, guard, parry and the finisher keep both hands on the hilt
  const free = H.state === HERO_STATE.DEAD || H.state === HERO_STATE.DODGE || H.state === HERO_STATE.HITSTUN;
  const want = GRIP_ON && GRIP.on && H.weapon >= 1 && !free ? 1 : 0;
  GRIP.w = dt > 0 ? GRIP.w + (want - GRIP.w) * Math.min(1, dt * (want ? 14 : 4)) : GRIP.w;
  if (GRIP.w < 1e-3) { gripFrame.valid = false; return; }
  const stable = GRIP_STABLE && dt > 0 && gripFrame.valid;
  const A = heroBones.LeftArm, F = heroBones.LeftForeArm, Hd = heroBones.LeftHand, S = heroBones.LeftShoulder;
  hero.model.updateMatrixWorld(true);
  A.getWorldPosition(_ga); F.getWorldPosition(_gb); Hd.getWorldPosition(_gc);
  // target the FIST (skin-weighted hand centroid), not the wrist joint: fist on the grip axis one hand-width below
  // the right fist; the wrist target is that minus the fist offset at the final hand orientation
  heroGreat.socket.getWorldQuaternion(_gq); _gq.multiply(GRIP.q); Hd.getWorldScale(_gw);
  _gt.copy(GRIP.fist); heroGreat.socket.localToWorld(_gt);
  _gx.copy(FIST.L).multiply(_gw).applyQuaternion(_gq); _gt.sub(_gx);
  let l1 = _gb.distanceTo(_ga), l2 = _gc.distanceTo(_gb);
  // hilt beyond the left arm's reach outside a swing (idle / loco / guard settling out of a chop): bring the sword
  // arm in. Rotate RightArm about its joint so the grip point moves toward the left shoulder by the excess. Never
  // during ACTION / FINISHER, so swing paths and contact frames keep the authored blade (no sword drift).
  const RA = heroBones.RightArm;
  // v2.22: the Rift's blend-in from loco (f3-11) swung the hilt 0.9 m from the left shoulder (grip miss 46 cm); the
  // plant has no contact before the finale, so the pull-in runs there too and stops 8 f before FINALE.
  const exactBlade = H.state === HERO_STATE.ACTION || H.state === HERO_STATE.FINISHER || (H.state === HERO_STATE.RIFT && H.riftF >= HERO_RIFT.FINALE - 8);
  // a rotation about the RightArm joint keeps the hilt at a fixed radius from it, so one alignment undershoots a
  // large excess; up to 3 passes converge (each re-measures the excess)
  // v2.22: during exact-blade states only a gross miss (> GRIP_GROSS past reach: the sweep f36 / rift f54 frames that
  // measured 15-18 cm) is pulled in. Contact is resolved in the sim, so this is presentation only; a hand off the
  // hilt reads far worse than a few degrees of blade path on one frame.
  for (let it = 0; RA && it < 3; it++) {
    const ex = (_ga.distanceTo(_gt) - (l1 + l2) * 0.95) * GRIP.w;
    if (ex <= (exactBlade ? GRIP_GROSS : 0.005)) break;
    {
      RA.getWorldPosition(_ge); _gu.subVectors(_gt, _ge);
      _gv.subVectors(_ga, _gt).normalize().multiplyScalar(ex).add(_gt).sub(_ge);
      alignBone(RA, _gu, _gv);
      _gt.copy(GRIP.fist); heroGreat.socket.localToWorld(_gt);
      heroGreat.socket.getWorldQuaternion(_gq); _gq.multiply(GRIP.q);
      _gx.copy(FIST.L).multiply(_gw).applyQuaternion(_gq); _gt.sub(_gx);
      A.getWorldPosition(_ga); F.getWorldPosition(_gb); Hd.getWorldPosition(_gc);
    }
  }
  _gt.sub(_gc).multiplyScalar(GRIP.w).add(_gc);                        // blend target from the authored hand
  // out of reach: swing the clavicle toward the hilt first (<= 28 deg), like a real shoulder reaching across
  if (S && _ga.distanceTo(_gt) > (l1 + l2) * 0.98) {
    S.getWorldPosition(_ge); _gu.subVectors(_ga, _ge); const sl = _gu.length();
    _gv.subVectors(_gt, _ge).normalize().multiplyScalar(sl);
    const ang = _gu.angleTo(_gv), lim = 0.49 * GRIP.w;
    if (ang > 1e-4) { _gv.sub(_gu).multiplyScalar(Math.min(1, lim / ang)).add(_gu); alignBone(S, _gu, _gv); }
    A.getWorldPosition(_ga); F.getWorldPosition(_gb); Hd.getWorldPosition(_gc);
    l1 = _gb.distanceTo(_ga); l2 = _gc.distanceTo(_gb);
  }
  _gd.subVectors(_gt, _ga); let d = _gd.length(); const reach = (l1 + l2) * 0.999;
  const far = d > reach; d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(reach, d)); _gd.normalize();
  // Preserve the authored elbow plane. A fixed world-space pole flipped
  // when a rising cut crossed it, undoing the continuous baked arm solve.
  _gp.subVectors(_gb, _ga).addScaledVector(_gd, -_gp.dot(_gd));
  if (_gp.lengthSq() < 1e-6) {
    const fx_ = H.facingX(), fz_ = H.facingZ();
    _gp.set(fz_ * 0.6 - fx_ * 0.2, -0.8, -fx_ * 0.6 - fz_ * 0.2);
    _gp.addScaledVector(_gd, -_gp.dot(_gd));
  }
  if (_gp.lengthSq() < 1e-8) _gp.set(0, 0, 1).addScaledVector(_gd, -_gd.z);
  _gp.normalize();
  if (stable) {
    _gq.setFromUnitVectors(gripFrame.dir, _gd);
    _gfp.copy(gripFrame.pole).applyQuaternion(_gq);
    _gfp.addScaledVector(_gd, -_gfp.dot(_gd)).normalize();
    if (_gfp.dot(_gp) < 0) _gp.negate();
    _gp.lerp(_gfp, Math.exp(-dt / 0.12)).normalize();
  }
  const cosA = Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))), sinA = Math.sqrt(1 - cosA * cosA);
  _ge.copy(_ga).addScaledVector(_gd, l1 * cosA).addScaledVector(_gp, l1 * sinA);
  _gu.subVectors(_gb, _ga); _gv.subVectors(_ge, _ga);
  if (stable) alignGripFrame(A, F, _gv, gripFrame.arm); else alignBone(A, _gu, _gv);
  F.getWorldPosition(_gb); Hd.getWorldPosition(_gc);
  _gu.subVectors(_gc, _gb); _gv.subVectors(_gt, _gb);
  if (stable) alignGripFrame(F, Hd, _gv, gripFrame.fore); else alignBone(F, _gu, _gv);
  if (dt > 0) {
    gripFrame.dir.copy(_gd); gripFrame.pole.copy(_gp);
    A.getWorldQuaternion(gripFrame.arm); F.getWorldQuaternion(gripFrame.fore); gripFrame.valid = true;
  }
  // hand orientation: measured grip rotation relative to the socket, slerped by the blend weight
  heroGreat.socket.getWorldQuaternion(_gq); _gq.multiply(GRIP.q);
  Hd.parent.getWorldQuaternion(_gq2); _gq2.invert().multiply(_gq);
  Hd.quaternion.slerp(_gq2, GRIP.w); Hd.updateMatrixWorld(true);
  if (dt > 0) {
    _gc.copy(FIST.L).applyMatrix4(Hd.matrixWorld); _gt.copy(GRIP.fist); heroGreat.socket.localToWorld(_gt);
    const e = _gc.distanceTo(_gt) * (GRIP.w > 0.99 ? 1 : 0);
    GRIP.n++; GRIP.err += e; if (e > GRIP.errMax) GRIP.errMax = e; if (far) GRIP.far++;
    GRIP.e = e; GRIP.dbg = [+l1.toFixed(3), +l2.toFixed(3), +_ga.distanceTo(_gt).toFixed(3)];
  }
}
// seconds until the current swing's active window (pose must be exact there: no sword drift). Infinity otherwise.
function contactDeadline() {
  if (H.state !== HERO_STATE.ACTION || !H.verbs[H.verb]) return Infinity;
  const v = H.verbs[H.verb], f = H.actF;
  if (f >= v.startup + v.active) return Infinity;
  return Math.max(0, (v.startup - f) / 60);
}
function heroClipT() { const w = WARP_ON && (H.weapon >= 1 ? WARP_GS : WARP)[H.verb]; return w ? w.clipTime(H.actF) : H.verbClipTime(H.actF); }
// great sword equipped and its two-handed clip is present -> that clip; else null (standard set)
function heroGsVerb() { const g = H.weapon >= 1 && GS_SET[H.verb]; return g && GS_WARP[H.verb] && hero.actions[g.clip] ? g : null; }
// v2.32 light variants (presentation only; sim timing / contact / travel identical). H.varIdx counts uses of the verb.
function heroLightVar() {
  if (!VAR_ON || H.state !== HERO_STATE.ACTION) return null;
  const n = Math.max(0, (H.varIdx | 0) - 1);
  if (H.weapon >= 1) { const L = GS_LIGHT_VAR[H.verb], c = L && L[n % L.length]; return c && hero.actions[c] ? c : null; }
  const v = H.verbs[H.verb];
  if (v && v.dance && !v.heavy && n % 2 === 1) { const c = v.foot + 'b'; return AT_OK[c] !== undefined ? c : null; }
  return null;
}
// v2.39: the great-sword light take on the new footwork (gs_l1b -> gl_1b), only while the sim walks that root curve
function heroGreatFootClip(v) {
  if (H.weapon < 1 || !v || !v.foot || !GREAT_FOOT_CLIPS.length) return null;
  const L = GS_LIGHT_VAR[H.verb]; if (!L) return null;
  const n = VAR_ON ? Math.max(0, (H.varIdx | 0) - 1) : 0, c = 'gl_' + L[n % L.length].slice(4);
  return AT_OK[c] !== undefined && hero.actions[c] ? c : (AT_OK[v.foot] !== undefined && hero.actions[v.foot] ? v.foot : null);
}
const heroGsGuard = () => H.weapon >= 1 && !!hero.actions[GS_GUARD.clip];
// v2.30 recovery hold: the last GS_HOLD_F frames of a great-sword verb ease the arms into gs_drag (blade low and out
// to the right), and loco keeps it for GS_HOLD_TAIL frames after the action ends before the ready carry returns.
// Weight is arm-only (gs_drag has no leg tracks), so planted feet and the move-cancel timing are untouched.
const GS_HOLD_F = 20, GS_HOLD_TAIL = 30, GS_DRAG_W = 12;
let gsDragW = 0;
const GS_DRAG_ON = qs.get('gsdrag') !== '0';   // ?gsdrag=0: v2.29 ready carry while moving (A/B)   // weight of gs_drag in this frame's hero pose (tip floor post-pass runs only when > 0)
function gsHoldW(v) {
  // Authored light variants already contain a complete recovery to ready.
  // A weight-12 static drag pose here overwhelmed that follow-through and
  // flipped wrists across the quaternion blend hemisphere in mid-recovery.
  if (H.weapon < 1 || v.dance || heroLightVar() || !hero.actions.gs_drag) return 0;
  const tot = v.total || 0; if (!tot) return 0;
  const k = Math.min(1, Math.max(0, (H.actF - (tot - GS_HOLD_F)) / GS_HOLD_F));
  if (k > 0) loco.gsHoldEnd = H.frame + GS_HOLD_TAIL;
  return k * k * (3 - 2 * k) * GS_DRAG_W;
}
function poseHeroBase(alpha, presentDt) {
  const st = H.state; gsDragW = 0;
  if (st === HERO_STATE.ACTION) {
    const v = H.verbs[H.verb], hw = gsHoldW(v); gsDragW = hw;
    if (H.flashF >= 0) {
      // v2.34 flash step: lunge footwork through the dash (same read as the snatch pull), strike starts on arrival
      const ln = hero.actions.lunge_m ? 'lunge_m' : hero.actions.lunge_h ? 'lunge_h' : null;
      const u = Math.min(1, (H.flashF + alpha) / (HERO_FLASH.STARTUP + HERO_FLASH.TRAVEL_MAX));
      if (ln) pose(hero, 1, ln, 1, u * (hero.actions[ln].getClip().duration - 0.01));
      else pose(hero, 1, 'dodge', 1, u * hero.dur.dodge * 0.8);
      return;
    }
    if (AIR_POSE[H.verb]) {
      const P = AIR_POSE[H.verb], c = hero.actions[P[0]] ? P[0] : 'heavy', f = H.actF + alpha, u = Math.min(1, f / v.total);
      const t0 = Math.min(P[1], hero.dur[c] - 0.01), t1 = Math.min(P[2], hero.dur[c] - 0.001);
      if (P[3] !== undefined && c === P[0]) {
        // wind-up eases in to the strike on the first active frame, then the follow-through plays out the recovery
        // a wave verb (BACK_CUT) throws its crescent on the last active frame, so the blade comes through there
        const fs = v.wave ? v.startup + v.active : v.startup + 1, th = Math.min(P[3], t1);
        pose(hero, 1, c, 1, f <= fs ? t0 + (th - t0) * Math.pow(f / fs, 1.4) : th + (t1 - th) * Math.min(1, (f - fs) / Math.max(1, v.total - fs)));
        return;
      }
      pose(hero, 1, c, 1, t0 + (t1 - t0) * u); return;
    }
    const gfc = heroGreatFootClip(v);
    if (gfc) {
      // v2.39 great sword light: the layered take (weighted step + two-handed arc) at the sim frame, 1:1 with the root curve
      pose(hero, 1, gfc, 1, Math.min(Math.max(0, H.actF - 1 + alpha) / 60, hero.dur[gfc] - 0.001));
      return;
    }
    if (v.sweep || (v.dance && AT_OK[v.foot] !== undefined)) {
      // v2.22 sweep / v2.27 dance step: the layered clip at the sim frame, 1:1 (the sim walks the same root curve,
      // feet stay planted)
      const c = (v.quick && AT_OK[v.q] !== undefined ? v.q : null) || heroLightVar() || (AT_OK[v.foot] !== undefined ? v.foot : hero.actions[v.clip] ? v.clip : 'heavy');
      // root sits at lerp(actF-1, actF, alpha) on the curve, so the clip samples the same instant (else feet skate)
      const ct = Math.min(Math.max(0, H.actF - 1 + alpha) / 60, hero.dur[c] - 0.001);
      if (hw > 0) pose(hero, 2, c, 1, ct, 'gs_drag', hw, 0); else pose(hero, 1, c, 1, ct);
      return;
    }
    const ln = LUNGE_FOR[H.verb], ld = ln && lungeOk[ln];
    const lv = H.weapon >= 1 ? heroLightVar() : null;
    const gs = heroGsVerb(), clip = lv || (gs ? gs.clip : v.clip);
    const ct = lv ? Math.min(Math.max(0, H.actF - 1 + alpha) / 60, hero.dur[lv] - 0.001) : gs ? GS_WARP[H.verb].clipTime(H.actF) : heroClipT();
    if (ld) {
      // footwork covers the sim lunge window (startup+active) and settles through early recovery
      const lf = v.startup + v.active, span = lf * 1.5, u = Math.min(1, (H.actF + alpha) / span);
      const w = H.actF < span ? 1.6 : Math.max(0, 1.6 * (1 - (H.actF - span) / 12));
      pose(hero, 3, clip, 1, ct, ln, w, u * ld, 'gs_drag', hw, 0);
      return;
    }
    if (hw > 0) pose(hero, 2, clip, 1, ct, 'gs_drag', hw, 0); else pose(hero, 1, clip, 1, ct);
    return;
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
  if (st === HERO_STATE.SNATCH) {
    // snatch: lunge footwork across the whole pull (startup crouch -> travel -> landing), clip time follows the sim frame
    const ln = hero.actions.lunge_h ? 'lunge_h' : hero.actions.lunge_m ? 'lunge_m' : null;
    const span = SNATCH_SPAN, u = Math.min(1, (Math.max(0, H.snatchF) + alpha) / span);
    if (ln) pose(hero, 1, ln, 1, u * (hero.actions[ln].getClip().duration - 0.01));
    else pose(hero, 1, 'dodge', 1, u * hero.dur.dodge * 0.8);
    return;
  }
  if (st === HERO_STATE.RIFT) {
    // Ember Rift: settle into the heavy wind-up and hold it while the cuts land (the blade is "sheathed" in the
    // stance), then release the strike over the finale. Clip time is a pure function of the sim frame.
    // v2.22: the Blender-authored gs_rift (layered at_rift_plant, 87 f = TOTAL + 1) plays 1:1 on the sim frame when the
    // great sword is equipped: brace + hold f22-46 while the cuts land, release f47-54 = FINALE.
    if (H.weapon >= 1 && AT_OK.at_rift_plant !== undefined) {
      pose(hero, 1, 'at_rift_plant', 1, Math.min(Math.max(0, H.riftF - 1 + alpha) / 60, hero.dur.at_rift_plant - 0.001)); return;
    }
    const R = HERO_RIFT, f = Math.max(0, H.riftF) + alpha, d = hero.dur.heavy, hold = d * 0.32;
    const tc = f < R.STARTUP ? hold * (f / R.STARTUP)
      : f < R.FINALE - 8 ? hold
      : Math.min(d - 0.01, hold + (d - hold) * Math.min(1, (f - (R.FINALE - 8)) / (R.TOTAL - (R.FINALE - 8))));
    pose(hero, 1, 'heavy', 1, tc); return;
  }
  if (st === HERO_STATE.AIR) {
    const c = hero.actions[JUMP_POSE[0]] ? JUMP_POSE[0] : 'dodge', n = HERO_JUMP.TAKEOFF + HERO_JUMP.AIR;
    const u = Math.min(1, (Math.max(0, H.jumpF) + alpha) / n), t0 = Math.min(JUMP_POSE[1], hero.dur[c] - 0.01), t1 = Math.min(JUMP_POSE[2], hero.dur[c] - 0.001);
    pose(hero, 1, c, 1, t0 + (t1 - t0) * u); return;
  }
  if (st === HERO_STATE.HITSTUN) { pose(hero, 1, 'hit', 1, Math.min(H.actF, 40) / 60); return; }
  if (st === HERO_STATE.DEAD) { pose(hero, 1, 'death', 1, Math.min(H.actF / 60, hero.dur.death - 0.01)); return; }
  if (st === HERO_STATE.FINISHER) {
    const fc = H.weapon >= 1 && hero.actions[GS_FINISHER_CLIP.clip] ? GS_FINISHER_CLIP : HERO_FINISHER_CLIP, kn = fc.knots, f = Math.min(HERO_FINISHER_F, H.actF + alpha);
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
  const gg = heroGsGuard();
  if (H.blocking) { pose(hero, 2, gg ? GS_GUARD.clip : 'block', 1 - wMove * 0.5, gg ? GS_GUARD.blockT : 0.35, 'walk', wMove * 0.5, loco.phase * hero.dur.walk); return; }
  if (H.deflectF >= 0 && H.deflectF < 20 && wMove < 0.5) { pose(hero, 1, gg ? GS_GUARD.clip : 'parry', 1, H.deflectF / 60 + (gg ? GS_GUARD.parryT0 : 0.1)); return; }
  // great sword: arms take the two-handed low-ready carry (weight 12 of 13 on the arm bones), legs keep the loco blend
  // v2.30: moving drags the blade low (gs_drag, ref #12 carry), standing returns to the ready carry; a great-sword
  // recovery hold lingers GS_HOLD_TAIL frames before the ready pose comes back
  const carry = H.weapon >= 1 && hero.actions.gs_carry ? 12 : 0;
  if (carry && hero.actions.gs_drag && GS_DRAG_ON) {
    const tail = Math.min(1, Math.max(0, ((loco.gsHoldEnd || 0) - H.frame) / GS_HOLD_TAIL));
    const m = Math.max(Math.min(1, Math.max(0, (sp - 0.6) / (SIM.WALK_SPEED - 0.6 + 1e-6))), tail * tail * (3 - 2 * tail));
    pose(hero, 4, 'idle', 1 - wMove, (H.frame / 60) % hero.dur.idle, 'walk', wMove * (1 - wRun), loco.phase * hero.dur.walk,
      'run', wMove * wRun, loco.phase * hero.dur.run, 'gs_carry_move', carry, Math.min(0.999, m));
    gsDragW = carry * m;
  } else {
    pose(hero, carry ? 4 : 3, 'idle', 1 - wMove, (H.frame / 60) % hero.dur.idle,
      'walk', wMove * (1 - wRun), loco.phase * hero.dur.walk, 'run', wMove * wRun, loco.phase * hero.dur.run, 'gs_carry', carry, 0);
  }
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
  if (i === 0 && d.elite) {
    if (WMO_ON) wardenMotion.apply(s, d, alpha, presentDtNow, WARDEN_GHOST_ID);
    // QA hold (?wmohold=1): freeze the loop on the first strike frame of each verb so a probe can capture it
    if (WMO_HOLD && d.state === DUEL_STATE.ATTACK && WMO_STRIKE[d.verb] !== undefined && d.f >= WMO_STRIKE[d.verb] && !wmoHeld[d.verb]) {
      wmoHeld[d.verb] = d.f; loop.paused = true; window.__wmoHold = d.verb;
    }
  }
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
  if (!TRAILER && B.verb === 7 && B.state === BRAIN_STATE.ACTION && (B.f % 6) === 0) fx.afterimage(BOSS_ID, false, 0.6);
  breathFx(B);
  if (TRAILER) trailerBossFx(B);
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
// Stage 3: pose the gauntlet, blade streaks during active windows, hazard meshes + their one-shot fx
const gStreak = { l: false, r: false, c: false };
const G_STREAK_ID = { l: GAUNTLET_ID + 1, r: GAUNTLET_ID + 2, c: GAUNTLET_ID + 3 };
const gCb = {
  strike: (x, y, z) => { _p.set(x, y + 0.6, z); _n.set(0, 1, 0); fx.burstSparks(_p, _n, 1.2); fx.shockwave(x, y + 0.2, z, 2.4, 0xbfe6ff, 0.9, 0.35); if (presentDtNow > 0) cam.impact('heavy'); },
  dome: (x, y, z) => { fx.shockwave(x, y + 0.2, z, 7, 0x7fd8ff, 1.0, 0.8); if (presentDtNow > 0) cam.impact('slam'); },
  slam: (x, y, z) => { fx.shockwave(x, y + 0.2, z, 4, 0xffb070, 1.2, 0.5); _p.set(x, y + 0.3, z); _n.set(0, 1, 0); fx.burstSparks(_p, _n, 1.4); if (presentDtNow > 0) cam.impact('slam'); },
};
function streakBlade(key, on, b) {
  if (on) { b.base.getWorldPosition(_a); b.tip.getWorldPosition(_b); fx.streakSample(G_STREAK_ID[key], _a, _b, sim.gauntlet.phase >= 2 ? 0xff6a4a : 0x40e0c8); gStreak[key] = true; }
  else if (gStreak[key]) { fx.streakEnd(G_STREAK_ID[key]); gStreak[key] = false; }
}
const gTerrainY = (z) => colliders.terrainY(z);
function poseGauntlet(alpha, dt) {
  const G = sim.gauntlet;
  gview.root.visible = true;
  gview.update(G, sim.frame, alpha, dt, gTerrainY, gauntletBlend);
  // blade trails: from 6 f before contact through the active window (verb-specific blade)
  const f = G.f, d = G.def, act = G.state === G_STATE.ACTION && d && f >= d.active[0] - 6 && f <= d.active[1] + 2;
  const v = G.verb;
  streakBlade('c', act && (v === 0 || v === 1 || v === 2 || v === 6), gview.crest);
  streakBlade('l', act && (v === 0 || v === 2 || v === 3), gview.bladeL);
  streakBlade('r', act && (v === 1 || v === 2 || v === 3), gview.bladeR);
  if (act && v === 2 && (f % 4) === 0 && dt > 0) fx.afterimage(GAUNTLET_ID, false, 0.6);
  // enrage: ember sparks shed off the blade tips (spec section 6, #FF5A2A); sparse and never inside an active
  // window so it can not steal a spark slot from a contact read
  if (G.phase >= 2 && dt > 0 && !act && G.state !== G_STATE.DEAD && sim.frame % 26 === 0 && gstat.emberF !== sim.frame) {
    gstat.emberF = sim.frame; const b = (sim.frame / 26) % 2 ? gview.bladeL : gview.bladeR;
    b.tip.getWorldPosition(_a); _n.set(0, 1, 0); fx.burstSparks(_a, _n, 0.3);
  }
  gview.hazards(G, sim.frame, dt, gTerrainY, gCb);
}
let presentDtNow = 0, camSimX = 0, camSimZ = 0;
let dispYaw = null;
const PLANT_F = 8;   // retarget_bake WARM: first frame with pinned feet on the v2.22 footwork clips
// frames into a planted-foot clip (sweep / sweep_rev / rift plant on the great sword), or -1
function heroPlantF() {
  if (H.state === HERO_STATE.ACTION && H.weapon < 1) { const v = H.verbs[H.verb]; return v && v.dance && AT_OK[v.foot] !== undefined ? H.actF : -1; }
  if (H.weapon < 1) return -1;
  if (H.state === HERO_STATE.RIFT) return AT_OK.at_rift_plant !== undefined ? Math.max(0, H.riftF) : -1;
  if (H.state === HERO_STATE.ACTION) { const v = H.verbs[H.verb]; return v && v.foot && AT_OK[v.foot] !== undefined ? H.actF : -1; }
  return -1;
}

let wasFinisher = false, finHitShown = false;
// cinematic letterbox: two DOM bars (no extra render pass), height follows the cine blend weight
const lbStyle = document.createElement('style');
lbStyle.textContent = '.ec-lb{position:fixed;left:0;right:0;height:11vh;background:#000;z-index:5;pointer-events:none;transform:scaleY(0);will-change:transform}' +
  '.ec-lb.t{top:0;transform-origin:top}.ec-lb.b{bottom:0;transform-origin:bottom}' +
  (recMode ? 'body,canvas{cursor:none!important}.ec-credit,.ec-fps,#stats{display:none!important}' : '') +
  (TRAILER ? '.ec-ret{display:none!important}.ec-hud>*:not(.ec-flash):not(.ec-banner){visibility:hidden!important}.ec-hud .ec-banner,.ec-hud .ec-banner *{visibility:visible!important}' : '') +
  // ?ad=1 (trailer only): clean plate for social ads - no banner text, no cue text, no letterbox bars, so every frame cuts
  (TRAILER && qs.get('ad') === '1' ? '.ec-banner,.ec-cue,.ec-lb,.ec-road{display:none!important}' : '');
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
  if (p.kind === ActorKind.GAUNTLET) {
    cam.cine(CINE.DEATH); loop.dilate(0.4, 70, true);
    const G = sim.gauntlet; fx.shockwave(G.x, colliders.terrainY(G.z) + 0.22, G.z, 9, 0x9fe8ff, 1.4, 0.9);
    if (INK_ON) fx.mist(G.x, colliders.terrainY(G.z) + 1.2, G.z, 1.6, MIST.WHITE, 18, 1.2);
    hud.banner('THE FOUNDRY FALLS SILENT', 'the chrome gauntlet is broken', 3.0);
    return;
  }
  if (p.actorId === WARDEN_ID) {
    cam.cine(CINE.DEATH); loop.dilate(0.4, 60, true);
    const w = sim.warden; fx.shockwave(w.x, colliders.terrainY(w.z) + 0.22, w.z, 6, 0xb89cff, 1.2, 0.8);
    if (INK_ON) { fx.mist(w.x, colliders.terrainY(w.z) + 1.0, w.z, 1.1, MIST.VIOLET, 18, 1.1); }
    hud.banner('THE WARDEN YIELDS', 'his blade falls among the maple leaves', 3.0);
    return;
  }
  if (p.kind !== ActorKind.WYVERN) {
    // v2.9 ink kill: the duelist dissolves in violet mist; a short presentation-only slow-mo sells the final blow
    if (!INK_ON) return;
    for (const s of slots) if (s.bound && s.actorId === p.actorId) {
      const r = s.root.position, y = colliders.terrainY(r.z);
      // foes die at sword range, so a dissolve centred on the corpse sat on the hero's legs for ~1 s and washed the
      // silhouette out (v2.15 attribution: smoke pool alone lifted hero-box luminance 88 -> 142). Push the cloud
      // up to 0.8 m away from the hero, keep it smaller and sparser; trigger kills dissolve in crimson instead.
      let mx = r.x, mz = r.z; const ddx = r.x - H.x, ddz = r.z - H.z, dd = Math.hypot(ddx, ddz);
      if (dd > 0.01 && dd < 3.0) { const push = 1.2 * (1 - dd / 3.0); mx += ddx / dd * push; mz += ddz / dd * push; }
      if (H.triggerF > 0) fx.mist(mx, y + 1.0, mz, 0.4, MIST.CRIMSON, 5, 0.9);
      else { fx.mist(mx, y + 1.1, mz, 0.5, MIST.VIOLET, 9, 0.9); fx.mist(mx, y + 0.3, mz, 0.6, MIST.WHITE, 3, 0.3); }
      if (!reducedMotion) loop.dilate(0.45, 8, true);
      if (TRAILER) {   // trailer kill beat: ground ring, white flare, a longer slow-mo
        { const ec = trailerEdge(); fx.shockwave(r.x, y + 0.08, r.z, 3.6, ec, 1.1, 0.6); _rv.set(r.x, y + 1.2, r.z); fx.flare(_rv, 2.6, ec);
          fx.riftSlash(_rv, 6.5, trailerSwingAngle(), ec, 0, 0.4); fx.mistRGBA(r.x, y + 0.6, r.z, 0.8, 0.9, 0.5, 0.3, 0.3, 8, 1.2);
          if (!reducedMotion) { loop.dilate(0.3, 16, true); post.kick(0.24, ec); cam.impact('heavy'); } }
      }
      break;
    }
    return;
  }
  cam.cine(CINE.DEATH); loop.dilate(0.4, 70, true);
  { const B = sim.brain; fx.shockwave(B.x, colliders.terrainY(B.z) + 0.22, B.z, 9, TRAILER ? trailerEdge() : 0xffc080, 1.4, 0.9); }
  hud.banner('THE FORD IS YOURS', 'the wyvern falls', 3.0);
});

// v2.23 road camera grammar (reference #1, PBZ breakdown: one continuous take, chase cam 3-5 m, ~60 deg, push in on
// engage, wide after a kill). Presentation only: reads sim state, never writes it.
//   ROAD_OPEN  crane from in front of the hero over the shoulder into the chase pose (stage start)
//   AMBUSH     raised three-quarter on the pincer, ends on the hero->nearest-foe two-shot
//   GATE       low hero shot with the torii above, ends on the chase pose
// Road shots always end on the gameplay pose, so the hand-back is a settle, never a cut. ?roadcam=0 = legacy rig.
const ROADCAM_ON = qs.get('roadcam') !== '0';
const roadCam = { leg: -1, amb: -1, gate: false, want: 0, sgn: 1 };
const ROAD_LOOKAHEAD = 7.0;   // m down the pass the chase yaw aims at (smooths the S-curve)
function roadYawAt(x, z) {
  // forward = toward the gate (-Z) along roadX; camera yaw convention: forward = (-sin y, -cos y)
  const tz = Math.max(ROAD.GATE_Z - 6, z - ROAD_LOOKAHEAD), fx = roadX(tz) - x, fz = tz - z;
  return Math.atan2(-fx, -fz);
}
function roadCamLayer() {
  cam.roadMode = ROADCAM_ON && sim.roadActive;
  if (!cam.roadMode) { roadCam.leg = -1; roadCam.amb = -1; roadCam.gate = false; return; }
  const hx = camHero.position.x, hz = camHero.position.z, hy = camHero.position.y;
  cam.roadYaw = roadYawAt(hx, hz);
  // subject: hero chest; during the ambush shot the pincer centroid pulls it toward the foes
  cam.cineFocus.set(hx, hy + 1.2, hz);
  cam.cineFitR = 0;
  if (cam.cineKind === CINE.AMBUSH) {
    // bbox centre of hero + live foes (not the hero-weighted mean, which left the far foe on the frame edge),
    // and the radius the lens must hold: CameraDirector backs the AMBUSH arc off until it fits
    let x0 = hx, x1 = hx, z0 = hz, z1 = hz;
    for (const d of sim.duelists) if (d.alive && Math.hypot(d.x - hx, d.z - hz) < 16) {
      x0 = Math.min(x0, d.x); x1 = Math.max(x1, d.x); z0 = Math.min(z0, d.z); z1 = Math.max(z1, d.z); }
    const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
    cam.cineFocus.x = cx; cam.cineFocus.z = cz;
    cam.cineFitR = Math.hypot(x1 - x0, z1 - z0) * 0.5 + 1.2;   // + body half-width and sword reach
  }
  if (roadCam.leg !== sim.roadLeg) {
    roadCam.leg = sim.roadLeg; roadCam.amb = -1; roadCam.gate = false; roadCam.sgn = sim.roadLeg ? -1 : 1;
    if (!reducedMotion) cam.cine(CINE.ROAD_OPEN, cam.roadYaw, roadCam.sgn);
  }
  if (sim.ambushLive && sim.ambushIdx !== roadCam.amb) {
    roadCam.amb = sim.ambushIdx;
    // end on the duel two-shot (camera behind the hero on the hero->nearest-foe line); arc from the far side
    let best = null, bd = 1e9;
    for (const d of sim.duelists) if (d.alive) { const dd = Math.hypot(d.x - hx, d.z - hz); if (dd < bd) { bd = dd; best = d; } }
    const endYaw = best ? Math.atan2(-(best.x - hx), -(best.z - hz)) : cam.roadYaw;
    let e = endYaw - cam.orbitYaw; e -= Math.round(e / (2 * Math.PI)) * 2 * Math.PI;
    if (!reducedMotion) cam.cine(CINE.AMBUSH, endYaw, e >= 0 ? 1 : -1);
  }
  if (!roadCam.gate && sim.roadCleared && Math.hypot(hx - roadX(ROAD.GATE_Z), hz - ROAD.GATE_Z) < 13) {
    roadCam.gate = true; if (!reducedMotion) cam.cine(CINE.GATE, cam.roadYaw, -roadCam.sgn);
  }
}
bus.on('wave/clear', () => { if (cam.roadMode) cam.release(); });

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
  if (sim.stage3Active && sim.gauntlet.state !== G_STATE.DEAD) {
    gview.HEAD.getWorldPosition(camTarget.position);
    camTarget.position.x = gview.root.position.x; camTarget.position.z = gview.root.position.z;
    camTarget.position.y = Math.max(1.6, Math.min(3.2, camTarget.position.y));
    camTarget.isBoss = true; camTarget.airborne = sim.gauntlet.y > 2.0;
    camTarget.distance = Math.hypot(sim.gauntlet.x - H.x, sim.gauntlet.z - H.z);
    cam.setTarget(camTarget, true); return;
  }
  if (sim.stage2Active && sim.warden && sim.warden.alive) {
    // duel: always framed on the warden (boss lens), chest height
    const r = slots[0].root.position;
    camTarget.position.set(r.x, r.y + 1.45 * WARDEN.SCALE, r.z);
    camTarget.isBoss = true; camTarget.airborne = false;
    camTarget.distance = Math.hypot(sim.warden.x - H.x, sim.warden.z - H.z);
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
  hero.root.position.set(prev.hx + (H.x - prev.hx) * alpha, colliders.terrainY(H.z) + (prev.hy || 0) + ((H.y || 0) - (prev.hy || 0)) * alpha, prev.hz + (H.z - prev.hz) * alpha);
  hero.root.position.y += bflipPhase(alpha);
  // v2.22 plant deficit (HeroSim.plantDX/DZ): the model sits where the clip's root curve put it, so planted feet
  // never skate when contact / walls bend the sim travel. The camera and gameplay keep the sim position.
  camSimX = hero.root.position.x; camSimZ = hero.root.position.z;
  hero.root.position.x += (prev.pdx || 0) + ((H.plantDX || 0) - (prev.pdx || 0)) * alpha; hero.root.position.z += (prev.pdz || 0) + ((H.plantDZ || 0) - (prev.pdz || 0)) * alpha;
  // C15: the sim snap-turns on attack assist / parry / finisher; the body turns into it over ~5 frames instead of
  // popping. Small steady turns pass straight through (no lag on locomotion).
  { const tY = lerpAngle(prev.hyaw, H.yaw, alpha);
    if (!INERT_ON || presentDt <= 0 || dispYaw === null) dispYaw = tY;
    else { let e = tY - dispYaw; e -= Math.round(e / (2 * Math.PI)) * 2 * Math.PI; const ae = Math.abs(e);
      let k = ae < 0.12 ? 1 : 1 - Math.exp(-presentDt * (ae > 1.2 ? 26 : 34));
      // v2.22 planted clips (sweeps, rift): the bake pins the feet from frame PLANT_F, so the assist turn must be fully
      // shown by then - any body yaw left over after that rotates the planted feet (measured 1.36 m/s skate at rift f11)
      const pf = heroPlantF();
      if (pf >= 0) k = pf >= PLANT_F ? 1 : Math.max(k, Math.min(1, presentDt * 60 / Math.max(1, PLANT_F - pf)));
      dispYaw += e * k; }
    hero.root.rotation.y = dispYaw + airSpinYaw(alpha); }
  poseHero(alpha, presentDt);
  for (let i = 0; i < slots.length; i++) if (slots[i].bound) poseDuelist(slots[i], i, alpha);
  if (sim.bossActive) poseBoss(alpha);
  else { for (const m of poolMeshes) m.visible = false; orbMesh.visible = false; }
  if (sim.stage3Active) poseGauntlet(alpha, presentDt);
  pickupLayer(presentDt); dropLayer(presentDt);
  if (roadMap.on) roadMap.update(Math.min(1, (sim.stateF + alpha) / FLOW_F.ROAD));

  const attacking = H.state === HERO_STATE.ACTION || H.state === HERO_STATE.FINISHER || (H.state === HERO_STATE.RIFT && H.riftF >= HERO_RIFT.FINALE - 8);
  if (attacking) { heroSword.hilt.getWorldPosition(_a); heroSword.tip.getWorldPosition(_b);
    const finisher = H.state === HERO_STATE.FINISHER;
    if (TRAILER) {
      // trailer: ribbon only on the outer 45% of the blade (a 2.2 m glaive drew a flat full-length sheet) and tinted
      // by the weapon's own edge colour; the tip motion is kept for screen-aligned contact cuts
      // outer 30%: a thin bright arc, not a translucent sheet. t7: on the 1 m sabre 30% is a 0.3 m hairline at
      // fight distance, so a one-handed blade draws its outer half
      _a.lerp(_b, H.weapon < 1 ? 0.5 : 0.7);
      trlTip.prev.copy(trlTip.cur); trlTip.cur.copy(_b); trlTip.live = trlTip.f === sim.frame - 1 || trlTip.f === sim.frame ? trlTip.live + 1 : 0; trlTip.f = sim.frame;
      // t7: in the air the body moves 2 m while the ribbon lingers, which drew long straight lines beside the crescent
      fx.streakSample(HERO_ID, _a, _b, finisher ? INK.FIN : trailerEdge(), (H.y || 0) > 0.2 ? 0.08 : 0.16);
    } else
    fx.streakSample(HERO_ID, _a, _b, INK_ON ? (finisher ? INK.FIN : INK.JADE) : 0xff1f14, INK_ON ? INK.LINGER : undefined); streak.hero = true; }
  else if (streak.hero) { fx.streakEnd(HERO_ID); streak.hero = false; }
  dmcLayer(presentDt);
  if (INK_ON) inkLayer(attacking, presentDt);
  else if (H.state === HERO_STATE.DODGE && H.actF === 3 && presentDt > 0) fx.afterimage(HERO_ID, false, 0.5);
  reticleLayer();

  camHero.position.copy(hero.root.position); camHero.position.x = camSimX; camHero.position.z = camSimZ; camHero.yaw = H.yaw;
  // v2.30: the camera follows only 30% of the LEAP height, so the wheel reads as airborne on screen (frame rises with the hero otherwise)
  camHero.position.y -= ((prev.hy || 0) + ((H.y || 0) - (prev.hy || 0)) * alpha) * 0.7; camHero.position.y -= bflip.h;
  chooseCamTarget();
  roadCamLayer();
  // cinematic subject: the wyvern's body-to-head midpoint (tracks the landing, the roar and the fall)
  // C13 occluder: the wyvern body centre (pelvis->chest), only while grounded near the hero
  cam.occluder.active = sim.bossActive && !sim.brain.airborne; cam.occAvoid = OCC_ON;
  if (cam.occluder.active) { BB.s2.getWorldPosition(cam.occluder.position); }
  if (sim.stage3Active) {
    cam.occluder.active = sim.gauntlet.y < 1.0; if (cam.occluder.active) gview.CHEST.getWorldPosition(cam.occluder.position);
    gview.HEAD.getWorldPosition(_a); cam.cineFocus.copy(gview.root.position).lerp(_a, 0.5); cam.cineFocus.y = Math.max(1.4, cam.cineFocus.y);
    if (cam.cineKind === CINE.FINISHER) cam.cineFocus.copy(gview.root.position);
  }
  // v2.16: the shrine never set a focus, so the warden INTRO/PHASE/DEATH shots orbited a stale ford point and the
  // DEATH pull-back drove into the halls (clearance pulled it 9 m in, hero 4x off the frame edge). Focus = warden chest.
  if (sim.stage2Active && sim.warden) {
    const r = slots[0].root.position; cam.cineFocus.set(r.x, r.y + 1.2 * WARDEN.SCALE, r.z);
    if (cam.cineKind === CINE.FINISHER) cam.cineFocus.copy(r);
  }
  if (sim.bossActive) {
    HEAD.getWorldPosition(_a); cam.cineFocus.copy(boss.root.position).lerp(_a, 0.5); cam.cineFocus.y = Math.max(1.4, cam.cineFocus.y);
    if (cam.cineKind === CINE.FINISHER) cam.cineFocus.copy(boss.root.position);
  }
  // gauntlet finisher: same beats as the wyvern (GauntletBrain FINISHER_HIT_F 60, 180 damage)
  const gFin = H.state === HERO_STATE.FINISHER && sim.stage3Active;
  if (gFin && !gstat.wasFin) cam.cine(CINE.FINISHER);
  if (gFin && sim.gauntlet.finisherF >= 60 && !gstat.finHit) {
    gstat.finHit = true; gview.HEAD.getWorldPosition(_a); hud.popDamage(innerWidth * 0.5, innerHeight * 0.42, 180, 'fin', 0);
    hud.flash(reducedMotion ? 0.2 : TRAILER ? 0.22 : 0.7); if (TRAILER && !reducedMotion) post.kick(0.45, trailerEdge());
    fx.shockwave(gview.root.position.x, colliders.terrainY(gview.root.position.z) + 0.25, gview.root.position.z, 6.5, TRAILER ? trailerEdge() : 0x9fe8ff, 1.2, 0.6);
    _n.set(0, 1, 0); fx.burstSparks(_a, _n, 1.6); gview.hit(H.facingX(), H.facingZ(), 1.4);
  }
  if (!gFin) gstat.finHit = false;
  gstat.wasFin = gFin;
  const fin = H.state === HERO_STATE.FINISHER && sim.bossActive;
  if (fin && !wasFinisher) cam.cine(CINE.FINISHER);
  // finisher blow lands on brain frame 60 (WyvernBrain FINISHER_HIT_F): flash + giant number, once per finisher
  if (fin && sim.brain.finisherF >= 60 && !finHitShown) {
    finHitShown = true; HEAD.getWorldPosition(_a); hud.popDamage(innerWidth * 0.5, innerHeight * 0.42, 160, 'fin', 0);
    // trailer: a 0.7 screen-blend flash read as a flat lavender frame in the ad review; a short coloured kick instead
    hud.flash(reducedMotion ? 0.2 : TRAILER ? 0.22 * TRL_FINFX : 0.7); if (TRAILER && !reducedMotion) post.kick(0.45 * TRL_FINFX, trailerEdge());
    fx.shockwave(boss.root.position.x, colliders.terrainY(boss.root.position.z) + 0.25, boss.root.position.z, 6.5, TRAILER ? trailerEdge() : 0xffd080, 1.2, 0.6);
    _n.set(0, 1, 0); if (TRL_FINFX > 0.05) fx.burstSparks(_a, _n, 1.6 * TRL_FINFX);
  }
  if (!fin) finHitShown = false;
  wasFinisher = fin;
  letterbox(Math.max(cam.cineActive ? cam.cineLb : 0, reducedMotion ? 0 : dmc.riftLb * 0.6));
  cam.update(presentDt);
  // t12: a shot may name how much of the air height it follows (air, default 0.45); the close air-string shots ride 0.7
  if (choreo && choreo.shot) { _chp.copy(hero.root.position); _chp.y -= ((prev.hy || 0) + ((H.y || 0) - (prev.hy || 0)) * alpha) * (1 - (choreo.shot.air !== undefined ? choreo.shot.air : 0.45)) + bflip.h;
    choreo.applyCam(camera, presentDt, _chp, boss.root.position, cam.cineActive); }
  camera.getWorldDirection(_dir); camYaw = Math.atan2(-_dir.x, -_dir.z);
  placeFill();
  fx.update(presentDt);
  if (arena === 'shrine') motes.shrine.update(presentDt); else if (arena === 'foundry') motes.foundry.update(presentDt);
  else if (arena === 'road' && roadStage) {
    motes.road.points.position.set(roadX(H.z), 0, H.z - 6); motes.road.update(presentDt);
    roadStage.update(H.z, sim.roadCleared, presentDt, arenaRig, roadSunDir(), ROAD_LOOK.sunDist);
  }
  world.update(loop.simFrame / 60);
  // trailer: thin the haze. Stage looks rewrite fog.density on a stage change, so rescale whenever it moved.
  if (TRAILER_LOOK && scene.fog && scene.fog.density !== trlFogSet) { scene.fog.density *= TRL_FOG; trlFogSet = scene.fog.density; }
  heroBlobLayer();   // after the final hero pose (IK, plant deficit, leap height) so the blob tracks the drawn feet
  if (!noRender) post.render(presentDt);
}

// ------------------------------------------------------------------ HUD, pause, screens
const ccby = (s) => s.replace(/CC-BY-(\d)\.(\d)/g, 'CC BY $1.$2').replace(/\.+\s*$/, '');
const credit = 'Boss model: ' + ccby(bossManifest.provenance.attribution) + '. Stage 3 boss model: ' + ccby(gauntletManifest.provenance.attribution) + '. Three.js (MIT).';
// Fullscreen: corner button + F key always; BEGIN (a user gesture) also enters it unless ?fs=0. Hidden while recording.
const fullscreen = new Fullscreen().init({ visible: !recMode });
const FS_ON_BEGIN = !recMode && qs.get('fs') !== '0';
const hud = new Hud().init({
  credit, touch: touch.visible,
  chars: { current: CHAR, list: [{ id: 'hero', name: 'THE DUELIST', weapon: 'Sword - claims boss blades' }, { id: 'vesper', name: 'VESPER', weapon: 'Cinder Sabre - fast, rolls' }, { id: 'kael', name: 'KAEL', weapon: 'Astral Glaive - longest reach' }] },
  onChar: (id) => { try { localStorage.setItem('ec.char', id); } catch (e) {} const u = new URL(location.href); u.searchParams.set('char', id); location.href = u.toString(); },
  onStart: () => { if (FS_ON_BEGIN) fullscreen.request(); input.releaseAll(); sim.start(); resetPresentation(); },
  onRetry: () => { input.releaseAll(); input.clearBuffer(); sim.retry(); resetPresentation(); },
  onRestart: () => { input.releaseAll(); input.clearBuffer(); setPaused(false); sim.reset('title'); sim.start(); resetPresentation(); },
  onResume: () => { setPaused(false); captureMouse(); },
});
systems.set('hud', hud);
const roadMap = new RoadMap().init({ route: ROUTE, weaponNames: WEAPONS.map((w) => w ? w.name : ''), reducedMotion });
systems.set('roadmap', roadMap);
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
  const can = sim.state === GameState.INTRO || sim.state === GameState.WAVE || sim.state === GameState.WAVE_CLEAR || sim.state === GameState.BOSS
    || sim.state === GameState.DOOR || sim.state === GameState.STAGE3 || sim.state === GameState.STAGE2 || sim.state === GameState.GATE;
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
  gripFrame.valid = false; GRIP.w = 0;
  prev.hx = H.x; prev.hz = H.z; prev.hy = H.y; prev.hyaw = H.yaw; prev.pdx = H.plantDX; prev.pdz = H.plantDZ;
  const B = sim.brain; prev.bx = B.x; prev.by = B.y; prev.bz = B.z; prev.byaw = B.yaw;
  loco.lastX = H.x; loco.lastZ = H.z; loco.phase = 0;
  fx.streakEnd(HERO_ID); streak.hero = false; fx.clearTelegraph(BOSS_ID); fx.clearFire(); wasFinisher = false; finHitShown = false; hud.clearFx(); breathOn = 0; letterbox(0);
  hero.inert.reset(); boss.inert.reset(); for (const s of slots) s.inert.reset(); dispYaw = null; lean.sp = 0; lean.p = 0; lean.r = 0; lean.yaw = H.yaw;
  swing.aid = -1; bossAnim.lag = 0; bossAnim.foot[0] = bossAnim.foot[1] = 1; bossAnim.lastF = -1; bossAnim.lastVerb = -1; bossAnim.yawPrev = sim.brain.yaw;
  heroReact.amp = 0; bossReact.amp = 0; bossReact.flash = 0; bossReact.look = 0; bossReact.rear = 0; bossReact.lastClip = ''; chargeFx.glow = 0; chargeFx.wasFull = false;
  heroSteel.emissive.setRGB(0, 0, 0); for (const m of bossMats) if (m.emissive) m.emissive.setRGB(0, 0, 0);
  for (let i = 0; i < slots.length; i++) { if (slots[i].actorId >= 0) { fx.streakEnd(slots[i].actorId); fx.clearTelegraph(slots[i].actorId); } streak.d[i] = false; }
  bindSlots(); boss.root.visible = sim.bossActive;
  { const G = sim.gauntlet, gp = gview.prev; gp.x = G.x; gp.y = G.y; gp.z = G.z; gp.yaw = G.yaw; }
  gview.root.visible = sim.stage3Active; gview.hideHazards(); if (gview.inert) gview.inert.reset();
  gview.react.amp = 0; gview.react.flash = 0; gview.seen.dome = false; gview.seen.wave = false; gview.seen.struck.fill(-1);
  fx.clearTelegraph(GAUNTLET_ID); for (const k in G_STREAK_ID) { fx.streakEnd(G_STREAK_ID[k]); gStreak[k] = false; } gstat.wasFin = false; gstat.finHit = false;
  dropGlow.t = 0; dropGlow.ping = -1; dropGlow.w = 0; dropRoot.visible = false;
  if (sim.state !== GameState.DOOR && sim.state !== GameState.GATE) roadMap.hide();
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
    trigger: dmcView.trigger, style: dmcView.style,
    // transitions (DOOR, GATE) show no boss bar: the previous foe's empty bar must not sit on the next stage's card
    boss: S === GameState.GATE || S === GameState.DOOR || S === GameState.LOOT ? null
      : sim.bossActive ? { hp: B.hp, max: BOSS.HP, posture: B.posture, postureMax: BOSS.POSTURE_MAX }
      : sim.stage3Active ? { name: 'CHROME GAUNTLET', hp: sim.gauntlet.hp, max: GAUNTLET.HP, posture: sim.gauntlet.posture, postureMax: GAUNTLET.POSTURE_MAX }
      : sim.stage2Active && sim.warden ? { name: 'SHADOW WARDEN', hp: sim.warden.hp, max: WARDEN.HP, posture: sim.warden.posture, postureMax: WARDEN.POSTURE } : null,
    waveLabel: S === GameState.WAVE ? 'WAVE ' + (sim.wave + 1) + ' / ' + WAVES.length + '<small>' + alive + ' FOE' + (alive === 1 ? ' REMAINS' : 'S REMAIN') + '</small>'
      : S === GameState.BOSS ? 'THE FORD WYVERN' : S === GameState.STAGE3 ? 'THE CHROME GAUNTLET' + (sim.gauntlet.phase >= 2 ? '<small>ENRAGED</small>' : '')
      : S === GameState.STAGE2 ? 'THE SHADOW WARDEN' + (sim.warden && sim.warden.phase >= 2 ? '<small>ENRAGED</small>' : '') : '',
    finisher: sim.finisherReady(), touch: touch.visible, flash: H.flash,
    tip: S === GameState.STAGE3 && (sim.stats.stage3F || 0) > 90 && (sim.stats.stage3F || 0) < 330
      ? (touch.visible ? 'TAP BLOCK JUST BEFORE A HIT  -  JUST GUARD' : 'PRESS BLOCK JUST BEFORE A HIT  -  JUST GUARD')
      : S === GameState.STAGE2 && (sim.stats.stage2F || 0) > 90 && (sim.stats.stage2F || 0) < 330
      ? 'RED RING = DODGE  -  HE GUARDS LIGHTS, BREAK HIS POSTURE' : '',
  }, dt);
  hudFrame = loop.simFrame;
  touch.update && touch.update();
  // v2.23: two-handers cannot roll or quickstep (HeroSim GREAT_NO_EVADE) - grey the buttons so touch shows it
  const canEvade = !(H.wp && GREAT_NO_EVADE);
  touch.setAvailable(A.DODGE, canEvade && H.stamina >= 1);
  touch.setAvailable(A.ROLL, canEvade && H.stamina >= 1);
  touch.setAvailable(A.HEAVY, H.stamina >= 1);
  touch.setAvailable(A.SNATCH, H.stamina >= HERO_SNATCH.STAMINA && H.snatchCd === 0);
  touch.setAvailable(A.SWEEP, !!H.wp && H.stamina >= HERO_SWEEP.SWEEP.stamina);
  touch.setAvailable(A.TRIGGER, H.triggerF > 0 || H.gauge >= HERO_TRIGGER.COST);
  touch.setReady(A.TRIGGER, (H.triggerF === 0 && H.gauge >= HERO_TRIGGER.COST) || H.triggerF >= HERO_RIFT.MIN_LEFT);
  input.lateUpdate(dt);
}

const loop = new Loop({ fixedUpdate, update, lateUpdate, reducedMotion });
// ?flow=1: plain real-time gameplay for footage - no hit-stop, no slow-mo (sim or presentation), no camera shake.
// Sim outcomes are unchanged (dilation never altered them), only the pacing on screen.
const FLOW = qs.get('flow') === '1';
// v2.28: hit-stop / slow-mo on hit is OFF in normal play too (user call: the dragon fight plays at 1.0x, weight comes
// from the authored strikes, impact shake and VFX). ?hitstop=1 restores the v2.27 dilation for A/B.
if (qs.get('hitstop') !== '1') loop.noDilate = true;
if (FLOW) { loop.noDilate = true; cam.impact = cam.deflect = cam.triggerPush = cam.phantomStep = () => {}; }   // no shake, no zoom punch
H.comboOn = qs.get('combo10') !== '0';
H.jumpOn = qs.get('jump') !== '0'; H.stepInOn = qs.get('stepin') !== '0'; H.hopOn = qs.get('hop') !== '0';   // v2.36
H.airStrOn = qs.get('air') !== '0'; H.backCutOn = qs.get('bcut') !== '0';   // v2.37 air string + launcher / back-step crescent
H.danceOn = DANCE_ON && ['dz_l1', 'dz_l2', 'dz_l3', 'dz_l4', 'dz_l5', 'dz_h1', 'dz_h2'].every((c) => AT_OK[c] !== undefined);
H.quickOn = QUICK_ON && ['q_l1', 'q_l2', 'q_l3', 'q_l4', 'q_l5'].every((c) => AT_OK[c] !== undefined);   // v2.38
H.setGreatFoot(GFOOT_ON && ['gl_1a', 'gl_2a', 'gl_3a'].every((c) => AT_OK[c] !== undefined));   // v2.39
// rec showcase only: ?bdmg=0.5 scales damage the wyvern takes so a filmed fight lasts long enough for full strings
// rec showcase only: ?nopick=1 keeps a one-hand dancer from walking into the ford great sword mid-take
if (recMode && qs.get('nopick') === '1') { const _sb = sim._startBoss.bind(sim); sim._startBoss = () => { _sb(); sim.pickup.active = false; }; sim.pickup.active = false; }
if (recMode && qs.get('bdmg')) sim.brain.dmgScale = Math.max(0.1, Math.min(1, +qs.get('bdmg') || 1));

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
  gview.root.visible = true; gview.root.position.set(4, 0, -10); gview.prewarmShow(true);
  for (let i = 0; i < 3; i++) { gview.cols[i].position.set(-3 + i * 3, 0, -6); gview.markers[i].position.set(-3 + i * 3, 0.05, -5); }
  gview.dome.position.set(0, 0, -10); gview.dome.scale.setScalar(3); gview.wave.position.set(0, 0.08, -8); gview.wave.scale.setScalar(3);
  pickupRoot.visible = true; pickupRoot.position.set(4.2, 1.4, -4.6); heroGreat.socket.visible = true;
  dropRoot.visible = true; dropRoot.position.set(-4.2, 1.4, -4.6);
  // v2.25: every generated weapon variant drawn once (each mesh material is its own program family)
  for (const r of [heroGreat, dropSword, pickupSword]) if (r.gen) for (const k in r.gen) r.gen[k].mesh.visible = true;
  if (heroSabre) heroSabre.socket.visible = true; if (heroGlaive) heroGlaive.socket.visible = true;
  lbTop.style.transform = 'scaleY(0)';
  renderer.setRenderTarget(null);
  const arena0 = arena;
  foundry.setVisible(true); shrine.setVisible(true); if (roadStage) roadStage.setVisible(true);
  await renderer.compileAsync(scene, camera, scene);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
  await world.water.prewarm(renderer, scene, camera);
  await post.prewarm();   // composer-target variants (NoToneMapping key) + bloom/grade/output programs
  foundry.setVisible(arena0 === 'foundry'); shrine.setVisible(arena0 === 'shrine'); if (roadStage) roadStage.setVisible(arena0 === 'road');
  fx.prewarmEnd();
  for (const m of poolMeshes) m.visible = false; orbMesh.visible = false;
  gview.hideHazards(); gview.root.visible = sim.stage3Active;
  showGen(heroGreat, Math.max(1, Math.min(4, H.weapon))); showGen(pickupSword, 1); showGen(dropSword, dropGlow.w > 0 ? dropGlow.w : 1);
  setHeroWeapon(H.weapon); pickupRoot.visible = sim.pickup.active && sim.bossActive; dropRoot.visible = false;
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
  post.setSize(innerWidth, innerHeight); for (const k in motes) motes[k].setViewportHeight(renderer.domElement.height);
}
addEventListener('resize', onResize);
loop.start();
if (recMode) setTimeout(() => { if (sim.state === GameState.TITLE) { sim.start(); resetPresentation(); } }, Number(qs.get('recDelay') || 2500));

window.__ember = {
  ready: true, seed, quality: quality.name, loadMs, credit, bot: useBot,
  flashStep() { return { on: HERO_FLASH.on, flashes: H.flashes, flashF: H.flashF, actF: H.actF, st: H.state, duel: sim.duelists.map((d) => [+d.x.toFixed(2), +d.z.toFixed(2), d.hp, d.alive]), hp: H.hp, stamina: H.stamina }; },
  heroActs() { return hero.on.map((a) => [a.getClip().name, +a.getEffectiveWeight().toFixed(2), +a.time.toFixed(2)]).concat([['deflectF', H.deflectF], ['block', H.blocking], ['cine', cam.cineKind || '']]); },
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
  programs() { return { start: progStart, now: renderer.info.programs.length }; },
  // QA (v2.33): skinned edge strain of the hero in the CURRENT engine pose (all IK / inertia layers applied).
  // pairs = flat [a0, b0, a1, b1, ...] vertex indices; returns the fraction of pairs stretched more than thr.
  get __hero() { return hero; },
  dbgStrain(pairs, thr = 0.3) {
    let sk = null; hero.model.traverse((o) => { if (!sk && o.isSkinnedMesh) sk = o; });
    if (!sk) return null;
    hero.model.updateMatrixWorld(true); sk.skeleton.update();
    const pos = sk.geometry.attributes.position, a = new THREE.Vector3(), b = new THREE.Vector3(), a0 = new THREE.Vector3(), b0 = new THREE.Vector3();
    // glTF skinning ignores the mesh node transform: world = sum(w * jointWorld * IBM) * p, with p in metres.
    // getVertexPosition returns that through the attached-mode bindMatrixInverse (= mesh world^-1, which holds the
    // armature's 0.01 scale), so map it back to world with sk.matrixWorld. k = the actor root's uniform world scale
    // (scale of the Hips skin matrix, 1 at bind), divided out so only skinning strain remains.
    const hi = sk.skeleton.bones.findIndex((x) => x.name === 'Hips');
    const Ms = new THREE.Matrix4().multiplyMatrices(sk.skeleton.bones[hi].matrixWorld, sk.skeleton.boneInverses[hi]);
    const k = new THREE.Vector3().setFromMatrixScale(Ms).x;
    let over = 0, max = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      a0.fromBufferAttribute(pos, pairs[i]); b0.fromBufferAttribute(pos, pairs[i + 1]);
      const L0 = a0.distanceTo(b0); if (L0 < 1e-9) continue;
      sk.getVertexPosition(pairs[i], a).applyMatrix4(sk.matrixWorld); sk.getVertexPosition(pairs[i + 1], b).applyMatrix4(sk.matrixWorld);
      const s = a.distanceTo(b) / (k * L0) - 1; if (s > thr) over++; if (s > max) max = s;
    }
    return { frac: over / (pairs.length / 2), max: +max.toFixed(3), n: pairs.length / 2, k: +k.toFixed(4) };
  },
  // QA (v2.19): finish the current boss through its own damage path so LOOT / road map flow can be reviewed fast
  qaKillBoss() {
    if (sim.state === GameState.STAGE2 && sim.warden) { sim.warden.hp = 1; sim.warden.onHeroHit(H, { name: 'HEAVY', dmg: 999, posture: 0 }); return 'warden'; }
    if (sim.state === GameState.STAGE3) { sim.gauntlet.hp = 1; sim.gauntlet.takeHit(999, 0, 0); return 'gauntlet'; }
    if (sim.state === GameState.BOSS) { sim.brain.hp = 1; sim.brain.takeHit ? sim.brain.takeHit(999, 0, 0) : (sim.brain.hp = 0); return 'wyvern'; }
    return null;
  },
  flow() { return { state: GAME_STATE_NAMES[sim.state], stateF: sim.stateF, drop: { ...sim.drop }, shown: dropRoot.visible, weapon: H.weapon, carry: sim.carry, claimed: sim.claimed.slice(), road: { on: roadMap.on, leg: roadMap.leg } }; },
  // QA: gauntlet blade sockets in world space (base, tip, length, visible) plus head/paw bone positions
  dbgBlades() {
    const r = (v) => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)], a = new THREE.Vector3(), b = new THREE.Vector3(), o = {};
    gview.root.updateMatrixWorld(true);
    for (const k of ['crest', 'bladeL', 'bladeR']) { const s = gview[k]; s.base.getWorldPosition(a); s.tip.getWorldPosition(b);
      let vis = true; for (let n = s.blade; n; n = n.parent) if (!n.visible) vis = false;
      o[k] = { base: r(a), tip: r(b), len: +a.distanceTo(b).toFixed(2), vis }; }
    for (const k of ['HEAD', 'PAW_L', 'PAW_R']) { gview[k].getWorldPosition(a); o[k] = r(a); }
    o.root = r(gview.root.position); o.headAhead = gview.headAhead; return o;
  },
  // QA: every DEF bone of the gauntlet in root space (forward = toward +Z of the sim, right, up)
  dbgGBones(re) {
    const R = gview.root, p = new THREE.Vector3(), out = [], rx = new RegExp(re || '^DEF-');
    R.updateMatrixWorld(true); const yaw = R.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw);
    R.traverse((o) => { if (!o.isBone || !rx.test(o.name)) return; o.getWorldPosition(p); const dx = p.x - R.position.x, dz = p.z - R.position.z;
      out.push([o.name, +(dx * fx + dz * fz).toFixed(2), +(dx * fz - dz * fx).toFixed(2), +(p.y - R.position.y).toFixed(2)]); });
    return out;
  },
  // QA: render the scene into a float32 target and report non-finite / over-half-float pixels and the object under them
  dbgHdr(hide) {
    const w = renderer.domElement.width, h = renderer.domElement.height, hid = [];
    if (hide) { const rx = new RegExp(hide); scene.traverse((o) => { if (o.visible && (rx.test(o.name) || (o.isMesh || o.isPoints || o.isSprite) && rx.test(o.type + ':' + [].concat(o.material || []).map((m) => m.type).join(',')))) hid.push(o); }); for (const o of hid) o.visible = false; }
    try { return this._hdr(w, h); } finally { for (const o of hid) o.visible = true; }
  },
  _hdr(w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    const prev = renderer.getRenderTarget(); renderer.setRenderTarget(rt); renderer.render(scene, camera); renderer.setRenderTarget(prev);
    const raw = new Uint16Array(w * h * 4); renderer.readRenderTargetPixels(rt, 0, 0, w, h, raw); rt.dispose();
    const px = new Float32Array(w * h * 4); for (let i = 0; i < raw.length; i++) px[i] = THREE.DataUtils.fromHalfFloat(raw[i]);
    let nan = 0, inf = 0, big = 0, max = 0; const hits = new Map(), rc = new THREE.Raycaster(), nd = new THREE.Vector2();
    for (let i = 0; i < w * h; i++) {
      let bad = 0;
      for (let c = 0; c < 3; c++) { const v = px[i * 4 + c]; if (v !== v) { nan++; bad = 1; } else if (!isFinite(v)) { inf++; bad = 1; } else { if (v > 65000) { big++; bad = 1; } if (v > max) max = v; } }
      if (bad && hits.size < 12) { const x = i % w, y = (i / w) | 0; nd.set((x + 0.5) / w * 2 - 1, (y + 0.5) / h * 2 - 1); rc.setFromCamera(nd, camera);
        const shown = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
        const hit = rc.intersectObjects(scene.children, true).find((o) => o.object.isMesh && shown(o.object));
        const key = hit ? (hit.object.name || '?') + '|' + [].concat(hit.object.material).map((m) => m.name || m.type).join(',') : 'none';
        hits.set(key, (hits.get(key) || 0) + 1); }
    }
    return { w, h, nan, inf, big, max: +max.toFixed(1), hits: [...hits] };
  },
  // QA: mean / p95 luminance of the drawn frame (0-255), read back from the canvas
  lum() {
    post.render(0);
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const hist = new Uint32Array(256); let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 64) { const l = Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]); hist[l]++; sum += l; n++; }
    let c = 0, p95 = 0, p50 = 0; for (let i = 0; i < 256; i++) { c += hist[i]; if (!p50 && c >= n * 0.5) p50 = i; if (c >= n * 0.95) { p95 = i; break; } }
    return { mean: +(sum / n).toFixed(1), p50, p95, arena };
  },
  // QA pick: first visible mesh under an NDC point, with its owner chain and distance from the camera
  pick(nx, ny) {
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
    const hits = rc.intersectObjects(scene.children, true).filter((h) => { for (let o = h.object; o; o = o.parent) if (!o.visible) return false; return true; });
    return hits.slice(0, 3).map((h) => { const chain = []; for (let o = h.object; o && chain.length < 4; o = o.parent) chain.push(o.name || o.type);
      return { d: +h.distance.toFixed(2), chain, p: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)] }; })
      .concat([{ cam: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)], hero: [+H.x.toFixed(2), +H.z.toFixed(2)] }]);
  },
  killBoss() { if (sim.bossActive) sim.brain.takeHit(99999, 0, 'body', false, true); else if (sim.stage3Active) sim.gauntlet.takeHit(99999, 0, 'body', true); return GAME_STATE_NAMES[sim.state]; },
  lights() { let n = 0; scene.traverse((o) => { if (o.isLight && o.visible) n++; }); return n; },
  state() {
    return { frame: loop.simFrame, simFrame: sim.frame, state: GAME_STATE_NAMES[sim.state], wave: sim.wave, paused: loop.paused, arena,
      pass: sim.roadActive ? { leg: sim.roadLeg, ambush: sim.ambushIdx, live: sim.ambushLive, cleared: sim.roadCleared, hx: +H.x.toFixed(2), hz: +H.z.toFixed(2), missing: roadStage ? roadStage.missing : null } : null,
      gauntlet: sim.stage3Active ? { hp: sim.gauntlet.hp, state: sim.gauntlet.state, x: sim.gauntlet.x, z: sim.gauntlet.z } : null,
      warden: sim.stage2Active && sim.warden ? { hp: sim.warden.hp, state: sim.warden.state, phase: sim.warden.phase, verb: sim.warden.verb, x: sim.warden.x, z: sim.warden.z, f: sim.warden.f, wmo: { applied: wardenMotion.applied, peak: wardenMotion.peak }, counts: Object.assign({}, sim.warden.verbCounts || {}) } : null,
      screen: hud._screen, hash: sim.hash(), heroHp: H.hp, heroState: H.state, stamina: H.stamina, bossHp: sim.brain.hp,
      dmc: { gauge: +H.gauge.toFixed(2), triggerF: H.triggerF, triggers: H.triggers, snatches: H.snatches, snatchCd: H.snatchCd,
        rifts: H.rifts, riftF: H.riftF, riftCuts: H.riftCuts, riftHits: H.riftHits, riftFx: fx.stats.rifts || 0,
        rank: sim.style.rank, letter: sim.style.letter, peak: sim.style.peak, points: +sim.style.points.toFixed(1),
        hud: { rank: hud.el.rankB.textContent, rankOn: hud.el.rank.classList.contains('on'), tg: hud._tgCls } },
      duelists: sim.duelists.map((d) => ({ hp: d.hp, alive: d.alive })), stats: { ...sim.stats }, run: { ...runStats },
      backDot: H.maxBackwardDot, camMin: cam.minClearance, camResets, quickstep: Object.keys(QUICKSTEP.clips),
      cam: { shot: cam.shot, trauma: cam.trauma, push: cam.push, phantom: cam.phantom, orbitYaw: cam.orbitYaw, heroYaw: H.yaw, timeScale: loop.timeScale,
        dist: Math.hypot(camera.position.x - H.x, camera.position.z - H.z), occFrames: cam.occFrames, occYaw: cam.occYaw, occOn: cam.occluder.active },
      cine: { kind: CINE_NAMES[cam.cineKind], w: cam.cineW, log: cam.cineLog.slice() }, fx: fx.counts(), postBlur: +(post.blur || 0).toFixed(3), rec: recMode, lunge: Object.keys(lungeOk),
      step: { kind: H.stepKind, dodgeF: H.dodgeF, clip: hero.on.length ? hero.on[0].getClip().name : '', verb: H.state === HERO_STATE.ACTION ? H.verb : H.state === HERO_STATE.FINISHER ? 'FINISHER' : '', hs: H.state },
      jump: { y: +(H.y || 0).toFixed(3), jumps: H.jumps || 0, jumpF: H.jumpF || 0, hop: +(H.hopDist || 0).toFixed(2), air: H.state === HERO_STATE.AIR }, programs: { start: progStart, now: renderer.info.programs.length },
      weapon: H.weapon, grip: { w: +GRIP.w.toFixed(3), n: GRIP.n, far: GRIP.far, errMeanMm: GRIP.n ? +(GRIP.err / GRIP.n * 1000).toFixed(2) : 0, errMaxMm: +(GRIP.errMax * 1000).toFixed(2), speed: +H.speed.toFixed(3), loco: H.state === HERO_STATE.LOCO, eMm: +((GRIP.e || 0) * 1000).toFixed(1), dbg: GRIP.dbg }, heroXZ: [+H.x.toFixed(2), +H.z.toFixed(2), +H.yaw.toFixed(3)], pickup: { x: sim.pickup.x, z: sim.pickup.z, active: sim.pickup.active, takenF: sim.pickup.takenF, shown: pickupRoot.visible }, drop: { ...sim.drop, shown: dropRoot.visible, carry: sim.carry, claimed: sim.claimed.slice() }, road: { on: roadMap.on, leg: roadMap.leg },
      dropped: loop.droppedSteps, touch: touch.visible, fs: { supported: fullscreen.supported, mode: fullscreen.mode, active: fullscreen.active, requests: fullscreen.requests }, hud: { hp: hud.el.hpI.style.transform, boss: hud.el.boss.style.display } };
  },
  // camera framing probe (QA): hero chest in NDC + camera forward bearing, read straight off the rendered camera
  camProbe() {
    const v = new THREE.Vector3(H.x, colliders.terrainY(H.z) + 1.2, H.z).project(camera), f = new THREE.Vector3();
    camera.getWorldDirection(f);
    return { nx: v.x, ny: v.y, nz: v.z, yaw: Math.atan2(f.x, f.z), fov: camera.fov, boom: cam.cur.boom, pulledIn: cam.pulledIn, dist: camera.position.distanceTo(new THREE.Vector3(H.x, camera.position.y, H.z)), shot: cam.shot, trauma: cam.trauma, timeScale: loop.timeScale, state: GAME_STATE_NAMES[sim.state], cine: cam.cineActive ? cam.cineW : 0,
      cineKind: CINE_NAMES[cam.cineKind], road: cam.roadMode, roadYaw: cam.roadMode ? cam.roadYaw + Math.PI : null, assist: +cam.assistW.toFixed(3), cx: camera.position.x, cy: camera.position.y, cz: camera.position.z, hz: H.z, amb: sim.ambushIdx, live: sim.ambushLive, fitR: +(cam.cineFitR || 0).toFixed(2), fitD: +(cam._fitD || 0).toFixed(2),
      cineT: +cam.cineT.toFixed(2), camHero: +Math.hypot(camera.position.x - H.x, camera.position.z - H.z).toFixed(2),
      foes: cam.roadMode ? sim.duelists.filter((d) => d.alive && Math.hypot(d.x - H.x, d.z - H.z) < 16).map((d) => { const p = new THREE.Vector3(d.x, colliders.terrainY(d.z) + 1.1, d.z).project(camera); return [+p.x.toFixed(3), +p.y.toFixed(3), p.z < 1 ? 1 : 0]; }) : [] };
  },
  jerk() { return { inert: INERT_ON, smooth: clipSmooth, heroKeys: hero.actions.light_1.getClip().tracks.map((t) => t.times.length).slice(0, 3), hero: jerk.hero.report(), boss: jerk.boss.report(), blends: { hero: hero.inert.blends, boss: boss.inert.blends } }; },
  dbgInert() { const r = []; for (const b of hero.inert.bones) { const q = b.quaternion; r.push([b.name, +q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)]); } return { r, t: hero.inert.t, dur: hero.inert.dur, clip: hero.inert.clip, st: H.state }; },
  resetJerk() { jerk.hero.reset(); jerk.boss.reset(); return true; },
  // v2.31 QA: hero contact blob (world pos, radius, opacity, foot lift) plus its centre and hero hips in screen px
  blobRay(x, z) {   // QA: top render surfaces under (x, z), ignoring the hero and the blob
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 6, z), new THREE.Vector3(0, -1, 0), 0, 12), out = [];
    for (const h of rc.intersectObject(scene, true)) {
      let o = h.object, skip = o === heroBlob.mesh || !o.visible; while (o && !skip) { if (o === hero.root) skip = true; o = o.parent; }
      if (!skip) out.push({ y: +h.point.y.toFixed(3), name: h.object.name || (h.object.parent && h.object.parent.name) || '?' });
      if (out.length >= 3) break;
    }
    return { x, z, terr: +colliders.terrainY(z).toFixed(3), hits: out };
  },
  blobHide(h) { heroBlob.qaHide = !!h; heroBlob.mesh.visible = BLOB_ON && !h; post.render(0); return true; },
  blob() { const B = heroBlob, m = B.mesh; _blH.copy(m.position).project(camera);
    const o = { on: BLOB_ON, vis: m.visible, x: +m.position.x.toFixed(3), y: +m.position.y.toFixed(3), z: +m.position.z.toFixed(3),
      r: +B.r.toFixed(3), a: +B.a.toFixed(3), lift: +B.lift.toFixed(3), heroY: +(H.y || 0).toFixed(3),
      sx: Math.round((_blH.x * 0.5 + 0.5) * innerWidth), sy: Math.round((-_blH.y * 0.5 + 0.5) * innerHeight),
      dHero: +Math.hypot(m.position.x - hero.root.position.x, m.position.z - hero.root.position.z).toFixed(3),
      terr: +colliders.terrainY(m.position.z).toFixed(3), raw: +(heroBlob.raw || 0).toFixed(3) };
    // screen radius: project a point r metres to the camera's right of the centre
    camera.getWorldDirection(_blL); _blR.set(-_blL.z, 0, _blL.x).normalize().multiplyScalar(B.r).add(m.position).project(camera);
    o.spx = Math.round(Math.abs(_blR.x - _blH.x) * 0.5 * innerWidth); return o; },
  // v2.30 QA: great-sword ref #12 counters (wave line, leap height, recovery hold tail)
  gsx() { return { y: +(H.y || 0).toFixed(3), waves: H.waves, waveHits: H.waveHits, leaps: H.leaps, live: H.wave.live, speed: +H.speed.toFixed(2),
    hold: Math.max(0, (loco.gsHoldEnd || 0) - H.frame) }; },
  dbgTrace(n) { trace.on = true; trace.rows.length = 0; jerkRaw.reset(); jerk.hero.reset(); for (let i = 0; i < n; i++) loop.advance(1 / 60); trace.on = false; return trace.rows.slice(); },
  frames() { const n = Math.min(ftN, ft.length); return Array.from(ft.subarray(0, n)); },
  resetFrames() { ftN = 0; lastNow = 0; },
  layout: () => touch.layoutReport(),
  // ink probe (QA): live streak slots as owner / tint / life / sample count / guard->tip span of the newest sample
  // QA only (?god=1): fill the Ember Trigger gauge so the keyboard path can be tested without a long combo
  grantGauge(n) { if (qs.get('god') === '1') H.gauge = Math.min(HERO_TRIGGER.MAX, n); return H.gauge; },
  dbgStreaks() { const r = [], S = FX_CAPS.streakSamples, Hh = fx.stHist; for (let s = 0; s < 4; s++) { if (fx.stLife[s] <= 0) continue; const b = s * S * 6;
    r.push({ owner: fx.stOwner[s], hero: fx.stOwner[s] === HERO_ID, active: fx.stActive[s], life: +fx.stLife[s].toFixed(3), n: fx.stCount[s],
      tint: [+fx.stTint[s * 3].toFixed(2), +fx.stTint[s * 3 + 1].toFixed(2), +fx.stTint[s * 3 + 2].toFixed(2)],
      tipToHero: +Math.hypot(Hh[b + 3] - H.x, Hh[b + 5] - H.z).toFixed(2) }); } return r; },
  // Recorder lockstep: stop RAF, then each advance(n) runs n exact 1/60 s frames (sim + render), so captured
  // footage is a true 60 fps regardless of how slow the capture itself is.
  lockstep() { loop.stop(); return true; },
  unlock() { loop.start(); return true; },
  press(k) { qaPress = k; return true; },
  place(x, z, yaw = 0) { const w = H.weapon; H.reset(x, z, yaw); if (w > 0) { H.weapon = 0; H.equip(w); } return [H.x, H.z]; },   // QA: open-ground review spot   // QA: one command flag on the next sim step (sweep / attack / heavy / trigger ...)
  // v2.22 QA: foot bone world positions (m), sword tip height above terrain, sweep counters
  v222() {
    const o = { sweeps: H.sweeps, knocks: H.knocks, dealt: H.damageDealt, tipY: null, feet: null, f: H.state === HERO_STATE.ACTION ? H.actF : H.state === HERO_STATE.RIFT ? H.riftF : -1,
      sc: +(hero.root.scale.x * hero.pivot.scale.x * hero.model.scale.x).toFixed(4), trig: H.triggerF, hs: H.state, ct: hero.pt,
      req: H.dbgReq, push: H.dbgPush, pre: H.dbgPre, x0: H.dbgX0, lim: [colliders.halfX, colliders.halfZ],
      x: H.x, z: H.z, yaw: H.yaw, rx: hero.root.position.x, rz: hero.root.position.z, ry: hero.root.rotation.y };
    if (heroSword && heroSword.tip) { heroSword.tip.getWorldPosition(_a); o.tipY = +(_a.y - colliders.terrainY(_a.z)).toFixed(3); }
    const L = hero.model.getObjectByName('LeftFoot'), R = hero.model.getObjectByName('RightFoot');
    if (L && R) { L.getWorldPosition(_a); R.getWorldPosition(_b); const g = colliders.terrainY(H.z);
      o.feet = { L: [+_a.x.toFixed(4), +(_a.y - g).toFixed(4), +_a.z.toFixed(4)], R: [+_b.x.toFixed(4), +(_b.y - g).toFixed(4), +_b.z.toFixed(4)] };
      const LT = hero.model.getObjectByName('LeftToeBase'), RT = hero.model.getObjectByName('RightToeBase');
      if (LT && RT) { LT.getWorldPosition(_a); RT.getWorldPosition(_b);
        o.toes = { L: [+_a.x.toFixed(4), +(_a.y - g).toFixed(4), +_a.z.toFixed(4)], R: [+_b.x.toFixed(4), +(_b.y - g).toFixed(4), +_b.z.toFixed(4)] }; } }
    return o;
  },
  // QA attribution: re-render the current frame with named fx children hidden (prefix match), then restore.
  // Visibility only - no program change, no sim step. Returns the names that were hidden.
  dbgRenderWithout(prefixes, bloomOff) {
    const hid = [];
    fx.group.traverse((o) => { if (o !== fx.group && o.visible && prefixes.some((p) => o.name.startsWith(p))) { o.visible = false; o.userData.__qaHid = true; hid.push(o.name); } });
    if (bloomOff && post.bloom) { post.__qaBs = post.bloom.strength; post.bloom.strength = 0; }
    post.render(0);
    return hid;
  },
  dbgRestore() {
    fx.group.traverse((o) => { if (o.userData.__qaHid) { o.visible = true; o.userData.__qaHid = false; } });
    if (post.bloom && post.__qaBs !== undefined) { post.bloom.strength = post.__qaBs; post.__qaBs = undefined; }
    post.render(0); return true;
  },
  dbgFxNames() { const n = []; fx.group.traverse((o) => { if (o !== fx.group && o.visible) n.push(o.name); }); return n; },
  world: () => ({ stats: world.stats, programs: renderer.info.programs.length, calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
  // review camera (QA screenshots only): stops the loop, places the camera, renders one frame
  reviewCam(p, t) { loop.stop(); camera.position.set(p[0], p[1], p[2]); camera.lookAt(t[0], t[1], t[2]); placeFill(); post.render(0); return true; },
  // QA: hold the hero in one clip frame (optionally with the grip IK applied) and frame a close-up of the hands
  holdPose(clip, f, ik = true, view = 'left', dist = 1.4) {
    // v2.24: shows the character's own loadout (Kael glaive, Vesper sabre one-handed, hero great sword)
    const hw = heroGlaive ? 5 : heroSabre ? 0 : 1; loop.stop(); setHeroWeapon(hw);
    pose(hero, 1, clip, 1, f / 60); hero.model.updateMatrixWorld(true);
    const saveW = H.weapon; H.weapon = Math.max(1, hw); if (CHAR !== 'hero') tipFloorGuard(); GRIP.w = ik && hw >= 1 ? 1 : 0; if (ik && hw >= 1) leftGripIK(0); tipFloorPost(); H.weapon = saveW;
    const c = new THREE.Vector3(), r = new THREE.Vector3(); heroBones.LeftHand.getWorldPosition(c); heroBones.RightHand.getWorldPosition(r); c.add(r).multiplyScalar(0.5);
    const yaw = H.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw), sx = view === 'left' ? -1 : view === 'right' ? 1 : 0;
    const dx = view === 'front' ? fx : -fz * sx, dz = view === 'front' ? fz : fx * sx;
    camera.position.set(c.x + dx * dist, c.y + 0.25, c.z + dz * dist); camera.lookAt(c); placeFill(); post.render(0);
    return true;
  },
  // v2.24 QA: current weapon geometry in hero-root space (x right, y up, z forward): hilt / tip, blade dir, hand
  // gaps (m), and the closest blade point to the Head / Spine02 bones (clip check). Call after holdPose.
  dbgWeapon() {
    const S = heroSword, a = new THREE.Vector3(), b = new THREE.Vector3(), h = new THREE.Vector3(), l = new THREE.Vector3(), r = new THREE.Vector3(), p = new THREE.Vector3();
    hero.root.updateMatrixWorld(true); S.hilt.getWorldPosition(a); S.tip.getWorldPosition(b);
    heroBones.RightHand.getWorldPosition(r); heroBones.LeftHand.getWorldPosition(l);
    const segD = (bone) => { bone.getWorldPosition(h); const ab = p.subVectors(b, a), t = Math.max(0, Math.min(1, h.clone().sub(a).dot(ab) / ab.lengthSq())); return +a.clone().addScaledVector(ab, t).distanceTo(h).toFixed(3); };
    const inv = new THREE.Matrix4().copy(hero.root.matrixWorld).invert(), loc = (v) => { const q = v.clone().applyMatrix4(inv); return [+q.x.toFixed(3), +q.y.toFixed(3), +(-q.z).toFixed(3)]; };
    const d = b.clone().sub(a).normalize().transformDirection(inv);
    return { ch: CHAR, w: H.weapon, hilt: loc(a), tip: loc(b), dir: [+d.x.toFixed(3), +d.y.toFixed(3), +(-d.z).toFixed(3)], len: +a.distanceTo(b).toFixed(3),
      rGap: +r.distanceTo(a).toFixed(3), lGap: +l.distanceTo(a).toFixed(3), head: segD(heroBones.Head), chest: segD(heroBones.Spine02), tipY: +(b.y - colliders.terrainY(b.z)).toFixed(3) };
  },
  // QA: raw-clip grip residual (mm) at one frame with the IK applied and no presentation layers
  dbgHeroPose() { const r = {}; hero.model.traverse((o) => { if (o.isBone) { const q = o.quaternion, p = o.position; r[o.name] = [q.x, q.y, q.z, q.w, p.x, p.y, p.z].map((v) => +v.toFixed(4)); } }); const s = heroGreat.socket.quaternion; return { pc: hero.pc, pt: hero.pt, bones: r, sock: [s.x, s.y, s.z, s.w].map((v) => +v.toFixed(4)), rs: hero.model.scale.toArray(), rp: hero.model.position.toArray() }; },
  handWorld() { const q = new THREE.Quaternion(); heroBones.RightHand.getWorldQuaternion(q); return [q.x, q.y, q.z, q.w]; },
  gripAt(clip, f) {
    pose(hero, 1, clip, 1, f / 60); hero.model.updateMatrixWorld(true);
    const saveW = H.weapon; H.weapon = 1; GRIP.w = 1; leftGripIK(0); H.weapon = saveW; hero.model.updateMatrixWorld(true);
    const a = new THREE.Vector3().copy(FIST.L).applyMatrix4(heroBones.LeftHand.matrixWorld), t = new THREE.Vector3().copy(GRIP.fist);
    heroGreat.socket.localToWorld(t); return { eMm: +(a.distanceTo(t) * 1000).toFixed(1), dbg: GRIP.dbg };
  },
  heroClips: () => Object.keys(hero.actions),
  // v2.30 QA: on-screen lift (px, 720p-normalised) of the lower foot above the floor point under it
  liftPx() {
    const a = new THREE.Vector3(), b = new THREE.Vector3(); let best = null;
    for (const n of ['LeftFoot', 'RightFoot']) { const bn = heroBones[n]; if (!bn) continue; bn.getWorldPosition(a); b.set(a.x, colliders.terrainY(a.z), a.z);
      const fy = a.clone().project(camera).y, gy = b.project(camera).y, px = (fy - gy) * 0.5 * 720; best = best === null ? px : Math.min(best, px); }
    return best === null ? null : +best.toFixed(1);
  },
  charSocket: () => ({ char: CHAR, socket: HERO_SOCKET }),   // v2.24: promo renders reuse the retargeted RightHand socket
  // QA: left / right FIST centres (skin-weighted hand vertices) in great-sword socket space per clip frame
  gripScan(clip, step = 2) {
    const a = hero.actions[clip]; if (!a) return null;
    const out = [], pw = new THREE.Vector3(), n = Math.floor(a.getClip().duration * 60);
    for (let f = 0; f <= n; f += step) {
      pose(hero, 1, clip, 1, f / 60); hero.model.updateMatrixWorld(true);
      pw.copy(FIST.L).applyMatrix4(heroBones.LeftHand.matrixWorld); const l = heroGreat.socket.worldToLocal(pw).toArray();
      pw.copy(FIST.R).applyMatrix4(heroBones.RightHand.matrixWorld); const r = heroGreat.socket.worldToLocal(pw).toArray();
      heroBones.LeftArm.getWorldPosition(pw); const sh = heroGreat.socket.worldToLocal(pw).toArray();
      out.push({ f, l: l.map((v) => +v.toFixed(3)), r: r.map((v) => +v.toFixed(3)), sh: sh.map((v) => +v.toFixed(3)) });
    }
    return out;
  },
  // QA: sword-tip world speed (m/s) per clip frame on the hero rig, standard blade (used to author strike windows)
  tipScan(clip, great = false) {
    const a = hero.actions[clip]; if (!a) return null;
    const blade = great && heroGreat.tip ? heroGreat : heroSwordStd, vis = heroGreat.socket.visible;
    if (great) heroGreat.socket.visible = true;
    try { return tipScanWith(a, clip, blade); } finally { heroGreat.socket.visible = vis; }
  },
  // v2.37 QA: leg read of the hero in this frame (knee flex in rad, feet apart along / across the body, tuck axis vs sim right)
  airProbe() {
    const B = heroBones, p = (b) => b.getWorldPosition(new THREE.Vector3());
    const hl = p(B.LeftUpLeg), hr = p(B.RightUpLeg), kl = p(B.LeftLeg), kr = p(B.RightLeg), fl = p(B.LeftFoot), fr = p(B.RightFoot);
    const flex = (h, k, f) => +k.clone().sub(h).angleTo(f.clone().sub(k)).toFixed(2);
    const r = hr.clone().sub(hl).normalize(), fw = new THREE.Vector3(r.z, 0, -r.x).normalize(), d = fl.clone().sub(fr), tip = heroSwordStd.tip.getWorldPosition(new THREE.Vector3());
    return { f: sim.frame, verb: H.state === HERO_STATE.ACTION ? H.verb : HERO_STATE_NAMES_QA[H.state] || String(H.state), actF: H.actF, y: +(H.y || 0).toFixed(2),
      kL: flex(hl, kl, fl), kR: flex(hr, kr, fr), across: +Math.abs(d.dot(r)).toFixed(2), along: +d.dot(fw).toFixed(2), ax: +airBody.ax.toFixed(2),
      footL: +(fl.y - hl.y).toFixed(2), footR: +(fr.y - hr.y).toFixed(2), tipY: +(tip.y - hero.root.position.y).toFixed(2), wave: H.wave.live ? +H.wave.d.toFixed(2) : -1,
      gy: +colliders.terrainY(H.z).toFixed(2), hipY: +((hl.y + hr.y) * 0.5 - colliders.terrainY(H.z)).toFixed(2), headY: +(B.Head ? p(B.Head).y - colliders.terrainY(H.z) : 0).toFixed(2),
      footMin: +(Math.min(fl.y, fr.y) - colliders.terrainY(H.z)).toFixed(2), dodgeF: H.dodgeF, st: H.state, tuck: +airBody.t.toFixed(2), flip: +bflip.u.toFixed(2),
      sh: +(B.Head ? Math.abs(p(B.Head).project(camera).y - (fl.y < fr.y ? fl : fr).clone().project(camera).y) * 0.5 : 0).toFixed(3), cd: +p(B.Hips).distanceTo(camera.position).toFixed(2),
      sx: +(p(B.Hips).project(camera).x * 0.5 + 0.5).toFixed(4), sy: +(0.5 - p(B.Hips).project(camera).y * 0.5).toFixed(4),
      // t12: head / lowest foot / blade tip on screen (0 = top edge) and where the last air crescent opened vs the blade
      hsy: +(B.Head ? 0.5 - p(B.Head).project(camera).y * 0.5 : 0).toFixed(3), fsy: +(0.5 - (fl.y < fr.y ? fl : fr).clone().project(camera).y * 0.5).toFixed(3),
      tsx: +(tip.clone().project(camera).x * 0.5 + 0.5).toFixed(3), tsy: +(0.5 - tip.clone().project(camera).y * 0.5).toFixed(3), cres: +(dmc.cresD || 0).toFixed(2) };
  },
  tipScanStd(clip) {
    const a = hero.actions[clip]; if (!a) return null;
    const n = Math.floor(a.getClip().duration * 60), out = [], p = new THREE.Vector3(), q = new THREE.Vector3(), r0 = hero.root.position.clone();
    hero.root.position.set(0, 0, 0); hero.root.rotation.y = 0; hero.root.updateMatrixWorld(true);
    for (let f = 0; f <= n; f++) { pose(hero, 1, clip, 1, f / 60); hero.root.updateMatrixWorld(true); heroSwordStd.tip.getWorldPosition(p);
      out.push([f, +(f ? p.distanceTo(q) * 60 : 0).toFixed(2), +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)]); q.copy(p); }
    hero.root.position.copy(r0); return out;
  },
  // film v14: play a written fight. sheet = { steps: [...] } (see src/game/Choreo.js). Boss arena only.
  choreo(sheet) {
    if (!choreo) choreo = new Choreo({ H, sim, HS: HERO_STATE, BS: BRAIN_STATE, BossVerb, RUN: SIM.RUN_SPEED, WALK: SIM.WALK_SPEED, STAM: SIM.STAMINA_MAX,
      bossR: BOSS.BODY_RADIUS, DODGE_CANCEL: HERO_DODGE.cancelFrom, ty: (z) => colliders.terrainY(z), clip: () => hero.pc, cine: () => cam.cineActive, clear: (x, y, z) => colliders.clearance(x, y, z), hitI: () => colliders.hit.index, coll: () => { const C = colliders, o = []; for (let i = 0; i < C.count; i++) o.push([i, C.kind[i], +C.cx[i].toFixed(1), +C.cz[i].toFixed(1), +C.hx[i].toFixed(2), +C.hz[i].toFixed(2), +C.cy[i].toFixed(1), +C.hy[i].toFixed(1)]); return o; }, ...(() => { const E = Object.entries(bossBones).filter(([, o]) => o && o.matrixWorld), v = E.map(() => new THREE.Vector3());
        return { occN: E.map(([k]) => k), occR: E.map(([k]) => /spine/i.test(k) ? 1.5 : /neck|head|pelvis|hip/i.test(k) ? 0.8 : 0.5),
          occ: () => { for (let i = 0; i < E.length; i++) v[i].setFromMatrixPosition(E[i][1].matrixWorld); return v; } }; })() });
    sim.pickup.active = false; return choreo.load(sheet);
  },
  choreoReport() { return choreo ? choreo.report() : null; },
  forceBossVerb(name) { const v = BossVerb[name]; if (v === undefined) return false; sim.brain.forceNext = v; return true; },
  advance(n = 1) { for (let i = 0; i < n; i++) { loop.advance(1 / 60); } return { state: GAME_STATE_NAMES[sim.state], frame: sim.frame, cine: CINE_NAMES[cam.cineKind],
    // recorder beat log: rifts, triggers, finishers, perfect deflects, hero state, time scale
    ev: [H.rifts, H.triggers, sim.stats.finishers || 0, runStats.perfect || 0, H.state, +loop.timeScale.toFixed(2), runStats.hits || 0, sim.stats.heroHits || 0,
  sim.brain ? sim.brain.verb : -1, sim.brain ? sim.brain.state : -1, +(post.flash || 0).toFixed(2),
  // hero + boss screen x (0..1) so a 9:16 cut can follow the action
  +(_scrX(H.x, 1.0, H.z)).toFixed(3), sim.bossActive ? +(_scrX(boss.root.position.x, 2.0, boss.root.position.z)).toFixed(3)
    : sim.stage3Active ? +(_scrX(gview.root.position.x, 2.0, gview.root.position.z)).toFixed(3)
    : sim.stage2Active && sim.warden && sim.warden.alive ? +(_scrX(slots[0].root.position.x, 1.4, slots[0].root.position.z)).toFixed(3) : -1,
  // cols 15/16: active verb (VERB_IDX, 0 = none) and charge level, so a cut can hold whole combo strings
  H.state === HERO_STATE.ACTION ? (VERB_IDX[H.verb] || 0) : 0, +(H.chargeLvl || 0).toFixed(2),
  // cols 17/18: combo depth of the playing verb (1..10, 0 = none) and its heavy-press bitmask (HUD pips)
  H.state === HERO_STATE.ACTION ? H.comboN : 0, H.comboMask,
  // col 19: carried weapon id (0 sword, 1 great sword, 2 fang, 3 odachi, 4 frostbrand) for film cutting
  H.weapon | 0,
  // col 20 (v2.32): the clip actually playing for the active verb, so a cut can prove no animation repeats
  H.state === HERO_STATE.ACTION ? (heroLightVar() || (H.weapon >= 1 && GS_SET[H.verb] ? GS_SET[H.verb].clip + ':' + H.verb : (H.verbs[H.verb].foot || H.verbs[H.verb].clip))) : ''] }; },
  begin() { if (sim.state === GameState.TITLE) { input.releaseAll(); sim.start(); resetPresentation(); } return GAME_STATE_NAMES[sim.state]; },
  pump(n) { const p = loop.paused; loop.paused = false; for (let i = 0; i < n; i++) loop.step(); loop.paused = p; update(0, 1, 0); return sim.frame; },
  dispose() {
    loop.dispose(); removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisPause); document.removeEventListener('pointerlockchange', onLockLost);
    sim.dispose(); hud.dispose(); roadMap.dispose(); fullscreen.dispose(); touch.dispose(); input.dispose(); fx.dispose(); cam.dispose(); world.dispose(); look.dispose(); bus.dispose();
    for (const a of [hero, boss, ...slots]) a.mixer.stopAllAction();
    scene.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); for (const m of [].concat(o.material)) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); } } });
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  },
};
