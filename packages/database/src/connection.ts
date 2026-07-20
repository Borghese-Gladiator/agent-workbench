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
