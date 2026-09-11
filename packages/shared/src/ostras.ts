import { carve, type DungeonDefinition, type DungeonSpace } from "./dungeons.js";
import type { EnemyKind, SpawnGroup } from "./enemies.js";
import { DASO, FANSHONA, SETTLEMENTS, type SettlementDefinition } from "./settlements.js";
import {
  heightAt,
  type FlatZone,
  type LakeDefinition,
  type TerrainRegion,
  type TerrainSettings,
} from "./terrain.js";

/**
 * The Ostras the game currently knows about, and the Gates between them.
 *
 * In the fiction the Gates were shut down in Y1100 and the Ostracon has been
 * isolated ever since; this game is set at the moment they come back on, which
 * is why there are so few of them and why Terra is the only hub. Named Ostras
 * are hand-authored and persistent, like these. Unnamed Ostras — the small,
 * beast-ridden ones — are meant to be generated into this same shape later, so
 * keep this a plain data table rather than anything clever.
 *
 * Terra is the exception in scale: eight kilometres on a side, most of it
 * generated from `wilds` by `worldgen.ts` rather than placed by hand. What IS
 * placed by hand — the Gate Circle, Daso, the roads and waystones — is the
 * skeleton the generated land hangs off.
 */

export type OstraId = "terra" | "ascendant" | "barals" | "barrow";

export interface GateDefinition {
  /** Unique within its own Ostra. */
  id: string;
  /** Shown to the player when they are standing in range. */
  label: string;
  /** Where this Gate leads. */
  target: OstraId;
  /** The Gate on the far side you step out of. */
  targetGate: string;
  x: number;
  z: number;
  /**
   * Which way you face when arriving through this Gate, in radians. You step
   * out GATE_ARRIVAL_OFFSET metres along this heading, so it should point into
   * the Ostra rather than at a wall.
   */
  exitYaw: number;
}

/** Per-Ostra look. Travel only feels like travel if the place looks different. */
export interface OstraPalette {
  /** Background, behind everything — and the fog, so distance fades into it. */
  sky: string;
  /** Low ground. */
  ground: string;
  /** Sunlit crests, and grass. */
  grid: string;
  /** Rock, boundary walls. */
  edge: string;
  /** Ambient bounce colour, tinting everything in shadow. */
  bounce: string;
  /** High peaks. Defaults to `edge`. */
  peak?: string;
  /** Scales the sun and the ambient light. 1 when absent; a crypt is darker. */
  light?: number;
}

/** A solid circular prop. Collided against by both sides, and identical on
 *  both, so it predicts perfectly — unlike another player. */
export interface ObstacleDefinition {
  x: number;
  z: number;
  radius: number;
  /** Purely visual; collision is a 2D circle. */
  height: number;
}

/**
 * How dangerous an Ostra is, as multipliers on its creatures.
 *
 * Travel should be a difficulty choice, not just a change of palette: Terra is
 * where you learn, Barals is where the lore says you suffer. Applied on the
 * server when a creature spawns and when it hits, so the same archetype is
 * genuinely tougher in a harder place. Creature LEVEL stacks on top.
 */
export interface OstraDifficulty {
  /** Scales creature damage against players. */
  damage: number;
  /** Scales creature maximum health. */
  health: number;
}

/** How an Ostra's scenery is drawn. Collision is a circle either way — this
 *  only decides which low-poly form sits on top of it. */
export type ObstacleStyle = "pillar" | "boulder";

/**
 * A standing stone you wake beside after dying.
 *
 * On an eighty-metre Ostra, respawning at the one spawn point was fine. On an
 * eight-kilometre one it would mean a twenty-minute walk back to your corpse,
 * so you wake at the nearest stone instead. They double as landmarks: they are
 * on the map, on the compass, and visible from a long way off.
 */
export interface WaystoneDefinition {
  id: string;
  name: string;
  x: number;
  z: number;
}

/**
 * A road, drawn into the ground and kept clear of trees and camps. On a map
 * this size, roads are how people find their way without a map open.
 *
 * `points` are the places it must pass through — a waystone, a town. How it
 * gets from one to the next is worked out over the terrain (`worldgen.ts`),
 * so it bends around mountains and lakes the way a road a person walked into
 * existence would, instead of running straight at them.
 */
export interface RoadDefinition {
  id: string;
  points: Array<{ x: number; z: number }>;
  width: number;
}

/**
 * A stretch of Terra with its own character: ground colour, trees, grass,
 * and which creatures live there. The shape of the land in it is the
 * `TerrainRegion` part, which the height function reads.
 */
