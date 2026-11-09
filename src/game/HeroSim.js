// HeroSim - player hero simulation for the full game (owner: game). No THREE, no DOM, no Math.random.
// Fixed 60 Hz. Reads a per-step command built from the input layer (or the QA bot), owns position, yaw,
// stamina, HP and the verb state machine. Field names match what WyvernBrain / DuelistSim read on a hero
// (x, z, y, yaw, radius, invuln, dodgeF, deflectF, blocking, stepDirX/Z, stepToward, pushX/Z, id).
// Verb frame data comes from assets/attack-timing.json (same table the controls page plays).
import { SIM } from '../shared/constants.js';
import { Outcome } from '../shared/enums.js';
import { footStep } from '../shared/attackFoot.js';

export const HERO_STATE = Object.freeze({ LOCO: 0, ACTION: 1, DODGE: 2, HITSTUN: 3, DEAD: 4, FINISHER: 5, SNATCH: 6, RIFT: 7 });
export const HERO_STATE_NAMES = Object.freeze(['LOCO', 'ACTION', 'DODGE', 'HITSTUN', 'DEAD', 'FINISHER', 'SNATCH', 'RIFT']);
// v2.21 RIFT ("Ember Rift"): Judgment-Cut-End adapted from the Jessica13007 reference. Only while Ember Trigger burns
// with at least MIN_LEFT frames left: press Trigger again. The hero plants and sheathes (STARTUP, invulnerable),
// CUTS space-cuts land on every targetable foe within RANGE (any direction, one actionId per cut), then the
// re-sheathe FINALE lands one heavy hit and spends the rest of the trigger. Invulnerable until FINALE + 6.
export const HERO_RIFT = Object.freeze({ STARTUP: 22, CUTS: 6, CUT_EVERY: 4, RANGE: 8.5, FINALE: 54, TOTAL: 86, MIN_LEFT: 150,
  CUT_DMG: 9, CUT_POSTURE: 16, END_DMG: 38, END_POSTURE: 70 });
// v2.14 DMC layer (studied from DMC5 Nero vs Vergil DMD footage; see docs/STYLE_SPEC.md).
// SNATCH: Nero's Wire Snatch adapted - an ember chain zips the hero to the nearest foe inside RANGE. Startup is
// vulnerable (no i-frames), travel is fast and ends just inside sword reach, recovery is cancellable into any
// attack (the "snatch into combo" loop). Big foes (bosses) pull the hero; it never moves the target.
export const HERO_SNATCH = Object.freeze({ RANGE: 11.0, MIN: 3.2, STARTUP: 7, TRAVEL_MAX: 16, SPEED: 0.62, RECOVER: 12, CANCEL_FROM: 2, STAMINA: 14, STOP_AT: 0.7, COOLDOWN: 24 });
// TRIGGER: Devil Trigger adapted as "Ember Trigger". Gauge 0..100 fills from style (StyleMeter) and landed hits.
// Activate at >= COST: TRIGGER_F frames of x DMG damage / x POSTURE posture, stamina regen x STAM, health drain
// reversed into slow regen, and a short invulnerable burst on activation (BURST_F) that knocks foes back.
export const HERO_TRIGGER = Object.freeze({ MAX: 100, COST: 50, DRAIN: 100 / (60 * 12), DMG: 1.3, POSTURE: 1.4, STAM: 1.8, HEAL_PER_S: 3, BURST_F: 18, BURST_R: 3.2, HIT_GAIN: 0.6 });

