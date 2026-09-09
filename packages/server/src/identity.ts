import { randomBytes } from "node:crypto";
import {
  getOstra,
  MAX_AFFINITY,
  MIN_AFFINITY,
  PLAYER_MAX_HEALTH,
  STARTING_OSTRA,
} from "@mmo/shared";
import type { CharacterRecord, CharacterStore } from "./store/CharacterStore.js";

/**
 * Making characters.
 *
 * Characters belong to accounts (see `auth.ts`). A character id is now just an
 * identifier — knowing one gets you nothing, because every join checks that the
 * character belongs to the authenticated account. This file used to carry a
 * long warning that it was not authentication; that warning is retired.
 */

/** Distinct, readable cube colours, handed out in turn as characters are made. */
const PALETTE = [
  0xe8563f, 0x3fa9e8, 0x5ec25e, 0xe8c23f, 0xa969e8,
  0x3fd6c4, 0xe86fb0, 0xf08f3c, 0x8ad04a, 0x6f7de8,
] as const;

const MAX_NAME_LENGTH = 16;

export function sanitiseName(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  // Strip control characters — they would render as boxes in the roster and
  // could smuggle newlines into logs.
  const cleaned = raw.replace(/\p{C}/gu, "").trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : fallback;
}

export function isCharacterId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

/** Mint a character and persist it. The caller hands the id to the client,
 *  which presents it on every subsequent join. */
export function createCharacter(
  store: CharacterStore,
  realmId: string,
  accountId: string,
  requestedName: unknown,
): CharacterRecord {
  const index = store.count(realmId);
  const spawn = getOstra(STARTING_OSTRA).spawn;
  const now = Date.now();

  const character: CharacterRecord = {
    id: randomBytes(16).toString("hex"),
    realmId,
    accountId,
    name: sanitiseName(requestedName, `Traveller ${index + 1}`),
    colour: PALETTE[index % PALETTE.length]!,
    ostraId: STARTING_OSTRA,
    x: spawn.x,
    y: 0,
    z: spawn.z,
    yaw: 0,
    health: PLAYER_MAX_HEALTH,
    // Rolled once, kept forever. "Everyone has some amount of innate magical
    // ability" — so nobody rolls zero, but not everyone can reach the same
    // ceiling.
    affinity: MIN_AFFINITY + Math.floor(Math.random() * (MAX_AFFINITY - MIN_AFFINITY + 1)),
    spells: {},
    inventory: [],
    equipment: {},
    createdAt: now,
    lastSeenAt: now,
  };

  store.create(character);
  return character;
}
