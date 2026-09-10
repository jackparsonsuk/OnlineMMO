# TODO

Ideas and known work, roughly grouped. Not a promise of order — the top of each
group is what would matter most. When one is done, delete it here and record the
design decision in README.md.

## Before this is public

- **Interest management.** Every awake creature is replicated to everyone in the
  Ostra. Fine for a handful of players; with twenty spread across Terra, most of
  each player's bandwidth is fights kilometres away. Colyseus `StateView`
  (per-client filtering) fixes it without changing gameplay.
- **Email verification and password reset.** An address is never proved, and a
  forgotten password is a lost account.
- **Tests for the shared invariants.** No tests exist; `npm run typecheck` is the
  only gate. Cheapest valuable set: `heightAt`/`sceneryCell`/`roadPaths` return
  identical results across runs, `applyInput` is deterministic, and
  `unsafeSpawns()` is empty.
- **Cross-room duplicate-character guard.** One character can't be in the same
  Ostra twice, but two clients racing could briefly hold it in two Ostras.

## Big features

The next large pieces of the game, roughly unordered. Several already have
smaller entries below; those are the first step towards them.

- **The main story: reopening the Gates.** The lore says the Gates were shut;
  the story is unlocking them, one at a time, each opening a new Ostra. Locked
  Gates stand in the world as the goal you can see and cannot yet take.
- **Quests.** Villagers stand still and say one line today (see below).
- **Dungeons.** Instanced, for a party; the first real source of mythic loot.
- **Raids.** Larger instances; where World and Ostra rarity come from.
- **Player houses.** Also the answer to "somewhere to store more than thirty
  items".
- **The other Ostras.** Ascendant and Barals are small hand-built maps next to
  eight-kilometre Terra; they need regions, roads and camps of their own.
- **Weather** (and day/night, below).
- **Fishing** — Fanshona is a fishing town on a lake nobody can fish.
- **Life skills.** Gathering and crafting (logging for Daso, mining, cooking,
  smithing), on the same 0–1000 proficiency scale as everything else.
- **Mounts.** Terra takes fourteen minutes to cross at a sprint.
- **Pets.**
- **Graphics redo.**
- **Parties and chat.** Nothing lets you group up or talk, and dungeons and
  raids need it. Parties should share loot claims and XP credit.
- **Trading, vendors and gold.** A currency, vendors in Daso and Fanshona, and
  player-to-player trade — until then the only thing to do with loot you don't
  want is destroy it.
- **Classes**, gating which armour and weapons you wear well and, with the
  weapon, which abilities you have.
- **World events.** The Black Tide breaking in; a camp spilling onto the road;
  a Cairn Golem walking between towns.
- **Achievements and a lore journal.** Every place found and every item's story
  collected — the world is the point of the game, so exploring it should count.
- **Guilds.**
- **Player-vs-player**, eventually: duels and an opt-in arena first.
- **Leaderboards per skill.** Everything already has a 0–1000 proficiency;
  "best Swords in the realm" is nearly free.
- **A death penalty.** Dying costs a walk from the nearest waystone and nothing
  else, so danger has no weight.
- **Music and ambience** — a theme per Ostra, a sound per region.
- **Bestiary.** Kill counts per creature, unlocking its lore and what it is weak
  to. Pairs with the lore journal.
- **Transmog.** Wear one item's look over another's stats — comes after gear is
  drawn on the body.
- **Seasonal events** through unique Gates that open for a season and close
  again, with their own small Ostra and limited cosmetics.
- **Moderation and anti-cheat tools.** A report button, mute, admin commands.
  Needed the day chat exists.
- **Server-side analytics.** Where players die, which items get destroyed, how
  long each level takes — how loot and proficiency actually get balanced.

### Lower tier / maybe

- **Ostra reputation.** Standing with Daso, Fanshona, the gods of the
  Ascendant, unlocking vendors, quests and cosmetics.
- **Spells from scrolls** (see below) as a life-skill-style find-then-train loop.
- **Housing trophies.** Mount rare drops and elite kills in your house.

