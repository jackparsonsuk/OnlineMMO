/**
 * Character level: one number for how far a character has come.
 *
 * This replaced proficiency — a separate 0-1000 scale for every spell, weapon
 * family, armour weight and trinket, each trained only by use. That system was
 * true to the vault's "like a muscle" line, but in play it asked you to keep a
 * dozen bars in your head, made every new weapon a step backwards, and never
 * produced the one moment an MMO is built around: the level-up.
 *
 * So there is one bar. Killing things fills it, and so does helping people.
 * Levels run 1 to MAX_LEVEL. The first few come in minutes; after that each
 * costs a little more than the last, compounding, so the top is a long road
 * rather than a wall (see XP_TABLE for the numbers).
 *
 * A level gives your class its base stats (`classes.ts`), the right to wear
 * gear of that level (`requiredLevel` in `items.ts`), and new abilities.
 *
 * Creature levels share the scale — a level-30 wolf is a fair fight for a
 * level-30 character — and the XP a kill pays depends on the gap between the
 * two, so the Gate Circle's Risen stop being worth anything long before they
 * stop being easy.
 */

/** The top, for now. */
export const MAX_LEVEL = 100;

/**
 * One creature level is ten points of item level.
 *
 * Creature and character levels stay small numbers you can read on a
 * nameplate, while item level keeps a finer scale — two level-12 swords can
 * still be told apart, and an unusually lucky drop can sit a level or two
 * above what dropped it. See `requiredLevel`.
 */
export const LEVEL_SCALE = 10;

// --- the curve ------------------------------------------------------------------

/** XP a kill pays against something exactly your level. */
export function killXp(level: number): number {
  return 40 + 10 * Math.max(1, level);
}

/**
 * Kills of your own level each level takes, at `level`.
 *
 * A power of the level for the early game — five kills to level 2, then a few
 * more each time — times a compounding 2.1% a level, which is what takes over
 * later and makes the top expensive. Fitted against a rough pace of ninety
 * kills an hour, counting travel and rest:
 *
 *   level 10   ~1 hour
 *   level 30   ~9 hours
 *   level 60   ~40 hours
 *   level 100  ~150 hours
 *
 * Quests pay on top of that, so the real numbers are a bit kinder.
 */
function killsPerLevel(level: number): number {
  return 5 * Math.pow(level, 0.52) * Math.pow(1.021, level - 1);
}

/**
 * XP from each level to the next, indexed by level (0 unused). Built once and
 * rounded to tens so the numbers on the bar are ones a person can read.
 *
 * `Math.pow` is fine here, unlike in worldgen: only the server decides when
 * you level, and the client uses this for nothing but the width of a bar.
 */
const XP_TABLE: readonly number[] = (() => {
  const table = [0];
  for (let level = 1; level < MAX_LEVEL; level++) {
    table.push(Math.round((killsPerLevel(level) * killXp(level)) / 10) * 10);
  }
  table.push(0);
  return table;
})();

/** XP from `level` to the next. Zero at the top: there is no next. */
export function xpToNext(level: number): number {
  if (level >= MAX_LEVEL || level < 1) return 0;
  return XP_TABLE[Math.floor(level)]!;
}

/** A character's place on the curve. */
export interface Progress {
  level: number;
  /** Towards the next level; always below `xpToNext(level)`. */
  xp: number;
}

/**
 * Add XP, carrying over as many levels as it pays for. At the top it stops:
 * XP past MAX_LEVEL is simply not earned.
 */
export function addXp(progress: Progress, gained: number): Progress & { levelsGained: number } {
  let { level, xp } = progress;
  let levelsGained = 0;
  xp += Math.max(0, Math.floor(gained));
  while (level < MAX_LEVEL && xp >= xpToNext(level)) {
    xp -= xpToNext(level);
    level++;
    levelsGained++;
  }
  if (level >= MAX_LEVEL) xp = 0;
  return { level, xp, levelsGained };
}

