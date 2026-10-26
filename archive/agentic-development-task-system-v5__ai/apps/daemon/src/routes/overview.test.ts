import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, upsertTask, repositories, type WorkbenchDatabase } from '@awb/database';
import { registerOverviewRoute } from './overview.js';

describe('GET /api/overview', () => {
  let app: FastifyInstance;
  let database: WorkbenchDatabase;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-overview-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    const iso = new Date().toISOString();
    database.db
      .insert(repositories)
      .values({ id: 'repo-1', canonicalPath: '/tmp/repo', name: 'repo', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: iso, updatedAt: iso })
      .run();
    // A spread of statuses across the derived-status set.
    upsertTask(database.db, { id: 't-run', repositoryId: 'repo-1', prompt: 'running', condition: 'running', phase: 'implement' });
    upsertTask(database.db, { id: 't-gate', repositoryId: 'repo-1', prompt: 'gated', condition: 'awaiting-human', phase: 'implement' });
    upsertTask(database.db, { id: 't-block', repositoryId: 'repo-1', prompt: 'blocked', condition: 'blocked', phase: 'implement' });
    upsertTask(database.db, { id: 't-fail', repositoryId: 'repo-1', prompt: 'failed', condition: 'failed', phase: 'implement' });
    upsertTask(database.db, { id: 't-done', repositoryId: 'repo-1', prompt: 'done', condition: 'completed', phase: 'release' });
    app = Fastify({ logger: false });
    registerOverviewRoute(app, database);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns factory-health counts, the needs-attention set, current-state counts, and recent activity', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.factoryHealth).toMatchObject({
      total: 5,
      running: 1,
      awaitingHuman: 1,
      blocked: 1,
      failed: 1,
      completed: 1,
    });

    // Needs-attention is exactly ATTENTION_STATUSES: awaiting-human, blocked, failed.
    const attentionStatuses = (body.needsAttention as Array<{ derivedStatus: string }>).map((t) => t.derivedStatus).sort();
    expect(attentionStatuses).toEqual(['awaiting-human', 'blocked', 'failed']);

    expect(body.currentState).toMatchObject({
      running: 1,
      'awaiting-human': 1,
      blocked: 1,
      failed: 1,
      completed: 1,
    });

    expect(body.recentActivity).toHaveLength(5);
    expect(body.recentActivity[0]).toHaveProperty('at');
    expect(body.recentActivity[0]).toHaveProperty('repositoryName', 'repo');
  });
});
