// Input - the ONE input layer (owner: player). Keyboard/mouse, touch (fed by ui/TouchOverlay through the
// sink methods below) and gamepad all write into the same state, so combat timing, the 10 f buffer and
// facing behave identically whichever device is used.
//
// Read side (player controller / combat / camera / game):
//   moveIntent(cameraYaw, outVec3)  -> world-space planar direction * magnitude (0..1), camera relative,
//                                      routed through WorldBasis (never hand-flipped signs).
//   moveMagnitude, speedForMagnitude(m) -> desired planar speed (walk at light push, run at full push).
//   peekBuffered() / consumeBuffered(action) -> newest buffered combat press (10 f, newest only).
//   isHeld(action), heldFrames(action)     -> holds (block, heavy charge).
//   consumeEdge(action)                    -> immediate edges (lock, pause); safe to call while paused.
//   consumeLook(out)                       -> accumulated camera yaw/pitch deltas (radians).
//
// Hot paths do not allocate: listeners are bound once in init(), scratch objects are fields.
import { Vector3 } from 'three';
import { DEFAULT_WORLD_BASIS } from '../gameblocks/modules/math/WorldBasis.js';
import { SIM, INPUT } from '../shared/constants.js';
import { InputAction, InputSource, INPUT_DEVICE_NAMES, INPUT_ACTION_COUNT } from '../shared/enums.js';

const A = InputAction;
const NONE = -1;

// Keyboard map (KeyboardEvent.code). Mouse: LMB attack, RMB heavy, MMB lock, wheel unused.
const KEY_MAP = {
  KeyJ: A.ATTACK, KeyK: A.HEAVY, KeyL: A.BLOCK, KeyQ: A.BLOCK, Space: A.DODGE, KeyC: A.ROLL, AltLeft: A.ROLL,
  Tab: A.LOCK, KeyR: A.LOCK, Escape: A.PAUSE, KeyP: A.PAUSE,
};
const MOVE_KEYS = { KeyW: 0, ArrowUp: 0, KeyS: 1, ArrowDown: 1, KeyA: 2, ArrowLeft: 2, KeyD: 3, ArrowRight: 3 };
const WALK_KEYS = { ShiftLeft: 1, ShiftRight: 1 };

// Standard-mapping gamepad: RB attack, RT heavy (analog), LB block, A dodge, B roll, X attack, Y heavy,
// R3 lock, Start pause. Left stick move, right stick look.
const PAD_BUTTONS = [
  [5, A.ATTACK], [2, A.ATTACK], [7, A.HEAVY], [3, A.HEAVY], [4, A.BLOCK], [6, A.BLOCK],
  [0, A.DODGE], [1, A.ROLL], [11, A.LOCK], [9, A.PAUSE],
];

export class Input {
  static id = 'input';
  static deps = [];

  constructor() {
    this.basis = DEFAULT_WORLD_BASIS;
    this.ctx = null;
    this.target = null;           // element for mouse buttons / pointer lock (canvas)
    this.disposed = false;

    // Held state: bitmask of InputSource per action; frames held (sim frames).
    this._held = new Uint8Array(INPUT_ACTION_COUNT);
    this._heldFrames = new Uint32Array(INPUT_ACTION_COUNT);
    // Edge counters for immediate actions (lock/pause) - read via consumeEdge.
    this._edges = new Uint8Array(INPUT_ACTION_COUNT);
    // Press counters (all actions) for telemetry/tests.
    this.pressCount = new Uint32Array(INPUT_ACTION_COUNT);
    this.lastPressSource = new Uint8Array(INPUT_ACTION_COUNT);

    // Combat buffer: newest press only.
    this._bufAction = NONE;
    this._bufAge = 0;
    this._bufSource = 0;

    // Move sources (right, forward) in -1..1, per device.
    this._keys = new Uint8Array(4);   // up, down, left, right
    this._walkKey = 0;
    this._touchX = 0; this._touchY = 0; this._touchActive = false;
    this._padX = 0; this._padY = 0;
    this.moveRight = 0; this.moveForward = 0; this.moveMagnitude = 0;

    // Look accumulators (radians).
    this._lookYaw = 0; this._lookPitch = 0;
    this._padLookX = 0; this._padLookY = 0;

    // Device tracking.
    this.device = 0;
    this._padIndex = -1;
    this._padPrev = new Uint8Array(16);
    this._polledFrame = -1;
    this._frame = 0;
    this.simFrame = 0;

    this._v = new Vector3();
    this._up = new Vector3();
  }

