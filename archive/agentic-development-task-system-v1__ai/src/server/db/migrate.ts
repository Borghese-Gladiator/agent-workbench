import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getDb } from "./connection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCHEMA_PATH = path.join(__dirname, "schema.sql");
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/** Tables that the base schema creates — used for idempotency check. */
const EXPECTED_TABLES = [
  "initiatives",
  "epics",
  "agents",
  "work_items",
  "work_item_tags",
  "reviews",
  "artifacts",
  "activity_events",
  "terminal_sessions",
  "task_session_links",
  "ingest_files",
] as const;

/**
 * Check whether the base schema has already been applied.
 */
function tablesExist(db: Database.Database): boolean {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string }[];

  const existing = new Set(rows.map((r) => r.name));
  return EXPECTED_TABLES.every((t) => existing.has(t));
}

/**
 * Ensure the schema_migrations tracking table exists.
 */
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

/**
 * Get list of already-applied migration names.
 */
function getAppliedMigrations(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM schema_migrations ORDER BY name`)
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Apply incremental migrations from the migrations/ directory.
 */
function applyIncrementalMigrations(db: Database.Database): void {
  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  ensureMigrationsTable(db);
  const applied = getAppliedMigrations(db);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[migrate] Applying migration: ${file}`);
    const rawSql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");

    // Strip line comments before splitting on semicolons
    const sql = rawSql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const migrate = db.transaction(() => {
      for (const stmt of statements) {
        db.exec(stmt + ";");
      }
      db.prepare(
        `INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`
      ).run(file, new Date().toISOString());
    });

    migrate();
    console.log(`[migrate] Applied: ${file}`);
  }
}

/**
 * Run all migrations. Idempotent.
 * 1. Apply base schema.sql if tables don't exist
 * 2. Apply incremental migrations from migrations/
 */
export function runMigrations(db?: Database.Database): void {
  const database = db ?? getDb();

  if (!tablesExist(database)) {
    console.log("[migrate] Applying base schema from schema.sql ...");

    const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf-8");
    const statements = schemaSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const migrate = database.transaction(() => {
      for (const stmt of statements) {
        database.exec(stmt + ";");
      }
    });

    migrate();
    console.log(
      `[migrate] Base schema applied — ${statements.length} statements executed.`
    );
  } else {
    console.log("[migrate] Base tables already exist — skipping base schema.");
  }

  // Apply incremental migrations
  applyIncrementalMigrations(database);
}
