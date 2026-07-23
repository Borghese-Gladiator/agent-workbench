import { createReadOnlyDatabase } from '@awb/database';
import { initDataDir } from '@awb/config';
import { getRepository } from '@awb/repository';
import { createWorktree, removeWorktree } from '@awb/workspace';
import type { WorkspaceLease } from '@awb/domain';

/**
 * Materializes a real git worktree + task branch off the registered repository's default branch,
 * used by `runPrepare` on the claude runtime (the mock runtime keeps its synthetic placeholder).
 * Opens a short-lived workbench DB handle to resolve the repository's canonical path from its id —
 * Activities may do I/O, so this stays out of Workflow code.
 */
export async function materializeWorktree(input: {
  repositoryId: string;
  taskId: string;
  /** Human-readable source (the task prompt/objective) for the branch slug — NOT the taskId, which
   *  would make the branch `awb/<uuid>-<uuid>`. Falls back to the taskId when absent. */
  slugSource?: string;
}): Promise<WorkspaceLease> {
  const { layout } = initDataDir();
  const database = createReadOnlyDatabase(layout.workbenchSqlite);
  try {
    const repository = await getRepository(database.db, input.repositoryId);
    if (!repository) {
      throw new Error(`materializeWorktree: no registered repository with id ${input.repositoryId}`);
    }
    const { lease } = await createWorktree({
      layout,
      repositoryId: input.repositoryId,
      repositoryPath: repository.canonicalPath,
      taskId: input.taskId,
      baseRef: repository.defaultBranch,
      slugSource: input.slugSource ?? input.taskId,
      executionProfile: 'native-trusted',
    });
    return lease;
  } finally {
    database.close();
  }
}

/** Tears down a worktree created by materializeWorktree, honoring the cancel-preservation policy. */
export async function teardownWorktree(input: {
  repositoryId: string;
  lease: WorkspaceLease;
  preserve: boolean;
}): Promise<void> {
  const { layout } = initDataDir();
  const database = createReadOnlyDatabase(layout.workbenchSqlite);
  try {
    const repository = await getRepository(database.db, input.repositoryId);
    if (!repository) return;
    await removeWorktree(repository.canonicalPath, input.lease, { preserve: input.preserve });
  } finally {
    database.close();
  }
}
