#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Back up the realm database safely while the server is running.
 *
 * `cp` is not safe here. The database runs in WAL mode, so recent writes live
 * in a separate -wal file and a plain copy can catch the pair mid-transaction.
 * `VACUUM INTO` asks SQLite itself for a consistent snapshot, which is correct
 * on a live database and also compacts it on the way out.
 *
 *   npm run backup -- [source] [destination]
 */

const source = resolve(process.argv[2] ?? process.env.DATABASE_FILE ?? "data/ostracon.db");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = resolve(process.argv[3] ?? `backups/ostracon-${stamp}.db`);

mkdirSync(dirname(destination), { recursive: true });

const db = new DatabaseSync(source, { readOnly: true });
try {
  // Single-quoted and escaped: a path with an apostrophe would otherwise end
  // the string early.
  db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  console.log(`Backed up ${source}\n        -> ${destination}`);
} finally {
  db.close();
}
