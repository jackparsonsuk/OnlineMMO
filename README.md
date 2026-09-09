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

Controls: **WASD** move, **Space / 1 / 2 / 3** cast, **I** pack, drag to orbit,
scroll to zoom, walk into a Gate ring to travel.

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

## Art style

Low poly, and that means two things that have to go together: very few
triangles, and **flat** shading so each triangle reads as its own facet. A coarse
mesh with smooth normals just looks badly made; the same mesh faceted looks
deliberate. `packages/client/src/lowpoly.ts` holds the whole style — materials
with no specular highlight, and every model built from primitives at runtime.

Nothing is loaded from a model file. There is no exporter in the pipeline, and a
creature's proportions sit next to the numbers the simulation uses, so a spider
cannot be drawn wider than the circle it collides with.

## Enemies and AI

Creatures are entirely server-driven. Clients predict their own movement and
nothing else, so enemies are interpolated exactly like other players — which
means the AI never has to be deterministic across machines, and is free to use
randomness.

`packages/shared/src/enemies.ts` is the archetype table. Two so far, built to
feel like opposites:

| | Risen (zombie) | Void Spider |
| --- | --- | --- |
| Notices you at | 13 m | 8 m |
| Chase speed | 3.2 m/s | 7.2 m/s (you cannot outrun it) |
| Threat | Sees you early and never stops | Harmless until close, then instant |

The state machine is Idle → Wander → Chase → Return.

Two details carry most of the feel. **Deaggro is wider than aggro** (20 m vs 13 m
for a Risen), because with a single radius a player standing exactly on the line
makes the creature start and stop every tick. And **Return is a latch, not a
distance test** — see below.

Creatures live and die with their room and are never persisted, so an emptied
Ostra repopulates the moment somebody walks back into it.

## Combat

Space swings. The server resolves everything; the client only draws.

**Hits are lag-compensated.** A client renders creatures ~120 ms in the past, so
a Void Spider closing at 7.2 m/s is nearly a metre from where it appears by the
time a swing reaches the server — most of the 2.4 m reach. The room records
enemy positions (`allowRewindState`) and the hit test asks `lastSeenBy()` where
they were when *that player* swung. Neither side has to be told about the
other's timing: the client's interpolation delay travels in the input handshake,
bound automatically because the input handle is wired through the reconciler.

`isInSwing()` lives in `@mmo/shared` for the same reason `applyInput` does — the
client paints the arc, the server judges it, and if those disagreed the game
would look like it was cheating you. Reach extends to the target's *surface*, so
a wide creature is easier to hit than a narrow one.

One swing hits the nearest creature in the arc, not everything in it. With five
things on you that makes numbers matter, where a cleave would make a crowd
easier than a single creature.

Cooldowns are enforced server-side, so holding Space auto-attacks and spamming
it gains nothing. The client mirrors the same constant purely so the swing draws
on the frame you press rather than a round trip later.

Death: creatures drop to a `Dead` state — still in the map, so the client can
tip them over — and return to their spawn after 12 s. Players wake at the Ostra's
spawn point after 4 s, and anything still locked onto them lets go.

Player health persists (see the migration in `SqliteCharacterStore`), so logging
out at 3 HP and back in is not a free heal.

### Spawn safety

`unsafeSpawns()` checks, at boot, that no spawn point sits inside a creature
camp's aggro radius, and the server logs a warning per offender.

This exists because Barals put new arrivals 10 m from a camp of Risen that
notice you at 13 m — you respawned into the creatures that had just killed you,
forever. Layout is hand-authored data, and hand-authored data drifts: the check
caught a *second* instance on its first run, one introduced minutes earlier by
widening a camp.

## Spells and getting better at them

Three abilities, on **1 / 2 / 3** (Space also casts Strike, so the free option
is always under a thumb):

| | Aequum | Mana | Shape | Role |
| --- | --- | --- | --- | --- |
| **Strike** | 0 | free | 2.4 m wide cone | Best sustained damage, worst reach |
| **Voidbolt** | 1 | 12 | 13 m narrow cone | Open before it closes |
| **Sunder** | 2 | 32 | 4.6 m ring | The answer to being surrounded |

Aequum is a **mana bracket, not a power ranking** — that's the lore's
definition, and it's why Strike is Aequum 0 while still being the highest
sustained damage in the kit. Every spell resolves through one `isInArc()` call;
a ring is just an arc of 2π, so adding a spell is a table entry rather than a
new code path.

