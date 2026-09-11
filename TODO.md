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
- **More quests.** The system is in (`quests.ts`) with nine quests in Daso
  (level 3) and Fanshona (23). Levels 5–22 have none at all: quests for the
  Heartland and every region between the two towns are the biggest hole in
  levelling now, then a quest to each elite, repeatable bounties, and the Gate
  story as a chain.
  The system still lacks talk-to objectives, escorts, quest items you carry
  and use, and shared progress within a party (once there are parties).
- **More dungeons.** The Hollow Barrow (7–10) is the first; the system is
  in (`dungeons.ts`, instanced per party). One per band of levels, each
  reached from its region — and the Ascendant and Barals could open with one
  each before their open ground is built.
- **Raids.** Larger instances; where World and Ostra rarity come from. The
  dungeon machinery is most of it; raids need bigger parties.
- **Player houses.** Also the answer to "somewhere to store more than thirty
  items".
- **The other Ostras.** Ascendant and Barals are small hand-built maps next to
  eight-kilometre Terra; they need regions, roads and camps of their own. They
  are where levels 30–65 and 65–100 are meant to be earned, so until they are
  built the curve stops at 30.
- **Weather.** Rain and heavier fog, from the clock like day/night
  (`daylight.ts`) so it needs nothing from the server.
- **Fishing** — Fanshona is a fishing town on a lake nobody can fish.
- **Life skills.** Gathering and crafting (logging for Daso, mining, cooking,
  smithing), each with its own level — the one place use-based training might
  still belong, now that combat has one character level.
- **Mounts.** Terra takes fourteen minutes to cross at a sprint.
- **Pets.**
- **Graphics redo.**
- **More chat.** Say and party are in (`chat.ts`); an Ostra-wide channel,
  whispers, and the moderation below — mute and report first, since there
  is nothing today but a length cap and a flood limit.
- **Trading, vendors and gold.** A currency, vendors in Daso and Fanshona, and
  player-to-player trade — until then the only thing to do with loot you don't
  want is destroy it.
- **More classes.** The Warrior exists (`classes.ts`); a caster is next —
  mana, Focus and Spirit, cloth, staves, wands and foci all drop already with
  nobody to use them. Then a class picker on the title screen, and a decision
  on whether classes gate armour weights.
- **World events.** The Black Tide breaking in; a camp spilling onto the road;
  a Cairn Golem walking between towns.
- **Achievements and a lore journal.** Every place found and every item's story
  collected — the world is the point of the game, so exploring it should count.
- **Guilds.**
- **Player-vs-player**, eventually: duels and an opt-in arena first.
- **Leaderboards.** Highest level, first to 100, most elites felled.
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
  long each level actually takes against the curve's guess — how loot and
  levelling actually get balanced.

### Lower tier / maybe

- **Ostra reputation.** Standing with Daso, Fanshona, the gods of the
  Ascendant, unlocking vendors, quests and cosmetics.
- **Spells from scrolls** (see below) as a life-skill-style find-then-train loop.
- **Housing trophies.** Mount rare drops and elite kills in your house.

## The world

- **Fast travel between waystones you have visited.** Needs discovery persisted
  per character. Waystones are already landmarks and respawn points.
- **Check the towns against the vault.** Fanshona — its lake, dock, Weighhouse,
  Lantern House and everyone in it — was invented for the game. So were Daso's
  smithy, storehouse and cart shed and the people added with them (Mott,
  Brenna); the vault only gives Daso "a few small houses and an inn".
- **Towns that feel lived in.** Villagers stand still facing out of their doors.
  Idle animations, turning to face you when you talk, and a few walking a
  route (a hauler to the cart shed, a fisher to the dock) would do more for
  the towns now than more buildings.
- **More settlements.** Vareto (Daso is "in the west of Vareto"), and something
  for the empty south and east — Terra is mostly wilds.
- **Rivers and bridges.** Roads already route round lakes; rivers would give
  them something to cross.
- **Walkable docks and bridges.** Fanshona's dock is scenery: you wade beside it.
- **Distant trees.** Trees appear at ~330 m where detailed chunks end; thicker
  haze now fades them in, but the horizon mesh has no trees and the far hills
  are hazier for it. Billboards or a coarse tree LOD on the horizon would let
  the fog thin out again.
- **Lamplight at night.** Lanterns and windows glow but light nothing; a few
  point lights in town (mind the four-lights-per-material limit) would pool
  light on the street.
- **Unnamed Ostras.** The lore's small, beast-ridden Ostras, generated into the
  same shape as the named ones.
- **Slopes, and a jump that clears things.** Terrain does not slow you: you
  climb a 120 m peak at walking speed. You can jump, but collision is flat, so
  a jump clears nothing; low things (logs, fences) could be skipped when high
  enough in the air.
- **Swimming / deep water.** Lakes are deliberately wadeable because there is no
  swimming.

## Creatures and combat

