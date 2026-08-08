import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { RepositoryFact } from '@awb/domain';
import { recordFacts } from './store.js';
import { compileConcepts } from './compile.js';
import { queryMemory } from './query.js';
import { makeTestDb, cleanupTestDb, seedRepository, type TestDb } from './test-helpers.js';

function fact(overrides: Partial<RepositoryFact> & Pick<RepositoryFact, 'id'>): RepositoryFact {
  return {
    repositoryId: 'repo-1',
    kind: 'architecture',
    statement: 'placeholder statement',
    confidence: 'inferred',
    observedAtSha: 'sha-1',
    sourcePaths: [],
    sourceHashes: [],
    invalidatedByPaths: [],
    ...overrides,
  };
}

describe('compileConcepts', () => {
  let testDb: TestDb;
  const complete = async () =>
    JSON.stringify({ title: 'Auth flow', statement: 'Login is handled under src/auth.', backlinks: ['Sessions'] });

  beforeEach(async () => {
    testDb = makeTestDb('awb-repomem-compile-');
    await seedRepository(testDb.handle, 'repo-1');
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('folds a cluster of overlapping facts into one linked concept that preserves union provenance', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', statement: 'login lives here', sourcePaths: ['src/auth/login.ts'], sourceHashes: ['h1'] }),
      fact({ id: 'f2', statement: 'logout lives here', sourcePaths: ['src/auth/logout.ts'], sourceHashes: ['h2'] }),
    ]);

    const result = await compileConcepts(testDb.handle.db, testDb.handle.sqlite, 'repo-1', complete);

    expect(result.concepts).toHaveLength(1);
    expect(result.compactedFrom).toBe(2);
    const concept = result.concepts[0]!;
    expect(concept.kind).toBe('concept');
    // Provenance is the union of the cluster's sources, so the concept is still traceable.
    expect(concept.sourcePaths.sort()).toEqual(['src/auth/login.ts', 'src/auth/logout.ts']);
    expect(concept.sourceHashes.sort()).toEqual(['h1', 'h2']);
    // Backlinks are rendered as [[wikilinks]] in the statement.
    expect(concept.statement).toContain('[[Sessions]]');

    // The concept is persisted alongside — not replacing — the atomic facts.
    const all = await queryMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', {});
    expect(all).toHaveLength(3);
  });

  it('leaves singleton clusters uncompiled (nothing to densify)', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'solo', sourcePaths: ['src/only/thing.ts'], sourceHashes: ['h'] }),
    ]);

    const result = await compileConcepts(testDb.handle.db, testDb.handle.sqlite, 'repo-1', complete);
    expect(result.concepts).toHaveLength(0);
  });

  it('never re-compiles prior concept output', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'c1', kind: 'concept', statement: 'existing concept', sourcePaths: ['src/x/a.ts'], sourceHashes: ['h'] }),
      fact({ id: 'c2', kind: 'concept', statement: 'another concept', sourcePaths: ['src/x/b.ts'], sourceHashes: ['h'] }),
    ]);

    const result = await compileConcepts(testDb.handle.db, testDb.handle.sqlite, 'repo-1', complete);
    expect(result.concepts).toHaveLength(0);
  });

  it('skips a cluster whose completion rejects instead of aborting the whole pass', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'a1', sourcePaths: ['src/auth/login.ts'], sourceHashes: ['h'] }),
      fact({ id: 'a2', sourcePaths: ['src/auth/logout.ts'], sourceHashes: ['h'] }),
      fact({ id: 'b1', sourcePaths: ['src/pay/charge.ts'], sourceHashes: ['h'] }),
      fact({ id: 'b2', sourcePaths: ['src/pay/refund.ts'], sourceHashes: ['h'] }),
    ]);

    // Fail the first cluster's completion, succeed on the rest — the pass must survive and still
    // compile the good cluster.
    let seen = 0;
    const flaky = async () => {
      seen += 1;
      if (seen === 1) throw new Error('provider failed');
      return JSON.stringify({ title: 'C', statement: 'ok.' });
    };

    const result = await compileConcepts(testDb.handle.db, testDb.handle.sqlite, 'repo-1', flaky);
    expect(result.concepts).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });
});
