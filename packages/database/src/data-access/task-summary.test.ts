import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, repositories, agentSessions, modelInvocations, findings, type WorkbenchDatabase } from '../index.js';
import {
  upsertTask,
  ensureRun,
  ensurePhaseAttempt,
  deleteTask,
  refreshTaskSummary,
  listTaskSummaries,
  getTaskSummary,
  backfillTaskSummaries,
} from './tasks.js';

const REPO_ID = 'repo-1';
const now = '2026-08-08T00:00:00.000Z';

describe('task_summary projection (Phase 0: state coherence)', () => {
  let dir: string;
  let db: WorkbenchDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awb-summary-'));
    db = createDatabase(join(dir, 'wb.sqlite'));
    db.db
      .insert(repositories)
      .values({ id: REPO_ID, canonicalPath: '/tmp/repo', name: 'browser-games', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('upsertTask creates a summary row with the canonical derived status', () => {
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p', phase: 'specify', condition: 'running' });
    const s = getTaskSummary(db.db, 't1');
    // specify + running → queued (domain deriveTaskStatus)
    expect(s?.derivedStatus).toBe('queued');
    expect(s?.repositoryName).toBe('browser-games');
    expect(s?.inputTokens).toBe(0);
    expect(s?.pendingGateReason).toBeNull();
  });

  it('derives awaiting-human and later statuses from condition', () => {
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p', phase: 'challenge', condition: 'awaiting-human' });
    expect(getTaskSummary(db.db, 't1')?.derivedStatus).toBe('awaiting-human');
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p', phase: 'plan', condition: 'running' });
    expect(getTaskSummary(db.db, 't1')?.derivedStatus).toBe('planning');
  });

  it('token rollup equals the direct sum of model_invocations for the task', () => {
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p' });
    const runId = ensureRun(db.db, 't1');
    const attemptId = ensurePhaseAttempt(db.db, { taskId: 't1', phase: 'implement', attemptNumber: 1 });
    const sessionId = 't1-sess';
    db.db.insert(agentSessions).values({ id: sessionId, taskId: 't1', runId, phaseAttemptId: attemptId, phase: 'implement', runtime: 'claude', startedAt: now }).run();
    db.db.insert(modelInvocations).values({ id: 't1-mi1', agentSessionId: sessionId, provider: 'anthropic', model: 'opus', inputTokens: 100, outputTokens: 20, costUsd: 0.5, startedAt: now }).run();
    db.db.insert(modelInvocations).values({ id: 't1-mi2', agentSessionId: sessionId, provider: 'anthropic', model: 'opus', inputTokens: 30, outputTokens: 5, costUsd: 0.25, startedAt: now }).run();

    refreshTaskSummary(db.db, 't1');
    const s = getTaskSummary(db.db, 't1');
    expect(s?.inputTokens).toBe(130);
    expect(s?.outputTokens).toBe(25);
    expect(s?.costUsd).toBeCloseTo(0.75);
    expect(s?.attemptCount).toBe(1);
  });

  it('counts only OPEN findings', () => {
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p' });
    db.db.insert(findings).values({ id: 'f1', taskId: 't1', severity: 'high', category: 'correctness', claimIdsJson: '[]', description: 'd', status: 'open' }).run();
    db.db.insert(findings).values({ id: 'f2', taskId: 't1', severity: 'low', category: 'correctness', claimIdsJson: '[]', description: 'd', status: 'resolved' }).run();
    refreshTaskSummary(db.db, 't1');
    expect(getTaskSummary(db.db, 't1')?.openFindingCount).toBe(1);
  });

  it('preserves a prior gate reason when a later plain upsert omits context, and clears it on explicit null', () => {
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p', condition: 'awaiting-human' }, { pendingGateReason: 'pr-readiness' });
    expect(getTaskSummary(db.db, 't1')?.pendingGateReason).toBe('pr-readiness');
    // A plain upsert with no context must NOT wipe the gate reason.
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p', condition: 'awaiting-human' });
    expect(getTaskSummary(db.db, 't1')?.pendingGateReason).toBe('pr-readiness');
    // Explicit null clears it (gate resolved).
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p', condition: 'running' }, { pendingGateReason: null });
    expect(getTaskSummary(db.db, 't1')?.pendingGateReason).toBeNull();
  });

  it('records title + cross-task retry lineage, insert-only (a later sync does not clobber)', () => {
    upsertTask(db.db, { id: 'orig', repositoryId: REPO_ID, prompt: 'Count the games. Extra detail.', title: 'Count games' });
    const origSummary = getTaskSummary(db.db, 'orig');
    expect(origSummary?.title).toBe('Count games');
    expect(origSummary?.retryOfTaskId).toBeNull();
    // An original's root is itself.
    expect(origSummary?.rootTaskId).toBe('orig');

    // A retry: root copied from the parent, retryOf set.
    upsertTask(db.db, { id: 'retry1', repositoryId: REPO_ID, prompt: 'Count the games. Extra detail.', retryOfTaskId: 'orig', rootTaskId: 'orig' });
    let r = getTaskSummary(db.db, 'retry1');
    expect(r?.retryOfTaskId).toBe('orig');
    expect(r?.rootTaskId).toBe('orig');

    // A later sync-style upsert (no lineage/title args) must preserve them.
    upsertTask(db.db, { id: 'retry1', repositoryId: REPO_ID, prompt: 'Count the games. Extra detail.', phase: 'plan', condition: 'running' });
    r = getTaskSummary(db.db, 'retry1');
    expect(r?.retryOfTaskId).toBe('orig');
    expect(r?.rootTaskId).toBe('orig');
  });

  it('deleteTask removes the summary row (no FK violation)', () => {
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p' });
    expect(getTaskSummary(db.db, 't1')).toBeDefined();
    expect(deleteTask(db.db, 't1')).toBe(true);
    expect(getTaskSummary(db.db, 't1')).toBeUndefined();
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('backfill projects a row for a task that has none, and is idempotent', () => {
    // Simulate a pre-projection task: the task row exists but its summary was never written.
    upsertTask(db.db, { id: 't1', repositoryId: REPO_ID, prompt: 'p' });
    db.sqlite.prepare('DELETE FROM task_summary').run();
    expect(listTaskSummaries(db.db)).toHaveLength(0);

    expect(backfillTaskSummaries(db.db)).toBe(1);
    expect(listTaskSummaries(db.db)).toHaveLength(1);
    // Idempotent: a second run creates nothing.
    expect(backfillTaskSummaries(db.db)).toBe(0);
  });
});
