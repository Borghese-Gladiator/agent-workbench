import { describe, expect, it, vi } from 'vitest';
import { createRealGitHubClient } from './real-github-client.js';
import type { Octokit } from '@octokit/rest';

/**
 * These tests verify the Octokit -> GitHubClient mapping logic using a fake object shaped like
 * Octokit's relevant methods, NEVER a real Octokit instance making network calls. This package's
 * own test suite must never be able to create a real PR, push a real branch, or otherwise touch
 * a real GitHub repository, even though the developer's local `gh` CLI is authenticated with
 * broad repo/workflow scopes.
 */
function makeFakeOctokit(overrides: Record<string, unknown> = {}): Octokit {
  return {
    pulls: {
      create: vi.fn().mockResolvedValue({
        data: { number: 7, html_url: 'https://github.com/acme/widgets/pull/7', head: { sha: 'sha-abc' }, node_id: 'node-1' },
      }),
      update: vi.fn().mockResolvedValue({ data: {} }),
      get: vi.fn().mockResolvedValue({
        data: { merged: false, state: 'open', head: { sha: 'sha-abc' }, merge_commit_sha: null },
      }),
      listReviewComments: vi.fn().mockResolvedValue({ data: [] }),
      ...((overrides.pulls as object) ?? {}),
    },
    issues: {
      createComment: vi.fn().mockResolvedValue({
        data: { id: 123, html_url: 'https://github.com/acme/widgets/pull/7#comment-123' },
      }),
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      ...((overrides.issues as object) ?? {}),
    },
  } as unknown as Octokit;
}

describe('createRealGitHubClient', () => {
  it('maps createDraftPullRequest to octokit.pulls.create with draft: true', async () => {
    const octokit = makeFakeOctokit();
    const client = createRealGitHubClient(octokit);

    const result = await client.createDraftPullRequest({
      owner: 'acme',
      repo: 'widgets',
      headBranch: 'awb/task-1',
      baseBranch: 'main',
      title: 'Add feature',
      body: 'Description',
    });

    expect(octokit.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widgets', head: 'awb/task-1', base: 'main', draft: true }),
    );
    expect(result.number).toBe(7);
    expect(result.headSha).toBe('sha-abc');
  });

  it('maps updatePullRequest to octokit.pulls.update', async () => {
    const octokit = makeFakeOctokit();
    const client = createRealGitHubClient(octokit);

    await client.updatePullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 7, title: 'New title' });

    expect(octokit.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widgets', pull_number: 7, title: 'New title' }),
    );
  });

  // Draft-only invariant (task DAG orchestration / product-level "never"): the workbench must never
  // open a ready-for-review PR nor flip an existing draft to ready. Guard both the create path
  // (always draft:true) and the update path (never passes draft at all → can't un-draft).
  it('never opens a non-draft PR and never un-drafts one', async () => {
    const octokit = makeFakeOctokit();
    const client = createRealGitHubClient(octokit);

    await client.createDraftPullRequest({
      owner: 'acme', repo: 'widgets', headBranch: 'awb/task-1', baseBranch: 'main', title: 't', body: 'b',
    });
    const createMock = octokit.pulls.create as unknown as ReturnType<typeof vi.fn>;
    const createArg = createMock.mock.calls[0]?.[0] as { draft?: boolean };
    expect(createArg.draft).toBe(true);

    await client.updatePullRequest({ owner: 'acme', repo: 'widgets', pullNumber: 7, title: 'x', body: 'y' });
    const updateMock = octokit.pulls.update as unknown as ReturnType<typeof vi.fn>;
    const updateArg = updateMock.mock.calls[0]?.[0] as { draft?: boolean };
    // The update path must not carry a `draft` field at all — it can only touch title/body.
    expect(updateArg).not.toHaveProperty('draft');
  });

  it('maps postComment to octokit.issues.createComment', async () => {
    const octokit = makeFakeOctokit();
    const client = createRealGitHubClient(octokit);

    const result = await client.postComment({ owner: 'acme', repo: 'widgets', pullNumber: 7, body: 'evidence matrix' });

    expect(octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widgets', issue_number: 7, body: 'evidence matrix' }),
    );
    expect(result.commentId).toBe('123');
  });

  it('maps getPrStatus to "merged" when octokit reports merged: true', async () => {
    const octokit = makeFakeOctokit({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { merged: true, state: 'closed', head: { sha: 'sha-final' }, merge_commit_sha: 'merge-sha' },
        }),
      },
    });
    const client = createRealGitHubClient(octokit);

    const status = await client.getPrStatus({ owner: 'acme', repo: 'widgets' }, 7);

    expect(status.state).toBe('merged');
    expect(status.mergeCommitSha).toBe('merge-sha');
  });

  it('maps getPrStatus to "closed" when closed but not merged', async () => {
    const octokit = makeFakeOctokit({
      pulls: {
        get: vi.fn().mockResolvedValue({
          data: { merged: false, state: 'closed', head: { sha: 'sha-final' }, merge_commit_sha: null },
        }),
      },
    });
    const client = createRealGitHubClient(octokit);

    const status = await client.getPrStatus({ owner: 'acme', repo: 'widgets' }, 7);
    expect(status.state).toBe('closed');
  });

  it('combines issue comments and review comments in listPrComments', async () => {
    const octokit = makeFakeOctokit({
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: [{ id: 1, user: { login: 'alice' }, body: 'looks good', created_at: '2026-01-01T00:00:00Z' }],
        }),
      },
      pulls: {
        listReviewComments: vi.fn().mockResolvedValue({
          data: [{ id: 2, user: { login: 'bob' }, body: 'fix this line', created_at: '2026-01-02T00:00:00Z' }],
        }),
      },
    });
    const client = createRealGitHubClient(octokit);

    const comments = await client.listPrComments({ owner: 'acme', repo: 'widgets' }, 7);

    expect(comments).toHaveLength(2);
    expect(comments.find((c) => c.author === 'alice')?.isReview).toBe(false);
    expect(comments.find((c) => c.author === 'bob')?.isReview).toBe(true);
  });
});