  init(ctx = null, opts = {}) {
    this.ctx = ctx;
    this.target = opts.target || (typeof document !== 'undefined' ? document.body : null);
    this.pointerLock = opts.pointerLock !== false;
    this.basis.upVector(this._up);

    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    this._onMouseDown = (e) => this._mouse(e, true);
    this._onMouseUp = (e) => this._mouse(e, false);
    this._onMouseMove = (e) => this._mouseMove(e);
    this._onContext = (e) => e.preventDefault();
    this._onBlur = () => this.releaseAll();
    this._onVis = () => { if (document.visibilityState === 'hidden') this.releaseAll(); };
    this._onPadConnect = (e) => { if (this._padIndex < 0) this._padIndex = e.gamepad.index; };
    this._onPadDisconnect = (e) => { if (this._padIndex === e.gamepad.index) { this._padIndex = -1; this._padX = this._padY = 0; this._releaseSource(InputSource.PAD); } };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('gamepadconnected', this._onPadConnect);
    window.addEventListener('gamepaddisconnected', this._onPadDisconnect);
    if (this.target) {
      this.target.addEventListener('mousedown', this._onMouseDown);
      this.target.addEventListener('contextmenu', this._onContext);
    }
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('mousemove', this._onMouseMove);
  }

  // ---------------------------------------------------------------- sinks (any device)
  press(action, source) {
    if (this.disposed) return;
    const wasHeld = this._held[action] !== 0;
    this._held[action] |= source;
    this._setDevice(source);
    if (wasHeld) return;   // second device on an already-held button: no new press
    this._heldFrames[action] = 0;
    this.pressCount[action]++;
    this.lastPressSource[action] = source;
    if (action === A.LOCK || action === A.PAUSE) {
      if (this._edges[action] < 255) this._edges[action]++;
    } else {
      this._bufAction = action; this._bufAge = 0; this._bufSource = source;   // newest press wins
    }
  }

  release(action, source) {
    this._held[action] &= ~source;
  }

  // Touch stick: x right, y up/forward, each -1..1 (already dead-zoned and clamped by the overlay).
  setTouchStick(x, y, active) {
    this._touchX = active ? x : 0; this._touchY = active ? y : 0; this._touchActive = !!active;
    if (active) this._setDevice(InputSource.TOUCH);
  }

  touchLook(dxPx, dyPx) {
    this._lookYaw -= dxPx * INPUT.TOUCH_LOOK_RAD_PER_PX;
    this._lookPitch += dyPx * INPUT.TOUCH_LOOK_RAD_PER_PX;
    this._setDevice(InputSource.TOUCH);
  }

  releaseAll() {
    this._held.fill(0);
    this._keys.fill(0);
    this._walkKey = 0;
    this._touchX = this._touchY = 0; this._touchActive = false;
    this._padX = this._padY = 0; this._padLookX = this._padLookY = 0;
    this._padPrev.fill(0);
  }

  // ---------------------------------------------------------------- read side
  isHeld(action) { return this._held[action] !== 0; }
  heldFrames(action) { return this._held[action] !== 0 ? this._heldFrames[action] : 0; }
  peekBuffered() { return this._bufAction; }
  bufferAge() { return this._bufAge; }
  bufferedSource() { return this._bufSource; }
  consumeBuffered(action) {
    if (this._bufAction !== action) return false;
    this._bufAction = NONE; this._bufAge = 0;
    return true;
  }
  clearBuffer() { this._bufAction = NONE; this._bufAge = 0; }
  consumeEdge(action) {
    if (this._edges[action] === 0) return false;
    this._edges[action]--;
    return true;
  }
  consumeLook(out) {
    out.x = this._lookYaw; out.y = this._lookPitch;
    this._lookYaw = 0; this._lookPitch = 0;
    return out;
  }
  deviceName() { return INPUT_DEVICE_NAMES[this.device] || 'none'; }

