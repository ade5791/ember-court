// TouchOverlay (owner: ui). On-screen controls for touch: floating left analog stick, right-side camera
// drag, and seven action buttons (Attack, Heavy, Block, Dodge, Roll, Lock, Pause).
//
// It writes into the input layer through a duck-typed sink obtained at runtime (ctx.get('input')):
//   sink.press(action, source) / sink.release(action, source) / sink.setTouchStick(x, y, active)
//   sink.touchLook(dxPx, dyPx) / sink.heldFrames(action) / sink.peekBuffered()
// No import of player code (ARCHITECTURE.md section 1).
//
// Layout rules: every button >= 48 px, all inside the safe area (env(safe-area-inset-*), overridable via
// --sat/--sar/--sab/--sal for tests), no overlapping hit areas, stick zone and buttons never overlap.
// Orientation changes only re-flow CSS; no input or game state is reset.
import { InputAction, InputSource } from '../shared/enums.js';

const A = InputAction;
const SRC = InputSource.TOUCH;
const STICK_RADIUS = 60;     // px, knob travel
const DEADZONE = 0.10;

const BUTTONS = [
  { action: A.ATTACK, key: 'attack', label: 'Attack', size: 'xl' },
  { action: A.HEAVY, key: 'heavy', label: 'Heavy', size: 'l', hint: 'hold' },
  { action: A.BLOCK, key: 'block', label: 'Block', size: 'l', hint: 'hold' },
  { action: A.DODGE, key: 'dodge', label: 'Dodge', size: 'l' },
  { action: A.ROLL, key: 'roll', label: 'Roll', size: 'l' },
  { action: A.LOCK, key: 'lock', label: 'Lock', size: 'm' },
  { action: A.PAUSE, key: 'pause', label: 'Pause', size: 's' },
  { action: A.SNATCH, key: 'snatch', label: 'Snatch', size: 'm' },
  { action: A.TRIGGER, key: 'trigger', label: 'Ember', size: 'm' },
  { action: A.SWEEP, key: 'sweep', label: 'Sweep', size: 'm' },
  { action: A.JUMP, key: 'jump', label: 'Jump', size: 'l' },
];