## The world

- **Fast travel between waystones you have visited.** Needs discovery persisted
  per character. Waystones are already landmarks and respawn points.
- **Check Fanshona against the vault.** Its lake, dock, Weighhouse and everyone
  in it were invented for the game.
- **More settlements.** Vareto (Daso is "in the west of Vareto"), and something
  for the empty south and east — Terra is mostly wilds.
- **Rivers and bridges.** Roads already route round lakes; rivers would give
  them something to cross.
- **Walkable docks and bridges.** Fanshona's dock is scenery: you wade beside it.
- **Distant trees.** Trees appear at ~330 m where detailed chunks end; thicker
  haze now fades them in, but the horizon mesh has no trees and the far hills
  are hazier for it. Billboards or a coarse tree LOD on the horizon would let
  the fog thin out again.
- **Day/night and weather.** Terra is permanently mid-afternoon.
- **Unnamed Ostras.** The lore's small, beast-ridden Ostras, generated into the
  same shape as the named ones.
- **Slopes and jumping.** Terrain does not affect movement: you climb a 120 m
  peak at walking speed.
- **Swimming / deep water.** Lakes are deliberately wadeable because there is no
  swimming.

## Creatures and combat

- **Creature pathfinding.** Creatures walk straight at you and slide along
  whatever they hit, which shows in the new forests. The road router's A* is a
  starting point.
- **More from elites.** A unique named drop each; persist their timers (a
  restart resets them); give Ascendant and Barals theirs; a map hint once one
  wakes; an aura and a horn. Watch the tank rule for leeching — standing in the
  way of blows is enough for credit, which is right for a tank and cheap for
  someone who only wants the loot.
- **World events.** A camp that spills over, a golem that walks the roads.
- **Taunt and group threat tools.** Threat is damage-only; nothing lets you hold
  a creature off a friend.
- **Player-vs-player.** Possible but untested — `isInArc` only ever runs against
  creatures.
- **Creature persistence.** Camps are never saved; a sleeping camp wakes fresh.

## Loot and gear

- **Weapons that change how you fight.** Each weapon family should reshape
  Strike (a dagger fast and short, a maul slow and wide) and, with classes,
  bring its own abilities — Guild Wars-style, class × weapon. Weapon skills
  already train separately; only the swing is missing. Needs the worn weapon
  replicated so everyone draws the right swing.
- **More sources for mythic and up.** Elites drop mythic and legendary now;
  dungeons and raids are next, and the only way to World and Ostra rarity.
- **World items that are really one in the realm.** Needs a realm-wide registry
  of which World bases exist and who holds them, checked at drop time.
- **Ostra items bound to their Ostra.** Name them after it (the name already
  says "Shard of…") and make them stronger there.
- **Souls.** Very rare; one slot that affects everything else; grows with the
  player; replacing one costs what it had become. The slot is on the screen,
  empty.
- **Classes** gating which weights and weapons you can wear well.
- **Gear drawn on the body.** Helms, plate, the actual weapon in hand.
- **Sort and filter the pack**, and compare a ring against the weaker of the two
  you wear rather than whichever slot is first.
- **Balance pass.** Budgets, Vigour's health, armour's curve and the training
  ceiling are first-pass numbers in `items.ts`, `stats.ts` and `skills.ts`.

## Progression and economy

- **Spells from scrolls and books.** The lore says the Library Ostracon holds
  them all; here everyone starts with three.
- **An economy.** Vendors in Daso and Fanshona, a currency, trading between
  players, and somewhere to store more than thirty items.
- **Quests from villagers.** They stand still and say one line.
- **Grouping and chat.** No way to form a party or talk.

## Client and tech

- **Draw calls.** Every creature rig is ~10 meshes; a busy fight is several
  hundred draw calls. Merging each rig's static parts would cut it sharply.
- **Settings.** Key rebinding, volume, view distance.
- **Postgres store.** SQLite means one process per realm; `CharacterStore` exists
  so this is a swap, not a rewrite.
- **Minimap zoom** and waypoints you can place on the world map.
