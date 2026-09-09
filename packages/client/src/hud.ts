import { PLAYER_MAX_HEALTH, type OstraDefinition, type Player, type WorldState } from "@mmo/shared";

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
  private shownHealth = -1;

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
