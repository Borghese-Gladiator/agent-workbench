import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { RepositoryFact } from '@awb/domain';
import { recordFacts } from './store.js';
import { invalidateFacts } from './invalidate.js';
import { queryMemory } from './query.js';
import { makeTestDb, cleanupTestDb, seedRepository, type TestDb } from './test-helpers.js';

function fact(overrides: Partial<RepositoryFact> & Pick<RepositoryFact, 'id'>): RepositoryFact {
  return {
    repositoryId: 'repo-1',
    kind: 'convention',
    statement: 'placeholder statement',
    confidence: 'validated',
    observedAtSha: 'sha-1',
    sourcePaths: [],
    sourceHashes: [],
    invalidatedByPaths: [],
    ...overrides,
  };
}

describe('queryMemory', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = makeTestDb('awb-repomem-query-');
    await seedRepository(testDb.handle, 'repo-1');
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('retrieves facts by exact path', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', sourcePaths: ['src/auth/login.ts'] }),
      fact({ id: 'f2', sourcePaths: ['src/billing/invoice.ts'] }),
    ]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      path: 'src/auth/login.ts',
    });
    expect(results.map((r) => r.id)).toEqual(['f1']);
  });

  it('retrieves facts scoped to a project unit prefix', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', sourcePaths: ['packages/api/src/handler.ts'] }),
      fact({ id: 'f2', sourcePaths: ['packages/web/src/app.tsx'] }),
    ]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      unitPrefix: 'packages/api/',
    });
    expect(results.map((r) => r.id)).toEqual(['f1']);
  });

  it('delegates full-text search to the FTS5 helper', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', statement: 'the repository uses drizzle orm for database access' }),
      fact({ id: 'f2', statement: 'tests run via vitest' }),
    ]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      text: 'drizzle',
    });
    expect(results.map((r) => r.id)).toEqual(['f1']);
  });

  it('retrieves facts by changed-path directory proximity', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', sourcePaths: ['src/auth/login.ts'] }),
      fact({ id: 'f2', sourcePaths: ['src/auth/session.ts'] }),
      fact({ id: 'f3', sourcePaths: ['src/billing/invoice.ts'] }),
    ]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      changedPaths: ['src/auth/logout.ts'],
    });
    expect(results.map((r) => r.id).sort()).toEqual(['f1', 'f2']);
  });

  it('filters by fact confidence', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', confidence: 'validated' }),
      fact({ id: 'f2', confidence: 'inferred' }),
    ]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      confidence: ['validated'],
    });
    expect(results.map((r) => r.id)).toEqual(['f1']);
  });

  it('sorts by confidence, highest first', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f-inferred', confidence: 'inferred' }),
      fact({ id: 'f-validated', confidence: 'validated' }),
      fact({ id: 'f-declared', confidence: 'declared' }),
    ]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      sort: 'confidence',
    });
    expect(results.map((r) => r.id)).toEqual(['f-validated', 'f-declared', 'f-inferred']);
  });

  it('sorts by recency, most recently inserted first', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [fact({ id: 'f-old' })]);
    await recordFacts(testDb.handle.db, 'repo-1', [fact({ id: 'f-new' })]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      sort: 'recency',
    });
    expect(results.map((r) => r.id)).toEqual(['f-new', 'f-old']);
  });

  it('excludes invalidated facts by default and includes them when requested', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f-live', sourcePaths: ['src/keep.ts'] }),
      fact({ id: 'f-dead', sourcePaths: ['src/auth/login.ts'] }),
    ]);
    await invalidateFacts(testDb.handle.db, 'repo-1', ['src/auth/login.ts']);

    const defaultResults = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {});
    expect(defaultResults.map((r) => r.id)).toEqual(['f-live']);

    const withInvalidated = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      includeInvalidated: true,
    });
    expect(withInvalidated.map((r) => r.id).sort()).toEqual(['f-dead', 'f-live']);
  });

  it('supports a symbolLookup pass-through hook for symbol-name retrieval', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', sourcePaths: ['src/auth/login.ts'] }),
      fact({ id: 'f2', sourcePaths: ['src/billing/invoice.ts'] }),
    ]);

    const results = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {
      symbolName: 'login',
      symbolLookup: (name) => (name === 'login' ? ['src/auth/login.ts'] : []),
    });
    expect(results.map((r) => r.id)).toEqual(['f1']);
  });
});