// gameplay numbers per verb (frame data comes from the timing table)
export const HERO_VERBS = Object.freeze({
  LIGHT_1: { clip: 'light_1', stamina: 12, lunge: 0.35, chainTo: 'LIGHT_2', chain: [16, 30], dodgeFrom: 20, dmg: 14, posture: 12 },
  LIGHT_2: { clip: 'light_2', stamina: 12, lunge: 0.35, chainTo: 'LIGHT_3', chain: [15, 31], dodgeFrom: 19, dmg: 14, posture: 12 },
  LIGHT_3: { clip: 'light_3', stamina: 16, lunge: 0.60, chainTo: null, chain: null, dodgeFrom: 30, dmg: 20, posture: 18 },
  HEAVY: { clip: 'heavy', stamina: 30, lunge: 0.80, chainTo: null, chain: null, dodgeFrom: 50, dmg: 32, posture: 34 },
});
// v2.22 great-sword SWEEP pair (Blender-authored gs_sweep / gs_sweep_rev over MotionBricks fw_sweep / fw_sweep_rev).
// Great sword only. Frame data is 1:1 with the authored clips (already at great-sword pace, so no SWING stretch).
// Contact: wide arc (cos >= ARC, about 100 deg each side of facing) instead of the 70 deg cone, every foe in the arc
// once per actionId, knockback KNOCK metres over KNOCK_F frames (non-boss only). Travel and turn come from the
// footwork root curve (foot), never from a lunge, so the planted feet in the clip match the sim exactly.
// SWEEP chains into SWEEP_REV with a second sweep press inside chain[].
export const HERO_SWEEP = Object.freeze({
  SWEEP: { clip: 'gs_sweep', foot: 'at_sweep', startup: 34, active: 13, total: 64, chainTo: 'SWEEP_REV', chain: [40, 58], dodgeFrom: 50,
    stamina: 26, dmg: 16, posture: 20, reach: 1.35, arc: -0.17, knock: 1.2 },
  SWEEP_REV: { clip: 'gs_sweep_rev', foot: 'at_sweep_rev', startup: 31, active: 13, total: 60, chainTo: null, chain: null, dodgeFrom: 48,
    stamina: 24, dmg: 18, posture: 24, reach: 1.35, arc: -0.17, knock: 1.4 },
  KNOCK_F: 10,
});
// v2.30 great sword weight pass (ref #12, God Eater 2 long blade; docs/COMBO_SPEC.md "Great sword reference").
// COIL: two-hander LIGHT_1 / LIGHT_2 startup is lengthened to `startup` frames (was 13 / 12 after the SWING stretch).
//   The extra frames are spent winding up (presentation warps clip `coil` = [clipFrom, clipTo, frames], then the
//   release covers the rest of startup), so the cut coils long and releases fast. Chain window and dodge cancel shift
//   by the same delta, so the 10-press route keeps its rhythm.
// WAVE (Hatou-giri style): long coil, short melee snap, then a ground line travels forward from the blade (speed m/frame,
//   range m, lateral half-width m) hitting every foe it crosses exactly once (own actionId, launched at end of ACTIVE).
// LEAP (leap wheel): planted take-off (`takeoff` frames, no travel), an airborne arc of `air` frames (height m, up to
//   `travel` m forward, shortened when a foe is near), the vertical chop lands on the first ACTIVE frame, deep recovery.
//   Feet only travel while airborne, so planted feet never slide; no i-frames (not an evade, GREAT_NO_EVADE holds).
const NO_TARGETS = Object.freeze([]);
export const GS_COIL = Object.freeze({
  LIGHT_1: Object.freeze({ startup: 24, coil: [36, 50, 16] }),
  LIGHT_2: Object.freeze({ startup: 22, coil: [34, 50, 14] }),
});
export const HERO_GREAT_X = Object.freeze({
  WAVE: Object.freeze({ clip: 'gs_overhead', startup: 26, active: 4, total: 72, chain: [56, 71], dodgeFrom: 60, stamina: 30, lunge: 0.3,
    dmg: 22, posture: 22, reach: 1.35, wave: Object.freeze({ speed: 0.34, range: 8.0, half: 0.9, dmg: 18, posture: 16 }) }),
  LEAP: Object.freeze({ clip: 'gs_overhead', startup: 34, active: 6, total: 80, chain: [60, 79], dodgeFrom: 64, stamina: 30, lunge: 0,
    dmg: 34, posture: 36, reach: 1.6, leap: Object.freeze({ takeoff: 10, air: 24, height: 0.85, travel: 2.2 }) }),
});
// Great-sword phases for timing-table verb k (SWING stretch + coil). Shared by the sim and the presentation warp.
export function greatPhases(k, phases) {
  const s = scalePhases(phases, GREATSWORD.SWING), c = GS_COIL[k];
  if (c && c.startup > s[0].specF) s[0] = { ...s[0], specF: c.startup };
  return s;
}
function coilVerb(v, k) {
  const c = GS_COIL[k]; if (!c || c.startup <= v.startup) return v;
  const d = c.startup - v.startup, o = { ...v, phases: v.phases.map((p) => ({ ...p })) };
  o.phases[0].specF = c.startup; let f = 0; for (const p of o.phases) { p.start = f; f += p.specF; }
  o.total = f; o.startup = c.startup; o.chain = v.chain ? [v.chain[0] + d, v.chain[1] + d] : null; o.dodgeFrom = v.dodgeFrom + d;
  return o;
}
function greatXVerb(k) {
  const s = HERO_GREAT_X[k], rec = s.total - s.startup - s.active;
  const phases = [
    { phase: 'STARTUP', specF: s.startup, clipF: [0, s.startup], start: 0 },
    { phase: 'ACTIVE', specF: s.active, clipF: [s.startup, s.startup + s.active], start: s.startup },
    { phase: 'RECOVERY', specF: rec, clipF: [s.startup + s.active, s.total], start: s.startup + s.active },
  ];
  return { ...s, name: k, phases, chainTo: null };
}
// Rift footwork (MotionBricks at_rift_plant, 87 f): the whole rift follows its root curve (a short planted brace).
export const HERO_RIFT_FOOT = Object.freeze({ CLIP: 'at_rift_plant' });
// v2.27 DANCE set (one-handed blades: the Duelist and Vesper). docs/DANCE_COMBAT.md. Every strike is a weight
// transfer authored as one MotionBricks footwork clip (lower body, contact IK) with an authored sword arc layered on
// top (motion/mb/hero.dance.attacks.json, clip = foot = dz_*). The blade peaks 2 frames after the lead foot plants
// (peak), so the hit lands on the step like a beat. Moves alternate the hip pivot (opposition: open left, close right)
// and the string travels a floor pattern (zig-zag in, turn, lunge) instead of standing still.
// Travel and turn come only from the clip root curve (planted feet = no slide). settle = first frame with both feet
// down; the chain opens a few frames before it so the next step starts from a loaded stance, on the rhythm.
export const HERO_DANCE = Object.freeze({
  D_L1: { foot: 'dz_l1', peak: 28, settle: 42, frames: 59, stamina: 12, dmg: 14, posture: 12, reach: 1.35 },  // step in, open left: R->L cut
  D_L2: { foot: 'dz_l2', peak: 30, settle: 36, frames: 54, stamina: 12, dmg: 14, posture: 12, reach: 1.35 },  // counter-pivot: high thrust (v2.28, was the rising cut - read too close to the reap)
  D_L3: { foot: 'dz_l3', peak: 32, settle: 42, frames: 57, stamina: 13, dmg: 16, posture: 14, reach: 1.45 },  // cross right: reaping L->R
  D_L4: { foot: 'dz_l4', peak: 24, settle: 42, frames: 51, stamina: 13, dmg: 15, posture: 14, reach: 1.35 },  // big open pivot: fast cut
  D_L5: { foot: 'dz_l5', peak: 30, settle: 43, frames: 57, stamina: 16, dmg: 20, posture: 18, reach: 1.55 },  // square lunge: overhead
  D_H1: { foot: 'dz_h1', peak: 42, settle: 54, frames: 65, stamina: 28, dmg: 30, posture: 32, reach: 1.5, heavy: true },   // deep plant: slam
  D_H2: { foot: 'dz_h2', peak: 38, settle: 56, frames: 71, stamina: 26, dmg: 28, posture: 30, reach: 1.45, heavy: true },  // half turn: spin cut
  ACTIVE: 6, PRE: 3, LINK_LEAD: 6,
});
function danceVerb(k) {
  const d = HERO_DANCE[k], startup = d.peak - HERO_DANCE.PRE, active = HERO_DANCE.ACTIVE, total = d.frames;
  const phases = [
    { phase: 'STARTUP', specF: startup, clipF: [0, startup], start: 0 },
    { phase: 'ACTIVE', specF: active, clipF: [startup, startup + active], start: startup },
    { phase: 'RECOVERY', specF: total - startup - active, clipF: [startup + active, total], start: startup + active },
  ];
  const c0 = Math.max(startup + active + COMBO.CHAIN_LEAD, d.settle - HERO_DANCE.LINK_LEAD);
  return { ...d, name: k, clip: d.foot, phases, total, startup, active, chain: [c0, total - 1], chainTo: null,
    dodgeFrom: startup + active + 4, lunge: 0, dance: true };
}
function sweepVerb(k) {
  const s = HERO_SWEEP[k], rec = s.total - s.startup - s.active;
  const phases = [
    { phase: 'STARTUP', specF: s.startup, clipF: [0, s.startup], start: 0 },
    { phase: 'ACTIVE', specF: s.active, clipF: [s.startup, s.startup + s.active], start: s.startup },
    { phase: 'RECOVERY', specF: rec, clipF: [s.startup + s.active, s.total], start: s.startup + s.active },
  ];
  return { ...s, name: k, phases, sweep: true };
}
// v2.23 combo routes: up to COMBO.MAX moves in one string, built from light (A) and heavy (B) presses. Each node maps
// the verb that is playing to the next verb for [A, B]. Any verb chains inside its chain window (verbs without an
// authored window chain from 3 frames after ACTIVE to the last recovery frame), so a light can follow a heavy and a
// heavy can follow a light at any depth. Chained moves cost CHAIN_STAMINA x their stamina so a full 10-hit string is
// affordable. Presentation follows the sim verb + actF only, so the animation sequence is exactly the button sequence.
export const COMBO = Object.freeze({ MAX: 10, CHAIN_STAMINA: 0.35, CHAIN_LEAD: 3 });
export const COMBO_ROUTE = Object.freeze({
  // v2.30: heavy after the third light or the reverse sweep is the WAVE slash; heavy out of a sweep (or a wave) is the LEAP
  great: Object.freeze({ LOCO: ['LIGHT_1', 'HEAVY'], LIGHT_1: ['LIGHT_2', 'HEAVY'], LIGHT_2: ['LIGHT_3', 'HEAVY'], LIGHT_3: ['SWEEP', 'WAVE'],
    SWEEP: ['SWEEP_REV', 'LEAP'], SWEEP_REV: ['LIGHT_2', 'WAVE'], HEAVY: ['LIGHT_2', 'SWEEP'], WAVE: ['LIGHT_2', 'LEAP'], LEAP: ['LIGHT_1', 'HEAVY'] }),
  std: Object.freeze({ LOCO: ['LIGHT_1', 'HEAVY'], LIGHT_1: ['LIGHT_2', 'HEAVY'], LIGHT_2: ['LIGHT_3', 'HEAVY'], LIGHT_3: ['LIGHT_1', 'HEAVY'],
    HEAVY: ['LIGHT_2', 'HEAVY'] }),
  // v2.27 Duelist dance route: five different light steps in a row (A x5 never repeats a move), and a heavy from
  // each light branches to one of two heavy finishers depending on where in the phrase it lands. The heavy opener
  // (from LOCO) stays the chargeable HEAVY.
  dance: Object.freeze({ LOCO: ['D_L1', 'HEAVY'], D_L1: ['D_L2', 'D_H1'], D_L2: ['D_L3', 'D_H2'], D_L3: ['D_L4', 'D_H1'],
    D_L4: ['D_L5', 'D_H2'], D_L5: ['D_L1', 'D_H1'], D_H1: ['D_L2', 'D_H2'], D_H2: ['D_L4', 'D_H1'], HEAVY: ['D_L2', 'D_H2'] }),
  // Vesper: same steps, her own phrasing - opens on the big pivot and keeps turning (quick, spinning, roll-friendly)
  vesper: Object.freeze({ LOCO: ['D_L4', 'HEAVY'], D_L4: ['D_L2', 'D_H2'], D_L2: ['D_L1', 'D_H2'], D_L1: ['D_L3', 'D_H1'],
    D_L3: ['D_L5', 'D_H2'], D_L5: ['D_L4', 'D_H1'], D_H2: ['D_L1', 'D_H1'], D_H1: ['D_L3', 'D_H2'], HEAVY: ['D_L4', 'D_H2'] }),
});
export const HERO_DODGE = Object.freeze({ total: 34, travel: 3.0, travelF: [2, 22], stamina: 20, cancelFrom: 28, guardRange: 9.0 });
// Guarded quickstep directions (relative to facing). Clip names match the MotionBricks bake (motion/mb/hero.combat.json).
export const STEP_DIR = Object.freeze({ NONE: 0, F: 1, B: 2, L: 3, R: 4 });
// v2.23: two-handers never roll or sidestep (user direction). Exported so fixtures can assert it.
export const GREAT_NO_EVADE = true;
// v2.29 attack steering (feel pass: "hard to move and attack at the same time").
//  AIM: during STARTUP the stick turns the swing toward the stick (at AIM_RATE x TURN per frame, at most AIM_MAX rad
//       per swing) when no foe is inside the assist range (the assist snap already aims it). Footwork verbs rotate
//       their whole root curve (footYaw0), so travel and facing stay in step.
//  MOVE CANCEL: from MOVE_AFTER frames past the end of ACTIVE (two-handers MOVE_AFTER_GREAT) a stick push with no
//       buffered follow-up ends the recovery straight into locomotion at >= walk speed, instead of finishing the clip.
//  Off with ?steer=0 (setAttackSteer(false)); the 10-press combo strings are unaffected (a buffered press wins).
export const ATTACK_STEER = { on: true, STICK: 0.35, AIM_RATE: 0.55, AIM_MAX: 0.70, MOVE_AFTER: 6, MOVE_AFTER_GREAT: 14 };
export function setAttackSteer(on) { ATTACK_STEER.on = !!on; }
// v2.34 FLOW (feel pass: "attacks feel stiff, not agile"). One-handed blades only (two-handers stay planted).
//  FLASH STEP: an attack pressed at a foe ahead that is out of reach (reach + MIN_EXTRA .. RANGE) dashes in along
//    the lunge clip (afterimages in main.js) and lands the strike on arrival. Works as an opener and inside a combo
//    chain, so a string flows from foe to foe. Same frame data for the strike itself; the dash adds STAMINA.
//  Steering: wider / faster aim during startup, earlier move-cancel out of recovery.
//  ?flow=0 (setFlow(false)) restores v2.33 exactly.
export const HERO_FLASH = { on: true, MIN_EXTRA: 0.9, RANGE: 6.5, CONE: 0.5, STARTUP: 2, TRAVEL_MAX: 12, SPEED: 0.42, STAMINA: 6, STOP_K: 0.7 };
const STEER_V233 = { AIM_RATE: 0.55, AIM_MAX: 0.70, MOVE_AFTER: 6 }, STEER_FLOW = { AIM_RATE: 0.9, AIM_MAX: 1.25, MOVE_AFTER: 3 };
export function setFlow(on) { HERO_FLASH.on = !!on; Object.assign(ATTACK_STEER, on ? STEER_FLOW : STEER_V233); }
setFlow(true);
export const STEP_CLIP = Object.freeze(['dodge', 'dodge_F', 'dodge_B', 'dodge_L', 'dodge_R']);
export const HERO_FINISHER_F = 96;          // matches the boss finisher length (WyvernBrain FINISHER_F)
// Finisher presentation: Sword Judgment (clip 102). Blade lands on clip frame 62, the boss takes the blow on sim
// frame 60 (WyvernBrain FINISHER_HIT_F); knots map sim frames -> clip frames (60 fps).
export const HERO_FINISHER_CLIP = Object.freeze({ clip: 'mh_judgment', knots: [[0, 0], [60, 62], [96, 112]] });
const HITSTUN_F = 20, GUARDBREAK_F = 50, DEATH_F = 100, ASSIST_RANGE = 4.5;
const STAMINA_REGEN = 34 / 60, STAMINA_DELAY = 30, BLOCK_REGEN_SCALE = 0.35;
// Charged heavy: holding heavy freezes the swing at the top of its wind-up (CHARGE_HOLD_F frames before ACTIVE)
// for up to CHARGE_MAX_F frames. Charge level 0..1 (counted after CHARGE_MIN_F so a tap stays a plain heavy)
// scales damage x1..1.7, posture x1..1.9 and lunge x1..1.5. Releasing (or reaching max) fires the swing.
export const HERO_CHARGE = Object.freeze({ HOLD_F: 8, MIN_F: 8, MAX_F: 54, DMG: 0.7, POSTURE: 0.9, LUNGE: 0.5 });
// Health regen: after REGEN_DELAY frames without taking damage, HP refills at REGEN_PER_S (never while dead).
export const HERO_REGEN = Object.freeze({ DELAY_F: 300, PER_S: 4 });
// v2.10 great sword (picked up beside the wyvern's landing): same verbs and frame data as the standard blade,
// longer reach and heavier hits for a little more stamina. weapon 0 = standard sword, 1 = great sword.
// v2.12: the great sword is heavy - every verb's frame data (startup, active, recovery, chain window, dodge cancel)
// is stretched by SWING, and locomotion top speed is scaled by MOVE. Dodge / roll are unchanged (defence stays fair).
export const GREATSWORD = Object.freeze({ REACH: 0.7, DMG: 1.4, POSTURE: 1.35, STAMINA: 1.15, SWING: 1.3, MOVE: 0.72, TURN: 0.8 });
// Stretch one verb record's frame data by k (phases, chain window, dodge cancel). Pure; used for the great-sword set.
// Stretch timing-table phases by k (specF / playedF; clip frame knots unchanged, so the clip plays slower).
export function scalePhases(phases, k) {
  const s = (n) => Math.max(1, Math.round(n * k));
  return phases.map((p) => ({ ...p, specF: s(p.specF), playedF: p.playedF ? s(p.playedF) : undefined }));
}
export function scaleVerb(v, k) {
  const s = (n) => Math.max(1, Math.round(n * k));
  const o = { ...v, phases: scalePhases(v.phases, k) };
  let f = 0; for (const p of o.phases) { p.start = f; f += p.specF; }
  o.total = f; o.startup = o.phases[0].specF; o.active = o.phases[1].specF;
  o.chain = v.chain ? [s(v.chain[0]), s(v.chain[1])] : null; o.dodgeFrom = s(v.dodgeFrom);
  return o;
}
export const WEAPON = Object.freeze({ SWORD: 0, GREAT: 1, FANG: 2, ODACHI: 3, FROST: 4 });
// v2.19 boss drops: every two-hander shares the great-sword frame data (SWING stays 1.3, so one stretched verb set
// and one clip warp table serve them all) and differs in reach / damage / posture / weight plus one perk:
// GAUGE scales the Ember Trigger gauge gained from style. Ids only go up (a drop never downgrades the hero).
// FANG drops from the Ford Wyvern, ODACHI from the Shadow Warden, FROST from the Chrome Gauntlet (victory relic).
export const WEAPONS = Object.freeze([
  null,
  Object.freeze({ id: 1, key: 'great', name: 'GREAT SWORD', REACH: 0.7, DMG: 1.4, POSTURE: 1.35, STAMINA: 1.15, SWING: 1.3, MOVE: 0.72, TURN: 0.8, GAUGE: 1.0 }),
  Object.freeze({ id: 2, key: 'fang', name: 'WYVERN FANG', REACH: 0.75, DMG: 1.55, POSTURE: 1.5, STAMINA: 1.2, SWING: 1.3, MOVE: 0.7, TURN: 0.8, GAUGE: 1.5 }),
  Object.freeze({ id: 3, key: 'odachi', name: 'DUSK ODACHI', REACH: 1.0, DMG: 1.45, POSTURE: 1.3, STAMINA: 1.1, SWING: 1.3, MOVE: 0.8, TURN: 0.86, GAUGE: 1.2 }),
  Object.freeze({ id: 4, key: 'frost', name: 'FROSTBRAND', REACH: 0.85, DMG: 1.7, POSTURE: 1.6, STAMINA: 1.15, SWING: 1.3, MOVE: 0.74, TURN: 0.82, GAUGE: 1.3 }),
  // v2.24 Kael's signature polearm (never dropped): longest reach, posture-heavy, a touch quicker on its feet than
  // the great blades. Same two-hander frame data, so GREAT_NO_EVADE applies (guard / just-guard / walk out).
  Object.freeze({ id: 5, key: 'glaive', name: 'ASTRAL GLAIVE', REACH: 1.1, DMG: 1.3, POSTURE: 1.55, STAMINA: 1.15, SWING: 1.3, MOVE: 0.78, TURN: 0.84, GAUGE: 1.15 }),
]);
// v2.24 playable characters. 'hero' is the original duelist and is bit-identical to v2.23 (fixtures unchanged).
// lock: the signature weapon is kept for the whole campaign (boss drops are recorded on the road map but not equipped).
// one: one-handed signature modifiers on the standard sword frame data (roll / quickstep stay available).
export const CHARACTERS = Object.freeze({
  hero: Object.freeze({ id: 'hero', name: 'THE DUELIST', weapon: 0, lock: false, one: null }),
  vesper: Object.freeze({ id: 'vesper', name: 'VESPER', weapon: 0, lock: true,
    one: Object.freeze({ name: 'CINDER SABRE', REACH: 0.2, DMG: 0.95, POSTURE: 0.8, STAMINA: 0.8, GAUGE: 1.45 }) }),
  kael: Object.freeze({ id: 'kael', name: 'KAEL', weapon: 5, lock: true, one: null }),
});
const TURN = SIM.TURN_RATE / 60;
const TAU = Math.PI * 2;
function wrap(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }

