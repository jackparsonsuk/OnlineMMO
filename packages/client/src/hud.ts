import {
  EQUIP_SLOTS,
  equipmentStats,
  getItem,
  INVENTORY_SIZE,
  MAX_AFFINITY,
  proficiencyMultiplier,
  SPELL_IDS,
  SPELLS,
  type EquipSlot,
  type Equipment,
  type OstraDefinition,
  type Player,
  type SpellId,
  type SpellProficiency,
  type WorldState,
} from "@mmo/shared";

export class Hud {
  private ostraName = document.getElementById("ostra-name") as HTMLElement;
  private ostraSubtitle = document.getElementById("ostra-subtitle") as HTMLElement;
  private status = document.getElementById("status") as HTMLElement;
  private stats = document.getElementById("stats") as HTMLElement;
  private roster = document.getElementById("roster") as HTMLElement;
  private gatePrompt = document.getElementById("gate-prompt") as HTMLElement;
  private speech = document.getElementById("speech") as HTMLElement;
  private speechWho = document.getElementById("speech-who") as HTMLElement;
  private speechLine = document.getElementById("speech-line") as HTMLElement;
  private speaking: string | undefined;
  private healthFill = document.querySelector("#health-bar i") as HTMLElement;
  private healthText = document.getElementById("health-text") as HTMLElement;
  private death = document.getElementById("death") as HTMLElement;
  private deathDetail = document.getElementById("death-detail") as HTMLElement;
  private manaFill = document.querySelector("#mana-bar i") as HTMLElement;
  private manaText = document.getElementById("mana-text") as HTMLElement;
  private abilities = document.getElementById("abilities") as HTMLElement;
  private affinityText = document.getElementById("affinity") as HTMLElement;
  private bag = document.getElementById("bag") as HTMLElement;
  private bagSlots = document.getElementById("bag-slots") as HTMLElement;
  private bagWorn = document.getElementById("bag-worn") as HTMLElement;
  private bagTotals = document.getElementById("bag-totals") as HTMLElement;
  private toast = document.getElementById("toast") as HTMLElement;
  private toastTimer: number | undefined;
  private targetFrame = document.getElementById("target-frame") as HTMLElement;
  private targetName = document.getElementById("tf-name") as HTMLElement;
  private targetLevel = document.getElementById("tf-level") as HTMLElement;
  private targetFill = document.querySelector("#tf-bar i") as HTMLElement;
  private targetText = document.getElementById("tf-text") as HTMLElement;
  private shownTarget = "";
  private combatFlag = document.getElementById("combat-flag") as HTMLElement;
  private vignette = document.getElementById("vignette") as HTMLElement;
  private soundToggle = document.getElementById("sound-toggle") as HTMLButtonElement;
  private lowHealth = false;
  private shownCombo = -1;
  private shownHealth = -1;
  private shownMana = -1;
  private shownMaxHealth = -1;
  private shownMaxMana = -1;
  /** Set by main so a click in the bag can reach the server. */
  onEquip: ((itemId: string) => void) | undefined;
  /** Set by main; returns whether sound is now muted. */
  onToggleSound: (() => boolean) | undefined;
  onUnequip: ((slot: EquipSlot) => void) | undefined;
  private slots = new Map<SpellId, { root: HTMLElement; cool: HTMLElement; prof: HTMLElement }>();

  constructor() {
    this.soundToggle.onclick = () => this.setMuted(this.onToggleSound?.() ?? false);
  }

  setMuted(muted: boolean): void {
    this.soundToggle.textContent = muted ? "Sound off" : "Sound on";
    this.soundToggle.classList.toggle("off", muted);
  }

  setOstra(ostra: OstraDefinition): void {
    this.ostraName.textContent = ostra.name;
    this.ostraSubtitle.textContent = ostra.subtitle;
  }

  setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("error", isError);
  }

  /** Ping and tick rate are the two numbers that explain almost every
   *  "why does it feel like that?" question during development. */
  setStats(ping: number, tickRate: number, pending: number): void {
    this.stats.textContent =
      `${Math.round(ping)} ms · ${tickRate} Hz · ${pending} pending`;
  }

  /** Named when you're near enough to see it, so a Gate is never a surprise. */
  setGatePrompt(label: string | undefined): void {
    this.gatePrompt.textContent = label ?? "";
    this.gatePrompt.hidden = label === undefined;
  }

  /**
   * What the nearest villager is saying, or nothing.
   *
   * Only touches the DOM when the speaker changes, so standing in front of
   * someone doesn't rewrite their line sixty times a second.
   */
  setSpeech(who: string | undefined, line = ""): void {
    if (who === this.speaking) return;
    this.speaking = who;
    this.speech.hidden = who === undefined;
    if (who === undefined) return;
    this.speechWho.textContent = who;
    this.speechLine.textContent = line;
  }

  /** Only touches the DOM when the number actually moved. */
  setHealth(health: number, max: number): void {
    if (health === this.shownHealth && max === this.shownMaxHealth) return;
    this.shownHealth = health;
    this.shownMaxHealth = max;
    const fraction = Math.max(0, Math.min(1, health / Math.max(1, max)));
    this.healthFill.style.width = `${fraction * 100}%`;
    this.healthText.textContent = `${health} / ${max}`;
    // Below a quarter the bar turns; you should not have to read a number to
    // know you are in trouble.
    this.healthFill.classList.toggle("low", fraction <= 0.25);
    // ...and the edges of the screen start to pulse, so you know without
    // looking at the bar at all.
    const low = health > 0 && fraction <= 0.25;
    if (low !== this.lowHealth) {
      this.lowHealth = low;
      this.vignette.classList.toggle("low", low);
    }
  }

  /**
   * A red flash at the screen's edges when you are hit, stronger for bigger
   * hits. Restarted from full on every hit, so a flurry reads as a flurry.
   */
  hurt(fraction: number): void {
    const strength = Math.min(1, 0.35 + fraction * 3);
    this.vignette.style.transition = "none";
    this.vignette.style.opacity = String(strength);
    // Force the reset to take before the fade starts.
    void this.vignette.offsetWidth;
    this.vignette.style.transition = "opacity 520ms ease-out";
    this.vignette.style.opacity = "";
  }

  setCombat(inCombat: boolean): void {
    if (this.combatFlag.hidden === !inCombat) return;
    this.combatFlag.hidden = !inCombat;
  }

  /**
   * The selected creature: name, level, and exact health — the nametag's bar
   * says roughly, this says exactly, which is what you want when deciding
   * whether one more Strike finishes it.
   */
  setTarget(target: {
    name: string; level: number; health: number; maxHealth: number; hunting: boolean; dead: boolean;
  } | undefined): void {
    const key = target
      ? `${target.name}|${target.level}|${target.health}|${target.maxHealth}|${target.hunting}|${target.dead}`
      : "";
    if (key === this.shownTarget) return;
    this.shownTarget = key;
    this.targetFrame.hidden = target === undefined;
    if (!target) return;
    this.targetName.textContent = target.name;
    this.targetLevel.textContent = String(target.level);
    const fraction = Math.max(0, Math.min(1, target.health / Math.max(1, target.maxHealth)));
    this.targetFill.style.width = `${fraction * 100}%`;
    this.targetText.textContent = target.dead ? "dead" : `${target.health} / ${target.maxHealth}`;
    this.targetFrame.classList.toggle("hunting", target.hunting);
    this.targetFrame.classList.toggle("dead", target.dead);
  }

  /** Light the Strike slot's chain pips: 0 means no chain in progress. */
  setCombo(step: number): void {
    if (step === this.shownCombo) return;
    this.shownCombo = step;
    const pips = this.slots.get("strike")?.root.querySelectorAll(".pips i");
    pips?.forEach((pip, index) => pip.classList.toggle("lit", index < step));
  }

  setMana(mana: number, max: number): void {
    if (mana === this.shownMana && max === this.shownMaxMana) return;
    this.shownMana = mana;
    this.shownMaxMana = max;
    this.manaFill.style.width = `${Math.max(0, Math.min(1, mana / Math.max(1, max))) * 100}%`;
    this.manaText.textContent = `${mana} / ${max}`;

    // Grey a spell you cannot currently afford, so the bar answers "why did
    // nothing happen?" before you have to ask it.
    for (const [id, slot] of this.slots) {
      slot.root.classList.toggle("unaffordable", mana < SPELLS[id].manaCost);
    }
  }

  /** Build the ability bar once. Called when a session starts. */
  buildAbilityBar(): void {
    this.abilities.innerHTML = "";
    this.slots.clear();
    this.shownCombo = -1;

    SPELL_IDS.forEach((id, index) => {
      const spell = SPELLS[id];
      const root = document.createElement("div");
      root.className = "ability";
      root.innerHTML =
        `<span class="key">${index + 1}</span>` +
        `<span class="name">${spell.name}</span>` +
        `<span class="meta">Aequum ${spell.aequum}` +
        `${spell.manaCost > 0 ? ` \u00b7 ${spell.manaCost} mana` : " \u00b7 free"}</span>` +
        `<span class="prof"></span>` +
        (id === "strike" ? `<span class="pips"><i></i><i></i><i></i></span>` : "") +
        `<span class="cool"></span>`;
      this.abilities.appendChild(root);

      this.slots.set(id, {
        root,
        cool: root.querySelector(".cool") as HTMLElement,
        prof: root.querySelector(".prof") as HTMLElement,
      });
    });
  }

  /** Sweep the cooldown shade on each slot. Cheap enough to run every frame. */
  setCooldowns(now: number, nextCastAt: Map<SpellId, number>): void {
    for (const [id, slot] of this.slots) {
      const ready = nextCastAt.get(id) ?? 0;
      const remaining = ready - now;
      if (remaining <= 0) {
        if (slot.cool.style.height !== "0%") slot.cool.style.height = "0%";
        continue;
      }
      slot.cool.style.height = `${Math.min(1, remaining / SPELLS[id].cooldownMs) * 100}%`;
    }
  }

  /**
   * Show how practised the caster is, and their innate ceiling.
   *
   * Proficiency is shown as the damage bonus it actually buys rather than a
   * raw number, because "+7% damage" answers the question a bare 12 does not.
   */
  setProfile(affinity: number, spells: SpellProficiency): void {
    this.affinityText.textContent =
      `Affinity ${Math.round(affinity)} / ${MAX_AFFINITY}`;

    for (const [id, slot] of this.slots) {
      const proficiency = spells[id] ?? 0;
      const bonus = Math.round((proficiencyMultiplier(proficiency) - 1) * 100);
      slot.prof.textContent = proficiency > 0 ? `+${bonus}%` : "";
      // At the ceiling this spell will never improve again; say so.
      slot.root.classList.toggle("maxed", proficiency >= affinity - 0.01);
    }
  }

  toggleBag(): void {
    this.bag.hidden = !this.bag.hidden;
  }

  get bagOpen(): boolean {
    return !this.bag.hidden;
  }

  /**
   * Redraw the bag.
   *
   * Every entry shows what it would do, not just what it is: an item you
   * cannot compare is an item you cannot choose between.
   */
  setInventory(inventory: string[], equipment: Equipment): void {
    this.bagWorn.innerHTML = "";
    for (const slot of EQUIP_SLOTS) {
      const wornId = equipment[slot];
      const item = wornId !== undefined ? getItem(wornId) : undefined;

      const row = document.createElement("div");
      row.className = `worn ${item ? item.rarity : "empty"}`;
      row.innerHTML =
        `<span class="slot">${slot}</span>` +
        `<span class="what">${item ? item.name : "\u2014"}</span>` +
        `<span class="stats">${item ? describeStats(item.stats) : ""}</span>`;

      if (item) {
        const off = document.createElement("button");
        off.className = "take-off";
        off.textContent = "remove";
        off.onclick = () => this.onUnequip?.(slot);
        row.appendChild(off);
      }
      this.bagWorn.appendChild(row);
    }

    this.bagSlots.innerHTML = "";
    if (inventory.length === 0) {
      const empty = document.createElement("div");
      empty.className = "carried empty";
      empty.textContent = "Nothing carried.";
      this.bagSlots.appendChild(empty);
    }

    inventory.forEach((id) => {
      const item = getItem(id);
      if (!item) return;
      const row = document.createElement("div");
      row.className = `carried ${item.rarity}`;
      row.innerHTML =
        `<span class="what">${item.name}</span>` +
        `<span class="slot">${item.slot}</span>` +
        `<span class="stats">${describeStats(item.stats)}</span>` +
        `<span class="flavour">${item.description}</span>`;
      // The whole row is the button: fewer things to aim at mid-fight.
      row.onclick = () => this.onEquip?.(id);
      this.bagSlots.appendChild(row);
    });

    const total = equipmentStats(equipment);
    this.bagTotals.textContent =
      `Worn: +${total.damage} damage \u00b7 +${total.health} health \u00b7 ` +
      `+${total.mana} mana \u00b7 ${inventory.length}/${INVENTORY_SIZE} carried`;
  }

  /** A line that fades. Used for pickups, which need acknowledging but not a
   *  dialog. */
  flash(text: string): void {
    this.toast.textContent = text;
    this.toast.hidden = false;
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast.hidden = true; }, 2600);
  }

  setDead(dead: boolean, detail = ""): void {
    this.death.hidden = !dead;
    this.deathDetail.textContent = detail;
  }

  setRoster(state: WorldState, selfSessionId: string): void {
    const rows: string[] = [];
    state.players.forEach((player: Player, sessionId: string) => {
      const colour = `#${player.colour.toString(16).padStart(6, "0")}`;
      const self = sessionId === selfSessionId;
      rows.push(
        `<div class="${self ? "self" : ""}">` +
        `<i style="background:${colour}"></i>` +
        `${escapeHtml(player.name)}${self ? " (you)" : ""}` +
        `</div>`,
      );
    });
    this.roster.innerHTML = rows.join("");
  }
}

/** "+5 damage · +10 mana", skipping whatever is zero. */
function describeStats(stats: { damage?: number; health?: number; mana?: number }): string {
  const parts: string[] = [];
  if (stats.damage) parts.push(`+${stats.damage} damage`);
  if (stats.health) parts.push(`+${stats.health} health`);
  if (stats.mana) parts.push(`+${stats.mana} mana`);
  return parts.join(" \u00b7 ");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}
