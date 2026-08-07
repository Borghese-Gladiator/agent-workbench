import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, repositories, upsertTask, insertArtifact, type WorkbenchDatabase } from '@awb/database';
import type { ArtifactRecord } from '@awb/domain';
import { registerMediaRoutes } from './media.js';

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

/** Writes a blob at the content-addressed path the ArtifactStore expects and inserts its row. */
async function seedArtifact(
  db: WorkbenchDatabase,
  artifactsDir: string,
  overrides: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'id' | 'sha256' | 'kind' | 'mediaType'>,
  bytes: Buffer,
): Promise<void> {
  const record: ArtifactRecord = {
    byteSize: bytes.length,
    relativePath: join('sha256', overrides.sha256.slice(0, 2), overrides.sha256),
    taskId: TASK_ID,
    retention: 'task',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as ArtifactRecord;
  const dir = join(artifactsDir, 'sha256', record.sha256.slice(0, 2));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, record.sha256), bytes);
  insertArtifact(db.db, record);
}

describe('media routes', () => {
  let app: FastifyInstance;
  let database: WorkbenchDatabase;
  let dbDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-media-db-'));
    artifactsDir = await mkdtemp(join(tmpdir(), 'awb-media-art-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seedRepo(database);
    upsertTask(database.db, { id: TASK_ID, repositoryId: REPO_ID, prompt: 'p' });
    app = Fastify({ logger: false });
    registerMediaRoutes(app, database, artifactsDir);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    database.close();
    await rm(dbDir, { recursive: true, force: true });
    await rm(artifactsDir, { recursive: true, force: true });
  });

  it('lists a task’s playable QA-media artifacts, newest first', async () => {
    await seedArtifact(
      database,
      artifactsDir,
      { id: 'gif-1', sha256: 'a'.repeat(64), kind: 'qa-video-gif', mediaType: 'image/gif', createdAt: '2026-01-02T00:00:00Z' },
      Buffer.from('GIF89a'),
    );
    await seedArtifact(
      database,
      artifactsDir,
      { id: 'webm-1', sha256: 'b'.repeat(64), kind: 'qa-video', mediaType: 'video/webm', createdAt: '2026-01-01T00:00:00Z' },
      Buffer.from('webmbytes'),
    );
    // A non-playable artifact must be filtered out.
    await seedArtifact(
      database,
      artifactsDir,
      { id: 'log-1', sha256: 'c'.repeat(64), kind: 'command-log', mediaType: 'text/plain', createdAt: '2026-01-03T00:00:00Z' },
      Buffer.from('log'),
    );

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${REPO_ID}/${TASK_ID}/media` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; kind: string }[];
    expect(body.map((m) => m.id)).toEqual(['gif-1', 'webm-1']);
    expect(body.find((m) => m.kind === 'command-log')).toBeUndefined();
  });

  it('streams an artifact’s bytes with its real content-type', async () => {
    await seedArtifact(
      database,
      artifactsDir,
      { id: 'gif-1', sha256: 'd'.repeat(64), kind: 'qa-video-gif', mediaType: 'image/gif' },
      Buffer.from('GIF89a-bytes'),
    );

    const res = await app.inject({ method: 'GET', url: `/api/artifacts/gif-1/content` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/gif');
    expect(res.body).toBe('GIF89a-bytes');
  });

  it('404s for an unknown artifact', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/artifacts/nope/content` });
    expect(res.statusCode).toBe(404);
  });
});
