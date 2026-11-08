# Ember Court - The Crimson Ford

A third-person sword duel in a red maple river gorge, running in the browser on Three.js (r180, WebGL2).
Fight two waves of duelists, then face the Ford Wyvern.

Play: https://ade5791.github.io/ember-court/

## Controls

- Move: WASD or arrows (hold Shift to walk). Camera: mouse.
- Light attack: left click or J. Heavy: right click or K.
- Guard / deflect: Q or L. Time it on contact for a perfect deflect.
- Phantom dodge: Space. Red and blue attacks cannot be blocked - dodge them.
- Roll: C (gamepad B, or the Roll button on touch). Always rolls clear, even right next to an enemy.
- Snatch: E or I (gamepad d-pad right) pulls an enemy 3-11 m away into your combo.
- Ember Trigger: V or U (gamepad L3 / d-pad left). Press again while it burns to unleash Ember Rift.
- Great-sword sweep: G or O (gamepad d-pad down). Press again to chain the reverse sweep.
- Great sword: when the wyvern lands, a great sword is planted in the ford beside it. Walk into it to take it -
  longer reach and heavier two-handed hits for a little more stamina.
- Lock on: middle click, Tab or R. Pause: Esc or P. Full screen: F.
- Gamepad is supported; touch controls appear automatically on phones and tablets.

## Heroes and combat

- Pick your hero on the title screen (or `?char=hero|vesper|kael`): the Duelist, Vesper with the Cinder Sabre
  (quick, turning strings) or Kael with the Astral Glaive (longest reach, heavy posture damage).
- One-handed blades fight like a dance: every strike is a real step, and a string chains up to 10 light / heavy
  presses with a different move on each press. Mix light and heavy to change the route.
- Two-handed weapons (great sword, Wyvern Fang, Dusk Odachi, Frostbrand) hit harder but cannot dodge or roll.
- Hit-stop and slow motion are off by default; `?hitstop=1` turns them back on.

URL options: `?q=low|medium|high` quality preset, `?seed=N` for a reproducible run.
`?stage3=1` (preview campaign): after the wyvern falls it drops a weapon and a door opens onto the mountain road.
Fight through its ambushes to the Shadow Warden at the Dusk Shrine, walk the next leg, then face the Chrome
Gauntlet in the Frozen Foundry. `?road=0` skips the road legs; `?stage3=1&start=stage3` jumps to the last fight.

## Credits

- Engine: Three.js (MIT), see `vendor/three/LICENSE`.
- Boss models (Ford Wyvern, Chrome Gauntlet) and the mountain road kit: CC BY 4.0, see `ATTRIBUTION.md`.
- Hero and duelist models were generated and rigged for this project.

This repository contains the runtime build only.
