import {
  MAX_AFFINITY,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
  proficiencyMultiplier,
  SPELL_IDS,
  SPELLS,
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
  private healthFill = document.querySelector("#health-bar i") as HTMLElement;
  private healthText = document.getElementById("health-text") as HTMLElement;
  private death = document.getElementById("death") as HTMLElement;
  private deathDetail = document.getElementById("death-detail") as HTMLElement;
  private manaFill = document.querySelector("#mana-bar i") as HTMLElement;
  private manaText = document.getElementById("mana-text") as HTMLElement;
  private abilities = document.getElementById("abilities") as HTMLElement;
  private affinityText = document.getElementById("affinity") as HTMLElement;
  private shownHealth = -1;
  private shownMana = -1;
  private slots = new Map<SpellId, { root: HTMLElement; cool: HTMLElement; prof: HTMLElement }>();

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

  /** Only touches the DOM when the number actually moved. */
  setHealth(health: number): void {
    if (health === this.shownHealth) return;
    this.shownHealth = health;
    const fraction = Math.max(0, Math.min(1, health / PLAYER_MAX_HEALTH));
    this.healthFill.style.width = `${fraction * 100}%`;
    this.healthText.textContent = `${health} / ${PLAYER_MAX_HEALTH}`;
    // Below a quarter the bar turns; you should not have to read a number to
    // know you are in trouble.
    this.healthFill.classList.toggle("low", fraction <= 0.25);
  }

  setMana(mana: number): void {
    if (mana === this.shownMana) return;
    this.shownMana = mana;
    this.manaFill.style.width = `${Math.max(0, Math.min(1, mana / PLAYER_MAX_MANA)) * 100}%`;
    this.manaText.textContent = `${mana} / ${PLAYER_MAX_MANA}`;

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}
