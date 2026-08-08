import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  createDatabase,
  repositories,
  getTask,
  getContract,
  listEvidenceByTask,
  listArtifactsByTask,
  listSemanticEventsAfter,
  type WorkbenchDatabase,
} from '@awb/database';
import type { RunStateSnapshot, SemanticEvent } from '@awb/domain';
import { registerInternalRoutes } from './internal.js';
import { SemanticEventBus } from '../event-bus.js';

const REPO_ID = 'repo-1';
const TASK_ID = 'task-1';

function seedRepo(db: WorkbenchDatabase): void {
  const now = new Date().toISOString();
  db.db
    .insert(repositories)
    .values({
      id: REPO_ID,
      canonicalPath: '/tmp/repo',
      name: 'repo',
      remoteUrl: null,
      defaultBranch: 'main',
      trusted: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe('internal worker→daemon routes', () => {
  let app: FastifyInstance;
  let database: WorkbenchDatabase;
  let eventBus: SemanticEventBus;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-internal-db-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seedRepo(database);
    eventBus = new SemanticEventBus();
    app = Fastify({ logger: false });
    registerInternalRoutes(app, database, eventBus);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('PUT /internal/tasks upserts a task row', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/internal/tasks/${TASK_ID}`,
      payload: { repositoryId: REPO_ID, prompt: 'do the thing', phase: 'verify' },
    });
    expect(res.statusCode).toBe(200);
    expect(getTask(database.db, TASK_ID)?.phase).toBe('verify');
  });

  it('PUT /internal/run-state persists contract + evidence + artifacts', async () => {
    const snapshot: RunStateSnapshot = {
      taskId: TASK_ID,
      repositoryId: REPO_ID,
      prompt: 'do the thing',
      contract: {
        id: 'contract-1',
        taskId: TASK_ID,
        version: 1,
        objective: 'obj',
        problemStatement: 'problem',
        constraints: [],
        nonGoals: [],
        risk: 'low',
        size: 'M',
        claims: [],
        status: 'approved',
      },
      verificationEvidence: [
        {
          id: 'ev-1',
          taskId: TASK_ID,
          runId: `${TASK_ID}-run`,
          phaseAttemptId: `${TASK_ID}-verify-1`,
          kind: 'unit-test',
          status: 'passed',
          claimIds: [],
          contractVersion: 1,
          repositorySnapshotId: 'snap-1',
          candidateSha: 'b'.repeat(40),
          policyVersion: 'v1',
          artifactIds: [],
          summary: 'green',
          createdAt: new Date().toISOString(),
        },
      ],
      qaEvidence: [],
      reviewFindings: [],
      artifacts: [
        {
          id: 'art-1',
          sha256: 'c'.repeat(64),
          mediaType: 'text/plain',
          byteSize: 10,
          relativePath: 'sha256/cc/' + 'c'.repeat(64),
          taskId: TASK_ID,
          kind: 'test-report',
          retention: 'task',
          createdAt: new Date().toISOString(),
        },
      ],
    };

    const res = await app.inject({ method: 'PUT', url: `/internal/run-state/${TASK_ID}`, payload: snapshot });
    expect(res.statusCode).toBe(200);
    expect(getContract(database.db, 'contract-1')?.objective).toBe('obj');
    expect(listEvidenceByTask(database.db, TASK_ID)).toHaveLength(1);
    expect(listArtifactsByTask(database.db, TASK_ID)).toHaveLength(1);
  });

  it('PUT /internal/run-state rejects a mismatched taskId', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/internal/run-state/${TASK_ID}`,
      payload: { taskId: 'other', repositoryId: REPO_ID, verificationEvidence: [], qaEvidence: [], reviewFindings: [], artifacts: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /internal/events persists and publishes to the bus', async () => {
    // The task row must exist first (runs → tasks FK); the worker persists it before events flow.
    await app.inject({
      method: 'PUT',
      url: `/internal/tasks/${TASK_ID}`,
      payload: { repositoryId: REPO_ID, prompt: 'p' },
    });
    const event: SemanticEvent = {
      id: 'evt-1',
      runId: `${TASK_ID}-run`,
      sequence: 0,
      occurredAt: new Date().toISOString(),
      phase: 'plan',
      phaseAttemptId: `${TASK_ID}-plan-1`,
      producer: 'planner',
      type: 'message',
      summary: 'hello',
    };
    const published: SemanticEvent[] = [];
    eventBus.subscribe((e) => published.push(e));

    const res = await app.inject({ method: 'POST', url: '/internal/events', payload: event });
    expect(res.statusCode).toBe(200);
    expect(published).toEqual([event]);
    expect(listSemanticEventsAfter(database.db, `${TASK_ID}-run`, -1)).toEqual([event]);
  });

  it('POST /internal/events rejects an invalid event', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/events', payload: { not: 'an event' } });
    expect(res.statusCode).toBe(400);
  });
});
