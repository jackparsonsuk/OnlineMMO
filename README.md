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

Then open http://localhost:5173, make an account, and name a character. For two
players locally, register a second account in another browser profile or a
private window — the session lives in localStorage, so two normal tabs share
one.

| Script | What it does |
| --- | --- |
| `npm run dev` | Builds `shared`, then runs the server and client together |
| `npm run dev:server` / `npm run dev:client` | One side only |
| `npm run typecheck` | Type-checks all three packages |

Controls: **WASD** move, **Shift** sprint (out of combat), **Space / 1 / 2 / 3**
cast, **Tab** or click to target, **Esc** to let go, **M** map, **I** pack, drag
to orbit, scroll to zoom, walk into a Gate ring to travel.

| Env var | Default | Meaning |
| --- | --- | --- |
| `JWT_SECRET` | *(random per boot)* | Signs session tokens. **Required in production.** |
| `PORT` | `2567` | Server port |
| `NODE_ENV` | | `production` enables the strict checks and static client serving |
| `ALLOWED_ORIGINS` | `http://localhost:5173` in dev | Extra CORS origins. Empty in production — the client is same-origin |
| `CLIENT_DIST` | `packages/client/dist` | Where the built client lives |
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

`packages/shared/src/enemies.ts` is the archetype table. Seven creatures, each
built around one thing you have to learn. Every attack goes through the same
telegraphed wedge test (see Combat); what differs is its reach, its width, how
long it warns you, and what the creature does around it (`style`):

| | Lives in | Style | What to do about it |
| --- | --- | --- | --- |
| **Risen** | Heartland, Ashfall | slow overhead | Sees you early and never stops; step out of the swing |
| **Void Spider** | woods, fens | fast bite, barely telegraphed | 7.2 m/s — you cannot outrun it; kill it |
| **Greywood Wolf** | Westwood, Greywood | quick bite, in packs | A shade slower than you, but there are always several |
| **Thornback Boar** | Sunward, Redstep | **charge**: winds up, then runs 8 m down a lane | Sidestep the painted lane |
| **Fen Wretch** | Lowfen, Brightwater | **spit**: hangs back at 8 m, spits down a 12 m lane | Close the distance — it backs away — or dodge sideways |
| **Cinder Wisp** | Ashfall | **pulse**: swells, then bursts in a ring | Two Strikes kill it; get out of the circle before it goes |
| **Cairn Golem** | ruins, Redstep, Highmoor | **slam**: huge, slow, wide | Can't be staggered and barely shoved; read it and move |

Each has a rare **signature drop** found nowhere else (Greywolf Mantle, Tusk
Charm, Fenwater Phial, Emberheart, Cairnstone Maul), kept out of the random
loot pool. The client gives each its own procedurally animated body, windup
sound and blow effect — a spit flies, a pulse bursts, a slam shakes the camera.

The state machine is Idle → Wander → Chase → Return.

Two details carry most of the feel. **Deaggro is wider than aggro** (20 m vs 13 m
for a Risen), because with a single radius a player standing exactly on the line
makes the creature start and stop every tick. And **Return is a latch, not a
distance test** — see below.

Creatures live and die with their room and are never persisted, so an emptied
Ostra repopulates the moment somebody walks back into it.

## Combat

Space swings. The server resolves everything; the client only draws — but it
draws *immediately*, which is most of what makes a hit feel like a hit.

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

One swing hits one creature in the arc, not everything in it — your selected
target if it is in there, otherwise the nearest. With five things on you that
makes numbers matter, where a cleave would make a crowd easier than a single
creature.

### Aim

`MoveInput` carries an `aim` separate from `yaw`. Yaw follows the camera and
steers movement; aim follows your target, so hitting something off to one side
doesn't bend the direction you are walking. With a target selected (Tab, or
click it) every cast turns to face it while in reach. Without one, Strike leans
toward whatever is within ~75° of where you are looking, and Voidbolt toward
anything within ~17° — reach is its reward, accuracy its price. Aim is computed
from the *drawn* positions, which are exactly what lag compensation rewinds to,
so aiming at the picture is aiming at the truth.

