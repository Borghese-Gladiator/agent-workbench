import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLayout } from '@awb/config';
import { runGit } from '@awb/repository';
import { createWorktree, removeWorktree } from './worktree.js';
import { PortAllocator } from './ports.js';
import { commitAll, makeTempRepo, writeFileEnsuringDir } from './test-helpers.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('createWorktree / removeWorktree', () => {
  let repoDir: string;
  let dataDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo();
    await writeFileEnsuringDir(repoDir, 'README.md', '# test');
    await commitAll(repoDir, 'init');
    dataDir = await mkdtemp(join(tmpdir(), 'awb-workspace-data-'));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('materializes a real linked worktree on a new branch, ready and with files present', async () => {
    const layout = resolveLayout(dataDir);
    const { lease, taskTempDir } = await createWorktree({
      layout,
      repositoryId: 'repo-1',
      repositoryPath: repoDir,
      taskId: 'task-1',
      baseRef: 'main',
      slugSource: 'Add login flow',
      executionProfile: 'native-trusted',
      portNames: ['dev'],
    });

    expect(lease.state).toBe('ready');
    expect(lease.branchName).toBe('awb/add-login-flow-task1');
    expect(lease.worktreePath).toBe(join(layout.worktreesDir, 'repo-1', 'add-login-flow-task1'));
    expect(lease.allocatedPorts.dev).toBeGreaterThan(0);
    expect(lease.baseSha).toMatch(/^[0-9a-f]{40}$/);

    expect(await pathExists(join(lease.worktreePath, 'README.md'))).toBe(true);
    expect(await pathExists(taskTempDir)).toBe(true);

    const { stdout } = await runGit(repoDir, ['worktree', 'list']);
    expect(stdout).toContain(lease.worktreePath);

    const { stdout: branchStdout } = await runGit(lease.worktreePath, ['branch', '--show-current']);
    expect(branchStdout).toBe(lease.branchName);
  });

  it('removes the worktree from disk and from git worktree list when preserve is false', async () => {
    const layout = resolveLayout(dataDir);
    const portAllocator = new PortAllocator();
    const { lease, taskTempDir } = await createWorktree({
      layout,
      repositoryId: 'repo-1',
      repositoryPath: repoDir,
      taskId: 'task-2',
      baseRef: 'main',
      slugSource: 'remove me',
      executionProfile: 'native-trusted',
      portAllocator,
    });

    const removed = await removeWorktree(repoDir, lease, { preserve: false, portAllocator, taskTempDir });

    expect(removed.state).toBe('removed');
    expect(await pathExists(lease.worktreePath)).toBe(false);
    expect(await pathExists(taskTempDir)).toBe(false);

    const { stdout } = await runGit(repoDir, ['worktree', 'list']);
    expect(stdout).not.toContain(lease.worktreePath);
  });

  it('preserves the worktree and temp dir on disk when preserve is true', async () => {
    const layout = resolveLayout(dataDir);
    const portAllocator = new PortAllocator();
    const { lease, taskTempDir } = await createWorktree({
      layout,
      repositoryId: 'repo-1',
      repositoryPath: repoDir,
      taskId: 'task-3',
      baseRef: 'main',
      slugSource: 'preserve me',
      executionProfile: 'native-trusted',
      portAllocator,
    });

    const preserved = await removeWorktree(repoDir, lease, { preserve: true, portAllocator, taskTempDir });

    expect(preserved.state).toBe('preserved');
    expect(await pathExists(lease.worktreePath)).toBe(true);
    expect(await pathExists(taskTempDir)).toBe(true);

    const { stdout } = await runGit(repoDir, ['worktree', 'list']);
    expect(stdout).toContain(lease.worktreePath);
  });

  it('releases allocated ports on removal even when preserving the worktree', async () => {
    const layout = resolveLayout(dataDir);
    const portAllocator = new PortAllocator();
    const { lease, taskTempDir } = await createWorktree({
      layout,
      repositoryId: 'repo-1',
      repositoryPath: repoDir,
      taskId: 'task-4',
      baseRef: 'main',
      slugSource: 'ports',
      executionProfile: 'native-trusted',
      portNames: ['dev', 'debug'],
      portAllocator,
    });

    for (const port of Object.values(lease.allocatedPorts)) {
      expect(portAllocator.isAllocated(port)).toBe(true);
    }

    await removeWorktree(repoDir, lease, { preserve: true, portAllocator, taskTempDir });

    for (const port of Object.values(lease.allocatedPorts)) {
      expect(portAllocator.isAllocated(port)).toBe(false);
    }
  });
});
