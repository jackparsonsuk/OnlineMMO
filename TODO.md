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
- **Distant trees.** Trees pop in at ~330 m where detailed chunks end; the
  horizon mesh has darker ground under woods but no trees. Billboards or a
  coarse tree LOD on the horizon would fix it.
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
- **A boss per region.** Each ruin has guardians; a named, rare, much tougher one
  would give each region a goal.
- **World events.** A camp that spills over, a golem that walks the roads.
- **Taunt and group threat tools.** Threat is damage-only; nothing lets you hold
  a creature off a friend.
- **Player-vs-player.** Possible but untested — `isInArc` only ever runs against
  creatures.
- **Creature persistence.** Camps are never saved; a sleeping camp wakes fresh.

## Progression and economy

- **Spells from scrolls and books.** The lore says the Library Ostracon holds
  them all; here everyone starts with three.
- **An economy.** Vendors in Daso and Fanshona, a currency, trading between
  players, and somewhere to store more than twelve items.
- **Quests from villagers.** They stand still and say one line.
- **Grouping and chat.** No way to form a party or talk.

## Client and tech

- **Draw calls.** Every creature rig is ~10 meshes; a busy fight is several
  hundred draw calls. Merging each rig's static parts would cut it sharply.
- **Settings.** Key rebinding, volume, view distance.
- **Postgres store.** SQLite means one process per realm; `CharacterStore` exists
  so this is a swap, not a rewrite.
- **Minimap zoom** and waypoints you can place on the world map.
