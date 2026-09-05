import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createDatabase,
  upsertTask,
  persistPhaseObservability,
  repositories,
  type WorkbenchDatabase,
} from '@awb/database';
import { registerTimelineRoute } from './timeline.js';

const now = '2026-09-04T00:00:00.000Z';

const ZERO = {
  environmentSetupMs: 0,
  dependencyInstallMs: 0,
  modelWaitMs: 0,
  modelGenerationMs: 0,
  toolExecutionMs: 0,
  testExecutionMs: 0,
  serviceStartupMs: 0,
  qaExecutionMs: 0,
  artifactProcessingMs: 0,
  githubOperationMs: 0,
  humanWaitMs: 0,
  retryBackoffMs: 0,
};

describe('GET /api/tasks/:repositoryId/:taskId/timeline', () => {
  let app: FastifyInstance;
  let database: WorkbenchDatabase;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-timeline-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    database.db
      .insert(repositories)
      .values({ id: 'repo-1', canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
    upsertTask(database.db, { id: 'task-1', repositoryId: 'repo-1', prompt: 'p' });
    persistPhaseObservability(database.db, {
      taskId: 'task-1',
      runId: 'task-1-run',
      phaseAttemptId: 'task-1-exercise-1',
      phase: 'exercise',
      attemptNumber: 1,
      runtimeAttribution: { ...ZERO, qaExecutionMs: 9000, modelGenerationMs: 1000 },
      sessions: [],
      startedAt: now,
      endedAt: '2026-09-04T00:00:10.000Z',
      outcome: 'candidate',
    });
    app = Fastify({ logger: false });
    registerTimelineRoute(app, database);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns the phase durations, outcomes and attribution without touching Temporal', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-1/timeline' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.taskId).toBe('task-1');
    expect(body.phases).toHaveLength(1);
    expect(body.phases[0]).toMatchObject({ phase: 'exercise', durationMs: 10_000, outcome: 'candidate' });
    expect(body.phases[0].runtimeAttribution.qaExecutionMs).toBe(9000);
    expect(body.totals.qaExecutionMs).toBe(9000);
    expect(body.longestPhase).toEqual({ phase: 'exercise', attemptNumber: 1, durationMs: 10_000 });
  });

  it('404s for a task with no recorded phase attempts', async () => {
    upsertTask(database.db, { id: 'task-empty', repositoryId: 'repo-1', prompt: 'e' });
    const res = await app.inject({ method: 'GET', url: '/api/tasks/repo-1/task-empty/timeline' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('task-empty');
  });
});