export interface RegionDefinition extends TerrainRegion {
  name: string;
  /** Low ground and sunlit crests, as hex colours. */
  ground: string;
  crest: string;
  /** Multiplies the woodland noise: 0 is bare, 1 normal, above is thick. */
  woods: number;
  /** Tree species, picked evenly; repeat one to weight it. */
  trees: Array<"pine" | "oak" | "birch" | "dead">;
  rock: "grey" | "red" | "dark";
  grass: "grass" | "dry" | "heather" | "reeds" | "ash";
  /** Relative odds of each creature for generated camps. */
  creatures: Partial<Record<EnemyKind, number>>;
  /**
   * The creature levels found here, lowest to highest — lowest on the side
   * nearest the Ostra's spawn, rising across the region away from it (see
   * `levelAt`). A region is a zone in the WoW sense: you know roughly what
   * level it is before you go.
   */
  levels: [number, number];
}

/**
 * An old ruin: a landmark to navigate by and, usually, something guarding it.
 * Its stones collide; `ruinParts` in worldgen says exactly where they are.
 */
export interface RuinDefinition {
  id: string;
  name: string;
  kind: "ring" | "tower" | "spire" | "barrow";
  x: number;
  z: number;
  radius: number;
}

/**
 * A named hunting ground: one creature variant (`variants.ts`) lives here and
 * nowhere else, in a few camps spread over the area, and nothing else lives
 * here — the generated camps keep out. Quests ask for its variant, so the map
 * can draw the area as where to go.
 */
export interface HuntingArea {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  variant: string;
  level: number;
  /** How many camps, one in the middle and the rest round it. At most 9. */
  camps: number;
  /** Creatures in each. */
  count: number;
}

/**
 * Generated content for a large Ostra: woodland, boulders, and creature camps,
 * all derived deterministically from `seed` so every client and the server
 * agree on where every tree is without sending any of it.
 */
export interface WildsSettings {
  seed: number;
  /** Chance per 8 m plot of a tree, where the woods are thickest. */
  forest: number;
  /** Feature size of woodland patches, in metres. */
  forestWavelength: number;
  /** Chance per plot of a boulder. */
  rocks: number;
  /** One candidate camp per square of this side, in metres. */
  campSpacing: number;
  /** Chance a candidate becomes a camp (before the safety rules reject it). */
  campChance: number;
  /**
   * How far either side of a region's centre, measured outward from the
   * spawn, its level band is spread across. About half the distance between
   * region centres, so the bottom of one band meets the border it shares with
   * the region nearer home.
   */
  levelReach: number;
}

export interface OstraDefinition {
  id: OstraId;
  /** "Terra Ostra" */
  name: string;
  /** The Common Tongue translation, per the lore. */
  subtitle: string;
  /** The playable area is a size x size square centred on the origin. */
  size: number;
  /** Where a brand-new character first opens their eyes, and what creature
   *  levels are measured outward from. */
  spawn: { x: number; z: number };
  palette: OstraPalette;
  gates: GateDefinition[];
  obstacles: ObstacleDefinition[];
  obstacleStyle: ObstacleStyle;
  difficulty: OstraDifficulty;
  /** The shape of the ground. */
  terrain: TerrainSettings;
  /** Settlement ids placed in this Ostra. */
  settlements: string[];
  /** Hand-placed creature camps. */
  spawns: SpawnGroup[];
  /** Respawn points. May be empty, in which case you wake at `spawn`. */
  waystones: WaystoneDefinition[];
  roads: RoadDefinition[];
  /** Present on Ostras big enough to need generating. */
  wilds?: WildsSettings;
  /** Areas with their own character. The same objects are the terrain's
   *  `regions`, so the land and its look can never disagree about borders. */
  regions: RegionDefinition[];
  ruins: RuinDefinition[];
  /** Present on a dungeon: instanced per party, and built of rock walls
   *  (see `dungeons.ts`). */
  dungeon?: DungeonDefinition;
  /** Hunting grounds, each the only home of one creature variant. */
  areas?: HuntingArea[];
}

