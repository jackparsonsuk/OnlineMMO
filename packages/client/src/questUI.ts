import {
  DEFAULT_CLASS,
  describeItem,
  DIFFICULTY_COLOUR,
  difficultyOf,
  findVillager,
  getQuest,
  objectiveTarget,
  questReady,
  questRewardItems,
  questsAt,
  questXp,
  RARITY,
  rarityHex,
  STAT_ORDER,
  STATS,
  TALK_RANGE,
  villagerName,
  type ClassId,
  type QuestDefinition,
  type QuestLog,
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
  complete(quest: string, choice: number): void;
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

/** "Level 3", in the colour of how hard that is for you. */
function levelTag(quest: QuestDefinition, level: number): string {
  const colour = DIFFICULTY_COLOUR[difficultyOf(quest.level, level)];
  return `<span class="quest-level" style="color:${colour}">Level ${quest.level}</span>`;
}

export class QuestUI {
  private readonly dialog: HTMLElement;
  private readonly tracker: HTMLElement;
  private readonly journal: HTMLElement;
  private log: QuestLog = EMPTY_LOG;
  private known = false;
  private level = 1;
  private characterId = "";
  private classId: ClassId = DEFAULT_CLASS;
  /** Who the dialogue is with, and which quest it is showing, if any. */
  private talking: VillagerDefinition | undefined;
  private showing: string | undefined;
  private choice = 0;

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
    }
  }

  private panel(id: string): HTMLElement {
    const element = document.createElement("div");
    element.id = id;
    element.hidden = true;
    document.body.appendChild(element);
    return element;
  }

  setCharacter(id: string, classId: ClassId): void {
    this.characterId = id;
    this.classId = classId;
  }

  /** Your level decides what is offered, what the XP is, and the colours. */
  setLevel(level: number): void {
    if (level === this.level) return;
    this.level = level;
    if (!this.dialog.hidden) this.renderDialog();
    if (!this.journal.hidden) this.renderJournal();
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
      const here = questsAt(villager.id, this.log, this.level);
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
  }

  private renderDialog(): void {
    const villager = this.talking;
    if (!villager) return;
    const quest = this.showing !== undefined ? getQuest(this.showing) : undefined;
    const head = `<header><b>${escapeHtml(villager.name)}</b><button type="button" data-act="close" title="Close (Esc)">×</button></header>`;

    if (!quest || villager.id === undefined) {
      const here = villager.id !== undefined
        ? questsAt(villager.id, this.log, this.level)
        : { offers: [], ready: [], underway: [] };
      const row = (q: QuestDefinition, mark: string, kind: string) =>
        `<button type="button" class="quest-row ${kind}" data-act="show" data-quest="${q.id}"><i>${mark}</i>` +
        `${escapeHtml(q.title)}${levelTag(q, this.level)}</button>`;
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

    let body = `<h3>${escapeHtml(quest.title)}${levelTag(quest, this.level)}</h3>` +
      `<p class="quest-speech">“${escapeHtml(speech)}”</p>`;
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

  /** Gold, XP, and one item of a few. When handing in, the item is a choice;
   *  before, a preview. */
  private rewardsHtml(quest: QuestDefinition, choosing: boolean): string {
    const items = this.characterId ? questRewardItems(quest, this.characterId, this.classId) : [];
    const cards = items.map((key, index) => {
      const item = describeItem(key);
      if (!item) return "";
      const stats = STAT_ORDER.filter((stat) => item.stats[stat])
        .map((stat) => `+${item.stats[stat]} ${STATS[stat].name}`).join(" · ");
      const picked = choosing && index === this.choice;
      const short = item.requiredLevel > this.level;
      return `<button type="button" class="quest-item${picked ? " picked" : ""}" data-act="choose" data-index="${index}"` +
        ` style="--rarity:${rarityHex(item.rarity)}"${choosing ? "" : " disabled"}>` +
        `<b>${escapeHtml(item.name)}</b><small>${RARITY[item.rarity].name} · ` +
        `<span class="${short ? "short" : ""}">requires level ${item.requiredLevel}</span></small>` +
        `<small class="stats">${stats}</small></button>`;
    }).join("");

    // What it pays you, now — a quest you have outgrown pays less, and a grey
    // one nothing, the same as a creature would.
    const amount = questXp(quest, this.level);
    const xp = `<span class="${amount === 0 ? "grey" : ""}">${amount > 0 ? `${amount.toLocaleString()} XP` : "No XP — you have outgrown it"}</span>`;

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
        if (this.showing) this.hooks.complete(this.showing, this.choice);
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
        return `<section><h3>${escapeHtml(quest.title)}${levelTag(quest, this.level)}</h3>` +
          `<p>${escapeHtml(quest.summary)}</p>` +
          this.objectivesHtml(quest, this.log.active[id]) +
          `<small>From ${escapeHtml(villagerName(quest.giver))}</small>` +
          `<button type="button" class="abandon" data-act="abandon" data-quest="${id}">Abandon</button></section>`;
      }).join("");
    this.journal.innerHTML =
      `<header><b>Quests</b><span>${this.log.done.length} completed</span><button type="button" data-act="close" title="Close (J or Esc)">×</button></header>` +
      body;
  }
}
