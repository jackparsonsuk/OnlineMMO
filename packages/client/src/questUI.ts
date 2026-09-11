import {
  describeItem,
  findVillager,
  GEAR_SKILL_IDS,
  GEAR_SKILLS,
  getQuest,
  objectiveTarget,
  questReady,
  questRewardItems,
  questsAt,
  questXp,
  RARITY,
  rarityHex,
  SPELL_IDS,
  SPELLS,
  STAT_ORDER,
  STATS,
  TALK_RANGE,
  villagerName,
  type Proficiency,
  type QuestDefinition,
  type QuestLog,
  type SkillId,
  type VillagerDefinition,
} from "@mmo/shared";

/**
 * Everything quests put on screen: the conversation with a villager (E), the
 * tracker under the minimap, and the quest log (J).
 *
 * It decides nothing. Accepting, abandoning and handing in are requests; the
 * server checks each against the same rules (`quests.ts`) and answers with the
 * new log, which is the only thing this ever draws from. The reward items it
 * shows come from `questRewardItems`, the same function the server pays from,
 * so the item you pick is the item you get.
 */

export interface QuestHooks {
  accept(quest: string): void;
  abandon(quest: string): void;
  complete(quest: string, choice: number, skill: SkillId): void;
  /** A line worth telling the player — progress, a quest ready to hand in. */
  notify(text: string): void;
}

const EMPTY_LOG: QuestLog = { active: {}, done: [] };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}

/** "Return to Herla", or for a delivery, "Take it to Ysolde in Fanshona". */
function handInLine(quest: QuestDefinition): string {
  const who = villagerName(quest.turnIn);
  if (quest.turnIn === quest.giver) return `Return to ${who}`;
  const where = findVillager(quest.turnIn)?.settlement.name;
  return `Take it to ${who}${where ? ` in ${where}` : ""}`;
}

function skillName(skill: SkillId): string {
  return (GEAR_SKILLS as Record<string, { name: string }>)[skill]?.name
    ?? SPELLS[skill as keyof typeof SPELLS]?.name ?? skill;
}

export class QuestUI {
  private readonly dialog: HTMLElement;
  private readonly tracker: HTMLElement;
  private readonly journal: HTMLElement;
  private log: QuestLog = EMPTY_LOG;
  private known = false;
  private skills: Proficiency = {};
  private characterId = "";
  /** Who the dialogue is with, and which quest it is showing, if any. */
  private talking: VillagerDefinition | undefined;
  private showing: string | undefined;
  private choice = 0;
  private skill: SkillId | undefined;

  constructor(private readonly hooks: QuestHooks) {
    this.dialog = this.panel("quest-dialog");
    this.journal = this.panel("quest-log");
    this.tracker = document.createElement("div");
    this.tracker.id = "quest-tracker";
    document.body.appendChild(this.tracker);

    // A choice in the dialogue must not also cast the spell on that key.
    for (const panel of [this.dialog, this.journal]) {
      panel.addEventListener("keydown", (event) => event.stopPropagation());
      panel.addEventListener("click", (event) => this.onClick(event));
      panel.addEventListener("change", (event) => this.onChange(event));
    }
  }

  private panel(id: string): HTMLElement {
    const element = document.createElement("div");
    element.id = id;
    element.hidden = true;
    document.body.appendChild(element);
    return element;
  }

  setCharacter(id: string): void {
    this.characterId = id;
  }

  setSkills(skills: Proficiency): void {
    this.skills = skills;
    if (!this.dialog.hidden) this.renderDialog();
  }

  /** The server's word on this player's quests. Tells the player what moved. */
  setLog(log: QuestLog): void {
    if (this.known) this.announceChanges(this.log, log);
    this.known = true;
    this.log = log;
    this.renderTracker();
    if (!this.dialog.hidden) this.renderDialog();
    if (!this.journal.hidden) this.renderJournal();
  }

  get currentLog(): QuestLog {
    return this.log;
  }

  get isOpen(): boolean {
    return !this.dialog.hidden || !this.journal.hidden;
  }

  /** Esc: close whatever is open. Returns whether anything was. */
  close(): boolean {
    const was = this.isOpen;
    this.dialog.hidden = true;
    this.journal.hidden = true;
    this.talking = undefined;
    return was;
  }

  /** E beside a villager. */
  talkTo(villager: VillagerDefinition): void {
    this.talking = villager;
    this.showing = undefined;
    this.journal.hidden = true;
    // Straight to the point when there is only one thing to say.
    if (villager.id !== undefined) {
      const here = questsAt(villager.id, this.log);
      const all = [...here.ready, ...here.offers, ...here.underway];
      if (all.length === 1) this.show(all[0]!);
    }
    this.renderDialog();
    this.dialog.hidden = false;
  }

