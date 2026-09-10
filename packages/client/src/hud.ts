import {
  proficiencyMultiplier,
  SPELL_IDS,
  SPELLS,
  type OstraDefinition,
  type Player,
  type Proficiency,
  type SpellId,
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
  private powerText = document.getElementById("power") as HTMLElement;
  private notes = document.getElementById("notes") as HTMLElement;
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
  /** Set by main; returns whether sound is now muted. */
  onToggleSound: (() => boolean) | undefined;
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
   * Show how practised the caster is at each spell.
   *
   * Proficiency is shown as the damage bonus it actually buys rather than a
   * raw number, because "+7% damage" answers the question a bare 47 does not.
   * The raw numbers live on the character screen's skills page.
   */
  setSkills(skills: Proficiency): void {
    for (const [id, slot] of this.slots) {
      const proficiency = skills[id] ?? 0;
      const bonus = Math.round((proficiencyMultiplier(proficiency) - 1) * 100);
      slot.prof.textContent = bonus > 0 ? `+${bonus}%` : "";
    }
  }

  /** The one number for "how strong is my gear, for me". */
  setPower(power: number): void {
    this.powerText.textContent = `Power ${power}`;
  }

  /**
   * A line that fades. Used for pickups, which need acknowledging but not a
   * dialog. `colour` tints it: a rare find should look like one.
   */
  flash(text: string, colour?: string): void {
    this.toast.textContent = text;
    this.toast.style.color = colour ?? "";
    this.toast.style.borderColor = colour ? `color-mix(in srgb, ${colour} 55%, transparent)` : "";
    this.toast.hidden = false;
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast.hidden = true; }, 2600);
  }

  /**
   * A small line in the corner that rises and fades: "Heavy Armour 14".
   * Skill-ups arrive in bursts early on; these stack quietly rather than
   * fighting the toast for attention, and the oldest are dropped past four.
   */
  note(text: string): void {
    const line = document.createElement("div");
    line.className = "note";
    line.textContent = text;
    this.notes.appendChild(line);
    while (this.notes.childElementCount > 4) this.notes.firstElementChild?.remove();
    window.setTimeout(() => line.remove(), 3200);
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
