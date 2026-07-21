import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type WorkbenchDatabase } from '@awb/database';
import { registerRepository, refreshRepositorySnapshot, getRepositoryCommands } from './persist.js';

const execFileAsync = promisify(execFile);

async function makeRepoWithTestScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-cmd-repo-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'vitest run', build: 'vite build' } }),
  );
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('getRepositoryCommands (Fix 2: rehydrate discovered commands)', () => {
  let db: WorkbenchDatabase;
  let dbPath: string;
  let repoDir: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awb-cmd-db-'));
    dbPath = join(dir, 'workbench.sqlite');
    db = createDatabase(dbPath);
    repoDir = await makeRepoWithTestScript();
  });

  afterEach(async () => {
    db.close();
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns [] before any snapshot is recorded', async () => {
    const repo = await registerRepository(db.db, { canonicalPath: repoDir });
    expect(await getRepositoryCommands(db.db, repo.id)).toEqual([]);
  });

  it('rehydrates the discovered unit-test and build commands after a refresh', async () => {
    const repo = await registerRepository(db.db, { canonicalPath: repoDir });
    await refreshRepositorySnapshot(db.db, repo);

    const commands = await getRepositoryCommands(db.db, repo.id);
    const purposes = commands.map((c) => c.purpose);
    expect(purposes).toContain('unit-test');
    expect(purposes).toContain('build');

    const testCmd = commands.find((c) => c.purpose === 'unit-test');
    expect(testCmd?.command).toContain('test');
    expect(testCmd?.repositoryId).toBe(repo.id);
  });
});