// Command filled each fixed step by the game (input layer or bot). Reused, never reallocated.
export function makeHeroCommand() {
  return { mx: 0, mz: 0, speed: 0, attack: false, heavy: false, heavyHeld: false, dodge: false, roll: false, blockHeld: false, blockPress: false, snatch: false, trigger: false, sweep: false };
}

export class HeroSim {
  // timing: parsed attack-timing.json; colliders: world Colliders (optional); god: HP never below 1
  constructor({ timing, colliders = null, god = false, dodgeProfile = null }) {
    this.colliders = colliders; this.god = god;
    // per-direction cumulative travel fractions (one per travel frame) from the MotionBricks root curve; linear fallback
    const N = HERO_DODGE.travelF[1] - HERO_DODGE.travelF[0] + 1;
    const lin = Float32Array.from({ length: N }, (_, i) => (i + 1) / N);
    this.stepProfile = STEP_CLIP.map((c) => (dodgeProfile && dodgeProfile.clips[c] && dodgeProfile.clips[c].profile.length === N)
      ? Float32Array.from(dodgeProfile.clips[c].profile) : lin);
    this.verbs = {};
    for (const k in HERO_VERBS) {
      const t = timing.verbs[k], v = { ...HERO_VERBS[k], name: k };
      if (t.clip) v.clip = t.clip;           // the timing table owns the clip choice (v2.8 long-sword set)
      v.phases = t.phases.map((p) => ({ ...p })); let f = 0;
      for (const p of v.phases) { p.start = f; f += p.specF; }
      v.total = f; v.startup = v.phases[0].specF; v.active = v.phases[1].specF;
      v.reach = t.contactDistM || 1.35;
      this.verbs[k] = v;
    }
    // great-sword frame data: same verbs stretched by GREATSWORD.SWING (this.verbs swaps on equip / reset)
    this.verbsStd = this.verbs; this.verbsGreat = {};
    for (const k in this.verbsStd) this.verbsGreat[k] = coilVerb(scaleVerb(this.verbsStd[k], GREATSWORD.SWING), k);
    this.verbsGreat.SWEEP = sweepVerb('SWEEP'); this.verbsGreat.SWEEP_REV = sweepVerb('SWEEP_REV');
    this.verbsGreat.WAVE = greatXVerb('WAVE'); this.verbsGreat.LEAP = greatXVerb('LEAP');
    this.wave = { live: false, x: 0, z: 0, dx: 0, dz: -1, d: 0, aid: 0, hitN: 0, ids: new Int32Array(8) };
    this._waveV = { name: 'WAVE_LINE', dmg: 0, posture: 0, reach: 0, charge: 0, great: true, wave: true };
    for (const k in HERO_DANCE) if (k.startsWith('D_')) this.verbsStd[k] = danceVerb(k);   // one-handed only
    this.danceOn = true;         // v2.27 dance routes for one-handed blades (main.js ?dance=0 restores v2.26)
    for (const set of [this.verbsStd, this.verbsGreat]) for (const k in set) {
      const v = set[k]; v.comboChain = v.chain || [v.startup + v.active + COMBO.CHAIN_LEAD, v.total - 1];
    }
    this.comboOn = true;         // v2.23 10-move combo routing (main.js ?combo10=0 restores the v2.22 chains)
    this._foot = new Float32Array(3); this.footYaw0 = 0; this.sweeps = 0; this.knocks = 0;
    this._charged = { ...this.verbs.HEAVY };   // scratch verb record for a charged release (no per-hit allocation)
    this._great = { name: '', dmg: 0, posture: 0, reach: 0, charge: 0 };   // scratch verb record for great-sword hits
    this.id = 1; this.radius = SIM.CAPSULE_RADIUS;
    this.contactSink = null;     // (rec) => void, presentation hook after the hero applied an incoming contact
    this.hitSink = null;         // (targetKind, target, dmg, info) => void, presentation hook for outgoing hits
    this._hitIds = new Int32Array(8); this._hitN = 0;
    this.lockW = -1; this.sig = null; this.charId = 'hero';   // v2.24 character loadout (setCharacter), survives reset
    this.reset(0, 9, 0);
  }

