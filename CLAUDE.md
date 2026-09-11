# CLAUDE.md

Ostracon: a browser MMO on Babylon.js (client) and Colyseus 0.18 (server), in an
npm-workspaces monorepo. **README.md is the design record** — it explains why
things are the way they are. Read the relevant section before changing a
system, and update it when a design decision changes. **TODO.md** is the list
of ideas and known work; remove an item when it is done, add ones you notice.

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
  worldgen.ts        routed roads, regions, woodland, rocks, camps, ruins,
                     SceneryIndex, buildingColliders, unsafeSpawns
  ostras.ts          the Ostra table: Terra = 8000 m, regions, lakes, ruins,
                     roads, waystones; generated wilds
  items.ts           slots, rarities, item bases; an item is a key
                     {base,level,rarity,seed} and describeItem() derives the rest
  itemNames.ts       names and lore from the item's seed
  levels.ts          character level 1-100: the XP curve, kill XP by level gap,
                     difficulty ("con") colours
  classes.ts         classes (the Warrior), per-level stats, ability unlocks,
                     Fervour
  stats.ts           Might/Focus/Vigour/Spirit + secondaries, and what they do
  elites.ts          rare named elites per region; unsafeElites() at boot
  quests.ts          quest data, objectives, reward choices, questXp
  vendors.ts         sell prices, vendor stock (pure function of vendor + level)
  combat.ts spells.ts enemies.ts settlements.ts schema.ts constants.ts
packages/server/
  rooms/OstraRoom.ts one room per Ostra: sim loop, camps, casts, loot, gates
  loot.ts            the only place items are rolled; old-save item migration
  ai/enemyAI.ts      creature state machine, windups, threat, knockback
  auth.ts, store/    accounts (JWT + scrypt), SQLite persistence
packages/client/src/
  session.ts         per-room glue: prediction, input, rigs, combat events,
                     the character screen's camera (setPortrait)
  character.ts       the character screen: slots, lines to the body, pack, abilities
  devtools.ts        the ` dev menu (dev builds only; server gates `dev` too)
  questUI.ts         quest dialogue (E), tracker, quest log (J)
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
- **Adding a creature** touches: `EnemyKind` + archetype in `enemies.ts` (its
  `style` drives AI and effects), a rig and pose in `rigs.ts`, an entry in
  `IMPACT_COLOUR`/`WINDUP_SOUND` in `session.ts`, and region `creatures` weights
  in `ostras.ts`. The compiler flags most of these via `Record<EnemyKind, …>`.

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
- Roads are routed by A* at startup on both sides (~0.35 s). Anything that
  changes terrain height, lakes or road `points` changes every road.
- `requestAnimationFrame` stops when the page isn't visible. `window.mmo.frame(now)`
  drives one frame by hand; `window.mmo` exposes `world`, `room`, `session`
  (`session.debug`), `keyboard`, `audio`, `characterScreen`, `devMenu`, and
  `loot()`. `room.send("dev", { cmd: "teleport", x, z })` and the other dev
  commands in `OstraRoom.onDev` work from the console. `GET /debug/rooms` lists
  live rooms.
- Browser automation's key presses arrive with an empty `event.code`, and every
  binding reads `code`. Drive keys with
  `window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }))`.
- Items are keys, not ids: never compare or look up an item by anything but
  `describeItem(key)`. Anything that rolls an item belongs in the server.

## Style

- Comments explain *why*, often at length, in the existing voice; match it.
  British spelling (`colour`, `armour`).
- Tuning lives in data tables (`ostras.ts`, `enemies.ts`, `spells.ts`,
  `combat.ts`), not in logic.
- Art is built from primitives at runtime, low-poly and flat-shaded; sounds are
  synthesised. Nothing is loaded from asset files.
- One feature per commit, with a descriptive title (see `git log`).
