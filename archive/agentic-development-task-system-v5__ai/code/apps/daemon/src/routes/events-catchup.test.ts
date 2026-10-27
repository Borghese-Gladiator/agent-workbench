import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { createDatabase, repositories, upsertTask, insertSemanticEvent, type WorkbenchDatabase } from '@awb/database';
import type { SemanticEvent } from '@awb/domain';
import { registerWebSocketRoute } from './websocket.js';
import { SemanticEventBus } from '../event-bus.js';

const REPO_ID = 'repo-1';
const TASK_ID = 'task-1';
const RUN_ID = `${TASK_ID}-run`;

let nextId = 0;
function event(): SemanticEvent {
  const id = nextId++;
  return {
    id: `evt-${id}`,
    runId: RUN_ID,
    sequence: 0, // daemon assigns the authoritative sequence on insert
    occurredAt: new Date().toISOString(),
    phase: 'plan',
    phaseAttemptId: `${TASK_ID}-plan-1`,
    producer: 'planner',
    type: 'message',
    summary: `event ${id}`,
  };
}

describe('GET /api/events reconnect catch-up (§31)', () => {
  let app: FastifyInstance;
  let database: WorkbenchDatabase;
  let dbDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-catchup-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    const now = new Date().toISOString();
    database.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/r', name: 'r', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
    upsertTask(database.db, { id: TASK_ID, repositoryId: REPO_ID, prompt: 'p' });
    // The daemon assigns sequence on insert; three distinct events yield 0,1,2.
    nextId = 0;
    insertSemanticEvent(database.db, event());
    insertSemanticEvent(database.db, event());
    insertSemanticEvent(database.db, event());

    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerWebSocketRoute(app, new SemanticEventBus(), database);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('returns all events after -1 (full history), in order', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/events?runId=${RUN_ID}&afterSequence=-1` });
    expect(res.statusCode).toBe(200);
    const { events } = res.json();
    expect(events.map((e: SemanticEvent) => e.sequence)).toEqual([0, 1, 2]);
  });

  it('returns only the tail after a given sequence (the reconnect case)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/events?runId=${RUN_ID}&afterSequence=0` });
    const { events } = res.json();
    expect(events.map((e: SemanticEvent) => e.sequence)).toEqual([1, 2]);
  });

  it('400s without a runId', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/events?afterSequence=0` });
    expect(res.statusCode).toBe(400);
  });
});
