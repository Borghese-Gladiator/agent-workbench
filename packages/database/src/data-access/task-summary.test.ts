import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  repositories,
  agentSessions,
  modelInvocations,
  findings,
  taskSummary,
  type WorkbenchDatabase,
} from '../index.js';
import {
  upsertTask,
  ensureRun,
  ensurePhaseAttempt,
  refreshTaskSummary,
  getTaskSummary,
  listTaskSummaries,
  backfillTaskSummaries,
  deleteTask,
} from './tasks.js';

const REPO_ID = 'repo-1';
const now = '2026-08-17T00:00:00.000Z';

/** Adds an agent session with model invocations under a task's plan attempt. */
function seedInvocations(
  db: WorkbenchDatabase,
  taskId: string,
  sessionSuffix: string,
  invs: Array<{ input: number; output: number; cost: number | null }>,
): void {
  const d = db.db;
  const runId = ensureRun(d, taskId);
  const attemptId = ensurePhaseAttempt(d, { taskId, phase: 'implement', attemptNumber: 1 });
  const sessionId = `${taskId}-${sessionSuffix}`;
  d.insert(agentSessions)
    .values({ id: sessionId, taskId, runId, phaseAttemptId: attemptId, phase: 'implement', runtime: 'claude', startedAt: now })
    .run();
  invs.forEach((inv, i) => {
    d.insert(modelInvocations)
      .values({
        id: `${sessionId}-mi-${i}`,
        agentSessionId: sessionId,
        provider: 'anthropic',
        model: 'opus',
        inputTokens: inv.input,
        outputTokens: inv.output,
        costUsd: inv.cost,
        startedAt: now,
      })
      .run();
  });
}

describe('task_summary projection', () => {
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

  it('stays consistent across create → advance → retry → delete', () => {
    // create: a fresh task in specify/running derives 'queued'.
    upsertTask(db.db, { id: 'task-A', repositoryId: REPO_ID, prompt: 'do a thing' });
    let s = getTaskSummary(db.db, 'task-A');
    expect(s).toMatchObject({
      taskId: 'task-A',
      repositoryId: REPO_ID,
      repositoryName: 'browser-games',
      derivedStatus: 'queued',
      attemptCount: 0,
      openFindingCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      rootTaskId: 'task-A',
    });

    // advance: move to implement/running (derives 'running'), add an attempt + tokens + an open finding.
    seedInvocations(db, 'task-A', 'sess', [{ input: 100, output: 40, cost: 0.5 }]);
    db.db
      .insert(findings)
      .values({ id: 'task-A-f1', taskId: 'task-A', severity: 'high', category: 'correctness', claimIdsJson: '[]', description: 'd', status: 'open' })
      .run();
    upsertTask(db.db, { id: 'task-A', repositoryId: REPO_ID, prompt: 'do a thing', phase: 'implement', condition: 'running' });
    s = getTaskSummary(db.db, 'task-A');
    expect(s).toMatchObject({
      derivedStatus: 'running',
      attemptCount: 1,
      openFindingCount: 1,
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.5,
    });

    // retry: a NEW task pointing at task-A, sharing its root.
    upsertTask(db.db, { id: 'task-A-r1', repositoryId: REPO_ID, prompt: 'retry', retryOfTaskId: 'task-A', rootTaskId: 'task-A' });
    const retry = getTaskSummary(db.db, 'task-A-r1');
    expect(retry).toMatchObject({ retryOfTaskId: 'task-A', rootTaskId: 'task-A', derivedStatus: 'queued' });
    // Both summaries now exist.
    expect(listTaskSummaries(db.db).map((r) => r.taskId).sort()).toEqual(['task-A', 'task-A-r1']);

    // delete: removes the projection row for the deleted task, leaves the retry intact.
    expect(deleteTask(db.db, 'task-A')).toBe(true);
    expect(getTaskSummary(db.db, 'task-A')).toBeUndefined();
    expect(db.db.select().from(taskSummary).all().map((r) => r.taskId)).toEqual(['task-A-r1']);
    // FK-check clean after cascade.
    expect(db.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('token rollups equal a direct model_invocations sum', () => {
    upsertTask(db.db, { id: 'task-T', repositoryId: REPO_ID, prompt: 'p' });
    seedInvocations(db, 'task-T', 'sA', [
      { input: 10, output: 5, cost: 0.1 },
      { input: 20, output: 8, cost: 0.2 },
    ]);
    seedInvocations(db, 'task-T', 'sB', [{ input: 7, output: 3, cost: null }]);
    refreshTaskSummary(db.db, 'task-T');

    const direct = db.sqlite
      .prepare(
        `SELECT SUM(mi.input_tokens) AS inp, SUM(mi.output_tokens) AS outp, SUM(mi.cost_usd) AS cost
         FROM model_invocations mi
         JOIN agent_sessions s ON s.id = mi.agent_session_id
         WHERE s.task_id = ?`,
      )
      .get('task-T') as { inp: number; outp: number; cost: number };

    const s = getTaskSummary(db.db, 'task-T');
    expect(s?.inputTokens).toBe(direct.inp);
    expect(s?.outputTokens).toBe(direct.outp);
    expect(s?.costUsd).toBeCloseTo(direct.cost, 10);
  });

  it('preserves prior gate context when a later refresh omits it, and clears on explicit null', () => {
    upsertTask(db.db, { id: 'task-G', repositoryId: REPO_ID, prompt: 'p' }, { pendingGateReason: 'task-contract-approval' });
    expect(getTaskSummary(db.db, 'task-G')?.pendingGateReason).toBe('task-contract-approval');

    // A plain sync (no context) must not wipe the gate reason.
    upsertTask(db.db, { id: 'task-G', repositoryId: REPO_ID, prompt: 'p', phase: 'plan' });
    expect(getTaskSummary(db.db, 'task-G')?.pendingGateReason).toBe('task-contract-approval');

    // Explicit null clears it.
    refreshTaskSummary(db.db, 'task-G', { pendingGateReason: null });
    expect(getTaskSummary(db.db, 'task-G')?.pendingGateReason).toBeNull();
  });

  it('backfills a summary for every task lacking one', () => {
    // Insert task rows directly (no upsertTask) to simulate pre-projection tasks.
    db.db
      .insert(repositories)
      .values({ id: 'repo-2', canonicalPath: '/tmp/r2', name: 'r2', remoteUrl: null, defaultBranch: 'main', trusted: true, createdAt: now, updatedAt: now })
      .run();
    upsertTask(db.db, { id: 'has-summary', repositoryId: REPO_ID, prompt: 'p' });
    // Delete its projection to simulate a task with no summary yet.
    db.db.delete(taskSummary).run();

    const created = backfillTaskSummaries(db.db);
    expect(created).toBe(1);
    expect(getTaskSummary(db.db, 'has-summary')).toBeDefined();
    // Idempotent: a second backfill creates nothing.
    expect(backfillTaskSummaries(db.db)).toBe(0);
  });
});
