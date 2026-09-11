/**
 * Parties: a few players who have agreed to play together.
 *
 * Module-level rather than on a room, for the same reason elite timers are: a
 * party outlives any one room. Its members walk through Gates, go down into a
 * dungeon while the others are still on the road, and log out and back in; the
 * party has to still be there each time. One process serves one realm (see
 * SQLite in the README), so a module is the realm's whole world. A restart
 * disbands every party, which is no worse than losing a group in any MMO when
 * the server goes down.
 *
 * Rooms tell this module who is online and where (`arrive` / `depart`), and
 * hand each presence a `send` so a message reaches a character in whatever
 * room they are standing in. What a party changes in play is decided by the
 * rooms: who shares a kill (`partyMates`), and which dungeon instance someone
 * is sent to (`dungeonInstanceFor`).
 */

import { randomUUID } from "node:crypto";
import { PARTY_SIZE } from "@mmo/shared";

/** One character online, as the room they are in describes them. */
export interface Presence {
  characterId: string;
  name: string;
  level: number;
  ostraId: string;
  /** The dungeon instance they are in, if they are in one. */
  instance: string | undefined;
  /** Their connection in that room. Unique across rooms, so a client can
   *  tell which members are in the room with it. */
  sessionId: string;
  send: (type: string, payload?: unknown) => void;
}

interface Party {
  id: string;
  leader: string;
  /** Character ids, in the order they joined. */
  members: string[];
}

/** What a member's client is told about their party. */
export interface RosterMember {
  id: string;
  name: string;
  level: number;
  online: boolean;
  ostraId: string;
  sessionId: string;
}

/** An invitation lapses after this long unanswered. */
const INVITE_MS = 60_000;

/** Someone who drops out is kept in the party this long, so a crash or a
 *  reload does not cost them their group. */
const OFFLINE_GRACE_MS = 3 * 60_000;

const online = new Map<string, Presence>();
const parties = new Map<string, Party>();
const partyOf = new Map<string, string>();
/** Invitee → who asked them, and when. One open invitation each. */
const invites = new Map<string, { from: string; at: number }>();
/** Last known name and level, for members who are offline. */
const known = new Map<string, { name: string; level: number; ostraId: string }>();
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

// --- presence ------------------------------------------------------------------

/** A character joined a room. Also how a room reports a change of level. */
export function arrive(presence: Presence): void {
  online.set(presence.characterId, presence);
  known.set(presence.characterId, { name: presence.name, level: presence.level, ostraId: presence.ostraId });
  const timer = offlineTimers.get(presence.characterId);
  if (timer) {
    clearTimeout(timer);
    offlineTimers.delete(presence.characterId);
  }
  const party = partyFor(presence.characterId);
  if (party) sendRoster(party);
}

/**
 * Tell one character their party, and any invitation still waiting for them.
 * Separate from `arrive` because a room's join is too early to send to the
 * client — its handlers are not registered yet — so the room calls this when
 * the client asks for its profile.
 */
export function greet(characterId: string): void {
  const presence = online.get(characterId);
  if (!presence) return;
  const party = partyFor(characterId);
  presence.send("party", party ? roster(party, characterId) : null);
  const invite = invites.get(characterId);
  if (invite && Date.now() - invite.at < INVITE_MS) {
    presence.send("partyInvite", { from: known.get(invite.from)?.name ?? "Someone" });
  }
}

/** Their level changed; everyone in their party redraws it. */
export function levelChanged(characterId: string, level: number): void {
  const presence = online.get(characterId);
  if (presence) arrive({ ...presence, level });
}

/**
 * A character left a room. Walking through a Gate joins the new room before
 * leaving the old one, so a departure from a session that is no longer theirs
 * is the tail end of a trip and changes nothing.
 */
export function depart(characterId: string, sessionId: string): void {
  if (online.get(characterId)?.sessionId !== sessionId) return;
  online.delete(characterId);
  const party = partyFor(characterId);
  if (!party) {
    invites.delete(characterId);
    return;
  }
  sendRoster(party);
  offlineTimers.set(characterId, setTimeout(() => {
    offlineTimers.delete(characterId);
    if (!online.has(characterId)) leave(characterId);
  }, OFFLINE_GRACE_MS));
}

// --- invitations -----------------------------------------------------------------

/** Find an online character by name, ignoring case. */
function findByName(name: string): Presence | undefined {
  const wanted = name.trim().toLowerCase();
  for (const presence of online.values()) {
    if (presence.name.toLowerCase() === wanted) return presence;
  }
  return undefined;
}

/**
 * Ask someone to join your party (making one, if you have none). Anyone in a
 * party may invite; it is a group of friends, not a guild with ranks. Returns
 * what to tell the inviter.
 */
