// ClipSmooth - load-time cubic resample of sparse (30 Hz, LINEAR) animation tracks to 60 Hz. Presentation only.
// Linear interpolation between 30 Hz keys displayed at 60 fps moves every limb in straight segments whose velocity
// jumps at each key - the "mechanical" look. We rebuild each track with a shape-preserving cubic Hermite
// (Fritsch-Carlson style: tangent 0 where the key is a local extreme or a hold), so:
//   - every authored key is still hit exactly (contact poses, extremes and holds are unchanged),
//   - no overshoot past an authored extreme (impact peaks stay crisp, holds stay held),
//   - velocity is continuous through each key.
// Quaternions are made hemisphere-continuous first, interpolated per component and renormalised (inter-key angles
// at 30 Hz are small, so this matches squad within display precision). Loop clips use wrapped tangents at the seam.
// Tracks already at or above the target rate, step tracks and tracks with < 3 keys are left untouched.
import * as THREE from 'three';

function tangents(T, V, stride, n, wrap) {
  const M = new Float32Array(V.length);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < stride; c++) {
      let i0 = i - 1, i1 = i + 1, t0, t1;
      if (i0 < 0) { if (!wrap) { M[i * stride + c] = i1 < n ? (V[i1 * stride + c] - V[i * stride + c]) / (T[i1] - T[i]) : 0; continue; } i0 = n - 2; t0 = T[i] - (T[n - 1] - T[n - 2]); }
      else t0 = T[i0];
      if (i1 >= n) { if (!wrap) { M[i * stride + c] = (V[i * stride + c] - V[i0 * stride + c]) / (T[i] - T[i0]); continue; } i1 = 1; t1 = T[i] + (T[1] - T[0]); }
      else t1 = T[i1];
      const p = V[i * stride + c], d0 = (p - V[i0 * stride + c]) / Math.max(1e-6, T[i] - t0), d1 = (V[i1 * stride + c] - p) / Math.max(1e-6, t1 - T[i]);
      // local extreme or hold -> flat tangent (no overshoot); otherwise harmonic-mean slope (monotone-preserving)
      M[i * stride + c] = d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
    }
  }
  return M;
}

function resampleTrack(track, rate, quat, wrap) {
  const T = track.times, n = T.length, stride = track.getValueSize();
  if (n < 3 || track.getInterpolation() === THREE.InterpolateDiscrete) return track;
  const span = T[n - 1] - T[0];
  if (span <= 0 || span / (n - 1) <= 1.01 / rate) return track;
  const V = Float32Array.from(track.values);
  if (quat) for (let i = 1; i < n; i++) {
    const a = (i - 1) * 4, b = i * 4;
    if (V[a] * V[b] + V[a + 1] * V[b + 1] + V[a + 2] * V[b + 2] + V[a + 3] * V[b + 3] < 0) for (let c = 0; c < 4; c++) V[b + c] = -V[b + c];
  }
  // wrapped tangents only when the loop actually closes (first key == last key)
  let closes = wrap;
  if (closes) for (let c = 0; c < stride; c++) if (Math.abs(V[c] - V[(n - 1) * stride + c]) > 1e-3) { closes = false; break; }
  const M = tangents(T, V, stride, n, closes);
  const steps = Math.round(span * rate), outT = new Float32Array(steps + 1), outV = new Float32Array((steps + 1) * stride);
  let seg = 0;
  for (let s = 0; s <= steps; s++) {
    const t = s === steps ? T[n - 1] : T[0] + s / rate;
    while (seg < n - 2 && t > T[seg + 1]) seg++;
    const h = T[seg + 1] - T[seg], u = Math.max(0, Math.min(1, (t - T[seg]) / h)), u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    outT[s] = t;
    for (let c = 0; c < stride; c++) {
      const a = seg * stride + c, b = (seg + 1) * stride + c;
      outV[s * stride + c] = h00 * V[a] + h10 * h * M[a] + h01 * V[b] + h11 * h * M[b];
    }
    if (quat) {
      const o = s * 4, l = Math.hypot(outV[o], outV[o + 1], outV[o + 2], outV[o + 3]) || 1;
      outV[o] /= l; outV[o + 1] /= l; outV[o + 2] /= l; outV[o + 3] /= l;
    }
  }
  const Ctor = track.constructor;
  return new Ctor(track.name, outT, outV);
}

// Mutates the clips in place (same AnimationClip objects, new tracks). Returns { tracks, resampled } for QA.
export function smoothClips(clips, { rate = 60, loops = new Set() } = {}) {
  let tracks = 0, resampled = 0;
  for (const clip of clips) {
    const wrap = loops.has(clip.name);
    for (let i = 0; i < clip.tracks.length; i++) {
      const t = clip.tracks[i]; tracks++;
      const r = resampleTrack(t, rate, t instanceof THREE.QuaternionKeyframeTrack, wrap);
      if (r !== t) { clip.tracks[i] = r; resampled++; }
    }
  }
  return { tracks, resampled };
}
