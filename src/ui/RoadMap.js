// RoadMap - v2.19 campaign road between bosses (owner: ui). DOM + inline SVG only: no WebGL programs, no lights,
// no per-frame allocation. Driven by the sim's DOOR / GATE states (ROAD frames): an ink-wash scroll unrolls, the
// travelled leg is drawn as a burning ember line from the beaten boss to the next one, the claimed drop is shown
// at the node it came from. Time comes from the caller (sim frames), never performance.now(), so captures hold.
const CSS = `
.ec-road{position:fixed;inset:0;pointer-events:none;z-index:22;display:flex;align-items:center;justify-content:center;
  opacity:0;transition:opacity .45s;font-family:Georgia,'Times New Roman',serif;color:#f4dcc0}
.ec-road.on{opacity:1}
.ec-road .veil{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 55%,rgba(18,8,6,.55),rgba(6,3,3,.92))}
.ec-road .scroll{position:relative;width:min(92vw,980px);aspect-ratio:2.25/1;clip-path:inset(0 calc(50% - var(--u,0) * 50%) 0 calc(50% - var(--u,0) * 50%))}
.ec-road svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ec-road .ttl{position:absolute;left:0;right:0;top:-3.2em;text-align:center;letter-spacing:.42em;font-size:clamp(12px,1.6vw,18px);color:#e9b98a}
.ec-road .sub{position:absolute;left:0;right:0;bottom:-2.6em;text-align:center;letter-spacing:.3em;font-size:clamp(10px,1.2vw,14px);color:#c9a080;opacity:.85}
.ec-road .lbl{font-size:15px;letter-spacing:.18em;fill:#f0d2b0}
.ec-road .lbl.dim{fill:#8a7060}
.ec-road .bss{font-size:11px;letter-spacing:.22em;fill:#d08a5a}
.ec-road .loot{font-size:11px;letter-spacing:.2em;fill:#ffcf8a}
@media (prefers-reduced-motion: reduce){.ec-road{transition:none}}
`;
// node positions in a 900x400 map space; ford (river, lower left) -> shrine (hills, centre) -> foundry (peaks, right)
const NODES = [[195, 290], [455, 165], [770, 255]];
// leg paths (cubic, hand-authored to follow the terrain strokes)
const LEGS = ['M195 290 C 270 300, 320 140, 455 165', 'M455 165 C 560 180, 640 330, 770 255'];
const NS = 'http://www.w3.org/2000/svg';

export class RoadMap {
  static id = 'roadmap';
  init({ host = document.body, route, weaponNames, reducedMotion = false }) {
    this.route = route; this.names = weaponNames; this.rm = reducedMotion; this.on = false; this.leg = -1;
    this._style = document.createElement('style'); this._style.textContent = CSS; document.head.appendChild(this._style);
    const r = this.root = document.createElement('div'); r.className = 'ec-road'; r.dataset.ec = 'roadmap';
    r.innerHTML = '<div class="veil"></div><div class="scroll"><div class="ttl"></div><svg viewBox="0 0 900 400" preserveAspectRatio="xMidYMid meet"></svg><div class="sub"></div></div>';
    this.scroll = r.querySelector('.scroll'); this.ttl = r.querySelector('.ttl'); this.sub = r.querySelector('.sub');
    this.svg = r.querySelector('svg');
    this._build();
    host.appendChild(r);
    return this;
  }

