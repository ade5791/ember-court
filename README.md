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
- Great sword: when the wyvern lands, a great sword is planted in the ford beside it. Walk into it to take it -
  longer reach and heavier hits for a little more stamina.
- Lock on: middle click, Tab or R. Pause: Esc or P.
- Gamepad is supported; touch controls appear automatically on phones and tablets.

URL options: `?q=low|medium|high` quality preset, `?seed=N` for a reproducible run.
`?stage3=1` (preview): after the wyvern falls, a door opens into Stage 3, the Frozen Foundry, against the Chrome
Gauntlet - just-guard its swings, dodge the red lightning columns, and get clear of the dome discharge.
`?stage3=1&start=stage3` jumps straight to that fight.

## Credits

- Engine: Three.js (MIT), see `vendor/three/LICENSE`.
- Boss models (Ford Wyvern, Chrome Gauntlet): CC BY 4.0, see `ATTRIBUTION.md`.
- Hero and duelist models were generated and rigged for this project.

This repository contains the runtime build only.