  toggleJournal(): void {
    this.journal.hidden = !this.journal.hidden;
    if (!this.journal.hidden) {
      this.dialog.hidden = true;
      this.renderJournal();
    }
  }

  /** Once per frame: walk away and the conversation ends. */
  update(x: number, z: number): void {
    const villager = this.talking;
    if (!villager || this.dialog.hidden) return;
    if (Math.hypot(villager.x - x, villager.z - z) > TALK_RANGE + 1.5) this.close();
  }

  // --- changes ---------------------------------------------------------------------

  private announceChanges(before: QuestLog, after: QuestLog): void {
    for (const [id, progress] of Object.entries(after.active)) {
      const quest = getQuest(id);
      if (!quest) continue;
      const old = before.active[id];
      if (!old) {
        this.hooks.notify(`Quest accepted: ${quest.title}`);
        continue;
      }
      quest.objectives.forEach((objective, i) => {
        const now = progress[i] ?? 0;
        if (now > (old[i] ?? 0)) this.hooks.notify(`${objective.label}: ${now}/${objectiveTarget(objective)}`);
      });
      if (!questReady(quest, old) && questReady(quest, progress)) {
        this.hooks.notify(`${quest.title}: ${handInLine(quest)}`);
      }
    }
  }

  // --- the conversation --------------------------------------------------------------

  private show(quest: QuestDefinition): void {
    this.showing = quest.id;
    this.choice = 0;
    // XP goes where you have been putting it, unless you say otherwise.
    const trained = [...SPELL_IDS, ...GEAR_SKILL_IDS]
      .sort((a, b) => (this.skills[b] ?? 0) - (this.skills[a] ?? 0));
    this.skill = trained[0];
  }

  private renderDialog(): void {
    const villager = this.talking;
    if (!villager) return;
    const quest = this.showing !== undefined ? getQuest(this.showing) : undefined;
    const head = `<header><b>${escapeHtml(villager.name)}</b><button type="button" data-act="close" title="Close (Esc)">×</button></header>`;

    if (!quest || villager.id === undefined) {
      const here = villager.id !== undefined ? questsAt(villager.id, this.log) : { offers: [], ready: [], underway: [] };
      const row = (q: QuestDefinition, mark: string, kind: string) =>
        `<button type="button" class="quest-row ${kind}" data-act="show" data-quest="${q.id}"><i>${mark}</i>${escapeHtml(q.title)}</button>`;
      const rows = [
        ...here.ready.map((q) => row(q, "?", "ready")),
        ...here.offers.map((q) => row(q, "!", "offer")),
        ...here.underway.map((q) => row(q, "…", "underway")),
      ];
      this.dialog.innerHTML = head +
        `<p class="quest-speech">“${escapeHtml(villager.line)}”</p>` +
        (rows.length > 0 ? `<div class="quest-rows">${rows.join("")}</div>` : `<p class="quest-none">Nothing for you, for now.</p>`);
      return;
    }

    const progress = this.log.active[quest.id];
    const ready = progress !== undefined && questReady(quest, progress) && quest.turnIn === villager.id;
    const offered = progress === undefined;
    const speech = ready ? quest.complete : offered ? quest.offer : quest.progress;

    let body = `<h3>${escapeHtml(quest.title)}</h3><p class="quest-speech">“${escapeHtml(speech)}”</p>`;
    body += this.objectivesHtml(quest, progress);
    body += this.rewardsHtml(quest, ready);

    const buttons: string[] = [`<button type="button" data-act="back">Back</button>`];
    if (offered) buttons.push(`<button type="button" class="primary" data-act="accept">Accept</button>`);
    if (ready) buttons.push(`<button type="button" class="primary" data-act="complete">Complete quest</button>`);
    this.dialog.innerHTML = head + body + `<footer>${buttons.join("")}</footer>`;
  }

  private objectivesHtml(quest: QuestDefinition, progress: number[] | undefined): string {
    const lines = quest.objectives.map((objective, i) => {
      const have = progress?.[i] ?? 0;
      const target = objectiveTarget(objective);
      const done = have >= target;
      const count = target > 1 ? ` ${have}/${target}` : "";
      return `<li class="${done ? "done" : ""}">${escapeHtml(objective.label)}${count}</li>`;
    });
    if (quest.turnIn !== quest.giver) lines.push(`<li>${escapeHtml(handInLine(quest))}</li>`);
    return lines.length > 0 ? `<ul class="quest-objectives">${lines.join("")}</ul>` : "";
  }