  _el(tag, attrs, parent = this.svg) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    parent.appendChild(e); return e;
  }

  _build() {
    const s = this.svg;
    const defs = this._el('defs', {});
    defs.innerHTML = '<linearGradient id="ecPaper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2418"/><stop offset="1" stop-color="#1c100b"/></linearGradient>'
      + '<filter id="ecGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '<filter id="ecRough"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="6"/></filter>';
    // paper with torn edge
    this._el('rect', { x: 8, y: 8, width: 884, height: 384, rx: 6, fill: 'url(#ecPaper)', stroke: '#6b3d22', 'stroke-width': 2, filter: 'url(#ecRough)' });
    // terrain ink: river under the ford, shrine hills, foundry peaks (strokes only - reads as brush on paper)
    const ink = { fill: 'none', stroke: '#7a4a30', 'stroke-width': 2, 'stroke-linecap': 'round', opacity: 0.8, filter: 'url(#ecRough)' };
    this._el('path', { ...ink, d: 'M30 340 C 110 320, 150 350, 230 330 S 330 360, 380 345', stroke: '#4f6a78', 'stroke-width': 5, opacity: 0.6 });
    this._el('path', { ...ink, d: 'M40 360 C 120 345, 170 372, 250 355', stroke: '#4f6a78', 'stroke-width': 2, opacity: 0.45 });
    this._el('path', { ...ink, d: 'M330 205 Q 390 120 450 200 Q 500 130 560 205' });
    this._el('path', { ...ink, d: 'M300 230 Q 350 180 400 228', opacity: 0.5 });
    this._el('path', { ...ink, d: 'M640 300 L 700 170 L 735 230 L 790 120 L 850 290', stroke: '#8aa0b8', opacity: 0.6 });
    this._el('path', { ...ink, d: 'M778 140 L 790 120 L 803 146', stroke: '#dfe8f2', 'stroke-width': 2.5, opacity: 0.7 });
    // maple sprigs along the ford
    for (let i = 0; i < 7; i++) this._el('circle', { cx: 60 + i * 38, cy: 250 + ((i * 37) % 40), r: 3 + (i % 3), fill: '#a8231c', opacity: 0.55 });
    // dashed future road
    for (const d of LEGS) this._el('path', { d, fill: 'none', stroke: '#6b4a38', 'stroke-width': 3, 'stroke-dasharray': '2 9', 'stroke-linecap': 'round' });
    // travelled ember lines (dash-offset animated per leg)
    this.trail = LEGS.map((d) => this._el('path', { d, fill: 'none', stroke: '#ff7a30', 'stroke-width': 4, 'stroke-linecap': 'round', filter: 'url(#ecGlow)' }));
    for (const p of this.trail) { const L = p.getTotalLength ? p.getTotalLength() : 420; p._len = L; p.setAttribute('stroke-dasharray', L + ' ' + L); p.setAttribute('stroke-dashoffset', L); }
    // walker ember on the active leg
    this.walker = this._el('circle', { r: 7, fill: '#ffd08a', filter: 'url(#ecGlow)', opacity: 0 });
    // nodes
    this.nodes = NODES.map(([x, y], i) => {
      const g = this._el('g', { transform: 'translate(' + x + ' ' + y + ')' });
      const ring = this._el('circle', { r: 17, fill: '#1a0d08', stroke: '#c9883a', 'stroke-width': 2.5 }, g);
      const core = this._el('circle', { r: 7, fill: '#5a3a28' }, g);
      const cross = this._el('path', { d: 'M-9 -9 L 9 9 M 9 -9 L -9 9', stroke: '#e0301e', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0 }, g);
      const lbl = this._el('text', { class: 'lbl', y: -30, 'text-anchor': 'middle' }, g); lbl.textContent = this.route[i].place;
      const bss = this._el('text', { class: 'bss', y: 38, 'text-anchor': 'middle' }, g); bss.textContent = this.route[i].boss;
      const loot = this._el('text', { class: 'loot', y: 56, 'text-anchor': 'middle', opacity: 0 }, g);
      return { g, ring, core, cross, lbl, bss, loot };
    });
  }

  // Show the leg from route[leg] to route[leg + 1]. claimed: weapon ids taken so far (sim.claimed).
  show(leg, claimed) {
    this.leg = leg; this.on = true; this.root.style.transition = ''; this.root.style.opacity = ''; this.root.classList.add('on');
    const next = this.route[leg + 1];
    this.ttl.textContent = 'THE ROAD TO ' + (next ? next.place : 'THE END');
    const w = claimed && claimed.length ? claimed[claimed.length - 1] : 0;
    this.sub.textContent = w ? 'CARRYING  ' + this.names[w] : '';
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i], beaten = i <= leg, isNext = i === leg + 1;
      n.cross.setAttribute('opacity', beaten ? 0.9 : 0);
      n.core.setAttribute('fill', beaten ? '#3a1a12' : isNext ? '#ff7a30' : '#5a3a28');
      n.ring.setAttribute('stroke', isNext ? '#ffb060' : beaten ? '#7a4a30' : '#c9883a');
      n.lbl.setAttribute('class', 'lbl' + (beaten ? ' dim' : ''));
      const got = claimed && claimed[i];
      n.loot.textContent = got ? '+ ' + this.names[got] : ''; n.loot.setAttribute('opacity', got ? 1 : 0);
    }
    for (let i = 0; i < this.trail.length; i++) {
      const p = this.trail[i]; p.setAttribute('stroke-dashoffset', i < leg ? 0 : p._len);
    }
    this.update(0);
  }

  // t in 0..1 across the ROAD state: unroll (0-0.18), walk the leg (0.2-0.85), hold, fade (0.92-1)
  update(t) {
    if (!this.on) return;
    const u = this.rm ? 1 : Math.min(1, t / 0.18);
    this.scroll.style.setProperty('--u', u.toFixed(3));
    const p = this.trail[this.leg];
    if (p) {
      const k = this.rm ? (t > 0.2 ? 1 : 0) : Math.max(0, Math.min(1, (t - 0.2) / 0.65));
      const e = k * k * (3 - 2 * k);
      p.setAttribute('stroke-dashoffset', (p._len * (1 - e)).toFixed(1));
      if (p.getPointAtLength) {
        const q = p.getPointAtLength(p._len * e);
        this.walker.setAttribute('cx', q.x.toFixed(1)); this.walker.setAttribute('cy', q.y.toFixed(1));
        this.walker.setAttribute('opacity', k > 0 && k < 1 ? 1 : 0);
      }
      const nx = this.nodes[this.leg + 1];
      if (nx) { const pulse = this.rm ? 9 : 7 + 3 * Math.abs(Math.sin(t * 18)); nx.core.setAttribute('r', (k >= 1 ? pulse : 7).toFixed(2)); }
    }
    this.root.style.opacity = t > 0.92 ? Math.max(0, (1 - t) / 0.08).toFixed(3) : '';
  }

  hide() { if (!this.on) return; this.on = false; this.leg = -1; this.root.style.transition = 'none'; this.root.classList.remove('on'); this.root.style.opacity = '0'; }

  dispose() { this.disposed = true; this.root.remove(); this._style.remove(); this.trail = this.nodes = null; }
}
