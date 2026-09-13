/**
 * Trades: fishing now, and logging, mining and cooking as they arrive — each
 * with a level of its own, earned only by doing it.
 *
 * Combat went to one character level because a dozen bars trained by use were
 * a dozen things to keep in your head, and every new weapon was a step back
 * (see `levels.ts`). A trade is the other case. It is something you choose to
 * take up, apart from fighting, and "I am a good fisher" is exactly the kind
 * of thing a bar should say. So each trade keeps its own, and nothing about a
 * trade touches your character level: fishing pays no character XP, so an
 * afternoon at the lake is never a quicker road to 30 than the camps.
 *
 * What is stored is the total XP ever earned in a trade, not a level and a
 * remainder. A level is read back off the curve, so if the curve is retuned
 * everyone lands where their work puts them rather than where it used to.
 *
 * A trade's level decides what it can gather at all (a Sunscale will not rise
 * for a beginner), and how easily — see `fishing.ts`.
 */

export type TradeId = "fishing";

export interface TradeDefinition {
  id: TradeId;
  name: string;
  /** One line for the character screen. */
  description: string;
}

export const TRADES: Record<TradeId, TradeDefinition> = {
  fishing: {
    id: "fishing",
    name: "Fishing",
    description: "Face open water and press E to cast; click when something bites. Anything wider than a puddle has fish in it, and the sea has more.",
  },
};

export const TRADE_IDS = Object.keys(TRADES) as TradeId[];

export function isTradeId(value: unknown): value is TradeId {
  return typeof value === "string" && Object.hasOwn(TRADES, value);
}

/** The top of every trade. Half the character curve's length, because a
 *  trade is one thing done over and over, not a whole character. */
export const MAX_TRADE_LEVEL = 50;

/** Total XP earned in each trade. A missing trade is none. */
export type Trades = Partial<Record<TradeId, number>>;

// --- the curve ------------------------------------------------------------------

/** XP one gathering pays against something exactly your trade level. */
export function gatherXp(level: number): number {
  return 10 + 2 * Math.max(1, level);
}

/**
 * Gatherings of your own level each level takes. Five to level 2, a few more
 * each time, compounding gently. At your own level every time, that is about
 * 140 catches to 11, 1,000 to 31 and 2,900 to the top — at a catch every
 * quarter of a minute, a dozen hours at the water, and more in practice, since
 * not every bite is landed. `Math.pow` is fine: only the server decides a level.
 */
function gathersPerLevel(level: number): number {
  return 5 * Math.pow(level, 0.55) * Math.pow(1.025, level - 1);
}

/** XP from each level to the next, indexed by level (0 unused), in tens. */
const TRADE_XP_TABLE: readonly number[] = (() => {
  const table = [0];
  for (let level = 1; level < MAX_TRADE_LEVEL; level++) {
    table.push(Math.round((gathersPerLevel(level) * gatherXp(level)) / 10) * 10);
  }
  table.push(0);
  return table;
})();

/** Total XP at which each level starts, indexed by level. */
const TRADE_XP_AT: readonly number[] = (() => {
  const at = [0, 0];
  for (let level = 1; level < MAX_TRADE_LEVEL; level++) at.push(at[level]! + TRADE_XP_TABLE[level]!);
  return at;
})();

/** XP from `level` to the next. Zero at the top. */
export function tradeXpToNext(level: number): number {
  if (level >= MAX_TRADE_LEVEL || level < 1) return 0;
  return TRADE_XP_TABLE[Math.floor(level)]!;
}

/** The most total XP a trade can hold: the start of its top level. */
export const MAX_TRADE_XP = TRADE_XP_AT[MAX_TRADE_LEVEL]!;

/** Where a total puts you: the level, and how far into it. */
export interface TradeProgress {
  level: number;
  /** XP into this level; always below `toNext` (both zero at the top). */
  into: number;
  toNext: number;
}

export function tradeProgress(total: number): TradeProgress {
  const xp = Math.max(0, Math.min(MAX_TRADE_XP, Math.floor(total) || 0));
  let level = 1;
  while (level < MAX_TRADE_LEVEL && xp >= TRADE_XP_AT[level + 1]!) level++;
  const toNext = tradeXpToNext(level);
  return { level, into: toNext === 0 ? 0 : xp - TRADE_XP_AT[level]!, toNext };
}

export function tradeLevel(trades: Trades, id: TradeId): number {
  return tradeProgress(trades[id] ?? 0).level;
}

/**
 * How much of a gathering's XP you get for its level against your trade's.
 * Full for anything at or above you; falling away below, to nothing twelve
 * levels down — minnows teach a fisher of 20 nothing more.
 */
export const TRADE_GREY_GAP = 12;

export function gatherXpFor(goodLevel: number, tradeLevelNow: number): number {
  if (tradeLevelNow >= MAX_TRADE_LEVEL) return 0;
  const below = tradeLevelNow - goodLevel;
  const scale = below <= 0 ? 1 : below > TRADE_GREY_GAP ? 0 : 1 - below / (TRADE_GREY_GAP + 1);
  return Math.round(gatherXp(goodLevel) * scale);
}

/**
 * Add XP to a trade. Returns the level before and after, so the caller can
 * announce a level-up; XP past the top is not earned.
 */
export function addTradeXp(trades: Trades, id: TradeId, amount: number): { from: number; to: number } {
  const before = trades[id] ?? 0;
  const from = tradeProgress(before).level;
  const after = Math.min(MAX_TRADE_XP, before + Math.max(0, Math.floor(amount)));
  trades[id] = after;
  return { from, to: tradeProgress(after).level };
}

/** Trades from a save or the wire: known ids, whole numbers, within the curve. */
export function sanitiseTrades(raw: unknown): Trades {
  const trades: Trades = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return trades;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isTradeId(id) || typeof value !== "number" || !Number.isFinite(value)) continue;
    const xp = Math.max(0, Math.min(MAX_TRADE_XP, Math.floor(value)));
    if (xp > 0) trades[id] = xp;
  }
  return trades;
}
