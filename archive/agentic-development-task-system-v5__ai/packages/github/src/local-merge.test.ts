import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverToLocalMerge } from './local-merge.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('deliverToLocalMerge', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'awb-local-merge-'));
    await git(repo, ['init', '-b', 'master']);
    await git(repo, ['config', 'user.email', 'test@awb.local']);
    await git(repo, ['config', 'user.name', 'AWB Test']);
    await writeFile(join(repo, 'README.md'), '# base\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base commit']);
    // Feature branch with a distinct commit, then back to master (the delivery target).
    await git(repo, ['checkout', '-b', 'awb/feature']);
    await writeFile(join(repo, 'feature.txt'), 'the feature\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add feature']);
    await git(repo, ['checkout', 'master']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('merges the feature branch into local master with a new commit and no remote', async () => {
    // Precondition: there is no origin remote.
    const remotes = await git(repo, ['remote']);
    expect(remotes).toBe('');

    const result = await deliverToLocalMerge({
      repositoryPath: repo,
      branchName: 'awb/feature',
      defaultBranch: 'master',
      objective: 'Add the feature',
    });

    expect(result.merged).toBe(true);
    expect(result.defaultBranch).toBe('master');

    // master now contains the feature file...
    const files = await git(repo, ['ls-tree', '--name-only', 'master']);
    expect(files.split('\n')).toContain('feature.txt');

    // ...via a distinct --no-ff merge commit whose sha is the reported tip.
    const head = await git(repo, ['rev-parse', 'master']);
    expect(head).toBe(result.commitSha);
    const subject = await git(repo, ['log', '-1', '--pretty=%s', 'master']);
    expect(subject).toContain('Merge awb/feature');

    // Still no remote was introduced.
    expect(await git(repo, ['remote'])).toBe('');
  });
});
