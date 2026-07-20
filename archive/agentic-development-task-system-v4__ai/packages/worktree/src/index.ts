/**
 * Local git worktree support for the Agent Workbench.
 *
 * The provider creates exactly one branch and one git worktree per task and can
 * report git status, show a diff, and remove the worktree again. It NEVER
 * mutates the project's main checkout — every operation targets the per-task
 * worktree directory under `data/worktrees/`.
 */

export * from './naming.js';

/** A single changed file in a worktree, as reported by `git status`. */
export interface ChangedFile {
  /** Path relative to the worktree root. */
  path: string;
  /** Two-letter porcelain status code (e.g. ' M', '??', 'A '). */
  status: string;
}

/** Live git status of a worktree. */
export interface GitStatus {
  branch: string;
  baseBranch: string | null;
  ahead: number;
  behind: number;
  changedFiles: ChangedFile[];
  clean: boolean;
}

export interface CreateWorktreeRequest {
  taskId: string;
  repoPath: string;
  defaultBranch: string;
  /** Desired branch name for this task's work. */
  branch: string;
  /** Absolute path the worktree should live at. */
  worktreePath: string;
}

export interface WorktreeHandle {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  status: 'stub' | 'created' | 'removed';
}

export interface WorktreeProvider {
  create(req: CreateWorktreeRequest): Promise<WorktreeHandle>;
  status(worktreePath: string): Promise<GitStatus>;
  diff(worktreePath: string): Promise<string>;
  remove(worktreePath: string, opts?: { force?: boolean; branch?: string }): Promise<void>;
}

export { GitWorktreeProvider } from './git-worktree.js';

/** No-op provider: returns deterministic stub values, no git/FS side effects. */
export class StubWorktreeProvider implements WorktreeProvider {
  async create(req: CreateWorktreeRequest): Promise<WorktreeHandle> {
    return {
      worktreePath: req.worktreePath,
      branch: req.branch,
      baseBranch: req.defaultBranch,
      status: 'stub',
    };
  }

  async status(_worktreePath: string): Promise<GitStatus> {
    return { branch: '', baseBranch: null, ahead: 0, behind: 0, changedFiles: [], clean: true };
  }

  async diff(_worktreePath: string): Promise<string> {
    return '';
  }

  async remove(_worktreePath: string): Promise<void> {
    // Intentionally empty — nothing was created on disk.
  }
}