### Making a hit feel like a hit

Before this, a hit was a creature swelling 16% for a tenth of a second and a
health bar getting shorter. Now, all of it on the client and none of it
deciding anything:

- **Bodies animate** (`rigs.ts`). Every figure is built around shoulder, hip and
  waist pivots and posed procedurally each frame: walk cycles from measured
  speed, a three-beat Strike chain, a Voidbolt punch, a Sunder slam, flinches,
  falls, and creatures climbing out of the ground when a camp wakes.
- **Impact is predicted.** At the moment the blade connects (`castContact`) the
  client runs the same `isInArc` test the server will, and plays the flash,
  the shards, the thud and a small camera shake *then* — not a round trip
  later. The server's `cast` message follows with the numbers.
- **Hitstop.** A struck body's animation freezes for ~55 ms. It is the cheapest
  way to give a blow weight.
- **Numbers** float off everything (`combatText.ts`): yellow and large for a
  crit, red for damage you take, "Evaded" when a dodge works, "Staggered" when
  a heavy blow interrupts.
- **Sound** is synthesised with Web Audio (`audio.ts`) — nothing loaded, same
  rule as the art.
- **Everyone sees everyone's fights.** Casts are broadcast to players within
  180 m, so another player's swings, bolts and kills are visible, not just their
  target's health bar moving.

### Telegraphs, and why fights are now a thing you play

Creatures used to deal damage whenever they stood next to you — no decision to
make. Now an attack **commits**: the creature picks a direction, winds up
(`windupMs` — 560 ms for a Risen, 300 for a spider), and the blow lands on
whoever is still inside `attackReach` × `attackArc` when it ends. The client
paints exactly that wedge on the ground, filling as the windup runs, so
stepping out of the red is stepping out of the hit. The Risen is a slow
overhead you should never take twice; the spider barely warns you at all.

Heavy blows (every third Strike, and Sunder) **stagger**: the windup is
cancelled and the creature can't attack for 700 ms. Hitting a Risen's overhead
with a finisher is a blow you never take. Hits also **knock back** — a
decaying velocity spent through `moveBody`, so a shoved creature still stops at
a tree.

Crits (12%, ×1.8) and the Strike chain (third link ×1.5) give the free spell a
rhythm instead of a metronome.

### Threat

Creatures chase whoever has hurt them most, not whoever is nearest, with a 10%
edge to the current quarry so two players trading blows don't make it
flip-flop. A player who has done damage is chased 4 m further than the aggro
radius, so a Voidbolt from the edge of range is never free. Hitting one member
of a camp brings camp-mates within 7 m. A creature that leashes home heals to
full — otherwise it could be chipped down from the edge of its leash one pull
at a time.

### Recovering

Health used to never regenerate; since it persists, the only way to heal was to
die. Now, out of combat, you regain 5% of your cap per second, and mana comes
back nearly three times faster. "In combat" means you dealt or took damage in
the last 5 s, *or something is hunting you*. It is replicated on the player,
because sprint is denied in combat and the client has to predict that.

Cooldowns are enforced server-side, so holding Space auto-attacks and spamming
it gains nothing. The client mirrors the same constant purely so the swing draws
on the frame you press rather than a round trip later.

Death: creatures drop to a `Dead` state — still in the map, so the client can
play them falling — and return to their spawn after 12 s. Players wake after
4 s at the **nearest waystone** to where they fell (the Ostra's spawn if it has
none), and anything still locked onto them lets go.

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
of palette. Creature **level** stacks on top (`levelHealthScale`,
`levelDamageScale`): there is no XP in this game, so a level is a warning, not a
gate. On Terra it rises by one every 380 m from the Gate Circle, to 12 at the
edge, and loot rarity tilts with it.

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

