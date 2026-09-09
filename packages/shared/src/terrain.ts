/**
 * The shape of the ground.
 *
 * Height has to be a pure function rather than a heightmap image, for the same
 * reason `applyInput` is shared: the server places you on the ground and the
 * client predicts where the ground will be, and if those two disagree by a
 * centimetre you get permanent vertical rubber-banding. A function both sides
 * call is identical by construction — there is no asset to load, no sampling
 * convention to get subtly wrong, and no image to fall out of sync with the
 * code.
 *
 * Deliberately a sum of waves rather than real noise. It is smooth (so walking
 * never jitters), cheap (called once per body per tick AND once per terrain
 * vertex when the client builds its mesh), and has no state to seed or share.
 */

/** An area blended flat, so a town does not sit on a hillside. */
export interface FlatZone {
  x: number;
  z: number;
  /** Fully flat inside this. */
  radius: number;
  /** Blends back to natural ground over this much further out. */
  falloff: number;
  /** The height it flattens to. */
  level: number;
}

export interface TerrainSettings {
  /** Metres from trough to crest, roughly. Zero is a flat plane. */
  amplitude: number;
  /** Bigger means tighter, more frequent hills. */
  frequency: number;
  /** Shifts the whole pattern, so two Ostras don't share a skyline. */
  phase: number;
  flats: FlatZone[];
}

/** Smooth 0..1 ramp. Linear blending leaves a visible crease where a flat
 *  zone meets the hills; this does not. */
function smoothstep(t: number): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return clamped * clamped * (3 - 2 * clamped);
}

export function heightAt(x: number, z: number, terrain: TerrainSettings): number {
  if (terrain.amplitude === 0 && terrain.flats.length === 0) return 0;

  const f = terrain.frequency;
  const p = terrain.phase;

  // Three octaves: broad rises, then two finer passes for texture. The
  // multipliers are deliberately not round numbers, so the waves don't line up
  // into an obvious repeating grid.
  let height =
    Math.sin(x * f + p) * Math.cos(z * f * 0.87 + p) * 1.0 +
    Math.sin(x * f * 2.31 + p * 1.7) * Math.cos(z * f * 2.13 + p * 0.6) * 0.42 +
    Math.sin(x * f * 4.73 + p * 3.1) * Math.cos(z * f * 4.29 + p * 2.2) * 0.18;

  height *= terrain.amplitude;

  for (const flat of terrain.flats) {
    const distance = Math.hypot(x - flat.x, z - flat.z);
    const outer = flat.radius + flat.falloff;
    if (distance >= outer) continue;

    // 0 at the centre (fully flattened) rising to 1 at the outer edge.
    const t = distance <= flat.radius
      ? 0
      : (distance - flat.radius) / flat.falloff;
    const natural = smoothstep(t);
    height = height * natural + flat.level * (1 - natural);
  }

  return height;
}

/**
 * The steepness at a point, as a 0..1 figure where 0 is level.
 *
 * Sampled rather than differentiated: the height function is a sum of waves
 * whose derivative is easy enough to write and easy to get wrong, and this is
 * only used to decide where grass will not grow.
 */
export function slopeAt(x: number, z: number, terrain: TerrainSettings): number {
  const step = 0.8;
  const here = heightAt(x, z, terrain);
  const dx = heightAt(x + step, z, terrain) - here;
  const dz = heightAt(x, z + step, terrain) - here;
  return Math.min(1, Math.hypot(dx, dz) / step);
}

/** A flat plane, for anywhere that wants no relief at all. */
export const FLAT_TERRAIN: TerrainSettings = {
  amplitude: 0,
  frequency: 0,
  phase: 0,
  flats: [],
};
