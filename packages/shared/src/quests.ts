/**
 * Quests: people in the world asking for help, and paying for it.
 *
 * A quest is data — who gives it, who takes it back, what must be done, what it
 * pays — and a player's progress is a small record of counts. Both sides read
 * this file: the client to draw the dialogue, the tracker and the "!" over a
 * villager's head; the server, which is the only one that ever advances or
 * completes anything, to check every request against the same rules.
 *
 * Objectives are the handful of things the world can already tell apart:
 *
 *   kill     — N of a kind of creature
 *   slay     — one particular elite (see `elites.ts`)
 *   collect  — N of something that only some of a kind of creature carry
 *   visit    — stand at a place
 *   gather   — pick N of something up off the ground in a place (`gathering.ts`)
 *
 * and a quest whose `turnIn` is someone other than its `giver` is a delivery:
 * finishing it means walking there.
 *
 * Collected things are counted, not carried. A pack full of wolf fangs would
 * be thirty slots of clutter the loot system has no use for.
 *
 * Rewards are gold, one item of the player's choosing from a few, and XP. A
 * quest is pitched at a level: it is offered from a few levels below it, its
 * items are of that level, and its XP is a share of that level's worth —
 * falling away, like a kill's, once you have outgrown it (see `questXp`).
 */

import type { ClassId } from "./classes.js";
import type { EnemyKind } from "./enemies.js";
import type { GatherThingId } from "./gathering.js";
import { basesFor, encodeItem, type ItemKey, type Rarity } from "./items.js";
import { LEVEL_SCALE, levelXpScale, MAX_LEVEL, xpToNext } from "./levels.js";
import { hash2 } from "./noise.js";
import type { OstraId } from "./ostras.js";
import { SETTLEMENTS, type SettlementDefinition, type VillagerDefinition } from "./settlements.js";

/**
 * A kill or collect can ask for one creature variant (`variants.ts`) rather
 * than a whole kind: a variant lives in one hunting area, so the quest has a
 * place, and the map can draw it. Its `creature`/`from` is still the kind.
 */
export type QuestObjective =
  | { kind: "kill"; creature: EnemyKind; variant?: string; count: number; label: string }
  | { kind: "slay"; elite: string; label: string }
  | { kind: "collect"; from: EnemyKind; variant?: string; count: number; chance: number; label: string }
  /** In `ostra` — Terra when absent. Every small Ostra and dungeon is built
   *  round its own origin, so coordinates alone would put the Gate Circle in
   *  the middle of the barrow's pillared hall. */
  | { kind: "visit"; x: number; z: number; radius: number; label: string; ostra?: OstraId }
  /** N of a thing lying about in a circle, picked up with E (`gathering.ts`).
   *  `spots` is how many lie there at once, twice `count` when unset. */
  | {
    kind: "gather"; thing: GatherThingId; count: number; x: number; z: number; radius: number;
    label: string; ostra?: OstraId; spots?: number;
  };

export interface QuestRewards {
  gold: number;
  /**
   * XP, as a share of a whole level at the quest's own level: 0.5 pays half
   * of what it takes to get from that level to the next. A share rather than
   * a number so re-tuning the curve (`levels.ts`) cannot leave every quest
   * paying too much or nothing.
   */
  xpShare: number;
  /** How many items to choose between, and how good they are. */
  choices: number;
  rarity: Rarity;
}

export interface QuestDefinition {
  id: string;
  title: string;
  /** Villager ids (see `VillagerDefinition.id`). */
  giver: string;
  turnIn: string;
  /** Level it is pitched at: when it is offered, its reward items' level,
   *  and what its XP is a share of. */
  level: number;
  /** Quests that must be done first. */
  requires: string[];
  /** One line for the log and the tracker. */
  summary: string;
  /** What the giver says when offering it... */
  offer: string;
  /** ...when you come back before it's done... */
  progress: string;
  /** ...and what whoever takes it back says when it is. */
  complete: string;
  objectives: QuestObjective[];
  rewards: QuestRewards;
}

/** A player's quests: progress per objective for those under way, and the ids
 *  of those finished. Persisted with the character. */
export interface QuestLog {
  active: Record<string, number[]>;
  done: string[];
}

/** Anyone further than this from a villager is not talking to them. */
export const TALK_RANGE = 5;

/** More quests under way than this and you should finish some first. */
export const MAX_ACTIVE_QUESTS = 12;

