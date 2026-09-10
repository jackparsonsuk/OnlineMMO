import type { Equipment, ItemKey, OstraId, Proficiency } from "@mmo/shared";

/**
 * A character as it survives between sessions. Position and Ostra live here
 * rather than only in room state, because the room is torn down the moment the
 * last player leaves — the database is what makes the world persistent.
 */
export interface CharacterRecord {
  /** Random 128-bit id. Identifies the character; ownership is what makes it
   *  yours, not knowledge of this value. */
  id: string;
  /**
   * Which realm (server) this character belongs to. Characters never move
   * between realms, so every lookup is scoped by it. Present from the start
   * because retrofitting a realm column onto live save data is miserable.
   */
  realmId: string;
  /** The account that owns this character. Empty only for pre-accounts saves,
   *  which are listed for nobody. */
  accountId: string;
  name: string;
  colour: number;
  ostraId: OstraId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Persisted so logging out at 3 HP and back in is not a full heal. */
  health: number;
  /** Every trained number, keyed by SkillId — spells, armour, weapons,
   *  attunement. Absent means untrained. */
  skills: Proficiency;
  /** Carried item keys, in pickup order. */
  inventory: ItemKey[];
  /** Worn item keys, by slot. */
  equipment: Equipment;
  createdAt: number;
  lastSeenAt: number;
}

/** Where a character is, and in which Ostra — the part that changes constantly. */
export type CharacterPosition =
  Pick<CharacterRecord, "ostraId" | "x" | "y" | "z" | "yaw" | "health"> & {
    /** Written on every save; all three change as you play. */
    skills: Proficiency;
    inventory: ItemKey[];
    equipment: Equipment;
  };

/**
 * Storage behind a narrow interface so the SQLite implementation can be
 * swapped for Postgres when this goes public, without the room knowing.
 * Deliberately synchronous: SQLite here is a local file and the room's fixed
 * timestep must not await anything. A Postgres implementation would change
 * these to promises and the room would load on join / save on leave, which are
 * already the only two places it touches the store.
 */
export interface CharacterStore {
  find(realmId: string, characterId: string): CharacterRecord | undefined;
  create(character: CharacterRecord): void;
  /** Persist position, Ostra, health, and last-seen. Name and colour never
   *  change. */
  savePosition(realmId: string, characterId: string, position: CharacterPosition): void;
  /** How many characters exist in this realm — used to hand out colours. */
  count(realmId: string): number;
  close(): void;
}
