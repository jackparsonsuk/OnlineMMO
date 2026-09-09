# Ostracon

A browser MMO set in the Ostracon — a world shattered into countless *Ostras*,
isolated from one another since the Gates were shut down in Y1100. The game is
set at the moment they come back on, which is why travel between Ostras is
something a player does rather than something only legends describe.

Built on [Babylon.js](https://www.babylonjs.com/) and [Colyseus](https://colyseus.io/).

Movement is **server-authoritative**. The client never sends a position — only
which keys are held and which way the camera is pointing. The server simulates
at a fixed 30 Hz and owns every coordinate.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Add `?slot=2` to play a second character in
another tab — without it both tabs share one character and the server rejects
the duplicate.

| Script | What it does |
| --- | --- |
| `npm run dev` | Builds `shared`, then runs the server and client together |
| `npm run dev:server` / `npm run dev:client` | One side only |
| `npm run typecheck` | Type-checks all three packages |

| Env var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `2567` | Server port |
| `REALM_ID` | `local` | Which realm this process serves |
| `DATABASE_FILE` | `data/ostracon.db` | SQLite file |
| `VITE_SERVER_URL` | `ws://localhost:2567` | Where the client looks for the server |

## Layout

```
packages/
  shared/   schema, tuning constants, the Ostra table, and the movement sim
  server/   Colyseus rooms, character persistence — the authority
  client/   Babylon scene, camera, prediction
```

`shared` exists so the movement code is written **once**. `applyInput()` runs on
the server to advance the real state, and on the client to predict and to replay
after a correction. If those two ever diverge you get permanent rubber-banding,
so they are literally the same compiled function.

## How a step works

1. Once per fixed step, the client samples the keyboard and camera heading and
   sends a `MoveInput` (`moveX`, `moveZ`, `yaw`). Nothing else.
2. The server buffers each client's inputs and drains them in its own
   `setFixedTimestep` loop, applying `applyInput()` to the authoritative
   `Player`. Inputs are clamped there — a client that sends `moveX: 99` gains
   nothing, and the 64-frame buffer stops anyone banking inputs to spend as a
   burst of speed later.
3. State patches go out every 50 ms, carrying an ack of how many inputs the
   server has actually consumed.
4. The client predicts its own cube immediately, and on each patch rewinds to
   the server's position and replays the inputs that weren't acked yet. Other
   players are interpolated ~120 ms in the past, so they always move between two
   real samples rather than guessing.

Steps 3 and 4 are the SDK's `Predict` / `Reconciler`; step 2 is the room's
`defineInput` buffer. The tick rate is advertised by the server through the join
handshake, so both sides predict on exactly the same `dt`.

## Collision

Circle-vs-circle push-out, resolved inside `applyInput` so client and server run
the identical code. Two kinds of collider go in:

- **Scenery** comes from each Ostra's `obstacles` table. Identical on both sides,
  so it predicts perfectly — you never see a correction walking into a rock.
- **Other players** are approximate on the client by construction. The server
  knows exactly where everyone is; the client only knows where it last *drew*
  them, ~120 ms in the past. The reconciler exists to absorb precisely that
  disagreement, so a contested shove settles rather than fighting.

Displacements from every contact are summed and applied together rather than one
collider at a time. Sequential resolution depends on the order colliders arrive
in, and the two sides build that list from different sources — order-independence
is what keeps them agreeing.

The server snapshots collider positions once per tick, before anyone moves.
Rebuilding per player would make the result depend on map iteration order, which
the client has no way to reproduce.

## Nametags

HTML, not 3D. Each label is a `<div>` positioned by projecting the player's world
position into CSS pixels every frame. Babylon's GUI package would render text into
a texture — another dependency, and soft text up close. As with most MMOs the
labels are not occluded by geometry: you can read a name through a rock.

## Ostras and Gates

Each Ostra is one Colyseus room. There is a single `OstraRoom` class, and
`filterBy(["ostraId"])` is what makes `joinOrCreate("ostra", { ostraId })` land
in the right one. `packages/shared/src/ostras.ts` is a plain data table of the
three Named Ostras and the Gates between them — Terra is the hub, and the
unnamed, beast-ridden Ostras of the lore are meant to be generated into that
same shape later.

Walking into a Gate ring hands you to another room:

1. The server writes your new Ostra and arrival position to the database.
2. It reserves you a seat in the destination room and sends you the reservation.
3. The client claims the new seat, *then* drops the old room. That order matters:
   claim-then-leave means a failure leaves you standing where you were, rather
   than in no room at all with your save already moved.
4. The destination room loads your position from the database.

So the **database, not a message payload, is what carries the player across**.
A Gate you arrive through is suppressed until you step out of its radius, which
is what stops you bouncing straight back.

## Characters and realms

Characters are minted over HTTP (`POST /characters`) before any room is joined,
and the client keeps the returned id in localStorage. A returning player asks
`GET /characters/:id` to find out which Ostra they logged out in, because only
the server knows.

Every character is scoped to a **realm** (`REALM_ID`). Two deployments pointed at
the same database still give players two separate worlds, which is how the
"different servers" model is meant to work.

## Known gaps

Ordered roughly by how much they would hurt in production.

- **There is no authentication.** The character id *is* the credential — anyone
  who learns one can play as that character. `packages/server/src/identity.ts`
  is deliberately the only file that assumes this, so accounts can replace it
  without touching the rooms.
- **`POST /characters` is unauthenticated and unthrottled.** Anyone can create
  characters in a loop and fill the database.
- **SQLite means one process per realm.** The `CharacterStore` interface exists
  so Postgres can replace it; nothing else needs to change.
- **A player entry twice appeared with no client attached**, both times during
  development after the server process was killed under live browser tabs. Two
  targeted reproductions (join/leave, and a Gate transfer watched from a second
  client) both came back clean, and the room census has matched ever since, so
  the cause is unconfirmed — most likely the client SDK's automatic reconnection
  racing a restarting server. `GET /debug/rooms` reports clients and players per
  room specifically to catch it: if those two numbers ever disagree, that is the
  bug.
- **Gate rings are not solid**, deliberately — you walk into one to use it.
  Scenery and other players are solid.
- **The duplicate-character guard is per-room.** One character can't be in the
  same Ostra twice, but two clients racing could briefly hold it in two
  different Ostras.
- **Only position persists.** No inventory, stats, or progression yet.
- **`y` is always 0.** It is in the schema and the movement state so terrain and
  jumping don't need a wire format change, but nothing moves vertically.

## Debugging

`GET /debug/rooms` lists every live room with its client count, player count and
names — the fastest way to tell a rendering problem from a state problem.

In dev, `window.mmo` exposes `{ character, world, keyboard, room, session, frame }`,
and `session.debug` carries `{ predict, meshes, colliders }`. Reading a pose two
ways — what prediction holds versus what is drawn — is how the yaw seam bug below
was pinned down.
`frame(now)` runs a single render/network frame on a clock you supply — useful
because `requestAnimationFrame` stops in a background tab, which otherwise makes
the client look frozen when you are testing two windows at once.

One subtlety worth keeping: **your own facing is never reconciled.** The server
only echoes back the yaw you sent it, so there is nothing to correct — and
correcting it anyway is a bug. The reconciler smooths numeric fields linearly with
no notion of angles, so a turn across the 0/2π seam gets interpolated the long way
round, whipping the cube through a half-turn to face the camera and back. The local
mesh reads `cameraYaw()` directly instead, which also removes a frame of turn
latency. Remote players are fine: their yaw is smoothed with `angle: true`.

Note that Babylon's ES-module build tree-shakes shader source out of the bundle
and fetches it at runtime; under Vite that request hits the SPA fallback and
returns `index.html`, so materials fail to compile and you get a black screen.
`scene.ts` imports the shader modules explicitly to prevent that — if you add a
material type, import its shaders too.
