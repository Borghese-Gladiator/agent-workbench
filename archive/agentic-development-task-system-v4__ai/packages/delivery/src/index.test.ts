import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cliGitClient, type DeliveryRequest, type GitClient, GitDeliveryAdapter } from './index.js';

const prReq: DeliveryRequest = {
  taskId: 'task_1',
  cwd: '/tmp/wt',
  branch: 'wb/task_1-add-dark-mode',
  baseBranch: 'main',
  target: 'Add dark mode',
  policy: 'create_pr',
};

const mergeReq: DeliveryRequest = { ...prReq, policy: 'merge_to_master' };

function fakeGit(overrides: Partial<GitClient> = {}): GitClient {
  return {
    conflictsWith: vi.fn(async () => []),
    commitAll: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    // Default: a remote IS configured (the common team-repo case), so a real
    // merge_to_master pushes. The no-remote case overrides this to false.
    hasRemote: vi.fn(async () => true),
    createDraftPr: vi.fn(async () => 'https://github.com/acme/repo/pull/42'),
    rebaseOnto: vi.fn(async () => {}),
    squashMergeToBase: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('GitDeliveryAdapter', () => {
  it('checks for conflicts before committing, regardless of policy', async () => {
    const git = fakeGit();
    await new GitDeliveryAdapter({ dryRun: true, git }).publish(prReq);
    expect(git.conflictsWith).toHaveBeenCalledWith(prReq.cwd, prReq.branch, prReq.baseBranch);
    expect(git.commitAll).toHaveBeenCalledOnce();
  });

  describe('conflict gate', () => {
    it('returns status "conflict" with the files and never commits or pushes', async () => {
      const git = fakeGit({ conflictsWith: vi.fn(async () => ['src/a.ts', 'src/b.ts']) });
      const res = await new GitDeliveryAdapter({ dryRun: false, git }).publish(mergeReq);

      expect(res.status).toBe('conflict');
      expect(res.conflicts).toEqual(['src/a.ts', 'src/b.ts']);
      expect(res.summary).toContain('src/a.ts');
      expect(git.commitAll).not.toHaveBeenCalled();
      expect(git.push).not.toHaveBeenCalled();
      expect(git.squashMergeToBase).not.toHaveBeenCalled();
      expect(git.createDraftPr).not.toHaveBeenCalled();
    });
  });

  describe('create_pr', () => {
    it('dry-run commits but never pushes or opens a PR', async () => {
      const git = fakeGit();
      const res = await new GitDeliveryAdapter({ dryRun: true, git }).publish(prReq);

      expect(git.push).not.toHaveBeenCalled();
      expect(git.createDraftPr).not.toHaveBeenCalled();
      expect(res.status).toBe('published');
      expect(res.url).toBeNull();
      expect(res.summary).toContain('(dry-run)');
      expect(res.summary).toContain('draft PR');
    });

    it('real run pushes the branch and opens a draft PR, returning its URL', async () => {
      const git = fakeGit();
      const res = await new GitDeliveryAdapter({ dryRun: false, git }).publish(prReq);

      expect(git.push).toHaveBeenCalledWith(prReq.cwd, prReq.branch);
      // No description on prReq → empty body (prior behavior preserved).
      expect(git.createDraftPr).toHaveBeenCalledWith(prReq.cwd, prReq.branch, prReq.target, '');
      expect(git.squashMergeToBase).not.toHaveBeenCalled();
      expect(res.status).toBe('published');
      expect(res.url).toBe('https://github.com/acme/repo/pull/42');
      expect(res.summary).toContain('draft PR');
    });

    it('threads the request description through as the PR body', async () => {
      const git = fakeGit();
      const req: DeliveryRequest = { ...prReq, description: '## Summary\n\nAdds dark mode.' };
      await new GitDeliveryAdapter({ dryRun: false, git }).publish(req);

      expect(git.createDraftPr).toHaveBeenCalledWith(
        req.cwd,
        req.branch,
        req.target,
        '## Summary\n\nAdds dark mode.',
      );
    });

    it('reports failure (does not throw) when opening the PR fails', async () => {
      const git = fakeGit({
        createDraftPr: vi.fn(async () => {
          throw new Error('gh: not authenticated');
        }),
      });
      const res = await new GitDeliveryAdapter({ dryRun: false, git }).publish(prReq);

      expect(res.status).toBe('failed');
      expect(res.url).toBeNull();
      expect(res.summary).toContain('not authenticated');
    });
  });

  describe('merge_to_master', () => {
    it('dry-run commits but never merges or pushes', async () => {
      const git = fakeGit();
      const res = await new GitDeliveryAdapter({ dryRun: true, git }).publish(mergeReq);

      expect(git.rebaseOnto).not.toHaveBeenCalled();
      expect(git.squashMergeToBase).not.toHaveBeenCalled();
      expect(git.push).not.toHaveBeenCalled();
      expect(git.createDraftPr).not.toHaveBeenCalled();
      expect(res.status).toBe('published');
      expect(res.summary).toContain('would rebase onto main');
    });

    it('rebases the branch onto base (in the worktree) BEFORE squash-merging it', async () => {
      const calls: string[] = [];
      const git = fakeGit({
        rebaseOnto: vi.fn(async () => {
          calls.push('rebase');
        }),
        squashMergeToBase: vi.fn(async () => {
          calls.push('squash');
        }),
      });
      await new GitDeliveryAdapter({ dryRun: false, git }).publish(mergeReq);

      // Rebase replays branch commits onto base for linear history; it runs in
      // the worktree that owns the feature branch (req.cwd), before the squash.
      expect(git.rebaseOnto).toHaveBeenCalledWith(
        mergeReq.cwd,
        mergeReq.branch,
        mergeReq.baseBranch,
      );
      expect(calls).toEqual(['rebase', 'squash']);
    });

    it('real run squash-merges the branch into the base and pushes when a remote exists (no PR)', async () => {
      const git = fakeGit({ hasRemote: vi.fn(async () => true) });
      const res = await new GitDeliveryAdapter({ dryRun: false, git }).publish(mergeReq);

      expect(git.squashMergeToBase).toHaveBeenCalledWith(
        mergeReq.cwd,
        mergeReq.branch,
        mergeReq.baseBranch,
        mergeReq.target,
      );
      expect(git.push).toHaveBeenCalledWith(mergeReq.cwd, mergeReq.baseBranch);
      expect(git.createDraftPr).not.toHaveBeenCalled();
      expect(res.status).toBe('published');
      expect(res.url).toBeNull();
      expect(res.summary).toContain('and pushed');
    });

    it('real run merges but does NOT push when the repo has no remote', async () => {
      // A local-only project (or an isolated test/proof repo) still delivers:
      // the merge is the delivery; the push is skipped because there's nowhere
      // to push, rather than failing on `git push origin`.
      const git = fakeGit({ hasRemote: vi.fn(async () => false) });
      const res = await new GitDeliveryAdapter({ dryRun: false, git }).publish(mergeReq);

      expect(git.squashMergeToBase).toHaveBeenCalledWith(
        mergeReq.cwd,
        mergeReq.branch,
        mergeReq.baseBranch,
        mergeReq.target,
      );
      expect(git.push).not.toHaveBeenCalled();
      expect(res.status).toBe('published');
      expect(res.url).toBeNull();
      expect(res.summary).toContain('not pushed');
    });

    it('merges in baseCwd (the checkout that owns the base branch), not the task worktree', async () => {
      // `git checkout <base>` inside a worktree fails with "already used by
      // worktree" when the base is checked out in the primary checkout — the
      // merge (and the base-branch push) must run THERE.
      const git = fakeGit();
      await new GitDeliveryAdapter({ dryRun: false, git }).publish({
        ...mergeReq,
        baseCwd: '/repo/primary',
      });

      expect(git.squashMergeToBase).toHaveBeenCalledWith(
        '/repo/primary',
        mergeReq.branch,
        mergeReq.baseBranch,
        mergeReq.target,
      );
      expect(git.push).toHaveBeenCalledWith('/repo/primary', mergeReq.baseBranch);
      // The branch itself is still committed in the worktree.
      expect(git.commitAll).toHaveBeenCalledWith(mergeReq.cwd, mergeReq.target);
    });

    it('reports failure (does not throw) when the merge fails', async () => {
      const git = fakeGit({
        squashMergeToBase: vi.fn(async () => {
          throw new Error('merge exploded');
        }),
      });
      const res = await new GitDeliveryAdapter({ dryRun: false, git }).publish(mergeReq);

      expect(res.status).toBe('failed');
      expect(res.summary).toContain('merge exploded');
    });
  });
});

describe('cliGitClient.commitAll against a real repo', () => {
  let repo: string;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  /** Installs a pre-commit hook running `body`, made executable. */
  const installHook = (body: string) => {
    const path = join(repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'wb-delivery-'));
    git('init', '-q');
    git('config', 'user.email', 'test@workbench.dev');
    git('config', 'user.name', 'wb test');
    git('config', 'commit.gpgsign', 'false');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('commits the hook-formatted result in ONE commit when a format hook mutates the tree on the first attempt', async () => {
    writeFileSync(join(repo, 'app.py'), 'x=1\n');
    // A format-on-commit hook in the lefthook `fail_on_changes` mold: on the
    // first run it reformats a staged file and exits non-zero; on the re-run
    // the file is already formatted so it leaves the tree alone and passes.
    installHook(
      [
        'if grep -q "x=1" app.py; then',
        '  printf "x = 1\\n" > app.py',
        '  echo "files were modified by a hook, and fail_on_changes is enabled" >&2',
        '  exit 1',
        'fi',
      ].join('\n'),
    );

    await expect(cliGitClient.commitAll(repo, 'wb: format hook task')).resolves.toBeUndefined();

    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(git('show', 'HEAD:app.py')).toBe('x = 1\n');
    // Nothing left uncommitted: the hook's reformat made it into the commit.
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('surfaces a genuine hook rejection (one that does not modify files) as an error', async () => {
    writeFileSync(join(repo, 'secret.txt'), 'AKIA-leak\n');
    // A hook that rejects the commit without touching the tree — re-staging and
    // retrying changes nothing, so the second attempt fails the same way.
    installHook('echo "rejected: secret detected" >&2\nexit 1');

    await expect(cliGitClient.commitAll(repo, 'wb: rejected task')).rejects.toThrow(
      /git commit failed/,
    );
    expect(git('rev-list', '--all', '--count').trim()).toBe('0');
  });

  it('tolerates "nothing to commit" as a no-op', async () => {
    await expect(cliGitClient.commitAll(repo, 'wb: empty')).resolves.toBeUndefined();
    expect(git('rev-list', '--all', '--count').trim()).toBe('0');
  });

  it('does NOT block the event loop while a slow git op runs', async () => {
    // The whole point of the async spawn: a long-running git op (here a
    // pre-commit hook that sleeps) must NOT freeze the daemon's single event
    // loop (see docs/econnreset-rootcause.md). Proof: a timer scheduled
    // concurrently fires WHILE the commit is still in flight. Under the old
    // spawnSync this timer could not run until the commit returned.
    writeFileSync(join(repo, 'app.py'), 'x = 1\n');
    installHook('sleep 0.5');

    let timerFiredBeforeCommit = false;
    const commitDone = cliGitClient.commitAll(repo, 'wb: slow hook').then(() => 'commit');
    const timer = new Promise<string>((r) => setTimeout(() => r('timer'), 50)).then((v) => {
      timerFiredBeforeCommit = true;
      return v;
    });

    expect(await Promise.race([commitDone, timer])).toBe('timer');
    await commitDone;
    expect(timerFiredBeforeCommit).toBe(true);
    expect(git('rev-list', '--count', 'HEAD').trim()).toBe('1');
  });
});
