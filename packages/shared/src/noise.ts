/**
 * Deterministic noise, for terrain and for scattering things across it.
 *
 * Both sides of the wire evaluate this — the server to stand bodies on the
 * ground and decide where trees block you, the client to predict the same and
 * to draw it — so it must give BIT-IDENTICAL answers in Node and in every
 * browser. `Math.sin` and friends do not promise that: each engine is free to
 * approximate them differently in the last bits. Nothing here uses them.
 * Hashing is `Math.imul` on integers and everything else is `+ - * /` and
 * `Math.floor`, which IEEE 754 pins down exactly everywhere.
 *
 * The old terrain was a sum of sine waves, which was fine over eighty metres
 * and would have tiled visibly over eight kilometres.
 */

/** A well-mixed 32-bit hash of an integer lattice point. */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** `hash2` as a float in [0, 1). */
export function hashUnit(ix: number, iz: number, seed: number): number {
  return hash2(ix, iz, seed) / 4294967296;
}

/** Feed a hash back into itself for another independent-looking value. */
export function rehash(h: number, salt: number): number {
  return hash2(h | 0, salt, 0x5bd1e995);
}

/** Eight unit gradients. Literal constants rather than cos/sin of an angle,
 *  for the reason at the top of the file. */
const GRAD_X = [1, -1, 0, 0, 0.7071067811865476, -0.7071067811865476, 0.7071067811865476, -0.7071067811865476];
const GRAD_Z = [0, 0, 1, -1, 0.7071067811865476, 0.7071067811865476, -0.7071067811865476, -0.7071067811865476];

/** Quintic ease: zero first AND second derivative at the lattice, so slopes
 *  are continuous and there is no visible crease along grid lines. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function corner(ix: number, iz: number, seed: number, dx: number, dz: number): number {
  const g = hash2(ix, iz, seed) & 7;
  return GRAD_X[g]! * dx + GRAD_Z[g]! * dz;
}

/** 2D gradient noise, roughly in [-1, 1], with a feature size of one unit. */
export function gradientNoise(x: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;

  const n00 = corner(x0, z0, seed, fx, fz);
  const n10 = corner(x0 + 1, z0, seed, fx - 1, fz);
  const n01 = corner(x0, z0 + 1, seed, fx, fz - 1);
  const n11 = corner(x0 + 1, z0 + 1, seed, fx - 1, fz - 1);

  const u = fade(fx);
  const v = fade(fz);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  // Unit gradients peak at sqrt(0.5); scale back up to about +-1.
  return (a + (b - a) * v) * 1.4142135623730951;
}

/** Rotation applied between octaves so their lattices never line up into a
 *  visible grid. cos/sin of ~0.6 rad, written out as constants. */
const ROT_C = 0.8253356149096783;
const ROT_S = 0.5646424733950354;

/**
 * Fractal sum of `octaves` layers, each twice the frequency and half the
 * amplitude of the last. Normalised so the result stays roughly in [-1, 1]
 * whatever the octave count.
 */
export function fbm(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += gradientNoise(px, pz, seed + i * 1013) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    const rx = (px * ROT_C - pz * ROT_S) * 2.03;
    const rz = (px * ROT_S + pz * ROT_C) * 2.03;
    px = rx;
    pz = rz;
  }
  return sum / norm;
}

/**
 * Ridged fractal: sharp crests, broad valleys — what mountains look like,
 * rather than the rounded blobs plain fbm gives. In [0, 1].
 */
export function ridged(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    const n = gradientNoise(px, pz, seed + i * 7919);
    const crest = 1 - (n < 0 ? -n : n);
    sum += crest * crest * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    const rx = (px * ROT_C - pz * ROT_S) * 2.07;
    const rz = (px * ROT_S + pz * ROT_C) * 2.07;
    px = rx;
    pz = rz;
  }
  return sum / norm;
}

/**
 * Ridged multifractal: each octave's detail is weighted by how near the octave
 * before it was to a crest. So the crests grow spurs and broken tops, and the
 * valleys between them stay smooth — which is what separates a mountain range
 * from `ridged`'s even tangle of ridges, where every octave is as rough in the
 * valley floor as on the summit. In [0, 1], and mostly well below 1.
 */
export function ridgedMulti(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let weight = 1;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    const n = gradientNoise(px, pz, seed + i * 6151);
    let signal = 1 - (n < 0 ? -n : n);
    signal *= signal * weight;
    weight = signal * 2;
    if (weight > 1) weight = 1;
    sum += signal * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    const rx = (px * ROT_C - pz * ROT_S) * 2.11;
    const rz = (px * ROT_S + pz * ROT_C) * 2.11;
    px = rx;
    pz = rz;
  }
  return sum / norm;
}

/** Smooth 0..1 ramp. Linear blending leaves a visible crease; this does not. */
export function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}
