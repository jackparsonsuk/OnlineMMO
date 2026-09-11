import { getOstra, isOstraId, PARTY_SIZE, type Player, type WorldState } from "@mmo/shared";

/**
 * Your party: frames down the left of the screen for everyone in it, the
 * window on P for inviting and leaving, and the prompt when someone asks you
 * to join.
 *
 * The server owns the party (see the server's `parties.ts`) and sends the
 * whole roster whenever it changes. Health is not in the roster — it changes
 * every blow — so a member in the same room as you is read straight from
 * replicated state by session id, and one elsewhere just says where they are.
 */

export interface PartyMember {
  id: string;
  name: string;
  level: number;
  online: boolean;
  ostraId: string;
  sessionId: string;
}

export interface PartyRoster {
  leader: string;
  members: PartyMember[];
  /** Your own character id, so the frames can leave you out. */
  you: string;
}

export interface PartyActions {
  invite(name: string): void;
  /** Invite whoever was clicked in the world, by their connection. */
  inviteSession(sessionId: string): void;
  respond(accept: boolean): void;
  leave(): void;
  kick(id: string): void;
}

/** An invitation on screen is withdrawn after this long (the server lets it
 *  lapse after a minute either way). */
const INVITE_SHOWN_MS = 55_000;

export class PartyUI {
  private readonly frames = document.getElementById("party") as HTMLElement;
  private readonly window = document.getElementById("party-window") as HTMLElement;
  private readonly prompt = document.getElementById("party-invite") as HTMLElement;
  private readonly menu = document.getElementById("player-menu") as HTMLElement;
  private roster: PartyRoster | undefined;
  private readonly rows = new Map<string, { fill: HTMLElement; text: HTMLElement; row: HTMLElement }>();
  private inviteTimer: number | undefined;
  private shown = "";

