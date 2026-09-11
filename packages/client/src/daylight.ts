import { Color3, Color4, Vector3 } from "@babylonjs/core/Maths/math.js";
import { AMBIENT_INTENSITY, SUN_INTENSITY, paintSky, type World } from "./scene.js";

/**
 * Day and night. A day lasts DAY_MS, and where we are in it is read from the
 * wall clock, so every player sees the same sky at the same moment with
 * nothing sent over the wire and nothing for the server to keep — the time
 * of day decides nothing in the simulation, only the light.
 *
 * Forty minutes, so an evening's play sees a dusk and a dawn; night is about
 * a third of it. Night is moonlit blue rather than dark: dark enough that the
 * lamps in Daso's windows (emissive, so they glow on their own) read as lit,
 * never so dark that you cannot see what is biting you.
 *
 * Dungeons keep their own torchlight and ignore the clock.
 */
export const DAY_MS = 40 * 60_000;

/** Moves the clock for testing (`(await import("/src/daylight.ts")).setDayOffset(ms)`). */
let offsetMs = 0;
export function setDayOffset(ms: number): void {
  offsetMs = ms;
  lastUpdate = -Infinity;
}

/** 0–1 through the day: 0 is midnight, 0.5 midday. */
export function dayPhase(now = Date.now()): number {
  const t = (now + offsetMs) % DAY_MS;
  return (t < 0 ? t + DAY_MS : t) / DAY_MS;
}

interface Light {
  /** Multipliers on the Ostra's own sky colour, at the horizon (and fog) and overhead. */
  horizon: Color3;
  zenith: Color3;
  sun: number;
  sunColour: Color3;
  /** Where the light travels; normalised after blending. */
  sunDirection: Vector3;
  ambient: number;
  ambientColour: Color3;
}

const rgb = (r: number, g: number, b: number): Color3 => new Color3(r, g, b);
const dir = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);

const NIGHT: Light = {
  horizon: rgb(0.17, 0.21, 0.36), zenith: rgb(0.1, 0.12, 0.26),
  sun: 0.36, sunColour: rgb(0.62, 0.72, 1), sunDirection: dir(0.3, -0.85, 0.4),
  ambient: 0.52, ambientColour: rgb(0.55, 0.66, 0.95),
};
const DAWN: Light = {
  horizon: rgb(1.25, 0.82, 0.62), zenith: rgb(0.72, 0.72, 0.95),
  sun: 0.7, sunColour: rgb(1, 0.74, 0.52), sunDirection: dir(-0.9, -0.3, -0.25),
  ambient: 0.8, ambientColour: rgb(1, 0.88, 0.82),
};
/** The morning is today's long-standing afternoon look; the light swings
 *  across to the other side by the afternoon, so shadows move through the day. */
const MORNING: Light = {
  horizon: rgb(1, 1, 1), zenith: rgb(1, 1, 1),
  sun: 1, sunColour: rgb(1, 0.96, 0.87), sunDirection: dir(-0.55, -0.85, -0.4),
  ambient: 1, ambientColour: rgb(1, 1, 1),
};
const AFTERNOON: Light = { ...MORNING, sunDirection: dir(0.5, -0.8, -0.35) };
const DUSK: Light = {
  horizon: rgb(1.3, 0.72, 0.5), zenith: rgb(0.55, 0.5, 0.82),
  sun: 0.68, sunColour: rgb(1, 0.62, 0.4), sunDirection: dir(0.9, -0.3, -0.25),
  ambient: 0.75, ambientColour: rgb(0.95, 0.82, 0.8),
};

/** The day, as keyframes on the phase; blended linearly between. */
const KEYS: Array<[number, Light]> = [
  [0, NIGHT],
  [0.2, NIGHT],
  [0.27, DAWN],
  [0.35, MORNING],
  [0.72, AFTERNOON],
  [0.8, DUSK],
  [0.87, NIGHT],
  [1, NIGHT],
];

/** The sky only needs repainting a few times a second: a whole day is forty minutes. */
const UPDATE_MS = 250;
let lastUpdate = -Infinity;

const horizon = new Color3();
const zenith = new Color3();
const direction = new Vector3();

/** Once a frame: set the light for the time of day. `force` after an Ostra changes. */
export function updateDaylight(world: World, now = Date.now(), force = false): void {
  if (!force && now - lastUpdate < UPDATE_MS) return;
  lastUpdate = now;
  const ostra = world.ostra;
  if (!ostra || ostra.dungeon) return;

  const phase = dayPhase(now);
  let i = 0;
  while (i < KEYS.length - 2 && phase >= KEYS[i + 1]![0]) i++;
  const [fromAt, from] = KEYS[i]!;
  const [toAt, to] = KEYS[i + 1]!;
  const raw = toAt > fromAt ? (phase - fromAt) / (toAt - fromAt) : 0;
  // Eased, so each change of light settles in rather than turning a corner.
  const t = raw * raw * (3 - 2 * raw);
  const mix = (a: number, b: number): number => a + (b - a) * t;

  const palette = ostra.palette;
  const light = palette.light ?? 1;
  const sky = Color3.FromHexString(palette.sky);
  const overhead = sky.scale(ostra.wilds ? 0.62 : 0.5);
  Color3.LerpToRef(from.horizon, to.horizon, t, horizon);
  Color3.LerpToRef(from.zenith, to.zenith, t, zenith);
  horizon.multiplyToRef(sky, horizon).clampToRef(0, 1, horizon);
  zenith.multiplyToRef(overhead, zenith).clampToRef(0, 1, zenith);
  paintSky(world.sky, horizon, zenith);
  world.scene.clearColor = Color4.FromColor3(horizon, 1);
  world.scene.fogColor = horizon.clone();

  world.sun.intensity = SUN_INTENSITY * light * mix(from.sun, to.sun);
  Color3.LerpToRef(from.sunColour, to.sunColour, t, world.sun.diffuse);
  Vector3.LerpToRef(from.sunDirection, to.sunDirection, t, direction);
  world.sun.direction.copyFrom(direction.normalize());
  world.ambient.intensity = AMBIENT_INTENSITY * light * mix(from.ambient, to.ambient);
  Color3.LerpToRef(from.ambientColour, to.ambientColour, t, world.ambient.diffuse);
}
