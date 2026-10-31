// TimeWarp - C1 attack clip-time mapping. Presentation only (the sim's phase frames are untouched).
// attack-timing.json maps each sim phase (startup / active / recovery) to a clip frame range. Mapping each phase
// linearly makes the clip playback RATE jump at every phase boundary (e.g. 1.2x -> 0.8x at contact) and stop dead
// when recovery reaches its last played frame - visible as a velocity kink in every limb. Here the same knots
// (phase start/end in sim frames -> clip frames) are joined by a monotone cubic Hermite: every knot is hit exactly
// (contact lands on the same clip frame at the same sim frame), the rate is continuous, never negative, and eases
// to zero into a held tail instead of freezing.
export function buildWarp(phases) {
  const kx = [0], ky = [phases[0].clipF[0]];
  let f = 0;
  for (const p of phases) {
    const played = p.playedF || p.specF;
    kx.push(f + played); ky.push(p.clipF[1]);
    if (played < p.specF) { kx.push(f + p.specF); ky.push(p.clipF[1]); }
    f += p.specF;
  }
  // drop zero-length segments
  const X = [], Y = [];
  for (let i = 0; i < kx.length; i++) if (!X.length || kx[i] > X[X.length - 1] + 1e-6) { X.push(kx[i]); Y.push(ky[i]); } else Y[Y.length - 1] = ky[i];
  const n = X.length, d = new Float64Array(n - 1), m = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (Y[i + 1] - Y[i]) / (X[i + 1] - X[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2] > 0 && n > 2 && d[n - 2] !== 0 ? d[n - 2] : 0;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  // Fritsch-Carlson limiter keeps the curve monotone (clip never runs backwards)
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const total = f;
  return {
    total,
    // f: fractional sim frame since action start -> clip time in seconds (clip frames are 60 fps units)
    clipTime(fr) {
      const x = Math.max(0, Math.min(X[n - 1], fr));
      let i = 0; while (i < n - 2 && x > X[i + 1]) i++;
      const h = X[i + 1] - X[i], u = (x - X[i]) / h, u2 = u * u, u3 = u2 * u;
      const y = (2 * u3 - 3 * u2 + 1) * Y[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * Y[i + 1] + (u3 - u2) * h * m[i + 1];
      return y / 60;
    },
  };
}
