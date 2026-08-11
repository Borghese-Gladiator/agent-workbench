import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LocalMergeInput {
  /** The repository root (main checkout) whose local default branch receives the merge. */
  repositoryPath: string;
  /** The feature branch to land (must already be committed in a linked worktree/branch). */
  branchName: string;
  /** The local default branch to merge into (main/master). */
  defaultBranch: string;
  /** The task objective, used as the merge-commit subject when a merge commit is created. */
  objective: string;
}

export interface LocalMergeResult {
  merged: boolean;
  /** The resulting tip SHA of the default branch after the merge. */
  commitSha: string;
  defaultBranch: string;
}

export interface LocalMergeRunner {
  merge(input: LocalMergeInput): Promise<LocalMergeResult>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trimEnd();
}

/**
 * Real local-merge delivery: for a repository with no `origin` remote, land a finished feature
 * branch by merging it into the local default branch instead of pushing/opening a PR. Checks out
 * the default branch in the repo root and merges the feature branch with `--no-ff` so the landing
 * is always a distinct commit that names the objective (a fast-forward would hide the task behind
 * the feature branch's own commits). Never touches a remote.
 */
export const realLocalMergeRunner: LocalMergeRunner = {
  async merge(input: LocalMergeInput): Promise<LocalMergeResult> {
    await git(input.repositoryPath, ['checkout', input.defaultBranch]);
    await git(input.repositoryPath, [
      'merge',
      '--no-ff',
      '-m',
      `Merge ${input.branchName}: ${input.objective}`,
      input.branchName,
    ]);
    const commitSha = await git(input.repositoryPath, ['rev-parse', 'HEAD']);
    return { merged: true, commitSha, defaultBranch: input.defaultBranch };
  },
};

/**
 * Deterministic local-merge delivery (the no-remote mirror of `deliverToGitHub`): merges the
 * feature branch into the local default branch and reports the landing commit. No push, no PR.
 */
export async function deliverToLocalMerge(
  input: LocalMergeInput,
  runner: LocalMergeRunner = realLocalMergeRunner,
): Promise<LocalMergeResult> {
  return runner.merge(input);
}
