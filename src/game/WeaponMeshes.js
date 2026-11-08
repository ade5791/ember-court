// v2.25 generated weapon meshes. Each GLB is a single textured mesh, blade along +Y from y=0 at the pommel end.
// fitWeapon() maps it into a weapon socket (metres, blade along +Y, hand at the origin) using the manifest anchors so
// the visible tip lands exactly where the sim's REACH puts the procedural tip. The procedural parts stay as the
// fallback (?meshwpn=0) and the tip / hilt Object3Ds are moved to the fitted mesh, so trails, tip guard and grip IK
// keep reading the same handles. No per-frame allocation; all work happens once at load.
import * as THREE from 'three';

export async function loadWeaponMeshes(loader, root) {
  const man = await fetch(root + 'assets/weapons/weapons.json').then((r) => r.json());
  const ids = Object.keys(man.weapons);
  const gltfs = await Promise.all(ids.map((id) => loader.loadAsync(root + 'assets/weapons/' + man.weapons[id].file).catch((e) => {
    console.warn('[wpn] load failed', id, e && e.message); return null;
  })));
  const out = {};
  ids.forEach((id, i) => {
    const g = gltfs[i]; if (!g) return;
    let mesh = null;
    g.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) return;
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    // tip = highest vertex (curved blades put it off-axis)
    const P = mesh.geometry.attributes.position; let ti = 0;
    for (let k = 1; k < P.count; k++) if (P.getY(k) > P.getY(ti)) ti = k;
    const m = mesh.material;
    if (m) {
      m.side = THREE.FrontSide; if (m.map) m.map.anisotropy = 4; m.envMapIntensity = 1;
      // fal Hi3D bakes metal=1 everywhere with dark albedo; under the dusk rig a fully metallic dark surface reads
      // as a black void. Leave the metal/rough map in charge of where metal is, but cap it so grip / guard / inlay
      // keep a diffuse term, and lift the albedo floor slightly.
      m.metalness = 0.75; m.roughness = 1; m.color.setScalar(1.25);
      if (man.weapons[id].vcol) { m.map = null; m.vertexColors = true; m.metalness = 0.55; m.color.setScalar(1); }
      m.needsUpdate = true;
    }
    out[id] = { spec: man.weapons[id], geo: mesh.geometry, mat: m, h: bb.max.y - bb.min.y, y0: bb.min.y,
      tip: new THREE.Vector3(P.getX(ti), P.getY(ti), P.getZ(ti)) };
  });
  return out;
}

// Build a fitted mesh for one weapon. Returns { mesh, tipY, tipX, scale } in socket space.
export function fitWeapon(W, matOverride) {
  const s = W.spec;
  let scale, offY;
  if (s.fit === 'ends') {
    scale = (s.topY - s.bottomY) / W.h; offY = s.bottomY - W.y0 * scale;
  } else {
    const guardH = W.y0 + s.guardFrac * W.h;              // mesh-space guard height
    scale = (s.tipY - s.guardY) / (W.y0 + W.h - guardH);   // blade above guard -> sim reach
    offY = s.guardY - guardH * scale;
  }
  const mesh = new THREE.Mesh(W.geo, matOverride || W.mat);
  mesh.scale.setScalar(scale); mesh.position.y = offY;
  mesh.castShadow = true; mesh.receiveShadow = false;
  return { mesh, scale, tipX: W.tip.x * scale, tipY: W.tip.y * scale + offY, tipZ: W.tip.z * scale };
}

// Replace a procedural rig's visible parts with the fitted mesh. rig = { socket, tip, ... } from addSword & co.
// Hides every existing Mesh child of the socket (procedural geometry) and adds the generated mesh.
export function dressRig(rig, W, matOverride) {
  for (const c of rig.socket.children) if (c.isMesh || (c.isGroup && c !== rig.meshHolder)) c.visible = false;
  const f = fitWeapon(W, matOverride);
  rig.socket.add(f.mesh);
  rig.tip.position.set(f.tipX, f.tipY, f.tipZ);
  rig.genMesh = f.mesh;
  return f;
}
