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
  yaw: number;
  /** Changes the roof and trim. */
  style: "cottage" | "hall" | "shed";
}

/** Scenery with no collision — you walk through the long grass, not around it. */
export interface PropDefinition {
  kind: "log" | "stump" | "barrel" | "crate" | "lamp" | "fence" | "woodpile";
  x: number;
  z: number;
  yaw: number;
}

/** Someone standing at their work. Static: a logging town at work is people
 *  in fixed places, and it costs no bandwidth at all. */
export interface VillagerDefinition {
  name: string;
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
}

/**
 * West of Vareto, per the vault. Terra's west is negative X — and now that
 * Terra is eight kilometres across, "west" means a real journey: a
 * kilometre and a half out along the Westroad from the Gate Circle, which is
 * about right for a town nobody visits on purpose.
 */
const DASO_X = -1450;
const DASO_Z = -180;

/** Relative to the town centre, so the whole place can be moved by editing two
 *  numbers rather than sixty. */
function at(dx: number, dz: number): { x: number; z: number } {
  return { x: DASO_X + dx, z: DASO_Z + dz };
}

export const DASO: SettlementDefinition = {
  id: "daso",
  name: "Daso",
  subtitle: "A logging town, fifty souls",
  x: DASO_X,
  z: DASO_Z,
  radius: 19,

  buildings: [
    {
      id: "daso-inn",
      name: "The Felled Oak",
      ...at(0, 7),
      width: 9,
      depth: 6.5,
      height: 4.6,
      yaw: 0.06,
      style: "hall",
    },
    {
      id: "daso-house-1",
      name: "Basan's house",
      ...at(-8.5, -1),
      width: 5,
      depth: 4.4,
      height: 3.1,
      yaw: -0.32,
      style: "cottage",
    },
    {
      id: "daso-house-2",
      name: "A logger's house",
      ...at(-7, -8),
      width: 4.6,
      depth: 4.2,
      height: 3.0,
      yaw: 0.5,
      style: "cottage",
    },
    {
      id: "daso-house-3",
      name: "A logger's house",
      ...at(6.5, -6.5),
      width: 4.8,
      depth: 4.2,
      height: 3.0,
      yaw: -0.18,
      style: "cottage",
    },
    {
      id: "daso-house-4",
      name: "A logger's house",
      ...at(9.5, 1.5),
      width: 4.4,
      depth: 4.4,
      height: 3.0,
      yaw: 0.72,
      style: "cottage",
    },
    {
      id: "daso-mill",
      name: "The timber shed",
      ...at(1, -9),
      width: 7.5,
      depth: 5,
      height: 3.6,
      yaw: -0.1,
      style: "shed",
    },
  ],

  // The yard between the shed and the inn is where the work happens, so that
  // is where the clutter is.
  props: [
    { kind: "woodpile", ...at(-2.5, -4.5), yaw: 0.1 },
    { kind: "woodpile", ...at(3.5, -4), yaw: -0.4 },
    { kind: "log", ...at(-0.5, -2.5), yaw: 1.2 },
    { kind: "log", ...at(1.5, -1.5), yaw: 1.35 },
    { kind: "log", ...at(-4.5, 2), yaw: 0.2 },
    { kind: "stump", ...at(0, -0.5), yaw: 0 },
    { kind: "stump", ...at(5.5, 4), yaw: 0 },
    { kind: "stump", ...at(-6, 5.5), yaw: 0 },
    { kind: "barrel", ...at(-3.6, 8.2), yaw: 0 },
    { kind: "barrel", ...at(-2.7, 8.6), yaw: 0.4 },
    { kind: "crate", ...at(4.6, 7.6), yaw: 0.25 },
    { kind: "crate", ...at(5.4, 6.6), yaw: -0.5 },
    { kind: "lamp", ...at(-2, 3.5), yaw: 0 },
    { kind: "lamp", ...at(4, 2.5), yaw: 0 },
    { kind: "lamp", ...at(0.5, 10.5), yaw: 0 },
    { kind: "fence", ...at(-11, 3), yaw: 0.15 },
    { kind: "fence", ...at(-11.4, 6), yaw: 0.15 },
    { kind: "fence", ...at(11.5, -2), yaw: -0.1 },
    { kind: "fence", ...at(11.7, 1), yaw: -0.1 },
  ],

  villagers: [
    {
      name: "Basan Log",
      // The vault's story: he finds an artifact in these woods and it speaks
      // to him. This is him before any of that happened.
      line: "There's a sound in the west woods. Like someone saying my name.",
      ...at(-7.5, 1),
      yaw: 2.4,
      colour: 0x8a6b45,
    },
    {
      name: "Herla, innkeeper",
      line: "Fifty of us, and I know every order by heart. Sit where you like.",
      ...at(-1, 4.2),
      yaw: 0.1,
      colour: 0x9a5b52,
    },
    {
      name: "Osk, timberwright",
      line: "Oak from the ridge, ash from the low ground. Don't mix them.",
      ...at(1.8, -6),
      yaw: 0.4,
      colour: 0x5c7a52,
    },
    {
      name: "Wen, sawyer",
      line: "Work's work. Nobody comes to Daso on purpose.",
      ...at(-2.2, -6.2),
      yaw: -0.6,
      colour: 0x4a6580,
    },
    {
      name: "Ilda, hauler",
      line: "Careful past the treeline. Things have been coming closer.",
      ...at(7.5, 3.5),
      yaw: -1.5,
      colour: 0x7a5a80,
    },
  ],

  // A ring of woodland, thinned on the east where the road comes in.
  trees: [
    { ...at(-15, -12), radius: 0.85, height: 7.5 },
    { ...at(-17, -6), radius: 0.95, height: 8.4 },
    { ...at(-16.5, 2), radius: 0.8, height: 7.0 },
    { ...at(-14.5, 9), radius: 0.9, height: 7.8 },
    { ...at(-9, 13.5), radius: 0.85, height: 7.2 },
    { ...at(-2, 15.5), radius: 0.95, height: 8.6 },
    { ...at(5, 14.5), radius: 0.8, height: 7.1 },
    { ...at(12, 11), radius: 0.9, height: 7.9 },
    { ...at(-12, -15), radius: 0.85, height: 7.4 },
    { ...at(-4, -16), radius: 0.9, height: 8.0 },
    { ...at(4, -15.5), radius: 0.8, height: 7.2 },
    { ...at(11, -13), radius: 0.95, height: 8.3 },
    { ...at(16, -8), radius: 0.85, height: 7.6 },
  ],
};

export const SETTLEMENTS: Record<string, SettlementDefinition> = {
  daso: DASO,
};
