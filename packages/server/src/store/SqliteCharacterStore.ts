import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  describeItem,
  INVENTORY_SIZE,
  isEquipSlot,
  isGearSkill,
  isOstraId,
  isSpellId,
  PLAYER_MAX_HEALTH,
  sanitiseProficiency,
  slotsFor,
  STARTING_OSTRA,
  wear,
  type Equipment,
  type ItemKey,
  type Proficiency,
} from "@mmo/shared";
import { LEGACY_SLOTS, migrateItem } from "../loot.js";
import type { CharacterPosition, CharacterRecord, CharacterStore } from "./CharacterStore.js";
import type { AccountRecord, AccountStore } from "./AccountStore.js";

/**
 * SQLite-backed persistence, using Node's built-in `node:sqlite` so there is no
 * native module to compile and nothing to install to run the game locally.
 *
 * This is the right store for a single realm on a single process, which is what
 * we have. It is NOT the right store for several processes sharing a realm —
 * when that day comes, implement `CharacterStore` over Postgres and change the
 * one line in `index.ts` that constructs this.
 */
export class SqliteCharacterStore implements CharacterStore, AccountStore {
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password      TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
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

    // Databases from before accounts may still carry an `affinity` column: the
    // innate ceiling that went when proficiency moved to one 0-1000 scale. It
    // has a default, so inserts that no longer mention it still succeed, and
    // nothing reads it. Left in place rather than dropped — a column nobody
    // reads costs nothing, and a migration that deletes data should have a
    // better reason than tidiness.

    if (!columns.has("spells")) {
      this.db.exec("ALTER TABLE characters ADD COLUMN spells TEXT NOT NULL DEFAULT '{}'");
    }

    if (!columns.has("skills")) {
      // A JSON blob rather than a proficiency table. It is small, always read
      // and written whole, and never queried across characters — the three
      // things that make a relational table worth its joins. Revisit if
      // anything ever needs "who is best at Sunder".
      //
      // It replaces `spells`, which held spell proficiency alone; spell ids are
      // skill ids, so the old blob carries straight across. The old values
      // were on a 0-100 scale and are kept as they are rather than multiplied
      // up: under the new rules they are what a few hours of training earns.
      this.db.exec("ALTER TABLE characters ADD COLUMN skills TEXT NOT NULL DEFAULT '{}'");
      this.db.exec("UPDATE characters SET skills = spells");
    }

    if (!columns.has("inventory")) {
      this.db.exec("ALTER TABLE characters ADD COLUMN inventory TEXT NOT NULL DEFAULT '[]'");
    }

    if (!columns.has("equipment")) {
      this.db.exec("ALTER TABLE characters ADD COLUMN equipment TEXT NOT NULL DEFAULT '{}'");
    }