  constructor(private readonly actions: PartyActions) {
    this.prompt.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-answer]");
      if (!button) return;
      this.actions.respond(button.dataset["answer"] === "yes");
      this.hideInvite();
    });
    this.window.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = this.window.querySelector<HTMLInputElement>("input[name=invite]");
      const name = input?.value.trim() ?? "";
      if (name.length === 0) return;
      this.actions.invite(name);
      if (input) input.value = "";
    });
    // The game's own keys ignore a focused text box, Escape included.
    this.window.addEventListener("keydown", (event) => {
      if (event.code === "Escape") this.setOpen(false);
    });
    this.window.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
      if (!button) return;
      if (button.dataset["act"] === "leave") this.actions.leave();
      else if (button.dataset["act"] === "kick" && button.dataset["id"]) this.actions.kick(button.dataset["id"]);
      else if (button.dataset["act"] === "close") this.setOpen(false);
    });
    this.menu.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-session]");
      if (button?.dataset["session"]) this.actions.inviteSession(button.dataset["session"]);
      this.menu.hidden = true;
    });
    // Anywhere else closes it, as a menu should.
    window.addEventListener("pointerdown", (event) => {
      if (!this.menu.hidden && !this.menu.contains(event.target as Node)) this.menu.hidden = true;
    });
    this.drawWindow();
  }

  /**
   * Someone clicked another player in the world: offer to invite them, at the
   * cursor. Only offered when it could work — not to someone already with you.
   */
  showPlayerMenu(sessionId: string, name: string, x: number, y: number): void {
    const already = this.mates.some((member) => member.sessionId === sessionId);
    const full = (this.roster?.members.length ?? 0) >= PARTY_SIZE;
    this.menu.innerHTML = `<div class="menu-title">${escapeHtml(name)}</div>` +
      (already ? `<div class="menu-note">In your party</div>`
        : full ? `<div class="menu-note">Your party is full</div>`
          : `<button type="button" data-session="${escapeHtml(sessionId)}">Invite to party</button>`);
    this.menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    this.menu.style.top = `${Math.min(y, window.innerHeight - 90)}px`;
    this.menu.hidden = false;
  }

  get isOpen(): boolean {
    return !this.window.hidden;
  }

  /** Character ids and session ids of everyone else in your party. */
  get mates(): PartyMember[] {
    if (!this.roster) return [];
    return this.roster.members.filter((member) => member.id !== this.roster!.you);
  }

  toggle(): void {
    this.setOpen(this.window.hidden);
  }

  setOpen(open: boolean): void {
    this.window.hidden = !open;
    if (open) {
      this.drawWindow();
      this.window.querySelector<HTMLInputElement>("input[name=invite]")?.focus();
    } else {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  setRoster(roster: PartyRoster | null): void {
    this.roster = roster ?? undefined;
    this.shown = "";
    this.drawFrames();
    this.drawWindow();
  }

  showInvite(from: string): void {
    this.prompt.innerHTML =
      `<div><b>${escapeHtml(from)}</b> invites you to join their party.</div>` +
      `<div class="party-invite-buttons">` +
      `<button type="button" data-answer="yes">Join</button>` +
      `<button type="button" data-answer="no">Decline</button></div>`;
    this.prompt.hidden = false;
    window.clearTimeout(this.inviteTimer);
    this.inviteTimer = window.setTimeout(() => this.hideInvite(), INVITE_SHOWN_MS);
  }

  private hideInvite(): void {
    window.clearTimeout(this.inviteTimer);
    this.prompt.hidden = true;
  }

  /** Once a frame: health for everyone in the room with you. Only touches
   *  the DOM when a number moved. */
  update(state: WorldState | undefined): void {
    if (!this.roster) return;
    let key = "";
    for (const member of this.mates) {
      const player = member.online && member.sessionId ? state?.players.get(member.sessionId) as Player | undefined : undefined;
      key += player ? `${member.id}:${player.health}/${player.maxHealth};` : `${member.id}:-;`;
    }
    if (key === this.shown) return;
    this.shown = key;
    for (const member of this.mates) {
      const row = this.rows.get(member.id);
      if (!row) continue;
      const player = member.online && member.sessionId ? state?.players.get(member.sessionId) as Player | undefined : undefined;
      row.row.classList.toggle("away", !player);
      row.row.classList.toggle("dead", player?.health === 0);
      if (player) {
        const fraction = Math.max(0, Math.min(1, player.health / Math.max(1, player.maxHealth)));
        row.fill.style.width = `${fraction * 100}%`;
        row.fill.classList.toggle("low", fraction <= 0.3);
        row.text.textContent = player.health === 0 ? "fallen" : `${player.health} / ${player.maxHealth}`;
      } else {
        row.fill.style.width = "0%";
        row.text.textContent = member.online ? `in ${ostraName(member.ostraId)}` : "offline";
      }
    }
  }

  private drawFrames(): void {
    this.rows.clear();
    this.frames.innerHTML = "";
    const roster = this.roster;
    this.frames.hidden = !roster;
    if (!roster) return;
    for (const member of this.mates) {
      const row = document.createElement("div");
      row.className = "party-member";
      row.innerHTML =
        `<div class="pm-head">${member.id === roster.leader ? `<span class="pm-crown" title="Leader">&#9733;</span>` : ""}` +
        `<span class="pm-name">${escapeHtml(member.name)}</span><span class="pm-level">${member.level}</span></div>` +
        `<div class="pm-bar"><i></i></div><div class="pm-text"></div>`;
      this.frames.appendChild(row);
      this.rows.set(member.id, {
        row,
        fill: row.querySelector(".pm-bar i") as HTMLElement,
        text: row.querySelector(".pm-text") as HTMLElement,
      });
    }
  }

  private drawWindow(): void {
    const roster = this.roster;
    const leader = roster?.leader === roster?.you;
    const members = roster
      ? roster.members.map((member) => {
        const you = member.id === roster.you;
        const kick = leader && !you ? `<button type="button" data-act="kick" data-id="${escapeHtml(member.id)}">Remove</button>` : "";
        return `<li><span>${member.id === roster.leader ? "&#9733; " : ""}${escapeHtml(member.name)}` +
          `${you ? " (you)" : ""} <small>${member.level}</small>` +
          `${member.online ? "" : ` <small class="pm-off">offline</small>`}</span>${kick}</li>`;
      }).join("")
      : "";
    this.window.innerHTML =
      `<div class="pw-head"><b>Party</b><button type="button" data-act="close" title="Close (P)">&times;</button></div>` +
      (roster
        ? `<ul>${members}</ul>`
        : `<p class="pw-note">You are on your own. Invite someone by name, or click them in the world.</p>`) +
      ((roster?.members.length ?? 0) < PARTY_SIZE
        ? `<label class="pw-invite"><input name="invite" maxlength="40" autocomplete="off" spellcheck="false" placeholder="Character name"><button type="submit">Invite</button></label>`
        : `<p class="pw-note">Your party is full.</p>`) +
      `<p class="pw-note">A party shares kills and quest credit, and goes into a dungeon together.</p>` +
      (roster ? `<button type="button" class="pw-leave" data-act="leave">Leave party</button>` : "");
  }
}

function ostraName(id: string): string {
  return isOstraId(id) ? getOstra(id).name : "the world";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}
