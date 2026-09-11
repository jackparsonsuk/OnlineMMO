/**
 * Places people live.
 *
 * Daso is taken straight from the vault: a logging town in the west of Vareto,
 * fifty people, a few small houses and an inn, and hardly anyone passing
 * through except for work or by accident. That last detail is the one that
 * shapes the layout — this is a working camp, not a destination, so it is
 * built around the timber yard rather than around a square.
 *
 * All of it is plain data. Buildings become box colliders on both the server
 * and the client's prediction; props and villagers are drawn client-side.
 *
 * Layouts are written in each town's own frame (see `townFrame`): buildings
 * turn their doors to the square, and villagers and door-side clutter are
 * placed relative to a building's door (`atDoor`) rather than at typed-in
 * coordinates. That is what keeps people out of walls — the old layout put
 * five of Daso's villagers inside or against buildings, and nobody noticed for
 * weeks. `settlementProblems()` in worldgen.ts checks all of it at boot.
 */

/** A building. Rotated so a town isn't a grid, but rectangular so walking
 *  around it feels like walking around a building. */
export interface BuildingDefinition {
  id: string;
  /** Shown when you stand near the door. */
  name: string;
  x: number;
  z: number;
  /** Footprint, before rotation. */
  width: number;
  depth: number;
  height: number;
  /** The door is on the building's local +z face; this is where it looks. */
  yaw: number;
  /** Changes the walls, roof and trim. */
  style: "cottage" | "hall" | "shed" | "stone";
}

/** Scenery with no collision — you walk through the long grass, not around it. */
export interface PropDefinition {
  kind: "log" | "stump" | "barrel" | "crate" | "lamp" | "fence" | "woodpile"
    | "dock" | "boat" | "well" | "stall";
  x: number;
  z: number;
  yaw: number;
}

/** Someone standing at their work. Static: a logging town at work is people
 *  in fixed places, and it costs no bandwidth at all. */
export interface VillagerDefinition {
  /** Set on anyone quests or trade refer to (see `quests.ts`, `vendors.ts`). */
  id?: string;
  name: string;
  /** Buys anything and sells plain gear (see `vendors.ts`). Needs an `id`. */
  vendor?: boolean;
  /** What they say when you stand near them. */
  line: string;
  x: number;
  z: number;
  yaw: number;
  /** Clothing colour, 0xRRGGBB. */
  colour: number;
}

export interface SettlementDefinition {
  id: string;
  name: string;
  /** Sits under the name when you arrive. */
  subtitle: string;
  /** Centre, and the radius the ground is flattened over. */
  x: number;
  z: number;
  radius: number;
  buildings: BuildingDefinition[];
  props: PropDefinition[];
  villagers: VillagerDefinition[];
  /** Trees around the edge. These DO collide — it is a logging town, and a
   *  forest you can walk through is not a forest. */
  trees: Array<{ x: number; z: number; radius: number; height: number }>;
  /** Thickens the generated woods around it. A logging town wants a forest;
   *  a lake town wants a view of the water. */
  woodland: boolean;
  /** Ground height of the town's level shelf. Omit to take the natural ground
   *  at its centre. Fixed where something else has to line up with it — a
   *  dock has to reach water. */
  level?: number;
}

// --- laying a town out ----------------------------------------------------------
//
// Trig is safe here, unlike in the generator: if two engines round a sine
// differently, a wall moves by a femtometre. It cannot make a wall appear or
// vanish, which is the failure the determinism rule guards against.

/** A town's own coordinates: relative to its centre, and turned by `turn` so a
 *  town can face its lake — the whole place moves or turns by editing one
 *  number rather than sixty. */
interface TownFrame {
  at(dx: number, dz: number): { x: number; z: number };
  turn: number;
}

function townFrame(x: number, z: number, turn: number): TownFrame {
  const sin = Math.sin(turn);
  const cos = Math.cos(turn);
  return { turn, at: (dx, dz) => ({ x: x + dx * cos + dz * sin, z: z - dx * sin + dz * cos }) };
}

