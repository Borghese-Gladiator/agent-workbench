import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, InMemoryArtifactMetadataStore } from './artifact-store.js';

describe('ArtifactStore', () => {
  let root: string;
  let store: ArtifactStore;
  let metadata: InMemoryArtifactMetadataStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'awb-artifacts-'));
    metadata = new InMemoryArtifactMetadataStore();
    store = new ArtifactStore(root, metadata);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('puts a buffer and computes correct sha256', async () => {
    const record = await store.put({
      source: Buffer.from('hello world'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
    });
    expect(record.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(record.byteSize).toBe(11);
    const got = store.get(record.id);
    expect(got).toBeDefined();
    const contents = await readFile(got!.path, 'utf8');
    expect(contents).toBe('hello world');
  });

  it('deduplicates identical content across two puts', async () => {
    const a = await store.put({
      source: Buffer.from('same content'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
    });
    const b = await store.put({
      source: Buffer.from('same content'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
    });
    expect(a.id).toBe(b.id);
    expect(metadata.all()).toHaveLength(1);
  });

  it('puts from a file path source', async () => {
    const srcPath = join(root, 'src-file.txt');
    await writeFile(srcPath, 'from a file');
    const record = await store.put({
      source: srcPath,
      mediaType: 'text/plain',
      kind: 'command-log',
      retention: 'temporary',
    });
    expect(record.byteSize).toBe(11);
    expect(await store.exists(record.id)).toBe(true);
  });

  it('verify returns true for intact content and false after corruption', async () => {
    const record = await store.put({
      source: Buffer.from('verify me'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
    });
    expect(await store.verify(record.id)).toBe(true);

    const path = store.get(record.id)!.path;
    await writeFile(path, 'corrupted');
    expect(await store.verify(record.id)).toBe(false);
  });

  it('delete removes metadata and, when unreferenced, the blob', async () => {
    const record = await store.put({
      source: Buffer.from('to be deleted'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'temporary',
    });
    await store.delete(record.id);
    expect(metadata.get(record.id)).toBeUndefined();
    expect(await store.exists(record.id)).toBe(false);
  });

  it('does not delete the blob when another record still references the same content', async () => {
    const a = await store.put({
      source: Buffer.from('shared'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
    });
    // Force a second distinct metadata record pointing at the same sha256 (simulates
    // two artifact records created from identical content before this store existed).
    metadata.insert({ ...a, id: 'second-id' });
    await store.delete(a.id);
    expect(await store.exists('second-id')).toBe(true);
  });

  it('listByTask and listByCandidateSha filter correctly', async () => {
    await store.put({
      source: Buffer.from('task-a-1'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
      taskId: 'task-a',
      candidateSha: 'sha-1',
    });
    await store.put({
      source: Buffer.from('task-b-1'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'task',
      taskId: 'task-b',
      candidateSha: 'sha-2',
    });
    expect(store.listByTask('task-a')).toHaveLength(1);
    expect(store.listByCandidateSha('sha-2')).toHaveLength(1);
  });

  it('garbageCollect removes orphaned blobs not referenced by metadata', async () => {
    const record = await store.put({
      source: Buffer.from('kept'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'permanent',
    });
    // Simulate an orphan: delete metadata directly without going through store.delete.
    const orphan = await store.put({
      source: Buffer.from('orphaned'),
      mediaType: 'text/plain',
      kind: 'other',
      retention: 'temporary',
    });
    metadata.delete(orphan.id);

    const { removed } = await store.garbageCollect();
    expect(removed).toBe(1);
    expect(await store.exists(record.id)).toBe(true);
  });
});