/** Face the middle of the Ostra from a point on its edge. */
function facingCentre(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

// --- Terra's skeleton ------------------------------------------------------

const TERRA_SIZE = 8000;

const TERRA_WAYSTONES: WaystoneDefinition[] = [
  { id: "gate-circle", name: "The Gate Circle", x: 0, z: -9 },
  { id: "westroad", name: "Westroad Stone", x: -700, z: -62 },
  { id: "daso", name: "Daso Stone", x: -1402, z: -168 },
  { id: "north", name: "North Stone", x: -34, z: 1120 },
  { id: "far-north", name: "Highmoor Stone", x: 180, z: 2350 },
  { id: "east", name: "East Stone", x: 1200, z: -38 },
  { id: "far-east", name: "Sunward Stone", x: 2350, z: 160 },
  { id: "south", name: "South Stone", x: 44, z: -1300 },
  { id: "far-south", name: "Lowfen Stone", x: -160, z: -2500 },
  { id: "northwest", name: "Greywood Stone", x: -2350, z: 1900 },
  { id: "southwest", name: "Ashfall Stone", x: -2450, z: -2150 },
  { id: "northeast", name: "Brightwater Stone", x: 2450, z: 2300 },
  { id: "southeast", name: "Redstep Stone", x: 2500, z: -2350 },
  { id: "fanshona", name: "Fanshona Stone", x: 2047, z: 1947 },
];

const stone = (id: string): { x: number; z: number } => {
  const found = TERRA_WAYSTONES.find((w) => w.id === id)!;
  return { x: found.x, z: found.z };
};

const TERRA_RUINS: RuinDefinition[] = [
  { id: "broken-crown", name: "The Broken Crown", kind: "ring", x: -420, z: 2150, radius: 13 },
  { id: "greywood-watch", name: "Greywood Watch", kind: "tower", x: -1900, z: 1450, radius: 7 },
  { id: "old-barrow", name: "The Old Barrow", kind: "barrow", x: -2050, z: -1800, radius: 11 },
  { id: "cinder-spire", name: "Cinder Spire", kind: "spire", x: -2800, z: -2550, radius: 6 },
  { id: "the-anvil", name: "The Anvil", kind: "spire", x: 2150, z: -1950, radius: 8 },
  { id: "sunken-hall", name: "The Sunken Hall", kind: "tower", x: -520, z: -2230, radius: 8 },
  { id: "sunward-ring", name: "Sunward Ring", kind: "ring", x: 1650, z: 520, radius: 10 },
  // In the west woods behind Daso, where Basan hears his name. The way down
  // into it is a Gate standing in the gap on the barrow's south side.
  { id: "hollow-barrow", name: "The Hollow Barrow", kind: "barrow", x: -1720, z: -160, radius: 11 },
];

const ruin = (id: string): { x: number; z: number } => {
  const found = TERRA_RUINS.find((r) => r.id === id)!;
  return { x: found.x, z: found.z };
};

/**
 * The roads, as the places each must pass through. A network with loops, not
 * a plus sign: you can ride a circuit of the outer stones, and most places
 * have two ways in.
 */
const TERRA_ROADS: RoadDefinition[] = [
  // The only road that goes anywhere a person lives, so the widest.
  // Daso's three roads run into its yard rather than stopping at the edge of
  // town: they are its streets, and the town is laid out along them. Each is
  // pinned by a point at the edge of town — east, north, south — because left
  // to itself the router takes the cheapest line over the hills, and those
  // lines went through the timber shed and ran two roads side by side.
  {
    id: "westroad", width: 5,
    // It reaches Daso from the north-east, down the valley the router
    // prefers; the pin is where it turns in, so it does not double back.
    points: [{ x: -32, z: -4 }, stone("westroad"), { x: DASO.x + 31, z: DASO.z + 17 }, { x: DASO.x + 12, z: DASO.z + 1 }],
  },
  { id: "northroad", width: 4, points: [{ x: 0, z: 34 }, stone("north"), stone("far-north")] },
  { id: "eastroad", width: 4, points: [{ x: 34, z: 0 }, stone("east"), stone("far-east")] },
  { id: "southroad", width: 4, points: [{ x: 0, z: -36 }, stone("south"), stone("far-south")] },
  { id: "lakeroad", width: 4, points: [stone("far-east"), stone("fanshona"), stone("northeast")] },
  { id: "highroad", width: 3, points: [stone("far-north"), stone("fanshona")] },
  {
    id: "greywood-track", width: 3,
    points: [{ x: DASO.x - 2, z: DASO.z + 9 }, { x: DASO.x - 5, z: DASO.z + 46 }, ruin("greywood-watch"), stone("northwest")],
  },
  { id: "moor-track", width: 3, points: [stone("northwest"), ruin("broken-crown"), stone("far-north")] },
  {
    id: "ash-road", width: 3,
    points: [{ x: DASO.x + 3, z: DASO.z - 9 }, { x: DASO.x + 2, z: DASO.z - 44 }, stone("southwest")],
  },
  { id: "fen-track", width: 3, points: [stone("southwest"), ruin("old-barrow"), stone("far-south")] },
  { id: "red-road", width: 3, points: [stone("far-south"), stone("southeast")] },
  { id: "anvil-road", width: 3, points: [stone("far-east"), ruin("the-anvil"), stone("southeast")] },
  { id: "ring-lane", width: 3, points: [stone("east"), ruin("sunward-ring"), stone("north")] },
];

/**
 * Terra's regions. The Westwood round Daso, where everyone starts, and the
 * Heartland round the Gate Circle are gentle and green; everything further out
 * has a character of its own, and creatures to match. Waystones sit roughly at
 * each centre and are named for them.
 *
 * Levels climb with distance from Daso: the two home regions, then the
 * Greywood and Ashfall on the western flank, the Lowfen and Highmoor, Sunward,
 * and at the far end of Terra the Brightwater (and Fanshona in it) and
 * Redstep, up to 30. Past that, the Gates: the Ascendant and Barals.
 */
const TERRA_REGIONS: RegionDefinition[] = [
  {
    id: "heartland", name: "The Heartland", x: 0, z: 0,
    ground: "#41703f", crest: "#79a355", woods: 0.7, trees: ["oak", "oak", "pine", "birch"],
    rock: "grey", grass: "grass", creatures: { zombie: 3, spider: 2, wolf: 1 }, levels: [5, 10],
  },
  {
    id: "westwood", name: "Westwood", x: -1500, z: -150, relief: 1.1,
    ground: "#3b673a", crest: "#6c974d", woods: 1.15, trees: ["oak", "oak", "pine", "birch"],
    rock: "grey", grass: "grass", creatures: { wolf: 3, spider: 2, zombie: 1 }, levels: [1, 5],
  },
  {
    id: "greywood", name: "Greywood", x: -2400, z: 1950, lift: 12, relief: 1.3, mountains: 1.2,
    ground: "#33523a", crest: "#56794c", woods: 1.4, trees: ["pine", "pine", "pine", "birch"],
    rock: "grey", grass: "grass", creatures: { wolf: 4, spider: 3, golem: 0.4 }, levels: [10, 15],
  },
  {
    id: "highmoor", name: "Highmoor", x: 200, z: 2450, lift: 20, relief: 0.8, mountains: 1.3,
    ground: "#6b6248", crest: "#927a70", woods: 0.22, trees: ["pine", "dead"],
    rock: "grey", grass: "heather", creatures: { golem: 1.5, wolf: 2.5, zombie: 1 }, levels: [15, 20],
  },
  {
    id: "brightwater", name: "Brightwater", x: 2350, z: 2250, relief: 0.55, mountains: 0.3,
    ground: "#487a4a", crest: "#8ab45e", woods: 0.55, trees: ["birch", "birch", "oak"],
    rock: "grey", grass: "grass", creatures: { wretch: 3, boar: 2, spider: 1 }, levels: [22, 27],
  },
  {
    id: "sunward", name: "Sunward", x: 2500, z: 100, relief: 0.5, mountains: 0.15,
    ground: "#7a8844", crest: "#c7b66a", woods: 0.15, trees: ["oak"],
    rock: "grey", grass: "dry", creatures: { boar: 4, zombie: 2, wolf: 1 }, levels: [18, 23],
  },
  {
    id: "redstep", name: "Redstep", x: 2500, z: -2350, lift: 10, relief: 1.7, mountains: 0.6, terrace: 9,
    ground: "#8a5a3a", crest: "#c3844f", woods: 0.06, trees: ["dead"],
    rock: "red", grass: "dry", creatures: { golem: 2, boar: 1.5, wisp: 1 }, levels: [25, 30],
  },
  {
    id: "ashfall", name: "Ashfall", x: -2450, z: -2150, relief: 1.2,
    ground: "#4a4642", crest: "#706860", woods: 0.55, trees: ["dead", "dead", "pine"],
    rock: "dark", grass: "ash", creatures: { wisp: 4, zombie: 3 }, levels: [11, 16],
  },
  {
    id: "lowfen", name: "Lowfen", x: -200, z: -2550, lift: -8, relief: 0.25, mountains: 0,
    ground: "#3d5839", crest: "#5f7a47", woods: 0.4, trees: ["dead", "birch", "birch"],
    rock: "dark", grass: "reeds", creatures: { wretch: 4, spider: 2, zombie: 1 }, levels: [13, 18],
  },
];

/** Fanshona's lake sits just below the town, fixed together so the dock
 *  always reaches the water whatever the ground around them does. */
const FANSHONA_LAKE_LEVEL = (FANSHONA.level ?? 0) - 1.1;

const TERRA_LAKES: LakeDefinition[] = [
  // Brightwater: the lake country.
  { x: 2150, z: 2050, radius: 70, shore: 18, depth: 0.85, level: FANSHONA_LAKE_LEVEL },
  { x: 2620, z: 2560, radius: 110, shore: 22, depth: 0.9 },
  { x: 2280, z: 2720, radius: 55, shore: 16, depth: 0.8 },
  { x: 2800, z: 2080, radius: 62, shore: 18, depth: 0.8 },
  // Lowfen: pools and meres.
  { x: -330, z: -2380, radius: 42, shore: 12, depth: 0.6 },
  { x: -60, z: -2700, radius: 58, shore: 14, depth: 0.7 },
  { x: 180, z: -2430, radius: 34, shore: 10, depth: 0.55 },
  { x: -520, z: -2720, radius: 46, shore: 12, depth: 0.6 },
  { x: 150, z: -2860, radius: 40, shore: 12, depth: 0.6 },
  { x: -720, z: -2480, radius: 30, shore: 10, depth: 0.5 },
  // A pond in the heartland, and Daso's millpond.
  { x: 420, z: 640, radius: 45, shore: 14, depth: 0.8 },
  { x: -1180, z: 180, radius: 50, shore: 14, depth: 0.8 },
];

/** Every place a person might stand or wake is levelled, so none of them is
 *  on a cliff. */
function terraFlats(): FlatZone[] {
  const flats: FlatZone[] = [
    // The Gate Circle: big, and dead level, because it is the landmark the
    // whole map is arranged around.
    { x: 0, z: 0, radius: 34, falloff: 60 },
    // Daso sits on a level shelf. A logging town on a hillside would look
    // like an accident.
    { x: DASO.x, z: DASO.z, radius: DASO.radius + 6, falloff: 50 },
    { x: FANSHONA.x, z: FANSHONA.z, radius: FANSHONA.radius + 6, falloff: 40, level: FANSHONA.level },
  ];
  for (const w of TERRA_WAYSTONES) {
    if (w.id === "gate-circle" || w.id === "daso" || w.id === "fanshona") continue;
    flats.push({ x: w.x, z: w.z, radius: 7, falloff: 26 });
  }
  for (const r of TERRA_RUINS) {
    flats.push({ x: r.x, z: r.z, radius: r.radius + 4, falloff: 28 });
  }
  return flats;
}

// --- the Hollow Barrow ---------------------------------------------------------

const BARROW_SIZE = 200;

/**
 * The barrow, entrance to throne: rooms and the passages between them, along
 * one straight spine running north (+z). Everything else is rock. Passages
 * are fourteen metres long, so a camp in one room cannot notice someone
 * standing in the last.
 */
const BARROW_SPACES: DungeonSpace[] = [
  // The entrance hall, with the Gate back up at its south end.
  { x0: -9, x1: 9, z0: -88, z1: -66 },
  { x0: -3, x1: 3, z0: -66, z1: -52 },
  // The first chamber: Risen, who were buried here.
  { x0: -12, x1: 12, z0: -52, z1: -30 },
  { x0: -3, x1: 3, z0: -30, z1: -16 },
  // The pillared hall, webbed.
  { x0: -16, x1: 16, z0: -16, z1: 12 },
  { x0: -3, x1: 3, z0: 12, z1: 26 },
  // The lamp-room, where the barrow-lights drift, and its keeper.
  { x0: -13, x1: 13, z0: 26, z1: 48 },
  { x0: -3.5, x1: 3.5, z0: 48, z1: 60 },
  // The King's hall.
  { x0: -17, x1: 17, z0: 60, z1: 94 },
];

export const OSTRAS: Record<OstraId, OstraDefinition> = {
  terra: {
    id: "terra",
    name: "Terra Ostra",
    subtitle: "Earth Shard",
    // Eight kilometres a side — a hundred times the eighty it used to be.
    // Big enough that crossing it is a trip and distant peaks are landmarks.
    size: TERRA_SIZE,
    // Daso, by its waystone: everyone starts in the logging town, among
    // people with work for them, rather than alone at the Gate Circle.
    spawn: waystoneArrival(TERRA_WAYSTONES.find((w) => w.id === "daso")!),
    // Daylight. The other two Ostras keep their gloom, which is the point:
    // arriving on Terra should feel like coming home, and a place described as
    // a mixing pot where most people live should not look like a crypt.
    palette: {
      sky: "#9dbfd8",
      ground: "#41703f",
      grid: "#79a355",
      edge: "#7a6f5c",
      bounce: "#5a6f4c",
      peak: "#dde4e6",
    },
    gates: [
      {
        id: "terra-ascendant",
        label: "Gate to the Ascendant Ostra",
        target: "ascendant",
        targetGate: "ascendant-terra",
        x: 20,
        z: 20,
        exitYaw: facingCentre(20, 20),
      },
      {
        id: "terra-barals",
        label: "Gate to Barals Ostra",
        target: "barals",
        targetGate: "barals-terra",
        x: -20,
        z: 20,
        exitYaw: facingCentre(-20, 20),
      },
      {
        id: "terra-barrow",
        label: "Into the Hollow Barrow — a dungeon for a party, levels 7–10",
        target: "barrow",
        targetGate: "barrow-terra",
        // In the gap on the barrow's south side, between the mound and the
        // ring; you come back out facing south, clear of the stones.
        x: ruin("hollow-barrow").x,
        z: ruin("hollow-barrow").z - 8.5,
        exitYaw: Math.PI,
      },
    ],
    // The standing stones of the Gate Circle.
    obstacles: [
      { x: 6, z: -9, radius: 1.4, height: 3.2 },
      { x: 10, z: -16, radius: 1.1, height: 2.4 },
      { x: -3, z: 11, radius: 1.8, height: 4.0 },
      { x: 13, z: 4, radius: 1.2, height: 2.8 },
      { x: -2, z: 20, radius: 2.2, height: 5.0 },
      { x: 24, z: -3, radius: 1.6, height: 3.6 },
    ],
    obstacleStyle: "pillar",
    terrain: {
      seed: 1701,
      // The ground you walk over: enough relief that the horizon moves as you
      // walk, not so much that a creature disappears behind every rise.
      hills: { amplitude: 7.5, wavelength: 320, octaves: 5 },
      // Kilometre-scale uplands and basins.
      continent: { amplitude: 26, wavelength: 2400 },
      // Ranges in about a third of the map. They are climbable — terrain does
      // not slow you — but they block sight, and sight is what makes a big map
      // feel big.
      mountains: { amplitude: 95, wavelength: 760, coverage: 0.34 },
      rim: { halfExtent: TERRA_SIZE / 2, width: 420, height: 120 },
      flats: terraFlats(),
      regions: TERRA_REGIONS,
      lakes: TERRA_LAKES,
    },
    settlements: ["daso", "fanshona"],
    // Gentle enough to learn the fight in. Level carries the danger further
    // out; this is the floor.
    difficulty: { damage: 0.6, health: 1 },
    // The camps by the Gate Circle, kept from when Terra was eighty metres
    // across and this was where everyone started. Spread wide: packed tighter
    // than a Risen's aggro radius, every approach pulls the whole camp at once.
    spawns: [
      { kind: "zombie", count: 4, x: 20, z: -40, radius: 11 },
      { kind: "spider", count: 3, x: 44, z: 22, radius: 8 },
      // Guardians of the ruins. Level comes from distance, like any camp.
      { kind: "golem", count: 2, ...ruin("broken-crown"), radius: 6 },
      { kind: "golem", count: 2, ...ruin("the-anvil"), radius: 5 },
      { kind: "golem", count: 1, ...ruin("sunward-ring"), radius: 3 },
      { kind: "wolf", count: 5, ...ruin("greywood-watch"), radius: 9 },
      { kind: "wisp", count: 4, ...ruin("old-barrow"), radius: 9 },
      { kind: "wisp", count: 3, ...ruin("cinder-spire"), radius: 8 },
      { kind: "wretch", count: 3, ...ruin("sunken-hall"), radius: 9 },
    ],
    waystones: TERRA_WAYSTONES,
    roads: TERRA_ROADS,
    regions: TERRA_REGIONS,
    ruins: TERRA_RUINS,
    // Daso's work, each somewhere you can point at: every quest in town asks
    // for a creature that lives in one of these and nowhere else.
    areas: [
      {
        id: "woodcutters-path", name: "The Woodcutters' Path", x: -1600, z: -430, radius: 45,
        variant: "pathstalker", level: 2, camps: 5, count: 2,
      },
      {
        id: "webbed-thicket", name: "The Webbed Thicket", x: -1680, z: 60, radius: 45,
        variant: "thicket-weaver", level: 3, camps: 5, count: 3,
      },
      {
        id: "felled-ridge", name: "The Felled Ridge", x: -1180, z: -330, radius: 48,
        variant: "rootbound", level: 5, camps: 5, count: 3,
      },
      {
        id: "silkstrand-hollow", name: "Silkstrand Hollow", x: -980, z: -250, radius: 45,
        variant: "silk-snatcher", level: 6, camps: 5, count: 3,
      },
    ],
    wilds: {
      seed: 9001,
      forest: 0.5,
      forestWavelength: 650,
      rocks: 0.018,
      // About seven times the camps of the first 210 m at 62%: walking between
      // fights was the boring part. Camps sit in the middle half of their cell
      // (see `campsIn`), so even this close neighbours stay 45 m apart and do
      // not share aggro. Everything awake near a player is replicated and
      // drawn, so density costs frames — this is about as far as it goes.
      campSpacing: 90,
      campChance: 0.85,
      levelReach: 900,
    },
  },

  ascendant: {
    id: "ascendant",
    name: "Ascendant Ostra",
    subtitle: "Realm of the Gods",
    size: 50,
    spawn: { x: 0, z: 0 },
    palette: {
      sky: "#12100a",
      ground: "#1e1a10",
      grid: "#b8963f",
      edge: "#5a4a22",
      bounce: "#2e2716",
    },
    gates: [
      {
        id: "ascendant-terra",
        label: "Gate to the Terra Ostra",
        target: "terra",
        targetGate: "terra-ascendant",
        x: 0,
        z: -16,
        exitYaw: facingCentre(0, -16),
      },
    ],
    // Tall, thin columns — the gods' realm reads as architecture, not rubble.
    obstacles: [
      { x: 5, z: 5, radius: 0.9, height: 7.0 },
      { x: -5, z: 5, radius: 0.9, height: 7.0 },
      { x: 5, z: -5, radius: 0.9, height: 7.0 },
      { x: -5, z: -5, radius: 0.9, height: 7.0 },
      { x: 0, z: 12, radius: 2.4, height: 9.0 },
    ],
    obstacleStyle: "pillar",
    // Nearly level. The gods' realm should read as something built, and hills
    // would fight the columns.
    terrain: { seed: 24, hills: { amplitude: 0.9, wavelength: 40, octaves: 3 }, flats: [] },
    settlements: [],
    difficulty: { damage: 1, health: 1.2 },
    // The gods' realm is guarded, not infested. Levels 30-65 are meant to
    // live here once it is more than a courtyard; for now, its guards are
    // the next step up from the edge of Terra.
    spawns: [
      { kind: "spider", count: 2, x: 14, z: 10, radius: 4, level: 35 },
    ],
    waystones: [],
    roads: [],
    regions: [],
    ruins: [],
  },

  barals: {
    id: "barals",
    name: "Barals Ostra",
    subtitle: "Realm of Fire and Pain",
    size: 60,
    // Deliberately north of every camp. At the origin this sat 10m from the
    // zombies, inside their 13m aggro — you respawned straight into a death
    // loop. `unsafeSpawns()` exists so that cannot come back unnoticed.
    spawn: { x: 0, z: 24 },
    palette: {
      sky: "#140a08",
      ground: "#1f0f0b",
      grid: "#a83c22",
      edge: "#5c2315",
      bounce: "#301410",
    },
    gates: [
      {
        id: "barals-terra",
        label: "Gate to the Terra Ostra",
        target: "terra",
        targetGate: "terra-barals",
        x: 0,
        z: -20,
        exitYaw: facingCentre(0, -20),
      },
    ],
    // Squat volcanic rock, scattered without pattern.
    obstacles: [
      { x: 8, z: 2, radius: 2.6, height: 2.2 },
      { x: -7, z: -4, radius: 1.9, height: 1.6 },
      { x: 2, z: -11, radius: 3.1, height: 2.8 },
      { x: -13, z: 9, radius: 2.2, height: 2.0 },
      { x: 15, z: -14, radius: 1.7, height: 1.4 },
      { x: -2, z: 16, radius: 2.8, height: 3.4 },
    ],
    obstacleStyle: "boulder",
    // Broken and steep, so sightlines are short and a spider can be on you
    // before you see it come over a rise.
    terrain: { seed: 51, hills: { amplitude: 5.2, wavelength: 42, octaves: 4 }, flats: [] },
    settlements: [],
    // "A place of power and war." Going here before you are ready should be a
    // mistake you feel.
    difficulty: { damage: 1.6, health: 1.5 },
    // The realm of fire and pain earns its name. The top of the curve, 65-100,
    // belongs here; like the Ascendant it is a placeholder at that level.
    spawns: [
      { kind: "zombie", count: 6, x: -8, z: -2, radius: 9, level: 68 },
      { kind: "zombie", count: 3, x: 16, z: -6, radius: 5, level: 70 },
      { kind: "spider", count: 4, x: -18, z: -12, radius: 7, level: 72 },
    ],
    waystones: [],
    roads: [],
    regions: [],
    ruins: [],
  },

  barrow: {
    id: "barrow",
    name: "The Hollow Barrow",
    subtitle: "Beneath the west woods",
    size: BARROW_SIZE,
    // In the entrance hall, back from the Gate: where you wake after a wipe,
    // and the one place in the barrow nothing can see.
    spawn: { x: 0, z: -75 },
    palette: {
      sky: "#0c0e12",
      ground: "#2b2822",
      // Barrow-light: the pale green of the Gate on Terra that leads here.
      grid: "#7fbf9a",
      edge: "#57524a",
      bounce: "#1c2622",
      light: 0.7,
    },
    gates: [
      {
        id: "barrow-terra",
        label: "Back up into the Westwood",
        target: "terra",
        targetGate: "terra-barrow",
        x: 0,
        z: -82,
        exitYaw: 0,
      },
    ],
    // The pillars holding up what is left of the roof, in the two big halls.
    obstacles: [
      { x: -10, z: -8, radius: 1.3, height: 7.5 },
      { x: 10, z: -8, radius: 1.3, height: 7.5 },
      { x: -10, z: 5, radius: 1.3, height: 7.5 },
      { x: 10, z: 5, radius: 1.3, height: 7.5 },
      { x: -11, z: 70, radius: 1.5, height: 8.5 },
      { x: 11, z: 70, radius: 1.5, height: 8.5 },
      { x: -11, z: 86, radius: 1.5, height: 8.5 },
      { x: 11, z: 86, radius: 1.5, height: 8.5 },
    ],
    obstacleStyle: "pillar",
    // A floor of packed earth, a little uneven; flat enough that nothing is
    // hidden behind a rise in a room twenty metres across.
    terrain: { seed: 313, hills: { amplitude: 0.3, wavelength: 26, octaves: 2 }, flats: [] },
    settlements: [],
    // Tougher than the woods above but no harder-hitting: nobody can heal
    // yet, so what makes it a party's fight is how much there is to kill and
    // how the King fights, not blows that take half a bar. (Loot is tilted
    // by `health`, like any Ostra's.)
    difficulty: { damage: 0.6, health: 1.15 },
    // One pull per room, two in the bigger halls, each a thing to learn
    // before the King: the Risen's overhead, a spider's speed, a wisp's burst
    // and a golem that cannot be staggered. The King himself is an elite
    // (`elites.ts`), at the far end of the last hall.
    spawns: [
      { kind: "zombie", count: 3, x: 0, z: -40, radius: 4, level: 7 },
      { kind: "spider", count: 3, x: -8, z: -2, radius: 3, level: 8 },
      { kind: "spider", count: 3, x: 8, z: 0, radius: 3, level: 8 },
      { kind: "wisp", count: 3, x: -6, z: 34, radius: 3, level: 8 },
      { kind: "golem", count: 1, x: 6, z: 42, radius: 1, level: 9 },
    ],
    waystones: [],
    roads: [],
    regions: [],
    ruins: [],
    dungeon: {
      levels: [7, 10],
      entrance: "terra-barrow",
      ...carve(BARROW_SPACES, BARROW_SIZE / 2, 6.5),
    },
  },
};

/** Where new characters begin. Terra is the mixing pot, per the lore. */
export const STARTING_OSTRA: OstraId = "terra";

export const OSTRA_IDS = Object.keys(OSTRAS) as OstraId[];

export function isOstraId(value: unknown): value is OstraId {
  return typeof value === "string" && Object.hasOwn(OSTRAS, value);
}

export function getOstra(id: OstraId): OstraDefinition {
  return OSTRAS[id];
}

/** Where you stand when you wake at a waystone: just in front of it, rather
 *  than inside its collider. */
export function waystoneArrival(stone: WaystoneDefinition): { x: number; z: number } {
  return { x: stone.x, z: stone.z + 3 };
}

/**
 * Where to wake after dying at (x, z): the nearest waystone's arrival point,
 * or the Ostra's spawn if it has none.
 */
export function respawnPoint(ostra: OstraDefinition, x: number, z: number): { x: number; z: number } {
  let best = ostra.spawn;
  let bestDistance = Infinity;
  for (const stone of ostra.waystones) {
    const d = (stone.x - x) * (stone.x - x) + (stone.z - z) * (stone.z - z);
    if (d < bestDistance) {
      bestDistance = d;
      best = waystoneArrival(stone);
    }
  }
  return best;
}

export function settlementsIn(ostra: OstraDefinition): SettlementDefinition[] {
  return ostra.settlements
    .map((id) => SETTLEMENTS[id])
    .filter((settlement): settlement is SettlementDefinition => settlement !== undefined);
}

/** Ground height in a given Ostra. Sugar over `heightAt`, so callers don't
 *  have to remember to reach for `.terrain`. */
export function groundHeight(ostra: OstraDefinition, x: number, z: number): number {
  return heightAt(x, z, ostra.terrain);
}

export function findGate(ostra: OstraDefinition, gateId: string): GateDefinition | undefined {
  return ostra.gates.find((gate) => gate.id === gateId);
}