/** A yaw, in the town's frame, looking from (dx, dz) towards (tx, tz). */
function looking(frame: TownFrame, dx: number, dz: number, tx: number, tz: number): number {
  return frame.turn + Math.atan2(tx - dx, tz - dz);
}

/** A building at (dx, dz) with its door turned to face `door` (the square, by
 *  default) — every door in town opens onto somewhere you would walk. */
function building(
  frame: TownFrame,
  id: string,
  name: string,
  style: BuildingDefinition["style"],
  dx: number,
  dz: number,
  width: number,
  depth: number,
  height: number,
  door: [number, number] = [0, 0],
): BuildingDefinition {
  return { id, name, style, ...frame.at(dx, dz), width, depth, height, yaw: looking(frame, dx, dz, door[0], door[1]) };
}

/**
 * A spot `out` metres in front of a building's door and `along` metres to one
 * side of it, facing out of the door. Where the people who work there stand,
 * and where their barrels go — measured from the wall, so it cannot end up in
 * it.
 */
function atDoor(b: BuildingDefinition, out: number, along = 0): { x: number; z: number; yaw: number } {
  const forward = b.depth / 2 + out;
  const sin = Math.sin(b.yaw);
  const cos = Math.cos(b.yaw);
  return { x: b.x + sin * forward + cos * along, z: b.z + cos * forward - sin * along, yaw: b.yaw };
}

/**
 * A ring of trees round a town, leaving gaps where roads come in. Angles are
 * compass-style in the town's frame: 0 is its +z, 90 its +x. Each tree's
 * spacing, size and distance wobble by a fixed pattern so the ring does not
 * read as a ring.
 */
function treeRing(
  frame: TownFrame,
  radius: number,
  count: number,
  gaps: Array<[number, number]>,
): SettlementDefinition["trees"] {
  const trees: SettlementDefinition["trees"] = [];
  for (let i = 0; i < count; i++) {
    const wobble = ((i * 37) % 11) / 11;
    const degrees = (i / count) * 360 + wobble * 7 - 3.5;
    const normal = ((degrees % 360) + 360) % 360;
    if (gaps.some(([from, to]) => normal >= from && normal <= to)) continue;
    const angle = (degrees * Math.PI) / 180;
    const reach = radius + wobble * 5;
    trees.push({
      ...frame.at(Math.sin(angle) * reach, Math.cos(angle) * reach),
      radius: 0.78 + wobble * 0.22,
      height: 7 + wobble * 1.8,
    });
  }
  return trees;
}

// --- Daso -------------------------------------------------------------------------

/**
 * West of Vareto, per the vault. Terra's west is negative X — and now that
 * Terra is eight kilometres across, "west" means a real journey: a
 * kilometre and a half out along the Westroad from the Gate Circle, which is
 * about right for a town nobody visits on purpose.
 *
 * Laid out around the timber yard, with three roads running into it: the
 * Westroad down from the north-east, the Greywood track north, and the Ash
 * road south; the waystone stands just east of town. The west is the woods —
 * where Basan hears his name — so the west side of town is its oldest houses,
 * with the forest at their backs.
 */
const DASO_X = -1450;
const DASO_Z = -180;
const daso = townFrame(DASO_X, DASO_Z, 0);

const DASO_INN = building(daso, "daso-inn", "The Felled Oak", "hall", -13, 15, 11, 7.5, 5);
const DASO_MILL = building(daso, "daso-mill", "The timber shed", "shed", 15, -15, 10, 6, 4.2);
const DASO_SAWPIT = building(daso, "daso-sawpit", "The saw pit", "shed", -15, -13, 7, 5, 3.4);
const DASO_BASAN = building(daso, "daso-house-1", "Basan's house", "cottage", -26, 3, 5.5, 4.8, 3.2);
const DASO_SMITHY = building(daso, "daso-smithy", "The smithy", "stone", 13, -28, 6, 5, 3.4);
const DASO_STORE = building(daso, "daso-store", "The storehouse", "shed", -27, -22, 6, 4.5, 3.2);
const DASO_CARTS = building(daso, "daso-carts", "The cart shed", "shed", 29, -9, 6.5, 5, 3.4);

