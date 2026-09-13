import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canWear,
  DEFAULT_CLASS,
  describeItem,
  EQUIP_SLOTS,
  getOstra,
  INVENTORY_SIZE,
  isClassId,
  isEquipSlot,
  isOstraId,
  PLAYER_MAX_HEALTH,
  sanitiseGoods,
  sanitiseProgress,
  sanitiseQuestLog,
  sanitiseWaystones,
  slotsFor,
  STARTING_OSTRA,
  wear,
  type Equipment,
  type ItemKey,
  type Wearer,
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

    if (!columns.has("quests")) {
      // A JSON blob, like skills, for the same reasons.
      this.db.exec("ALTER TABLE characters ADD COLUMN quests TEXT NOT NULL DEFAULT '{}'");
    }

    if (!columns.has("gold")) {
      this.db.exec("ALTER TABLE characters ADD COLUMN gold INTEGER NOT NULL DEFAULT 0");
    }

    if (!columns.has("level")) {
      // Character levels replaced proficiency. Everyone who had trained under
      // the old rules starts again at level 1 with their gear kept — gear
      // above their new level waits in the bag (see `parseEquipment`). The
      // `skills` column above is left where it is, unread, for the same reason
      // `affinity` was: a migration that deletes data wants a better reason
      // than tidiness.
      this.db.exec("ALTER TABLE characters ADD COLUMN level INTEGER NOT NULL DEFAULT 1");
      this.db.exec("ALTER TABLE characters ADD COLUMN xp INTEGER NOT NULL DEFAULT 0");
      // ...and back in Daso, where level 1 lives now. Left where they were,
      // they would wake at level 1 among the Gate Circle's level-7 Risen.
      const spawn = getOstra(STARTING_OSTRA).spawn;
      this.db.prepare("UPDATE characters SET ostra_id = ?, x = ?, z = ?")
        .run(STARTING_OSTRA, spawn.x, spawn.z);
    }

    if (!columns.has("class_id")) {
      // Everyone made before classes was a Warrior all along.
      this.db.exec(`ALTER TABLE characters ADD COLUMN class_id TEXT NOT NULL DEFAULT '${DEFAULT_CLASS}'`);
    }

    if (!columns.has("waystones")) {
      // A JSON array of `waystoneKey` keys, for the same reasons as quests:
      // small, always read and written whole, never queried across
      // characters. Everyone who played before fast travel starts with none
      // woken — they are a few strides off the roads they already walk.
      this.db.exec("ALTER TABLE characters ADD COLUMN waystones TEXT NOT NULL DEFAULT '[]'");
    }

    if (!columns.has("goods")) {
      // The satchel, as a JSON object of counts by good id — a blob for the
      // same reasons as quests and waystones. Everyone starts with it empty.
      this.db.exec("ALTER TABLE characters ADD COLUMN goods TEXT NOT NULL DEFAULT '{}'");
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
        (id, realm_id, account_id, name, colour, class_id, ostra_id, x, y, z, yaw, health,
         level, xp, inventory, equipment, quests, gold, waystones, goods, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      character.id,
      character.realmId,
      character.accountId,
      character.name,
      character.colour,
      character.classId,
      character.ostraId,
      character.x,
      character.y,
      character.z,
      character.yaw,
      character.health,
      character.level,
      character.xp,
      JSON.stringify(character.inventory),
      JSON.stringify(character.equipment),
      JSON.stringify(character.quests),
      Math.max(0, Math.floor(character.gold)),
      JSON.stringify(character.waystones),
      JSON.stringify(character.goods),
      character.createdAt,
      character.lastSeenAt,
    );
  }

  savePosition(realmId: string, characterId: string, position: CharacterPosition): void {
    this.db.prepare(`
      UPDATE characters
         SET ostra_id = ?, x = ?, y = ?, z = ?, yaw = ?, health = ?, level = ?, xp = ?,
             inventory = ?, equipment = ?, quests = ?, gold = ?, waystones = ?, goods = ?, last_seen_at = ?
       WHERE realm_id = ? AND id = ?
    `).run(
      position.ostraId,
      position.x,
      position.y,
      position.z,
      position.yaw,
      position.health,
      position.level,
      position.xp,
      JSON.stringify(position.inventory),
      JSON.stringify(position.equipment),
      JSON.stringify(position.quests),
      Math.max(0, Math.floor(position.gold)),
      JSON.stringify(position.waystones),
      JSON.stringify(position.goods),
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

/**
 * A bag may be over its size by up to a full set of gear. Worn items that no
 * longer fit the rules go into the bag rather than vanishing (see
 * `parseEquipment`), even past its size — and that overflow has to survive the
 * next load too. Cutting back to INVENTORY_SIZE here used to throw it away the
 * second time the character logged in. The limit is only a guard against a
 * hand-edited save with ten thousand items in it.
 */
const OVERFULL_LIMIT = INVENTORY_SIZE + EQUIP_SLOTS.length;

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
    .slice(0, OVERFULL_LIMIT);
}

/**
 * Worn gear, re-worn one piece at a time through the same `wear` the room uses,
 * so a save can never describe a body the rules would not allow — a two-handed
 * maul beside a shield, a ring in the head slot, a helm above the wearer's
 * level (which is every character from before levels, the first time they
 * load), or a robe their class does not wear (everyone from before classes).
 * Whatever does not fit is returned as `spill` for the bag.
 */
function parseEquipment(raw: unknown, wearer: Wearer): { equipment: Equipment; spill: ItemKey[] } {
  const parsed = parseJson(raw);
  let equipment: Equipment = {};
  const spill: ItemKey[] = [];
  if (typeof parsed !== "object" || parsed === null) return { equipment, spill };

  for (const [storedSlot, value] of Object.entries(parsed as Record<string, unknown>)) {
    const slot = isEquipSlot(storedSlot) ? storedSlot : LEGACY_SLOTS[storedSlot];
    const key = migrateItem(value);
    const item = key !== undefined ? describeItem(key) : undefined;
    if (!slot || !item) continue;
    if (!canWear(item, wearer)) {
      spill.push(item.key);
      continue;
    }
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
  // A class a later build removed falls back rather than locking anyone out.
  const classId = isClassId(row["class_id"]) ? row["class_id"] : DEFAULT_CLASS;
  const progress = sanitiseProgress(Number(row["level"] ?? 1), Number(row["xp"] ?? 0));
  const { equipment, spill } = parseEquipment(row["equipment"], { classId, level: progress.level });
  return {
    id: String(row["id"]),
    realmId: String(row["realm_id"]),
    accountId: String(row["account_id"] ?? ""),
    name: String(row["name"]),
    colour: Number(row["colour"]),
    classId,
    // A row could name an Ostra a later build removed. Falling back to the
    // starting Ostra strands nobody in a room that no longer exists.
    ostraId: isOstraId(ostraId) ? ostraId : STARTING_OSTRA,
    x: Number(row["x"]),
    y: Number(row["y"]),
    z: Number(row["z"]),
    yaw: Number(row["yaw"]),
    // A row written before these columns existed reads as null.
    health: Number(row["health"] ?? PLAYER_MAX_HEALTH),
    level: progress.level,
    xp: progress.xp,
    // Anything the body could not hold goes back in the bag — even past its
    // size: losing a worn item to a rules change would be worse than an
    // overfull pack, which only stops you picking things up until you have
    // made room. Levels did exactly this to every save made before them.
    inventory: [...parseInventory(row["inventory"]), ...spill],
    equipment,
    quests: sanitiseQuestLog(parseJson(row["quests"])),
    gold: Math.max(0, Math.floor(Number(row["gold"] ?? 0)) || 0),
    waystones: sanitiseWaystones(parseJson(row["waystones"])),
    goods: sanitiseGoods(parseJson(row["goods"])),
    createdAt: Number(row["created_at"]),
    lastSeenAt: Number(row["last_seen_at"]),
  };
}
