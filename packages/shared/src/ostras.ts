/**
 * The Ostras the game currently knows about, and the Gates between them.
 *
 * In the fiction the Gates were shut down in Y1100 and the Ostracon has been
 * isolated ever since; this game is set at the moment they come back on, which
 * is why there are so few of them and why Terra is the only hub. Named Ostras
 * are hand-authored and persistent, like these. Unnamed Ostras — the small,
 * beast-ridden ones — are meant to be generated into this same shape later, so
 * keep this a plain data table rather than anything clever.
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
  /** Background, behind everything. */
  sky: string;
  /** Ground fill and grid lines. */
  ground: string;
  grid: string;
  /** Boundary walls. */
  edge: string;
  /** Ambient bounce colour, tinting everything in shadow. */
  bounce: string;
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
}

/** Face the middle of the Ostra from a point on its edge. */
function facingCentre(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

export const OSTRAS: Record<OstraId, OstraDefinition> = {
  terra: {
    id: "terra",
    name: "Terra Ostra",
    subtitle: "Earth Shard",
    size: 80,
    spawn: { x: 0, z: 0 },
    palette: {
      sky: "#0d1117",
      ground: "#111a16",
      grid: "#3f6b52",
      edge: "#2b4438",
      bounce: "#1a2620",
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
  },

  barals: {
    id: "barals",
    name: "Barals Ostra",
    subtitle: "Realm of Fire and Pain",
    size: 60,
    spawn: { x: 0, z: 0 },
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

export function findGate(ostra: OstraDefinition, gateId: string): GateDefinition | undefined {
  return ostra.gates.find((gate) => gate.id === gateId);
}