export const DASO: SettlementDefinition = {
  id: "daso",
  name: "Daso",
  subtitle: "A logging town, fifty souls",
  x: DASO_X,
  z: DASO_Z,
  radius: 38,

  buildings: [
    DASO_INN,
    DASO_MILL,
    DASO_SAWPIT,
    DASO_BASAN,
    DASO_SMITHY,
    DASO_STORE,
    DASO_CARTS,
    building(daso, "daso-house-2", "A logger's house", "cottage", 7, 19, 5, 4.6, 3.1),
    building(daso, "daso-house-3", "A logger's house", "cottage", 25, -1, 4.8, 4.4, 3),
    building(daso, "daso-house-4", "A logger's house", "cottage", -25, -9, 5, 4.4, 3.1),
    building(daso, "daso-house-5", "A logger's house", "cottage", -23, 23, 4.8, 4.6, 3),
    building(daso, "daso-house-6", "A logger's house", "cottage", 9, 29, 5.2, 4.6, 3.2),
    building(daso, "daso-house-7", "A logger's house", "cottage", -15, 31, 4.8, 4.4, 3),
    building(daso, "daso-house-8", "A logger's house", "cottage", 31, 17, 4.8, 4.4, 3),
  ],

  // The yard is where the work happens, so that is where the clutter is; the
  // rest sits by the doors it belongs to.
  props: [
    { kind: "woodpile", ...daso.at(-5, -6), yaw: 0.1 },
    { kind: "woodpile", ...daso.at(5, -7), yaw: -0.4 },
    { kind: "woodpile", ...daso.at(-8, 4), yaw: 1.4 },
    { kind: "log", ...daso.at(-1, -3), yaw: 1.2 },
    { kind: "log", ...daso.at(3, -1.5), yaw: 1.35 },
    { kind: "log", ...daso.at(-4, 1.5), yaw: 0.2 },
    { kind: "log", ...daso.at(1, 4), yaw: 1.5 },
    { kind: "stump", ...daso.at(0, 1), yaw: 0 },
    { kind: "stump", ...daso.at(6, 4), yaw: 0 },
    { kind: "stump", ...daso.at(-6, -2.5), yaw: 0 },
    { kind: "stump", ...daso.at(-3, -10), yaw: 0 },
    { kind: "well", ...daso.at(-4, 8), yaw: 0.3 },
    // Lamps along the three streets, so the way in reads from the road.
    { kind: "lamp", ...daso.at(10, 5), yaw: 0 },
    { kind: "lamp", ...daso.at(20, -4), yaw: 0 },
    { kind: "lamp", ...daso.at(33, 5), yaw: 0 },
    { kind: "lamp", ...daso.at(-7, 12), yaw: 0 },
    { kind: "lamp", ...daso.at(2, 24), yaw: 0 },
    { kind: "lamp", ...daso.at(18, 12), yaw: 0 },
    { kind: "lamp", ...daso.at(-3, -18), yaw: 0 },
    { kind: "barrel", ...atDoor(DASO_INN, 0.8, -3.6) },
    { kind: "barrel", ...atDoor(DASO_INN, 1.3, -4.3) },
    { kind: "crate", ...atDoor(DASO_INN, 0.9, 3.8) },
    { kind: "woodpile", ...atDoor(DASO_MILL, 1.4, 3.2) },
    { kind: "log", ...atDoor(DASO_MILL, 3.2, 0.5) },
    { kind: "log", ...atDoor(DASO_SAWPIT, 2.6, -1.5) },
    { kind: "crate", ...atDoor(DASO_STORE, 0.9, -2) },
    { kind: "crate", ...atDoor(DASO_STORE, 1.1, -2.9) },
    { kind: "barrel", ...atDoor(DASO_STORE, 0.8, 2.2) },
    { kind: "crate", ...atDoor(DASO_CARTS, 1, 2.4) },
    { kind: "barrel", ...atDoor(DASO_SMITHY, 0.8, -2.4) },
    { kind: "stump", ...atDoor(DASO_SMITHY, 1.6, 1.8) },
    // The yard's edge, where the logs come in from the south.
    { kind: "fence", ...daso.at(-9, -19), yaw: 1.5 },
    { kind: "fence", ...daso.at(-6, -19.2), yaw: 1.5 },
    { kind: "fence", ...daso.at(8, -21), yaw: 1.4 },
    { kind: "fence", ...daso.at(31, 3), yaw: 0.1 },
    { kind: "fence", ...daso.at(31, -2), yaw: 0.1 },
  ],

  villagers: [
    {
      name: "Basan Log",
      // The vault's story: he finds an artifact in these woods and it speaks
      // to him. This is him before any of that happened.
      line: "There's a sound in the west woods. Like someone saying my name.",
      ...atDoor(DASO_BASAN, 1.6, 0.8),
      colour: 0x8a6b45,
    },
    {
      id: "herla", name: "Herla, innkeeper",
      line: "Fifty of us, and I know every order by heart. Sit where you like.",
      ...atDoor(DASO_INN, 1.6, 1.8),
      colour: 0x9a5b52,
    },
    {
      id: "osk", name: "Osk, timberwright",
      line: "Oak from the ridge, ash from the low ground. Don't mix them.",
      ...atDoor(DASO_MILL, 1.8, -2.2),
      colour: 0x5c7a52,
    },
    {
      id: "wen", name: "Wen, sawyer",
      line: "Work's work. Nobody comes to Daso on purpose.",
      ...atDoor(DASO_SAWPIT, 1.8, 1.2),
      colour: 0x4a6580,
    },
    {
      id: "ilda", name: "Ilda, hauler",
      line: "Careful past the treeline. Things have been coming closer.",
      ...atDoor(DASO_CARTS, 1.8, 0),
      colour: 0x7a5a80,
    },
    {
      id: "mott", name: "Mott, smith", vendor: true,
      line: "Axe-heads, saw teeth, hinges. Nothing fancy, and nothing that breaks. I'll buy what you're carrying.",
      ...atDoor(DASO_SMITHY, 1.8, 0.6),
      colour: 0x5a5550,
    },
    {
      name: "Brenna, woodcutter",
      line: "Three trees a day, every day. The forest doesn't notice.",
      ...daso.at(7, -3),
      yaw: looking(daso, 7, -3, 0, 0),
      colour: 0x6b8a4a,
    },
  ],

  // The forest closes round the town, opened where the three roads come in —
  // the Greywood track north, the Westroad north-east, the Ash road south —
  // and on the walk in from the waystone to the east.
  trees: treeRing(daso, 41, 30, [[-22, 10], [28, 62], [66, 90], [158, 196]]),
  woodland: true,
};

