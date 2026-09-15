import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { repositoryFacts } from '@awb/database';
import type { RepositoryFact } from '@awb/domain';
import { qualifiesForPromotion, evictSupersededFacts, STALE_MARKER, STALE_AFTER_OBSERVATIONS } from './lifecycle.js';
import { recordFacts } from './store.js';
import { makeTestDb, cleanupTestDb, seedRepository, type TestDb } from './test-helpers.js';

const REPO = 'repo-1';

function fact(overrides: Partial<RepositoryFact> = {}): RepositoryFact {
  return {
    id: `fact-${Math.random().toString(36).slice(2, 10)}`,
    repositoryId: REPO,
    kind: 'pitfall',
    statement: 'The pytest wrapper pins the main checkout venv, so a worktree tests the wrong source.',
    confidence: 'validated',
    observedAtSha: 'abc1234',
    sourcePaths: ['bin/pytest'],
    sourceHashes: ['hash-1'],
    invalidatedByPaths: [],
    ...overrides,
  };
}

// ADR-010 §1. The bar is DURABILITY and PROVENANCE, not interestingness: memory only ever grew
// because any fact a run produced could be written.
describe('qualifiesForPromotion (TASK-116)', () => {
  it('promotes a durable, provenanced, falsifiable fact', () => {
    expect(qualifiesForPromotion(fact())).toEqual({ promote: true, reasons: [] });
  });

  it.each([
    { label: 'no source paths', patch: { sourcePaths: [] }, reason: /source paths/ },
    { label: 'no observed SHA', patch: { observedAtSha: '  ' }, reason: /observedAtSha/ },
    { label: 'too short to falsify', patch: { statement: 'be careful' }, reason: /too short/ },
    {
      label: 'advice rather than a claim',
      patch: { statement: 'Try to keep the configuration files tidy where possible.' },
      reason: /advice, not a falsifiable claim/,
    },
    {
      label: 'run state rather than repository knowledge',
      patch: { statement: 'Slice 3 failed twice during this run before it finally passed.' },
      reason: /describes this run/,
    },
  ])('refuses a fact with $label', ({ patch, reason }) => {
    const verdict = qualifiesForPromotion(fact(patch));
    expect(verdict.promote).toBe(false);
    expect(verdict.reasons.some((r) => reason.test(r))).toBe(true);
  });
});

describe('memory lifecycle end to end (TASK-116)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = makeTestDb('awb-memory-lifecycle-');
    await seedRepository(db.handle, REPO);
  });
  afterEach(() => cleanupTestDb(db));

  const liveFacts = async (): Promise<{ id: string; supersededBy: string | null }[]> =>
    db.handle.db
      .select({ id: repositoryFacts.id, supersededBy: repositoryFacts.supersededBy })
      .from(repositoryFacts)
      .where(eq(repositoryFacts.repositoryId, REPO));

  it('writes a promoted fact and refuses one that does not qualify', async () => {
    const good = fact();
    const bad = fact({ statement: 'try harder' });
    const result = await recordFacts(db.handle.db, REPO, [good, bad]);

    expect(result.recorded).toEqual([good.id]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.factId).toBe(bad.id);
    // A refused fact is the policy working, not an error — nothing throws, and nothing is written.
    expect(await liveFacts()).toHaveLength(1);
  });

  it('supersedes the fact an incoming one explicitly replaces', async () => {
    await recordFacts(db.handle.db, REPO, [fact({ id: 'f-original' })]);

    const replacement = {
      ...fact({ id: 'f-replacement', statement: 'The pytest wrapper pins the main checkout venv, so worktree edits are never tested.' }),
      supersedesFactIds: ['f-original'],
    };
    const result = await recordFacts(db.handle.db, REPO, [replacement]);

    expect(result.evicted.replaced).toEqual([{ factId: 'f-original', supersededBy: 'f-replacement' }]);
    const rows = await liveFacts();
    expect(rows.find((r) => r.id === 'f-original')?.supersededBy).toBe('f-replacement');
    expect(rows.find((r) => r.id === 'f-replacement')?.supersededBy).toBeNull();
  });

  // Replacement is explicit precisely so a write can never retire a fact it did not name. A
  // mis-supersession is data loss, which is far worse than a duplicate row.
  it('leaves every other fact alone when a new one is recorded', async () => {
    await recordFacts(db.handle.db, REPO, [fact({ id: 'f-1' })]);
    const result = await recordFacts(db.handle.db, REPO, [fact({ id: 'f-2' })]);

    expect(result.evicted.replaced).toEqual([]);
    expect((await liveFacts()).find((r) => r.id === 'f-1')?.supersededBy).toBeNull();
  });

  it.each([
    { label: 'an id that is not live', supersedesFactIds: ['f-never-existed'] },
    { label: 'its own id', supersedesFactIds: ['f-self'] },
  ])('ignores a supersedes reference to $label', async ({ supersedesFactIds }) => {
    const incoming = { ...fact({ id: 'f-self' }), supersedesFactIds };
    const result = await recordFacts(db.handle.db, REPO, [incoming]);

    expect(result.evicted.replaced).toEqual([]);
    // A self-reference would retire the incoming fact the moment it was written.
    expect((await liveFacts()).find((r) => r.id === 'f-self')?.supersededBy).toBeNull();
  });

  it('evicts an inferred fact that went unconfirmed past the horizon', async () => {
    await recordFacts(db.handle.db, REPO, [fact({ id: 'f-guess', confidence: 'inferred', kind: 'convention' })]);

    const result = await evictSupersededFacts(db.handle.db, REPO, [], {
      observationsSinceByFactId: new Map([['f-guess', STALE_AFTER_OBSERVATIONS]]),
    });

    expect(result.stale).toEqual(['f-guess']);
    expect((await liveFacts()).find((r) => r.id === 'f-guess')?.supersededBy).toBe(STALE_MARKER);
  });

  // A declared or validated fact does not decay: one is written down in the repo, the other was
  // proven by running something.
  it.each(['declared', 'validated'] as const)('never ages out a %s fact', async (confidence) => {
    await recordFacts(db.handle.db, REPO, [fact({ id: 'f-durable', confidence })]);

    const result = await evictSupersededFacts(db.handle.db, REPO, [], {
      observationsSinceByFactId: new Map([['f-durable', 99]]),
    });

    expect(result.stale).toEqual([]);
  });
});
