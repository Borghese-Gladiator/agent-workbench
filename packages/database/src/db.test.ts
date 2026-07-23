import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type WorkbenchDatabase } from './connection.js';

describe('createDatabase', () => {
  let tmpDir: string;
  let handle: WorkbenchDatabase;

  afterEach(() => {
    handle?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs migrations, enables WAL and foreign keys', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'awb-db-'));
    handle = createDatabase(join(tmpDir, 'workbench.sqlite'));

    const journalMode = handle.sqlite.pragma('journal_mode', { simple: true });
    expect(journalMode).toBe('wal');

    const foreignKeys = handle.sqlite.pragma('foreign_keys', { simple: true });
    expect(foreignKeys).toBe(1);

    const migrations = handle.sqlite.prepare('SELECT name FROM _migrations').all() as {
      name: string;
    }[];
    expect(migrations.map((row) => row.name)).toContain('0001_init.sql');
  });

  it('is idempotent across repeated opens', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'awb-db-'));
    const dbPath = join(tmpDir, 'workbench.sqlite');

    handle = createDatabase(dbPath);
    handle.close();

    handle = createDatabase(dbPath);
    const migrations = handle.sqlite.prepare('SELECT name FROM _migrations').all() as {
      name: string;
    }[];
    // Every migration is applied exactly once across repeated opens (idempotent); no re-application.
    const names = migrations.map((row) => row.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('0001_init.sql');
    expect(names).toContain('0002_observability.sql');
  });
});
