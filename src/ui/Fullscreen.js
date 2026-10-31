// Fullscreen - corner toggle button, F key, and auto-enter on BEGIN (owner: ui). DOM only, no THREE.
// Fullscreen can only be requested inside a user gesture, so request() must be called from a click/tap/key
// handler. Unsupported browsers (iPhone Safari has no element fullscreen) get no button and request() is a no-op.
const CSS = `
.ec-fs{position:fixed;z-index:30;left:calc(env(safe-area-inset-left,0px) + 18px);top:calc(env(safe-area-inset-top,0px) + 44px);
  width:36px;height:36px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:rgba(20,8,4,.55);border:1px solid rgba(255,214,170,.45);border-radius:4px;color:#ffe6c8;touch-action:manipulation}
.ec-fs:hover,.ec-fs:focus-visible{background:rgba(120,24,10,.7);outline:none}
.ec-fs svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:square}
.ec-fs .x{display:none}.ec-fs.on .o{display:none}.ec-fs.on .x{display:inline}
`;
const ICON = '<svg viewBox="0 0 24 24"><path class="o" d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>'
  + '<path class="x" d="M9 3v6H3M21 9h-6V3M15 21v-6h6M3 15h6v6"/></svg>';

export class Fullscreen {
  static id = 'fullscreen';
  init({ host = document.body, el = document.documentElement, visible = true } = {}) {
    this.target = el;
    this.supported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    this.requests = 0;
    this._style = document.createElement('style'); this._style.textContent = CSS; document.head.appendChild(this._style);
    const b = this.button = document.createElement('button');
    b.className = 'ec-fs'; b.type = 'button'; b.dataset.ec = 'fullscreen'; b.innerHTML = ICON;
    b.setAttribute('aria-label', 'Toggle full screen'); b.title = 'Full screen (F)';
    b.style.display = this.supported && visible ? '' : 'none';
    // stop the press here so it never reaches the canvas (pointer lock / attack) or the touch look zone
    this._stop = (e) => { e.stopPropagation(); };
    this._onClick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(); b.blur(); };
    b.addEventListener('pointerdown', this._stop); b.addEventListener('mousedown', this._stop); b.addEventListener('click', this._onClick);
    this._onKey = (e) => { if (e.code === 'KeyF' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); this.toggle(); } };
    window.addEventListener('keydown', this._onKey);
    this._onChange = () => { b.classList.toggle('on', this.active); b.setAttribute('aria-pressed', String(this.active)); };
    document.addEventListener('fullscreenchange', this._onChange); document.addEventListener('webkitfullscreenchange', this._onChange);
    host.appendChild(b);
    return this;
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

  toggle() { if (this.active) this.exit(); else this.request(); }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    document.removeEventListener('fullscreenchange', this._onChange); document.removeEventListener('webkitfullscreenchange', this._onChange);
    this.button.removeEventListener('pointerdown', this._stop); this.button.removeEventListener('mousedown', this._stop); this.button.removeEventListener('click', this._onClick);
    this.button.remove(); this._style.remove();
  }
}
