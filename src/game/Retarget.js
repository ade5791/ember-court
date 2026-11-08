// Retarget - same-topology rest-delta retarget (presentation only, owner: game). No per-frame work.
// Both rigs share the 24-bone Meshy skeleton (same names, same parent chain) but their rest/bind rotations differ
// (mesh-fit: up to ~30 deg at the feet). A clip authored on rig A is moved to rig B so that every bone turns away
// from ITS OWN rest by the same world-space rotation it did on A:
//   Wb(x) = Da(x) * restWb(x),  Da(x) = Wa(x) * inv(restWa(x))
// which reduces to a purely local per-key rule (no FK, so partial / layered clips work too):
//   Lb(x) = M(parent) * La(x) * inv(M(x)),   M(x) = inv(restWb(x)) * restWa(x),   M(root parent) = identity.
// Hips.position is scaled by the hip-height ratio so the feet stay on the floor.
// Build the retargeter while both skeletons are still at rest (before any mixer touches them).
import * as THREE from 'three';

function restWorld(root) {
  const local = {}, parent = {}, world = {}, hips = { y: 0 };
  root.traverse((o) => {
    if (!o.isBone) return;
    local[o.name] = o.quaternion.clone(); parent[o.name] = o.parent && o.parent.isBone ? o.parent.name : null;
    if (o.name === 'Hips') hips.y = o.position.length();
  });
  const get = (n) => {
    if (world[n]) return world[n];
    const p = parent[n]; const w = p ? get(p).clone().multiply(local[n]) : local[n].clone();
    return (world[n] = w);
  };
  for (const n in local) get(n);
  return { local, parent, world, hipY: hips.y };
}

export function makeRetargeter(srcRoot, dstRoot) {
  const A = restWorld(srcRoot), B = restWorld(dstRoot);
  const M = {}, missing = [];
  for (const n in A.world) {
    if (!B.world[n]) { missing.push(n); continue; }
    if (A.parent[n] !== B.parent[n]) throw new Error('retarget: parent mismatch at ' + n);
    M[n] = B.world[n].clone().invert().multiply(A.world[n]);
  }
  if (missing.length) throw new Error('retarget: bones missing on target: ' + missing.join(','));
  const hk = B.hipY / (A.hipY || 1);
  let maxDeg = 0; for (const n in M) maxDeg = Math.max(maxDeg, 2 * Math.acos(Math.min(1, Math.abs(M[n].w))) * 180 / Math.PI);
  const report = { bones: Object.keys(M).length, tracks: 0, hipK: +hk.toFixed(4), maxRestDeltaDeg: +maxDeg.toFixed(1) };
  const ident = new THREE.Quaternion(), mp = new THREE.Quaternion(), mi = new THREE.Quaternion(), q = new THREE.Quaternion();
  function clip(c) {
    const nt = c.tracks.map((t) => {
      const dot = t.name.lastIndexOf('.'), bone = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
      if (!M[bone]) return t;
      if (prop === 'position' && bone === 'Hips') {
        const v = Float32Array.from(t.values); for (let i = 0; i < v.length; i++) v[i] *= hk;
        return new THREE.VectorKeyframeTrack(t.name, t.times, v);
      }
      if (prop !== 'quaternion') return t;
      const p = B.parent[bone]; mp.copy(p ? M[p] : ident); mi.copy(M[bone]).invert();
      const v = Float32Array.from(t.values);
      for (let i = 0; i < v.length; i += 4) {
        q.set(v[i], v[i + 1], v[i + 2], v[i + 3]); q.premultiply(mp).multiply(mi); q.normalize();
        v[i] = q.x; v[i + 1] = q.y; v[i + 2] = q.z; v[i + 3] = q.w;
      }
      report.tracks++;
      return new THREE.QuaternionKeyframeTrack(t.name, t.times, v);
    });
    const out = new THREE.AnimationClip(c.name, c.duration, nt); out.userData = c.userData; return out;
  }
  // hand-socket transform for the target rig: same world blade pose as the source socket under the same motion
  function socket(s, bone = 'RightHand') {
    const m = M[bone];
    const p = new THREE.Vector3().fromArray(s.position).applyQuaternion(m);
    const r = m.clone().multiply(new THREE.Quaternion().fromArray(s.quaternion));
    return { position: p.toArray(), quaternion: [r.x, r.y, r.z, r.w], scale: s.scale };
  }
  return { clips: (cs) => cs.map(clip), socket, M, report };
}
