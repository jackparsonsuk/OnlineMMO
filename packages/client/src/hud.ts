import type { OstraDefinition, Player, WorldState } from "@mmo/shared";

export class Hud {
  private ostraName = document.getElementById("ostra-name") as HTMLElement;
  private ostraSubtitle = document.getElementById("ostra-subtitle") as HTMLElement;
  private status = document.getElementById("status") as HTMLElement;
  private stats = document.getElementById("stats") as HTMLElement;
  private roster = document.getElementById("roster") as HTMLElement;
  private gatePrompt = document.getElementById("gate-prompt") as HTMLElement;

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
