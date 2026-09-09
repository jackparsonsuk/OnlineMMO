import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EQUIP_SLOTS,
  isItemId,
  ITEMS,
  isOstraId,
  MIN_AFFINITY,
  PLAYER_MAX_HEALTH,
  STARTING_OSTRA,
  type Equipment,
  type SpellProficiency,
} from "@mmo/shared";
import type { CharacterPosition, CharacterRecord, CharacterStore } from "./CharacterStore.js";

/**
 * SQLite-backed persistence, using Node's built-in `node:sqlite` so there is no
 * native module to compile and nothing to install to run the game locally.
 *
 * This is the right store for a single realm on a single process, which is what
 * we have. It is NOT the right store for several processes sharing a realm —
 * when that day comes, implement `CharacterStore` over Postgres and change the
 * one line in `index.ts` that constructs this.
 */
export class SqliteCharacterStore implements CharacterStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);

    // WAL lets reads proceed during writes, which matters once several rooms
    // are saving players at the same time.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS characters (
        id          TEXT NOT NULL,
        realm_id    TEXT NOT NULL,
        name        TEXT NOT NULL,
        colour      INTEGER NOT NULL,
        ostra_id    TEXT NOT NULL,
        x           REAL NOT NULL,
        y           REAL NOT NULL,
        z           REAL NOT NULL,
        yaw         REAL NOT NULL,
        created_at  INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (realm_id, id)
      )
    `);

    this.migrate();
  }

  /**
   * Add columns that later versions introduced.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
   * so a new field is invisible to anyone with an existing save file. Adding
   * them here keeps a development database working across a schema change
   * instead of silently reading undefined. Each step must be idempotent.
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(characters)").all() as { name: string }[])
        .map((column) => column.name),
    );

    if (!columns.has("health")) {
      this.db.exec(
        `ALTER TABLE characters ADD COLUMN health INTEGER NOT NULL DEFAULT ${PLAYER_MAX_HEALTH}`,
      );
    }

    if (!columns.has("affinity")) {
      this.db.exec(
        `ALTER TABLE characters ADD COLUMN affinity INTEGER NOT NULL DEFAULT ${MIN_AFFINITY}`,
      );
    }

    if (!columns.has("spells")) {
      // A JSON blob rather than a spell_proficiency table. It is small, always
      // read and written whole, and never queried across characters — the
      // three things that make a relational table worth its joins. Revisit if
      // anything ever needs "who is best at Sunder".
      this.db.exec("ALTER TABLE characters ADD COLUMN spells TEXT NOT NULL DEFAULT '{}'");
    }

    if (!columns.has("inventory")) {
      this.db.exec("ALTER TABLE characters ADD COLUMN inventory TEXT NOT NULL DEFAULT '[]'");
    }

    if (!columns.has("equipment")) {
      this.db.exec("ALTER TABLE characters ADD COLUMN equipment TEXT NOT NULL DEFAULT '{}'");
    }
  }

  find(realmId: string, characterId: string): CharacterRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM characters WHERE realm_id = ? AND id = ?")
      .get(realmId, characterId) as Record<string, unknown> | undefined;
    return row ? toRecord(row) : undefined;
  }

  create(character: CharacterRecord): void {
    this.db.prepare(`
      INSERT INTO characters
        (id, realm_id, name, colour, ostra_id, x, y, z, yaw, health, affinity, spells,
         inventory, equipment, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      character.id,
      character.realmId,
      character.name,
      character.colour,
      character.ostraId,
      character.x,
      character.y,
      character.z,
      character.yaw,
      character.health,
      character.affinity,
      JSON.stringify(character.spells),
      JSON.stringify(character.inventory),
      JSON.stringify(character.equipment),
      character.createdAt,
      character.lastSeenAt,
    );
  }

  savePosition(realmId: string, characterId: string, position: CharacterPosition): void {
    this.db.prepare(`
      UPDATE characters
         SET ostra_id = ?, x = ?, y = ?, z = ?, yaw = ?, health = ?, spells = ?,
             inventory = ?, equipment = ?, last_seen_at = ?
       WHERE realm_id = ? AND id = ?
    `).run(
      position.ostraId,
      position.x,
      position.y,
      position.z,
      position.yaw,
      position.health,
      JSON.stringify(position.spells),
      JSON.stringify(position.inventory),
      JSON.stringify(position.equipment),
      Date.now(),
      realmId,
      characterId,
    );
  }

  count(realmId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM characters WHERE realm_id = ?")
      .get(realmId) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

/** Hand-editing the database, or a half-written row, should cost a character
 *  their training — not their whole session. */
function parseSpells(raw: unknown): SpellProficiency {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    }
    return result as SpellProficiency;
  } catch {
    return {};
  }
}

/** Only ids this build still knows survive a load — an item removed from the
 *  table should vanish from a bag, not crash the room that opens it. */
function parseInventory(raw: unknown): string[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id): id is string => typeof id === "string" && isItemId(id));
}

function parseEquipment(raw: unknown): Equipment {
  const parsed = parseJson(raw);
  if (typeof parsed !== "object" || parsed === null) return {};
  const result: Equipment = {};
  for (const slot of EQUIP_SLOTS) {
    const id = (parsed as Record<string, unknown>)[slot];
    // The slot on the item must still match the slot it is stored under, or a
    // renamed item could end up worn somewhere it was never meant to go.
    if (typeof id === "string" && isItemId(id) && ITEMS[id]?.slot === slot) {
      result[slot] = id;
    }
  }
  return result;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toRecord(row: Record<string, unknown>): CharacterRecord {
  const ostraId = row["ostra_id"];
  return {
    id: String(row["id"]),
    realmId: String(row["realm_id"]),
    name: String(row["name"]),
    colour: Number(row["colour"]),
    // A row could name an Ostra a later build removed. Falling back to the
    // starting Ostra strands nobody in a room that no longer exists.
    ostraId: isOstraId(ostraId) ? ostraId : STARTING_OSTRA,
    x: Number(row["x"]),
    y: Number(row["y"]),
    z: Number(row["z"]),
    yaw: Number(row["yaw"]),
    // A row written before these columns existed reads as null.
    health: Number(row["health"] ?? PLAYER_MAX_HEALTH),
    affinity: Number(row["affinity"] ?? MIN_AFFINITY),
    spells: parseSpells(row["spells"]),
    inventory: parseInventory(row["inventory"]),
    equipment: parseEquipment(row["equipment"]),
    createdAt: Number(row["created_at"]),
    lastSeenAt: Number(row["last_seen_at"]),
  };
}
