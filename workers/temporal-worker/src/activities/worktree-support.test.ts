import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir } from '@awb/config';
import { createDatabase } from '@awb/database';
import { registerRepository } from '@awb/repository';
import { materializeWorktree, teardownWorktree } from './worktree-support.js';

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-worktree-repo-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('materializeWorktree (Stage 1 real worktree)', () => {
  let dataDir: string;
  let repoDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'awb-worktree-data-'));
    process.env.AWB_DATA_DIR = dataDir;
    initDataDir();
    repoDir = await makeTempRepo();
  });

  afterEach(async () => {
    delete process.env.AWB_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('creates a real git worktree + branch and captures a real base SHA', async () => {
    const { layout } = initDataDir();
    const database = createDatabase(layout.workbenchSqlite);
    const repository = await registerRepository(database.db, { canonicalPath: repoDir });
    database.close();

    const taskId = 'task-worktree-1';
    const lease = await materializeWorktree({ repositoryId: repository.id, taskId });

    expect(lease.state).toBe('ready');
    expect(lease.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(lease.baseSha).not.toBe('0'.repeat(40));
    expect(lease.branchName).toContain(taskId);
    expect(existsSync(lease.worktreePath)).toBe(true);
    expect(existsSync(join(lease.worktreePath, 'README.md'))).toBe(true);

    // The worktree is a real linked checkout on its own branch.
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: lease.worktreePath,
    });
    expect(stdout.trim()).toBe(lease.branchName);

    await teardownWorktree({ repositoryId: repository.id, lease, preserve: false });
    expect(existsSync(lease.worktreePath)).toBe(false);
  });
});
