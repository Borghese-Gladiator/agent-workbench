import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.js';
import { runMigrations } from './migrate.js';

export type DrizzleDb = BetterSQLite3Database<typeof schema>;

export interface WorkbenchDatabase {
  db: DrizzleDb;
  sqlite: Database.Database;
  close: () => void;
}

export function createDatabase(sqlitePath: string): WorkbenchDatabase {
  const sqlite = new Database(sqlitePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  runMigrations(sqlite);

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}

/**
 * Opens a read-only handle to an already-migrated workbench database. The worker's Activities use
 * this so the daemon stays the single application writer (spec §8 / docs/storage.md): a readonly
 * better-sqlite3 connection rejects every INSERT/UPDATE/DELETE/DDL at the SQLite layer, and we skip
 * `runMigrations` (which would need to write). WAL still permits concurrent readers alongside the
 * daemon's writer. The daemon must have created/migrated the file first.
 */
export function createReadOnlyDatabase(sqlitePath: string): WorkbenchDatabase {
  const sqlite = new Database(sqlitePath, { readonly: true });
  sqlite.pragma('foreign_keys = ON');
  // Belt-and-suspenders on top of `readonly: true`: mark the connection query-only so any write is
  // refused even if a code path somehow obtained a mutating statement on this handle (TASK-21).
  sqlite.pragma('query_only = ON');

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