  reset(x, z, yaw) {
    this.x = x; this.z = z; this.y = 0; this.yaw = yaw; this.prevX = x; this.prevZ = z; this.prevYaw = yaw;
    this.speed = 0; this.vx = 0; this.vz = 0;
    this.hp = SIM.HP_PLAYER; this.stamina = SIM.STAMINA_MAX; this.staminaIdle = 0;
    this.state = HERO_STATE.LOCO; this.verb = null; this.actF = 0; this.actionId = 0; this.stateF = 0;
    this.invuln = false; this.dodgeF = -1; this.deflectF = -1; this.blocking = false;
    this.stepDirX = 0; this.stepDirZ = 1; this.stepToward = 0; this.pushX = 0; this.pushZ = 0; this._lpx = 0; this._lpz = 0; this._lpF = 0; this.plantDX = 0; this.plantDZ = 0; this.stepKind = STEP_DIR.NONE;
    this.queued = null; this.queuedBtn = 0; this.hitstunLen = HITSTUN_F;
    this.comboN = 0; this.comboMask = 0; this.comboMax = 0; this.combos10 = 0;
    this.varCnt = this.varCnt || {}; for (const k in this.varCnt) this.varCnt[k] = 0; this.varIdx = 0;
    this.frame = 0; this.hitsTaken = 0; this.damageTaken = 0; this.damageDealt = 0; this.flash = 0;
    this.perfects = 0; this.deflects = 0; this.phantoms = 0; this.finishers = 0;
    this.lastEvent = ''; this.lastEventFrame = -999; this.lastStaminaFail = -999;
    this.maxBackwardDot = 1;
    this._hitN = 0;
    this.wave.live = false; this.waves = 0; this.waveSeq = 0; this.waveHits = 0; this.leaps = 0; this.y = 0; this.airborne = false; this.leapDist = 0;
    this.charging = false; this.chargeF = 0; this.chargeLvl = 0; this.chargedHits = 0;
    this.hpIdle = 0; this.hpRegained = 0;
    this.weapon = WEAPON.SWORD; this.wp = null; this.verbs = this.verbsStd;
    if (this.lockW > 0) { this.weapon = this.lockW; this.wp = WEAPONS[this.lockW]; this.verbs = this.verbsGreat; }   // v2.24 signature two-hander
    // DMC layer
    this.snatchF = -1; this.snatchT = null; this.snatchCd = 0; this.snatchX = 0; this.snatchZ = 0; this.snatches = 0;
    this.flashF = -1; this.flashT = null; this.flashes = 0; this.flashStop = 0;
    this.gauge = 0; this.triggerF = 0; this.triggers = 0; this.burstF = -1; this.burstHit = false;
    this.riftF = -1; this.rifts = 0; this.riftCuts = 0; this.riftHits = 0;
  }

  // Ember Rift: needs a burning trigger with MIN_LEFT frames left; free cancel from LOCO, late ACTION recovery or DODGE.
  _startRift(targets) {
    if (this.triggerF < HERO_RIFT.MIN_LEFT) return false;
    const s = this.state;
    const okAct = s === HERO_STATE.ACTION && this.verbs[this.verb] && this.actF >= this.verbs[this.verb].dodgeFrom;
    if (!(s === HERO_STATE.LOCO || s === HERO_STATE.DODGE || okAct)) return false;
    this.state = HERO_STATE.RIFT; this.riftF = 0; this.actF = 0; this.dodgeF = -1; this.invuln = true;
    this.blocking = false; this.queued = null; this.charging = false; this.speed = 0;
    const ay = this._assistYaw(targets); if (ay !== null) this.yaw = ay;
    this.footYaw0 = this.yaw; this.rifts++; this._event('rift');
    return true;
  }