/** A quest is offered to anyone within this many levels below it. Any
 *  further and the villager can tell you are not ready. */
export const QUEST_LEVEL_LEAD = 3;

// --- the quests ---------------------------------------------------------------

/** Daso is where everyone starts, in the Westwood (levels 1-5). */
const DASO_LEVEL = 3;
/** Fanshona sits in the Brightwater, at the far end of Terra from Daso. */
const FANSHONA_LEVEL = 23;

export const QUESTS: Record<string, QuestDefinition> = {
  // --- Daso -------------------------------------------------------------------------
  "herla-wolves": {
    id: "herla-wolves", title: "A Hunter's Welcome", giver: "herla", turnIn: "herla", level: DASO_LEVEL,
    requires: [],
    summary: "Kill Pathstalkers on the Woodcutters' Path, south-west of Daso, for Herla.",
    offer: "You'll be wanting a bed, and I'll be wanting the wolves off the woodcutters' path. "
      + "Five of them, and the room's yours for the week.",
    progress: "Still hearing howling. Not five yet, then.",
    complete: "Five. I heard every one of them go quiet. Sit down — the first one's on the house.",
    objectives: [{ kind: "kill", creature: "wolf", variant: "pathstalker", count: 5, label: "Pathstalkers killed" }],
    rewards: { gold: 12, xpShare: 0.5, choices: 2, rarity: "common" },
  },
  "osk-webs": {
    id: "osk-webs", title: "Webs in the Timber", giver: "osk", turnIn: "osk", level: DASO_LEVEL,
    requires: [],
    summary: "Clear the Thicket Weavers out of the Webbed Thicket, north-west of Daso, for Osk.",
    offer: "Spiders have got into the stacked oak. Webs through the grain, eggs in the knots. They come in from "
      + "the thicket north-west of town — the Webbed Thicket, we call it now. Thin them out before the yard's worth nothing.",
    progress: "Found another nest this morning. Keep at it.",
    complete: "Good. I'll burn the worst of the stack, but the rest'll season. You've saved me a year.",
    objectives: [{ kind: "kill", creature: "spider", variant: "thicket-weaver", count: 6, label: "Thicket Weavers killed" }],
    rewards: { gold: 12, xpShare: 0.5, choices: 2, rarity: "common" },
  },
  "wen-fangs": {
    id: "wen-fangs", title: "Teeth for the Saw", giver: "wen", turnIn: "wen", level: DASO_LEVEL,
    requires: ["herla-wolves"],
    summary: "Bring Wen fangs from the Pathstalkers on the Woodcutters' Path.",
    offer: "Heard you've been at the wolves. Wolf fang makes a better saw-set than anything the smith sells — "
      + "don't ask me why. Bring me four good ones.",
    progress: "Those are chipped. Good ones, I said.",
    complete: "Now that's a set. Hear that? That's a blade that'll go through ash like it's butter.",
    objectives: [{ kind: "collect", from: "wolf", variant: "pathstalker", count: 4, chance: 0.5, label: "Good wolf fangs" }],
    rewards: { gold: 15, xpShare: 0.6, choices: 3, rarity: "uncommon" },
  },
  // Errands with no fight in them — or none you have to pick. Something to do
  // for someone other than hit a thing, and a walk out to somewhere.
  "herla-moonwort": {
    id: "herla-moonwort", title: "Moonwort for the Kitchen", giver: "herla", turnIn: "herla", level: 2,
    requires: [],
    summary: "Gather moonwort in the glade north-west of Daso for Herla's kitchen.",
    offer: "My cook's down with the fen-shakes, and there's only one thing brings that fever down. Moonwort. "
      + "It grows in the glade north-west of town — you'll know it, it catches the light like it's wet. Six sprigs.",
    progress: "North-west of town, in the glade. It glows a little. You can't miss it, even in daylight.",
    complete: "That's it, that's the smell. He'll be cursing me by supper. You've a better eye for it than my last three.",
    objectives: [{
      kind: "gather", thing: "moonwort", count: 6, x: -1530, z: -30, radius: 34, label: "Moonwort gathered",
    }],
    rewards: { gold: 8, xpShare: 0.45, choices: 2, rarity: "common" },
  },
  "ilda-sacks": {
    id: "ilda-sacks", title: "Salt on the Road", giver: "ilda", turnIn: "ilda", level: 4,
    requires: ["ilda-westroad"],
    summary: "Recover the salt sacks spilled along the road north-east of Daso.",
    offer: "I went back out along the road. The cart shed half its load before the horse came home — salt, "
      + "sacks of it, all through the grass either side. Salt's worth more than the cart. "
      + "Bring me back what isn't split.",
    progress: "North-east of town, where the road bends. Watch the trees.",
    complete: "Eight whole sacks. We'll eat this winter, then. Still no sign of him, was there? ...No.",
    objectives: [{
      kind: "gather", thing: "saltSack", count: 8, x: -1040, z: 68, radius: 36, label: "Salt sacks recovered",
    }],
    rewards: { gold: 14, xpShare: 0.6, choices: 2, rarity: "uncommon" },
  },
  "brenna-heartwood": {
    id: "brenna-heartwood", title: "Wood That Won't Burn", giver: "brenna", turnIn: "brenna", level: 7,
    requires: ["brenna-risen"],
    summary: "Cut blighted heartwood from the dead grove south-west of the Gate Circle, where the Risen walk.",
    offer: "The Risen on the ridge came out of a tree gone grey at the heart. I want to know why. "
      + "South-west of the Gate Circle there's a whole grove dead like that, and more of them walking in it. "
      + "Bring me five pieces of the heartwood. Don't breathe on it.",
    progress: "South-west of the Circle, where the trees are grey. Five pieces. Mind what's walking.",
    complete: "Cold. It's cold, in summer. Wood doesn't do that. I'll show Basan — he's been saying things about "
      + "the barrow I didn't want to hear.",
    objectives: [{
      kind: "gather", thing: "heartwood", count: 5, x: -200, z: -550, radius: 40, label: "Blighted heartwood cut",
    }],
    rewards: { gold: 20, xpShare: 0.8, choices: 3, rarity: "uncommon" },
  },
  "basan-candles": {
    id: "basan-candles", title: "Lights for the Barrow", giver: "basan", turnIn: "basan", level: 3,
    requires: [],
    summary: "Gather the grave-candles left round the Hollow Barrow, west of Daso.",
    offer: "Folk used to leave candles round the barrow, for the ones inside. Nobody's lit one in years. "
      + "The old stubs are still out there in the grass around the mound. Fetch me six — "
      + "if I'm to send people down there, I'd like to have asked first.",
    progress: "Round the mound, in the long grass. They'll catch the light. Don't go in yet.",
    complete: "Six. I'll light them tonight, for what it's worth. And when you're stronger — the King. I'll ask you then.",
    objectives: [{
      kind: "gather", thing: "graveCandle", count: 6, x: -1720, z: -160, radius: 40, label: "Grave-candles gathered",
    }],
    rewards: { gold: 10, xpShare: 0.5, choices: 2, rarity: "common" },
  },
  "ilda-westroad": {
    id: "ilda-westroad", title: "The Empty Cart", giver: "ilda", turnIn: "ilda", level: DASO_LEVEL,
    requires: [],
    summary: "Walk the Westroad to its waystone and see what became of Ilda's driver.",
    offer: "The cart came back this morning without its driver. Horse was calm as anything. "
      + "Walk the Westroad as far as the stone and tell me what you see.",
    progress: "Well? The stone's east of here, on the road. You can't miss it.",
    complete: "Nothing at all? No blood, no cart-tracks off the road? ...Somehow that's worse. Thank you for looking.",
    objectives: [{ kind: "visit", x: -700, z: -62, radius: 14, label: "Reach the Westroad Stone" }],
    rewards: { gold: 10, xpShare: 0.4, choices: 2, rarity: "common" },
  },
  // The road east: Daso's second round of work, pitched past its first so
  // there is something between the town's errands and the barrow. Each one
  // walks you further out of the Westwood and into the Heartland, where the
  // creatures are the levels the barrow wants.
  "brenna-risen": {
    id: "brenna-risen", title: "Dead Wood", giver: "brenna", turnIn: "brenna", level: 5,
    requires: [],
    summary: "Put down the Rootbound Risen on the Felled Ridge, east of Daso, for Brenna.",
    offer: "I felled an oak on the east ridge yesterday and something climbed out of the roots after it. "
      + "Grey, slow, and it knew I was there. There's more of them out towards the road. Eight, and I'll cut there again.",
    progress: "Still hearing them out past the ridge. They don't sleep, you know. Neither do I, now.",
    complete: "Eight. Right. I'll take the east ridge back tomorrow — with you in earshot, if it's the same to you.",
    objectives: [{ kind: "kill", creature: "zombie", variant: "rootbound", count: 8, label: "Rootbound Risen put down" }],
    rewards: { gold: 16, xpShare: 0.7, choices: 2, rarity: "uncommon" },
  },
  "ilda-crates": {
    id: "ilda-crates", title: "Dragged into the Trees", giver: "ilda", turnIn: "ilda", level: 5,
    requires: ["ilda-westroad"],
    summary: "Recover Daso's crates from the Silk Snatchers in Silkstrand Hollow, off the Westroad.",
    offer: "The carts that do get through are coming in light. Spiders — they web the crates and drag them off the road "
      + "like they were flies. Some are still whole. Bring back five and I'll know what we've lost.",
    progress: "Silkstrand Hollow, off the Westroad. Look where the webs are thickest.",
    complete: "Nails, salt, and the smith's iron. Mott'll be glad. Did you see anything of the driver out there? ...No. Thank you.",
    objectives: [{ kind: "collect", from: "spider", variant: "silk-snatcher", count: 5, chance: 0.45, label: "Webbed crates recovered" }],
    rewards: { gold: 18, xpShare: 0.7, choices: 3, rarity: "uncommon" },
  },
  "herla-circle": {
    id: "herla-circle", title: "Nobody from the Gate", giver: "herla", turnIn: "herla", level: 6,
    requires: ["herla-wolves"],
    summary: "Walk the Westroad east to the Gate Circle, and tell Herla why nobody comes from it.",
    offer: "Since the Gates came back on, I've had someone through the door every week who came from the Circle. "
      + "Not this month. Walk the Westroad east to the end — the standing stones, you can't miss them — and tell me why.",
    progress: "All the way east on the Westroad. The stones are taller than the trees.",
    complete: "The dead around the stones, and spiders in the grass. Well — that's why. Go carefully out there; "
      + "and if you're going under the barrow for Basan, go carefully there too.",
    objectives: [{ kind: "visit", x: 0, z: -9, radius: 18, label: "Reach the Gate Circle" }],
    rewards: { gold: 20, xpShare: 0.9, choices: 3, rarity: "uncommon" },
  },
  // The first dungeon. The sound Basan hears is the vault's story, and it
  // does not end here: the King is what is in the barrow, not what is
  // calling. Pitched for a party, and paid like it.
  "basan-barrow": {
    id: "basan-barrow", title: "The Hollow Barrow", giver: "basan", turnIn: "basan", level: 9,
    requires: [],
    summary: "Go down into the Hollow Barrow in the west woods and put its King back in the ground.",
    offer: "There's a barrow in the west woods, a few minutes past the last house. Hollow — you can walk down into it. "
      + "Something down there is walking too. I can hear it at night, pacing. Take friends. I mean that.",
    progress: "Still pacing. Past the last house, due west. Take friends.",
    complete: "Quiet. The pacing's stopped. ...The other sound hasn't, mind. Still says my name. "
      + "But that's mine to worry about, not yours.",
    objectives: [{ kind: "slay", elite: "hollow-king", label: "The Hollow King laid to rest" }],
    rewards: { gold: 30, xpShare: 1, choices: 3, rarity: "rare" },
  },
  "ilda-haul": {
    id: "ilda-haul", title: "The Long Haul", giver: "ilda", turnIn: "ysolde", level: 18,
    requires: ["ilda-westroad"],
    summary: "Carry Daso's tally to Ysolde at the Weighhouse in Fanshona, far to the north-east.",
    offer: "I can't spare a driver now, not after this. Ysolde at the Weighhouse in Fanshona owes Daso for "
      + "three loads. Take her this tally. North-east, past the Heartland — follow the roads and don't stop at night.",
    progress: "It's a long way. The roads will get you there.",
    complete: "Daso's tally. Of course they sent it with a stranger. Tell Ilda it's settled — and stay a while. "
      + "Fanshona could use someone who walks that far for other people.",
    objectives: [],
    rewards: { gold: 30, xpShare: 0.8, choices: 3, rarity: "uncommon" },
  },

  // --- Fanshona -------------------------------------------------------------------
  "tobin-wretches": {
    id: "tobin-wretches", title: "Spit Through the Mesh", giver: "tobin", turnIn: "tobin", level: FANSHONA_LEVEL,
    requires: [],
    summary: "Kill the Fen Wretches fouling Tobin's nets.",
    offer: "The Wretches take a net a week. Spit straight through the mesh, and then they eat what's in it. "
      + "Six of them fewer and I might finish a net before it's ruined.",
    progress: "Lost another one last night. Hear that gurgling? That's them laughing.",
    complete: "Quiet on the water tonight. That's a sound I'd forgotten.",
    objectives: [{ kind: "kill", creature: "wretch", count: 6, label: "Fen Wretches killed" }],
    rewards: { gold: 20, xpShare: 0.5, choices: 2, rarity: "uncommon" },
  },
  "pell-hides": {
    id: "pell-hides", title: "Thornback Hide", giver: "pell", turnIn: "pell", level: FANSHONA_LEVEL,
    requires: [],
    summary: "Bring Pell hides from Thornback Boars to patch the boats.",
    offer: "Thornback hide patches a hull better than pitch, if you can get close enough to take one. "
      + "Most of them come off too torn. Bring me four I can use.",
    progress: "That one's more hole than hide. Four good ones.",
    complete: "Thick as a door and twice as stubborn. The Brightwater won't get through these.",
    objectives: [{ kind: "collect", from: "boar", count: 4, chance: 0.5, label: "Usable Thornback hides" }],
    rewards: { gold: 20, xpShare: 0.5, choices: 3, rarity: "uncommon" },
  },
  "maera-stone": {
    id: "maera-stone", title: "The Brightwater Stone", giver: "maera", turnIn: "maera", level: FANSHONA_LEVEL,
    requires: [],
    summary: "Go to the Brightwater Stone and see why the boats won't moor there.",
    offer: "Every boat on the Brightwater ties up here, or it doesn't tie up at all — and lately none of them "
      + "will go near the Brightwater Stone. Go and look, and tell me why.",
    progress: "The stone's east along the shore. Mind the shallows.",
    complete: "Something in the water, watching. That's what the fishers say too. I'd hoped you'd tell me they were wrong.",
    objectives: [{ kind: "visit", x: 2450, z: 2300, radius: 14, label: "Reach the Brightwater Stone" }],
    rewards: { gold: 15, xpShare: 0.4, choices: 2, rarity: "common" },
  },
  "caddo-silt": {
    id: "caddo-silt", title: "What Waits in the Shallows", giver: "caddo", turnIn: "caddo", level: 29,
    requires: ["tobin-wretches", "maera-stone"],
    summary: "Slay Mother Silt, who waits in the Brightwater shallows north-east of Fanshona.",
    offer: "Came through the Gate the day it opened, and she was in the lake then too. Mother Silt. "
      + "The Wretches are hers, you know — every one. You've the look of someone who could finish it. "
      + "Past the Brightwater Stone, where the water goes still.",
    progress: "She's still there. I can feel it when the lake goes quiet.",
    complete: "Fifty years I've watched that water. It looks different already. Take this — you've earned more, "
      + "but it's what an old man has.",
    objectives: [{ kind: "slay", elite: "silt", label: "Mother Silt slain" }],
    rewards: { gold: 60, xpShare: 1, choices: 3, rarity: "rare" },
  },
};