### Proficiency

Progression is use-based, from the vault:

> Everyone has some amount of innate magical ability within them. **Like a
> muscle the more you use magic the better you become, up to a set ceiling.**

So there is no XP bar. Each spell has its own proficiency that rises **only on
a landed cast** — casting at a wall would otherwise be training in the least
interesting sense — and growth slows as it approaches your ceiling, so the last
points cost far more casts than the first.

`affinity` is that ceiling, rolled once at creation between 55 and 100 and never
changed. The damage bonus scales against 100 rather than against your own
ceiling, deliberately: someone born with 55 who maxes out should be weaker than
someone born with 100 who maxes out, or the ceiling is just a slower bar.

Affinity and proficiency are private, so they travel as a message rather than in
replicated state — and the client **asks** for them once its handlers are up
rather than being pushed them from `onJoin`, which is the same race the
character id fell into.

### Difficulty by Ostra

Creatures scale per Ostra, so travel is a difficulty choice rather than a change
of palette:

| Ostra | Creature damage | Creature health |
| --- | --- | --- |
| Terra | ×0.6 | ×1.0 |
| Ascendant | ×1.0 | ×1.2 |
| Barals | ×1.6 | ×1.5 |

## Loot and equipment

Creatures drop gear. It lands where they fell, hovers as a faceted crystal
coloured by rarity, and is picked up by walking over it — no key, because one
less thing between killing something and being rewarded for it. Press **I** for
the pack; click a carried item to wear it.

Three slots — weapon, armour, trinket — and three stats: flat `damage` added
after proficiency scaling, plus `health` and `mana` added to your caps. Flat
rather than percentages, so the numbers stay legible next to the ones already
on screen ("+5 damage" against Strike's 18) instead of compounding into nonsense
once there are more slots.

**Gear is the fast axis, proficiency the slow one.** A lucky drop changes your
numbers today; training a spell changes them over an evening. Keeping them
separate means neither makes the other pointless — you cannot loot your way to a
trained spell, and practice is no substitute for a better blade.

Rarity odds are tilted by the Ostra's danger, so Barals pays better than Terra.
Without that, a harder place is pure downside and nobody would go.

`maxHealth` and `maxMana` are replicated on the player rather than derived
client-side, because equipment itself is private — without them the client
could not draw its own bars. Taking armour off clamps current health to the new
ceiling rather than scaling it: it should never kill you, and never leave you
above your cap.

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
- **No economy.** Items drop and are worn; nothing buys, sells, repairs or
  trades them, and there is nowhere to store them beyond twelve carried slots.
- **No settlements and no NPCs.** Daso and Fanshona exist in the vault and
  nowhere in the game, which means players still have no reason to be in the
  same place at the same time.
- **Loot has no ownership.** The first person to walk over a drop takes it,
  whoever killed the creature.
- **No threat or targeting.** Creatures always chase whoever is nearest; you
  cannot taunt, and there is no target selection — spells hit whatever is in the
  shape.
- **Spells are found nowhere.** The lore says spells come from scrolls and books
  and that the Library Ostracon holds them all; here you simply start with three.
- **No damage feedback beyond a flinch.** No numbers, no death animation; a
  killed creature just tips over.
- **Player-vs-player is possible but untested.** Nothing stops a swing landing on
  another player except that `isInSwing` is only ever run against creatures.
- **A stray player twice appeared after the server was killed under live tabs.**
  Not a state leak: `GET /debug/rooms` showed clients and players *matching*, so
  it was a genuine extra connection. The browser console explains it — the SDK
  retries dropped rooms with `skipHandshake=true&reconnectionToken=...`, so a
  retry from an abandoned page can succeed against a freshly restarted server and
  rejoin for real. A development artifact of restarting the process under open
  tabs. If clients and players ever *disagree*, that is a different and much
  worse bug.
- **Gate rings are not solid**, deliberately — you walk into one to use it.
  Scenery and other players are solid.
- **The duplicate-character guard is per-room.** One character can't be in the
  same Ostra twice, but two clients racing could briefly hold it in two
  different Ostras.
- **Only position persists.** No inventory, stats, or progression yet, and
  creatures reset with their room.
- **AI has no pathfinding.** A creature walks straight at its goal and slides
  along whatever it hits. Fine in open ground; it will look stupid the moment an
  Ostra has a wall to walk around.
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
