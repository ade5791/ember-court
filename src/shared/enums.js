// Shared enums - ARCHITECTURE.md section 6. Pure frozen data, no imports.
const e = (names) => Object.freeze(Object.fromEntries(names.map((n, i) => [n, i])));

// Order is append-only: v1 indices stay stable. Crimson Ford (stage ford-32m) adds the last eight;
// court-colliders.json carries surface by NAME, resolved through this table at load.
export const Surface = e(['STONE_FLOOR', 'STONE_WALL', 'WOOD_CRATE', 'METAL_BRAZIER', 'CLOTH_BANNER', 'FLESH', 'ARMOR', 'BLADE',
  'WATER', 'SAND', 'WOOD_PLANK', 'MOSS_STONE', 'ROCK', 'STONE_LANTERN', 'WOOD_BARK', 'SCALE']);
export const GameState = e(['BOOT', 'TITLE', 'INTRO', 'WAVE', 'WAVE_CLEAR', 'BOSS', 'VICTORY', 'DEFEAT']);
export const ActorKind = e(['HERO', 'DUELIST', 'WYVERN']);
// Wyvern boss: locomotion layer (ground biped / ground quadruped / air) and verbs (CINEMATIC_SPEC section 9).
export const BossStance = e(['GROUND_UP', 'GROUND_LOW', 'AIR']);
export const BossVerb = e(['W_BITE', 'W_LUNGE', 'W_CHARGE', 'W_TAIL_L', 'W_TAIL_R', 'W_SPIT', 'W_HAZE', 'W_SWOOP', 'W_SKY_HAZE', 'W_LAND', 'W_ROAR']);
export const ActorState = e(['LOCOMOTION', 'ACTION', 'BLOCK', 'DODGE', 'STAGGER', 'GUARDBROKEN', 'DEAD']);
export const Verb = e(['LIGHT_1', 'LIGHT_2', 'LIGHT_3', 'HEAVY', 'BLOCK', 'PARRY', 'DODGE', 'E_SLASH', 'E_THRUST', 'E_COMBO', 'C_CHARGED', 'C_SPIN', 'C_GROUND_SLAM']);
export const Phase = e(['STARTUP', 'ACTIVE', 'RECOVERY']);
export const Outcome = e(['HIT', 'BLOCKED', 'PARRIED', 'WHIFF_IFRAME', 'GUARDBREAK']);
export const FxKind = e(['SPARK', 'BLOOD_DUST', 'PARRY_FLASH', 'EMBER_BURST', 'DUST_PUFF', 'TELEGRAPH_GLINT']);

// Input layer (player owns the state, ui touch overlay writes into it by duck-typed sink).
export const InputAction = e(['ATTACK', 'HEAVY', 'BLOCK', 'DODGE', 'LOCK', 'PAUSE']);
export const INPUT_ACTION_NAMES = Object.freeze(['attack', 'heavy', 'block', 'dodge', 'lock', 'pause']);
export const INPUT_ACTION_COUNT = 6;
// Bit flags so a hold from two devices at once is released only when both let go.
export const InputSource = Object.freeze({ KBM: 1, TOUCH: 2, PAD: 4 });
export const INPUT_DEVICE_NAMES = Object.freeze({ 1: 'kbm', 2: 'touch', 4: 'pad' });
// Actions that go through the 10 f combat buffer (newest press wins). LOCK and PAUSE are immediate edges.
export const BUFFERED_ACTIONS = Object.freeze([0, 1, 2, 3]);
