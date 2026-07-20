import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { DataDirLayout } from '@awb/config';
import { worktreeDir } from '@awb/config';
import { runGit } from '@awb/repository';
import type { ExecutionProfile, WorkspaceLease } from '@awb/domain';
import { resolveBaseSha } from './base-sha.js';
import { resolveTaskBranchName } from './branch.js';
import { PortAllocator } from './ports.js';
import { createTaskTempDir, removeTaskTempDir } from './task-dir.js';

export interface CreateWorktreeOptions {
  layout: DataDirLayout;
  repositoryId: string;
  repositoryPath: string;
  taskId: string;
  baseRef: string;
  slugSource: string;
  executionProfile: ExecutionProfile;
  portNames?: string[];
  portAllocator?: PortAllocator;
}

export interface WorktreeHandle {
  lease: WorkspaceLease;
  taskTempDir: string;
}

/**
 * Resolves the base ref to an immutable SHA, creates a unique `awb/<taskId>-<slug>` branch,
 * materializes a linked git worktree rooted at `worktreeDir()`, allocates any requested task
 * ports, and creates a task scratch directory. Returns the resulting `WorkspaceLease` (in the
 * `ready` state) plus the task temp dir path. Persisting the lease is the caller's job.
 */
export async function createWorktree(options: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const {
    layout,
    repositoryId,
    repositoryPath,
    taskId,
    baseRef,
    slugSource,
    executionProfile,
    portNames = [],
  } = options;
  const portAllocator = options.portAllocator ?? new PortAllocator();

  let lease: WorkspaceLease = {
    id: randomUUID(),
    repositoryId,
    taskId,
    baseRef,
    baseSha: '',
    branchName: resolveTaskBranchName(taskId, slugSource),
    worktreePath: worktreeDir(layout, repositoryId, taskId),
    executionProfile,
    allocatedPorts: {},
    state: 'requested',
    createdAt: new Date().toISOString(),
  };

  lease = { ...lease, state: 'materializing' };

  const baseSha = await resolveBaseSha(repositoryPath, baseRef);
  await runGit(repositoryPath, ['worktree', 'add', lease.worktreePath, '-b', lease.branchName, baseSha]);

  const allocatedPorts: Record<string, number> = {};
  for (const name of portNames) {
    allocatedPorts[name] = await portAllocator.allocatePort();
  }

  const taskTempDir = await createTaskTempDir(layout, taskId);

  lease = {
    ...lease,
    baseSha,
    allocatedPorts,
    state: 'ready',
  };

  return { lease, taskTempDir };
}

export interface RemoveWorktreeOptions {
  preserve: boolean;
  portAllocator?: PortAllocator;
  taskTempDir?: string;
}

/**
 * Removes a worktree's git worktree entry, releases its allocated ports, and deletes its task
 * temp directory — unless `preserve` is set, in which case the worktree and temp dir are left
 * on disk for inspection (the failed-worktree-preservation policy from the product spec) and
 * only the in-process port allocations are released, since the ports themselves are no longer
 * meaningfully "in use" once the caller stops running anything in the preserved worktree.
 */
export async function removeWorktree(
  repositoryPath: string,
  lease: WorkspaceLease,
  options: RemoveWorktreeOptions,
): Promise<WorkspaceLease> {
  const { preserve, portAllocator, taskTempDir } = options;

  for (const port of Object.values(lease.allocatedPorts)) {
    portAllocator?.releasePort(port);
  }

  if (preserve) {
    return { ...lease, state: 'preserved' };
  }

  await runGit(repositoryPath, ['worktree', 'remove', '--force', lease.worktreePath]);
  if (taskTempDir) {
    await removeTaskTempDir(taskTempDir);
  }
  // Fallback in case `git worktree remove` left residue (e.g. dirty ignored files); this mirrors
  // the "removed" state meaning "gone from disk", not merely "unregistered from git".
  await rm(lease.worktreePath, { recursive: true, force: true });

  return { ...lease, state: 'removed' };
}
