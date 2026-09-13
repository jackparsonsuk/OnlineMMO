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

Controls: the **mouse** looks and aims, **left click** Strikes (on the move),
**right click** blocks (hold), **2–6** abilities, **WASD** move, **Shift**
sprint (out of combat), **Space** jump, **Q** dodge, **R** Second Wind (a heal),
**Alt** held for a cursor, **Tab** to lock a target, **Esc** to let go (and,
with nothing left to close, the game menu: log out, sign out, sound), **M** map
(scroll to zoom, drag to pan), **I** (or **C**) character and pack, **E** talk
to a villager (or, facing open water, fish), **J** quest log, **P** party, **Enter** chat, **H** this list,
scroll to zoom, walk into a Gate ring to travel.

In development, **`` ` ``** (backtick) opens the dev menu: teleport by clicking
the world map (the hint shows the coordinates, region and creature level under
the cursor), to any named place, or through any Gate; heal, god mode (blows
still land, but take nothing), set your level, give XP (as if earned, so it
levels you with the banner); put an
item of any rarity and level in the bag, scatter one of each, empty the bag;
kill everything within 25 m (drops roll as normal); a far camera; hide the HUD
for screenshots. `mmo.loot(level, spread)` in the console does the scatter.

It is safe to leave in the code: the client only builds the menu in a
development build, and the server only registers the `dev` message when
`NODE_ENV` is not `production` — so no crafted message reaches it on a real
server. Every cheat still goes through the server like any other intent.

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
   players are interpolated 150 ms in the past, so they always move between two
   real samples rather than guessing — enough to ride out the jitter of a home
   connection through a tunnel.

Steps 3 and 4 are the SDK's `Predict` / `Reconciler`; step 2 is the room's
`defineInput` buffer. The tick rate is advertised by the server through the join
handshake, so both sides predict on exactly the same `dt`.

## Collision

Circle-vs-circle push-out, resolved inside `applyInput` so client and server run
the identical code. **A player collides only with what both sides know
exactly**: scenery (each Ostra's `obstacles`, the generated trees and rocks),
buildings and dungeon rock, the ground, ground too steep to climb, and water
too deep to wade. So your own movement predicts
perfectly — you never see a correction walking into a rock or a wall.

**Players pass through other players and through creatures**, as in WoW. They
used to collide, against positions the client could only know late: where it
last *drew* them, 150 ms in the past, plus the other player's own latency. The
server, knowing better, disagreed at every brush, and every disagreement is a
correction. With three friends playing together over a home connection that
was constant rubber-banding — measured at a 210 ms round trip, walking through
a friend gave ten corrections of up to 64 cm in ten seconds; with bodies out of
your step, none. Creatures still keep out of players, from their side: their
step (server-only, never predicted) collides with everyone, so a Risen still
stops at you rather than standing in you.

Sprint had the same shape of problem at the start of every fight: the server
stops honouring it the moment something hunts you, and the client heard a
round trip later, having predicted a sprint the server refused — one snap back
of most of a metre. Now the client only asks to sprint while it believes you
are out of combat, and the server honours a request for `SPRINT_GRACE_MS`
after a fight begins, so the two agree across the round trip.

What correction is left eases out over 90 ms rather than snapping, and anything
over 5 m is a teleport (a respawn, a Gate) and pops. `GET /debug/rooms` reports
each room's tick time (a tick over 33 ms is the simulation falling behind), and
in dev `session.debug.reconciler()` is the live reconciler. To test netcode
locally, start the server with `COLYSEUS_LATENCY=150` (round-trip ms).

Displacements from every contact are summed and applied together rather than one
collider at a time. Sequential resolution depends on the order colliders arrive
in, and the two sides build that list from different sources — order-independence
is what keeps them agreeing.

The server snapshots collider positions once per tick, before anyone moves.
Rebuilding per player would make the result depend on map iteration order, which
the client has no way to reproduce.

## The HUD

Kept to what you use while playing, in the places an MMO player looks for it.
Everything you watch in a fight is in one block at the bottom centre, under
your character: health (big, numbers inside, a red edge and crossed swords in
a fight) and Fervour directly over the abilities, the XP line under them, and
the cast bar just above. It sat in a frame in the top-left corner for a while,
and a glance at a corner is a glance away from the telegraph you should be
stepping out of. Party frames are top left, the target under the compass,
minimap and quest tracker top right, chat bottom left, and a small corner for
gold, ping, help and sound. Your name and level are over your head and on the
XP line, so nothing else repeats them.

What used to sit on screen permanently and is now shown only when it means
something: the Ostra's name is a title card that fades in on arrival (the
minimap keeps saying where you are); the connection status only appears while
connecting or when something is wrong; tick rate and unacked inputs only in
development; the list of players in the room moved into the party window as
"Nearby", with invite buttons; and the bar of controls became a card on **H**,
shown by itself the first time a browser enters the world.

Every panel shares one look — dark glass, a warm gold hairline, a soft shadow
— set by CSS variables at the top of `style.css`, and names and titles are in a
book face from the fonts every desktop already has (Palatino, Book Antiqua,
Georgia), since nothing is loaded from a file.

## Nametags

HTML, not 3D. Each label is a `<div>` positioned by projecting the player's world
position into CSS pixels every frame. Babylon's GUI package would render text into
a texture — another dependency, and soft text up close. As with most MMOs the
labels are not occluded by geometry: you can read a name through a rock.

A villager's quest mark used to be a 14px character before the name, seen
only as far as the name — 45 m — so in a town of lit windows the way to find
work was to read every label. It is now a large gold "!" or "?" floating over
the head, bobbing, and seen on its own from 140 m (`MARKER_DISTANCE`); the
name appears when you are close enough to read it. Work under way keeps the
small grey "…", and stays at name range. A vendor carries a gold **Shop** sign
under the name, and a coin where they stand on the minimap and the world map
zoomed in on a town.

## Art style

**Voxels.** Every body, prop, building and tree is a grid of cells, meshed at
load. `packages/client/src/voxel.ts` holds the whole style.

It was low poly before, and the problem was not the polygons: it was that a
creature was a handful of stretched boxes — the wolf was thirteen — which is
not an art style so much as the absence of one. Voxels keep the one thing that
approach got right and fix the one it got wrong. **Nothing is still loaded from
a model file:** a voxel model is data in a source file, so there is no exporter
in the pipeline, no asset to download, no loading screen, and a creature's
proportions still sit next to the numbers the simulation uses — a spider cannot
be drawn wider than the circle it collides with. But where a box could only
ever be a box, a grid can have a jaw, an ear, a strap and a notch.

Three techniques do the work, and they have to go together:

- **Resolution.** `VOXEL` is 1/32 m, so a player is 51 cells tall and a leg is
  6x12x6. The number that matters is the smallest part, not the total: at
  1/16 m a head is five cells and five cells cannot hold a face.
- **Ambient occlusion**, baked into the vertex colours at mesh time from each
  corner's three neighbours. This is the signature voxel look and it costs
  nothing at runtime. It is also why `bevel` is worth its one cell — the new
  faces it makes are all concave, so the occlusion does the shaping.
- **Speckle**: three or four shades of one hue scattered over a surface, so
  fur and bark have grain instead of reading as painted plastic.

Colours travel in the **vertex data**, so one flat white material serves any
number of models — a whole town is a handful of draw calls, and a body is one
material rather than the four or five it used to have (two where something on
it glows, since the flash on a hit is a change to the material).

**Greedy meshing** is what makes it affordable: interior faces are thrown away
and what is left is merged into the largest rectangles sharing a colour *and*
the same four corner AO values. A player is ~3,100 triangles across 7 meshes —
fewer draw calls than the 10 boxes it replaced.

Two things fall out of that and both cost real frames if you forget them:

- **Speckle is the expensive technique.** Two neighbouring cells of different
  colours cannot merge, so scatter is cheap on a body and ruinous on a wall. A
  log at 0.45 came out at 10,500 triangles; the golem's chest at 0.45 was
  28,000. Grain has to thin as a surface grows, and architecture gets none at
  all — walls and roofs use *structured* grain (courses, planks, studs, thatch
  bundles) which merges into long strips almost for free. Detailing both faces
  of a wall doubled every building in the game to draw stone on the inside of a
  room nobody can enter, so panels are detailed on one face and turned.
- **Big things get bigger cells.** A ten-metre pine at 1/32 m is thirteen
  million cells. Scenery uses 1/8 m and rocks 1/16 m — you look at a tree from
  twenty metres and a face from three, so a voxel four times larger subtends
  the same angle. The grain matches; the grid does not.

Scenery instances are scaled **uniformly**, or the cells would come out as
bricks. That works because the generator rolls a tree's height and its trunk
radius from one number, so scaling by the radius makes the drawn trunk exactly
the circle the server stops you against and leaves the height within a few
percent. Rocks are the exception — their height runs 0.8 to 1.3 of their radius
— so they get three templates of different squatness, picked by the same roll.

Buildings cannot be solid grids: Daso's hall would be fifteen million cells. A
wall's inside is never seen, so each face is a slab six cells thick.

`lowpoly.ts` remains for the things that are not surfaces — cast arcs, ground
items, the sky — and for the flat, unshiny material everything shares.

### Day and night

A day is forty minutes (`daylight.ts`), so an evening's play sees a dusk and a
dawn; night is about a third of it. The time comes from the wall clock, not the
server: every player sees the same sky with nothing sent, and since the light
decides nothing in the simulation there is nothing to keep in step. It is
keyframes — night, dawn, morning, afternoon, dusk — blended for the sky (as
tints on each Ostra's own palette, so a wilds Ostra keeps its colour), the fog
that meets it, and the sun's colour, strength and direction, which swings
across the sky so the shading moves through the day. Night is moonlit blue,
dark enough that Daso's lamps and windows (emissive, so they glow unaided)
read as lit, never so dark you cannot see what is biting you. Dungeons keep
their torchlight and ignore the clock. `setDayOffset(ms)` moves the clock for
testing.

### Music

Composed as it plays (`music.ts`), because nothing is loaded — so there are no
tracks, only a small composer. Each place has a **piece**: a key, a mode, a
pace, how bright it sounds, and a round of four chords. The Westwood is a warm
dorian, the Heartland an open mixolydian, the Greywood and the Highmoor slow
aeolian over a low drone, Sunward a bright major, the Brightwater a lydian,
Redstep and Ashfall phrygian, Lowfen dark and slow, a town a little livelier
than the woods round it, and a dungeon almost nothing but a hum. Four voices
play the round a little differently every time: a pad swelling across each
bar, a bass under it, sparse plucked chord tones, and now and then a short tune
stepping through the scale from a note of the chord. One round in five is
played thin, pad and bass only, so it breathes. Everything goes through a
reverb whose impulse is generated decaying noise.

**It follows you.** Where you stand picks the piece (a town within 70 m of its
edge, otherwise the region), and the change waits for the next bar line, so it
turns rather than cuts. **In a fight** a second layer eases in a beat at a
time — a drum on the beat, a skin on the offbeats, a driving bass on the same
chords, the pace a little quicker — and eases out again when you are out of
combat; a bar was too slow a step to answer the first blow.

Notes are queued on the audio clock a third of a second ahead each frame, so a
hitch never makes it stumble. Levels were set by rendering it offline and
measuring: about −37 dB of RMS in quiet places and −34 dB in a fight, well under
the sound of a blow. It has its own slider on the Esc menu (Music, kept per
browser) and mutes with everything else.

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
| **Fen Wretch** | Lowfen, Brightwater | **spit**: hangs back at 8 m, spits down a 12 m lane | Close the distance — it backs away, until you are within 3 m and it is caught, then it stands and fights — or dodge sideways |
| **Cinder Wisp** | Ashfall | **pulse**: swells, then bursts in a ring | Two Strikes kill it; get out of the circle before it goes |
| **Cairn Golem** | ruins, Redstep, Highmoor | **slam**: huge, slow, wide | Can't be staggered and barely shoved; read it and move |

Each has a rare **signature drop** found nowhere else (Greywolf Mantle, Tusk
Charm, Fenwater Phial, Emberheart, Cairnstone Maul), kept out of the random
loot pool. The client gives each its own procedurally animated body, windup
sound and blow effect — a spit flies, a pulse bursts, a slam shakes the camera.

### Variants and hunting grounds

A quest can only point at a place if what it asks for lives in one. "Kill
five wolves" on a map where wolves live everywhere is a quest with no
direction, so a **variant** (`variants.ts`) is a kind's body and fight with its
own name, colour and size, and multipliers on health and damage — and each
lives in exactly one **hunting area** (`OstraDefinition.areas`) and nowhere
else. The area's camps are one in the middle, a level up, and the rest round
it; the generated camps keep out of it, so it is theirs alone. The first four
are Daso's work:

| Area | Variant | Of | Levels |
| --- | --- | --- | --- |
| The Woodcutters' Path, south-west | Pathstalker | wolf, lean and brown | 2–3 |
| The Webbed Thicket, north-west | Thicket Weaver | spider, small and green | 3–4 |
| The Felled Ridge, east | Rootbound Risen | Risen, mossy and bigger | 5–6 |
| Silkstrand Hollow, off the Westroad | Silk Snatcher | spider, wine-red | 6–7 |

Nothing new to learn in a fight: the kind decides the body, the AI and the
effects. The size travels as `Enemy.scale`, like an elite's, so a bigger body
is never a smaller hitbox; the id travels as `Enemy.variant` for the name and
colour. A quest objective names a variant (`variant` on kill and collect) to
ask for it rather than the whole kind.

The state machine is Idle → Wander → Chase → Return.

Two details carry most of the feel. **Deaggro is wider than aggro** (20 m vs 13 m
for a Risen), because with a single radius a player standing exactly on the line
makes the creature start and stop every tick. And **Return is a latch, not a
distance test** — see below.

**Grey creatures leave you alone.** Something grey to you (`difficultyOf`, too
far below you to pay XP) does not notice you at all until you give it threat —
by hitting it, or its camp, which rallies. A level-12 walking back through the
Westwood used to be nipped at by every Pathstalker on the way; picking a fight
with the weak is now a choice, as in WoW.

Creatures live and die with their room and are never persisted, so an emptied
Ostra repopulates the moment somebody walks back into it.

## Combat

Left click swings. The server resolves everything; the client only draws —
but it draws *immediately*, which is most of what makes a hit feel like a hit.

### Action controls

The mouse is the camera all the time, with no button held, and the buttons are
the fight: **left click Strikes, right click is the class's guard** — a
**block** for the Warrior (`ClassDefinition.guard`; a lighter class would dodge
on it instead), and the rest of the kit stays on **2–6**. It is the browser's
pointer lock (`mouselook.ts`): the game holds the mouse whenever you are in
the world and nothing is open, lets go while **Alt** is held or any window is
(the pack, the map, a dialogue, the menu), and takes it back when the window
closes. Locks are only granted on a gesture, so it asks on a click or on the
key that closed a window; when it wants the mouse and has not got it, a line
in the middle of the screen says to click. Esc is the browser's way out of a
lock, so losing it for no other reason is treated as Esc and opens the menu —
unless the window lost focus (Alt-Tab), which is not asking for anything.

The turning is done here, one browser mouse event to one turn, rather than by
Babylon's orbit camera: its device layer reports each movement twice, and its
inertia would carry every flick ten times as far as the hand went. Its drag
input is switched off while the mouse is held and back on with a cursor, so
the character screen still orbits on a drag. Up and down turn at the same rate
as left and right, and the rate is the player's (Esc menu, Mouse
sensitivity, kept per browser).

**Strike swings on the move** — every 0.7 s, three to a chain — where it used
to be a 0.9 s standing cast every 1.8 s; its damage scaled with the time between
swings, so a fight lasts as long. You move at 72% while an ability key is held
and 45% behind a guard (`ATTACK_MOVE_FACTOR`, `BLOCK_MOVE_FACTOR`), read from
the input itself so the prediction agrees. Sunder and Cleave keep their short
plant-your-feet windups.

**Block** (hold right click) takes 80% off a blow from the front — within about
70° of where you face, judged from the creature or a slam's centre — and says
"Blocked". Behind a guard you cannot swing, and Fervour drains rather than
builds. `Player.blocking` is replicated, so everyone sees the guard go up.

**Aim is the camera.** The reticle is the middle of the screen and never
moves — the mouse moves the world under it, which is what makes it feel like
the mouse — and goes red when Strike would connect. The camera orbits a point
over your head (`AIM_LIFT`) rather than your body, so the middle of the
screen looks past you: at the usual downward angle the reticle lands on the
ground about 2.5 m ahead, where a swing does, and further out as you look up.
Your own name is hidden while the mouse is held, since it would sit on the
reticle. (The first reticle was a point pinned 6 m ahead and projected; it
slid down the screen as you looked up, and hid behind your back looking
level.) Without a locked target, a blow leans toward
something within ~40° of where you look (it was ~75° for tab-targeting). Tab
still locks a target, which turns your swings toward it; clicking things in
the world (a creature to target, a player to invite) is for a free cursor.

**Hits are lag-compensated.** A client renders creatures 150 ms in the past, so
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
doesn't bend the direction you are walking. With a target locked (Tab) every
cast turns to face it while in reach. Without one, a blow leans toward whatever
is within ~40° of where you are looking, and Heroic Throw toward anything within
~17° — reach is its reward, accuracy its price. Aim is computed
from the *drawn* positions, which are exactly what lag compensation rewinds to,
so aiming at the picture is aiming at the truth.

### Making a hit feel like a hit

Before this, a hit was a creature swelling 16% for a tenth of a second and a
health bar getting shorter. Now, all of it on the client and none of it
deciding anything:

- **Bodies animate** (`rigs.ts`). Every figure is built around shoulder, hip and
  waist pivots and posed procedurally each frame: walk cycles from measured
  speed, a three-beat Strike chain, an overarm throw, a Sunder slam, a Cleave
  sweep, a shield shove, a war cry, flinches, falls, and creatures climbing out
  of the ground when a camp wakes.
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

Heavy blows (every third Strike, Sunder, Shield Bash) **stagger**: the windup is
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
radius, so a Heroic Throw from the edge of range is never free. Hitting one member
of a camp brings camp-mates within 7 m. A creature that leashes home heals to
full — otherwise it could be chipped down from the edge of its leash one pull
at a time.

### Recovering

Health used to never regenerate; since it persists, the only way to heal was to
die. Now, out of combat, you regain 5% of your cap per second, and Fervour
drains away (see below). "In combat" means you dealt or took damage in
the last 5 s, *or something is hunting you*. It is replicated on the player,
because sprint is denied in combat and the client has to predict that.

**Some attacks need you standing still.** Swinging while strafing made every
telegraph trivial: you could keep hitting while walking out of each blow. Now,
as in WoW, an ability has a **cast time** (`castMs`) or is instant. Sunder
(0.5 s) and Cleave (0.7 s) take time and must be performed standing: they will
not start on the move, and moving (or jumping, dodging or raising a guard)
before one lands cancels it — nothing paid, cooldown given back, "Interrupted"
on the cast bar. Strike, Heroic Throw, Shield Bash and Battle Cry are instant
and work on the run. You are
never rooted; getting out of the red just costs you the swing.

A cast is counted in **input steps, not milliseconds** (`castSteps`). The
server advances it once per input it applies (`stepCast`) and the client once
per input it sends (`stepLocalCast`), so both land it — or cancel it, on the
first input with movement — at the same input; wall-clock time would let
latency decide. Cost is paid when it lands; aim follows the target throughout.
A cancel is also sent as `castCancelled` in case the two ever disagree.

Cooldowns are enforced server-side, so holding the button auto-attacks and
spamming it gains nothing.

### Jump, dodge and Second Wind

**Space jumps** — about a metre, two thirds of a second in the air. Height
used to be derived from where you stand and nothing else, which is why
nothing vertical could drift between client and server; a jump needs a
vertical speed (`Player.vy`), so it is carried in the state and reconciled
like position. On the ground `vy` is exactly zero and `y` is exactly the
ground, so walking is still derived; only a jump, or walking off something
taller than `STEP_DOWN`, is integrated (`fall` in `movement.ts`). Collision is
still flat: a jump clears nothing but looks like it should.

**Q dodges**: a dash of about four metres in a quarter of a second, where you
are steering or straight back if you are not, every five seconds. Blows that
land while it lasts miss (`isDodging`, checked in `damagePlayer`, so a slam
misses too). Like a cast, it is counted in input steps — `dodgeLeft` and
`dodgeCooldown` on the player, reconciled — so the client predicts the exact
dash the server runs. It is sent for one step per press, not held.

A jump or a dodge cancels a cast with a cast time, as walking does
(`isMoving`).

Both have a pose (`posePlayer` in `rigs.ts`). In the air a knee comes up and
the arms go out, the legs reaching for the ground on the way down, with a dip
at the knees on landing; the blend follows `vy`, eased so leaving and meeting
the ground never snap. A dodge goes low and leans into the dash — hard
forward, a little back from a backstep, sideways to the side — legs split,
arms flung behind the motion. Everyone else's `vy` and `dodgeLeft` arrive raw
while their body is drawn `INTERP_DELAY_MS` in the past, so the client logs
each change and reads it back that much later (`lateMoves`); read straight,
their legs would tuck before they left the ground.

**R is Second Wind**: 35% of your health back at once, usable in a fight,
every 40 seconds — every class's, and the stand-in for potions until there
are consumables to carry. The server gates it on its own clock; everyone near
sees it land. The client mirrors the same constant purely so the swing draws
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

## Levels, classes and abilities

### Levels

**One bar, 1 to 100** (`levels.ts`). Killing things fills it, and so does
helping people. The first few levels come in minutes; after that each costs a
little more than the last, compounding, so the top is a long road rather than
a wall. The curve is fitted against a rough pace of ninety kills an hour,
counting travel and rest:

| Level | Kills that level takes | Time to reach it |
| --- | --- | --- |
| 2 | 5 | ~3 minutes |
| 10 | ~18 | ~1 hour |
| 30 | ~50 | ~9 hours |
| 60 | ~140 | ~40 hours |
| 100 | ~420 | ~150 hours |

Quests pay on top, so the real numbers are kinder. `killsPerLevel` is a power
of the level, for the early ramp, times a compounding 2.1% a level, which is
what takes over later; `XP_TABLE` is built from it once and rounded to tens so
the numbers on the bar are readable. A kill of your own level pays `40 + 10 ×
level`.

**What a kill pays depends on the gap** (`levelXpScale`): +5% a level for
something above you (up to five), falling away linearly below you to nothing
once it is **grey** — five levels down at the start, widening by one every ten
levels. Without that, the fastest way to level 100 would be the rabbits by the
Gate Circle. An elite pays eight times a kill. XP goes to **everyone who fought
the creature** (anyone with threat on it), and to their party close by (see
Parties), in full, the same rule quests use, so grouping never costs anyone;
an elite's goes to everyone it credits (see Rare elites). A level-up restores your health and is seen by everyone nearby.

**The banner says what the level gave.** For a long time it named new
abilities and nothing else, so a level that taught none said nothing but a
number, and the Might, the Vigour and the sword in your pack that had just
become wearable all went unmentioned — a reward you are not told about is
hardly a reward. It now reads out the attributes the class grew, the health
that Vigour bought, and how many carried items the new level lets you wear,
then the abilities. All of it is derived client-side by `levelGains` from the
same pure functions the server grows a character with — `baseStats` diffed
against the level before, and `canWear` asked twice ("wearable now, and not a
level ago") rather than comparing `requiredLevel`, so it stays true to the
rule if `canWear` ever grows a second condition — which means the banner
cannot claim a point the character screen does not show. An attribute that
did not move is left out, because a class with fractional growth gains nothing
in some attribute on some levels and a "+0" is worse than silence. The banner
lives longer the more it has to say: its animation ends at zero opacity, so
the duration is what the reader actually gets.

Creature levels share the scale, so the number over its head is a
comparison, coloured WoW-style by `difficultyOf`: grey (beneath you, pays
nothing), green, yellow (a fair fight), orange, red.

This replaced **proficiency**: a separate 0–1000 scale for every spell, weapon
family, armour weight and trinket, each rising only by use, and each item's
stats falling away below its level in its skill. It was true to the vault's
"like a muscle" line, but in play it asked you to keep a dozen bars in your
head, made every new weapon a step backwards, and never produced the moment an
MMO is built around. Characters from before it start again at level 1 in Daso,
with their gear (see Old saves).

### Classes

A class decides which abilities sit on your bar and when each is learned, what
they are paid with, and which attributes grow as you level (`classes.ts`).
Everything else — gear, stats, the fight — is shared. Characters carry a
`classId` from creation, so the second class is a table entry and a picker on
the title screen, not a migration. There is one so far:

**The Warrior.** +2 Might and +2 Vigour a level after the first. Level 1 gives
nothing, so a new character is exactly what the game was tuned around; the
rate is what keeps a Warrior of level N, in gear of level N, about as many
blows from killing a creature of level N as a new one is from a Risen, since
creatures grow too (`levelHealthScale`, +30% of base health a level).

| Key | Ability | Learned | Fervour | Shape | Role |
| --- | --- | --- | --- | --- | --- |
| Left click | **Strike** | 1 | builds | 2.4 m cone | Best sustained damage, on the move; every third blow staggers |
| 2 | **Heroic Throw** | 3 | builds | 13 m narrow cone | Open before it closes |
| 3 | **Sunder** | 6 | 35 | 4.6 m ring | The answer to being surrounded |
| 4 | **Cleave** | 10 | 20 | 3.2 m half-circle | Everything in front of you |
| 5 | **Shield Bash** | 15 | 15 | 2.6 m cone | The interrupt: staggers one foe |
| 6 | **Battle Cry** | 22 | — | self | Fills Fervour, and it does not drain for 10 s |

The whole kit is on the bar from the start; what you have not learned is shown
locked, with the level that brings it, so the bar is also the road ahead. The
server checks `knowsSpell` on every cast. Every ability still resolves through
one `isInArc()` call; a ring is an arc of 2π, and a self-cast is a spell with
`targeting: "self"`, so adding one is a table entry rather than a new code path.

### Fervour

Rage, rethought. It does not come from being hit or hitting so much as from
**staying in the fight**: while you are in combat it rises on its own, 4 a
second (full in 25), and a landed Strike or Throw stokes it by 4 more. **While
it is high, everything you do hits harder** — up to +35% at full. Out of combat
it drains at 20 a second, and on death it is gone.

The big abilities **spend** it. That is the decision rage never asked of you:
a spender hits with the Fervour it is cashing in, but every blow after it is
weaker by what it cost, so the question is always whether to cash in now or
keep it for the long fight. Battle Cry skips the ramp once a minute.

It is the class's `resource`, replicated on the player as `resource` /
`maxResource` — one pair of fields rather than one per resource, because a
character only ever has the one. Mana is still there in `combat.ts` (fed by
Spirit, slowed by heavy armour) for the first caster class; the Warrior's
character sheet says it has no use for Focus or Spirit.

### Where the levels are

Everyone starts in **Daso**, in the Westwood, among people with work for them.
Each Terra region has a **band of levels** (`RegionDefinition.levels`), and
within it the level rises with distance from Daso — from the bottom of the band
on the side nearest home to the top on the far side (`levelAt`, spread over
`levelReach`). So the map gets harder the further you go, in steps you can see:
crossing into the Greywood is a jump, as a new zone should be, and every region
has an easy edge to arrive on and a hard heart. The minimap shows the band of
wherever you stand.

| Region | Levels |
| --- | --- |
| Westwood (Daso) | 1–5 |
| The Heartland (the Gate Circle) | 5–10 |
| Greywood | 10–15 |
| Ashfall | 11–16 |
| Lowfen | 13–18 |
| Highmoor | 15–20 |
| Sunward | 18–23 |
| Brightwater (Fanshona) | 22–27 |
| Redstep | 25–30 |

Past Terra, the Gates: the Ascendant is meant for 30–65 and Barals for 65–100.
Both are still courtyards; their camps sit at 35 and 68–72 as placeholders.
Packs grow with level up to three extra creatures and no further.

### Fighting above your level

Levels used to change only a creature's numbers, and a telegraphed fight
does not care much about numbers: every blow is painted on the ground, so a
level-4 Warrior could step out of a level-20 Risen's overhead for as long as
it took, and did. In WoW the level itself fights you, and so it does here
(`LEVEL_GAP` and `levelGapEffect` in `combat.ts`). For each level a creature
stands above you:

| | Per level | Limit |
| --- | --- | --- |
| Your blows miss it ("Miss") | +6% | 45% |
| Your blows that land do less | −10% | 25% of their worth |
| Its blows do more | +15% | ×2.5 |
| Your guard takes less off | −10 points of 80% | 30% |
| Its windup is shorter | −6% | 55% of its own |
| It notices you further off | +1 m | +8 m |

and from **three levels up your heavy blows no longer stagger it**, which is
most of how a Warrior handles a Risen. One level up is a hard fight you should
win; three one you will probably lose; five and more you run from. A miss is
still an attack — it adds threat and rallies the camp — so swinging at
something far above you is how to find out. Nothing is given back the other
way: out-levelling a creature already makes it pay and hurt less.

The windup is scaled by the level of whoever it swings at, and sent in
`enemySwing` as always, so the painted wedge fills at the true speed. The
Hollow King (level 10) is two levels up on a party of level-8s, which is
meant: it is a party's fight.

### Difficulty by Ostra

Creatures scale per Ostra too, so travel is a difficulty choice rather than a
change of palette. Level stacks on top (`levelHealthScale`,
`levelDamageScale`). Item level, loot rarity and XP all follow it. Under all of
it, every creature has **×1.8 health and ×3 damage** (`CREATURE_HEALTH_SCALE`,
`CREATURE_DAMAGE_SCALE`): the first tuning made three of your own level an easy
fight, and three should be one you might lose.

| Ostra | Creature damage | Creature health |
| --- | --- | --- |
| Terra | ×0.6 | ×1.0 |
| Ascendant | ×1.0 | ×1.2 |
| Barals | ×1.6 | ×1.5 |

## Loot and equipment

Creatures drop gear. It lands where they fell, hovers as a faceted crystal
coloured by rarity, and is picked up by walking over it — no key, because one
less thing between killing something and being rewarded for it. Mythic and
above also stand a pillar of light over themselves, visible across a fight.

### Items are generated, not listed

An item is four numbers — `{ base, level, rarity, seed }`, stored and sent as a
short key like `heavyHead.120.2.1k3j9a` — and **everything else is derived from
them** by `describeItem` in `items.ts`, identically on both sides: its name, its
stats, its line of history. That keeps an item small enough for a JSON column
and a replicated string on the ground, gives effectively endless variety, and
lets the client draw a full tooltip for something it was only ever sent the key
of. Only the server rolls items (`packages/server/src/loot.ts` — the one place
`Math.random` touches an item); the client only describes them. Derivation uses
the integer hashes in `noise.ts`, so every engine agrees on every stat.

A **base** is a kind of item: 18 armour pieces (three weights × head, body,
legs, feet, hands, cloak), nine weapons (sword, greatsword, axe, greataxe, mace,
maul, dagger, staff, wand), two off-hands (shield, focus), and neck, ring and
sigil. Each says which family it belongs to, which stats it tends to roll, and the
nouns and materials its names are built from. A handful are **named** — the
pre-generation items, kept by name because "Gatecutter" is worth finding in a
way a generated sword never quite is — and five are **signatures**, one per
creature, found nowhere else.

**Names and lore** come from `itemNames.ts`, picked by the seed from fragments of
the setting: the places on the Ostra table, the people of Daso and Fanshona, the
creatures that actually roam. Rarer items get longer stories — a common gets one
plain line, a rare an origin and a detail, mythic and above a coined name, an
epithet and a history. The lore points at things a player can go and find.

### Slots, rarity, stats

Thirteen slots: head, neck, cloak, body, hands, two rings, legs, feet, weapon,
off hand, sigil (the old "trinket"), and soul. Two-handed weapons and anything
in the off hand exclude each other; daggers go in either hand. `wear()` is
shared, so the client previews exactly what the server will do.

| Rarity | Stats | Where from |
| --- | --- | --- |
| Common | 1 primary | anything |
| Uncommon | 2 primaries, 1 secondary | anything |
| Rare | 2 primaries, 2 secondaries | anything |
| Mythic | 2 + 3, bigger budget | elites, dungeons, raids |
| Legendary | 2 + 3, bigger still | elites (very rarely), dungeons, raids |
| World | 2 + 4 | raids — and meant to be one in the realm |
| Ostra | 2 + 4 | raids — and meant to belong to one Ostra |

**Ordinary creatures stop at rare** (`SOURCE_ODDS` in `loot.ts`). A top tier any
wolf might drop is not a top tier; mythic and up have to come from something
that is itself rare. None of those sources exist yet, so for now the top of the
table is only seen through the dev loot command.

**Colour is earned with the levels.** The same 70/25/5 everywhere had level-1
wolves by Daso dropping blues, spending the moment a rare is meant to be before
a new player knows what a green is. An ordinary creature below level 5 drops no
rare at all, and its share grows to the full 5% by level 12; greens start at
40% of theirs and are whole by level 7. What is thinned away goes to common
(`youngCreatureShare`). Quest rewards keep their own rarity — green in Daso,
a first blue from the Hollow Barrow.

Four **primary** stats — **Might** (adds to Strike), **Focus** (adds to spells
that cost mana), **Vigour** (health, 3 per point), **Spirit** (mana, and its
return) — and four **secondaries**: **Critical**, **Recovery**, **Leech**, and
**Armour**, which is mostly inherent to armour and shields. Items show flat
numbers, deliberately — "+12 Might" stays legible next to Strike's 18 — and the
character sheet shows what they are worth as percentages, with diminishing
returns (`stats.ts`). Armour is measured against the **attacker's** level: the
same breastplate turns a Risen's swing at the Gate Circle into a bruise and does
much less at the edge of the world, or armour would be worth the same
everywhere.

The three armour weights are different builds, not different colours. Cloth
rolls Focus and Spirit with a bigger budget and little armour; light rolls
Might, Critical and Leech; heavy rolls the most armour and Might, and **each
heavy piece slows mana by 5%** — heavy armour has to cost something or everyone
wears it.

**Gear is class-specific.** Each class lists the families it uses
(`ClassDefinition.families`): a Warrior wears plate and leather, swords, axes,
maces, daggers, shields and jewellery — cloth, staves, wands and foci are a
caster's. Nothing else drops for them (a drop is rolled for whoever earns it,
so each credited player in an elite fight gets gear for their own class), is
offered as a quest reward or by a vendor, or can be put on (`canWear` checks
class as well as level). Worn gear a class cannot use goes back to the bag on
load, where a vendor will take it. A wand dropping for a Warrior was not loot,
it was litter.

Stats are class-aware too. An item rolled for a player carries their class as
a fifth part of its key (`heavyHead.120.2.1k3j9a.warrior`), and rolls its
primaries only from what that class uses (`ClassDefinition.stats`) — a
Warrior's gear is Might and Vigour, never Focus or Spirit, and a future
caster's ring from the same base will be the other way round. A base that
loses most of its list (a dagger without its Focus) is topped up with the
class's own stats, so it can still roll two. Keys from before classes have
four parts and roll from the base's whole list, as they always did, so no
saved item changes. The character sheet only lists the attributes the class
uses.

**Power** is one number for "is this better": an item's stat budget, and the sum
of what you wear (after effectiveness) for the character.

### Rare elites

One named creature per Terra region (`elites.ts`) — Old Greymuzzle in the
Greywood, the Crownless King at the Broken Crown, Mother Silt in the
Brightwater shallows, eight in all — each by a ruin or deep in its region. An
elite is its kind drawn and collided larger (`Enemy.scale`, read on both sides
through `scaledArchetype`, so a bigger body is never a smaller hitbox), three
levels above the ground it stands on, with several times the health and more
damage. It is the **first source of mythic and legendary loot** (`source:
"elite"`), always drops two or three items, and shows gold on nametags, and
violet on the minimap and world map at any range while it lives (they were
gold there too, and eight gold dots that never went away read as quest marks
that would not clear) — it is announced to the
whole Ostra, so hiding where it is would only make you search.

Each has **signature moves**, data in its `abilities` list, resolved by the
room's `stepElites`. There are three kinds:

- **Summon**: at set health thresholds its kind's allies join the fight, like
  Old Greymuzzle's pack or the Crownless King's court. They drop nothing and
  vanish when the fight ends.
- **Slam**: it roots itself and a ring is telegraphed around it for over a
  second, then it lands on everyone still inside. The ring is an ordinary
  telegraph with a full-circle shape, so the client draws exactly what the
  server tests.
- **Enrage**: below a threshold it hits harder and swings more often.

Each move comes with a line everyone nearby sees. A fight that ends (everyone
dead, gone, or the leash snapped) resets it: summons vanish, triggers re-arm,
and it walks home and heals, so it cannot be worn down in shifts.

**Credit is earned, not touched.** Everyone who dealt at least 10% of its
health, or who took at least 25% of their own health in its blows (holding its
attention is work too), gets the elite's XP and their own drops, reserved for
them for as long as they lie there. One hit, or only the killing blow, earns
nothing. Summoned creatures pay no XP of their own; the elite's covers them. Credit is read
from the creature's threat table, which is exactly the damage each player dealt
it this fight, and that table clears on a reset.

When one falls, the whole Ostra is told who brought it down, and it stays gone
for its own window — 15 to 35 minutes — before it wakes again, announced to
everyone. The timers live at module level on the server rather than on the
room, because a room is torn down when its last player leaves and a timer that
died with it would let anyone kill an elite, log out, log back in and find it
fresh. A server restart does still reset them. `unsafeElites()` holds them to
the same "never near somewhere safe" rule as camps, at boot.

### Item level and required level

Item level is **creature level × 10**, a nudge for a dangerous Ostra, ±4 of
spread, and a long upward tail — one drop in twelve is 10–30 levels better, one
in a hundred 40–120. That tail is what makes a drop worth looking at. Item level
sets the stat budget, and keeps a fine scale so two swords from the same wolf
can still be told apart.

Every item asks for a **character level** (`requiredLevel`): its item level
back on the creature scale, so a level-12 wolf's ordinary drops are wearable at
12. Below that you cannot put it on — the server refuses the equip, and the pack
shows it dimmed with its level in red. At or above it you get every point. The
lucky one from the long tail is something you carry until you have grown into
it. Item level stayed where it was, rather than moving to the 1–100 scale,
because it is inside every item key in every save; required level is derived
from it.

Rarity odds are tilted by the Ostra's danger and the creature's level
(`dropDanger` in `loot.ts`), so Barals pays better than Terra — up to level 30
and no further, or everything past the Gates would drop nothing but rares.
Without the tilt, a harder place is pure downside and nobody would go.

### The character screen

**I** (or **C**) swings the camera round to face you and closes in, framed left
of centre; the slots fly out of your body along lines tied to where each is
worn — the helm to the head, a ring to each hand, the weapon to the blade — and
the pack slides in from the right. It is the body you walk around in, not a
portrait of it: the lines are re-projected from the rig's joints every frame, so
they stay attached through the camera's swing, your idle sway, and any orbiting
you do by dragging the empty space. Your facing is held still while the camera
has moved, or looking at yourself would turn you round. While it is up, the
near clip plane is pushed out and the grass at your feet is cut, because a low
camera otherwise looks at your legs through a hedge.

The heading reads your level and class. The tooltip shows what an item gives,
the level it asks of you, and what wearing it would change — computed through
the same `wear` and `characterStats` the server uses, class base stats
included. Click to wear, drag onto a slot, right-click to choose a hand or
destroy; click a worn item to take it off. The Abilities tab is the spellbook:
every ability of your class, what it costs, and the level each is learned at.

### Old saves

Characters from before gear was generated load with their fixed items converted
(`migrateItem` in `loot.ts`): each old id becomes a generated item of a matching
base and rarity at level 10–30, and the old weapon/armour/trinket slots become
weapon/body/sigil. Worn gear is re-worn through `wear()` on load, so a save can
never describe a body the rules would not allow; anything that does not fit —
including anything above the character's level — goes back in the bag, **even
past its size**. An overfull bag stops you picking things up until you make
room, and can still wear things out of it; losing a worn item to a rules
change would be worse. (The load used to trim the bag back to 30, which threw
the overflow away the second time you logged in.)

Characters from before levels start at **level 1, as Warriors, in Daso**, with
everything they owned: the migration that adds the `level` column moves every
character to Daso once, since level 1 among the Gate Circle's level-7 Risen is
no start at all. The old `skills` column is left in place, unread.

A drop belongs to whoever earned it for 25 seconds — drawn small until the claim
lapses, so you can see something fell and that it is not yet yours. Without it,
the first person to walk over a drop takes it whoever did the killing, which is
fine alone and immediately unfair the moment two people fight the same camp.

`maxHealth` and `maxResource` are replicated on the player rather than derived
client-side, because equipment itself is private — without them the client
could not draw its own bars. Taking armour off clamps current health to the new
ceiling rather than scaling it: it should never kill you, and never leave you
above your cap.

## Quests

Villagers ask for help, and pay for it. A **"!"** over someone's head means
they have work for you, a **"?"** means something is ready to hand back, and a
grey **"…"** means something of theirs is under way. Walk up and press **E** to
talk. Quests under way are tracked under the minimap, and **J** opens the log,
where a quest can be abandoned.

A quest is data in `quests.ts`: who gives it, who takes it back, what must be
done, and what it pays. There are four kinds of objective, the things the
world can already tell apart:

- **kill** N of a creature
- **slay** one particular elite
- **collect** N of something only some of a creature carry
- **visit** a place
- **gather** N of something lying about in a place

**Gathering** is the first quest that is not a fight. Moonwort in a glade,
salt sacks spilled along a road, heartwood from a blighted grove, candle stubs
round a barrow: each lies about its circle, one part of it lit in its colour
(the moonwort's flower, the candle flames) over a faint patch of glow, and
**E** picks one up. They first stood under four-metre threads of light, which
found every one from the edge of the place and turned the errand into walking
from beam to beam; the map's circle says where to look, and looking is the
errand. Where they lie is a pure function
of the quest (`gatherSpots` in `gathering.ts`) — on dry, gentle ground, clear
of every tree and rock — so the client draws exactly what the server accepts
and nothing is sent or saved. The server checks the quest is under way, you
are within reach and alive, and that you have not emptied that spot in the
last minute; a spot you picked is gone for you alone and grows back after
`GATHER_RESPAWN_MS`, so two players on the same errand never race for the last
sack. Only whoever has the quest sees them. Creatures may live there too —
the Risen walk in Brenna's grove — but they are in the way, not the errand.

**Where each quest wants you is on the maps and the compass**
(`questMarks.ts`): the hunting area of a variant it asks for, highlighted in
gold with the quest's name; a gold marker for a place to visit or an elite to
find (for a dungeon's boss, the Gate down to it); and a "?" over whoever takes
it back once it is done. Only what is left is drawn — a quest half done points
at its other half — and marks beyond the minimap's edge are notches on its
rim, pointing the way. An objective for a whole kind has no single place and
gets no mark, which is the argument for variants.

Hunting grounds are drawn **only while a quest sends you to one**, named under
its gold ring. They used to be ringed and named on the world map always, so
the place to find Pathstalkers was findable without the quest — but a ring on
a map reads as "you have business here", and players saw the Webbed Thicket
marked who had never spoken to Osk.

**Someone with work is on the maps too**, as a gold "!" where they stand, and
on the compass. The mark over a head is only any use once you can see the
head: a new character woke at the Daso Stone facing away from the inn, with
nothing to say there was work sixty metres behind them. With nothing under
way, the tracker says so and where — "4 people in Daso have work for you" —
rather than disappearing.

A quest handed back to someone other than its giver is a delivery. Collected
things are counted, not carried, because thirty slots of wolf fangs would be
clutter the loot system has no use for. A kill counts for **everyone who fought
the creature** (anyone with threat on it), not just the killing blow, so a
group never has to take turns at the last hit.

A quest is **pitched at a level**. It is offered from three levels below it
(`QUEST_LEVEL_LEAD`), so a "!" means something you are ready for, and its level
is shown in the dialogue and the log in the same difficulty colours as a
creature's.

**Rewards** are gold (the first currency, and nothing sells yet), one item of
your choosing from two or three, and XP. The item choices come from
`questRewardItems`, which is a pure function of the quest and the character's
id. The client shows exactly the choices the server will honour, and asking
again cannot reroll them; they are of the quest's level. Each card says what
wearing it would change against what you have on now — the character
screen's own comparison (`compareWorn`), so the two cannot disagree; a vendor's
stock carries the same line. A list of stats alone left you opening the pack
to remember what was in the slot. The XP is a **share of
a whole level at the quest's level** (`xpShare` — half a level for most, a
whole one for Mother Silt), scaled like a kill by how far you are from it
(`questXp`), so a Daso errand done at 20 is grey and pays nothing. A share
rather than a number, so re-tuning the curve cannot leave every quest paying
too much or nothing.

The client decides nothing. Accept, abandon and complete are requests the room
checks against the same rules: whether you can take it, whether you are within
talking range of the right villager, whether it is done, and whether there is
room in the bag. The log (`{ active, done }`) and gold are saved with the
character. The first content is a Daso chain (wolves, spiders, fangs, the
driver missing on the Westroad, and four gathering errands), a long delivery that walks you to
Fanshona, and a Fanshona chain that ends with Old Caddo sending you after Mother
Silt.

## Parties

Up to five players who have agreed to play together. **P** opens the party
window: invite someone by name, or click them in the world and choose
"Invite to party"; the leader (★) can remove members, and anyone can leave.
Members get frames down the left of the screen — health for anyone in the
same room as you, and where the rest are ("in The Hollow Barrow", "offline")
— and show green on their nametags, the minimap and the world map, with
their names readable from much further off. A party of two that loses one is
disbanded.

A party changes three things:

- **Kills are shared.** Anyone in the party within 60 m of a kill, alive,
  counts as having fought it — XP and quest objectives both — so nobody has
  to tag every creature to keep up. The same goes for an elite's credit: a
  party member standing in the fight shares it without having to reach the
  damage share that strangers need.
- **Dungeons are entered together** (below).
- **Loot is not shared.** Pickup is by walking over, so a shared claim goes to
  whoever runs through first. Drops stay the killer's for their claim, as
  before; a party already shares the XP.

The party lives on the server at module level (`packages/server/src/parties.ts`),
not on a room, for the same reason elite timers do: its members walk through
Gates, go down into a dungeon while the others are still on the road, and log
out and back in. Rooms tell it who is online and where (`arrive` / `depart`)
and give each presence a `send`, so an invitation reaches someone in whatever
room they are standing in. A Gate joins the new room before it leaves the old
one, so a departure from a connection that is no longer the character's is
ignored. Someone who drops out stays in the party for three minutes, so a
reload does not cost them their group; a server restart disbands every party.

## Chat

**Enter** opens a line at the bottom left. Two channels: **say**, heard by
anyone in the same room within 60 m and drawn in a bubble over the speaker's
head, and **party**, heard by the whole party wherever each of them is. A line
goes to the party by default when you have one — that is who you are playing
with — and aloud otherwise; `/s` or `/p` at the start picks for that line. The
log fades when closed and comes back while typing.

The server trims each line, replaces control characters, caps it at 200
characters and refuses more than five lines in six seconds; the client only
ever puts it on screen as text, never HTML. That is the whole of moderation so
far — there is no mute, report or filter (see TODO).

## Dungeons

Instanced places for a party, built as small Ostras (`OstraDefinition.dungeon`,
and `dungeons.ts`), so they get everything a Gate and a room already do — the
transfer, camps, elites and loot. The first is **the Hollow Barrow**, entered
through a Gate in the gap of a barrow in the west woods, a few minutes past
the last house in Daso. It is pitched at levels 7–10, and Basan Log's quest
sends you down into it.

**One copy per party.** Dungeons are defined as a second room name
(`DUNGEON_ROOM_NAME`) matched on `instance` as well as `ostraId`. Stepping into
its Gate sends you to whichever copy a party member is already in, even if they
went in before the party formed, or a fresh one (`dungeonInstanceFor`). There
is no stored instance: a copy lasts exactly as long as its room, which is
disposed — and so reset — when the last player in it leaves. Matchmaking for
that room name is open to any client, so the Gate leaves a **grant** naming the
instance, and the room refuses anyone without one.

**Nobody is saved inside a dungeon.** Stepping in saves you *outside* its Gate
on Terra, and the grant carries where you stand inside; logging out, or the
server stopping, leaves you in front of the barrow rather than in an instance
that no longer exists. That is also why a dungeon's `onJoin` reads position
from the grant rather than the store.

**What is killed stays dead** until the instance resets: bodies are cleared
away instead of standing back up after 12 s. The boss is an elite
(`elites.ts`, with a fixed `level`, since a dungeon has no regions to read one
from) whose timer is the instance's own and never runs out. It drops from the
dungeon table (`SOURCE_ODDS.dungeon`: rare, mythic, legendary), two items for
each player it credits, and its fall tells the instance the dungeon is cleared.

**It is rock, not a ruin.** The layout is a run of rooms and passages along one
straight spine (`carve`), and everything outside them is solid: a block either
side of each space, reaching to the edge, and a cap at each end — so a narrow
passage's blocks are the end walls of the rooms either side, and nothing has to
be worked out where they meet. The blocks are ordinary box colliders in
`buildingColliders`, so a passage predicts exactly like walking round a house in
Daso. One straight spine because creatures have no pathfinding: they walk
straight at their quarry and slide along walls, and a line of doorways is what
lets a pull come to you rather than wedge itself in a corner. Passages are
fourteen metres, so a camp in one room cannot see into the next.

It is darker (`OstraPalette.light`) and foggier than anywhere else, lit by
torches: an unlit flame and an additive halo each, flickering, because the
standard material lights a mesh by four lights at most and there are twenty
torches. The map paints the rock, so it shows the rooms.

Tuning, first pass: creature damage is Terra's (×0.6) with a little more health
(×1.15) — nobody can heal yet, so what makes it a party's fight is how much
there is and how the King fights, not blows that take half a bar. The Hollow
King has about 10,000 health: about 75 seconds for two ungeared level-8
Warriors, 50 for three. He summons his court at 70% and 40%, slams a 6 m ring
every eleven seconds, and enrages at 20%. He is 1.7 times a Risen and no
bigger: a Risen swings from `attackRange`, which grows with scale faster than a
Strike's reach to its surface, and at 1.9 he stood just out of reach of every
blow aimed at him.

The barrow, its King and Basan's quest were invented for the game, like
Fanshona; the vault's story of the voice Basan hears is left where it was — the
King is what is in the barrow, not what is calling.

## Vendors

Loot drops far faster than it can be worn, and thirty slots fill in a few
camps. **Mott** the smith in Daso and **Corran** the trader in Fanshona
(`vendor: true` on the villager) buy anything in your pack — one item at a
time, or the whole bag with **Sell all**, which asks once because it empties
it. Worn gear is never sold. They pay an item's power over eight, times its
rarity's worth (a rare is 2.5 commons, a legendary 8), and never less than one
gold (`sellPrice` in `vendors.ts`).

They also sell plain gear: one common piece per slot, at your own level,
weighted to what a Warrior wears — plate and leather, blades, a shield, a ring
and an amulet — at four times what they would pay for it. Nothing a lucky drop
will not beat, but always something, so a bad run of drops never leaves a slot
empty. Rarer gear is found, never bought. Like quest rewards, the stock is a
pure function of the vendor and your level (`vendorStock`): the client shows
exactly what the server will sell, and it changes only when you level.

## Goods and the satchel

Things you gather rather than wear — fish first, and timber, ore and food as
other trades arrive — are **goods** (`goods.ts`), and they are nothing like
items. An item is one of a kind: a key with a seed, a rolled name, stats, a
place on the body. A perch is a perch. So goods are plain counts by id, kept
in a **satchel** beside the pack (the Satchel tab on the character screen),
never in its thirty slots.

Stacks in the pack were the obvious alternative, and wrong twice over. Every
pack operation — sell, wear, destroy, pick up — finds an item by its key, and a
key whose count changes stops being the same key, so all of them would have had
to learn about stacks. And a full pack is what sends you back to town after a
run of camps; a trade should not be stopped by it. (Quests count what you
collect rather than carry it for the same reason.)

Each good has a `stack`, the most one character carries — a hundred of a fish.
Past it a catch is let go, which keeps anyone from hoarding a lake. Any vendor
buys goods, one kind at a time or the whole satchel at once, without asking
first: a perch is a perch, and there will be more of them. The satchel is
saved as a JSON blob of counts, and a load keeps only ids this build knows,
held to their stacks.

## Trades

Fishing is the first **trade** (`trades.ts`); logging, mining and cooking are
meant to follow. Each has a level of its own, 1 to 50, earned only by doing it.

That looks like the proficiency system combat gave up (see Levels), and on
purpose it is the one place that system's idea survives. Combat went to one
level because a dozen bars trained by use were a dozen things to keep in your
head and every new weapon was a step back. A trade is the other case: it is
something you choose to take up, apart from fighting, and "I am a good fisher"
is exactly what a bar should say. **A trade pays no character XP**, so an
afternoon at the lake is never a faster road to 30 than the camps.

What is saved is the total XP ever earned in each trade, not a level and a
remainder: the level is read back off the curve, so if the curve is retuned,
everyone lands where their work puts them. Gathering something at your level
pays `10 + 2 × level`; below you it pays less, and nothing twelve levels down
— minnows teach a fisher of 20 nothing. At your own level every time, the
curve is about 140 catches to 11, 1,000 to 31 and 2,900 to 50. Trade levels
are private, like the pack: a level-up is announced to you and nobody else, and
the Satchel tab shows each trade's bar above what you have gathered.

### Fishing

Face open water and press **E**. A line goes out onto the first water deep
enough to fish (`FISHING_DEPTH`, 35 cm) straight ahead, between 3 and 12 m;
after four to twelve seconds — a third quicker at Fishing 50 — something bites,
and a **click** or **E** hooks it. Too soon pulls the line in empty; too late
and it got away. Moving, jumping, dodging, blocking, an ability, the heal, a
fight or a teleport all reel the line in.

**Which water it is decides what lives there.** Every lake names its `waters`
in `ostras.ts` — Daso's millpond and the heartland pond are *ponds*, the
Lowfen's are *meres*, the Brightwater's are *lakes*, and Fanshona's own lake
keeps the Lanternfin — and the Morning Sea is the sea. Each has a table in
`fishing.ts` of fish, the Fishing level each wants, and how often it bites.
Your level decides three things: whether anything there bites at all (every
water has a lowest fish, and below it the cast is refused *with the level it
wants*, so a beginner at the sea is told to find a pond rather than left
waiting forever — the sea wants 10); which fish you can catch, a fish just
within reach biting at a third of its weight and all of it five levels later;
and how long a bite waits for you, 850 ms plus 12 per level.

**The server decides everything, and none of it is predicted**, because
nothing about fishing moves anyone. The cast point is the shared `castPoint`,
so the prompt at the water's edge says exactly what E will do; the server
works it out again from where you really stand and face. It times the bite,
and the click is judged against its own clock — so the window it keeps carries
another 400 ms (`HOOK_LATENCY_MS`) for the round trip the bite has to make to
you and the click has to make back. What is caught is rolled on the server from
`catchChances`, like loot, into the satchel; a full stack lets the fish go but
still pays the XP.

**Everyone sees everyone fish.** `Player` replicates `fishing` (none, waiting,
bite) and where the bobber sits, and `Anglers` (client `fishing.ts`) draws every
line from that alone, yours included: the rod out of the same hand as the blade
(which is put away), the throw, the bobber arcing out and plopping in, the line
sagging from the rod's tip, ripples, and on a bite the bobber jerking under
and the arm pulled at. A bite is nothing more than that state changing, so a
friend on the far bank sees yours dip. A fishing body turns to face its
bobber whatever the camera does. While a line is out, or a cast has just been
asked for, the left button hooks rather than Strikes — and stays out of the
fight until it is let go, or a held click would swing the moment the line
came in. The sounds are synthesised like the rest: a whoosh and the line
singing off the reel, a plop, a double splash for a bite, the ratchet.

`fishingProblems()` checks at boot that every lake names waters that exist and
is deep enough to fish at its middle, and logs `[fishing]` if not.

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
hills, ridged mountain ranges in patches, a wall of peaks at the rim, and a sea
along one side (see A world eight kilometres wide). The
noise is built from `Math.imul` hashing and plain arithmetic only — **no
`Math.sin`, `Math.hypot` or `**` anywhere in `noise.ts`, `terrain.ts` or
`worldgen.ts`**, because the spec lets each JS engine round those differently
and Node and every browser must agree to the last bit. (The previous sum of
sine waves was fine over 80 m and would have tiled visibly over 8 km.) Height
is **derived** from the final x/z each step rather than integrated, so there is
no vertical velocity to drift out of sync.

The ground is the one surface that is not voxels, and cannot be: the height is
a pure function the server walks on too, so quantising it would put what you
see and what you collide with a step apart. Its **colour** is celled instead.
A grain texture is generated into a canvas at boot from the same `hash2` as the
rest of the world — half-metre patches you read as ground, eighth-metre grain
inside them matching the scenery, and one patch in thirty a stone or a scrape.
Its UVs are world metres rather than mesh-local, so the pattern belongs to the
ground and not to the chunk, and two chunks meeting have no seam. Because a
texture can only ever darken, the mean it comes out at is divided back out of
the material, or every field would lose a tenth of its light. The channels
drift slightly apart per patch, which is what lets a patch read as *drier*
rather than merely dimmer. Between the kilometre-wide dry bands and those
half-metre cells there is now a third scale — clumps a few metres across —
because that is the size a hillside is actually uneven at. The map skips it:
at a kilometre to the inch it would only look noisy.

Flat zones blend the hills away under a settlement or waystone, levelled to
whatever the natural ground is at their centre, and mountains are kept 320 m
clear of them — a town should never have a cliff for a back wall. The visible
mesh is built from the same function and flat-shaded, coloured through vertex
colours: grass by height, drier patches, darker under woods, stone where steep,
snow on peaks, dirt on roads.

### Hills, mountains, and the valleys between

For a long time Terra was, in effect, a table. Measured: half the ground was
flatter than 3%, the typical rise and fall within 300 m was 7 m, and the
highest ground inside the rim was 97 m. The layers *said* 7.5 m hills and 95 m
mountains, but fractal noise uses a fraction of its nominal range — two
octaves sit between about 0.3 and 0.7 — so the hills really moved ±2.5 m, and
the mountain mask was tested raw against its coverage and almost never let a
range reach full height. And a 1 km haze hid what little there was.

Now the typical rise and fall within 300 m is about 45 m, the tallest peaks
near 500 m, and roughly an eighth of Terra is steeper than 45°. What does it:

- **Real hills** (`hills` 45 m over 380 m, four octaves) on broad basins and
  uplands (`continent` 80 m over 2.2 km), scaled per region by `relief` — the
  Westwood and the Heartland at 0.6, so the first hours are rolling woodland,
  and the moor, the Greywood and the mesas well above 1.
- **Mountain massifs** (`mountains`, 280 m): a ridged multifractal (`massif`,
  `noise.ts`'s `ridgedMulti`) over a warped plane. Each octave's detail is
  weighted by the ridge beneath it, so crests grow spurs and broken tops while
  valley floors stay smooth, and the warp makes ranges branch rather than loop.
  The plain ridged noise it replaced was an even tangle of worms. The mask is
  spread over its real range first, and brought in over a wide band and
  squared, so a range rises out of foothills; brought in narrowly, every massif
  stood behind a rampart of cliff.
- **Ranges along the region borders** (`borders`, `borderRange`), so each
  region is a country of its own with high ground round it, as a zone in a big
  game is. They follow their own, wilder warp of the region centres — Terra's
  nine centres sit near a three-by-three grid, and ranges on the true borders
  were a grid of embankments — and a ridged crest that sinks away to hills in
  long stretches of its own accord. A border is the mean of its two regions'
  `walls`, so the home regions are fenced gently.
- **Valleys along the roads** (`valleys`). Mountains, border ranges and the
  mesas' terraces all fall away within a few hundred metres of the straight
  line between each pair of a road's places (and of a line out to each ruin no
  road reaches). This is what makes it all work: every waystone, town and ruin
  hangs off a road, so every one stays in walkable low country; roads are routed
  afterwards and keep to the valleys because the going is cheapest there; and
  the massifs end up standing in the middle of the road network's loops, with
  the wildest country beyond the roads, towards the rim. An earlier attempt cut
  passes only where roads crossed a border, and left waystones inside massifs at
  the bottom of craters — the flat zones had cleared the mountains round them.
- **Blends that never jump.** Lift, relief and mountain strength used to be
  blended between the nearest two regions only, and wherever the runner-up
  changed hands near a three-way junction the ground stepped. Invisible on
  seven-metre hills; a line of cliffs once a moor stood thirty metres up.
  `regionWeights` now fades every region out over REGION_BLEND beyond its own
  border, and the border ranges take the greatest over every neighbour, for the
  same reason. Region borders also wander more (REGION_WARP, two sizes), so
  regions stopped being tiles.

**Steep ground stops you.** A step that climbs steeper than `MAX_CLIMB_GRADE`
(1:1, 45°) is refused inside `moveBody`, judged over the step itself. Going
down is never refused — mountains should keep you out, not keep you in. The
same machinery as the sea's depth limit: a pure function of position, so the
client predicts it exactly (at a 150 ms round trip, walking into a cliff and
along it gave no corrections at all), and a refused step keeps whichever of its
x and z halves is allowed, or is turned along the slope, so you slide along a
cliff foot instead of sticking. Creatures are stopped the same way.

**What keeps it honest.** Roads are never routed up anything steeper than 0.6
between grid cells, and `roadProblems()` walks every road a metre at a time at
boot and logs `[road]` if any stretch is steeper than anyone can climb or runs
through deep water — so a road you can walk end to end is also the proof that
what it joins can be reached. Camps are not placed on slopes over 0.45, trees
not on cliffs over 0.8, and waystones, ruins and the two towns blend back to the
hills over 60–130 m, not 26–50, so none sits on a shelf with banks you cannot
climb. Nudging the land meant re-pinning Fanshona's lake road once more, and
exposed a tree ring whose gap across north (-22° to 10°) only ever honoured its
eastern half.

**Seeing it.** The haze thinned from 0.0018 to 0.0012 so a range stays in sight
for a kilometre and a half, and the horizon mesh went from 64 m quads to 32 m:
a 64 m facet across a 400 m mountain cut each ridge into a few slabs, and a
mountain range is mostly its skyline. It costs about 0.6 s to build on arrival
and a few milliseconds each time a detailed chunk streams in and its quads are
cut out of the horizon.

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

**Everyone starts here**, by the Daso stone (Terra's `spawn`), and creature
levels are measured outward from it: the woods round the town are level 1, the
Gate Circle 7. A new character wakes among people with work for them rather
than alone in a ring of standing stones.

Fourteen buildings round the yard — **The Felled Oak**, the timber shed, the saw
pit, a smithy, a storehouse, a cart shed and the loggers' houses — with a ring
of woodland that actually blocks you, opened where the roads come in. All three
roads (the Westroad from the north-east, the Greywood track north, the Ash road
south) run into the yard as its streets, pinned by a point at the edge of town
so the router cannot send one through the timber shed. Seven villagers say
something when you come near. Basan Log is there, before the events of *The
Daso Voice*:

> There's a sound in the west woods. Like someone saying my name.

`settlements.ts` is plain data. Buildings become colliders on both sides;
props and villagers are drawn client-side and cost no bandwidth.

**Towns are laid out relative to their doors.** Each building turns its door to
the square (`building`), and the people who work there and the barrels by the
door are placed *from the door* (`atDoor`) — so they cannot end up inside the
wall. The first layout used typed-in coordinates and put five of Daso's
villagers inside or against buildings, barrels inside the inn and a road
through the Weighhouse; nobody noticed, because none of it breaks anything.
`settlementProblems()` now checks every town at boot and logs `[town]`
warnings: villagers in walls, buildings overlapping, roads or water under a
building, props and trees inside one.

`unsafeSpawns()` checks camps against **settlements** as well as spawn
points — and caught a Risen camp reaching within 10.6 m of Daso on its first
run, which would have put zombies in the streets of the one calm place.

Buildings are drawn in `settlement.ts`: a stone footing, walls, and a gabled
roof of two slabs over a solid triangular body whose ends are the gables. The
body is a hand-built prism whose faces check their own winding — the roofs
were once built from rotated boxes with the tilt the wrong way round, and every
house in the game wore a V. Houses get framed doors and windows, chimneys, and
half-timbering; the halls and a fixed third of the houses have lamps lit.

## Fanshona

The second settlement, in Brightwater, Terra's lake country: a stone market
town of thirteen buildings facing its lake — a harbour square with the
Weighhouse and the trading house across it from one another, market stalls, a
well, fishers' houses up the spine of the town, a boathouse, the Lantern House
at the south end, a dock running out over the water and boats moored beside
it. Its two roads decide the layout: one comes up the town's spine to the
square and on along the shore, the other in from the west to the waystone, and
nothing is built across either. Built as Daso's
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
woodland, boulders and ~5000 creature camps from `wilds.seed`, lazily, one 64 m
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
meres). Each is also a band of creature levels, rising away from Daso (see
Where the levels are). A region is the nearest of nine centres, with borders
warped by noise so they meander and blended over ~200 m so none is a line. The same
`TerrainRegion` data bends the height function — a moor is lifted, a fen
pressed flat, mesas terraced, ranges raised along the borders — so the land and
its look agree about borders (see Terrain, Hills, mountains, and the valleys
between).

**Lakes** are shallow — you wade, there is no swimming — and carved by
`heightAt` with a wandering shoreline and a bank that always rises above the
water. The client draws the surface as a sheet covering every cell where the
ground dips below it, so the water follows the carved shore exactly.

**The Morning Sea** runs down Terra's eastern edge, where the sun comes up —
below Sunward's plains, the end of the Brightwater and Redstep's mesas.
Nobody draws its shoreline. From `from` (2900 m out, wandering 250 m either
way) the land is tipped down, gently and then steeply, and the coast is simply
wherever that falling ground passes below the sea's level. So the sea comes in
up a low valley, a hill stands out into it as a headland, and one in the
shallows is left as an island; the coast follows the country instead of a
line. There is no rim of peaks along that side, and the north and south rims
sink as they reach the water, so they run out into it rather than stopping in
a cliff at the edge of the world. Ground less than 1.6 m above the water is
sand: no trees, no grass, and the seabed under the shallows darkens with
depth, which is most of what makes the water on top of it read as shallow or
deep.

That shape makes the client's job easy. Everything short of where the land
starts falling stands above the sea, and everywhere past it, ground below the
level *is* sea — so the surface is one sheet running from there out to six
kilometres past the edge, under the land where there is land, and the horizon
is water rather than the end of the world. The one thing that breaks it is a
hollow below sea level just short of where the fall begins: water would stand
in a straight edge along the line. `seaProblems()` samples for exactly that at
boot and logs `[sea]`. The water's colour is darker than a lake's for the same
look — a flat sheet facing the sky takes the whole of the sun and the sky
light, and at a lake's colour the sea came out a cyan the haze could not pull
back.

**Deep water is a wall.** There is still no swimming, so a step that would
end deeper than `MAX_WADE_DEPTH` (1 m, waist-deep; 1.3 was nearly over a
person's head) is refused inside `moveBody`, for players and creatures alike.
It is a pure function of position, like the edge of the Ostra, so the client
predicts it exactly — measured at a 150 ms round trip, walking into it and
along it gave no corrections at all. A refused step keeps whichever of its x
and z halves stays shallow, so you slide along the drop-off; where the
drop-off runs on a diagonal both halves go deeper, and then the step is turned
along the line of equal depth instead. Something already out too deep may
always move shallower, or it could never come back. Camps are kept a metre
clear of the water all round, so nothing scatters into the sea.

**Roads are routed, not drawn.** Each road lists only the places it must pass
through; A* over a 32 m grid finds the way between them, where cost climbs
steeply with gradient (roads go round mountains), water is nearly forbidden
(round lakes), broad noise-driven "bad going" is avoided (so even gentle country
gets long sweeping bends), and ground an earlier road covers is cheap (so roads
merge into a network with junctions and loops rather than running side by
side). The result is smoothed into curves and given a gentle wander. Thirteen
roads, about 36 km, route in ~0.2 s at startup on each side.

For a long while "nearly forbidden" was the opposite. `waterDepthAt` answered 0
away from any water, which reads as "right at the waterline", and the router
counts a cell wet within 40 cm of water (`WET_MARGIN`, the drowned margin
where nothing grows) — so every field on Terra was wet and cost thirty times
over, and a lake's bank was the one cheap ground in the world. The roads went
looking for water: the west road ran 80 cm deep through Daso's millpond, and
the lake road through Fanshona's lake. It also made A*'s distance estimate
worthless against a map priced thirty to the metre, which is where most of
the old 0.35 s went. Now `waterDepthAt` is -Infinity where no water reaches,
and only the ground around water counts. Most roads did not move at all; the
ones that did came off the water, the ring lane now actually runs by Sunward
Ring instead of borrowing two other roads to get there, and the lake road had
to be pinned where it leaves Fanshona on the shore side, or the new way to the
Brightwater Stone went back round the south of town through two houses.

**Ruins** — a stone ring, a watchtower, a barrow, two spires, a sunken hall — are
landmarks with guardians. `ruinParts` places every stone deterministically, so
the server collides with exactly what the client draws.

**Collision is bucketed.** `MoveWorld.scenery` is a `SceneryIndex`; a body only
tests the 3×3 cells around it, in a fixed order so both sides sum contacts
identically. Without it, every body would test tens of thousands of trees
every tick.

**Creatures live where they belong.** Generated camps used to take their kind
from the region's odds alone, spread evenly over the land, so a Risen was as
likely in a meadow as a spider in a wood, and the world read as creatures
scattered on it rather than living in it. Now each kind has ground it suits
(`habitat` in `worldgen.ts`), and the region's odds only choose between the
kinds that would live there: spiders in thick forest, wolves at wood edges
and on the moors, boars on open grass, wretches by water and in the reeds,
golems on rocky slopes and by ruins, wisps in ash and on dry red ground, and
Risen in **blight**. Ground that suits nothing in its region keeps a camp only
a fifth as often, so open country is quieter than a wood full of spiders
rather than full of whatever was left over. The Heartland and the Westwood
gained boars for their fields.

**Blight** (`blightAt`) is where the dead walk: round every ruin and the Gate
Circle, all of Ashfall, and slow patches of old burial ground on about a tenth
of the rest, kept away from the towns. Trees in it grow dead, so a Risen's
country shows before the Risen does. Hunting areas and the hand-placed camps
are unchanged: they are placed for a reason already.

**Camps sleep.** A camp's creatures only exist while a player is within 190 m
of it, and are removed 20 s after nobody is within 280 m and nothing in it is
fighting. Terra holds ~21000 creatures; the server simulates and replicates the
dozens near someone.

**The ground streams.** Detailed 64 m chunks (2 m quads) are built nearest-first
around the camera, two per frame, out to 330 m, each with a skirt to hide seams.
Beyond that, one coarse mesh of the whole Ostra at 64 m per quad is the
horizon — with its quad cut out wherever a detailed chunk stands. Trees, rocks
and grass are thin instances, one draw call per kind. Fog and a sky dome fade
the far ground into the sky; the depth buffer is reversed, because a normal one
runs out of precision long before eight kilometres.

**Arriving is quick.** Entering Terra used to freeze for nine seconds before
the first frame, and seven of those were towns: every copy of a voxel model
was meshed again — each wall panel, barrel and fence run — though the models
were already cached. `voxelMesh` now keeps each model's mesh by anchor and
grain, so a town pays once per distinct piece. And towns and lakes are no
longer built on arrival but when you come within 1.5 km of them
(`DEFERRED_RANGE`): whatever is in range on the first frame is built then,
since you are standing in it, and anything later one a frame. Fanshona is a
second of meshing four kilometres from Daso, past the fog. From click to the
first frame is now about three seconds in a dev build; the ground still takes
a few more to stream in around you.

**You can find your way.** A minimap (north up, with an N on the rim to say
so), a compass strip with bearings to landmarks, and a world map on **M** that
paints itself in tiles in the background from the same `groundTone` as the
terrain. The world map zooms on the scroll wheel about the point under the
cursor, up to 24 times, and drags to pan. Waystones have light columns that
show above the haze.

A map of eight kilometres is only worth opening if it answers the questions a
player actually has, so it carries four things beyond the ground:

- **A legend.** Every glyph on the map, named, under it. A dozen symbols
  nobody has been taught is a puzzle, not an instrument.
- **A scale bar, and the view's width** ("8.0 km across"). Without them
  nothing says whether two places are a stroll apart or a quarter of an hour,
  and at 24× zoom the very same picture means 300 m.
- **Every region's level band**, under its name, coloured against your own
  level by the same `difficultyOf` that colours a nameplate. That one line is
  the whole answer to "can I go there yet", which is the only question a
  levelling player has about a far-off place.
- **Names placed by priority.** Fourteen stones, two towns, eight ruins, nine
  regions, the hunting grounds and whatever your quests want are far too many
  names for one screen. Glyphs are all drawn first, then names in order —
  regions, quests, towns and stones, then ruins — and a name whose box would
  overlap one already drawn is dropped rather than printed on top of it. Ruin
  and hunting-ground names wait for 1.6× and 2.2× zoom. Region names are drawn
  before the marker that says where you are, so the one region you most want
  named is not the one that loses.

Zoomed well in it draws detail from the minimap's fine tiles rather than
stretching its own, over the coarse whole-Ostra tiles as an underlay — a
detailed tile costs real time to paint, and a blurry map is worth a great deal
more than a black one while you wait. Whichever cache the map is drawing from
is the one that gets the painting budget.

### Waystones, and travel between them

Fourteen standing stones, each a point some road has to pass through. They are
landmarks first — on the maps, on the compass, lit by a column visible over
the haze — and they are where you wake after dying.

They are also the fast travel network, and **walking to one is what unlocks
it**. Come within `WAYSTONE_ATTUNE_RANGE` (16 m) of a stone and it wakes to
you; stand within `WAYSTONE_USE_RANGE` (9 m) of any stone and **E** offers
every stone you have woken, nearest first, with its region and level band.
Travel is instant and free: Terra takes fourteen minutes to cross at a sprint,
and charging for the alternative would only mean walking. What it costs is
having been there.

Because every stone is on a road, the network you have walked is the network
you can use, and the map opens up as you explore rather than all at once. The
stone you leave from does not have to be woken — you are standing in front of
it, there is nothing left to discover — but it does have to be a stone: this
is a waystone network, not a recall.

The server is the authority on all of it. It wakes stones on the same slow
tick as quest visits (a stone is 16 m wide to that check, and nobody crosses
that in a thirtieth of a second), refuses travel in combat or while dead, and
the woken list is persisted per character as `waystoneKey` keys — `terra:north`
and the like, because stone ids are only unique within an Ostra. The travel
window checks combat too, and greys itself out: a request that vanishes
without explanation is worse than a button that says why.

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
- **A thin economy.** Vendors buy items and goods and sell plain gear, but
  nothing repairs or trades between players, gold buys nothing else, and there
  is nowhere to store items beyond thirty carried slots.
- **The top of the loot table is thin.** Elites drop mythic and legendary, but
  World and Ostra rarity need a raid, and none exist yet. World items do not yet enforce
  "one in the realm", Ostra items are not yet bound to an Ostra, and there are
  no Souls to find.
- **Gear does not change your body or your swing.** Strike is the same blade
  whatever you hold, Shield Bash needs no shield, and armour is not drawn on
  the rig.
- **Content stops at level 30.** Terra runs 1–30; the Ascendant and Barals are
  still courtyards with a camp or two at 35 and ~70, so the curve to 100 has
  nowhere to be climbed yet.
- **One class.** The Warrior. Focus, Spirit, cloth, staves, wands and foci all
  still drop, for a caster that does not exist yet.
- **No interest management.** Camps only exist near players, which keeps state
  small, but every active creature is still replicated to everyone in the
  room. With players spread across Terra that grows with the player count;
  Colyseus `StateView` (per-client filtering) is the fix.
- **Two settlements.** Daso and Fanshona; most of Terra is wilds. Fanshona's
  details are invented and unchecked against the vault.
- **Docks are scenery.** You wade beside Fanshona's dock, not along it.
- **No taunt, no group threat tools.** Threat is damage-based; there is no way
  to deliberately hold a creature off a friend.
- **Chat has no moderation.** Say and party channels exist, trimmed, capped
  and rate-limited, but nobody can be muted or reported.
- **Dungeons have no lockout.** Leaving empties an instance and the next trip
  down is a fresh one, boss and all, as often as a party likes.
- **Abilities are learned by levelling, not found.** The lore says spells come
  from scrolls and books and that the Library Ostracon holds them all; a caster
  class should probably learn that way rather than at set levels.
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
  Scenery and buildings are solid; players and creatures are not, to you.
- **The duplicate-character guard is per-room.** One character can't be in the
  same Ostra twice, but two clients racing could briefly hold it in two
  different Ostras.
- **Creatures reset.** Camps are never persisted; a sleeping camp wakes fresh.
- **AI has no pathfinding.** A creature walks straight at its goal and slides
  along whatever it hits. Generated camps sit in clearings, but a chase through
  thick woodland shows it.
- **Slopes do not slow you.** Anything up to 45° is climbed at full walking
  speed, and anything steeper not at all. You can jump, but collision is flat,
  so a jump clears nothing a walk would not.
- **Creatures do not path round mountains.** One chasing you across a valley
  stops at the foot of a cliff it cannot climb, rather than finding the way
  round.
- **Villagers are scenery.** They stand where they are put and say one line,
  and some give quests. No trading, no schedule.

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