// --- Fanshona ---------------------------------------------------------------------

/**
 * Fanshona: a lake town in Brightwater, Terra's north-east.
 *
 * NOTE: the vault names Fanshona but these details — the lake, the docks,
 * the weighhouse, everyone in it — were invented for the game and should be
 * checked against the vault before anyone writes lore around them.
 *
 * Built as Daso's opposite. Daso is timber, a working camp nobody visits;
 * Fanshona is stone, a market everything passes through — fish off the lake,
 * timber down from Daso, stone from the moor. So it is laid out around a
 * harbour square that faces the water, with the Weighhouse and the trading
 * house across it from one another and the dock running out from its foot.
 *
 * The frame is turned so +z points at the lake. The roads decide the rest: one
 * comes in from the east along the south side and runs up the town's spine to
 * the square and on along the shore; the other comes from the west to the
 * waystone at the south of town. Nothing is built across either, and nothing
 * nearer the lake than its shore will hold.
 */
const FANSHONA_X = 2065;
const FANSHONA_Z = 1965;
/** The town faces its lake, which lies to the north-east. */
const fanshona = townFrame(FANSHONA_X, FANSHONA_Z, Math.PI / 4);

const FANSHONA_WEIGH = building(fanshona, "fanshona-weighhouse", "The Weighhouse", "hall", -14, 4, 11, 7.5, 5.4, [0, 4]);
const FANSHONA_TRADE = building(fanshona, "fanshona-trade", "The trading house", "stone", 14, 4, 9, 6.5, 4.6, [0, 4]);
const FANSHONA_NET = building(fanshona, "fanshona-house-3", "The net-house", "stone", -24, 10, 5, 4.4, 3.2, [0, 5]);
const FANSHONA_BOATHOUSE = building(fanshona, "fanshona-boathouse", "The boathouse", "shed", 25, 11, 7, 5, 3.6, [25, 30]);
const FANSHONA_LANTERN = building(fanshona, "fanshona-lantern", "The Lantern House", "hall", 0, -42, 9, 7, 5, [0, 0]);

