import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataDirLayout } from '@awb/config';

/**
 * A task's scratch/temporary directory, separate from its git worktree. Used for things like
 * downloaded context, intermediate artifacts, or scratch files that should not be committed and
 * should not pollute the worktree itself. Rooted under the workbench's cache/temporary-context
 * dir (`layout.cacheTemporaryContextDir`) rather than under the worktree, so it survives
 * independently of worktree add/remove and is trivially globbable for cache-wide cleanup.
 */
export function taskTempDirPath(layout: DataDirLayout, taskId: string): string {
  return join(layout.cacheTemporaryContextDir, taskId);
}

export async function createTaskTempDir(layout: DataDirLayout, taskId: string): Promise<string> {
  const dir = taskTempDirPath(layout, taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeTaskTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
