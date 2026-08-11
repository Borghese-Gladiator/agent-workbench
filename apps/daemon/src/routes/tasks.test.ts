import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, upsertTask, getTask, repositories, workspaceLeases, type WorkbenchDatabase } from '@awb/database';
import { registerTaskRoutes } from './tasks.js';
import { setTemporalClientForTesting, workflowIdFor } from '../temporal-client.js';

interface RecordedSignal {
  workflowId: string;
  signal: string;
  args: unknown[];
}

function makeStubClient(recorded: RecordedSignal[], opts: { failWith?: Error; starts?: unknown[][] } = {}): Client {
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
    registerTaskRoutes(app, database);
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
