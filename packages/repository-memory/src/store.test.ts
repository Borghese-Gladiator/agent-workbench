import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { repositoryFacts, repositoryFactSources } from '@awb/database';
import { eq } from 'drizzle-orm';
import type { RepositoryFact } from '@awb/domain';
import { recordFacts } from './store.js';
import { makeTestDb, cleanupTestDb, seedRepository, type TestDb } from './test-helpers.js';

describe('recordFacts', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = makeTestDb('awb-repomem-store-');
    await seedRepository(testDb.handle, 'repo-1');
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('persists a fact and its per-path sources with full provenance', async () => {
    const fact: RepositoryFact = {
      id: 'fact-1',
      repositoryId: 'repo-1',
      kind: 'convention',
      statement: 'uses pnpm workspaces',
      confidence: 'validated',
      observedAtSha: 'sha-abc',
      sourcePaths: ['package.json', 'pnpm-workspace.yaml'],
      sourceHashes: ['hash-a', 'hash-b'],
      invalidatedByPaths: [],
    };

    await recordFacts(testDb.handle.db, 'repo-1', [fact]);

    const rows = await testDb.handle.db
      .select()
      .from(repositoryFacts)
      .where(eq(repositoryFacts.id, 'fact-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.statement).toBe('uses pnpm workspaces');
    expect(JSON.parse(rows[0]?.sourcePathsJson ?? '[]')).toEqual([
      'package.json',
      'pnpm-workspace.yaml',
    ]);

    const sourceRows = await testDb.handle.db
      .select()
      .from(repositoryFactSources)
      .where(eq(repositoryFactSources.factId, 'fact-1'));
    expect(sourceRows).toHaveLength(2);
    expect(sourceRows.map((r) => r.path).sort()).toEqual(['package.json', 'pnpm-workspace.yaml']);
    expect(sourceRows.find((r) => r.path === 'package.json')?.sha256).toBe('hash-a');
  });

  it('inserts multiple facts in one call', async () => {
    const facts: RepositoryFact[] = [
      {
        id: 'fact-a',
        repositoryId: 'repo-1',
        kind: 'architecture',
        statement: 'monorepo with pnpm',
        confidence: 'declared',
        observedAtSha: 'sha-1',
        sourcePaths: [],
        sourceHashes: [],
        invalidatedByPaths: [],
      },
      {
        id: 'fact-b',
        repositoryId: 'repo-1',
        kind: 'testing',
        statement: 'tests run via vitest',
        confidence: 'inferred',
        observedAtSha: 'sha-1',
        sourcePaths: [],
        sourceHashes: [],
        invalidatedByPaths: [],
      },
    ];

    await recordFacts(testDb.handle.db, 'repo-1', facts);

    const rows = await testDb.handle.db.select().from(repositoryFacts);
    expect(rows).toHaveLength(2);
  });

  it('rejects a fact whose repositoryId does not match the target repository', async () => {
    const fact: RepositoryFact = {
      id: 'fact-mismatch',
      repositoryId: 'repo-other',
      kind: 'risk',
      statement: 'mismatched repo',
      confidence: 'declared',
      observedAtSha: 'sha-1',
      sourcePaths: [],
      sourceHashes: [],
      invalidatedByPaths: [],
    };

    await expect(recordFacts(testDb.handle.db, 'repo-1', [fact])).rejects.toThrow();
  });
});