export const QUEST_IDS = Object.keys(QUESTS);

export function getQuest(id: unknown): QuestDefinition | undefined {
  return typeof id === "string" && Object.hasOwn(QUESTS, id) ? QUESTS[id] : undefined;
}

// --- rules ----------------------------------------------------------------------

/** How many of an objective finish it. */
export function objectiveTarget(objective: QuestObjective): number {
  return objective.kind === "kill" || objective.kind === "collect" || objective.kind === "gather" ? objective.count : 1;
}

export function questReady(quest: QuestDefinition, progress: readonly number[] | undefined): boolean {
  return quest.objectives.every((objective, i) => (progress?.[i] ?? 0) >= objectiveTarget(objective));
}

/** What a villager has for this player right now. */
export function questsAt(npc: string, log: QuestLog, level: number): {
  offers: QuestDefinition[];
  ready: QuestDefinition[];
  underway: QuestDefinition[];
} {
  const offers: QuestDefinition[] = [];
  const ready: QuestDefinition[] = [];
  const underway: QuestDefinition[] = [];
  for (const quest of Object.values(QUESTS)) {
    const progress = log.active[quest.id];
    if (progress) {
      if (quest.turnIn === npc && questReady(quest, progress)) ready.push(quest);
      else if (quest.giver === npc || quest.turnIn === npc) underway.push(quest);
    } else if (quest.giver === npc && canTake(quest, log, level)) {
      offers.push(quest);
    }
  }
  return { offers, ready, underway };
}

