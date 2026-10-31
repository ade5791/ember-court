// Fullscreen - toggle buttons, F key, and auto-enter on BEGIN (owner: ui). DOM only, no THREE.
// Two buttons share one toggle: a labelled "FULL SCREEN" button beside BEGIN on the title screen (mounted into the
// HUD slot via mountMenu), and a corner icon under the health bars during play, pause and end screens.
// Fullscreen can only be requested inside a user gesture, so request() must be called from a click/tap/key handler.
// iPhone Safari has no element fullscreen: there the buttons open an "Add to Home Screen" tip instead (the web app
// manifest launches the home-screen copy full screen). Installed home-screen copies hide both (already full screen).
const CSS = `
.ec-fs{position:fixed;z-index:30;left:calc(env(safe-area-inset-left,0px) + 18px);top:calc(env(safe-area-inset-top,0px) + 44px);
  width:40px;height:40px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:rgba(20,8,4,.72);border:1px solid rgba(255,190,120,.85);border-radius:4px;color:#fff1de;touch-action:manipulation;
  box-shadow:0 0 12px rgba(196,58,26,.45)}
.ec-fs:hover,.ec-fs:focus-visible{background:rgba(140,30,12,.8);outline:none}
.ec-fs svg,.ec-fsm svg{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:square}
.ec-fs .x,.ec-fsm .x{display:none}.ec-fs.on .o,.ec-fsm.on .o{display:none}.ec-fs.on .x,.ec-fsm.on .x{display:inline}
.ec-fsm{pointer-events:auto;min-height:52px;margin:6px;padding:12px 20px;display:inline-flex;align-items:center;gap:10px;
  font:inherit;font-size:14px;letter-spacing:.24em;color:#ffe6c8;background:rgba(20,8,4,.55);border:1px solid rgba(255,200,150,.55);
  cursor:pointer;touch-action:manipulation}
.ec-fsm:hover,.ec-fsm:focus-visible{background:rgba(170,40,16,.6);outline:none}
.ec-fs-tip{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;background:rgba(8,2,1,.7);padding:16px}
.ec-fs-tip.show{display:flex}
.ec-fs-tip div{max-width:min(420px,90vw);padding:16px 18px;background:#1a0a05;border:1px solid rgba(255,190,120,.75);border-radius:4px;
  color:#fff1de;font:15px/1.5 system-ui,sans-serif;text-align:center}
.ec-fs-tip b{color:#ffb04a}.ec-fs-tip small{display:block;margin-top:10px;opacity:.7;font-size:12px;letter-spacing:.12em}
`;
const ICON = '<svg viewBox="0 0 24 24"><path class="o" d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>'
  + '<path class="x" d="M9 3v6H3M21 9h-6V3M15 21v-6h6M3 15h6v6"/></svg>';

export class Fullscreen {
  static id = 'fullscreen';
  init({ host = document.body, el = document.documentElement, visible = true } = {}) {
    this.target = el; this.host = host; this.visible = visible;
    this.supported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    const ua = navigator.userAgent || '';
    this.ios = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    this.standalone = !!(navigator.standalone || (window.matchMedia && (matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: standalone)').matches)));
    this.mode = this.standalone ? 'standalone' : this.supported ? 'api' : this.ios ? 'ios-tip' : 'none';
    this.usable = visible && (this.mode === 'api' || this.mode === 'ios-tip');
    this.requests = 0; this._menuShown = false;
    this._style = document.createElement('style'); this._style.textContent = CSS; document.head.appendChild(this._style);
    this._stop = (e) => { e.stopPropagation(); };
    this._onClick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(); e.currentTarget.blur(); };
    const b = this.button = this._make('ec-fs', ICON);
    b.dataset.ec = 'fullscreen'; b.title = 'Full screen (F)';
    host.appendChild(b);
    this.menuButton = null;
    const tip = this.tip = document.createElement('div');
    tip.className = 'ec-fs-tip'; tip.dataset.ec = 'fullscreen-tip';
    tip.innerHTML = '<div>Safari on iPhone does not let web pages go full screen.<br><br>Tap <b>Share</b>, then <b>Add to Home Screen</b>, '
      + 'and open Ember Court from your home screen to play full screen. Turn the phone sideways for the best view.<small>TAP TO CLOSE</small></div>';
    this._onTip = (e) => { e.preventDefault(); e.stopPropagation(); tip.classList.remove('show'); };
    tip.addEventListener('pointerdown', this._stop); tip.addEventListener('click', this._onTip);
    host.appendChild(tip);
    this._onKey = (e) => { if (e.code === 'KeyF' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); this.toggle(); } };
    window.addEventListener('keydown', this._onKey);
    this._onChange = () => { for (const x of [this.button, this.menuButton]) if (x) { x.classList.toggle('on', this.active); x.setAttribute('aria-pressed', String(this.active)); } this._sync(); };
    document.addEventListener('fullscreenchange', this._onChange); document.addEventListener('webkitfullscreenchange', this._onChange);
    this._sync();
    return this;
  }