    if (!columns.has("account_id")) {
      // Nullable on purpose: characters made before accounts existed have no
      // owner and cannot be claimed. They stay in the table, listed for nobody,
      // and the server reports how many at boot rather than deleting anyone's
      // save behind their back.
      this.db.exec("ALTER TABLE characters ADD COLUMN account_id TEXT");
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_characters_account ON characters (realm_id, account_id)",
    );
  }

  // --- accounts -------------------------------------------------------------

  findAccountByEmail(email: string): AccountRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE email = ?")
      .get(normaliseEmail(email)) as Record<string, unknown> | undefined;
    return row ? toAccount(row) : undefined;
  }

  findAccountById(id: string): AccountRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toAccount(row) : undefined;
  }

  createAccount(account: AccountRecord): void {
    this.db.prepare(`
      INSERT INTO accounts (id, email, password, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      account.id,
      normaliseEmail(account.email),
      account.password,
      account.createdAt,
      account.lastLoginAt,
    );
  }

  touchLogin(id: string): void {
    this.db.prepare("UPDATE accounts SET last_login_at = ? WHERE id = ?").run(Date.now(), id);
  }

  charactersForAccount(realmId: string, accountId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM characters WHERE realm_id = ? AND account_id = ? ORDER BY created_at")
      .all(realmId, accountId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  countOrphanedCharacters(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM characters WHERE account_id IS NULL")
      .get() as { n: number };
    return row.n;
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
        (id, realm_id, account_id, name, colour, ostra_id, x, y, z, yaw, health,
         skills, inventory, equipment, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      character.id,
      character.realmId,
      character.accountId,
      character.name,
      character.colour,
      character.ostraId,
      character.x,
      character.y,
      character.z,
      character.yaw,
      character.health,
      JSON.stringify(character.skills),
      JSON.stringify(character.inventory),
      JSON.stringify(character.equipment),
      character.createdAt,
      character.lastSeenAt,
    );
  }

  savePosition(realmId: string, characterId: string, position: CharacterPosition): void {
    this.db.prepare(`
      UPDATE characters
         SET ostra_id = ?, x = ?, y = ?, z = ?, yaw = ?, health = ?, skills = ?,
             inventory = ?, equipment = ?, last_seen_at = ?
       WHERE realm_id = ? AND id = ?
    `).run(
      position.ostraId,
      position.x,
      position.y,
      position.z,
      position.yaw,
      position.health,
      JSON.stringify(position.skills),
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
 *  a skill — not their whole session. */
function parseSkills(raw: unknown): Proficiency {
  return sanitiseProficiency(parseJson(raw), (id) => isSpellId(id) || isGearSkill(id));
}

/**
 * Only keys this build can describe survive a load — a base removed from the
 * table should vanish from a bag, not crash the room that opens it. Old fixed
 * item ids are converted to their generated form here, on the way in.
 */
function parseInventory(raw: unknown): ItemKey[] {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((value) => migrateItem(value))
    .filter((key): key is ItemKey => key !== undefined)
    .slice(0, INVENTORY_SIZE);
}

/**
 * Worn gear, re-worn one piece at a time through the same `wear` the room uses,
 * so a save can never describe a body the rules would not allow — a two-handed
 * maul beside a shield, or a ring in the head slot. Whatever does not fit is
 * returned as `spill` for the bag.
 */
function parseEquipment(raw: unknown): { equipment: Equipment; spill: ItemKey[] } {
  const parsed = parseJson(raw);
  let equipment: Equipment = {};
  const spill: ItemKey[] = [];
  if (typeof parsed !== "object" || parsed === null) return { equipment, spill };

  for (const [storedSlot, value] of Object.entries(parsed as Record<string, unknown>)) {
    const slot = isEquipSlot(storedSlot) ? storedSlot : LEGACY_SLOTS[storedSlot];
    const key = migrateItem(value);
    const item = key !== undefined ? describeItem(key) : undefined;
    if (!slot || !item) continue;
    const target = slotsFor(item).includes(slot) ? slot : slotsFor(item)[0]!;
    const result = wear(equipment, item, target);
    if (!result) continue;
    equipment = result.next;
    spill.push(...result.removed);
  }
  return { equipment, spill };
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** One canonical form for an email, so "A@b.com " and "a@b.com" are one
 *  account rather than two. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAccount(row: Record<string, unknown>): AccountRecord {
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    password: String(row["password"]),
    createdAt: Number(row["created_at"]),
    lastLoginAt: Number(row["last_login_at"]),
  };
}

function toRecord(row: Record<string, unknown>): CharacterRecord {
  const ostraId = row["ostra_id"];
  const { equipment, spill } = parseEquipment(row["equipment"]);
  return {
    id: String(row["id"]),
    realmId: String(row["realm_id"]),
    accountId: String(row["account_id"] ?? ""),
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
    skills: parseSkills(row["skills"]),
    // Anything the body could not hold goes back in the bag — even past its
    // size, once: losing a worn item to a rules change would be worse than a
    // briefly overfull pack.
    inventory: [...parseInventory(row["inventory"]), ...spill],
    equipment,
    createdAt: Number(row["created_at"]),
    lastSeenAt: Number(row["last_seen_at"]),
  };
}
