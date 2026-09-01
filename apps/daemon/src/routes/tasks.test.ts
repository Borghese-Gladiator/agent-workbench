import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, upsertTask, getTask, repositories, workspaceLeases, type WorkbenchDatabase } from '@awb/database';
import { registerTaskRoutes } from './tasks.js';
import { TaskScheduler } from '../scheduler.js';
import { setTemporalClientForTesting, workflowIdFor } from '../temporal-client.js';

/** A scheduler whose start/hasReleased are no-ops — the signal-route tests don't exercise the DAG. */
function makeStubScheduler(database: WorkbenchDatabase): TaskScheduler {
  return new TaskScheduler({ database, startTask: async () => {}, hasReleased: async () => false });
}

interface RecordedSignal {
  workflowId: string;
  signal: string;
  args: unknown[];
}

function makeStubClient(
  recorded: RecordedSignal[],
  opts: { failWith?: Error; starts?: unknown[][]; queryFailsWith?: Error; queryState?: unknown } = {},
): Client {
  return {
    workflow: {
      async start(_wf: unknown, options: { args: unknown[] }) {
        opts.starts?.push(options.args);
      },
      getHandle(workflowId: string) {
        return {
          async signal(signalDef: { name: string }, ...args: unknown[]) {
            if (opts.failWith) throw opts.failWith;
            recorded.push({ workflowId, signal: signalDef.name, args });
          },
          async query(queryDef: { name: string }) {
            if (opts.queryFailsWith) throw opts.queryFailsWith;
            if (queryDef.name === 'getCurrentState') return opts.queryState ?? {};
            if (queryDef.name === 'getOpenFindings') return [];
            return undefined;
          },
        };
      },
    },
  } as unknown as Client;
}

