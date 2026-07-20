import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PushBranchInput } from './types.js';

const execFileAsync = promisify(execFile);

export interface GitPushRunner {
  push(input: PushBranchInput): Promise<{ pushed: boolean }>;
}

/** Real implementation: shells out to the local `git` CLI (never Octokit) to push a branch. */
export const realGitPushRunner: GitPushRunner = {
  async push(input: PushBranchInput): Promise<{ pushed: boolean }> {
    const args = ['push', 'origin', `${input.branchName}:${input.branchName}`];
    if (input.force) args.push('--force-with-lease');
    await execFileAsync('git', args, { cwd: input.worktreePath });
    return { pushed: true };
  },
};
