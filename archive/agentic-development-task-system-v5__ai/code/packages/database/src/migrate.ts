import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function defaultMigrationsDir(): string {
  return join(__dirname, '..', 'migrations');
}

export function runMigrations(sqlite: Database.Database, migrationsDir: string = defaultMigrationsDir()): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = sqlite.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  const applied = new Set(appliedRows.map((row) => row.name));

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const applyMigration = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
    });
    applyMigration();
  }
}
