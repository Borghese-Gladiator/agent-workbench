import { describe, expect, it } from 'vitest';
import { deliverToGitHub } from './delivery.js';
import { FakeGitHubClient, FakeGitPushRunner } from './test-fakes.js';
import type { Evidence } from '@awb/domain';

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev-1',
    taskId: 'task-1',
    runId: 'run-1',
    phaseAttemptId: 'pa-1',
    kind: 'unit-test',
    status: 'passed',
    claimIds: ['claim-1'],
    contractVersion: 1,
    repositorySnapshotId: 'snap-1',
    candidateSha: 'a'.repeat(40),
    policyVersion: 'v1',
    artifactIds: [],
    summary: 'unit tests passed',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const baseInput = {
  ref: { owner: 'acme', repo: 'widgets' },
  branchName: 'awb/task-1-add-feature',
  worktreePath: '/tmp/worktree',
  baseBranch: 'main',
  objective: 'Add feature X to the widgets page — e.g. show a badge.',
  planSummary: 'Add a badge component and wire it into the widgets page.',
  changedPaths: ['src/widgets/page.tsx'],
  candidateSha: 'a'.repeat(40),
  evidence: [makeEvidence()],
};

describe('deliverToGitHub', () => {
  it('pushes the branch and creates a new draft PR when no existing PR is given', async () => {
    const client = new FakeGitHubClient();
    const pushRunner = new FakeGitPushRunner();

    const result = await deliverToGitHub(baseInput, client, pushRunner);

    expect(result.pushed).toBe(true);
    expect(pushRunner.pushes).toHaveLength(1);
    expect(pushRunner.pushes[0]?.force).toBe(false);
    expect(client.createdPrs).toHaveLength(1);
    expect(client.createdPrs[0]?.headBranch).toBe('awb/task-1-add-feature');
    expect(result.pr.number).toBe(1);
  });

  it('uses a short brief title with no [AWB] prefix', async () => {
    const client = new FakeGitHubClient();
    const pushRunner = new FakeGitPushRunner();

    const result = await deliverToGitHub(baseInput, client, pushRunner);

    expect(result.title).not.toContain('[AWB]');
    expect(result.title).not.toContain('e.g.');
    expect(result.title.length).toBeLessThanOrEqual(72);
    expect(client.createdPrs[0]?.title).toBe(result.title);
  });

  it('renders a templated body (Background/Changes/Test plan) and posts NO comment', async () => {
    const client = new FakeGitHubClient();
    const pushRunner = new FakeGitPushRunner();

    await deliverToGitHub(baseInput, client, pushRunner);

    const body = client.createdPrs[0]?.body ?? '';
    expect(body).toContain('## Background');
    expect(body).toContain('## Changes');
    expect(body).toContain('## Test plan');
    // Evidence is folded into the body's Test plan, not a separate matrix comment.
    expect(body).toContain('unit-test');
    expect(body).toContain('src/widgets/page.tsx');
    expect(client.postedComments).toHaveLength(0);
  });

  it('updates the existing PR instead of creating a new one when existingPrNumber is given', async () => {
    const client = new FakeGitHubClient();
    const pushRunner = new FakeGitPushRunner();

    const result = await deliverToGitHub({ ...baseInput, existingPrNumber: 42 }, client, pushRunner);

    expect(client.createdPrs).toHaveLength(0);
    expect(client.updatedPrs).toHaveLength(1);
    expect(client.updatedPrs[0]?.pullNumber).toBe(42);
    expect(result.pr.number).toBe(42);
  });

  it('force-pushes (with lease) when updating an existing PR, but not on first delivery', async () => {
    const client = new FakeGitHubClient();
    const pushRunner = new FakeGitPushRunner();

    await deliverToGitHub({ ...baseInput, existingPrNumber: 42 }, client, pushRunner);

    expect(pushRunner.pushes[0]?.force).toBe(true);
  });

  it('propagates a push failure without creating a PR', async () => {
    const client = new FakeGitHubClient();
    const pushRunner = new FakeGitPushRunner();
    pushRunner.shouldFail = true;

    await expect(deliverToGitHub(baseInput, client, pushRunner)).rejects.toThrow('simulated push failure');
    expect(client.createdPrs).toHaveLength(0);
  });
});