const CSS = `
.ec-touch{position:fixed;inset:0;z-index:20;pointer-events:none;user-select:none;-webkit-user-select:none;
  -webkit-touch-callout:none;touch-action:none;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  --sat:env(safe-area-inset-top,0px);--sar:env(safe-area-inset-right,0px);
  --sab:env(safe-area-inset-bottom,0px);--sal:env(safe-area-inset-left,0px);}
.ec-touch.hidden{display:none}
.ec-zone{position:absolute;pointer-events:auto;touch-action:none}
.ec-zone.stick{left:0;top:calc(var(--sat) + 64px);bottom:0;width:45%}
.ec-zone.look{right:0;top:calc(var(--sat) + 64px);bottom:0;width:55%}
.ec-stick{position:absolute;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;
  border:2px solid rgba(255,214,170,.35);background:radial-gradient(circle,rgba(30,18,12,.35),rgba(30,18,12,.15));
  opacity:0;transition:opacity .12s;pointer-events:none}
.ec-stick.on{opacity:1}
.ec-stick.idle{opacity:.35}
.ec-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;
  background:radial-gradient(circle at 40% 35%,#ffcf9a,#c9661f 70%);box-shadow:0 2px 10px rgba(0,0,0,.45)}
.ec-stick.run .ec-knob{background:radial-gradient(circle at 40% 35%,#ffe6b0,#ff7a1c 70%);box-shadow:0 0 14px rgba(255,120,30,.7)}
.ec-btn{position:absolute;pointer-events:auto;touch-action:none;border-radius:50%;display:flex;flex-direction:column;
  align-items:center;justify-content:center;color:#ffe9d2;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
  background:radial-gradient(circle at 45% 35%,rgba(70,40,26,.82),rgba(26,14,10,.82));
  border:2px solid rgba(255,190,130,.55);box-shadow:0 3px 10px rgba(0,0,0,.45),inset 0 0 0 1px rgba(0,0,0,.4);
  transform:translate(50%,50%);transition:transform .05s,background .05s,opacity .1s;box-sizing:border-box}
.ec-btn .lb{font-size:11px;line-height:1}
.ec-btn .ht{font-size:10px;opacity:.95;margin-top:3px;font-weight:700;color:#ffd08a}
.ec-btn.held{transform:translate(50%,50%) scale(.92);background:radial-gradient(circle at 45% 35%,#ff9a3c,#a5380e);
  border-color:#ffd9a8;color:#fff}
.ec-btn.queued{border-color:#ffd25a;box-shadow:0 0 0 3px rgba(255,210,90,.55),0 3px 10px rgba(0,0,0,.45)}
.ec-btn.off{opacity:.38;border-style:dashed}
.ec-btn.on-toggle{border-color:#7fd3ff;box-shadow:0 0 0 3px rgba(127,211,255,.45)}
.ec-btn .ring{position:absolute;inset:-6px;border-radius:50%;pointer-events:none;
  background:conic-gradient(#ffb347 calc(var(--charge,0)*360deg),transparent 0);
  -webkit-mask:radial-gradient(circle,transparent 62%,#000 63%);mask:radial-gradient(circle,transparent 62%,#000 63%);opacity:.95}
.ec-btn.xl{width:88px;height:88px}.ec-btn.xl .lb{font-size:13px}
.ec-btn.l{width:66px;height:66px}
.ec-btn.m{width:56px;height:56px}
.ec-btn.s{width:48px;height:48px;border-radius:12px}.ec-btn.s .lb{font-size:9px}
/* centres measured from the bottom-right corner of the safe area (translate(50%,50%) centres them) */
.ec-btn.attack{right:calc(var(--sar) + 70px);bottom:calc(var(--sab) + 92px)}
.ec-btn.heavy{right:calc(var(--sar) + 168px);bottom:calc(var(--sab) + 60px)}
.ec-btn.block{right:calc(var(--sar) + 62px);bottom:calc(var(--sab) + 196px)}
.ec-btn.dodge{right:calc(var(--sar) + 156px);bottom:calc(var(--sab) + 164px)}
.ec-btn.roll{right:calc(var(--sar) + 160px);bottom:calc(var(--sab) + 262px)}
.ec-btn.lock{right:calc(var(--sar) + 62px);bottom:calc(var(--sab) + 288px)}
.ec-btn.pause{right:calc(var(--sar) + 36px);bottom:auto;top:calc(var(--sat) + 12px);transform:translate(50%,0)}
.ec-btn.pause.held{transform:translate(50%,0) scale(.92)}
.ec-btn.snatch{right:calc(var(--sar) + 160px);bottom:calc(var(--sab) + 352px);border-color:rgba(255,110,80,.7)}
.ec-btn.trigger{right:calc(var(--sar) + 62px);bottom:calc(var(--sab) + 372px);border-color:rgba(255,80,40,.75)}
.ec-btn.trigger.ready{box-shadow:0 0 14px 2px rgba(255,80,30,.8)}
.ec-btn.sweep{right:calc(var(--sar) + 160px);bottom:calc(var(--sab) + 440px);border-color:rgba(255,170,90,.7)}
.ec-btn.jump{right:calc(var(--sar) + 62px);bottom:calc(var(--sab) + 458px);border-color:rgba(150,220,255,.75)}
@media (orientation:landscape){
  .ec-btn.jump{right:calc(var(--sar) + 268px);bottom:calc(var(--sab) + 40px)}
  .ec-btn.sweep{right:calc(var(--sar) + 356px);bottom:calc(var(--sab) + 150px)}
  .ec-btn.snatch{right:calc(var(--sar) + 262px);bottom:calc(var(--sab) + 200px)}
  .ec-btn.trigger{right:calc(var(--sar) + 356px);bottom:calc(var(--sab) + 60px)}
  .ec-btn.attack{right:calc(var(--sar) + 76px);bottom:calc(var(--sab) + 76px)}
  .ec-btn.heavy{right:calc(var(--sar) + 176px);bottom:calc(var(--sab) + 50px)}
  .ec-btn.block{right:calc(var(--sar) + 64px);bottom:calc(var(--sab) + 180px)}
  .ec-btn.dodge{right:calc(var(--sar) + 160px);bottom:calc(var(--sab) + 148px)}
  .ec-btn.roll{right:calc(var(--sar) + 166px);bottom:calc(var(--sab) + 236px)}
  .ec-btn.lock{right:calc(var(--sar) + 260px);bottom:calc(var(--sab) + 112px)}
  .ec-zone.stick{width:40%}.ec-zone.look{width:60%}
}
@media (prefers-reduced-motion:reduce){.ec-btn,.ec-stick{transition:none}}
`;

