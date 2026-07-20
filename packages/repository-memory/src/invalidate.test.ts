import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { repositoryFacts } from '@awb/database';
import { eq } from 'drizzle-orm';
import type { RepositoryFact } from '@awb/domain';
import { recordFacts } from './store.js';
import { invalidateFacts, INVALIDATED_MARKER } from './invalidate.js';
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

describe('repository fact invalidation', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = makeTestDb('awb-repomem-invalidate-');
    await seedRepository(testDb.handle, 'repo-1');
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('invalidates a fact whose sourcePaths overlap the changed paths, and leaves an unrelated fact untouched', async () => {
    const affected = fact({
      id: 'fact-affected',
      statement: 'login flow validates credentials against the auth service',
      sourcePaths: ['src/auth/login.ts'],
      sourceHashes: ['hash-login'],
    });
    const unrelated = fact({
      id: 'fact-unrelated',
      statement: 'unrelated helper util',
      sourcePaths: ['src/unrelated/thing.ts'],
      sourceHashes: ['hash-thing'],
    });

    await recordFacts(testDb.handle.db, 'repo-1', [affected, unrelated]);

    const invalidatedIds = await invalidateFacts(testDb.handle.db, 'repo-1', [
      'src/auth/login.ts',
    ]);

    expect(invalidatedIds).toEqual(['fact-affected']);

    const [affectedRow] = await testDb.handle.db
      .select()
      .from(repositoryFacts)
      .where(eq(repositoryFacts.id, 'fact-affected'));
    expect(affectedRow?.supersededBy).toBe(INVALIDATED_MARKER);

    const [unrelatedRow] = await testDb.handle.db
      .select()
      .from(repositoryFacts)
      .where(eq(repositoryFacts.id, 'fact-unrelated'));
    expect(unrelatedRow?.supersededBy).toBeNull();
  });

  it('invalidates a fact via invalidatedByPaths even when sourcePaths does not overlap', async () => {
    const noAuthModuleFact = fact({
      id: 'fact-no-auth-module',
      statement: 'there is no auth module in this repository',
      sourcePaths: ['README.md'],
      sourceHashes: ['hash-readme'],
      invalidatedByPaths: ['src/auth/'],
    });

    await recordFacts(testDb.handle.db, 'repo-1', [noAuthModuleFact]);

    const invalidatedIds = await invalidateFacts(testDb.handle.db, 'repo-1', ['src/auth/']);

    expect(invalidatedIds).toEqual(['fact-no-auth-module']);

    const [row] = await testDb.handle.db
      .select()
      .from(repositoryFacts)
      .where(eq(repositoryFacts.id, 'fact-no-auth-module'));
    expect(row?.supersededBy).toBe(INVALIDATED_MARKER);
  });

  it('leaves facts with no overlap in either field untouched', async () => {
    const survivor = fact({
      id: 'fact-survivor',
      sourcePaths: ['src/billing/invoice.ts'],
      invalidatedByPaths: ['src/billing/legacy/'],
    });

    await recordFacts(testDb.handle.db, 'repo-1', [survivor]);

    const invalidatedIds = await invalidateFacts(testDb.handle.db, 'repo-1', [
      'src/auth/login.ts',
    ]);

    expect(invalidatedIds).toEqual([]);

    const [row] = await testDb.handle.db
      .select()
      .from(repositoryFacts)
      .where(eq(repositoryFacts.id, 'fact-survivor'));
    expect(row?.supersededBy).toBeNull();
  });

  it('does not re-process facts that are already invalidated', async () => {
    const affected = fact({
      id: 'fact-twice',
      sourcePaths: ['src/auth/login.ts'],
    });
    await recordFacts(testDb.handle.db, 'repo-1', [affected]);

    const first = await invalidateFacts(testDb.handle.db, 'repo-1', ['src/auth/login.ts']);
    expect(first).toEqual(['fact-twice']);

    const second = await invalidateFacts(testDb.handle.db, 'repo-1', ['src/auth/login.ts']);
    expect(second).toEqual([]);
  });
});