  _riftCut(targets, fin) {
    const R = HERO_RIFT;
    const v = fin ? (this._riftEnd || (this._riftEnd = { name: 'RIFT_END', dmg: R.END_DMG, posture: R.END_POSTURE, reach: R.RANGE, charge: 0, great: false, rift: true }))
      : (this._riftV || (this._riftV = { name: 'RIFT_CUT', dmg: R.CUT_DMG, posture: R.CUT_POSTURE, reach: R.RANGE, charge: 0, great: false, rift: true }));
    this.actionId++; this.riftCuts++;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      if (Math.hypot(t.x - this.x, t.z - this.z) > R.RANGE + (t.radius || 0)) continue;
      const dealt = t.onHeroHit ? t.onHeroHit(this, v, this.actionId) : 0;
      if (dealt > 0) { this.damageDealt += dealt; this.riftHits++; }
      if (this.hitSink) this.hitSink(t, dealt, v);
    }
    this._event(fin ? 'rift_end' : 'rift_cut');
  }

  get triggered() { return this.triggerF > 0; }
  addGauge(g) { if (!(g > 0) || this.triggerF > 0) return; this.gauge = Math.min(HERO_TRIGGER.MAX, this.gauge + g); }

  // Ember Trigger: spend the full gauge on a timed burst mode. Allowed from LOCO / ACTION / DODGE (a "DT cancel").
  _startTrigger() {
    if (this.triggerF > 0 || this.gauge < HERO_TRIGGER.COST) return false;
    const s = this.state; if (s === HERO_STATE.DEAD || s === HERO_STATE.FINISHER || s === HERO_STATE.HITSTUN) return false;
    this.triggerF = Math.round(this.gauge / HERO_TRIGGER.DRAIN); this.gauge = 0; this.triggers++;
    this.burstF = 0; this.burstHit = false; this.stamina = SIM.STAMINA_MAX; this._event('trigger');
    return true;
  }

  // Snatch: pull toward the nearest targetable foe in [MIN, RANGE]. Returns false (no stamina spent) if none.
  _startSnatch(targets) {
    if (this.snatchCd > 0) return false;
    let best = null, bd = HERO_SNATCH.RANGE;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      const d = Math.hypot(t.x - this.x, t.z - this.z) - (t.radius || 0);
      if (d >= HERO_SNATCH.MIN && d < bd) { bd = d; best = t; }
    }
    if (!best || !this._spend(HERO_SNATCH.STAMINA)) return false;
    this.state = HERO_STATE.SNATCH; this.snatchF = 0; this.actF = 0; this.snatchT = best; this.blocking = false; this.queued = null;
    this.yaw = Math.atan2(-(best.x - this.x), -(best.z - this.z)); this.snatchX = best.x; this.snatchZ = best.z;
    this.snatches++; this._event('snatch');
    return true;
  }

  equipGreatsword() { return this.equip(WEAPON.GREAT); }
  // v2.27 combo route for the blade in hand: two-handers keep the great route; one-handed blades dance, each
  // character with its own phrasing. comboOn=false / danceOn=false fall back to the classic three-light chain.
  _route() {
    if (this.wp) return COMBO_ROUTE.great;
    if (!this.danceOn) return COMBO_ROUTE.std;
    return this.charId === 'vesper' ? COMBO_ROUTE.vesper : COMBO_ROUTE.dance;
  }
  _opener() { return this.comboOn ? this._route().LOCO[0] : 'LIGHT_1'; }
  // v2.24: pick a CHARACTERS entry. Locked characters keep their signature weapon (drops never replace it).
  setCharacter(id) {
    const C = CHARACTERS[id] || CHARACTERS.hero;
    this.charId = C.id; this.lockW = C.lock ? C.weapon : -1; this.sig = C.one;
    this.reset(this.x, this.z, this.yaw); return C;
  }
  // equip a two-hander by id; refuses anything not better than what is held (drops only upgrade)
  equip(w) {
    if (!(w > this.weapon) || !WEAPONS[w] || (this.lockW >= 0 && w !== this.lockW)) return false;
    this.weapon = w; this.wp = WEAPONS[w]; this.verbs = this.verbsGreat; this._event('equip'); return true;
  }

  // charge level of the current (or last) heavy, 0..1
  _chargeLevel() { return Math.max(0, Math.min(1, (this.chargeF - HERO_CHARGE.MIN_F) / (HERO_CHARGE.MAX_F - HERO_CHARGE.MIN_F))); }

  get alive() { return this.state !== HERO_STATE.DEAD; }
  facingX() { return -Math.sin(this.yaw); }
  facingZ() { return -Math.cos(this.yaw); }

  // Frame index inside the current verb and its phase name ('STARTUP' | 'ACTIVE' | 'RECOVERY' | 'DONE').
  phase() {
    if (this.state !== HERO_STATE.ACTION) return null;
    const v = this.verbs[this.verb];
    for (const p of v.phases) if (this.actF < p.start + p.specF) return p.phase;
    return 'DONE';
  }
  // Clip time (s) of the current verb at fractional frame f (piecewise warp, spec frames -> clip frames).
  verbClipTime(f) {
    const v = this.verbs[this.verb];
    for (let i = 0; i < v.phases.length; i++) {
      const p = v.phases[i];
      if (f < p.start + p.specF || i === v.phases.length - 1) {
        const played = p.playedF || p.specF, u = Math.min(1, Math.max(0, (f - p.start) / played));
        return (p.clipF[0] + (p.clipF[1] - p.clipF[0]) * u) / 60;
      }
    }
    return 0;
  }

  _event(name) { this.lastEvent = name; this.lastEventFrame = this.frame; }

  _spend(cost) {
    if (this.stamina < cost * 0.5) { this.lastStaminaFail = this.frame; return false; }   // allow going slightly negative-free
    this.stamina = Math.max(0, this.stamina - cost); this.staminaIdle = 0; return true;
  }

  // nearest live target inside the assist range, for attack snap-turn
  _assistYaw(targets) {
    let best = null, bd = ASSIST_RANGE;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      const d = Math.hypot(t.x - this.x, t.z - this.z) - (t.radius || 0);
      if (d < bd) { bd = d; best = t; }
    }
    return best ? Math.atan2(-(best.x - this.x), -(best.z - this.z)) : null;
  }

  // chained: started from a combo window (cheaper, extends the string). btn: 0 light, 1 heavy, 2 sweep (HUD pips)
  _startVerb(name, targets, chained = false, btn = name === 'HEAVY' ? 1 : 0) {
    const v = this.verbs[name];
    const sk = (this.wp ? this.wp.STAMINA : this.sig ? this.sig.STAMINA : 1) * (chained ? COMBO.CHAIN_STAMINA : 1);
    if (!this._spend(sk !== 1 ? Math.round(v.stamina * sk) : v.stamina)) return false;
    this.comboN = chained ? this.comboN + 1 : 1;
    if (!chained) this.comboMask = 0;
    if (btn === 1 && this.comboN <= COMBO.MAX) this.comboMask |= 1 << (this.comboN - 1);
    if (this.comboN > this.comboMax) this.comboMax = this.comboN;
    if (this.comboN === COMBO.MAX) { this.combos10++; this._event('combo10'); }
    this.state = HERO_STATE.ACTION; this.verb = name; this.actF = 0; this.actionId++; this._hitN = 0;
    // v2.32: per-verb use counter -> presentation variant (main.js VARIANTS). A repeated light never replays the
    // same animation as its previous use; sim timing, contact and travel are identical across variants.
    this.varIdx = this.varCnt[name] = (this.varCnt[name] | 0) + 1;
    this.queued = null; this.blocking = false;
    this.charging = name === 'HEAVY'; this.chargeF = 0; this.chargeLvl = 0;
    const ay = this._assistYaw(targets); if (ay !== null) this.yaw = ay;
    this.footYaw0 = this.yaw; this.aimAcc = 0; this.aimFree = ay === null;
    this.flashF = -1; this.flashT = null;
    if (HERO_FLASH.on && !this.wp && !v.sweep && !v.leap) this._tryFlash(v, targets);
    if (v.sweep) { this.sweeps++; this._event('sweep'); }
    if (v.leap) {
      // leap length: full travel in the open, shortened so the chop lands at reach on the nearest foe ahead
      let near = Infinity; const fx = this.facingX(), fz = this.facingZ();
      for (let i = 0; i < (targets ? targets.length : 0); i++) { const t = targets[i]; if (!t || !t.targetable) continue;
        const dx = t.x - this.x, dz = t.z - this.z, d = Math.hypot(dx, dz); if (d > 0.3 && (dx * fx + dz * fz) / d < 0.5) continue;
        near = Math.min(near, d - (t.radius || 0) - this.radius); }
      this.leapDist = Math.max(0, Math.min(v.leap.travel, near - v.reach * 0.75)); this.leaps++; this._event('leap');
    }
    return true;
  }

  // v2.34 flash step: pick the nearest foe in front (stick direction if pushed, else facing) that is beyond strike
  // reach but inside HERO_FLASH.RANGE; the verb waits at frame 0 while the hero dashes to it (ACTION case).
  _tryFlash(v, targets) {
    const F = HERO_FLASH; if (!targets) return false;
    const fx = this.facingX(), fz = this.facingZ();
    let best = null, bd = F.RANGE;
    const near = (v.reach || 1.35) + F.MIN_EXTRA;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      const dx = t.x - this.x, dz = t.z - this.z, d = Math.hypot(dx, dz), edge = d - (t.radius || 0);
      if (edge < near) return false;            // a foe is already close: strike it, never dash away from it
      if (edge >= bd || d < 1e-3) continue;
      if ((dx * fx + dz * fz) / d < F.CONE) continue;
      bd = edge; best = t;
    }
    if (!best || this.stamina < F.STAMINA) return false;
    this.stamina = Math.max(0, this.stamina - F.STAMINA);
    this.flashF = 0; this.flashT = best; this.flashes++; this.aimFree = false;
    this.flashStop = (best.radius || 0) + this.radius + (v.reach || 1.35) * F.STOP_K;
    this.yaw = Math.atan2(-(best.x - this.x), -(best.z - this.z)); this.footYaw0 = this.yaw;
    this._event('flash');
    return true;
  }

  // roll = true (ROLL button): always the evasive roll, even with a foe in guard range. Same frames, i-frames,
  // travel and stamina as the dodge; only the quickstep branch is skipped.
  // v2.23: a two-hander (weapon >= 1) cannot roll or quickstep at all - the heavy blade plants the hero. Defence with
  // a great sword is guard / just-guard plus walking out of red telegraphs. No stamina is spent on a refused evade.
  _startDodge(cmd, targets, roll = false) {
    if (this.wp && GREAT_NO_EVADE) return false;
    if (!this._spend(HERO_DODGE.stamina)) return false;
    this.state = HERO_STATE.DODGE; this.dodgeF = 0; this.actF = 0; this.blocking = false; this.queued = null;
    const l = Math.hypot(cmd.mx, cmd.mz);
    let dx, dz;
    if (l > 0.1) { dx = cmd.mx / l; dz = cmd.mz / l; }
    else { dx = -this.facingX(); dz = -this.facingZ(); }         // no stick: backstep
    // Guarded quickstep: with a foe in range the hero squares up to it and steps in one of four directions
    // relative to that facing (MotionBricks clips), never turning its back. Otherwise: the roll.
    const t = (targets && !roll) ? this._nearest(targets, HERO_DODGE.guardRange) : null;
    if (t) {
      this.yaw = Math.atan2(-(t.x - this.x), -(t.z - this.z));
      const fx = this.facingX(), fz = this.facingZ(), rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const f = dx * fx + dz * fz, r = dx * rx + dz * rz;
      if (Math.abs(f) >= Math.abs(r)) { this.stepKind = f > 0 ? STEP_DIR.F : STEP_DIR.B; const g = f > 0 ? 1 : -1; dx = fx * g; dz = fz * g; }
      else { this.stepKind = r > 0 ? STEP_DIR.R : STEP_DIR.L; const g = r > 0 ? 1 : -1; dx = rx * g; dz = rz * g; }
    } else this.stepKind = STEP_DIR.NONE;
    this.stepDirX = dx; this.stepDirZ = dz;
    this._event('dodge');
    return true;
  }

  _nearest(targets, range) {
    let best = null, bd = range;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      const d = Math.hypot(t.x - this.x, t.z - this.z) - (t.radius || 0);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // Called by the game when a finisher is granted (boss stagger / duelist guardbreak). Hero is invulnerable for it.
  startFinisher(target) {
    if (this.state === HERO_STATE.DEAD) return false;
    this.state = HERO_STATE.FINISHER; this.actF = 0; this.invuln = true; this.blocking = false; this.queued = null;
    if (target) this.yaw = Math.atan2(-(target.x - this.x), -(target.z - this.z));
    this.finishers++; this._event('finisher');
    return true;
  }

  // One fixed step. cmd: makeHeroCommand(); targets: [{ x, z, radius, targetable, id, onHeroHit(hero, verbDef, part) }]
  step(cmd, targets = NO_TARGETS) {
    this.frame++;
    this.prevX = this.x; this.prevZ = this.z; this.prevYaw = this.yaw;
    if (this.deflectF >= 0 && ++this.deflectF > 20) this.deflectF = -1;
    if (cmd.blockPress) this.deflectF = 0;
    if (this.flash > 0) this.flash--;
    let mx = 0, mz = 0;                       // planar displacement this step (metres)

    // Ember Trigger: activation is a free cancel out of LOCO / ACTION / DODGE; burst frames are invulnerable
    // a second Trigger press while burning cashes the rest of the meter into an Ember Rift
    if (cmd.trigger) { if (this.triggerF > 0) this._startRift(targets); else this._startTrigger(); }
    if (this.snatchCd > 0) this.snatchCd--;
    if (this.triggerF > 0) {
      if (--this.triggerF === 0) this._event('trigger_end');
      if (this.state !== HERO_STATE.DEAD && this.hp < SIM.HP_PLAYER) this.hp = Math.min(SIM.HP_PLAYER, this.hp + HERO_TRIGGER.HEAL_PER_S / 60);
    }
    if (this.burstF >= 0) {
      this.burstF++;
      if (!this.burstHit && this.burstF >= 4) { this.burstHit = true; this._burst(targets); }
      if (this.burstF > HERO_TRIGGER.BURST_F) { this.burstF = -1; if (this.state !== HERO_STATE.FINISHER && this.state !== HERO_STATE.RIFT && this.dodgeF < 0) this.invuln = false; }
      else this.invuln = true;
    }
    // Snatch from LOCO, or as a cancel from late ACTION recovery
    if (cmd.snatch && (this.state === HERO_STATE.LOCO || (this.state === HERO_STATE.ACTION && this.verbs[this.verb] && this.actF >= this.verbs[this.verb].dodgeFrom))) {
      this.charging = false; this._startSnatch(targets);
    }

    switch (this.state) {
      case HERO_STATE.RIFT: {
        const R = HERO_RIFT, f = ++this.riftF; this.actF++; this.speed = 0;
        if (this.wp) { // v2.22 great sword: braced plant from the MotionBricks at_rift_plant root curve (about 0.1 m forward)
          const s = footStep(HERO_RIFT_FOOT.CLIP, f, this._foot), fx0 = -Math.sin(this.footYaw0), fz0 = -Math.cos(this.footYaw0);
          mx = fx0 * s[0] + fz0 * s[1]; mz = fz0 * s[0] - fx0 * s[1];
        }
        const c = f - R.STARTUP;
        if (c >= 0 && c < R.CUTS * R.CUT_EVERY && c % R.CUT_EVERY === 0) this._riftCut(targets, false);
        if (f === R.FINALE) { this._riftCut(targets, true); if (this.triggerF > 0) { this.triggerF = 0; this._event('trigger_end'); } }
        this.invuln = f <= R.FINALE + 6;
        if (f >= R.TOTAL) { this.state = HERO_STATE.LOCO; this.riftF = -1; this.actF = 0; this.invuln = false; }
        break;
      }

      case HERO_STATE.SNATCH: {
        this.snatchF++; this.actF++;
        const S = HERO_SNATCH, t = this.snatchT;
        if (t && t.targetable) { this.snatchX = t.x; this.snatchZ = t.z; }
        if (this.snatchF > S.STARTUP && this.snatchF <= S.STARTUP + S.TRAVEL_MAX) {
          const dx = this.snatchX - this.x, dz = this.snatchZ - this.z, d = Math.hypot(dx, dz);
          const stop = (t && t.radius || 0) + this.radius + S.STOP_AT;
          const left = d - stop;
          if (left <= 0.02) this.snatchF = S.STARTUP + S.TRAVEL_MAX;
          else { const s = Math.min(S.SPEED, left); mx = dx / d * s; mz = dz / d * s; this.yaw = Math.atan2(-dx, -dz); }
        }
        const recAt = S.STARTUP + S.TRAVEL_MAX;
        if (this.snatchF > recAt) {
          // landing: cancel straight into a combo starter (Snatch -> Streak/Combo loop)
          if (this.snatchF >= recAt + S.CANCEL_FROM && (cmd.attack || cmd.heavy)) {
            this.state = HERO_STATE.LOCO; this.snatchF = -1; this.snatchCd = S.COOLDOWN;
            this._startVerb(cmd.heavy ? 'HEAVY' : this._opener(), targets); break;
          }
          if (this.snatchF >= recAt + S.RECOVER) { this.state = HERO_STATE.LOCO; this.snatchF = -1; this.actF = 0; this.snatchCd = S.COOLDOWN; this.speed = 0; }
        }
        break;
      }

      case HERO_STATE.DEAD: this.actF++; this.speed = 0; break;

      case HERO_STATE.FINISHER:
        this.actF++;
        if (this.actF >= HERO_FINISHER_F) { this.state = HERO_STATE.LOCO; this.invuln = false; }
        break;

      case HERO_STATE.HITSTUN:
        this.actF++;
        if (this.actF >= this.hitstunLen) { this.state = HERO_STATE.LOCO; this.actF = 0; }
        break;

      case HERO_STATE.DODGE: {
        this.dodgeF++; this.actF++;
        const D = HERO_DODGE;
        if (this.dodgeF >= D.travelF[0] && this.dodgeF <= D.travelF[1]) {
          // travel follows the clip's own root curve (planted feet); the total is exactly D.travel
          const P = this.stepProfile[this.stepKind], j = this.dodgeF - D.travelF[0];
          const s = D.travel * (P[j] - (j > 0 ? P[j - 1] : 0));
          mx = this.stepDirX * s; mz = this.stepDirZ * s;
          if (this.stepKind === STEP_DIR.NONE) this.yaw = wrap(this.yaw + Math.max(-TURN, Math.min(TURN, wrap(Math.atan2(-this.stepDirX, -this.stepDirZ) - this.yaw))));
        }
        if (this.dodgeF >= D.cancelFrom && (cmd.attack || cmd.heavy || (cmd.sweep && this.wp))) {
          this.dodgeF = -1; this.state = HERO_STATE.LOCO;
          this._startVerb(cmd.heavy ? 'HEAVY' : cmd.attack ? this._opener() : 'SWEEP', targets);
        } else if (this.dodgeF >= D.total) { this.dodgeF = -1; this.state = HERO_STATE.LOCO; this.actF = 0; }
        break;
      }

      case HERO_STATE.ACTION: {
        const v = this.verbs[this.verb];
        // v2.34 flash step: dash to the foe, then the strike starts at frame 0 on arrival (frame data unchanged)
        if (this.flashF >= 0) {
          const F = HERO_FLASH, t = this.flashT; this.flashF++;
          if ((cmd.dodge || cmd.roll) && !(this.wp && GREAT_NO_EVADE)) { this.flashF = -1; this.flashT = null; this.state = HERO_STATE.LOCO; this._startDodge(cmd, targets, cmd.roll); break; }
          let done = !t || !t.targetable || this.flashF > F.STARTUP + F.TRAVEL_MAX;
          if (!done && this.flashF > F.STARTUP) {
            const dx = t.x - this.x, dz = t.z - this.z, d = Math.hypot(dx, dz), left = d - this.flashStop;
            if (left <= 0.02) done = true;
            else { const s = Math.min(F.SPEED, left); mx = dx / d * s; mz = dz / d * s; this.yaw = Math.atan2(-dx, -dz); if (left <= F.SPEED) done = true; }
          } else if (!done && t) this.yaw = Math.atan2(-(t.x - this.x), -(t.z - this.z));
          if (done) { this.flashF = -1; this.flashT = null; this.footYaw0 = this.yaw; this.actF = 0; this._event('flash_land'); }
          break;
        }
        // charged heavy: hold at the top of the wind-up while the button is held (tracks the target, no lunge)
        if (this.charging) {
          const holdAt = v.startup - HERO_CHARGE.HOLD_F;
          if (this.actF >= holdAt && cmd.heavyHeld && this.chargeF < HERO_CHARGE.MAX_F) {
            this.chargeF++; this.chargeLvl = this._chargeLevel();
            if (this.chargeF === HERO_CHARGE.MAX_F) this._event('charged');
            const ay = this._assistYaw(targets);
            if (ay !== null) this.yaw = wrap(this.yaw + Math.max(-TURN * 0.5, Math.min(TURN * 0.5, wrap(ay - this.yaw))));
            if ((cmd.dodge || cmd.roll) && !(this.wp && GREAT_NO_EVADE)) { this.charging = false; this.state = HERO_STATE.LOCO; this._startDodge(cmd, targets, cmd.roll); }
            break;
          }
          if (this.actF >= holdAt) { this.charging = false; if (this.chargeLvl > 0) this._event('release'); }
        }
        this.actF++;
        // v2.29 aim: the stick steers the swing during STARTUP (bounded), footwork curves rotate with it
        const stl = Math.hypot(cmd.mx, cmd.mz), ST = ATTACK_STEER;
        if (ST.on && this.aimFree && stl > ST.STICK && this.actF <= v.startup && this.aimAcc < ST.AIM_MAX) {
          const d = wrap(Math.atan2(-cmd.mx, -cmd.mz) - this.yaw);
          const lim = Math.min(TURN * ST.AIM_RATE * (this.wp ? this.wp.TURN : 1), ST.AIM_MAX - this.aimAcc);
          const r = Math.max(-lim, Math.min(lim, d));
          this.aimAcc += Math.abs(r);
          if (v.foot) this.footYaw0 = wrap(this.footYaw0 + r); else this.yaw = wrap(this.yaw + r);
        }
        // lunge during startup->active, scaled down when a target is already inside reach
        const lungeF = v.startup + v.active;
        if (v.leap) {
          // v2.30 leap wheel: planted take-off, ballistic arc ending on the first ACTIVE frame, planted landing
          const L = v.leap, a0 = v.startup - L.air, u = (this.actF - a0) / L.air;
          if (this.actF > a0 && this.actF <= v.startup) {
            const s = this.leapDist / L.air; mx = this.facingX() * s; mz = this.facingZ() * s;
            this.y = 4 * L.height * u * (1 - u); this.airborne = this.actF < v.startup;
          } else { this.y = 0; this.airborne = false; }
        } else if (v.foot) {
          // sweep: travel + turn come from the MotionBricks root curve, in the start facing frame (planted feet)
          const s = footStep(v.foot, this.actF, this._foot), fx0 = -Math.sin(this.footYaw0), fz0 = -Math.cos(this.footYaw0);
          mx = fx0 * s[0] + fz0 * s[1]; mz = fz0 * s[0] - fx0 * s[1];
          this.yaw = wrap(this.footYaw0 + s[2]);
        } else if (this.actF <= lungeF) {
          let near = Infinity;
          for (let i = 0; i < targets.length; i++) { const t = targets[i]; if (t && t.targetable) near = Math.min(near, Math.hypot(t.x - this.x, t.z - this.z) - (t.radius || 0)); }
          const k = (near < v.reach * 0.8 ? 0.25 : 1) * (this.verb === 'HEAVY' ? 1 + HERO_CHARGE.LUNGE * this.chargeLvl : 1);
          mx = this.facingX() * v.lunge * k / lungeF; mz = this.facingZ() * v.lunge * k / lungeF;
        }
        // contact: ACTIVE window, reach + target radius, inside a 70 degree half-cone, once per (actionId, target)
        const ph = this.phase();
        if (ph === 'ACTIVE') this._resolveSwing(v, targets);
        if (v.wave && this.actF === v.startup + v.active) this._launchWave(v);
        // buffered follow-ups
        if (this.comboOn) {
          const r = this._route()[this.verb], room = this.comboN < COMBO.MAX;
          if (r && room && cmd.attack) { this.queued = r[0]; this.queuedBtn = 0; }
          if (r && room && cmd.heavy) { this.queued = r[1]; this.queuedBtn = 1; }
          if (room && cmd.sweep && this.wp) { const q = v.sweep ? (v.chainTo || null) : 'SWEEP'; if (q) { this.queued = q; this.queuedBtn = 2; } }
        } else {
          if (cmd.attack && v.chainTo) this.queued = v.chainTo;
          if (cmd.heavy) this.queued = 'HEAVY';
          if (cmd.sweep && this.wp) this.queued = v.sweep ? (v.chainTo || null) : 'SWEEP';   // sweep -> rev; light/heavy -> sweep
        }
        // two-handers cannot evade: a dodge / roll press must not queue (it would cut the swing back to LOCO)
        const canEvade = !(this.wp && GREAT_NO_EVADE);
        if (cmd.dodge && canEvade) this.queued = 'DODGE';
        if (cmd.roll && canEvade) this.queued = 'ROLL';
        const evade = this.queued === 'DODGE' || this.queued === 'ROLL';
        if (evade && this.actF >= v.dodgeFrom) { const r = this.queued === 'ROLL'; this.state = HERO_STATE.LOCO; this._startDodge(cmd, targets, r); break; }
        const cw = this.comboOn ? v.comboChain : v.chain;
        if (this.queued && !evade && cw && this.actF >= cw[0] && this.actF <= cw[1]) {
          const q = this.queued; this.state = HERO_STATE.LOCO; if (!this._startVerb(q, targets, this.comboOn, this.queuedBtn)) this.state = HERO_STATE.LOCO;
          break;
        }
        // v2.29 move cancel: a stick push in late recovery (no buffered follow-up) walks straight out of the swing
        if (ST.on && !this.queued && !this.charging && stl > ST.STICK
          && this.actF >= v.startup + v.active + (this.wp ? ST.MOVE_AFTER_GREAT : ST.MOVE_AFTER) && this.actF < v.total) {
          this.state = HERO_STATE.LOCO; this.actF = 0; this.chargeLvl = 0;
          this.speed = Math.max(this.speed, SIM.WALK_SPEED * (this.wp ? this.wp.MOVE : 1));
          this.moveCancels = (this.moveCancels || 0) + 1; this._event('move_cancel');
          break;
        }
        if (this.actF >= v.total) {
          this.state = HERO_STATE.LOCO; this.actF = 0; this.chargeLvl = 0;
          if (this.comboOn && this.queued && !evade) this._startVerb(this.queued, targets, true, this.queuedBtn);
          else if (this.queued === 'HEAVY' || this.queued === 'SWEEP') this._startVerb(this.queued, targets);
          this.queued = null;
        }
        break;
      }

      default: {   // LOCO
        this.actF++;
        if ((cmd.dodge || cmd.roll) && this._startDodge(cmd, targets, cmd.roll)) break;
        if (cmd.heavy && this._startVerb('HEAVY', targets)) break;
        if (cmd.attack && this._startVerb(this._opener(), targets)) break;
        if (cmd.sweep && this.wp && this._startVerb('SWEEP', targets)) break;
        this.blocking = cmd.blockHeld;
        const gk = this.wp ? this.wp.MOVE : 1;   // heavy blade: slower top speed and turns
        const want = (this.blocking ? Math.min(cmd.speed, SIM.WALK_SPEED) : cmd.speed) * gk;
        // dodge / lunge carry-over enters LOCO at full velocity; with the great sword cap it at the heavy top speed
        if (gk < 1) this.speed = Math.min(this.speed, SIM.RUN_SPEED * gk);
        const l = Math.hypot(cmd.mx, cmd.mz);
        const dirX = l > 1e-4 ? cmd.mx / l : 0, dirZ = l > 1e-4 ? cmd.mz / l : 0;
        // speed ramps with ACCEL/DECEL; facing always turns toward travel, so the hero never runs backwards
        const target = l > 1e-4 ? want : 0;
        const rate = (target > this.speed ? SIM.ACCEL : SIM.DECEL) / 60;
        this.speed += Math.max(-rate, Math.min(rate, target - this.speed));
        if (l > 1e-4) {
          const wantYaw = Math.atan2(-dirX, -dirZ), d = wrap(wantYaw - this.yaw);
          const tr = this.wp ? TURN * this.wp.TURN : TURN;
          this.yaw = wrap(this.yaw + Math.max(-tr, Math.min(tr, d)));
          // move along facing once mostly turned (no backwards travel while the turn completes)
          const fx = this.facingX(), fz = this.facingZ();
          const dot = fx * dirX + fz * dirZ;
          const s = this.speed / 60 * Math.max(0, dot);
          mx = fx * s; mz = fz * s;
        } else {
          mx = this.facingX() * this.speed / 60; mz = this.facingZ() * this.speed / 60;
        }
      }
    }

    // v2.30: the leap height only lives inside a LEAP action (a hit or any state change lands the hero at once)
    if (this.y !== 0 && !(this.state === HERO_STATE.ACTION && this.verbs[this.verb] && this.verbs[this.verb].leap)) { this.y = 0; this.airborne = false; }
    if (this.wave.live) this._stepWave(targets);
    // stamina regen (slower while blocking, none while acting)
    if (this.state === HERO_STATE.LOCO || this.state === HERO_STATE.HITSTUN) {
      if (++this.staminaIdle > STAMINA_DELAY) this.stamina = Math.min(SIM.STAMINA_MAX, this.stamina + STAMINA_REGEN * (this.blocking ? BLOCK_REGEN_SCALE : 1));
    } else this.staminaIdle = 0;
    // health regen after a quiet spell (any damage taken resets hpIdle in the contact path)
    if (this.state !== HERO_STATE.DEAD && ++this.hpIdle > HERO_REGEN.DELAY_F && this.hp < SIM.HP_PLAYER) {
      const before = this.hp;
      this.hp = Math.min(SIM.HP_PLAYER, this.hp + HERO_REGEN.PER_S / 60);
      this.hpRegained += this.hp - before;
    }

    // integrate + collide
    this.dbgReq = Math.hypot(mx, mz); this.dbgPush = Math.hypot(this.pushX, this.pushZ); const x0_ = this.x, z0_ = this.z;
    // footwork clips (sweep / rift plant): never step INTO a body already in contact (the boss would shove the
    // planted hero back out and the feet would skate). The contact signal is the body push itself (this frame's,
    // or last frame's if the pusher updates after us); the normal is held 8 frames so the step cannot alternate.
    const planted = this.state === HERO_STATE.ACTION && this.flashF < 0 && this.verbs[this.verb] && this.verbs[this.verb].foot || (this.state === HERO_STATE.RIFT && !!this.wp);
    const cmx = mx, cmz = mz;   // the authored root-curve step, before the contact guard / body push / walls
    if (planted) {
      const px = this.pushX || (this._lpF > 0 ? this._lpx : 0), pz = this.pushZ || (this._lpF > 0 ? this._lpz : 0), pl = Math.hypot(px, pz);
      if (pl > 1e-6) { const k = (mx * px + mz * pz) / pl; if (k < 0) { mx -= px / pl * k; mz -= pz / pl * k; } }
    }
    if (this.pushX || this.pushZ) { this._lpx = this.pushX; this._lpz = this.pushZ; this._lpF = 8; } else if (this._lpF > 0) this._lpF--;
    this.x += mx + this.pushX; this.z += mz + this.pushZ; this.pushX = 0; this.pushZ = 0;
    this.dbgPre = [this.x, this.z]; this.dbgX0 = [x0_, z0_];
    if (this.colliders) { const r = this.colliders.resolveCapsule(this.x, this.z, this.radius, 0.0, SIM.ACTOR_HEIGHT); this.x = r.x; this.z = r.z; }
    const C = this.colliders, limX = (C ? C.halfX : SIM.ARENA_HALF) - this.radius, limZ = (C ? C.halfZ : SIM.ARENA_HALF) - this.radius;
    this.x = Math.max(-limX, Math.min(limX, this.x)); this.z = Math.max(-limZ, Math.min(limZ, this.z));
    // plant deficit (presentation only, never read by gameplay): how far the body is from where the clip's root
    // curve put it during a planted-foot clip. The view offsets the model by it so the planted feet stay fixed in
    // the world when the guard, a body push or a wall bends the travel; it bleeds off once the feet are free.
    if (planted) {
      this.plantDX += cmx - (this.x - x0_); this.plantDZ += cmz - (this.z - z0_);
      const pl = Math.hypot(this.plantDX, this.plantDZ); if (pl > 0.4) { this.plantDX *= 0.4 / pl; this.plantDZ *= 0.4 / pl; }
    } else if (this.plantDX || this.plantDZ) {
      this.plantDX *= 0.86; this.plantDZ *= 0.86;
      if (Math.abs(this.plantDX) + Math.abs(this.plantDZ) < 1e-4) { this.plantDX = 0; this.plantDZ = 0; }
    }
    this.vx = (this.x - this.prevX) * 60; this.vz = (this.z - this.prevZ) * 60;
    if (this.state !== HERO_STATE.LOCO) this.speed = Math.hypot(this.vx, this.vz);
    else {
      // backwards-running metric: self-driven travel (push excluded) against facing, while actually moving
      const sp = Math.hypot(mx, mz) * 60;
      if (sp > 0.5) { const dot = (mx * this.facingX() + mz * this.facingZ()) * 60 / sp; if (dot < this.maxBackwardDot) this.maxBackwardDot = dot; }
    }
  }

  _resolveSwing(v, targets) {
    if (v.name === 'HEAVY' && this.chargeLvl > 0) {
      const c = this._charged, L = this.chargeLvl;
      c.dmg = Math.round(v.dmg * (1 + HERO_CHARGE.DMG * L)); c.posture = Math.round(v.posture * (1 + HERO_CHARGE.POSTURE * L));
      c.charge = L; v = c;
    }
    if (this.wp) {
      const g = this._great, W = this.wp;
      g.name = v.name; g.charge = v.charge || 0; g.reach = v.reach + W.REACH;
      g.dmg = Math.round(v.dmg * W.DMG); g.posture = Math.round(v.posture * W.POSTURE); g.great = true;
      g.arc = v.arc; g.knock = v.knock || 0; g.sweep = !!v.sweep;
      v = g;
    } else if (this.sig) {   // v2.24 one-handed signature blade (Vesper's Cinder Sabre)
      const g = this._sigV || (this._sigV = { name: '', dmg: 0, posture: 0, reach: 0, charge: 0, great: false }), S = this.sig;
      g.name = v.name; g.charge = v.charge || 0; g.reach = v.reach + S.REACH;
      g.dmg = Math.round(v.dmg * S.DMG); g.posture = Math.round(v.posture * S.POSTURE);
      g.arc = v.arc; g.knock = v.knock || 0; g.sweep = !!v.sweep;
      v = g;
    }
    if (this.triggerF > 0) {
      const tr = this._trig || (this._trig = { name: '', dmg: 0, posture: 0, reach: 0, charge: 0, great: false, triggered: true });
      tr.name = v.name; tr.charge = v.charge || 0; tr.reach = v.reach; tr.great = !!v.great;
      tr.dmg = Math.round(v.dmg * HERO_TRIGGER.DMG); tr.posture = Math.round(v.posture * HERO_TRIGGER.POSTURE);
      tr.arc = v.arc; tr.knock = v.knock || 0; tr.sweep = !!v.sweep;
      v = tr;
    }
    const fx = this.facingX(), fz = this.facingZ(), cosMin = v.arc !== undefined ? v.arc : 0.34;   // sweep: about 100 deg each side
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      let seen = false;
      for (let k = 0; k < this._hitN; k++) if (this._hitIds[k] === t.id) { seen = true; break; }
      if (seen) continue;
      const dx = t.x - this.x, dz = t.z - this.z, d = Math.hypot(dx, dz);
      if (d > v.reach + (t.radius || 0) + this.radius) continue;
      if (d > 0.3 && (dx * fx + dz * fz) / d < cosMin) continue;    // 70 degree half-cone (sweep: wide arc)
      if (this._hitN < this._hitIds.length) this._hitIds[this._hitN++] = t.id;
      const dealt = t.onHeroHit ? t.onHeroHit(this, v, this.actionId) : 0;
      if (v.knock && dealt > 0 && !t.isBoss) this.knocks++;
      if (dealt > 0) { this.damageDealt += dealt; if (v.charge) this.chargedHits++; this.addGauge(dealt * HERO_TRIGGER.HIT_GAIN); }
      if (this.hitSink) this.hitSink(t, dealt, v);
    }
  }

  // v2.30 wave slash: a ground line launched from the blade along the facing. One actionId for the whole line; every
  // foe whose centre comes within half-width (+ radius) of the line front, ahead of the hero, is hit once.
  _launchWave(v) {
    const W = this.wave, P = v.wave;
    W.live = true; W.x = this.x + this.facingX() * 0.6; W.z = this.z + this.facingZ() * 0.6; W.dx = this.facingX(); W.dz = this.facingZ();
    // own contact id space (negative): actionId counts player actions (combo strings, swing tracking), not contacts
    W.d = 0; W.prevD = 0; W.hitN = 0; W.aid = -(++this.waveSeq); W.speed = P.speed; W.range = P.range; W.half = P.half;
    const g = this._waveV, m = this.wp || { DMG: 1, POSTURE: 1 }, tk = this.triggerF > 0;
    g.dmg = Math.round(P.dmg * m.DMG * (tk ? HERO_TRIGGER.DMG : 1)); g.posture = Math.round(P.posture * m.POSTURE * (tk ? HERO_TRIGGER.POSTURE : 1));
    g.reach = P.range; this.waves++; this._event('wave');
    this._hitN = 0;   // the melee snap and the line are separate contacts (different actionIds)
  }
  _stepWave(targets) {
    const W = this.wave; W.prevD = W.d; W.d = Math.min(W.range, W.d + W.speed);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      let seen = false; for (let k = 0; k < W.hitN; k++) if (W.ids[k] === t.id) { seen = true; break; }
      if (seen) continue;
      const rx = t.x - W.x, rz = t.z - W.z, along = rx * W.dx + rz * W.dz, lat = Math.abs(rx * W.dz - rz * W.dx), r = t.radius || 0;
      if (along < -r || along > W.d + r || lat > W.half + r) continue;
      if (W.hitN < W.ids.length) W.ids[W.hitN++] = t.id;
      const dealt = t.onHeroHit ? t.onHeroHit(this, this._waveV, W.aid) : 0;
      if (dealt > 0) { this.damageDealt += dealt; this.waveHits++; this.addGauge(dealt * HERO_TRIGGER.HIT_GAIN); }
      if (this.hitSink) this.hitSink(t, dealt, this._waveV);
    }
    if (W.d >= W.range) W.live = false;
  }

  // Trigger burst: radial shove that hits every targetable foe in BURST_R once (light damage, heavy posture).
  _burst(targets) {
    const b = this._burstV || (this._burstV = { name: 'BURST', dmg: 8, posture: 26, reach: HERO_TRIGGER.BURST_R, charge: 0, great: false, burst: true });
    this.actionId++;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]; if (!t || !t.targetable) continue;
      const d = Math.hypot(t.x - this.x, t.z - this.z);
      if (d > HERO_TRIGGER.BURST_R + (t.radius || 0)) continue;
      const dealt = t.onHeroHit ? t.onHeroHit(this, b, this.actionId) : 0;
      if (dealt > 0) this.damageDealt += dealt;
      if (this.hitSink) this.hitSink(t, dealt, b);
    }
    this._event('burst');
  }

  // Incoming contact record (WyvernBrain / DuelistSim rec shape). Applied exactly once by the attacker.
  applyContact(R) {
    if (this.state === HERO_STATE.DEAD) return;
    const O = Outcome;
    if ((R.outcome === O.HIT || R.outcome === O.BLOCKED) && R.damage > 0) this.hpIdle = 0;
    if (R.outcome === O.HIT && R.damage >= 8) this.charging = false;
    if (R.outcome === O.HIT) {
      this.hp -= R.damage; this.damageTaken += R.damage; this.hitsTaken++; this.flash = 12;
      if (this.god && this.hp < 1) this.hp = 1;
      if (this.hp <= 0) { this.hp = 0; this.state = HERO_STATE.DEAD; this.actF = 0; this.blocking = false; this.dodgeF = -1; this._event('death'); }
      else if (R.damage >= 8) { this.state = HERO_STATE.HITSTUN; this.actF = 0; this.hitstunLen = HITSTUN_F; this.blocking = false; this.queued = null; this._event('hit'); }
      else this._event('chip');
    } else if (R.outcome === O.BLOCKED) {
      this.hp = Math.max(this.god ? 1 : 0, this.hp - (R.damage || 0));
      this.stamina -= (R.posture || 0) * 0.5; this.staminaIdle = 0;
      if (this.stamina <= 0) { this.stamina = 0; this.state = HERO_STATE.HITSTUN; this.actF = 0; this.hitstunLen = GUARDBREAK_F; this.blocking = false; this._event('guardbreak'); }
      else this._event('block');
      if (R.slide > 0) { const l = Math.hypot(R.normal.x, R.normal.z) || 1; this.pushX += R.normal.x / l * R.slide; this.pushZ += R.normal.z / l * R.slide; }
    } else if (R.outcome === O.GUARDBREAK) {
      // Stage 3 G_DOME against a held block (wyvern/duelists never send this to the hero)
      this.hpIdle = 0;
      this.hp = Math.max(this.god ? 1 : 0, this.hp - (R.damage || 0)); this.damageTaken += R.damage || 0;
      if (this.hp <= 0) { this.state = HERO_STATE.DEAD; this.actF = 0; this.blocking = false; this.dodgeF = -1; this._event('death'); }
      else { this.state = HERO_STATE.HITSTUN; this.actF = 0; this.hitstunLen = GUARDBREAK_F; this.blocking = false; this.queued = null; this._event('guardbreak'); }
    } else if (R.outcome === O.PARRIED) {
      if (R.perfect) { this.perfects++; this._event('perfect'); this.stamina = Math.min(SIM.STAMINA_MAX, this.stamina + 15); }
      else { this.deflects++; this._event('deflect'); }
    } else if (R.outcome === O.WHIFF_IFRAME && R.effect && R.effect !== 'none') {
      this.phantoms++; this._event(R.effect);
    }
    if (R.effect === 'slip' || R.effect === 'behind') { this.x = R.tx; this.z = R.tz; this.prevX = this.x; this.prevZ = this.z; }
    if (this.contactSink) this.contactSink(R, this);
  }

  hash() {
    let x = 2166136261 >>> 0;
    const q = (v) => { x = Math.imul(x ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    q(this.x); q(this.z); q(this.yaw); q(this.hp); q(this.stamina); q(this.state); q(this.actF); q(this.weapon);
    return x >>> 0;
  }
}

export const DEATH_HOLD_F = DEATH_F;