/**
 * What dying costs: a tenth of what this level takes, out of the progress made
 * through it — never a level, so a bad fight cannot undo a level-up, and
 * nothing at all before level 3, while dying is still how you learn the
 * fight.
 *
 * Dying used to cost a walk from the nearest waystone and nothing else, so
 * pulling something far above you had no downside worth weighing; with the
 * level gap making such fights hopeless, it needed one. XP rather than gold
 * or gear because it is the thing you were spending the time on anyway, and a
 * tenth is a few kills to earn back — enough to notice, not enough to stop
 * anyone trying.
 */
export const DEATH_XP_SHARE = 0.1;
export const DEATH_PENALTY_FROM = 3;

export function deathXpLoss(progress: Progress): number {
  if (progress.level < DEATH_PENALTY_FROM || progress.level >= MAX_LEVEL) return 0;
  return Math.min(progress.xp, Math.round(xpToNext(progress.level) * DEATH_XP_SHARE));
}

/** A save's level and XP made sane: a hand-edited row costs some XP, never a session. */
export function sanitiseProgress(rawLevel: unknown, rawXp: unknown): Progress {
  const level = typeof rawLevel === "number" && Number.isFinite(rawLevel)
    ? Math.max(1, Math.min(MAX_LEVEL, Math.floor(rawLevel)))
    : 1;
  const xp = typeof rawXp === "number" && Number.isFinite(rawXp)
    ? Math.max(0, Math.min(Math.max(0, xpToNext(level) - 1), Math.floor(rawXp)))
    : 0;
  return { level, xp };
}

// --- what a kill is worth ----------------------------------------------------------

/**
 * How many levels below you something can be and still teach you anything.
 * Five at the start, widening as you climb, so the band of worthwhile
 * creatures stays a similar share of the world.
 */
export function greyGap(playerLevel: number): number {
  return 5 + Math.floor(playerLevel / 10);
}

/** Bonus per level something is above you, and how many levels count. */
const ABOVE_BONUS = 0.05;
const ABOVE_BONUS_LEVELS = 5;

/**
 * How much of a kill's (or a quest's) XP you get for its level against yours:
 * a little more for something above you, falling away to nothing once it is
 * grey. Without the fall-off, the fastest way to level 100 would be the
 * rabbits by the Gate Circle.
 */
export function levelXpScale(targetLevel: number, playerLevel: number): number {
  const diff = targetLevel - playerLevel;
  if (diff >= 0) return 1 + ABOVE_BONUS * Math.min(diff, ABOVE_BONUS_LEVELS);
  const gap = greyGap(playerLevel);
  if (-diff > gap) return 0;
  return 1 - -diff / (gap + 1);
}

/** An elite is a fight, not a kill: several times the XP. */
export const ELITE_XP_MULTIPLIER = 8;

/** XP for killing something of `creatureLevel` at `playerLevel`. */
export function killXpFor(creatureLevel: number, playerLevel: number, elite = false): number {
  if (playerLevel >= MAX_LEVEL) return 0;
  const scaled = killXp(creatureLevel) * levelXpScale(creatureLevel, playerLevel) * (elite ? ELITE_XP_MULTIPLIER : 1);
  return Math.round(scaled);
}

// --- reading a level at a glance ---------------------------------------------------

/**
 * How dangerous something looks, WoW's "con" colours: grey is beneath you
 * (and pays nothing), green is easy, yellow is a fair fight, orange is hard,
 * red is a mistake.
 */
export type Difficulty = "grey" | "green" | "yellow" | "orange" | "red";

export function difficultyOf(targetLevel: number, playerLevel: number): Difficulty {
  const diff = targetLevel - playerLevel;
  if (diff >= 5) return "red";
  if (diff >= 3) return "orange";
  if (diff >= -2) return "yellow";
  if (-diff <= greyGap(playerLevel)) return "green";
  return "grey";
}

export const DIFFICULTY_COLOUR: Record<Difficulty, string> = {
  grey: "#9aa1a8",
  green: "#5fd068",
  yellow: "#f0d060",
  orange: "#f0913c",
  red: "#f05a4a",
};
