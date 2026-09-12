import {
  CLASSES,
  fervourMultiplier,
  MAX_LEVEL,
  SPELLS,
  xpToNext,
  type ClassId,
  type OstraDefinition,
  type ResourceKind,
  type SpellId,
} from "@mmo/shared";

const RESOURCE_NAMES: Record<ResourceKind, string> = { fervour: "Fervour", mana: "Mana" };

interface AbilitySlot {
  root: HTMLElement;
  cool: HTMLElement;
  meta: HTMLElement;
  learnedAt: number;
}

/**
 * What crossing a level handed a character, ready to read out. Derived in
 * `main.ts` from the same pure functions the server grows stats with, so the
 * banner can never disagree with the character screen.
 */
export interface LevelGains {
  /** Primary attributes, already diffed and with anything that did not move
   *  left out — a class with fractional growth gains nothing in some
   *  attribute on some levels, and naming a "+0" is worse than silence. */
  stats: ReadonlyArray<{ name: string; amount: number }>;
  /** Maximum health the level's Vigour bought. */
  health: number;
  /** Items already in the pack that this level makes wearable. */
  wearable: number;
}

export class Hud {
  private zoneBanner = document.getElementById("zone-banner") as HTMLElement;
  private ostraName = document.getElementById("ostra-name") as HTMLElement;
  private ostraSubtitle = document.getElementById("ostra-subtitle") as HTMLElement;
  private status = document.getElementById("status") as HTMLElement;
  private stats = document.getElementById("stats") as HTMLElement;
  private help = document.getElementById("help") as HTMLElement;
  private gatePrompt = document.getElementById("gate-prompt") as HTMLElement;
  private waystonePrompt = document.getElementById("waystone-prompt") as HTMLElement;
  private waystoneShown: string | undefined;
  private speech = document.getElementById("speech") as HTMLElement;
  private speechWho = document.getElementById("speech-who") as HTMLElement;
  private speechLine = document.getElementById("speech-line") as HTMLElement;
  private speaking: string | undefined;
  private healthFill = document.querySelector("#health-bar i") as HTMLElement;
  private healthText = document.getElementById("health-text") as HTMLElement;
  private death = document.getElementById("death") as HTMLElement;
  private deathDetail = document.getElementById("death-detail") as HTMLElement;
  private resourceBar = document.getElementById("resource-bar") as HTMLElement;
  private resourceFill = document.querySelector("#resource-bar i") as HTMLElement;
  private resourceText = document.getElementById("resource-text") as HTMLElement;
  private castbar = document.getElementById("castbar") as HTMLElement;
  private castFill = document.querySelector("#castbar i") as HTMLElement;
  private castLabel = document.querySelector("#castbar span") as HTMLElement;
  private castTimer: number | undefined;
  private xpRoot = document.getElementById("xp") as HTMLElement;
  private xpFill = document.querySelector("#xp-bar i") as HTMLElement;
  private xpLevel = document.querySelector("#xp-text b") as HTMLElement;
  private xpNumbers = document.querySelector("#xp-text span") as HTMLElement;
  private abilities = document.getElementById("abilities") as HTMLElement;
  private powerText = document.getElementById("power") as HTMLElement;
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
  private shownResource = -1;
  private shownMaxHealth = -1;
  private shownMaxResource = -1;
  /** Set by main; returns whether sound is now muted. */
  onToggleSound: (() => boolean) | undefined;
  private slots = new Map<SpellId, AbilitySlot>();
  private level = 1;

  private bannerTimer: number | undefined;
  private shownStats = "";

  constructor() {
    this.soundToggle.onclick = () => this.setMuted(this.onToggleSound?.() ?? false);
    document.getElementById("help-toggle")!.onclick = () => this.toggleHelp();
    this.help.addEventListener("click", (event) => {
      // The button, or the dark around the card.
      const target = event.target as HTMLElement;
      if (target === this.help || target.closest("[data-close]")) this.toggleHelp(false);
    });
  }

  setMuted(muted: boolean): void {
    this.soundToggle.classList.toggle("off", muted);
    this.soundToggle.title = muted ? "Sound off (click to unmute)" : "Sound on (click to mute)";
  }

  /** The controls card, on H and the corner's "?". */
  toggleHelp(open = this.help.hidden): void {
    this.help.hidden = !open;
  }

  get helpOpen(): boolean {
    return !this.help.hidden;
  }

