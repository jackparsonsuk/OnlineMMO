# CLAUDE.md

Ostracon: a browser MMO on Babylon.js (client) and Colyseus 0.18 (server), in an
npm-workspaces monorepo. **README.md is the design record** — it explains why
things are the way they are. Read the relevant section before changing a
system, and update it when a design decision changes.

## Commands

```bash
npm install
npm run dev          # builds shared, then shared --watch + server + client
npm run typecheck    # all three packages; this is the gate — there are no tests
npm run build        # production build (server serves client/dist itself)
```

- Client: http://localhost:5173 (Vite). Server: ws/http on :2567.
- `.claude/launch.json` has `server` and `client` entries for the preview tools.
- Don't test against http://localhost:2567 in a browser during development: the
  server serves whatever stale `packages/client/dist` exists.

## Layout

```
packages/shared/   one copy of everything both sides must agree on
  movement.ts        applyInput / moveBody / collision — the shared sim
  noise.ts           deterministic hashing + gradient noise
  terrain.ts         heightAt (pure function of TerrainSettings)
  worldgen.ts        roads, woodland, rocks, camps, SceneryIndex, unsafeSpawns
  ostras.ts          the Ostra table (Terra = 8000 m, generated wilds)
  combat.ts spells.ts enemies.ts items.ts settlements.ts schema.ts constants.ts
packages/server/
  rooms/OstraRoom.ts one room per Ostra: sim loop, camps, casts, loot, gates
  ai/enemyAI.ts      creature state machine, windups, threat, knockback
  auth.ts, store/    accounts (JWT + scrypt), SQLite persistence
packages/client/src/
  session.ts         per-room glue: prediction, input, rigs, combat events
  terrain.ts         chunk streamer + horizon mesh + groundTone
  scenery.ts         thin-instanced trees/rocks/grass per chunk
  rigs.ts            procedural animated bodies (Animator)
  effects.ts combatText.ts audio.ts map.ts hud.ts nametags.ts scene.ts
```

## Invariants — break these and you get rubber-banding or ghosts

- **Anything the client predicts must come from `@mmo/shared`** and be called
  identically on both sides: `applyInput`, `heightAt`, `sceneryIndex`,
  `buildingColliders`, `isInArc`. The client's `MoveWorld` must carry the same
  `scenery`, `boxes` and `terrain` the server's does.
- **Determinism across JS engines.** In `noise.ts`, `terrain.ts` and
  `worldgen.ts` use only `+ - * /`, `Math.floor`, `Math.sqrt`, `Math.abs`,
  `Math.imul`. No `Math.sin/cos/hypot/pow/exp` and no `**` — engines may round
  those differently, and a tree that exists on the server but not the client
  is an invisible wall. No `Math.random` in anything shared.
- **The server is the only authority.** Clients send intent (`MoveInput`:
  axes, yaw, cast slot, aim, sprint) and never positions or damage. Client-side
  combat visuals (predicted impacts, animations) decide nothing.
- **Schema changes are wire changes.** Client and server must be rebuilt
  together; `npm run dev` does this.
- **Every spawn/waystone must be safe.** `unsafeSpawns()` runs at boot and logs
  `[spawn]` warnings; treat any as a bug in the Ostra data.

## Gotchas already paid for

- Babylon is left-handed: facing yaw means direction `(sin yaw, cos yaw)` in
  x/z. Custom meshes need Babylon's front-face winding (see `terrain.ts`).
- Babylon ES modules tree-shake shaders; `scene.ts` imports them explicitly.
  Add imports for any new material type.
- The depth buffer is reversed (`engine.useReverseDepthBuffer`). Don't use
  `mesh.infiniteDistance` — it pins depth to the near plane and covers the
  world. The sky dome follows the camera by hand.
- Your own player's facing is never reconciled; it reads `cameraYaw()`.
- In dev, `JWT_SECRET` is random per boot and `tsx watch` restarts the server on
  every server/shared change — stored sessions become invalid and the client
  drops back to sign-in.
- `requestAnimationFrame` stops when the page isn't visible. `window.mmo.frame(now)`
  drives one frame by hand; `window.mmo` exposes `world`, `room`, `session`
  (`session.debug`), `keyboard`, `audio`. `GET /debug/rooms` lists live rooms.

## Style

- Comments explain *why*, often at length, in the existing voice; match it.
  British spelling (`colour`, `armour`).
- Tuning lives in data tables (`ostras.ts`, `enemies.ts`, `spells.ts`,
  `combat.ts`), not in logic.
- Art is built from primitives at runtime, low-poly and flat-shaded; sounds are
  synthesised. Nothing is loaded from asset files.
- One feature per commit, with a descriptive title (see `git log`).
