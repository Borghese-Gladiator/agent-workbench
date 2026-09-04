import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createDatabase,
  upsertTask,
  ensureRun,
  ensurePhaseAttempt,
  repositories,
  agentSessions,
  modelInvocations,
  persistPhaseObservability,
  type WorkbenchDatabase,
} from '@awb/database';
import { registerExecutionTreeRoute } from './execution-tree.js';

const now = '2026-08-17T00:00:00.000Z';

describe('GET /api/tasks/:repositoryId/:taskId/execution-tree', () => {
  let app: FastifyInstance;
  let database: WorkbenchDatabase;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-exec-tree-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    database.db
      .insert(repositories)
      .values({ id: 'repo-1', canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
    upsertTask(database.db, { id: 'task-1', repositoryId: 'repo-1', prompt: 'p' });
    const runId = ensureRun(database.db, 'task-1');
    const attemptId = ensurePhaseAttempt(database.db, { taskId: 'task-1', phase: 'implement', attemptNumber: 1 });
    database.db
      .insert(agentSessions)
      .values({ id: 'sess-1', taskId: 'task-1', runId, phaseAttemptId: attemptId, phase: 'implement', runtime: 'claude', model: 'opus', startedAt: now })
      .run();
    database.db
      .insert(modelInvocations)
      .values({ id: 'mi-1', agentSessionId: 'sess-1', provider: 'anthropic', model: 'opus', inputTokens: 100, outputTokens: 50, startedAt: now })
      .run();
    app = Fastify({ logger: false });
    registerExecutionTreeRoute(app, database);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('assembles phase attempts → agent sessions → model invocations', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-1/execution-tree' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.taskId).toBe('task-1');
    expect(body.phaseAttempts).toHaveLength(1);
    const attempt = body.phaseAttempts[0];
    expect(attempt.phase).toBe('implement');
    expect(attempt.sessions).toHaveLength(1);
    expect(attempt.sessions[0].id).toBe('sess-1');
    expect(attempt.sessions[0].invocations).toHaveLength(1);
    expect(attempt.sessions[0].invocations[0]).toMatchObject({ id: 'mi-1', inputTokens: 100, outputTokens: 50 });
    expect(attempt.sessions[0].contextComposition).toBeNull();
  });

  it('joins runtime attribution and a duration onto each phase attempt (TASK-124)', async () => {
    persistPhaseObservability(database.db, {
      taskId: 'task-1',
      runId: 'task-1-run',
      phaseAttemptId: 'task-1-implement-1',
      phase: 'implement',
      attemptNumber: 1,
      runtimeAttribution: {
        environmentSetupMs: 0,
        dependencyInstallMs: 3000,
        modelWaitMs: 0,
        modelGenerationMs: 12_000,
        toolExecutionMs: 0,
        testExecutionMs: 4000,
        serviceStartupMs: 0,
        qaExecutionMs: 0,
        artifactProcessingMs: 0,
        githubOperationMs: 0,
        humanWaitMs: 0,
        retryBackoffMs: 0,
      },
      sessions: [],
      startedAt: '2026-08-17T00:00:00.000Z',
      endedAt: '2026-08-17T00:00:20.000Z',
      outcome: 'candidate',
    });

    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-1/execution-tree' });
    const attempt = res.json().phaseAttempts[0];
    expect(attempt.durationMs).toBe(20_000);
    expect(attempt.outcome).toBe('candidate');
    expect(attempt.runtimeAttribution).toMatchObject({
      modelGenerationMs: 12_000,
      testExecutionMs: 4000,
      dependencyInstallMs: 3000,
    });
  });

  it('reports a null duration and attribution for an attempt that never closed', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-1/execution-tree' });
    const attempt = res.json().phaseAttempts[0];
    expect(attempt.durationMs).toBeNull();
    expect(attempt.runtimeAttribution).toBeNull();
    expect(attempt.sessions[0].durationMs).toBeNull();
  });

  it('returns an empty tree for a task with no observability', async () => {
    upsertTask(database.db, { id: 'task-empty', repositoryId: 'repo-1', prompt: 'empty' });
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-empty/execution-tree' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ taskId: 'task-empty', phaseAttempts: [] });
  });
});
