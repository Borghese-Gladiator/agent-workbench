import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhaseObservability } from '@awb/domain';
import { eq } from 'drizzle-orm';
import { createDatabase, phaseAttempts, repositories, upsertTask, type WorkbenchDatabase } from '../index.js';
import {
  persistPhaseObservability,
  getTokenBreakdown,
  getRuntimeAttribution,
  getBuilderResumeSessions,
  getCrossRepoTokenReport,
} from './observability.js';

const REPO_ID = 'repo-1';
const TASK_ID = 'task-1';

function seed(db: WorkbenchDatabase): void {
  const now = new Date().toISOString();
  db.db
    .insert(repositories)
    .values({
      id: REPO_ID,
      canonicalPath: '/tmp/repo',
      name: 'repo',
      remoteUrl: null,
      defaultBranch: 'main',
      trusted: true,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  upsertTask(db.db, { id: TASK_ID, repositoryId: REPO_ID, prompt: 'p' });
}

const payload = (over: Partial<PhaseObservability> = {}): PhaseObservability => ({
  taskId: TASK_ID,
  runId: `${TASK_ID}-run`,
  phaseAttemptId: `${TASK_ID}-plan-1`,
  phase: 'plan',
  attemptNumber: 1,
  runtimeAttribution: {
    environmentSetupMs: 0,
    dependencyInstallMs: 0,
    modelWaitMs: 100,
    modelGenerationMs: 2000,
    toolExecutionMs: 50,
    testExecutionMs: 0,
    serviceStartupMs: 0,
    qaExecutionMs: 0,
    artifactProcessingMs: 0,
    githubOperationMs: 0,
    humanWaitMs: 0,
    retryBackoffMs: 0,
  },
  sessions: [
    {
      id: 'sess-1',
      taskId: TASK_ID,
      runId: `${TASK_ID}-run`,
      phaseAttemptId: `${TASK_ID}-plan-1`,
      phase: 'plan',
      role: 'planner',
      runtime: 'claude',
      model: 'claude-opus',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      modelInvocations: [
        {
          id: 'mi-1',
          provider: 'anthropic',
          model: 'claude-opus',
          inputTokens: 500,
          outputTokens: 120,
          cachedInputTokens: 50,
          cacheCreationInputTokens: 30,
          costUsd: 0.01,
          startedAt: new Date().toISOString(),
        },
      ],
      contextComposition: {
        contractTokens: 200,
        planTokens: 0,
        diffTokens: 0,
        evidenceTokens: 0,
        findingsTokens: 0,
        repositoryMapTokens: 0,
        memoryTokens: 0,
        instructionTokens: 40,
      },
    },
  ],
  ...over,
});

describe('phase observability persistence (§27)', () => {
  let dbDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-obs-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seed(database);
  });

  afterEach(async () => {
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('persists sessions, model invocations, runtime attribution, and context composition', () => {
    persistPhaseObservability(database.db, payload());

    const ra = getRuntimeAttribution(database.db, TASK_ID);
    expect(ra).toHaveLength(1);
    expect(ra[0]?.modelGenerationMs).toBe(2000);
    expect(ra[0]?.modelWaitMs).toBe(100);

    const breakdown = getTokenBreakdown(database.db, TASK_ID);
    expect(breakdown.totals).toEqual({
      inputTokens: 500,
      outputTokens: 120,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 30,
      costUsd: 0.01,
    });
    expect(breakdown.byModel['claude-opus']).toEqual({
      inputTokens: 500,
      outputTokens: 120,
      cachedInputTokens: 50,
      cacheCreationInputTokens: 30,
      costUsd: 0.01,
    });
  });

  it('is idempotent per phase attempt (no duplicate attribution/session rows on re-run)', () => {
    persistPhaseObservability(database.db, payload());
    persistPhaseObservability(database.db, payload());
    expect(getRuntimeAttribution(database.db, TASK_ID)).toHaveLength(1);
    // Two model-invocation rows would double the totals; idempotency keeps them at one.
    expect(getTokenBreakdown(database.db, TASK_ID).totals.inputTokens).toBe(500);
  });

  it('aggregates token usage across models', () => {
    persistPhaseObservability(database.db, payload());
    persistPhaseObservability(
      database.db,
      payload({
        phaseAttemptId: `${TASK_ID}-challenge-1`,
        phase: 'challenge',
        sessions: [
          {
            id: 'sess-2',
            taskId: TASK_ID,
            runId: `${TASK_ID}-run`,
            phaseAttemptId: `${TASK_ID}-challenge-1`,
            phase: 'challenge',
            role: 'adversarial-reviewer',
            runtime: 'claude',
            model: 'claude-haiku',
            startedAt: new Date().toISOString(),
            modelInvocations: [
              {
                id: 'mi-2',
                provider: 'anthropic',
                model: 'claude-haiku',
                inputTokens: 300,
                outputTokens: 60,
                startedAt: new Date().toISOString(),
              },
            ],
          },
        ],
      }),
    );

    const b = getTokenBreakdown(database.db, TASK_ID);
    expect(b.totals.inputTokens).toBe(800);
    expect(Object.keys(b.byModel).sort()).toEqual(['claude-haiku', 'claude-opus']);
    expect(b.byModel['claude-haiku']?.outputTokens).toBe(60);
  });

  // The durable resume round-trip. An implement-phase session persists its resume token; the
  // builder resume map is reconstructed keyed by slice id, and the latest attempt's token wins.
  it('reconstructs builder resume sessions keyed by slice id from persisted agent_sessions', () => {
    const implementSession = (attempt: number, sliceId: string, resumeSessionId: string) =>
      payload({
        phaseAttemptId: `${TASK_ID}-implement-${attempt}`,
        phase: 'implement',
        sessions: [
          {
            id: `${TASK_ID}-implement-${attempt}-${sliceId}`,
            taskId: TASK_ID,
            runId: `${TASK_ID}-run`,
            phaseAttemptId: `${TASK_ID}-implement-${attempt}`,
            phase: 'implement',
            role: 'builder',
            runtime: 'claude',
            resumeSessionId,
            startedAt: new Date().toISOString(),
            modelInvocations: [],
          },
        ],
      });

    expect(getBuilderResumeSessions(database.db, TASK_ID)).toBeUndefined();

    persistPhaseObservability(database.db, implementSession(1, 'slice-a', 'sdk-session-a1'));
    persistPhaseObservability(database.db, implementSession(1, 'slice-b', 'sdk-session-b1'));
    // A retry of slice-a persists a new token under a new attempt-scoped session id.
    persistPhaseObservability(database.db, implementSession(2, 'slice-a', 'sdk-session-a2'));

    const resume = getBuilderResumeSessions(database.db, TASK_ID);
    expect(resume).toEqual({ 'slice-a': 'sdk-session-a2', 'slice-b': 'sdk-session-b1' });
  });
});

describe('cross-repo token report (TASK-98)', () => {
  let dbDir: string;
  let database: WorkbenchDatabase;

  const seedRepo = (id: string) => {
    const now = new Date().toISOString();
    database.db
      .insert(repositories)
      .values({
        id,
        canonicalPath: `/tmp/${id}`,
        name: id,
        remoteUrl: null,
        defaultBranch: 'main',
        trusted: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  };

  // One phase-attempt worth of tokens for (task, repo, phase, model), with an explicit outcome.
  const seedTokens = (args: {
    taskId: string;
    repositoryId: string;
    parentTaskId?: string;
    phase: 'plan' | 'implement';
    model: string;
    inputTokens: number;
    outputTokens: number;
    outcome: string;
  }) => {
    upsertTask(database.db, {
      id: args.taskId,
      repositoryId: args.repositoryId,
      prompt: 'p',
      ...(args.parentTaskId ? { parentTaskId: args.parentTaskId } : {}),
    });
    const phaseAttemptId = `${args.taskId}-${args.phase}-1`;
    persistPhaseObservability(
      database.db,
      payload({
        taskId: args.taskId,
        runId: `${args.taskId}-run`,
        phaseAttemptId,
        phase: args.phase,
        sessions: [
          {
            id: `${args.taskId}-${args.phase}-sess`,
            taskId: args.taskId,
            runId: `${args.taskId}-run`,
            phaseAttemptId,
            phase: args.phase,
            role: 'planner',
            runtime: 'claude',
            model: args.model,
            startedAt: new Date().toISOString(),
            modelInvocations: [
              {
                id: `${args.taskId}-${args.phase}-mi`,
                provider: 'anthropic',
                model: args.model,
                inputTokens: args.inputTokens,
                outputTokens: args.outputTokens,
                cachedInputTokens: 10,
                cacheCreationInputTokens: 5,
                startedAt: new Date().toISOString(),
              },
            ],
          },
        ],
      }),
    );
    database.db
      .update(phaseAttempts)
      .set({ outcome: args.outcome })
      .where(eq(phaseAttempts.id, phaseAttemptId))
      .run();
  };

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-obs-xrepo-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seedRepo('repo-a');
    seedRepo('repo-b');
    // repo-a: task-a1, then task-a2 which is a retry of task-a1 (parentTaskId edge).
    seedTokens({ taskId: 'task-a1', repositoryId: 'repo-a', phase: 'plan', model: 'claude-opus', inputTokens: 500, outputTokens: 100, outcome: 'failed' });
    seedTokens({ taskId: 'task-a2', repositoryId: 'repo-a', parentTaskId: 'task-a1', phase: 'plan', model: 'claude-opus', inputTokens: 700, outputTokens: 150, outcome: 'succeeded' });
    // repo-b: a single task.
    seedTokens({ taskId: 'task-b1', repositoryId: 'repo-b', phase: 'implement', model: 'claude-haiku', inputTokens: 300, outputTokens: 40, outcome: 'succeeded' });
  });

  afterEach(async () => {
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('rolls up per repo/task/model/phase/outcome with grand totals', () => {
    const report = getCrossRepoTokenReport(database.db);
    expect(report.rows).toHaveLength(3);
    expect(report.totals).toEqual({ tokensIn: 1500, tokensOut: 290, sessions: 3 });

    const a1 = report.rows.find((r) => r.taskId === 'task-a1');
    expect(a1).toMatchObject({
      repositoryId: 'repo-a',
      model: 'claude-opus',
      phase: 'plan',
      outcome: 'failed',
      retryOfTaskId: null,
      sessions: 1,
      tokensIn: 500,
      tokensOut: 100,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  it('carries the retry-lineage parent on the rollup row', () => {
    const report = getCrossRepoTokenReport(database.db);
    const a2 = report.rows.find((r) => r.taskId === 'task-a2');
    expect(a2?.retryOfTaskId).toBe('task-a1');
    expect(a2?.outcome).toBe('succeeded');
  });

  it('filters to a subset of repos', () => {
    const report = getCrossRepoTokenReport(database.db, { repositoryIds: ['repo-b'] });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.repositoryId).toBe('repo-b');
    expect(report.totals.tokensIn).toBe(300);
  });
});