  /** Show the controls once per browser, the first time into the world. */
  showHelpOnce(): void {
    const key = "ostracon:seenControls";
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      // Storage refused: showing it every time is the safe way round.
    }
    this.toggleHelp(true);
  }

  /**
   * Arriving in an Ostra: its name across the screen for a few seconds, the
   * way a new zone announces itself, then gone. The minimap keeps saying
   * where you are after that; a panel saying it permanently was clutter.
   */
  setOstra(ostra: OstraDefinition): void {
    this.ostraName.textContent = ostra.name;
    this.ostraSubtitle.textContent = ostra.subtitle;
    this.zoneBanner.classList.remove("show");
    // Restart the animation even when arriving back where you were.
    void this.zoneBanner.offsetWidth;
    this.zoneBanner.classList.add("show");
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.zoneBanner.classList.remove("show"), 4600);
  }

  /** Only on screen while something is happening or wrong: "connected" is
   *  the normal state, and the normal state needs no label. */
  setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.classList.toggle("error", isError);
    this.status.hidden = !isError && text === "connected";
  }

  /** Ping in the corner. Tick rate and unacked inputs explain most "why
   *  does it feel like that?" questions in development, and none in play. */
  setStats(ping: number, tickRate: number, pending: number): void {
    const text = import.meta.env.DEV
      ? `${Math.round(ping)} ms · ${tickRate} Hz · ${pending}`
      : `${Math.round(ping)} ms`;
    if (text === this.shownStats) return;
    this.shownStats = text;
    this.stats.textContent = text;
    this.stats.classList.toggle("slow", ping > 180);
  }

  /** Named when you're near enough to see it, so a Gate is never a surprise. */
  setGatePrompt(label: string | undefined): void {
    this.gatePrompt.textContent = label ?? "";
    this.gatePrompt.hidden = label === undefined;
  }

  /**
   * The woken waystone you are standing at, and how to use it. Only touches
   * the DOM when the stone changes — you stand at one for whole seconds.
   */
  setWaystonePrompt(name: string | undefined): void {
    if (name === this.waystoneShown) return;
    this.waystoneShown = name;
    this.waystonePrompt.hidden = name === undefined;
    if (name === undefined) return;
    this.waystonePrompt.innerHTML = `<b></b><span><kbd>E</kbd> travel</span>`;
    (this.waystonePrompt.querySelector("b") as HTMLElement).textContent = name;
  }

  /**
   * What the nearest villager is saying, or nothing.
   *
   * Only touches the DOM when the speaker changes, so standing in front of
   * someone doesn't rewrite their line sixty times a second.
   */
  setSpeech(who: string | undefined, line = "", talk = false): void {
    if (who === this.speaking) return;
    this.speaking = who;
    this.speech.hidden = who === undefined;
    if (who === undefined) return;
    this.speechWho.textContent = who;
    this.speechLine.textContent = line;
    // Anyone who might have work for you says how to ask.
    if (talk) {
      const hint = document.createElement("span");
      hint.className = "speech-talk";
      hint.innerHTML = "<kbd>E</kbd> talk";
      this.speechLine.appendChild(hint);
    }
  }

  /** Force the bubble to redraw next frame — its hint may have changed. */
  refreshSpeech(): void {
    this.speaking = undefined;
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

  /**
   * The class's resource under the health bar. Fervour also says what it is
   * worth right now, because "+21% damage" is the reason to care about it.
   */
  setResource(kind: ResourceKind, value: number, max: number): void {
    if (value === this.shownResource && max === this.shownMaxResource) return;
    this.shownResource = value;
    this.shownMaxResource = max;
    this.resourceBar.dataset["kind"] = kind;
    this.resourceFill.style.width = `${Math.max(0, Math.min(1, value / Math.max(1, max))) * 100}%`;
    const bonus = Math.round((fervourMultiplier(value) - 1) * 100);
    this.resourceText.textContent = kind === "fervour"
      ? `${RESOURCE_NAMES[kind]} ${value}${bonus > 0 ? ` \u00b7 +${bonus}% damage` : ""}`
      : `${value} / ${max}`;

    // Grey what you cannot currently afford, so the bar answers "why did
    // nothing happen?" before you have to ask it.
    for (const [id, slot] of this.slots) {
      slot.root.classList.toggle("unaffordable", value < SPELLS[id].cost);
    }
  }

  /**
   * Build the ability bar for a class: every ability it will ever learn, in
   * order, the ones not yet learned shown locked with the level that brings
   * them \u2014 so the bar is also the road ahead.
   */
  buildAbilityBar(classId: ClassId): void {
    this.abilities.innerHTML = "";
    this.slots.clear();
    this.shownCombo = -1;
    const resource = RESOURCE_NAMES[CLASSES[classId].resource];

    CLASSES[classId].abilities.forEach(({ spell: id, level }, index) => {
      const spell = SPELLS[id];
      const root = document.createElement("div");
      root.className = index === 0 ? "ability mouse-key" : "ability";
      root.title = spell.description;
      root.innerHTML =
        // The first ability is the left mouse button; the rest keep their numbers.
        `<span class="key">${index === 0 ? "LMB" : index + 1}</span>` +
        `<span class="name">${spell.name}</span>` +
        `<span class="meta" data-cost="${spell.cost > 0 ? `${spell.cost} ${resource}` : "free"}"></span>` +
        (id === "strike" ? `<span class="pips"><i></i><i></i><i></i></span>` : "") +
        `<span class="cool"></span>`;
      this.abilities.appendChild(root);

      this.slots.set(id, {
        root,
        cool: root.querySelector(".cool") as HTMLElement,
        meta: root.querySelector(".meta") as HTMLElement,
        learnedAt: level,
      });
    });

    // Every class's two, on their own keys, set apart from the class's bar.
    const utility = (key: string, name: string, meta: string, title: string): HTMLElement => {
      const root = document.createElement("div");
      root.className = key.length > 1 ? "ability utility mouse-key" : "ability utility";
      root.title = title;
      root.innerHTML = `<span class="key">${key}</span><span class="name">${name}</span>` +
        `<span class="meta">${meta}</span><span class="cool"></span>`;
      this.abilities.appendChild(root);
      return root.querySelector(".cool") as HTMLElement;
    };
    // Right-click is the class's guard: a block, or a second key for Dodge.
    const guard = CLASSES[classId].guard;
    if (guard === "block") {
      utility("RMB", "Block", "hold", "Block: hold the right mouse button. Blows from the front do a fifth of their damage; you move slowly, cannot swing, and Fervour drains.");
    }
    this.dodgeCool = utility(guard === "dodge" ? "RMB" : "Q", "Dodge", "dash", "Dodge: a quick dash where you are steering (or back). Blows miss you while it lasts.");
    this.healCool = utility("R", "Second Wind", "heal", "Second Wind: a third of your health back at once. Usable in a fight; a long cooldown.");
    this.drawLocks();
    // The resource line re-greys against the new slots on its next update.
    this.shownResource = -1;
  }

  /** Your level: the XP bar's label, and which abilities are unlocked. */
  setXp(level: number, xp: number): void {
    const next = xpToNext(level);
    this.xpLevel.textContent = `Level ${level}`;
    this.xpNumbers.textContent = level >= MAX_LEVEL ? "Max level" : `${xp.toLocaleString()} / ${next.toLocaleString()} XP`;
    this.xpFill.style.width = `${level >= MAX_LEVEL ? 100 : Math.min(100, (xp / Math.max(1, next)) * 100)}%`;
    if (level !== this.level) {
      this.level = level;
      this.drawLocks();
    }
  }

  private drawLocks(): void {
    for (const slot of this.slots.values()) {
      const locked = slot.learnedAt > this.level;
      slot.root.classList.toggle("locked", locked);
      slot.meta.textContent = locked ? `Level ${slot.learnedAt}` : slot.meta.dataset["cost"] ?? "";
    }
  }

  /** A cast with a cast time has started: fill the bar over its length. */
  startCast(name: string, ms: number): void {
    window.clearTimeout(this.castTimer);
    this.castbar.classList.remove("interrupted");
    this.castLabel.textContent = name;
    this.castbar.hidden = false;
    this.castFill.style.transition = "none";
    this.castFill.style.width = "0%";
    // Force the reset to take before the fill starts.
    void this.castFill.offsetWidth;
    this.castFill.style.transition = `width ${ms}ms linear`;
    this.castFill.style.width = "100%";
  }

  /** The cast landed, or was cancelled by moving — which says so briefly. */
  endCast(interrupted: boolean): void {
    window.clearTimeout(this.castTimer);
    if (!interrupted) {
      this.castbar.hidden = true;
      return;
    }
    this.castbar.classList.add("interrupted");
    this.castLabel.textContent = "Interrupted";
    this.castFill.style.transition = "none";
    this.castTimer = window.setTimeout(() => { this.castbar.hidden = true; }, 700);
  }

  /** "+77 XP", floating off the end of the bar. */
  xpGain(amount: number): void {
    if (amount <= 0) return;
    const drop = document.createElement("div");
    drop.className = "xp-drop";
    drop.textContent = `+${amount.toLocaleString()} XP`;
    this.xpRoot.appendChild(drop);
    window.setTimeout(() => drop.remove(), 1400);
  }

  private dodgeCool: HTMLElement | undefined;
  private healCool: HTMLElement | undefined;
  private shownUtility = "";

  /** The Dodge and Second Wind slots' cooldowns, as the fraction left. */
  setUtility(dodge: number, heal: number): void {
    const d = Math.max(0, Math.min(1, dodge));
    const h = Math.max(0, Math.min(1, heal));
    const key = `${d.toFixed(3)}|${h.toFixed(3)}`;
    if (key === this.shownUtility) return;
    this.shownUtility = key;
    if (this.dodgeCool) this.dodgeCool.style.height = `${d * 100}%`;
    if (this.healCool) this.healCool.style.height = `${h * 100}%`;
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

  /** The one number for "how strong is my gear". */
  setPower(power: number): void {
    this.shownPower = power;
    this.drawPurse();
  }

  setGold(gold: number): void {
    this.shownGold = gold;
    this.drawPurse();
  }

  private shownPower = 0;
  private shownGold = 0;

  private drawPurse(): void {
    this.powerText.innerHTML = `Power ${this.shownPower} · <span class="gold">${this.shownGold} gold</span>`;
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
   * News for the whole Ostra — an elite waking or falling. Shares the level-up
   * column, so it stacks with them rather than covering them.
   */
  announce(heading: string, name: string, line: string, fell: boolean): void {
    const banner = document.createElement("div");
    banner.className = `announce${fell ? " fell" : ""}`;
    banner.innerHTML = `<small>${escapeHtml(heading)}</small><b>${escapeHtml(name)}</b><span>${escapeHtml(line)}</span>`;
    document.getElementById("level-ups")?.appendChild(banner);
    window.setTimeout(() => banner.remove(), 6000);
  }

  /** A level gained: centre of the screen, big, and gone in a few seconds —
   *  with anything it taught you, since that is what you will want to try. */
  /**
   * A level, and everything it handed you.
   *
   * The level-up is the moment the whole of `levels.ts` was rebuilt around, and
   * for a long time the banner only ever named new abilities — so a level that
   * taught nothing said nothing but a number, and the Might, the Vigour and the
   * sword in your pack that had just become wearable all went unmentioned. A
   * reward you are not told about is not much of a reward.
   *
   * The lines are stacked strongest-first: what you became, what you learned,
   * then what is now waiting in your pack.
   */
  levelUp(level: number, learned: readonly string[], gains: LevelGains): void {
    const lines: string[] = [];
    const grew = gains.stats.map((stat) => `+${stat.amount} ${escapeHtml(stat.name)}`);
    if (gains.health > 0) grew.push(`+${gains.health} health`);
    if (grew.length > 0) lines.push(`<u>${grew.join(" · ")}</u>`);
    if (learned.length > 0) {
      lines.push(`<b>You have learned ${learned.map(escapeHtml).join(" and ")}</b>`);
    }
    if (gains.wearable > 0) {
      lines.push(`<i>${gains.wearable === 1
        ? "Something in your pack fits you now"
        : `${gains.wearable} things in your pack fit you now`}</i>`);
    }

    const banner = document.createElement("div");
    banner.className = "level-up";
    banner.innerHTML = `<small>Level up</small><span>${level}</span>${lines.join("")}`;
    // The animation ends at zero opacity, so its duration — not the timer — is
    // how long the banner is actually readable. More to read, longer to read
    // it; the timer only tidies up afterwards.
    const life = 2600 + lines.length * 700;
    banner.style.animationDuration = `${life}ms`;
    // Stacked in one column, so a big quest turn-in worth two levels shows both.
    document.getElementById("level-ups")?.appendChild(banner);
    window.setTimeout(() => banner.remove(), life + 200);
  }

  setDead(dead: boolean, detail = ""): void {
    this.death.hidden = !dead;
    this.deathDetail.textContent = detail;
  }

}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}