  _make(cls, html) {
    const b = document.createElement('button');
    b.className = cls; b.type = 'button'; b.innerHTML = html; b.setAttribute('aria-label', 'Toggle full screen');
    // stop the press here so it never reaches the canvas (pointer lock / attack) or the touch look zone
    b.addEventListener('pointerdown', this._stop); b.addEventListener('mousedown', this._stop); b.addEventListener('click', this._onClick);
    return b;
  }

  // Place the labelled "FULL SCREEN" button into a container (the HUD title slot beside BEGIN).
  mountMenu(container) {
    if (!container || this.menuButton) return;
    const m = this.menuButton = this._make('ec-fsm', ICON + '<span>FULL SCREEN</span>');
    m.dataset.ec = 'fullscreen-menu';
    container.appendChild(m); this._sync();
  }

  // true while the title screen shows: the labelled button carries the toggle and the corner icon steps aside.
  setMenu(on) { this._menuShown = !!on; if (!on) this.tip.classList.remove('show'); this._sync(); }

  _sync() {
    const menu = this._menuShown && !!this.menuButton;
    this.button.style.display = this.usable && !menu ? '' : 'none';
    if (this.menuButton) {
      this.menuButton.style.display = this.usable ? '' : 'none';
      const t = this.active ? 'EXIT FULL SCREEN' : 'FULL SCREEN'; const s = this.menuButton.querySelector('span');
      if (s.textContent !== t) s.textContent = t;
    }
  }

  get active() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

  // Call from inside a user gesture. Resolves quietly when refused (no gesture, iframe without allow, etc).
  request() {
    if (!this.supported || this.active) return;
    this.requests++;
    const el = this.target;
    try {
      const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen && el.webkitRequestFullscreen();
      if (r && r.catch) r.catch(() => {});
      // landscape lock is only allowed while fullscreen and only on some phones; failure is expected elsewhere
      if (r && r.then && screen.orientation && screen.orientation.lock && matchMedia('(pointer: coarse)').matches) r.then(() => screen.orientation.lock('landscape').catch(() => {}), () => {});
    } catch (_) { /* refused */ }
  }

  exit() {
    if (!this.active) return;
    const r = document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen && document.webkitExitFullscreen();
    if (r && r.catch) r.catch(() => {});
  }

  toggle() {
    if (this.mode === 'ios-tip') { this.tip.classList.toggle('show'); return; }
    if (this.active) this.exit(); else this.request();
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    document.removeEventListener('fullscreenchange', this._onChange); document.removeEventListener('webkitfullscreenchange', this._onChange);
    for (const b of [this.button, this.menuButton]) if (b) {
      b.removeEventListener('pointerdown', this._stop); b.removeEventListener('mousedown', this._stop); b.removeEventListener('click', this._onClick); b.remove();
    }
    this.tip.removeEventListener('pointerdown', this._stop); this.tip.removeEventListener('click', this._onTip);
    this.tip.remove(); this._style.remove();
  }
}
