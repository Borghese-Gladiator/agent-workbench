import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type WorkbenchDatabase } from '@awb/database';
import {
  registerRepository,
  refreshRepositorySnapshot,
  getRepositoryCommands,
  persistValidatedStartCommand,
} from './persist.js';

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-start-repo-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { build: 'vite build' } }));
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('persistValidatedStartCommand', () => {
  let db: WorkbenchDatabase;
  let repoDir: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awb-start-db-'));
    db = createDatabase(join(dir, 'workbench.sqlite'));
    repoDir = await makeRepo();
  });

  afterEach(async () => {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it('writes a validated inferred start row that a later read finds', async () => {
    const repo = await registerRepository(db.db, { canonicalPath: repoDir });
    await refreshRepositorySnapshot(db.db, repo);

    await persistValidatedStartCommand(db.db, repo.id, {
      command: 'npm run dev',
      cwd: '/w/tree',
      validatedAtSha: 'sha-1',
    });

    const startRows = (await getRepositoryCommands(db.db, repo.id)).filter((c) => c.purpose === 'start');
    expect(startRows).toHaveLength(1);
    expect(startRows[0]).toMatchObject({
      command: 'npm run dev',
      cwd: '/w/tree',
      source: 'inferred',
      status: 'validated',
      validatedAtSha: 'sha-1',
      lastExitCode: 0,
    });
  });

  it('replaces a prior start row rather than accumulating duplicates', async () => {
    const repo = await registerRepository(db.db, { canonicalPath: repoDir });
    await refreshRepositorySnapshot(db.db, repo);

    await persistValidatedStartCommand(db.db, repo.id, { command: 'old', cwd: '/w', validatedAtSha: 'sha-1' });
    await persistValidatedStartCommand(db.db, repo.id, { command: 'new', cwd: '/w', validatedAtSha: 'sha-2' });

    const startRows = (await getRepositoryCommands(db.db, repo.id)).filter((c) => c.purpose === 'start');
    expect(startRows).toHaveLength(1);
    expect(startRows[0]?.command).toBe('new');
    expect(startRows[0]?.validatedAtSha).toBe('sha-2');
  });

  it('leaves other-purpose commands intact', async () => {
    const repo = await registerRepository(db.db, { canonicalPath: repoDir });
    await refreshRepositorySnapshot(db.db, repo);
    const buildBefore = (await getRepositoryCommands(db.db, repo.id)).filter((c) => c.purpose === 'build');
    expect(buildBefore.length).toBeGreaterThan(0);

    await persistValidatedStartCommand(db.db, repo.id, { command: 'npm run dev', cwd: '/w' });

    const buildAfter = (await getRepositoryCommands(db.db, repo.id)).filter((c) => c.purpose === 'build');
    expect(buildAfter).toEqual(buildBefore);
  });
});