  // Camera-relative move vector on the ground plane, length = stick magnitude (0..1).
  moveIntent(cameraYaw, out) {
    this.basis.fromBasisComponents(this.moveRight, 0, this.moveForward, out);
    out.applyAxisAngle(this._up, cameraYaw);
    return out;
  }

  // Walk at a light push, run at a full push: 0..knee -> 0..WALK, knee..1 -> WALK..RUN.
  speedForMagnitude(m) {
    const k = INPUT.STICK_WALK_KNEE;
    if (m <= 0) return 0;
    if (m <= k) return SIM.WALK_SPEED * (m / k);
    return SIM.WALK_SPEED + (SIM.RUN_SPEED - SIM.WALK_SPEED) * Math.min(1, (m - k) / (1 - k));
  }

  // ---------------------------------------------------------------- loop hooks
  fixedUpdate() {
    this.poll();
    this.simFrame++;
    for (let i = 0; i < INPUT_ACTION_COUNT; i++) if (this._held[i] !== 0) this._heldFrames[i]++;
    if (this._bufAction !== NONE) {
      this._bufAge++;
      if (this._bufAge > INPUT.BUFFER_FRAMES) { this._bufAction = NONE; this._bufAge = 0; }
    }
  }

  update(dt) {
    this.poll();
    if (this._padLookX !== 0 || this._padLookY !== 0) {
      this._lookYaw -= this._padLookX * INPUT.PAD_LOOK_RAD_PER_S * dt;
      this._lookPitch += this._padLookY * INPUT.PAD_LOOK_RAD_PER_S * dt;
    }
  }

  lateUpdate() { this._frame++; }

  // Gamepad poll + move resolution. Idempotent within one render frame.
  poll() {
    if (this._polledFrame === this._frame) return;
    this._polledFrame = this._frame;
    this._pollPad();
    this._resolveMove();
  }

  // ---------------------------------------------------------------- internals
  _resolveMove() {
    let x = 0, y = 0, mag = 0;
    if (this._touchActive && (this._touchX !== 0 || this._touchY !== 0)) {
      x = this._touchX; y = this._touchY;
    } else if (this._padX !== 0 || this._padY !== 0) {
      x = this._padX; y = this._padY;
    } else {
      const k = this._keys;
      x = (k[3] ? 1 : 0) - (k[2] ? 1 : 0);
      y = (k[0] ? 1 : 0) - (k[1] ? 1 : 0);
      if (x !== 0 || y !== 0) {
        const l = Math.hypot(x, y), s = (this._walkKey ? INPUT.KEY_WALK_MAG : 1) / l;
        x *= s; y *= s;
      }
    }
    mag = Math.hypot(x, y);
    if (mag > 1) { x /= mag; y /= mag; mag = 1; }
    this.moveRight = x; this.moveForward = y; this.moveMagnitude = mag;
  }

