import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGitHubRemote, resolveDeliveryTarget, resolveRepositoryRoot } from './delivery-support.js';

const execFileAsync = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

describe('parseGitHubRemote (Fix 6: resolve real repo ref)', () => {
  it('parses an https remote and strips .git', () => {
    expect(parseGitHubRemote('https://github.com/Borghese-Gladiator/wip-browser-games.git')).toEqual({
      owner: 'Borghese-Gladiator',
      repo: 'wip-browser-games',
    });
  });

  it('parses an https remote without .git', () => {
    expect(parseGitHubRemote('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses an ssh remote', () => {
    expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('returns undefined for a non-GitHub remote', () => {
    expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeUndefined();
    expect(parseGitHubRemote('')).toBeUndefined();
  });
});

describe('resolveDeliveryTarget (TASK-71: no-origin → local merge)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'awb-delivery-target-'));
    await git(repo, ['init', '-q', '-b', 'master']);
    await git(repo, ['config', 'user.email', 't@t.com']);
    await git(repo, ['config', 'user.name', 't']);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('routes a repo with no origin to a local merge into its default branch', async () => {
    const target = await resolveDeliveryTarget(repo);
    expect(target).toEqual({ kind: 'local-merge', defaultBranch: 'master' });
  });

  it('routes a repo with a GitHub origin to a github PR', async () => {
    await git(repo, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const target = await resolveDeliveryTarget(repo);
    expect(target).toEqual({ kind: 'github', ref: { owner: 'owner', repo: 'repo' } });
  });

  it('resolves the default branch from the REPO ROOT, not a linked worktree on a feature branch', async () => {
    // Reproduces the local-merge delivery bug: called with the WORKTREE path, `git branch
    // --show-current` there returns the feature branch — so local-merge would try to check out the
    // very branch it is delivering. The target must be the root's default branch (master).
    const wt = join(repo, '..', `wt-${Date.now()}`);
    await git(repo, ['worktree', 'add', '-q', '-b', 'awb/feature', wt]);
    try {
      const target = await resolveDeliveryTarget(wt);
      expect(target).toEqual({ kind: 'local-merge', defaultBranch: 'master' });
    } finally {
      await git(repo, ['worktree', 'remove', '--force', wt]);
    }
  });
});

describe('resolveRepositoryRoot', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'awb-repo-root-'));
    await git(repo, ['init', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 't@t.com']);
    await git(repo, ['config', 'user.name', 't']);
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('resolves a linked worktree back to its owning repository root', async () => {
    const wt = join(repo, '..', `wt-${Date.now()}`);
    await git(repo, ['worktree', 'add', '-q', '-b', 'awb/feat', wt]);
    try {
      const root = await resolveRepositoryRoot(wt);
      // macOS /tmp is a symlink to /private/tmp; compare via realpath through git.
      const expected = await git(repo, ['rev-parse', '--show-toplevel']);
      expect(await git(root, ['rev-parse', '--show-toplevel'])).toBe(expected);
    } finally {
      await git(repo, ['worktree', 'remove', '--force', wt]);
    }
  });
});