/** The lowest level a quest is offered at. */
export function questMinLevel(quest: QuestDefinition): number {
  return Math.max(1, quest.level - QUEST_LEVEL_LEAD);
}

export function canTake(quest: QuestDefinition, log: QuestLog, level: number): boolean {
  return !log.done.includes(quest.id)
    && log.active[quest.id] === undefined
    && level >= questMinLevel(quest)
    && quest.requires.every((id) => log.done.includes(id))
    && Object.keys(log.active).length < MAX_ACTIVE_QUESTS;
}

/** The mark over a villager's head: something to hand in beats something to
 *  take, which beats something under way. */
export function questMarker(npc: string, log: QuestLog, level: number): "?" | "!" | "…" | "" {
  const here = questsAt(npc, log, level);
  if (here.ready.length > 0) return "?";
  if (here.offers.length > 0) return "!";
  if (here.underway.length > 0) return "…";
  return "";
}

/**
 * The items a quest offers this character, derived from the character and the
 * quest alone — so the client can show exactly the choices the server will
 * honour, and a player cannot reroll them by asking again. Integer hashing
 * only, like everything else that must match across the wire; one of each kind
 * of piece where it can, so a choice is a real choice.
 */
export function questRewardItems(quest: QuestDefinition, characterId: string, classId: ClassId): ItemKey[] {
  let h = 0x811c9dc5;
  for (const text of [characterId, quest.id]) {
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  // Only what this character's class can use: a reward you cannot wear is
  // no choice at all.
  const pool = basesFor(quest.rewards.rarity, classId).filter((base) => base.name === undefined);
  const items: ItemKey[] = [];
  const usedGear = new Set<string>();
  for (let n = 0; n < quest.rewards.choices && pool.length > 0; n++) {
    let pick = pool[hash2(h, n, 0x9e37) % pool.length]!;
    for (let tries = 1; usedGear.has(pick.gear) && tries < 12; tries++) {
      pick = pool[hash2(h, n * 16 + tries, 0x9e37) % pool.length]!;
    }
    usedGear.add(pick.gear);
    items.push(encodeItem({
      base: pick.id,
      level: Math.max(1, quest.level * LEVEL_SCALE),
      rarity: quest.rewards.rarity,
      seed: hash2(h, n, 0x51ed),
      classId,
    }));
  }
  return items;
}

/**
 * What handing a quest in pays a character of `level`: its share of a level
 * at the quest's own level, scaled the way a kill of that level would be. A
 * Daso errand done at level 20 is grey, and pays nothing — it was never meant
 * to be the way to level 20.
 */
export function questXp(quest: QuestDefinition, level: number): number {
  if (level >= MAX_LEVEL) return 0;
  return Math.round(xpToNext(quest.level) * quest.rewards.xpShare * levelXpScale(quest.level, level));
}

/** Where a villager is, by id. */
export function findVillager(id: string): { villager: VillagerDefinition; settlement: SettlementDefinition } | undefined {
  for (const settlement of Object.values(SETTLEMENTS)) {
    const villager = settlement.villagers.find((candidate) => candidate.id === id);
    if (villager) return { villager, settlement };
  }
  return undefined;
}

/** The short name: "Osk", not "Osk, timberwright". */
export function villagerName(id: string): string {
  return findVillager(id)?.villager.name.split(",")[0] ?? id;
}

/** Only known quests, with progress arrays the right length and in range, and
 *  nothing both active and done. A hand-edited save costs a quest, not a session. */
export function sanitiseQuestLog(raw: unknown): QuestLog {
  const log: QuestLog = { active: {}, done: [] };
  if (typeof raw !== "object" || raw === null) return log;
  const { active, done } = raw as { active?: unknown; done?: unknown };
  if (Array.isArray(done)) {
    for (const id of done) if (getQuest(id) && !log.done.includes(id as string)) log.done.push(id as string);
  }
  if (typeof active === "object" && active !== null) {
    for (const [id, progress] of Object.entries(active as Record<string, unknown>)) {
      const quest = getQuest(id);
      if (!quest || log.done.includes(id) || !Array.isArray(progress)) continue;
      log.active[id] = quest.objectives.map((objective, i) => {
        const value = progress[i];
        return typeof value === "number" && Number.isFinite(value)
          ? Math.max(0, Math.min(objectiveTarget(objective), Math.floor(value)))
          : 0;
      });
    }
  }
  return log;
}
