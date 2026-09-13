import {
  ELITES,
  findGate,
  findVillager,
  getOstra,
  getQuest,
  objectiveTarget,
  OSTRA_IDS,
  questMarker,
  questReady,
  settlementsIn,
  type OstraDefinition,
  type QuestLog,
} from "@mmo/shared";
import type { QuestMark } from "./map.js";

/**
 * Where each of your quests wants you, in the Ostra you are standing in.
 *
 * - Done: the "?" over whoever takes it back.
 * - A kill or collect for a variant: the hunting area it lives in, since a
 *   variant lives in exactly one (`variants.ts`). One for a whole kind has no
 *   single place and gets no mark — which is the argument for variants.
 * - A visit: the place.
 * - An elite: where it waits — or, for a dungeon's boss, the Gate down to it.
 *
 * Only unfinished objectives are drawn: a quest half done points at what is
 * left of it.
 *
 * - Someone with work for you: a "!" where they stand. The "!" over a head is
 *   only any use once you can see the head; a new arrival at the Daso Stone,
 *   facing the wrong way, had nothing telling them the inn was sixty metres
 *   behind them with work in it.
 */
export function questMarksFor(ostra: OstraDefinition, log: QuestLog, level: number): QuestMark[] {
  const marks: QuestMark[] = [];
  for (const settlement of settlementsIn(ostra)) {
    for (const villager of settlement.villagers) {
      if (villager.id === undefined || questMarker(villager.id, log, level) !== "!") continue;
      marks.push({ kind: "offer", x: villager.x, z: villager.z, label: `${villager.name} has work` });
    }
  }
  for (const [id, progress] of Object.entries(log.active)) {
    const quest = getQuest(id);
    if (!quest) continue;

    if (questReady(quest, progress)) {
      const found = findVillager(quest.turnIn);
      if (found && settlementsIn(ostra).includes(found.settlement)) {
        marks.push({ kind: "turnin", x: found.villager.x, z: found.villager.z, label: quest.title });
      }
      continue;
    }

    quest.objectives.forEach((objective, i) => {
      if ((progress[i] ?? 0) >= objectiveTarget(objective)) return;
      switch (objective.kind) {
        case "kill":
        case "collect": {
          if (!objective.variant) return;
          const area = ostra.areas?.find((candidate) => candidate.variant === objective.variant);
          if (area) marks.push({ kind: "area", x: area.x, z: area.z, radius: area.radius, label: quest.title });
          return;
        }
        case "visit":
          if ((objective.ostra ?? "terra") === ostra.id) {
            marks.push({ kind: "point", x: objective.x, z: objective.z, label: quest.title });
          }
          return;
        case "slay": {
          const elite = ELITES.find((candidate) => candidate.id === objective.elite);
          if (!elite) return;
          if (elite.ostra === ostra.id) {
            marks.push({ kind: "point", x: elite.x, z: elite.z, label: quest.title });
            return;
          }
          // In a dungeon: point at the Gate down to it, from wherever it is.
          const gate = gateTo(ostra, elite.ostra);
          if (gate) marks.push({ kind: "point", x: gate.x, z: gate.z, label: quest.title });
          return;
        }
      }
    });
  }
  return marks;
}

/** A Gate in `ostra` that leads to `target`, if there is one. */
function gateTo(ostra: OstraDefinition, target: string): { x: number; z: number } | undefined {
  if (!OSTRA_IDS.includes(target as never)) return undefined;
  const direct = ostra.gates.find((gate) => gate.target === target);
  if (direct) return direct;
  // A dungeon names the Gate it is entered by.
  const entrance = getOstra(target as never).dungeon?.entrance;
  return entrance ? findGate(ostra, entrance) : undefined;
}