- **Creature pathfinding.** Creatures walk straight at you and slide along
  whatever they hit, which shows in the new forests. The road router's A* is a
  starting point.
- **More from elites.** A unique named drop each; persist their timers (a
  restart resets them); give Ascendant and Barals theirs; an aura and a horn. Watch the tank rule for leeching — standing in the
  way of blows is enough for credit, which is right for a tank and cheap for
  someone who only wants the loot.
- **World events.** A camp that spills over, a golem that walks the roads.
- **Taunt and group threat tools.** Threat is damage-only; nothing lets you hold
  a creature off a friend. The Hollow King is where this will be felt first.
- **Healing.** No class heals, so every group fight is attrition; the
  dungeon's damage is held at Terra's for that reason. A caster, or even a
  bandage, changes what a boss can be.
- **Player-vs-player.** Possible but untested — `isInArc` only ever runs against
  creatures.
- **Creature persistence.** Camps are never saved; a sleeping camp wakes fresh.

## Loot and gear

- **Weapons that change how you fight.** Each weapon family should reshape
  Strike (a dagger fast and short, a maul slow and wide) and, with classes,
  bring its own abilities — Guild Wars-style, class × weapon. Shield Bash
  should probably want a shield. Needs the worn weapon replicated so everyone
  draws the right swing.
- **More sources for mythic and up.** Elites drop mythic and legendary now;
  dungeons and raids are next, and the only way to World and Ostra rarity.
- **World items that are really one in the realm.** Needs a realm-wide registry
  of which World bases exist and who holds them, checked at drop time.
- **Ostra items bound to their Ostra.** Name them after it (the name already
  says "Shard of…") and make them stronger there.
- **Souls.** Very rare; one slot that affects everything else; grows with the
  player; replacing one costs what it had become. The slot is on the screen,
  empty.
- **Gear drawn on the body.** Helms, plate, the actual weapon in hand.
- **Sort and filter the pack**, and compare a ring against the weaker of the two
  you wear rather than whichever slot is first.
- **Balance pass.** Budgets, Vigour's health, armour's curve, the XP curve,
  a Warrior's per-level growth and Fervour's numbers are all first-pass, in
  `items.ts`, `stats.ts`, `levels.ts` and `classes.ts`. Levels 30–100 have
  never been played at all; the creature and gear curves were only checked on
  paper that far.

## Progression and economy

- **Spells from scrolls and books.** The lore says the Library Ostracon holds
  them all; here abilities come with levels. A caster class could learn this way.
- **Level-up could say what it gave.** The banner names new abilities, but
  not the Might and Vigour, or the gear that just became wearable.
- **Rested XP, or something like it**, if the curve past 30 turns out to feel
  like a wall rather than a road.
- **XP in a group.** Everyone who fights a creature gets its full XP, and so
  does their party within 60 m. Kind to grouping, and cheap to exploit by
  tagging a stranger's fight; with parties in, "full within a party only"
  is now an option.
- **Dungeon lockouts.** Leaving resets an instance, so a party can clear the
  barrow for its King's drops as often as it likes. A daily lockout per boss,
  or loot only on the first clear of the day.
- **Party loot rules.** Drops stay the killer's; a party that wants to share
  has no way to. Round-robin or need/greed, once pickup is a choice rather
  than walking over it.
- **Party polish.** Pass leadership, a party marker on the world map for
  members in other Ostras, and summoning a member to the dungeon Gate.
- **Dungeon checks at boot.** Nothing checks a dungeon's camps against its
  rock: a camp placed in a wall scatters creatures into solid stone, which
  pushes them out wherever is nearest.
- **An economy.** Vendors in Daso and Fanshona, a currency, trading between
  players, and somewhere to store more than thirty items.
- **Gold has nowhere to go.** Quests pay it; nothing sells. Vendors first.

## Client and tech

- **Draw calls.** Every creature rig is ~10 meshes; a busy fight is several
  hundred draw calls. Merging each rig's static parts would cut it sharply.
- **Settings.** Key rebinding, volume, view distance, and invert-Y (mouse
  sensitivity is on the Esc menu already).
- **A class that dodges on right-click.** `ClassDefinition.guard` is there
  for it; only the Warrior (block) exists.
- **Block, shields and weapons.** Block works bare-handed; a shield could
  block more, and a two-hander less. Needs gear drawn on the body first.
- **Postgres store.** SQLite means one process per realm; `CharacterStore` exists
  so this is a swap, not a rewrite.
- **Minimap zoom** and waypoints you can place on the world map. (The world
  map zooms and pans now.)
- **Hunting grounds for the rest of Terra.** Four areas with variants round
  Daso (`variants.ts`); Fanshona's quests and every region past the Westwood
  still ask for whole kinds, so they get no map mark. One area and variant
  per quest, as the Daso ones are.
- **Consumables.** Second Wind stands in for potions; potions that drop, sell
  and sit on a key would replace or join it.
- **A jump and dodge pose.** The body lifts and dashes, but its limbs do not
  tuck or roll.