export class TouchOverlay {
  static id = 'touch';
  static deps = ['input'];

  constructor() {
    this.root = null;
    this.sink = null;
    this.disposed = false;
    this._stickId = -1; this._lookId = -1;
    this._ox = 0; this._oy = 0; this._lx = 0; this._ly = 0;
    this._btnEls = [];
    this._btnPointer = new Int32Array(BUTTONS.length).fill(-1);
    this._available = new Uint8Array(BUTTONS.length).fill(1);
    this._readyCls = new Uint8Array(BUTTONS.length);
    this.heavyChargeFrames = 30;
    this.stickX = 0; this.stickY = 0;
  }

  init(ctx, opts = {}) {
    this.sink = opts.sink || (ctx && ctx.get ? ctx.get('input') : null);
    if (!this.sink) throw new Error('TouchOverlay: no input sink');
    const host = opts.host || document.body;

    this._style = document.createElement('style');
    this._style.textContent = CSS;
    document.head.appendChild(this._style);

    const root = this.root = document.createElement('div');
    root.className = 'ec-touch';
    root.setAttribute('data-ec', 'touch-overlay');

    this._stickZone = this._el('div', 'ec-zone stick', root); this._stickZone.dataset.ec = 'stick-zone';
    this._lookZone = this._el('div', 'ec-zone look', root); this._lookZone.dataset.ec = 'look-zone';
    this._stick = this._el('div', 'ec-stick idle', root);
    this._knob = this._el('div', 'ec-knob', this._stick);

    for (let i = 0; i < BUTTONS.length; i++) {
      const b = BUTTONS[i];
      const el = this._el('div', 'ec-btn ' + b.size + ' ' + b.key, root);
      el.dataset.ec = 'btn-' + b.key;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', b.label);
      if (b.action === A.HEAVY) this._ring = this._el('div', 'ring', el);
      this._el('div', 'lb', el).textContent = b.label;
      if (b.hint) this._el('div', 'ht', el).textContent = b.hint;
      this._btnEls.push(el);
      el.addEventListener('pointerdown', this._onBtnDown = this._onBtnDown || ((e) => this._btnDown(e)));
      el.addEventListener('pointerup', this._onBtnUp = this._onBtnUp || ((e) => this._btnUp(e)));
      el.addEventListener('pointercancel', this._onBtnUp);
      el.addEventListener('lostpointercapture', this._onBtnUp);
    }
    this._placeStickIdle();

    this._onStickDown = (e) => this._stickDown(e);
    this._onStickMove = (e) => this._stickMove(e);
    this._onStickUp = (e) => this._stickUp(e);
    this._onLookDown = (e) => this._lookDown(e);
    this._onLookMove = (e) => this._lookMove(e);
    this._onLookUp = (e) => this._lookUp(e);
    this._stickZone.addEventListener('pointerdown', this._onStickDown);
    this._stickZone.addEventListener('pointermove', this._onStickMove);
    this._stickZone.addEventListener('pointerup', this._onStickUp);
    this._stickZone.addEventListener('pointercancel', this._onStickUp);
    this._stickZone.addEventListener('lostpointercapture', this._onStickUp);
    this._lookZone.addEventListener('pointerdown', this._onLookDown);
    this._lookZone.addEventListener('pointermove', this._onLookMove);
    this._lookZone.addEventListener('pointerup', this._onLookUp);
    this._lookZone.addEventListener('pointercancel', this._onLookUp);
    this._lookZone.addEventListener('lostpointercapture', this._onLookUp);
    this._onCtx = (e) => e.preventDefault();
    root.addEventListener('contextmenu', this._onCtx);
    this._onResize = () => { if (this._stickId < 0) this._placeStickIdle(); };
    window.addEventListener('resize', this._onResize);

    host.appendChild(root);
    const force = opts.visible;
    const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
    this.setVisible(force !== undefined ? force : coarse);
    // Any real touch anywhere reveals the overlay (e.g. a touch laptop that reports a fine pointer).
    this._onAnyTouch = (e) => { if (e.pointerType === 'touch' && !this.visible) this.setVisible(true); };
    window.addEventListener('pointerdown', this._onAnyTouch, true);
    // Page-zoom guard. iOS Safari ignores user-scalable=no and touch-action for pinch, and still double-tap zooms
    // when two quick taps land on adjacent buttons. Block the gesture/dblclick/multi-touch paths at the document
    // (passive:false so preventDefault sticks). Headless Chromium never zooms, so this is the real-device fix.
    this._noZoom = (e) => { if (e.cancelable) e.preventDefault(); };
    this._noPinch = (e) => { if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault(); };
    this._lastTouchEnd = 0;
    this._noDblTap = (e) => { const t = e.timeStamp; if (t - this._lastTouchEnd < 350 && e.cancelable) e.preventDefault(); this._lastTouchEnd = t; };
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) document.addEventListener(ev, this._noZoom, { passive: false });
    document.addEventListener('touchmove', this._noPinch, { passive: false });
    document.addEventListener('touchend', this._noDblTap, { passive: false });
  }

  setVisible(v) {
    this.visible = !!v;
    if (this.root) this.root.classList.toggle('hidden', !this.visible);
    if (this.onVisibility) this.onVisibility(this.visible);
    if (!this.visible) this._releaseAll();
  }

  // Grey out a button the game currently refuses (e.g. dodge at 0 stamina); presses still reach the input
  // layer so the combat side owns the decision, the overlay only shows it.
  setAvailable(action, ok) {
    const i = this._indexOf(action);
    if (i < 0 || this._available[i] === (ok ? 1 : 0)) return;
    this._available[i] = ok ? 1 : 0;
    this._btnEls[i].classList.toggle('off', !ok);
  }

  // Glow a button when its resource is ready (Ember Trigger gauge >= cost). Presentation only.
  setReady(action, on) {
    const i = this._indexOf(action);
    if (i >= 0 && this._readyCls[i] !== (on ? 1 : 0)) { this._readyCls[i] = on ? 1 : 0; this._btnEls[i].classList.toggle('ready', !!on); }
  }

  setToggle(action, on) {
    const i = this._indexOf(action);
    if (i >= 0) this._btnEls[i].classList.toggle('on-toggle', !!on);
  }

  // Per render frame: charge ring, queued highlight. No allocation.
  update() {
    if (!this.visible || !this.sink) return;
    const hf = this.sink.heldFrames(A.HEAVY);
    const c = hf > 0 ? Math.min(1, hf / this.heavyChargeFrames) : 0;
    if (c !== this._lastCharge) { this._lastCharge = c; this._btnEls[1].style.setProperty('--charge', c.toFixed(3)); }
    const q = this.sink.peekBuffered();
    if (q !== this._lastQueued) {
      if (this._lastQueued >= 0) { const j = this._indexOf(this._lastQueued); if (j >= 0) this._btnEls[j].classList.remove('queued'); }
      if (q >= 0) { const j = this._indexOf(q); if (j >= 0) this._btnEls[j].classList.add('queued'); }
      this._lastQueued = q;
    }
  }

  // Bounding boxes for the layout gate (tests): returns plain data, called rarely.
  layoutReport() {
    const out = { buttons: [], stickZone: null, lookZone: null };
    for (let i = 0; i < BUTTONS.length; i++) {
      const r = this._btnEls[i].getBoundingClientRect();
      out.buttons.push({ key: BUTTONS[i].key, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    const s = this._stickZone.getBoundingClientRect(), l = this._lookZone.getBoundingClientRect();
    out.stickZone = { x: s.left, y: s.top, w: s.width, h: s.height };
    out.lookZone = { x: l.left, y: l.top, w: l.width, h: l.height };
    const cs = getComputedStyle(this.root);
    out.safe = { top: cs.getPropertyValue('--sat'), right: cs.getPropertyValue('--sar'), bottom: cs.getPropertyValue('--sab'), left: cs.getPropertyValue('--sal') };
    return out;
  }

  // ------------------------------------------------------------ buttons
  _btnDown(e) {
    const el = e.currentTarget;
    const i = this._btnEls.indexOf(el);
    if (i < 0 || this._btnPointer[i] >= 0) return;
    e.preventDefault(); e.stopPropagation();
    this._btnPointer[i] = e.pointerId;
    if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ } }
    el.classList.add('held');
    this.sink.press(BUTTONS[i].action, SRC);
  }

  _btnUp(e) {
    const el = e.currentTarget;
    const i = this._btnEls.indexOf(el);
    if (i < 0 || this._btnPointer[i] !== e.pointerId) return;
    this._btnPointer[i] = -1;
    el.classList.remove('held');
    this.sink.release(BUTTONS[i].action, SRC);
  }

  // ------------------------------------------------------------ stick (floating)
  _stickDown(e) {
    if (this._stickId >= 0) return;
    e.preventDefault();
    this._stickId = e.pointerId;
    try { this._stickZone.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    const zr = this._stickZone.getBoundingClientRect();
    // Keep the whole base inside the zone (zone already starts below the top safe inset).
    this._ox = Math.min(Math.max(e.clientX, zr.left + STICK_RADIUS + 4), zr.right - STICK_RADIUS - 4);
    this._oy = Math.min(Math.max(e.clientY, zr.top + STICK_RADIUS + 4), zr.bottom - STICK_RADIUS - 4);
    this._stick.style.left = this._ox + 'px'; this._stick.style.top = this._oy + 'px';
    this._stick.classList.remove('idle'); this._stick.classList.add('on');
    this._applyStick(e.clientX, e.clientY);
  }

  _stickMove(e) {
    if (e.pointerId !== this._stickId) return;
    e.preventDefault();
    this._applyStick(e.clientX, e.clientY);
  }

  _stickUp(e) {
    if (e.pointerId !== this._stickId) return;
    this._stickId = -1;
    this.stickX = this.stickY = 0;
    this.sink.setTouchStick(0, 0, false);
    this._knob.style.transform = '';
    this._stick.classList.remove('on', 'run');
    this._placeStickIdle();
  }

  _applyStick(cx, cy) {
    let dx = cx - this._ox, dy = cy - this._oy;
    let d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) { dx *= STICK_RADIUS / d; dy *= STICK_RADIUS / d; d = STICK_RADIUS; }
    this._knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    let m = Math.min(1, d / STICK_RADIUS);
    let x = 0, y = 0;
    if (m > DEADZONE) {
      const s = (m - DEADZONE) / (1 - DEADZONE);
      x = (dx / (d || 1)) * s; y = -(dy / (d || 1)) * s;   // screen up = forward
      m = s;
    } else m = 0;
    this.stickX = x; this.stickY = y;
    this._stick.classList.toggle('run', m > 0.85);
    this.sink.setTouchStick(x, y, true);
  }

  _placeStickIdle() {
    if (!this._stickZone) return;
    const zr = this._stickZone.getBoundingClientRect();
    if (zr.width === 0) return;
    this._stick.style.left = (zr.left + Math.min(zr.width * 0.42, 130)) + 'px';
    this._stick.style.top = (zr.bottom - Math.min(zr.height * 0.3, 150)) + 'px';
    this._stick.classList.add('idle');
  }

  // ------------------------------------------------------------ camera look
  _lookDown(e) {
    if (this._lookId >= 0) return;
    e.preventDefault();
    this._lookId = e.pointerId;
    try { this._lookZone.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
    this._lx = e.clientX; this._ly = e.clientY;
  }

  _lookMove(e) {
    if (e.pointerId !== this._lookId) return;
    e.preventDefault();
    this.sink.touchLook(e.clientX - this._lx, e.clientY - this._ly);
    this._lx = e.clientX; this._ly = e.clientY;
  }

  _lookUp(e) { if (e.pointerId === this._lookId) this._lookId = -1; }

  // ------------------------------------------------------------ misc
  _releaseAll() {
    for (let i = 0; i < BUTTONS.length; i++) {
      if (this._btnPointer[i] >= 0) { this._btnPointer[i] = -1; this._btnEls[i].classList.remove('held'); this.sink.release(BUTTONS[i].action, SRC); }
    }
    if (this._stickId >= 0) { this._stickId = -1; this.sink.setTouchStick(0, 0, false); }
    this._lookId = -1;
  }

  _indexOf(action) { for (let i = 0; i < BUTTONS.length; i++) if (BUTTONS[i].action === action) return i; return -1; }

  _el(tag, cls, parent) { const el = document.createElement(tag); el.className = cls; parent.appendChild(el); return el; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._releaseAll();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointerdown', this._onAnyTouch, true);
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) document.removeEventListener(ev, this._noZoom);
    document.removeEventListener('touchmove', this._noPinch); document.removeEventListener('touchend', this._noDblTap);
    if (this.root) {
      for (const el of this._btnEls) {
        el.removeEventListener('pointerdown', this._onBtnDown); el.removeEventListener('pointerup', this._onBtnUp);
        el.removeEventListener('pointercancel', this._onBtnUp); el.removeEventListener('lostpointercapture', this._onBtnUp);
      }
      this.root.remove();
    }
    if (this._style) this._style.remove();
    this.root = null; this._btnEls.length = 0;
  }
}