A drop belongs to whoever earned it for 25 seconds — drawn small until the claim
lapses, so you can see something fell and that it is not yet yours. Without it,
the first person to walk over a drop takes it whoever did the killing, which is
fine alone and immediately unfair the moment two people fight the same camp.

`maxHealth` and `maxMana` are replicated on the player rather than derived
client-side, because equipment itself is private — without them the client
could not draw its own bars. Taking armour off clamps current health to the new
ceiling rather than scaling it: it should never kill you, and never leave you
above your cap.

## Accounts

Sign in with an email and password; a session token (JWT, one week) authorises
everything after that. **Accounts are global, characters are per-realm** — one
login gets you into every realm and you have a separate character on each, which
is what makes "different servers" mean something.

Nothing here invents cryptography. Passwords go through `@colyseus/auth`'s
scrypt `Hash`, and tokens through `jsonwebtoken`. A login hashes even when the
account does not exist, so the failure path costs the same as the success path
and the endpoint cannot be used to enumerate which addresses are registered.

Authorisation happens twice, deliberately:

1. **`static onAuth`** verifies the token during matchmaking, so an
   unauthenticated client never reaches a room at all.
2. **`onJoin`** checks the character belongs to that account, answering "not
   yours" and "does not exist" identically so ids cannot be probed.

A character id is therefore just a selector now — knowing one gets you nothing.
`JWT_SECRET` is **required in production**: the server refuses to start without
it, because a secret committed to a repository is the same as no secret.

Characters created before accounts existed have no owner. They are listed for
nobody and the server reports how many at boot, rather than deleting somebody's
save without asking.

## Deploying

One artifact: the server serves the built client from its own origin, so there
is no CORS to configure, no server URL baked into the bundle at build time, and
one certificate.

```bash
npm ci && npm run build
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") NODE_ENV=production npm start
```

**[DEPLOYMENT.md](DEPLOYMENT.md) is the full runbook** — Railway, Fly and plain
Docker, every environment variable, backups, and the ephemeral-filesystem trap
that silently wipes a realm on redeploy.

Serverless hosts (Vercel, Netlify Functions, Lambda) cannot run the server: the
world lives in memory and ticks at 30 Hz, which needs a process that outlives a
request.

## Terrain

The ground has shape, and `y` finally means something.

Height is a **pure function**, not a heightmap image, for the same reason
`applyInput` is shared: the server places you on the ground and the client
predicts where the ground will be, and a centimetre of disagreement is
permanent vertical rubber-banding. A function both sides call is identical by
construction — no asset to load, no sampling convention to get subtly wrong.

It is layered gradient noise (`noise.ts`): kilometre-scale uplands, rolling
hills, ridged mountain ranges in patches, and a wall of peaks at the rim. The
noise is built from `Math.imul` hashing and plain arithmetic only — **no
`Math.sin`, `Math.hypot` or `**` anywhere in `noise.ts`, `terrain.ts` or
`worldgen.ts`**, because the spec lets each JS engine round those differently
and Node and every browser must agree to the last bit. (The previous sum of
sine waves was fine over 80 m and would have tiled visibly over 8 km.) Height
is **derived** from the final x/z each step rather than integrated, so there is
no vertical velocity to drift out of sync.

Flat zones blend the hills away under a settlement or waystone, levelled to
whatever the natural ground is at their centre, and mountains are kept 320 m
clear of them — a town should never have a cliff for a back wall. The visible
mesh is built from the same function and flat-shaded, coloured through vertex
colours: grass by height, drier patches, darker under woods, stone where steep,
snow on peaks, dirt on roads.

The client's prediction now passes the terrain and building colliders to
`applyInput` too. It used to leave them out, so it predicted you walking
through walls and at the wrong height, and was corrected every patch.

Buildings needed **box colliders**, added alongside the circles. A twelve-metre
inn approximated by a circle either blocks the street outside it or lets you
stand in its corners. Boxes rotate, so the town isn't forced onto a grid.