export function invite(fromId: string, target: { name?: string; characterId?: string }): string {
  const from = online.get(fromId);
  if (!from) return "You are not in the world.";
  const to = target.characterId !== undefined ? online.get(target.characterId)
    : target.name !== undefined ? findByName(target.name)
      : undefined;
  if (!to) return target.name ? `Nobody called ${target.name} is here.` : "They are not here.";
  if (to.characterId === fromId) return "You are already in your own company.";
  const party = partyFor(fromId);
  if (party && party.members.includes(to.characterId)) return `${to.name} is already with you.`;
  if (partyFor(to.characterId)) return `${to.name} is already in a party.`;
  if (party && party.members.length >= PARTY_SIZE) return `A party is at most ${PARTY_SIZE}.`;
  const open = invites.get(to.characterId);
  if (open && open.from !== fromId && Date.now() - open.at < INVITE_MS) return `${to.name} is considering another invitation.`;

  invites.set(to.characterId, { from: fromId, at: Date.now() });
  to.send("partyInvite", { from: from.name });
  return `Invited ${to.name}.`;
}

/** Say yes or no to the invitation you were sent. */
export function respond(characterId: string, accept: boolean): void {
  const open = invites.get(characterId);
  invites.delete(characterId);
  const me = online.get(characterId);
  if (!open || !me) return;
  const inviter = online.get(open.from);
  if (Date.now() - open.at >= INVITE_MS) {
    me.send("partyNote", { text: "That invitation has lapsed." });
    return;
  }
  if (!accept) {
    inviter?.send("partyNote", { text: `${me.name} declined.` });
    return;
  }
  if (partyFor(characterId)) return;

  let party = partyFor(open.from);
  if (!party) {
    // The inviter may have gone offline since; a party of one waiting for
    // someone who has left would only confuse.
    if (!inviter) {
      me.send("partyNote", { text: "They have gone." });
      return;
    }
    party = { id: randomUUID(), leader: open.from, members: [open.from] };
    parties.set(party.id, party);
    partyOf.set(open.from, party.id);
  }
  if (party.members.length >= PARTY_SIZE) {
    me.send("partyNote", { text: "That party is full." });
    return;
  }
  party.members.push(characterId);
  partyOf.set(characterId, party.id);
  for (const id of party.members) {
    online.get(id)?.send("partyNote", { text: id === characterId ? "You joined the party." : `${me.name} joined the party.` });
  }
  sendRoster(party);
}

// --- leaving -------------------------------------------------------------------

/** Leave your party. Two is the smallest party; one left alone is disbanded. */
export function leave(characterId: string): void {
  const party = partyFor(characterId);
  if (!party) return;
  party.members = party.members.filter((id) => id !== characterId);
  partyOf.delete(characterId);
  online.get(characterId)?.send("party", null);
  const name = known.get(characterId)?.name ?? "Someone";

  if (party.members.length < 2) {
    for (const id of party.members) {
      partyOf.delete(id);
      online.get(id)?.send("party", null);
      online.get(id)?.send("partyNote", { text: "Your party has disbanded." });
    }
    parties.delete(party.id);
    return;
  }
  if (party.leader === characterId) party.leader = party.members[0]!;
  for (const id of party.members) online.get(id)?.send("partyNote", { text: `${name} left the party.` });
  sendRoster(party);
}

/** The leader removes someone. */
export function kick(leaderId: string, targetId: string): void {
  const party = partyFor(leaderId);
  if (!party || party.leader !== leaderId || targetId === leaderId || !party.members.includes(targetId)) return;
  online.get(targetId)?.send("partyNote", { text: "You were removed from the party." });
  leave(targetId);
}

// --- what a party changes ----------------------------------------------------------

function partyFor(characterId: string): Party | undefined {
  const id = partyOf.get(characterId);
  return id !== undefined ? parties.get(id) : undefined;
}

/**
 * A line said to the party, wherever each of them is standing. Returns
 * false if there is no party to hear it.
 */
export function partyChat(characterId: string, payload: { from: string; sessionId: string; text: string }): boolean {
  const party = partyFor(characterId);
  if (!party) return false;
  for (const id of party.members) online.get(id)?.send("chat", { ...payload, channel: "party" });
  return true;
}

/** Everyone else in this character's party, online or not. */
export function partyMates(characterId: string): string[] {
  return partyFor(characterId)?.members.filter((id) => id !== characterId) ?? [];
}

/**
 * Which copy of a dungeon to send someone into.
 *
 * Whichever one a party member is already in — so friends who go down one at
 * a time find each other, even if the first went in before the party formed.
 * Otherwise a fresh one. There is no stored "party instance": an instance is
 * exactly as long-lived as the room holding it, and it is gone (reset) once
 * the last person in it has left.
 */
export function dungeonInstanceFor(characterId: string, ostraId: string): string {
  for (const id of partyMates(characterId)) {
    const presence = online.get(id);
    if (presence?.ostraId === ostraId && presence.instance !== undefined) return presence.instance;
  }
  return `${ostraId}:${randomUUID()}`;
}

function sendRoster(party: Party): void {
  for (const id of party.members) online.get(id)?.send("party", roster(party, id));
}

function roster(party: Party, you: string): { leader: string; members: RosterMember[]; you: string } {
  const members: RosterMember[] = party.members.map((id) => {
    const presence = online.get(id);
    const last = known.get(id);
    return {
      id,
      name: presence?.name ?? last?.name ?? "?",
      level: presence?.level ?? last?.level ?? 1,
      online: presence !== undefined,
      ostraId: presence?.ostraId ?? last?.ostraId ?? "",
      sessionId: presence?.sessionId ?? "",
    };
  });
  return { leader: party.leader, members, you };
}
