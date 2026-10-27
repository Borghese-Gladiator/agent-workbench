import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArtifactMetadataStore } from '@awb/evidence';
import { InMemoryArtifactMetadataStore } from '@awb/evidence';
import type { ArtifactRecord } from '@awb/domain';
import { createDatabase, repositories, type WorkbenchDatabase } from '../index.js';
import { upsertTask } from './tasks.js';
import { SqliteArtifactMetadataStore } from './artifact-metadata-store.js';

function seedTasks(database: WorkbenchDatabase): void {
  const now = new Date().toISOString();
  database.db
    .insert(repositories)
    .values({
      id: 'repo-1',
      canonicalPath: '/tmp/repo',
      name: 'repo',
      remoteUrl: null,
      defaultBranch: 'main',
      trusted: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  upsertTask(database.db, { id: 'task-1', repositoryId: 'repo-1', prompt: 'p' });
  upsertTask(database.db, { id: 'task-2', repositoryId: 'repo-1', prompt: 'p' });
}

const record = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  id: 'art-1',
  sha256: 'a'.repeat(64),
  mediaType: 'text/plain',
  byteSize: 5,
  relativePath: 'sha256/aa/' + 'a'.repeat(64),
  taskId: 'task-1',
  candidateSha: 'b'.repeat(40),
  kind: 'command-log',
  retention: 'task',
  createdAt: new Date().toISOString(),
  ...over,
});

// The SQLite store and the in-memory store must be behaviorally identical for the ArtifactStore.
describe.each<{ name: string }>([{ name: 'in-memory' }, { name: 'sqlite' }])(
  'ArtifactMetadataStore ($name)',
  ({ name }) => {
    let store: ArtifactMetadataStore;
    let dbDir: string | undefined;
    let database: WorkbenchDatabase | undefined;

    beforeEach(async () => {
      if (name === 'sqlite') {
        dbDir = await mkdtemp(join(tmpdir(), 'awb-artifact-meta-'));
        database = createDatabase(join(dbDir, 'workbench.sqlite'));
        seedTasks(database);
        store = new SqliteArtifactMetadataStore(database.db);
      } else {
        store = new InMemoryArtifactMetadataStore();
      }
    });

    afterEach(async () => {
      database?.close();
      if (dbDir) await rm(dbDir, { recursive: true, force: true });
      dbDir = undefined;
      database = undefined;
    });

    it('inserts and gets by id + sha256', () => {
      const r = record();
      store.insert(r);
      expect(store.get('art-1')).toEqual(r);
      expect(store.getBySha256('a'.repeat(64))).toEqual(r);
    });

    it('lists by task and candidate sha', () => {
      store.insert(record({ id: 'a1' }));
      store.insert(record({ id: 'a2', sha256: 'c'.repeat(64), taskId: 'task-2', candidateSha: 'd'.repeat(40) }));
      expect(store.listByTask('task-1').map((r) => r.id)).toEqual(['a1']);
      expect(store.listByCandidateSha('b'.repeat(40)).map((r) => r.id)).toEqual(['a1']);
    });

    it('deletes and reports all', () => {
      store.insert(record({ id: 'a1' }));
      store.insert(record({ id: 'a2', sha256: 'c'.repeat(64) }));
      expect(store.all()).toHaveLength(2);
      store.delete('a1');
      expect(store.get('a1')).toBeUndefined();
      expect(store.all()).toHaveLength(1);
    });
  },
);