  /** Gold, XP into a skill of your choosing, and one item of a few. When
   *  handing in, the item and the skill are choices; before, a preview. */
  private rewardsHtml(quest: QuestDefinition, choosing: boolean): string {
    const items = this.characterId ? questRewardItems(quest, this.characterId) : [];
    const cards = items.map((key, index) => {
      const item = describeItem(key);
      if (!item) return "";
      const stats = STAT_ORDER.filter((stat) => item.stats[stat])
        .map((stat) => `+${item.stats[stat]} ${STATS[stat].name}`).join(" · ");
      const picked = choosing && index === this.choice;
      return `<button type="button" class="quest-item${picked ? " picked" : ""}" data-act="choose" data-index="${index}"` +
        ` style="--rarity:${rarityHex(item.rarity)}"${choosing ? "" : " disabled"}>` +
        `<b>${escapeHtml(item.name)}</b><small>${RARITY[item.rarity].name} · item level ${item.level}</small>` +
        `<small class="stats">${stats}</small></button>`;
    }).join("");

    let xp = `<span>${quest.rewards.xp} XP into a skill of your choice</span>`;
    if (choosing && this.skill) {
      const options = [...SPELL_IDS, ...GEAR_SKILL_IDS].map((id) =>
        `<option value="${id}"${id === this.skill ? " selected" : ""}>${escapeHtml(skillName(id))} (${Math.floor(this.skills[id] ?? 0)})</option>`).join("");
      const current = this.skills[this.skill] ?? 0;
      const after = questXp(current, quest);
      xp = `<label>${quest.rewards.xp} XP into <select data-act="skill">${options}</select>` +
        `<small>${Math.floor(current)} → ${Math.floor(after)}${after - current < quest.rewards.xp / 100 - 0.001 ? " (capped)" : ""}</small></label>`;
    }

    return `<div class="quest-rewards"><h4>${choosing ? "Choose your reward" : "Rewards"}</h4>` +
      `<div class="quest-purse"><span class="gold">${quest.rewards.gold} gold</span>${xp}</div>` +
      (cards ? `<div class="quest-items">${cards}</div>` : "") + `</div>`;
  }

  private onClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const act = target?.dataset["act"];
    if (!act || !target) return;
    switch (act) {
      case "close":
        this.close();
        return;
      case "show": {
        const quest = getQuest(target.dataset["quest"]);
        if (quest) this.show(quest);
        this.renderDialog();
        return;
      }
      case "back":
        this.showing = undefined;
        this.renderDialog();
        return;
      case "accept":
        if (this.showing) this.hooks.accept(this.showing);
        this.showing = undefined;
        return;
      case "choose":
        this.choice = Number(target.dataset["index"]) || 0;
        this.renderDialog();
        return;
      case "complete":
        if (this.showing && this.skill) this.hooks.complete(this.showing, this.choice, this.skill);
        this.showing = undefined;
        return;
      case "abandon": {
        const id = target.dataset["quest"];
        if (id && target.classList.contains("confirm")) {
          this.hooks.abandon(id);
        } else if (id) {
          // Asks once: abandoning loses the progress.
          target.classList.add("confirm");
          target.textContent = "Abandon — sure?";
        }
        return;
      }
    }
  }

  private onChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    if (select.dataset["act"] !== "skill") return;
    this.skill = select.value as SkillId;
    this.renderDialog();
  }

  // --- tracker and log ---------------------------------------------------------------

  private renderTracker(): void {
    const entries = Object.entries(this.log.active);
    this.tracker.hidden = entries.length === 0;
    this.tracker.innerHTML = entries.map(([id, progress]) => {
      const quest = getQuest(id);
      if (!quest) return "";
      const ready = questReady(quest, progress);
      const lines = ready
        ? [`<li class="ready">${escapeHtml(handInLine(quest))}</li>`]
        : quest.objectives.map((objective, i) => {
          const target = objectiveTarget(objective);
          const have = progress[i] ?? 0;
          return `<li class="${have >= target ? "done" : ""}">${escapeHtml(objective.label)}${target > 1 ? ` ${have}/${target}` : ""}</li>`;
        });
      return `<div class="tracked${ready ? " ready" : ""}"><b>${escapeHtml(quest.title)}</b><ul>${lines.join("")}</ul></div>`;
    }).join("");
  }

  private renderJournal(): void {
    const entries = Object.keys(this.log.active);
    const body = entries.length === 0
      ? `<p class="quest-none">No quests under way. Look for a <b class="mark">!</b> over someone's head.</p>`
      : entries.map((id) => {
        const quest = getQuest(id);
        if (!quest) return "";
        return `<section><h3>${escapeHtml(quest.title)}</h3><p>${escapeHtml(quest.summary)}</p>` +
          this.objectivesHtml(quest, this.log.active[id]) +
          `<small>From ${escapeHtml(villagerName(quest.giver))}</small>` +
          `<button type="button" class="abandon" data-act="abandon" data-quest="${id}">Abandon</button></section>`;
      }).join("");
    this.journal.innerHTML =
      `<header><b>Quests</b><span>${this.log.done.length} completed</span><button type="button" data-act="close" title="Close (J or Esc)">×</button></header>` +
      body;
  }
}
