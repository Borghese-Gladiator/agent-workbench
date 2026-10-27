/**
 * DeliveryAdapter: commits the task's branch, then delivers it according to the
 * project's delivery policy — either opening a draft pull request (returning the
 * PR URL) or squash-merging the branch into the project's default branch as a
 * single commit.
 *
 * Delivery action (PR vs merge) is decided by `policy`; it is independent of how
 * the work was implemented (worktree vs direct), which the caller has already
 * resolved into `cwd` and `branch`.
 *
 * Before doing anything mutating, `publish` checks whether the branch merges
 * cleanly into the base. If not, it returns `status: 'conflict'` with the list
 * of conflicted files — without committing or pushing — so the caller can resolve
 * the conflict (e.g. hand it to an agent) and re-attempt.
 *
 * Network/git side effects go through an injectable `GitClient` so the publish
 * flow is unit-testable without a real remote, and a `dryRun` mode performs the
 * local commit only — nothing leaves the machine unless real delivery is
 * explicitly enabled.
 */

import { spawn } from 'node:child_process';
import type { DeliveryPolicy } from '@workbench/core';

export interface DeliveryRequest {
  taskId: string;
  cwd: string;
  /** Branch the work lives on (a feature branch, or the default branch in direct mode). */
  branch: string;
  /** The project's default branch — the merge target for `merge_to_master`. */
  baseBranch: string;
  /**
   * The checkout that OWNS `baseBranch` (the project's primary checkout). A
   * squash-merge must run THERE: `git checkout <base>` inside a task worktree
   * fails with "already used by worktree" because a branch can only be checked
   * out once across worktrees. Falls back to `cwd` (correct for direct mode).
   */
  baseCwd?: string;
  /** PR title / target description. Also used as the squash commit message. */
  target: string;
  /**
   * Markdown body for the pull request (ignored for `merge_to_master`). Usually
   * the task's delivery package artifact. Falls back to an empty body when
   * absent, preserving the prior behavior.
   */
  description?: string;
  policy: DeliveryPolicy;
}

export interface DeliveryResult {
  status: 'published' | 'conflict' | 'failed';
  /** URL of the created PR; null for dry-run, merges, conflicts, or failures. */
  url: string | null;
  /** Conflicted file paths when `status === 'conflict'`; empty otherwise. */
  conflicts: string[];
  summary: string;
}

export interface DeliveryAdapter {
  publish(req: DeliveryRequest): Promise<DeliveryResult>;
}

/**
 * The git/network operations a delivery needs. Injectable so tests can stub the
 * remote-touching steps. All methods run inside `cwd`.
 */
export interface GitClient {
  /**
   * Returns the paths that would conflict if `branch` were merged into
   * `baseBranch`, without mutating the working tree. Empty array = clean merge.
   */
  conflictsWith(cwd: string, branch: string, baseBranch: string): Promise<string[]>;
  /** Stage and commit everything on the current branch. No-op if nothing to commit. */
  commitAll(cwd: string, message: string): Promise<void>;
  /** Push the branch to its remote, setting upstream. */
  push(cwd: string, branch: string): Promise<void>;
  /** Whether the repo has any remote configured (i.e. there's somewhere to push). */
  hasRemote(cwd: string): Promise<boolean>;
  /** Open a draft PR for the branch and return its URL. */
  createDraftPr(cwd: string, branch: string, title: string, body: string): Promise<string>;
  /**
   * Rebase `branch` onto `baseBranch` so its commits replay on top of the latest
   * base — keeping history linear before the squash. On conflict it aborts the
   * rebase (leaving the working tree clean) and throws, so the caller can surface
   * the conflict and hand it to the agent rather than leaving a half-done rebase.
   */
  rebaseOnto(cwd: string, branch: string, baseBranch: string): Promise<void>;
  /**
   * Squash-merge `branch` into `baseBranch` as a single commit, leaving
   * `baseBranch` checked out.
   */
  squashMergeToBase(
    cwd: string,
    branch: string,
    baseBranch: string,
    message: string,
  ): Promise<void>;
}

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Cap captured output so a runaway command can't grow the buffer without bound.
// 64 MB matches the worktree provider's execFileSync maxBuffer; on overflow we
// SIGKILL the child, mirroring spawnSync's maxBuffer-exceeded behavior.
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * Async equivalent of the old `spawnSync(..., { encoding: 'utf8' })`: spawns the
 * command, buffers stdout/stderr, and resolves once the process closes. Unlike
 * `spawnSync` it does NOT block the event loop — delivery's rebase/squash on a
 * large monorepo can run for seconds-to-minutes, and the daemon must keep
 * servicing SSE and keep-alive polls throughout (see docs/econnreset-rootcause.md:
 * the proven prod ECONNRESET was exactly this kind of multi-minute event-loop
 * block, in the validation runner).
 */
