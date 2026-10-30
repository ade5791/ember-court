// Guarded quickstep timing from the MotionBricks bake (motion/mb/hero.combat.json, NVIDIA MotionBricks via the
// target-pose-motion-generation skill). Pure data -> pure numbers, shared by the sim (HeroSim travel curve) and the
// presentation (clip time for a sim frame), so both are driven by the same root curve and the feet stay planted.
//
// Per clip: s/t = first/last frame with root speed above 10% of peak (the step itself); profile = cumulative
// fraction of the step distance sampled uniformly over the sim travel window (length n). The sim frames
// [travelF0 .. travelF0+n-1] map linearly onto clip frames [s .. t]; before/after map onto the clip lead-in/out.
export const QUICKSTEP_CLIPS = ['dodge_F', 'dodge_B', 'dodge_L', 'dodge_R'];

export function buildQuickstep(bake, n) {
  const out = { n, clips: {} };
  for (const name of QUICKSTEP_CLIPS) {
    const c = bake && bake.clips && bake.clips[name];
    if (!c || !c.rootXZ || c.rootXZ.length < 4) continue;
    const r = c.rootXZ, F = r.length, e = r[F - 1], L = Math.hypot(e[0], e[1]);
    if (!(L > 0.1)) continue;
    const ux = e[0] / L, uz = e[1] / L;
    const dist = new Float64Array(F);
    for (let i = 0; i < F; i++) dist[i] = (r[i][0] * ux + r[i][1] * uz) / L;
    let pk = 0; for (let i = 0; i < F - 1; i++) pk = Math.max(pk, dist[i + 1] - dist[i]);
    let s = 0, t = F - 1;
    for (let i = 0; i < F - 1; i++) if (dist[i + 1] - dist[i] > 0.1 * pk) { s = i; break; }
    for (let i = F - 2; i >= 0; i--) if (dist[i + 1] - dist[i] > 0.1 * pk) { t = i + 1; break; }
    const d0 = dist[s], d1 = dist[t], profile = new Array(n);
    for (let j = 0; j < n; j++) {
      const x = s + (t - s) * (j + 1) / n, i = Math.min(F - 2, Math.floor(x)), u = x - i;
      const d = dist[i] + (dist[i + 1] - dist[i]) * u;
      profile[j] = j === n - 1 ? 1 : Math.max(0, Math.min(1, (d - d0) / (d1 - d0)));
    }
    for (let j = 1; j < n; j++) if (profile[j] < profile[j - 1]) profile[j] = profile[j - 1];   // monotone
    out.clips[name] = { profile, s, t, F, fps: c.fps || 60, warp: (t - s) / n };
  }
  return out;
}

// Clip time (seconds) for sim dodge frame d, given travel window [a, b] and dodge total T.
export function quickstepClipTime(info, d, a, b, T) {
  let f;
  if (d <= a) f = info.s * (d / Math.max(1, a));
  else if (d <= b) f = info.s + (info.t - info.s) * (d - a) / (b - a + 1);
  else f = info.t + (info.F - 1 - info.t) * Math.min(1, (d - b) / Math.max(1, T - b));
  return Math.min(info.F - 1, Math.max(0, f)) / info.fps;
}