And the camera now stops at walls: a ray from the player outward, tested only
against things tagged `blocksCamera`, so grass and villagers never shove the
view around.

## Daso

Terra's west, per the vault — a kilometre and a half out along the Westroad
from the Gate Circle, deep in woodland: a logging town of fifty, a few houses and an inn,
and nobody passing through except for work or by accident. That last detail
shapes the layout — it is built around the timber yard, not a square.

Six buildings including **The Felled Oak** (the only lit windows in the world),
a ring of woodland that actually blocks you, woodpiles and stumps and lamps,
and five villagers who say something when you come near. Basan Log is there,
before the events of *The Daso Voice*:

> There's a sound in the west woods. Like someone saying my name.

`settlements.ts` is plain data. Buildings become colliders on both sides;
props and villagers are drawn client-side and cost no bandwidth.

`unsafeSpawns()` now checks camps against **settlements** as well as spawn
points — and caught a Risen camp reaching within 10.6 m of Daso on its first
run, which would have put zombies in the streets of the one calm place.

## Fanshona

The second settlement, in Brightwater, Terra's lake country: a stone market
town facing its lake, with a Weighhouse, market stalls, a well, a boathouse, a
dock running out over the water and boats moored beside it. Built as Daso's
opposite — Daso is timber and nobody visits; Fanshona is stone and slate and
everything passes through it: fish off the lake, timber from Daso, stone from
the moor.

**The vault names Fanshona, but none of these details come from it** — they were
invented for the game and are listed in TODO.md to be checked.

The town is laid out in its own frame, facing the lake, and rotated into
place, so it can be turned by editing one number. Its shelf and its lake share
a fixed level, so the dock always reaches water whatever the ground does.

## A world eight kilometres wide

Terra is 8000 m on a side — a hundred times the 80 it was. Crossing it on foot
takes twenty-two minutes, fourteen sprinting. What makes that workable:

**Most of it is generated, and none of it is sent.** `worldgen.ts` derives
woodland, boulders and ~700 creature camps from `wilds.seed`, lazily, one 64 m
cell at a time. The server asks a cell for its colliders; the client asks the
same cell for things to draw. Same deterministic function, so the tree you see
is the tree that stops you. What is placed by hand — the Gate Circle, two towns,
fourteen waystones, seven ruins, twelve lakes and the places roads must reach —
is the skeleton the rest hangs off, and the placement rules are mostly about
where things may *not* go: nothing on a road or in a lake, no camp that can see
a town or a waystone.

**Nine regions**, each with its own ground colour, trees, rocks, grass and
creatures: the green Heartland round the Gate Circle, Westwood (Daso's oak
woods), Greywood (dark pine forest), Highmoor (lifted heath and peaks),
Brightwater (lakes and birch), Sunward (golden plains), Redstep (red mesas cut
into terraces), Ashfall (grey ash and dead trees) and Lowfen (sunken marsh and
meres). A region is the nearest of nine centres, with borders warped by noise
so they meander and blended over ~200 m so none is a line. The same
`TerrainRegion` data bends the height function — a moor is lifted, a fen
pressed flat, mesas terraced — so the land and its look agree about borders.

**Lakes** are shallow — you wade, there is no swimming — and carved by
`heightAt` with a wandering shoreline and a bank that always rises above the
water. The client draws the surface as a sheet covering every cell where the
ground dips below it, so the water follows the carved shore exactly.

**Roads are routed, not drawn.** Each road lists only the places it must pass
through; A* over a 32 m grid finds the way between them, where cost climbs
steeply with gradient (roads go round mountains), water is nearly forbidden
(round lakes), broad noise-driven "bad going" is avoided (so even gentle country
gets long sweeping bends), and ground an earlier road covers is cheap (so roads
merge into a network with junctions and loops rather than running side by
side). The result is smoothed into curves and given a gentle wander. Thirteen
roads, about 36 km, route in ~0.35 s at startup on each side.

