import type BetterSqlite3 from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.js';

/**
 * A minimal synchronous migration runner over better-sqlite3.
 *
 * Why not Kysely's built-in Migrator? That API is async, and the Store is
 * constructed synchronously in every call site (the seed script and tests
 * included). Since better-sqlite3 is a synchronous driver we run the ordered
 * migration list ourselves: pending migrations (by name, in array order) each
 * run in a transaction and are recorded in the `kysely_migration` ledger. This
 * is the same concept as the Kysely migrator — ordered, named, version-tracked —
 * and the migration modules would port to the async Migrator unchanged.
 */
const LEDGER = 'kysely_migration';

function ensureLedger(db: BetterSqlite3.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       name TEXT PRIMARY KEY,
       executed_at TEXT NOT NULL
     )`,
  );
}

function appliedNames(db: BetterSqlite3.Database): Set<string> {
  const rows = db.prepare(`SELECT name FROM ${LEDGER}`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Runs all pending migrations to bring `db` up to date. Idempotent: already
 * recorded migrations are skipped. Returns the names that were applied this call
 * (empty when the DB was already current).
 */
export function migrateToLatest(
  db: BetterSqlite3.Database,
  migrations: Migration[] = MIGRATIONS,
): string[] {
  ensureLedger(db);
  const done = appliedNames(db);
  const record = db.prepare(`INSERT INTO ${LEDGER} (name, executed_at) VALUES (?, ?)`);
  const applied: string[] = [];

  for (const m of migrations) {
    if (done.has(m.name)) continue;
    const run = db.transaction(() => {
      m.up(db);
      record.run(m.name, new Date().toISOString());
    });
    run();
    applied.push(m.name);
  }
  return applied;
}