function spawnCapture(cwd: string, cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const capped = () => {
      if (stdout.length + stderr.length > MAX_OUTPUT) {
        child.kill('SIGKILL');
        rejectPromise(new Error(`${cmd} ${args.join(' ')} exceeded ${MAX_OUTPUT}-byte output cap`));
      }
    };
    child.stdout.on('data', (d: string) => {
      stdout += d;
      capped();
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
      capped();
    });
    child.on('error', rejectPromise);
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** Runs a command, throwing with captured output on a non-zero exit. */
async function run(cwd: string, cmd: string, args: string[]): Promise<string> {
  const proc = await spawnCapture(cwd, cmd, args);
  if (proc.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${proc.status}): ${proc.stderr}`);
  }
  return proc.stdout.trim();
}

/** Runs `git commit -m <message>` without throwing, returning the raw result. */
function commit(cwd: string, message: string): Promise<SpawnResult> {
  return spawnCapture(cwd, 'git', ['commit', '-m', message]);
}

/** True when a `git commit` result means "nothing to commit" (a tolerated no-op). */
function isNothingToCommit(proc: SpawnResult): boolean {
  return /nothing to commit/i.test(proc.stdout);
}

/** Default GitClient: shells out to `git` and `gh`. */
export const cliGitClient: GitClient = {
  async conflictsWith(cwd, branch, baseBranch) {
    // `git merge-tree` (write-tree mode) performs an in-memory merge and reports
    // conflicts without touching the working tree or index. On a conflict it
    // exits 1 and prints the tree oid, a blank line, then one conflicted path
    // per line (because of `--name-only`); we parse those paths.
    const proc = await spawnCapture(cwd, 'git', [
      'merge-tree',
      '--write-tree',
      '--name-only',
      baseBranch,
      branch,
    ]);
    // Exit 0 → clean merge. Exit 1 → conflicts. Other codes → a real error.
    if (proc.status === 0) return [];
    if (proc.status === 1) {
      const lines = proc.stdout.split('\n');
      const blank = lines.indexOf('');
      const paths = blank >= 0 ? lines.slice(blank + 1) : lines.slice(1);
      return paths.map((p) => p.trim()).filter(Boolean);
    }
    throw new Error(`git merge-tree failed (${proc.status}): ${proc.stderr || proc.stdout}`);
  },
  async commitAll(cwd, message) {
    await run(cwd, 'git', ['add', '-A']);
    // `git commit` exits non-zero when there is nothing to commit; tolerate that.
    const proc = await commit(cwd, message);
    if (proc.status === 0 || isNothingToCommit(proc)) return;
    // Format-on-commit hooks (black/isort/prettier via lefthook's
    // `fail_on_changes`, pre-commit, husky, …) reformat staged files and exit
    // non-zero on the FIRST commit — by design. The reformatted result is
    // exactly what we want committed, so re-stage the hook's edits and retry
    // once, matching what a human does. A second non-zero exit is a real
    // failure (e.g. a hook that rejects without modifying any files).
    await run(cwd, 'git', ['add', '-A']);
    const retry = await commit(cwd, message);
    if (retry.status === 0 || isNothingToCommit(retry)) return;
    throw new Error(`git commit failed (${retry.status}): ${retry.stderr || retry.stdout}`);
  },
  async hasRemote(cwd) {
    // `git remote` lists configured remotes, one per line; empty output = none.
    const proc = await spawnCapture(cwd, 'git', ['remote']);
    return proc.stdout.trim().length > 0;
  },
  async push(cwd, branch) {
    await run(cwd, 'git', ['push', '-u', 'origin', branch]);
  },
  async createDraftPr(cwd, branch, title, body) {
    return run(cwd, 'gh', [
      'pr',
      'create',
      '--draft',
      '--head',
      branch,
      '--title',
      title,
      '--body',
      body,
    ]);
  },
  async rebaseOnto(cwd, branch, baseBranch) {
    await run(cwd, 'git', ['checkout', branch]);
    // Replay branch commits on top of base. On conflict, `git rebase` exits
    // non-zero and pauses mid-rebase; abort so we never leave the working tree in
    // a half-rebased state, then throw — the caller surfaces the conflict.
    const proc = await spawnCapture(cwd, 'git', ['rebase', baseBranch]);
    if (proc.status !== 0) {
      await spawnCapture(cwd, 'git', ['rebase', '--abort']);
      throw new Error(
        `git rebase ${baseBranch} onto ${branch} failed (${proc.status}): ${proc.stderr || proc.stdout}`,
      );
    }
  },
  async squashMergeToBase(cwd, branch, baseBranch, message) {
    await run(cwd, 'git', ['checkout', baseBranch]);
    // `--squash` stages the merged changes without creating a commit; we then
    // commit once so the base gets exactly one commit for the whole task.
    await run(cwd, 'git', ['merge', '--squash', branch]);
    await run(cwd, 'git', ['commit', '-m', message]);
  },
};

export interface GitDeliveryOptions {
  /** When true (default), commit locally but do not push or open a PR. */
  dryRun?: boolean;
  git?: GitClient;
}

export class GitDeliveryAdapter implements DeliveryAdapter {
  private readonly dryRun: boolean;
  private readonly git: GitClient;

  constructor(opts: GitDeliveryOptions = {}) {
    this.dryRun = opts.dryRun ?? true;
    this.git = opts.git ?? cliGitClient;
  }

  async publish(req: DeliveryRequest): Promise<DeliveryResult> {
    try {
      // Conflict gate first: never commit or push when the branch wouldn't merge
      // cleanly. The caller resolves the conflict and retries.
      const conflicts = await this.git.conflictsWith(req.cwd, req.branch, req.baseBranch);
      if (conflicts.length > 0) {
        return {
          status: 'conflict',
          url: null,
          conflicts,
          summary:
            `Cannot deliver ${req.branch}: it conflicts with ${req.baseBranch} in ` +
            `${conflicts.length} file(s): ${conflicts.join(', ')}.`,
        };
      }
      await this.git.commitAll(req.cwd, req.target);
      return req.policy === 'merge_to_master' ? await this.merge(req) : await this.openPr(req);
    } catch (err) {
      return {
        status: 'failed',
        url: null,
        conflicts: [],
        summary: `Delivery failed for ${req.branch}: ${(err as Error).message}`,
      };
    }
  }

  /** Push the branch and open a draft PR against the default branch. */
  private async openPr(req: DeliveryRequest): Promise<DeliveryResult> {
    if (this.dryRun) {
      return {
        status: 'published',
        url: null,
        conflicts: [],
        summary: `(dry-run) committed ${req.branch}; would push and open a draft PR.`,
      };
    }
    await this.git.push(req.cwd, req.branch);
    const url = await this.git.createDraftPr(
      req.cwd,
      req.branch,
      req.target,
      req.description ?? '',
    );
    return {
      status: 'published',
      url,
      conflicts: [],
      summary: `Opened draft PR for ${req.branch}: ${url}`,
    };
  }

  /**
   * Rebase the branch onto the default branch, then squash-merge it as one
   * commit — keeping the base's history linear (no merge commit). The merge is
   * the delivery; pushing the merged base to a remote is a SEPARATE publish step
   * that only runs when the repo actually has a remote configured. A repo with
   * no remote (a local-only project, or an isolated test/proof repo) still
   * delivers successfully — it merges locally and reports that it didn't push,
   * rather than failing on `git push 'origin'` against a nonexistent remote.
   */
  private async merge(req: DeliveryRequest): Promise<DeliveryResult> {
    if (this.dryRun) {
      return {
        status: 'published',
        url: null,
        conflicts: [],
        summary: `(dry-run) committed ${req.branch}; would rebase onto ${req.baseBranch}, squash-merge, and push.`,
      };
    }
    // Rebase the branch onto base FIRST so its commits replay on top of the
    // latest base — linear history before we collapse to one commit. The
    // `publish` conflict gate (git merge-tree) has already confirmed the trees
    // merge cleanly, so this rebase won't hit content conflicts in the happy
    // path; the rebase runs in the task worktree (`req.cwd`), which owns the
    // feature branch. The subsequent squash must run in the checkout that owns
    // the base branch (see DeliveryRequest.baseCwd) — checking out the base
    // inside a task worktree is rejected by git when it's checked out elsewhere.
    await this.git.rebaseOnto(req.cwd, req.branch, req.baseBranch);
    const baseCwd = req.baseCwd ?? req.cwd;
    await this.git.squashMergeToBase(baseCwd, req.branch, req.baseBranch, req.target);
    const pushed = await this.git.hasRemote(baseCwd);
    if (pushed) await this.git.push(baseCwd, req.baseBranch);
    return {
      status: 'published',
      url: null,
      conflicts: [],
      summary: pushed
        ? `Rebased and squash-merged ${req.branch} into ${req.baseBranch} (one commit, linear) and pushed.`
        : `Rebased and squash-merged ${req.branch} into ${req.baseBranch} (one commit, linear); no remote configured, not pushed.`,
    };
  }
}

/** Not implemented — retained for tests/back-compat that want a throwing stub. */
export class UnimplementedDeliveryAdapter implements DeliveryAdapter {
  async publish(_req: DeliveryRequest): Promise<DeliveryResult> {
    throw new Error('DeliveryAdapter is not implemented in this increment.');
  }
}
