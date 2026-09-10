import type { SpawnGroup } from "./enemies.js";
import type { BoxCollider } from "./movement.js";
import { DASO, SETTLEMENTS, type SettlementDefinition } from "./settlements.js";
import { heightAt, type FlatZone, type TerrainSettings } from "./terrain.js";

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

export type OstraId = "terra" | "ascendant" | "barals";

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

/** A path, drawn into the ground and kept clear of trees and camps. On a map
 *  this size, roads are how people find their way without a map open. */
export interface RoadDefinition {
  id: string;
  /** Control points. The drawn road meanders between them. */
  points: Array<{ x: number; z: number }>;
  width: number;
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
  /** Creature level rises by one every this many metres from the spawn. */
  metresPerLevel: number;
}

export interface OstraDefinition {
  id: OstraId;
  /** "Terra Ostra" */
  name: string;
  /** The Common Tongue translation, per the lore. */
  subtitle: string;
  /** The playable area is a size x size square centred on the origin. */
  size: number;
  /** Where a brand-new character first opens their eyes. */
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
];

const TERRA_ROADS: RoadDefinition[] = [
  {
    // The only road that goes anywhere a person lives.
    id: "westroad",
    width: 5,
    points: [
      { x: -6, z: -4 }, { x: -320, z: -30 }, { x: -700, z: -58 },
      { x: -1080, z: -132 }, { x: -1405, z: -172 },
    ],
  },
  {
    id: "northroad",
    width: 4,
    points: [
      { x: 0, z: 28 }, { x: 36, z: 420 }, { x: -34, z: 1116 },
      { x: 90, z: 1760 }, { x: 180, z: 2346 },
    ],
  },
  {
    id: "eastroad",
    width: 4,
    points: [
      { x: 30, z: -2 }, { x: 520, z: 50 }, { x: 1196, z: -38 },
      { x: 1800, z: 60 }, { x: 2346, z: 160 },
    ],
  },
  {
    id: "southroad",
    width: 4,
    points: [
      { x: 0, z: -30 }, { x: -60, z: -620 }, { x: 44, z: -1296 },
      { x: -40, z: -1900 }, { x: -160, z: -2496 },
    ],
  },
];

/** Every place a person might stand or wake is levelled, so none of them is
 *  on a cliff. */
function terraFlats(): FlatZone[] {
  const flats: FlatZone[] = [
    // The Gate Circle: big, and dead level, because it is the first thing
    // anyone sees.
    { x: 0, z: 0, radius: 34, falloff: 60 },
    // Daso sits on a level shelf. A logging town on a hillside would look
    // like an accident.
    { x: DASO.x, z: DASO.z, radius: DASO.radius + 6, falloff: 50 },
  ];
  for (const stone of TERRA_WAYSTONES) {
    if (stone.id === "gate-circle" || stone.id === "daso") continue;
    flats.push({ x: stone.x, z: stone.z, radius: 7, falloff: 26 });
  }
  return flats;
}

export const OSTRAS: Record<OstraId, OstraDefinition> = {
  terra: {
    id: "terra",
    name: "Terra Ostra",
    subtitle: "Earth Shard",
    // Eight kilometres a side — a hundred times the eighty it used to be.
    // Big enough that crossing it is a trip and distant peaks are landmarks.
    size: TERRA_SIZE,
    spawn: { x: 0, z: 0 },
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
    },
    settlements: ["daso"],
    // Gentle enough to learn the fight in. Level carries the danger further
    // out; this is the floor.
    difficulty: { damage: 0.6, health: 1 },
    // The starter camps by the Gate Circle, kept from when Terra was eighty
    // metres across. Spread wide: packed tighter than a Risen's aggro radius,
    // every approach pulls the whole camp at once and a new player never gets a
    // winnable first fight.
    spawns: [
      { kind: "zombie", count: 4, x: 20, z: -40, radius: 11 },
      { kind: "spider", count: 3, x: 44, z: 22, radius: 8 },
    ],
    waystones: TERRA_WAYSTONES,
    roads: TERRA_ROADS,
    wilds: {
      seed: 9001,
      forest: 0.5,
      forestWavelength: 650,
      rocks: 0.018,
      campSpacing: 210,
      campChance: 0.62,
      metresPerLevel: 380,
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
    // The gods' realm is guarded, not infested.
    spawns: [
      { kind: "spider", count: 2, x: 14, z: 10, radius: 4, level: 4 },
    ],
    waystones: [],
    roads: [],
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
    // The realm of fire and pain earns its name.
    spawns: [
      { kind: "zombie", count: 6, x: -8, z: -2, radius: 9, level: 6 },
      { kind: "zombie", count: 3, x: 16, z: -6, radius: 5, level: 6 },
      { kind: "spider", count: 4, x: -18, z: -12, radius: 7, level: 7 },
    ],
    waystones: [],
    roads: [],
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

const boxColliderCache = new Map<OstraId, readonly BoxCollider[]>();

/** Buildings, as rectangles. Built once and reused; identical on both sides,
 *  so walking around a wall predicts perfectly. */
export function buildingColliders(ostra: OstraDefinition): readonly BoxCollider[] {
  let cached = boxColliderCache.get(ostra.id);
  if (!cached) {
    const boxes: BoxCollider[] = [];
    for (const settlement of settlementsIn(ostra)) {
      for (const building of settlement.buildings) {
        boxes.push({
          id: building.id,
          x: building.x,
          z: building.z,
          halfWidth: building.width / 2,
          halfDepth: building.depth / 2,
          yaw: building.yaw,
        });
      }
    }
    cached = boxes;
    boxColliderCache.set(ostra.id, cached);
  }
  return cached;
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