**Ruins** — a stone ring, a watchtower, a barrow, two spires, a sunken hall — are
landmarks with guardians. `ruinParts` places every stone deterministically, so
the server collides with exactly what the client draws.

**Collision is bucketed.** `MoveWorld.scenery` is a `SceneryIndex`; a body only
tests the 3×3 cells around it, in a fixed order so both sides sum contacts
identically. Without it, every body would test tens of thousands of trees
every tick.

**Camps sleep.** A camp's creatures only exist while a player is within 190 m
of it, and are removed 20 s after nobody is within 280 m and nothing in it is
fighting. Terra holds ~3000 creatures; the server simulates and replicates the
dozens near someone.

**The ground streams.** Detailed 64 m chunks (2 m quads) are built nearest-first
around the camera, two per frame, out to 330 m, each with a skirt to hide seams.
Beyond that, one coarse mesh of the whole Ostra at 64 m per quad is the
horizon — with its quad cut out wherever a detailed chunk stands. Trees, rocks
and grass are thin instances, one draw call per kind. Fog and a sky dome fade
the far ground into the sky; the depth buffer is reversed, because a normal one
runs out of precision long before eight kilometres.

**You can find your way.** A minimap (north up), a compass strip with bearings
to landmarks, and a world map on **M** that paints itself in tiles in the
background from the same `groundTone` as the terrain. Waystones have light
columns that show above the haze.

The size is one number (`TERRA_SIZE` in `ostras.ts`); everything above scales
with it.

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

Ordered roughly by how much they would hurt in production. Ideas for what to
build next live in [TODO.md](TODO.md).

- **No email verification and no password reset.** An address is never proved,
  and a forgotten password is a lost account.
- **No TLS.** Browsers refuse `wss://` from an HTTPS page, so a real deployment
  needs a reverse proxy or a host that terminates it.
- **SQLite means one process per realm.** The `CharacterStore` interface exists
  so Postgres can replace it; nothing else needs to change.
- **No economy.** Items drop and are worn; nothing buys, sells, repairs or
  trades them, and there is nowhere to store them beyond twelve carried slots.
- **No interest management.** Camps only exist near players, which keeps state
  small, but every active creature is still replicated to everyone in the
  room. With players spread across Terra that grows with the player count;
  Colyseus `StateView` (per-client filtering) is the fix.
- **Two settlements.** Daso and Fanshona; most of Terra is wilds. Fanshona's
  details are invented and unchecked against the vault.
- **Docks are scenery.** You wade beside Fanshona's dock, not along it.
- **No taunt, no group threat tools.** Threat is damage-based; there is no way
  to deliberately hold a creature off a friend.
- **Spells are found nowhere.** The lore says spells come from scrolls and books
  and that the Library Ostracon holds them all; here you simply start with three.
- **No fast travel.** Waystones are where you wake, not where you can go.
- **Distant trees pop in** at ~330 m, where the detailed chunks end; the
  horizon mesh has darker ground under woods but no trees.
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
- **Creatures reset.** Camps are never persisted; a sleeping camp wakes fresh.
- **AI has no pathfinding.** A creature walks straight at its goal and slides
  along whatever it hits. Generated camps sit in clearings, but a chase through
  thick woodland shows it.
- **Terrain does not affect movement.** Slopes cost nothing to climb — including
  the rim's 120 m peaks — and there is no jumping; you simply follow the
  surface.
- **Villagers are scenery.** They stand where they are put and say one line.
  No trading, no quests, no schedule.

## Debugging

`GET /debug/rooms` lists every live room with its client count, player count and
names — the fastest way to tell a rendering problem from a state problem.

In dev, `window.mmo` exposes `{ character, world, keyboard, audio, room, session, frame }`,
and `session.debug` carries `{ predict, meshes, colliders, input, target }`. Reading a pose two
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
