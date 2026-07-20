import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunInput, AgentRuntimeAdapter } from '@workbench/agents';
import type { DeliveryAdapter } from '@workbench/delivery';
import { Store } from '@workbench/store';
import { GitWorktreeProvider } from '@workbench/worktree';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

/**
 * Fast fake agent: the `claude` runtime here only exists to drive the real git
 * worktree provider, not the agent. Without it the lifecycle's agent stages
 * would shell out to the real `claude` CLI and hang.
 */
const fakeAgent = (onStage?: (stage: string) => void): AgentRuntimeAdapter => ({
  async runStageAgent(input: AgentRunInput) {
    onStage?.(input.stage);
    // The feature_e2e gate reads the Playwright JSON verdict from results.json;
    // a fake QA run must write a passing one or the stage correctly parks.
    if (input.stage === 'feature_e2e' && input.env?.QA_OUTPUT_DIR) {
      mkdirSync(input.env.QA_OUTPUT_DIR, { recursive: true });
      writeFileSync(
        join(input.env.QA_OUTPUT_DIR, 'results.json'),
        JSON.stringify({ stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 } }),
      );
    }
    return {
      status: 'succeeded' as const,
      transcript: { kind: 'log' as const, title: 'run', body: 'fake transcript' },
      produced: [{ kind: 'log' as const, title: `${input.stage}`, body: `fake ${input.stage}` }],
    };
  },
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

let store: Store;
let artifactsDir: string;
let worktreesDir: string;
let repo: string;

beforeEach(() => {
  artifactsDir = mkdtempSync(join(tmpdir(), 'wb-art-'));
  worktreesDir = mkdtempSync(join(tmpdir(), 'wb-wt-'));
  repo = mkdtempSync(join(tmpdir(), 'wb-repo-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  store = new Store({ dbPath: ':memory:', artifactsDir });
});
afterEach(() => {
  store.close();
  for (const d of [artifactsDir, worktreesDir, repo]) rmSync(d, { recursive: true, force: true });
});

/** Build an app with the given delivery adapter and drive a task to the delivery gate. */
async function driveToDeliveryGate(
  delivery: DeliveryAdapter,
  opts: {
    skipWorktree?: boolean;
    deliveryPolicy?: 'create_pr' | 'merge_to_master';
    onStage?: (stage: string) => void;
  } = {},
) {
  const app = createApp(store, {
    worktrees: new GitWorktreeProvider(),
    worktreesDir,
    delivery,
    agentFor: () => fakeAgent(opts.onStage),
  });
  const p = await request(app)
    // 'claude' runtime so the real GitWorktreeProvider drives the worktree (the
    // mock default would route to the stub and skip real git).
    .post('/api/projects')
    .send({
      name: 'Demo',
      repoPath: repo,
      defaultBranch: 'main',
      deliveryPolicy: opts.deliveryPolicy ?? 'create_pr',
      agentRuntime: 'claude',
    });
  const t = await request(app)
    .post('/api/tasks')
    .send({ projectId: p.body.id, title: 'Add Dark Mode', rawRequest: 'r' });
  const id = t.body.id as string;
  await request(app).post(`/api/tasks/${id}/generate-brief`).send({});
  await request(app)
    .post(`/api/tasks/${id}/approve-brief`)
    .send(opts.skipWorktree ? { skipWorktree: true } : {});
  await request(app).post(`/api/tasks/${id}/approve-plan`).send({});
  const review = await request(app).post(`/api/tasks/${id}/review/complete`).send({});
  expect(review.body.stage).toBe('human_delivery_approval');
  return { app, id };
}

// Real-git delivery integration (worktree + commit/merge + a lifecycle walk):
// runs longer than a unit test and must not race vitest's 5s default under
// parallel-worker CPU pressure. 30s headroom.
describe('delivery in the lifecycle', { timeout: 30_000 }, () => {
  it('publishes on delivery approval and records the PR URL on the package', async () => {
    const publish = vi.fn(async () => ({
      status: 'published' as const,
      url: 'https://github.com/acme/repo/pull/7',
      summary: 'Opened PR',
    }));
    const { app, id } = await driveToDeliveryGate({ publish });

    const closed = await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});
    expect(closed.body.stage).toBe('closeout');
    expect(closed.body.status).toBe('done');

    // The adapter ran against the task's real worktree branch.
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({
      target: 'Add Dark Mode',
      policy: 'create_pr',
      baseBranch: 'main',
    });

    const detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.delivery.status).toBe('published');
    expect(detail.body.delivery.prUrl).toBe('https://github.com/acme/repo/pull/7');
  });

  it('threads the REAL delivery_prep artifact as the PR body (not the mock template)', async () => {
    // delivery_prep now runs the agent (pr-description skill) on the claude runtime;
    // its produced artifact — not the static `(mock)` template — must become the PR
    // body handed to the delivery adapter.
    const publish = vi.fn(async () => ({
      status: 'published' as const,
      url: 'https://github.com/acme/repo/pull/9',
      summary: 'Opened PR',
    }));
    const { app, id } = await driveToDeliveryGate({ publish });

    // The package is registered against a produced artifact (not synthesized inline).
    const detail = await request(app).get(`/api/tasks/${id}`);
    const pkgArtifactId = detail.body.delivery.artifactId as string | null;
    expect(pkgArtifactId).toBeTruthy();
    expect(detail.body.artifacts.some((a: { id: string }) => a.id === pkgArtifactId)).toBe(true);

    await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});
    // The PR body handed to the delivery adapter is the REAL produced artifact (the
    // fake agent writes "fake delivery_prep"), NOT the static `(mock)` template.
    expect(publish.mock.calls[0][0].description).toContain('fake delivery_prep');
    expect(publish.mock.calls[0][0].description).not.toContain('(mock)');
  });

  it('skip-worktree: commits directly on the project default branch (repoPath/main)', async () => {
    const publish = vi.fn(async () => ({
      status: 'published' as const,
      url: null,
      summary: '(dry-run) committed main',
    }));
    const { app, id } = await driveToDeliveryGate({ publish }, { skipWorktree: true });

    const closed = await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});
    expect(closed.body.status).toBe('done');

    // Direct mode publishes against the project checkout on its default branch,
    // NOT a per-task worktree branch — i.e. commits land directly on main.
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({ cwd: repo, branch: 'main' });
  });

  it('passes the project delivery policy independent of worktree mode', async () => {
    // A worktree task (feature branch) carrying a merge_to_master policy: the
    // branch resolution and the delivery action are decided independently.
    const publish = vi.fn(async () => ({
      status: 'published' as const,
      url: null,
      summary: 'Merged',
    }));
    const { app, id } = await driveToDeliveryGate(
      { publish },
      { deliveryPolicy: 'merge_to_master' },
    );

    await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});

    const call = publish.mock.calls[0][0];
    expect(call.policy).toBe('merge_to_master');
    // cwd/branch still come from the per-task worktree, not the project checkout.
    expect(call.cwd).not.toBe(repo);
    // The per-task feature branch (`<slug>-<short-id>`), not the default branch.
    expect(call.branch).not.toBe('main');
    expect(call.branch).toMatch(/-[A-Za-z0-9_-]+$/);
  });

  it('merge_to_master skips the delivery_prep agent run and synthesizes the package from artifacts', async () => {
    // The work lands as one squash commit nobody reviews on a PR page, so a fresh
    // diff-reading agent run to write the body is wasted latency. delivery_prep
    // must NOT invoke the agent for merge_to_master — yet still register a
    // non-blank delivery package (so the gate has something to show).
    const stages: string[] = [];
    const publish = vi.fn(async () => ({
      status: 'published' as const,
      url: null,
      conflicts: [],
      summary: 'Merged',
    }));
    const { app, id } = await driveToDeliveryGate(
      { publish },
      { deliveryPolicy: 'merge_to_master', onStage: (s) => stages.push(s) },
    );

    // The agent ran for the earlier stages but NOT for delivery_prep.
    expect(stages).not.toContain('delivery_prep');

    // A package is still registered against a real (synthesized) artifact.
    const detail = await request(app).get(`/api/tasks/${id}`);
    const pkgArtifactId = detail.body.delivery.artifactId as string | null;
    expect(pkgArtifactId).toBeTruthy();
    expect(detail.body.artifacts.some((a: { id: string }) => a.id === pkgArtifactId)).toBe(true);
  });

  it('create_pr still runs the delivery_prep agent (PR body is human-reviewed)', async () => {
    const stages: string[] = [];
    const publish = vi.fn(async () => ({
      status: 'published' as const,
      url: 'https://github.com/acme/repo/pull/11',
      summary: 'Opened PR',
    }));
    await driveToDeliveryGate({ publish }, { onStage: (s) => stages.push(s) });

    expect(stages).toContain('delivery_prep');
  });

  it('a failed publish blocks delivery (409) and stays at the gate — no false-success closeout', async () => {
    // A live run reached `done` with nothing delivered (squash-merge failed
    // inside the task worktree). Failure must park at the gate for a retry,
    // exactly like an unresolved conflict.
    const publish = vi.fn(async () => ({
      status: 'failed' as const,
      url: null,
      conflicts: [],
      summary: 'gh: not authenticated',
    }));
    const { app, id } = await driveToDeliveryGate({ publish });

    const res = await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});
    expect(res.status).toBe(409);

    const detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.task.stage).toBe('human_delivery_approval'); // still at the gate
    expect(detail.body.delivery.status).toBe('prepared'); // not published
    expect(detail.body.delivery.summary).toContain('not authenticated');
  });

  it('resolves a merge conflict with the agent, then re-attempts and publishes', async () => {
    // First publish reports a conflict; after the agent resolves it, the retry
    // publishes. The fake agent (claude runtime) stands in for the resolution run.
    const publish = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'conflict' as const,
        url: null,
        conflicts: ['src/a.ts'],
        summary: 'conflicts with main in 1 file(s): src/a.ts.',
      })
      .mockResolvedValueOnce({
        status: 'published' as const,
        url: null,
        conflicts: [],
        summary: 'Squash-merged into main.',
      });
    const { app, id } = await driveToDeliveryGate(
      { publish },
      { deliveryPolicy: 'merge_to_master' },
    );

    const closed = await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});
    expect(closed.body.status).toBe('done'); // advanced to closeout after retry
    expect(publish).toHaveBeenCalledTimes(2); // initial + post-resolution retry

    const detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.delivery.status).toBe('published');
  });

  it('an unresolved conflict blocks delivery (409) and stays at the gate', async () => {
    // Every publish reports a conflict — even after the agent runs — so the task
    // must NOT advance; it waits at the delivery gate for manual resolution.
    const publish = vi.fn(async () => ({
      status: 'conflict' as const,
      url: null,
      conflicts: ['src/a.ts', 'src/b.ts'],
      summary: 'conflicts with main in 2 file(s): src/a.ts, src/b.ts.',
    }));
    const { app, id } = await driveToDeliveryGate(
      { publish },
      { deliveryPolicy: 'merge_to_master' },
    );

    const res = await request(app).post(`/api/tasks/${id}/approve-delivery`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.message ?? JSON.stringify(res.body)).toContain('src/a.ts');

    const detail = await request(app).get(`/api/tasks/${id}`);
    expect(detail.body.task.stage).toBe('human_delivery_approval'); // still at the gate
    expect(detail.body.delivery.status).toBe('prepared'); // not published
  });
});