export const FANSHONA: SettlementDefinition = {
  id: "fanshona",
  name: "Fanshona",
  subtitle: "Market town on the Brightwater",
  x: FANSHONA_X,
  z: FANSHONA_Z,
  radius: 42,
  woodland: false,
  // Set with the lake's level in ostras.ts, so the dock always reaches water.
  level: 10.2,

  buildings: [
    FANSHONA_WEIGH,
    FANSHONA_TRADE,
    FANSHONA_NET,
    FANSHONA_BOATHOUSE,
    FANSHONA_LANTERN,
    building(fanshona, "fanshona-house-1", "A fisher's house", "stone", -13, -8, 5.5, 4.6, 3.4, [0, -8]),
    building(fanshona, "fanshona-house-2", "A fisher's house", "stone", 13, -8, 5.5, 4.6, 3.4, [0, -8]),
    building(fanshona, "fanshona-house-5", "A boatwright's house", "stone", -33, 1, 5, 4.4, 3.3, [0, 4]),
    building(fanshona, "fanshona-house-4", "A trader's house", "stone", 26, -4, 5.2, 4.4, 3.6),
    building(fanshona, "fanshona-house-6", "A cooper's house", "stone", 16, -32, 5, 4.4, 3.3, [0, -26]),
    building(fanshona, "fanshona-house-7", "A fisher's house", "stone", 29, -30, 5, 4.4, 3.2, [0, -26]),
    building(fanshona, "fanshona-house-8", "A fisher's house", "stone", -14, -36, 5, 4.4, 3.2, [0, -26]),
    building(fanshona, "fanshona-house-9", "A stonecutter's house", "stone", -30, -6, 5.2, 4.6, 3.4),
  ],

  props: [
    { kind: "well", ...fanshona.at(-5, 8), yaw: 0 },
    // The market: stalls facing across the square and along the spine.
    { kind: "stall", ...fanshona.at(-7, -1), yaw: looking(fanshona, -7, -1, 0, -1) },
    { kind: "stall", ...fanshona.at(-8, 13), yaw: looking(fanshona, -8, 13, 0, 13) },
    { kind: "stall", ...fanshona.at(8, 12), yaw: looking(fanshona, 8, 12, 0, 12) },
    { kind: "stall", ...fanshona.at(9, -2), yaw: looking(fanshona, 9, -2, 0, -2) },
    { kind: "lamp", ...fanshona.at(-4, 15), yaw: 0 },
    { kind: "lamp", ...fanshona.at(5, 17), yaw: 0 },
    { kind: "lamp", ...fanshona.at(-5, -13), yaw: 0 },
    { kind: "lamp", ...fanshona.at(9, -13), yaw: 0 },
    { kind: "lamp", ...fanshona.at(-5, -30), yaw: 0 },
    { kind: "lamp", ...fanshona.at(5, -34), yaw: 0 },
    { kind: "crate", ...atDoor(FANSHONA_WEIGH, 0.9, -3.8) },
    { kind: "crate", ...atDoor(FANSHONA_WEIGH, 1.1, -4.7) },
    { kind: "barrel", ...atDoor(FANSHONA_WEIGH, 0.8, 3.6) },
    { kind: "barrel", ...atDoor(FANSHONA_TRADE, 0.8, -3) },
    { kind: "barrel", ...atDoor(FANSHONA_TRADE, 1.3, -3.6) },
    { kind: "crate", ...atDoor(FANSHONA_TRADE, 0.9, 3.2) },
    { kind: "barrel", ...atDoor(FANSHONA_NET, 0.8, -2) },
    { kind: "crate", ...atDoor(FANSHONA_BOATHOUSE, 1, -3) },
    // Out over the water from the foot of the square.
    { kind: "dock", ...fanshona.at(0, 38), yaw: fanshona.turn },
    { kind: "boat", ...fanshona.at(-5, 55), yaw: fanshona.turn + 1.4 },
    { kind: "boat", ...fanshona.at(5.5, 51), yaw: fanshona.turn + 1.7 },
  ],

  villagers: [
    {
      id: "maera", name: "Maera, harbourmistress",
      line: "Every boat on the Brightwater ties up here, or it doesn't tie up at all.",
      ...fanshona.at(-3, 17),
      yaw: looking(fanshona, -3, 17, 0, 0),
      colour: 0x3f6a8a,
    },
    {
      id: "tobin", name: "Tobin, net-mender",
      line: "The Wretches take a net a week. Spit straight through the mesh.",
      ...atDoor(FANSHONA_NET, 1.8, 1),
      colour: 0x6a7a5a,
    },
    {
      id: "ysolde", name: "Ysolde, weigher",
      line: "Fish, timber down from Daso, stone off the moor. Everything gets weighed.",
      ...atDoor(FANSHONA_WEIGH, 1.6, 0),
      colour: 0x8a5a6a,
    },
    {
      id: "caddo", name: "Old Caddo",
      line: "Came through the Gate the day it opened. Saw the lake and never left.",
      ...fanshona.at(-7, 9),
      yaw: looking(fanshona, -7, 9, -7, 30),
      colour: 0x7a6a50,
    },
    {
      id: "pell", name: "Pell, boatwright",
      line: "Thornback hide patches a hull, if you can get close enough to take one.",
      ...atDoor(FANSHONA_BOATHOUSE, 1.8, -1),
      colour: 0x8a6a3a,
    },
    {
      id: "corran", name: "Corran, trader", vendor: true,
      line: "Timber from Daso, fish from the lake, and me in the middle, taking a little of each. Yours too.",
      ...atDoor(FANSHONA_TRADE, 1.6, 0),
      colour: 0x6a5a8a,
    },
    {
      name: "Irrin, fishwife",
      line: "Fresh this morning. Well. Fresh this week.",
      ...fanshona.at(-8.8, -1),
      yaw: looking(fanshona, -8.8, -1, 0, -1),
      colour: 0x5a7a8a,
    },
    {
      name: "Sister Aveline",
      line: "We keep a lamp lit for everyone still out on the water. Some nights that's a lot of lamps.",
      ...atDoor(FANSHONA_LANTERN, 1.6, 0),
      colour: 0xb8a878,
    },
  ],

  trees: [
    { ...fanshona.at(-38, 12), radius: 0.6, height: 7.4 },
    { ...fanshona.at(38, 2), radius: 0.6, height: 7.9 },
    { ...fanshona.at(-26, -46), radius: 0.55, height: 6.8 },
    { ...fanshona.at(26, -46), radius: 0.6, height: 7.2 },
    { ...fanshona.at(-44, -4), radius: 0.6, height: 7.6 },
  ],
};

export const SETTLEMENTS: Record<string, SettlementDefinition> = {
  daso: DASO,
  fanshona: FANSHONA,
};
