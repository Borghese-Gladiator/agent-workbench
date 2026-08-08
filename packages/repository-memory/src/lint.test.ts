import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { RepositoryFact } from '@awb/domain';
import { recordFacts } from './store.js';
import { lintMemory } from './lint.js';
import { makeTestDb, cleanupTestDb, seedRepository, type TestDb } from './test-helpers.js';

function fact(overrides: Partial<RepositoryFact> & Pick<RepositoryFact, 'id'>): RepositoryFact {
  return {
    repositoryId: 'repo-1',
    kind: 'invariant',
    statement: 'placeholder statement',
    confidence: 'validated',
    observedAtSha: 'sha-1',
    sourcePaths: [],
    sourceHashes: [],
    invalidatedByPaths: [],
    ...overrides,
  };
}

describe('lintMemory', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = makeTestDb('awb-repomem-lint-');
    await seedRepository(testDb.handle, 'repo-1');
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('flags a planted contradiction and reports it without mutating the store', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'f1', statement: 'The default port is 4417' }),
      fact({ id: 'f2', statement: 'The default port is 8080' }),
    ]);

    const complete = async () =>
      JSON.stringify({
        contradictions: [{ factIds: ['f1', 'f2'], reason: 'conflicting default port' }],
        staleFactIds: [],
        connectionCandidates: [],
      });

    const report = await lintMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', complete);
    expect(report.contradictions).toHaveLength(1);
    expect(report.contradictions[0]!.factIds).toEqual(['f1', 'f2']);

    // Report-only: the facts are untouched (still live, not superseded).
    const rows = testDb.handle.sqlite.prepare('SELECT superseded_by FROM repository_facts').all() as {
      superseded_by: string | null;
    }[];
    expect(rows.every((r) => r.superseded_by === null)).toBe(true);
  });

  it('drops hallucinated ids that are not in the fact set', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [fact({ id: 'real' })]);

    const complete = async () =>
      JSON.stringify({
        contradictions: [{ factIds: ['real', 'ghost'], reason: 'made up' }],
        staleFactIds: ['ghost'],
        connectionCandidates: [],
      });

    const report = await lintMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', complete);
    expect(report.contradictions).toHaveLength(0);
    expect(report.staleFactIds).toEqual([]);
  });

  it('leaves consistent facts unflagged', async () => {
    await recordFacts(testDb.handle.db, 'repo-1', [
      fact({ id: 'a', statement: 'Tests run via pnpm test' }),
      fact({ id: 'b', statement: 'Lint runs via eslint' }),
    ]);

    const complete = async () =>
      JSON.stringify({ contradictions: [], staleFactIds: [], connectionCandidates: [] });

    const report = await lintMemory(testDb.handle.db, testDb.handle.sqlite, 'repo-1', complete);
    expect(report).toEqual({ contradictions: [], staleFactIds: [], connectionCandidates: [] });
  });
});
