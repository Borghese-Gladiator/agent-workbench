import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root — three levels up from src/server/db/ */
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
/**
 * Default DB path. Tests can override by setting TASKBOARD_DB_PATH before
 * importing this module (or before the first `getDb()` call).
 */
const DEFAULT_DB_PATH =
  process.env.TASKBOARD_DB_PATH ??
  path.join(PROJECT_ROOT, "data", "db", "taskboard.sqlite");

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

/**
 * Get (or create) a singleton SQLite database connection.
 * Enables WAL journal mode and foreign key enforcement.
 */
export function getDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? DEFAULT_DB_PATH;

  // If we already have a connection to the same path, reuse it
  if (_db && _dbPath === resolvedPath) {
    return _db;
  }

  // If switching paths, close the old connection first
  if (_db) {
    closeDb();
  }

  // Ensure the parent directory exists
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true });

  _db = new Database(resolvedPath);
  _dbPath = resolvedPath;

  // Enable WAL mode for better concurrent read performance
  _db.pragma("journal_mode = WAL");

  // Enforce foreign key constraints
  _db.pragma("foreign_keys = ON");

  return _db;
}

/** Return the resolved path to the SQLite database file. */
export function getDbPath(): string {
  return _dbPath ?? DEFAULT_DB_PATH;
}

/** Close the singleton database connection. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = null;
  }
}
