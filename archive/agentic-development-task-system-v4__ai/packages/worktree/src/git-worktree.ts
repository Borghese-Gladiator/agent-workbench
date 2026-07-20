/**
 * Real `git worktree` provider. Each task gets one branch + one worktree.
 *
 * Hard rule: this never touches the project's main checkout. `create` only adds
 * a new worktree at a fresh path, and `remove` refuses to operate on the repo's
 * own working directory.
 *
 * git is invoked synchronously: the daemon is a single-user local process (it
 * already does synchronous SQLite IO), and synchronous spawning reliably honors
 * the per-call `cwd`, sidestepping event-loop/cwd interactions seen with the
 * async spawner under some test runners.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  ChangedFile,
  CreateWorktreeRequest,
  GitStatus,
  WorktreeHandle,
  WorktreeProvider,
} from './index.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export class GitWorktreeProvider implements WorktreeProvider {
  /**
   * Per-repo serialization of `create`. Concurrent `git worktree add` on the same
   * repo race on `.git/worktrees` metadata + the index lock, which can corrupt the
   * repo — so the multi-task queue (which may start several same-project tasks at
   * once) must not let two creations on one repo overlap. The lock is keyed by the
   * resolved repo path and held ONLY across `create`; everything after (the task's
   * own work in its isolated worktree) stays fully parallel. Creations on
   * *different* repos never contend. Today `git()` is synchronous so the event
   * loop already serializes a single provider's calls; this makes the guarantee
   * explicit and survives a future async refactor.
   */
  private readonly createLocks = new Map<string, Promise<unknown>>();

  async create(req: CreateWorktreeRequest): Promise<WorktreeHandle> {
    const repo = resolve(req.repoPath);
    // Chain this creation after any in-flight creation on the same repo.
    const prior = this.createLocks.get(repo) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.createUnlocked(req, repo));
    this.createLocks.set(repo, run);
    try {
      return await run;
    } finally {
      // Only clear the slot if no newer creation chained onto it.
      if (this.createLocks.get(repo) === run) this.createLocks.delete(repo);
    }
  }

  private async createUnlocked(req: CreateWorktreeRequest, repo: string): Promise<WorktreeHandle> {
    const worktreePath = resolve(req.worktreePath);

    if (worktreePath === repo) {
      throw new Error('refusing to create a worktree at the main checkout path');
    }
    if (existsSync(worktreePath)) {
      throw new Error(`worktree path already exists: ${worktreePath}`);
    }

    // Ensure the parent (data/worktrees/<project-slug>) exists.
    mkdirSync(dirname(worktreePath), { recursive: true });

    // `-b <branch> <path> <base>` creates the branch off the base and checks it
    // out in the new worktree. The main checkout is left exactly as it was.
    git(repo, ['worktree', 'add', '-b', req.branch, worktreePath, req.defaultBranch]);

    return {
      worktreePath,
      branch: req.branch,
      baseBranch: req.defaultBranch,
      status: 'created',
    };
  }

  async status(worktreePath: string): Promise<GitStatus> {
    return parsePorcelain(git(worktreePath, ['status', '--porcelain=v1', '-b']));
  }

  async diff(worktreePath: string): Promise<string> {
    // Intent-to-add untracked files so brand-new files (which agents routinely
    // create) show up as additions. `-N` records the path only, not the content,
    // so it stays non-destructive to the later `git add -A` at delivery.
    git(worktreePath, ['add', '-N', '--', '.']);
    // Working tree + staged changes relative to HEAD.
    return git(worktreePath, ['diff', 'HEAD']);
  }

  async remove(
    worktreePath: string,
    opts: { force?: boolean; branch?: string } = {},
  ): Promise<void> {
    const target = resolve(worktreePath);
    // A worktree's git dir lives under the main repo, so resolve the main repo
    // path from inside the worktree and refuse to remove it.
    const commonDir = git(target, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).trim();
    const mainRepo = resolve(dirname(commonDir));
    if (target === mainRepo) {
      throw new Error('refusing to remove the main checkout');
    }
    const args = ['worktree', 'remove', target];
    if (opts.force) args.push('--force');
    git(mainRepo, args);

    // Drop the per-task branch too so the task can be re-worked from a clean
    // slate (and so re-creating its worktree doesn't collide on the name).
    if (opts.branch) {
      git(mainRepo, ['branch', '-D', opts.branch]);
    }
  }
}

/** Parse `git status --porcelain=v1 -b` into a structured {@link GitStatus}. */
export function parsePorcelain(out: string): GitStatus {
  const lines = out.split('\n').filter((l) => l.length > 0);
  let branch = '';
  let baseBranch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const changedFiles: ChangedFile[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      // e.g. "## wb/x...origin/main [ahead 1, behind 2]" or "## wb/x"
      const header = line.slice(3);
      const trackMatch = header.match(/^(.+?)\.\.\.(.+?)(?:\s\[(.+)\])?$/);
      if (trackMatch) {
        branch = trackMatch[1]!;
        baseBranch = trackMatch[2]!;
        const tracking = trackMatch[3];
        if (tracking) {
          const a = tracking.match(/ahead (\d+)/);
          const b = tracking.match(/behind (\d+)/);
          if (a) ahead = Number(a[1]);
          if (b) behind = Number(b[1]);
        }
      } else {
        branch = header.replace(/\s.*$/, '');
      }
      continue;
    }
    changedFiles.push({ status: line.slice(0, 2), path: line.slice(3) });
  }

  return { branch, baseBranch, ahead, behind, changedFiles, clean: changedFiles.length === 0 };
}
