import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorktreeProvider, parsePorcelain } from './git-worktree.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

let repo: string;
let worktrees: string;
let provider: GitWorktreeProvider;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  worktrees = mkdtempSync(join(tmpdir(), 'wb-wt-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  provider = new GitWorktreeProvider();
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktrees, { recursive: true, force: true });
});

const create = () =>
  provider.create({
    taskId: 'task_1',
    repoPath: repo,
    defaultBranch: 'main',
    branch: 'wb/task_1-demo',
    worktreePath: join(worktrees, 'task_1-demo'),
  });

describe('GitWorktreeProvider', () => {
  it('creates a branch + worktree and leaves the main checkout untouched', async () => {
    const mainHeadBefore = git(repo, 'rev-parse', 'HEAD').trim();
    const mainBranchBefore = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

    const handle = await create();
    expect(handle.status).toBe('created');
    expect(handle.branch).toBe('wb/task_1-demo');
    expect(handle.baseBranch).toBe('main');
    expect(existsSync(join(worktrees, 'task_1-demo', 'README.md'))).toBe(true);

    // Main checkout: still on main, same HEAD, clean.
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(mainHeadBefore);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(mainBranchBefore);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');

    // The branch exists in the repo's branch list.
    expect(git(repo, 'branch', '--list', 'wb/task_1-demo')).toContain('wb/task_1-demo');
  });

  it('reports clean then dirty status with changed files', async () => {
    const handle = await create();
    const clean = await provider.status(handle.worktreePath);
    expect(clean.clean).toBe(true);
    expect(clean.branch).toBe('wb/task_1-demo');

    writeFileSync(join(handle.worktreePath, 'new.txt'), 'hello\n');
    writeFileSync(join(handle.worktreePath, 'README.md'), '# changed\n');
    const dirty = await provider.status(handle.worktreePath);
    expect(dirty.clean).toBe(false);
    const paths = dirty.changedFiles.map((f) => f.path);
    expect(paths).toContain('new.txt');
    expect(paths).toContain('README.md');
  });

  it('returns a diff for a modified tracked file', async () => {
    const handle = await create();
    writeFileSync(join(handle.worktreePath, 'README.md'), '# changed\n');
    const diff = await provider.diff(handle.worktreePath);
    expect(diff).toContain('README.md');
    expect(diff).toContain('+# changed');
  });

  it('includes brand-new untracked files in the diff', async () => {
    const handle = await create();
    writeFileSync(join(handle.worktreePath, 'feature.ts'), 'export const x = 1;\n');
    const diff = await provider.diff(handle.worktreePath);
    expect(diff).toContain('feature.ts');
    expect(diff).toContain('+export const x = 1;');
    // Intent-to-add must not actually stage content for the later `git add -A`.
    expect(git(handle.worktreePath, 'diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('removes the worktree from disk', async () => {
    const handle = await create();
    expect(existsSync(handle.worktreePath)).toBe(true);
    await provider.remove(handle.worktreePath, { force: true });
    expect(existsSync(handle.worktreePath)).toBe(false);
  });

  it('serializes concurrent creates on the same repo (no race, all distinct)', async () => {
    // Fire N creations on the SAME repo at once — the multi-task queue can start
    // several same-project tasks together. The per-repo create lock must let every
    // one succeed with its own branch + worktree, never corrupting the shared repo.
    const reqs = Array.from({ length: 5 }, (_, i) => ({
      taskId: `task_c${i}`,
      repoPath: repo,
      defaultBranch: 'main',
      branch: `wb/task_c${i}`,
      worktreePath: join(worktrees, `task_c${i}`),
    }));
    const handles = await Promise.all(reqs.map((r) => provider.create(r)));

    expect(handles).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(existsSync(join(worktrees, `task_c${i}`, 'README.md'))).toBe(true);
      expect(git(repo, 'branch', '--list', `wb/task_c${i}`)).toContain(`wb/task_c${i}`);
    }
    // Main checkout still clean and on main.
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('a failed create on a repo does not block subsequent creates (lock released)', async () => {
    // First call collides with the main checkout path and rejects; the lock must
    // still release so a valid create on the same repo afterwards succeeds.
    await expect(
      provider.create({
        taskId: 'task_bad',
        repoPath: repo,
        defaultBranch: 'main',
        branch: 'wb/task_bad',
        worktreePath: repo,
      }),
    ).rejects.toThrow();
    const handle = await create();
    expect(handle.status).toBe('created');
  });

  it('refuses to create a worktree at the main checkout path', async () => {
    await expect(
      provider.create({
        taskId: 'task_2',
        repoPath: repo,
        defaultBranch: 'main',
        branch: 'wb/task_2-x',
        worktreePath: repo,
      }),
    ).rejects.toThrow(/main checkout/);
    // README still here, untouched.
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# repo\n');
  });
});

describe('parsePorcelain', () => {
  it('parses tracking branch with ahead/behind', () => {
    const s = parsePorcelain('## wb/x...origin/main [ahead 1, behind 2]\n M file.ts\n?? new.ts\n');
    expect(s.branch).toBe('wb/x');
    expect(s.baseBranch).toBe('origin/main');
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(2);
    expect(s.clean).toBe(false);
    expect(s.changedFiles).toEqual([
      { status: ' M', path: 'file.ts' },
      { status: '??', path: 'new.ts' },
    ]);
  });

  it('parses a branch with no upstream', () => {
    const s = parsePorcelain('## wb/x\n');
    expect(s.branch).toBe('wb/x');
    expect(s.baseBranch).toBeNull();
    expect(s.clean).toBe(true);
  });
});
