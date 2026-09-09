import { isOstraId, STARTING_OSTRA, type OstraId } from "@mmo/shared";

/**
 * Talking to the server's character endpoints, and remembering which character
 * this browser plays.
 *
 * The id is stored in localStorage, keyed by realm and slot. The slot exists so
 * two tabs on the same machine can be two different players — without it every
 * tab shares one character, which makes local multiplayer testing impossible.
 * Pass `?slot=2` in the URL to use another one.
 */

export interface CharacterSummary {
  id: string;
  name: string;
  ostraId: OstraId;
}

function storageKey(realmId: string, slot: string): string {
  return `ostracon:${realmId}:character:${slot}`;
}

/** localStorage throws in some privacy modes; never let that stop the game. */
function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Non-fatal: the player gets a fresh character next reload.
  }
}

function clearStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Non-fatal.
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function toSummary(value: unknown): CharacterSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["name"] !== "string") return undefined;
  return {
    id: record["id"],
    name: record["name"],
    // An Ostra this build doesn't know about would leave us asking to join a
    // room that can't exist; fall back rather than hanging on a failed join.
    ostraId: isOstraId(record["ostraId"]) ? record["ostraId"] : STARTING_OSTRA,
  };
}

/**
 * Resolve the character this browser should play: reuse the stored one if the
 * server still recognises it, otherwise mint a new one.
 *
 * Returning the Ostra matters as much as the id — a returning player has to
 * know which room to ask for, and only the server knows where they logged out.
 */
export async function resolveCharacter(
  httpEndpoint: string,
  realmId: string,
  slot: string,
  requestedName?: string,
): Promise<CharacterSummary> {
  const key = storageKey(realmId, slot);
  const storedId = readStored(key);

  if (storedId) {
    const response = await fetch(`${httpEndpoint}/characters/${storedId}`);
    if (response.ok) {
      const summary = toSummary(await readJson(response));
      if (summary) return summary;
    }
    // 404 means a wiped database or a different realm — drop it and start over
    // rather than repeatedly failing to join with an id nobody knows.
    clearStored(key);
  }

  const created = await fetch(`${httpEndpoint}/characters`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: requestedName }),
  });
  if (!created.ok) {
    throw new Error(`Could not create a character (${created.status}).`);
  }

  const summary = toSummary(await readJson(created));
  if (!summary) throw new Error("The server returned a character it could not describe.");

  writeStored(key, summary.id);
  return summary;
}
