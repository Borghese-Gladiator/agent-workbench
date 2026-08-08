import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositories } from '@awb/database';
import { buildServer, type DaemonServer } from '../server.js';
import { setTemporalClientForTesting } from '../temporal-client.js';
import { taskQueueName } from '../temporal-worker-constants.js';
// Import the real runPhase + syncTaskState Activities from the worker's built output, mirroring
// run-phase-e2e.test.ts. syncTaskState must be registered or the workflow stalls on its proxy call.
import { runPhase, syncTaskState } from '../../../../workers/temporal-worker/dist/activities/run-phase.js';

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'awb-daemon-e2e-repo-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# fixture for daemon completion e2e\n');
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

async function poll(check: () => Promise<boolean>, timeoutMs = 30_000, intervalMs = 150): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('poll timed out');
}

let testEnv: TestWorkflowEnvironment;
let repoDir: string;
let dataDir: string;
let server: DaemonServer;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal();
  repoDir = await makeTempRepo();
  process.env.AWB_RUN_PHASE_FIXTURE_REPO = repoDir;

  dataDir = await mkdtemp(join(tmpdir(), 'awb-daemon-e2e-data-'));
  process.env.AWB_DATA_DIR = dataDir;

  // Point the daemon's routes at the test environment's Temporal client, so route code runs
  // against a real workflow with no separately running Temporal server.
  setTemporalClientForTesting(testEnv.client);
  server = await buildServer();

  // The tasks row now FK-references repositories. Seed the repo row the task
  // is created under so `POST /api/tasks` can persist its durable task row. The workflow resolves the
  // fixture repo path from AWB_RUN_PHASE_FIXTURE_REPO, so the id just needs to satisfy the FK.
  const now = new Date().toISOString();
  server.database.db
    .insert(repositories)
    .values({
      id: 'daemon-e2e-repo',
      canonicalPath: repoDir,
      name: 'daemon-e2e-repo',
      remoteUrl: null,
      defaultBranch: 'main',
      trusted: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}, 60_000);

afterAll(async () => {
  await server?.close();
  setTemporalClientForTesting(undefined);
  await testEnv?.teardown();
  delete process.env.AWB_DATA_DIR;
  delete process.env.AWB_RUN_PHASE_FIXTURE_REPO;
  await rm(dataDir, { recursive: true, force: true });
  await rm(repoDir, { recursive: true, force: true });
});

describe('daemon routes drive a task to completion', () => {
  it('create -> approve-contract -> pr-merged, entirely over HTTP, reaches assimilate/merged', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: taskQueueName(),
      workflowsPath: new URL('../../../../packages/workflow/dist/task-workflow.js', import.meta.url).pathname,
      activities: { runPhase, syncTaskState },
    });

    const result = await worker.runUntil(async () => {
      const repositoryId = 'daemon-e2e-repo';

      const createRes = await server.app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { repositoryId, prompt: 'do the thing' },
      });
      expect(createRes.statusCode).toBe(201);
      const { taskId } = createRes.json();

      const base = `/api/tasks/${repositoryId}/${taskId}`;

      await poll(async () => {
        const show = await server.app.inject({ method: 'GET', url: base });
        const body = show.json();
        return body.state?.phase === 'specify' && body.state?.condition === 'awaiting-human';
      });

      const approve = await server.app.inject({
        method: 'POST',
        url: `${base}/approve-contract`,
        payload: { contractVersion: 1 },
      });
      expect(approve.statusCode).toBe(200);

      await poll(async () => {
        const show = await server.app.inject({ method: 'GET', url: base });
        const body = show.json();
        return body.state?.phase === 'release' && body.state?.condition === 'awaiting-human';
      }, 40_000);

      const merged = await server.app.inject({
        method: 'POST',
        url: `${base}/pr-merged`,
        payload: { mergeCommitSha: 'daemon-e2e-merge-sha' },
      });
      expect(merged.statusCode).toBe(200);

      // Wait for the terminal condition, not just the phase: the workflow reaches `assimilate` a
      // beat before it sets `condition: 'completed'` (the completion transition + its state sync are
      // awaited steps), so polling on phase alone can observe the intermediate `running`.
      await poll(async () => {
        const show = await server.app.inject({ method: 'GET', url: base });
        const s = show.json().state;
        return s?.phase === 'assimilate' && s?.condition === 'completed';
      });

      const final = await server.app.inject({ method: 'GET', url: base });
      return final.json();
    });

    expect(result.state.phase).toBe('assimilate');
    expect(result.state.condition).toBe('completed');
    expect(result.state.deliveryState).toBe('merged');
  }, 90_000);

  it('DELETE removes a task (terminating its workflow) and drops it from the list (TASK-37)', async () => {
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: taskQueueName(),
      workflowsPath: new URL('../../../../packages/workflow/dist/task-workflow.js', import.meta.url).pathname,
      activities: { runPhase, syncTaskState },
    });

    await worker.runUntil(async () => {
      const repositoryId = 'daemon-e2e-repo';
      const createRes = await server.app.inject({
        method: 'POST',
        url: '/api/tasks',
        payload: { repositoryId, prompt: 'delete me' },
      });
      const { taskId } = createRes.json();

      // Let the workflow persist at least the task row before we delete (it's created synchronously).
      await poll(async () => {
        const list = await server.app.inject({ method: 'GET', url: '/api/tasks' });
        return list.json().some((t: { taskId: string }) => t.taskId === taskId);
      });

      const del = await server.app.inject({ method: 'DELETE', url: `/api/tasks/${repositoryId}/${taskId}` });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ removed: taskId });

      const list = await server.app.inject({ method: 'GET', url: '/api/tasks' });
      expect(list.json().some((t: { taskId: string }) => t.taskId === taskId)).toBe(false);

      // Deleting again is a 404 — the row is gone.
      const again = await server.app.inject({ method: 'DELETE', url: `/api/tasks/${repositoryId}/${taskId}` });
      expect(again.statusCode).toBe(404);
    });
  }, 60_000);
});
