/**
 * Chat: Enter to talk, a short log at the bottom left, and what is said aloud
 * drawn over the speaker's head (see `Nametags.say`).
 *
 * Two channels. "say" is heard by anyone within sixty metres, in the same
 * room; "party" by your whole party wherever they are. Lines go to your party
 * by default when you have one — that is who you are playing with — and aloud
 * otherwise; "/s" and "/p" at the start of a line pick one for that line.
 * The server trims, caps and rate-limits everything; this only draws.
 */

export type ChatChannel = "say" | "party";

export interface ChatLine {
  from: string;
  sessionId: string;
  text: string;
  channel: ChatChannel;
}

/** Lines kept in the log. */
const KEEP = 60;
/** Lines shown while chat is closed, and for how long after each arrives. */
const SHOWN_CLOSED = 7;
const FADE_MS = 25_000;

export class Chat {
  private readonly root = document.getElementById("chat") as HTMLElement;
  private readonly log = document.getElementById("chat-log") as HTMLElement;
  private readonly form = document.getElementById("chat-form") as HTMLFormElement;
  private readonly input = document.getElementById("chat-input") as HTMLInputElement;
  private readonly channelTag = document.getElementById("chat-channel") as HTMLElement;
  private inParty = false;

  constructor(private readonly send: (text: string, channel: ChatChannel) => void) {
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener("keydown", (event) => {
      // The game's keys ignore a focused text box, so Escape is handled here.
      if (event.code === "Escape") this.close();
    });
    this.input.addEventListener("input", () => this.drawChannel());
  }

  get isOpen(): boolean {
    return !this.form.hidden;
  }

  /** Enter: open the box and focus it. */
  open(): void {
    this.form.hidden = false;
    this.root.classList.add("open");
    this.drawChannel();
    this.input.focus();
  }

  close(): void {
    this.input.value = "";
    this.input.blur();
    this.form.hidden = true;
    this.root.classList.remove("open");
  }

  setInParty(inParty: boolean): void {
    this.inParty = inParty;
    this.drawChannel();
  }

  /** A line arrived. */
  add(line: ChatLine): void {
    this.append(line.channel, `${line.from}: `, line.text);
  }

  /** Something the game says in the log — a refusal, mostly. */
  note(text: string): void {
    this.append("note", "", text);
  }

  private append(kind: string, who: string, text: string): void {
    const row = document.createElement("div");
    row.className = `chat-line ${kind}`;
    row.dataset["at"] = String(Date.now());
    if (kind === "party") {
      const tag = document.createElement("span");
      tag.className = "chat-tag";
      tag.textContent = "[Party] ";
      row.appendChild(tag);
    }
    if (who) {
      const name = document.createElement("b");
      name.textContent = who;
      row.appendChild(name);
    }
    // Text, never HTML: this is whatever another player typed.
    row.appendChild(document.createTextNode(text));
    this.log.appendChild(row);
    while (this.log.children.length > KEEP) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Once a frame or so: lines fade out while chat is closed. */
  update(now: number): void {
    const rows = this.log.children;
    const open = this.isOpen;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      const recent = rows.length - i <= SHOWN_CLOSED && now - Number(row.dataset["at"]) < FADE_MS;
      const hidden = !open && !recent;
      if (row.classList.contains("faded") !== hidden) row.classList.toggle("faded", hidden);
    }
  }

  private channelFor(text: string): { channel: ChatChannel; text: string } {
    const match = /^\/(s|say|p|party)\s+/i.exec(text);
    if (match) {
      const party = match[1]!.toLowerCase().startsWith("p");
      return { channel: party ? "party" : "say", text: text.slice(match[0].length) };
    }
    return { channel: this.inParty ? "party" : "say", text };
  }

  private drawChannel(): void {
    const { channel } = this.channelFor(this.input.value);
    this.channelTag.textContent = channel === "party" ? "Party" : "Say";
    this.channelTag.className = channel;
  }

  private submit(): void {
    const { channel, text } = this.channelFor(this.input.value.trim());
    if (text.trim().length > 0) this.send(text.trim(), channel);
    this.close();
  }
}