describe('task PR-lifecycle signal routes', () => {
  let app: FastifyInstance;
  let recorded: RecordedSignal[];
  let dbDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    recorded = [];
    setTemporalClientForTesting(makeStubClient(recorded));
    dbDir = await mkdtemp(join(tmpdir(), 'awb-tasks-route-db-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    const iso = new Date().toISOString();
    database.db
      .insert(repositories)
      .values({ id: 'repo-1', canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: iso, updatedAt: iso })
      .run();
    app = Fastify({ logger: false });
    registerTaskRoutes(app, database, makeStubScheduler(database));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
    setTemporalClientForTesting(undefined);
  });

  it('POST /pr-merged signals pullRequestMerged with the merge SHA', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/repo-1/task-1/pr-merged`,
      payload: { mergeCommitSha: 'abc123' },
    });
    expect(res.statusCode).toBe(200);
    expect(recorded).toEqual([
      { workflowId: workflowIdFor('repo-1', 'task-1'), signal: 'pullRequestMerged', args: [{ mergeCommitSha: 'abc123' }] },
    ]);
  });

  it('POST /pr-closed signals pullRequestClosed', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/tasks/repo-1/task-1/pr-closed` });
    expect(res.statusCode).toBe(200);
    expect(recorded[0]?.signal).toBe('pullRequestClosed');
  });

  it('POST /pr-feedback signals pullRequestFeedbackReceived with the feedback id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/repo-1/task-1/pr-feedback`,
      payload: { feedbackId: 'fb-9' },
    });
    expect(res.statusCode).toBe(200);
    expect(recorded[0]).toMatchObject({ signal: 'pullRequestFeedbackReceived', args: [{ feedbackId: 'fb-9' }] });
  });

  it('POST /pr-feedback-ingest auto-loops a clear defect (classifies + signals)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/repo-1/task-1/pr-feedback-ingest`,
      payload: { feedbackId: 'fb-1', body: 'This is broken — it crashes on empty input.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ category: 'implementation-defect', action: 'auto-loop' });
    expect(recorded[0]).toMatchObject({ signal: 'pullRequestFeedbackReceived', args: [{ feedbackId: 'fb-1' }] });
  });

  it('POST /pr-feedback-ingest gates a question (classifies, no signal)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/repo-1/task-1/pr-feedback-ingest`,
      payload: { feedbackId: 'fb-2', body: 'Why did you use a map here?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ category: 'question', action: 'human-gate' });
    expect(recorded).toHaveLength(0); // gated — no auto-loop signal fired
  });

  it('POST /api/tasks stacks a child on its parent: base = parent delivered branch, in start args + row', async () => {
    const starts: unknown[][] = [];
    setTemporalClientForTesting(makeStubClient(recorded, { starts }));
    // A parent task that already delivered a branch (its workspace lease's branchName).
    upsertTask(database.db, { id: 'task-parent', repositoryId: 'repo-1', prompt: 'parent' });
    database.db
      .insert(workspaceLeases)
      .values({
        id: 'task-parent-lease', repositoryId: 'repo-1', taskId: 'task-parent', baseRef: 'main', baseSha: 'sha',
        branchName: 'awb/task-parent-slug', worktreePath: '/tmp/wt', executionProfile: 'native-trusted',
        allocatedPortsJson: '[]', state: 'active', createdAt: new Date().toISOString(),
      })
      .run();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { repositoryId: 'repo-1', prompt: 'child', parentTaskId: 'task-parent' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().baseBranch).toBe('awb/task-parent-slug');

    // The workflow was started with the resolved base branch...
    expect(starts[0]?.[0]).toMatchObject({ baseBranch: 'awb/task-parent-slug' });
    // ...and the child task row carries the stacking edge.
    const child = res.json().taskId as string;
    expect(getTask(database.db, child)).toMatchObject({
      parentTaskId: 'task-parent',
      baseBranch: 'awb/task-parent-slug',
    });
  });

  it('POST /api/tasks 409s when the parent has no delivered branch yet', async () => {
    setTemporalClientForTesting(makeStubClient(recorded, { starts: [] }));
    upsertTask(database.db, { id: 'task-parent', repositoryId: 'repo-1', prompt: 'parent' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { repositoryId: 'repo-1', prompt: 'child', parentTaskId: 'task-parent' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('no delivered branch');
  });

  it('POST /api/tasks with no parent starts a root task (no baseBranch in args)', async () => {
    const starts: unknown[][] = [];
    setTemporalClientForTesting(makeStubClient(recorded, { starts }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { repositoryId: 'repo-1', prompt: 'root' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().baseBranch).toBeUndefined();
    expect((starts[0]?.[0] as { baseBranch?: string })?.baseBranch).toBeUndefined();
  });

  it('GET /api/tasks reads the projection: additive derived-status/rollup/lineage fields', async () => {
    upsertTask(database.db, { id: 'task-p', repositoryId: 'repo-1', prompt: 'projected', condition: 'awaiting-human', phase: 'implement' });
    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.taskId === 'task-p')!;
    // Base shape preserved…
    expect(row).toMatchObject({ taskId: 'task-p', repositoryId: 'repo-1', prompt: 'projected', repositoryName: 'repo' });
    // …plus the additive projection fields.
    expect(row.derivedStatus).toBe('awaiting-human');
    expect(row).toHaveProperty('attemptCount', 0);
    expect(row).toHaveProperty('openFindingCount', 0);
    expect(row).toHaveProperty('inputTokens', 0);
    expect(row).toHaveProperty('rootTaskId', 'task-p');
    expect(row).toHaveProperty('indexedAt');
  });

  it('POST /api/tasks accepts title + retryOfTaskId and resolves rootTaskId from the parent summary', async () => {
    setTemporalClientForTesting(makeStubClient(recorded, { starts: [] }));
    // An original task whose own root is itself.
    upsertTask(database.db, { id: 'task-orig', repositoryId: 'repo-1', prompt: 'orig' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { repositoryId: 'repo-1', prompt: 'retry', title: 'A retry', retryOfTaskId: 'task-orig' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ retryOfTaskId: 'task-orig', rootTaskId: 'task-orig' });

    const child = res.json().taskId as string;
    expect(getTask(database.db, child)).toMatchObject({
      title: 'A retry',
      retryOfTaskId: 'task-orig',
      rootTaskId: 'task-orig',
    });
  });

  it('POST /api/tasks retry-of-a-retry keeps pointing at the original root', async () => {
    setTemporalClientForTesting(makeStubClient(recorded, { starts: [] }));
    upsertTask(database.db, { id: 'task-root', repositoryId: 'repo-1', prompt: 'root' });
    upsertTask(database.db, { id: 'task-mid', repositoryId: 'repo-1', prompt: 'mid', retryOfTaskId: 'task-root', rootTaskId: 'task-root' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { repositoryId: 'repo-1', prompt: 'again', retryOfTaskId: 'task-mid' },
    });
    expect(res.statusCode).toBe(201);
    // Root resolves through the parent summary's rootTaskId, not the immediate parent.
    expect(res.json()).toMatchObject({ retryOfTaskId: 'task-mid', rootTaskId: 'task-root' });
  });

  it('GET task-state emits a freshness envelope when Temporal is live', async () => {
    setTemporalClientForTesting(makeStubClient(recorded, { queryState: { phase: 'implement', condition: 'running', deliveryState: 'not-started' } }));
    upsertTask(database.db, { id: 'task-live', repositoryId: 'repo-1', prompt: 'live' });
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-live' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.freshness.liveWorkflowAvailable).toBe(true);
    expect(body.freshness).toHaveProperty('indexedAt');
  });

  it('GET task-state stays responsive from the projection when Temporal is degraded (liveUnavailable)', async () => {
    setTemporalClientForTesting(makeStubClient(recorded, { queryFailsWith: new Error('temporal down') }));
    upsertTask(database.db, { id: 'task-deg', repositoryId: 'repo-1', prompt: 'deg', condition: 'awaiting-human', phase: 'implement' });
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-deg' });
    // No 404 — durable fallback keeps the detail page alive.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.freshness.liveWorkflowAvailable).toBe(false);
    expect(body.state).toMatchObject({ condition: 'awaiting-human', phase: 'implement' });
  });

  it('GET task-state 404s only when Temporal is degraded AND there is no projection row', async () => {
    setTemporalClientForTesting(makeStubClient(recorded, { queryFailsWith: new Error('temporal down') }));
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-missing' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the target workflow signal fails', async () => {
    setTemporalClientForTesting(makeStubClient(recorded, { failWith: new Error('workflow not found') }));
    const res = await app.inject({
      method: 'POST',
      url: `/api/tasks/repo-1/task-1/pr-merged`,
      payload: { mergeCommitSha: 'abc123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('workflow not found');
  });
});

describe('POST /api/task-dags (stacked-PR DAG declaration)', () => {
  let app: FastifyInstance;
  let database: WorkbenchDatabase;
  let dbDir: string;
  let started: string[];
  const released = new Set<string>();

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-task-dags-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    const iso = new Date().toISOString();
    database.db
      .insert(repositories)
      .values({ id: 'repo-1', canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: iso, updatedAt: iso })
      .run();
    started = [];
    released.clear();
    const scheduler = new TaskScheduler({
      database,
      startTask: async (input) => {
        started.push(input.taskId);
      },
      hasReleased: async (parentTaskId) => released.has(parentTaskId),
    });
    app = Fastify({ logger: false });
    registerTaskRoutes(app, database, scheduler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('creates a linear chain with only the root started and children blocked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/task-dags',
      payload: {
        repositoryId: 'repo-1',
        nodes: [
          { key: 'a', prompt: 'A' },
          { key: 'b', prompt: 'B', dependsOn: 'a' },
          { key: 'c', prompt: 'C', dependsOn: 'b' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    const byKey = Object.fromEntries(body.tasks.map((t: { key: string }) => [t.key, t]));
    expect(byKey.a.scheduleState).toBe('ready');
    expect(byKey.b.scheduleState).toBe('blocked');
    expect(byKey.c.scheduleState).toBe('blocked');
    // Child edges point at the resolved parent task ids.
    expect(byKey.b.parentTaskId).toBe(byKey.a.taskId);
    expect(byKey.c.parentTaskId).toBe(byKey.b.taskId);
    // Only the root was started (children wait for their parent to release).
    expect(started).toEqual([byKey.a.taskId]);
    // And the persisted rows carry the edges.
    expect(getTask(database.db, byKey.b.taskId)?.parentTaskId).toBe(byKey.a.taskId);
  });

  it('rejects a cyclic spec and writes nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/task-dags',
      payload: {
        repositoryId: 'repo-1',
        nodes: [
          { key: 'a', prompt: 'A', dependsOn: 'b' },
          { key: 'b', prompt: 'B', dependsOn: 'a' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cycle/);
    expect(started).toHaveLength(0);
  });
});