  _pollPad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    if (!pads) return;
    let pad = this._padIndex >= 0 ? pads[this._padIndex] : null;
    if (!pad) {
      for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected) { pad = pads[i]; this._padIndex = i; break; }
      if (!pad) return;
    }
    const ax = pad.axes;
    let x = ax[0] || 0, y = -(ax[1] || 0);
    let m = Math.hypot(x, y);
    const dz = INPUT.DEADZONE_PAD;
    if (m < dz) { x = 0; y = 0; } else { const s = Math.min(1, (m - dz) / (1 - dz)) / m; x *= s; y *= s; }
    let lx = ax[2] || 0, ly = -(ax[3] || 0);
    m = Math.hypot(lx, ly);
    if (m < dz) { lx = 0; ly = 0; } else { const s = Math.min(1, (m - dz) / (1 - dz)) / m; lx *= s; ly *= s; }
    if ((x !== 0 || y !== 0 || lx !== 0 || ly !== 0)) this._setDevice(InputSource.PAD);
    this._padX = x; this._padY = y; this._padLookX = lx; this._padLookY = ly;

    const b = pad.buttons;
    for (let i = 0; i < PAD_BUTTONS.length; i++) {
      const bi = PAD_BUTTONS[i][0], act = PAD_BUTTONS[i][1];
      const btn = b[bi];
      if (!btn) continue;
      const prev = this._padPrev[bi];
      // Analog triggers: press above 0.55, release below 0.35 (hysteresis).
      const v = btn.value !== undefined ? btn.value : (btn.pressed ? 1 : 0);
      const down = prev ? (btn.pressed || v > 0.35) : (btn.pressed && v > 0.55) || v > 0.55;
      if (down && !prev) { this._padPrev[bi] = 1; this.press(act, InputSource.PAD); }
      else if (!down && prev) { this._padPrev[bi] = 0; this._releasePadAction(act); }
    }
  }

  // Release a pad action only if no other pad button mapped to it is still down.
  _releasePadAction(act) {
    for (let i = 0; i < PAD_BUTTONS.length; i++) if (PAD_BUTTONS[i][1] === act && this._padPrev[PAD_BUTTONS[i][0]]) return;
    this.release(act, InputSource.PAD);
  }

  _releaseSource(src) { for (let i = 0; i < INPUT_ACTION_COUNT; i++) this._held[i] &= ~src; }

  _key(e, down) {
    if (this.disposed) return;
    const code = e.code;
    const mv = MOVE_KEYS[code];
    if (mv !== undefined) { this._keys[mv] = down ? 1 : 0; if (down) this._setDevice(InputSource.KBM); e.preventDefault(); return; }
    if (WALK_KEYS[code]) { this._walkKey = down ? 1 : 0; return; }
    const act = KEY_MAP[code];
    if (act === undefined) return;
    e.preventDefault();
    if (down) { if (!e.repeat) this.press(act, InputSource.KBM); }
    else this.release(act, InputSource.KBM);
  }

  _mouse(e, down) {
    if (this.disposed) return;
    const act = e.button === 0 ? A.ATTACK : e.button === 2 ? A.HEAVY : e.button === 1 ? A.LOCK : -1;
    if (down && this.pointerLock && this.target && document.pointerLockElement !== this.target && this.target.requestPointerLock) {
      // First click only captures the mouse; it does not attack.
      const r = this.target.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
      return;
    }
    if (act < 0) return;
    if (down) { e.preventDefault(); this.press(act, InputSource.KBM); }
    else this.release(act, InputSource.KBM);
  }

  _mouseMove(e) {
    if (this.pointerLock && document.pointerLockElement !== this.target) return;
    this._lookYaw -= e.movementX * INPUT.MOUSE_LOOK_RAD_PER_PX;
    this._lookPitch += e.movementY * INPUT.MOUSE_LOOK_RAD_PER_PX;
  }

  _setDevice(src) {
    if (this.device === src) return;
    this.device = src;
    const bus = this.ctx && this.ctx.bus;
    if (bus) { const p = bus.payload('input/device'); p.device = INPUT_DEVICE_NAMES[src]; bus.dispatch('input/device'); }
    if (this.onDevice) this.onDevice(INPUT_DEVICE_NAMES[src]);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('gamepadconnected', this._onPadConnect);
    window.removeEventListener('gamepaddisconnected', this._onPadDisconnect);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    if (this.target) {
      this.target.removeEventListener('mousedown', this._onMouseDown);
      this.target.removeEventListener('contextmenu', this._onContext);
    }
    if (document.pointerLockElement === this.target && document.exitPointerLock) document.exitPointerLock();
    this.releaseAll();
  }
}
