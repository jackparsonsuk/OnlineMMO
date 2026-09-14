# Art to generate

Painted 2D art for the screens and the UI. The world itself stays voxels built
at runtime. Tick things off as they land in `packages/client/public/art/`.

## Style — decide once, apply to everything

Make **title-terra.webp first** and use it as the reference for everything
after it, so the set reads as one game. Suggested prefix for every prompt:

> Painterly fantasy illustration, muted earthy palette with warm gold light,
> soft volumetric haze, chunky blocky low-poly forms echoing a voxel game,
> no text, no logos, no watermark.

**Specs**

| Kind | Size | Notes |
| --- | --- | --- |
| Backgrounds | 2560×1440 (16:9), WebP | Keep the centre third quiet: the UI sits there |
| Ability icons | 256×256, WebP | One bold subject, centred, dark background, no frame or border (the game draws the frame), readable at 48 px |
| Portraits | 512×512, WebP | Head and shoulders, or the creature's head, facing slightly left |
| Logo | 2048×512, transparent PNG | Wordmark only |

Put the filenames exactly as written below; the code will look for them.

---

## Tier 1 — do these first

### Title screen

- [x] `title-terra.jpg` — **the key art.** A great stone Gate ring standing on
  a green hill at dawn, a wide wooded valley of Terra below, a winding dirt
  road, a small village with smoke from its chimneys far off, mountains in the
  haze behind. A lone armoured warrior with sword and shield on the path,
  small in frame, looking out at it. *In, at 2752×1536, with the logo painted
  in top right. The title screen's panel sits in the middle, so keep the
  centre quiet in any redo.*
- [x] ~~`logo.png`~~ — not needed while the logo is part of the title art.

### Ability icons (13)

- [ ] `icons/strike.webp` — a single sword slash, bright arc of steel
- [ ] `icons/charge.webp` — a shoulder-first warrior silhouette rushing forward, dust and speed lines
- [ ] `icons/cleave.webp` — a wide half-moon sweep of a blade, sparks at the arc's edge
- [ ] `icons/shockwave.webp` — a fist striking the ground, a crack and a wave of rock running away from it
- [ ] `icons/crushing-blow.webp` — a heavy sword raised overhead in two gauntlets, glowing with building force
- [ ] `icons/shield-bash.webp` — a round shield turning a blow aside, a burst of sparks
- [ ] `icons/heroic-leap.webp` — a warrior mid-leap against the sky, blade raised, a ring of dust below
- [ ] `icons/execute.webp` — a downward executioner's chop, a red glint on the edge
- [ ] `icons/whirlwind.webp` — a spinning ring of blades, a vortex of steel and wind
- [ ] `icons/battle-cry.webp` — a helmeted warrior roaring, gold sound rings bursting outward
- [ ] `icons/block.webp` — a shield raised square to the viewer
- [ ] `icons/dodge.webp` — a blurred figure sidestepping, afterimage trailing
- [ ] `icons/second-wind.webp` — a green breath of light rising from a chest, a leaf motif

### Loading screens (Gates and joining)

One per Ostra; Terra gets three and picks one at random.

- [ ] `loading-terra-1.webp` — **Daso in the Westwood:** a small timber village
  with an inn among tall dark trees, lanterns lit at dusk, a waystone glowing
  pale blue at the edge of town
- [ ] `loading-terra-2.webp` — **Fanshona:** a lakeside town at sunset, a long
  wooden dock, a tall Lantern House with a warm light, boats on still water
- [ ] `loading-terra-3.webp` — **the Highmoor:** purple heather moorland under
  a vast sky, a crumbling stone ring (the Broken Crown) on a rise, a hulking
  stone golem silhouetted on the ridge
- [ ] `loading-ascendant.webp` — **Ascendant Ostra, Realm of the Gods:** white
  marble terraces and colonnades floating among clouds, gold light pouring down,
  enormous statues of faceless gods
- [ ] `loading-barals.webp` — **Barals Ostra, Realm of Fire and Pain:** a black
  basalt wasteland split by rivers of lava, ash falling, a jagged fortress on
  the horizon, red sky
- [ ] `loading-barrow.webp` — **The Hollow Barrow:** a burial mound's stone
  doorway in the dark woods opening onto descending steps, cold torchlight
  inside, roots through the lintel

---

## Tier 2 — portraits of the rare elites (9)

Shown on the banner when an elite wakes or falls.

- [ ] `elites/silkmother.webp` — **Silkmother**, Queen of the Westwood Webs:
  a huge violet-black spider with many glinting eyes, webs and cocoons behind her
- [ ] `elites/greymuzzle.webp` — **Old Greymuzzle**, Alpha of the Greywood:
  a massive scarred grey wolf, white muzzle, one torn ear, snarling
- [ ] `elites/crownless.webp` — **The Crownless King**, Last Lord of the Broken
  Crown: a risen corpse king in rusted armour, a bare brow where a crown was,
  hollow glowing eyes
- [ ] `elites/silt.webp` — **Mother Silt**, She Who Waits in the Shallows:
  a bloated swamp wretch half-sunk in murky water, weeds for hair, green bile
- [ ] `elites/tuskbreaker.webp` — **Old Tuskbreaker**, Terror of the Sunward
  Grass: an enormous boar with one broken tusk, dry golden grass flying
- [ ] `elites/keeper.webp` — **The Anvil's Keeper**, Forged, and Never
  Finished: a towering red-stone golem, glowing seams, one arm still unhewn rock
- [ ] `elites/ember.webp` — **The Ember That Walks**, Last Fire of Cinder
  Spire: a humanoid wisp of living flame shedding cinders, a black spire behind
- [ ] `elites/abbot.webp` — **The Drowned Abbot**, Keeper of the Sunken Hall:
  a waterlogged monk in rotted robes, water streaming from his hood, a dead
  lantern in hand
- [ ] `elites/hollow-king.webp` — **The Hollow King**, Who Was Buried Standing
  (the Barrow's boss): a gaunt armoured king standing upright in a stone tomb,
  greatsword held point-down, grave dirt falling

---

## Tier 3 — region banners (9)

A wide strip behind the region's name as you enter it. **2560×640**, subject
along the bottom half, sky on top for the text.

- [ ] `regions/heartland.webp` — gentle green hills, stone walls, the central Gate Circle
- [ ] `regions/westwood.webp` — tall dark conifers, a timber road, webbed thickets
- [ ] `regions/greywood.webp` — misty grey pine mountains, a lone watchtower
- [ ] `regions/highmoor.webp` — high heather moors, bare crags, a stone ring
- [ ] `regions/brightwater.webp` — bright lakes and reed beds under a clear sky
- [ ] `regions/sunward.webp` — dry golden grassland, a stone ring on a rise, heat haze
- [ ] `regions/redstep.webp` — red rock terraces stepping down to the sea, an anvil-shaped spire
- [ ] `regions/ashfall.webp` — dark ash plains, a smouldering black spire, drifting embers
- [ ] `regions/lowfen.webp` — flat black-water fen, reeds, a sunken hall's broken tower

---

## Tier 4 — nice to have

- [ ] `death.webp` (2560×1440) — a fallen warrior's sword planted in the earth,
  a waystone's pale light in the distance
- [ ] `map-parchment.webp` (2048×2048, tileable) — aged parchment texture for the world map
- [ ] Creature portraits, 512×512, for a future bestiary: `creatures/risen.webp`,
  `void-spider`, `wolf`, `boar`, `wretch`, `wisp`, `golem`
- [ ] Quest-giver portraits for the dialogue window — list to come once the
  first batch is in and the style is settled
