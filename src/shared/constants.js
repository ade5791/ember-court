// Simulation constants - ARCHITECTURE.md section 4. Pure data, no imports.
export const SIM = Object.freeze({
  FIXED_HZ: 60,
  FIXED_DT: 1 / 60,
  SUBSTEP_CAP: 5,
  DELTA_CAP: 0.1,
  ACTOR_HEIGHT: 1.80,
  CAPSULE_RADIUS: 0.35,
  CAPSULE_HALF_SEGMENT: 0.55,
  GRAVITY: -9.81,
  WALK_SPEED: 1.6,
  RUN_SPEED: 4.2,
  ACCEL: 14,
  DECEL: 18,
  TURN_RATE: 720 * Math.PI / 180,
  ARENA_HALF: 16.0,        // 32 x 32 m playable floor (contract v2); inner wall face at |x|,|z| = 16.0
  LOCK_RANGE: 9.0,
  HP_PLAYER: 100,
  STAMINA_MAX: 100,
  SEED_DEFAULT: 0xE3BE7C0E,
});

// Wyvern boss (CINEMATIC_SPEC section 9). Asset: characters/boss/wyvern.glb (protofactor wyvern,
// Sketchfab CC BY 4.0). Every clip is in place: the boss controller owns root XZ, yaw and flight height.
export const BOSS = Object.freeze({
  SCALE: 3.0,              // runtime uniform scale; rest pose ~7.4 m nose-to-tail, head ~2.1 m (bipedal idle)
  ROT_Y: Math.PI,          // asset faces +Z, game forward is -Z (pivot rotation, never sign hacks)
  SPAWN: Object.freeze([0, 0, -9]),
  HP: 900,
  POSTURE_MAX: 300,
  HOVER_Y: 4.65,           // min root height in hover clips: hover_haze body dips 4.58 m at scale 3
  FLIGHT_CEILING: 11.0,    // camera and boss both clamp below this
  BODY_RADIUS: 2.2,        // ground hurt/push capsule (pelvis-centred). v2.4: hull bones measured 1.65-1.74 m p90 at scale 3
  BODY_HALF_SEGMENT: 1.6,
  HEAD_RADIUS: 0.55,       // head hurt sphere, follows bone 'wivern_ Head'
  COLOR_SCALE: 2.0,        // albedo lift: measured boss-only mean luminance 11.1 -> 23.1 (of 255)
  AO_INTENSITY: 0.5,
  CAMERA_WALL_MARGIN: 0.25 // C5
});

// Input layer constants (COMBAT_SPEC section 1 + control layer plan).
export const INPUT = Object.freeze({
  BUFFER_FRAMES: 10,       // attack/heavy/block/dodge presses live 10 f, newest only
  DEADZONE_PAD: 0.18,      // radial, rescaled
  DEADZONE_TOUCH: 0.10,
  STICK_WALK_KNEE: 0.6,    // stick magnitude that maps exactly to WALK_SPEED; 1.0 -> RUN_SPEED
  KEY_WALK_MAG: 0.6,       // keyboard magnitude while the walk modifier is held
  MOUSE_LOOK_RAD_PER_PX: 0.0025,
  TOUCH_LOOK_RAD_PER_PX: 0.0065,
  PAD_LOOK_RAD_PER_S: 3.0,
  PITCH_MIN: -0.35,
  PITCH_MAX: 0.70,
});
