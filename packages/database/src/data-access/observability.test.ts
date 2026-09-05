import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PhaseObservability } from '@awb/domain';
import { eq } from 'drizzle-orm';
import {
  createDatabase,
  insertArtifact,
  insertEvidence,
  phaseAttempts,
  repositories,
  upsertTask,
  type WorkbenchDatabase,
} from '../index.js';
import {
  persistPhaseObservability,
  getTokenBreakdown,
  getTokenSpendByPhase,
  getRuntimeAttribution,
  getContextComposition,
  getBuilderResumeSessions,
  getCrossRepoTokenReport,
  getRuntimeAttributionByAttempt,
  durationMs,
  listAgentSessions,
  listModelInvocations,
  buildTaskTimeline,
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
        estimated: false,
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

  it('round-trips the context-composition estimated provenance flag as a boolean', () => {
    persistPhaseObservability(database.db, payload());
    const cc = getContextComposition(database.db, TASK_ID);
    expect(cc).toHaveLength(1);
    expect(cc[0]?.estimated).toBe(false);
    expect(cc[0]?.contractTokens).toBe(200);

    persistPhaseObservability(
      database.db,
      payload({
        phaseAttemptId: `${TASK_ID}-implement-1`,
        phase: 'implement',
        sessions: [
          {
            id: 'sess-est',
            taskId: TASK_ID,
            runId: `${TASK_ID}-run`,
            phaseAttemptId: `${TASK_ID}-implement-1`,
            phase: 'implement',
            role: 'builder',
            runtime: 'mock',
            startedAt: new Date().toISOString(),
            modelInvocations: [],
            contextComposition: {
              contractTokens: 10,
              planTokens: 0,
              diffTokens: 0,
              evidenceTokens: 0,
              findingsTokens: 0,
              repositoryMapTokens: 0,
              memoryTokens: 0,
              instructionTokens: 0,
              estimated: true,
            },
          },
        ],
      }),
    );
    const est = getContextComposition(database.db, TASK_ID).find((c) => c.agentSessionId === 'sess-est');
    expect(est?.estimated).toBe(true);
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

  it('getTokenSpendByPhase splits cache + static/injected context and ranks phases by spend (TASK-79)', () => {
    // plan: fresh 500, cache-read 50, cache-write 30, static 40, injected 200 (from the base payload).
    persistPhaseObservability(database.db, payload());
    // challenge: a smaller spend so plan ranks first; distinct static/injected split.
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
                inputTokens: 100,
                outputTokens: 20,
                cachedInputTokens: 10,
                cacheCreationInputTokens: 5,
                costUsd: 0.002,
                startedAt: new Date().toISOString(),
              },
            ],
            contextComposition: {
              contractTokens: 0,
              planTokens: 90,
              diffTokens: 60,
              evidenceTokens: 0,
              findingsTokens: 0,
              repositoryMapTokens: 0,
              memoryTokens: 0,
              instructionTokens: 25,
              estimated: false,
            },
          },
        ],
      }),
    );

    const spend = getTokenSpendByPhase(database.db, TASK_ID);
    // Ranked by total input spend (fresh + cache) descending: plan (580) before challenge (115).
    expect(spend.byPhase.map((r) => r.phase)).toEqual(['plan', 'challenge']);

    const plan = spend.byPhase.find((r) => r.phase === 'plan')!;
    expect(plan).toMatchObject({
      freshInputTokens: 500,
      cacheReadTokens: 50,
      cacheCreationTokens: 30,
      outputTokens: 120,
      staticContextTokens: 40,
      injectedContextTokens: 200,
    });

    const challenge = spend.byPhase.find((r) => r.phase === 'challenge')!;
    expect(challenge).toMatchObject({
      freshInputTokens: 100,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      staticContextTokens: 25,
      injectedContextTokens: 150,
    });

    expect(spend.totals).toMatchObject({
      phase: '(totals)',
      freshInputTokens: 600,
      cacheReadTokens: 60,
      cacheCreationTokens: 35,
      outputTokens: 140,
      staticContextTokens: 65,
      injectedContextTokens: 350,
    });
    expect(spend.totals.costUsd).toBeCloseTo(0.012, 6);
  });

  it('getTokenSpendByPhase returns empty rows and zero totals for a task with no observability', () => {
    const spend = getTokenSpendByPhase(database.db, TASK_ID);
    expect(spend.byPhase).toEqual([]);
    expect(spend.totals.freshInputTokens).toBe(0);
    expect(spend.totals.injectedContextTokens).toBe(0);
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

describe('phase attempt close (TASK-124)', () => {
  let dbDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-obs-close-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seed(database);
  });

  afterEach(async () => {
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  const attemptRow = () =>
    database.db.select().from(phaseAttempts).where(eq(phaseAttempts.id, `${TASK_ID}-plan-1`)).all()[0];

  it('leaves ended_at and outcome null when the payload carries no close fields', () => {
    persistPhaseObservability(database.db, payload());
    expect(attemptRow()?.endedAt).toBeNull();
    expect(attemptRow()?.outcome).toBeNull();
  });

  it.each([
    ['candidate'],
    ['repair'],
    ['replan'],
    ['await-human'],
    ['blocked'],
    ['cancelled'],
    ['failed'],
  ] as const)('writes ended_at and outcome %s', (outcome) => {
    persistPhaseObservability(
      database.db,
      payload({ startedAt: '2026-09-04T00:00:00.000Z', endedAt: '2026-09-04T00:00:05.000Z', outcome }),
    );
    const row = attemptRow();
    expect(row?.endedAt).toBe('2026-09-04T00:00:05.000Z');
    expect(row?.outcome).toBe(outcome);
    expect(durationMs(row?.startedAt ?? null, row?.endedAt ?? null)).toBe(5000);
  });

  it('closes an attempt that recorded no sessions and no wall-clock — the throw path', () => {
    persistPhaseObservability(
      database.db,
      payload({
        sessions: [],
        runtimeAttribution: {
          environmentSetupMs: 0,
          dependencyInstallMs: 0,
          modelWaitMs: 0,
          modelGenerationMs: 0,
          toolExecutionMs: 0,
          testExecutionMs: 0,
          serviceStartupMs: 0,
          qaExecutionMs: 0,
          artifactProcessingMs: 0,
          githubOperationMs: 0,
          humanWaitMs: 0,
          retryBackoffMs: 0,
        },
        startedAt: '2026-09-04T00:00:00.000Z',
        endedAt: '2026-09-04T00:00:01.000Z',
        outcome: 'failed',
      }),
    );
    const row = attemptRow();
    expect(row?.outcome).toBe('failed');
    expect(row?.endedAt).toBe('2026-09-04T00:00:01.000Z');
  });

  it('never pushes started_at forward on a re-persist of the same attempt', () => {
    persistPhaseObservability(
      database.db,
      payload({ startedAt: '2026-09-04T00:00:00.000Z', endedAt: '2026-09-04T00:00:05.000Z', outcome: 'repair' }),
    );
    persistPhaseObservability(
      database.db,
      payload({ startedAt: '2026-09-04T00:00:09.000Z', endedAt: '2026-09-04T00:00:12.000Z', outcome: 'candidate' }),
    );
    const row = attemptRow();
    expect(row?.startedAt).toBe('2026-09-04T00:00:00.000Z');
    expect(row?.endedAt).toBe('2026-09-04T00:00:12.000Z');
    expect(row?.outcome).toBe('candidate');
  });

  it('keys runtime attribution by phase attempt for the execution tree', () => {
    persistPhaseObservability(database.db, payload({ endedAt: '2026-09-04T00:00:05.000Z', outcome: 'candidate' }));
    const byAttempt = getRuntimeAttributionByAttempt(database.db, TASK_ID);
    expect(byAttempt.get(`${TASK_ID}-plan-1`)?.modelGenerationMs).toBe(2000);
  });
});

describe('durationMs', () => {
  it.each([
    ['2026-09-04T00:00:00.000Z', '2026-09-04T00:00:05.000Z', 5000],
    ['2026-09-04T00:00:00.000Z', null, null],
    [null, '2026-09-04T00:00:05.000Z', null],
    ['not-a-date', '2026-09-04T00:00:05.000Z', null],
  ])('maps (%s, %s) to %s', (start, end, expected) => {
    expect(durationMs(start, end)).toBe(expected);
  });

  it('clamps a negative interval to zero rather than reporting time running backwards', () => {
    expect(durationMs('2026-09-04T00:00:05.000Z', '2026-09-04T00:00:00.000Z')).toBe(0);
  });
});

describe('session and invocation timestamps (TASK-125)', () => {
  let dbDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-obs-sess-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seed(database);
  });

  afterEach(async () => {
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('persists a session interval rather than a zero duration', () => {
    const base = payload();
    persistPhaseObservability(database.db, {
      ...base,
      sessions: [
        {
          ...base.sessions[0]!,
          startedAt: '2026-09-04T00:00:00.000Z',
          endedAt: '2026-09-04T00:00:42.000Z',
        },
      ],
    });
    const session = listAgentSessions(database.db, `${TASK_ID}-plan-1`)[0];
    expect(session?.startedAt).toBe('2026-09-04T00:00:00.000Z');
    expect(session?.endedAt).toBe('2026-09-04T00:00:42.000Z');
    expect(durationMs(session?.startedAt ?? null, session?.endedAt ?? null)).toBe(42_000);
  });

  it('persists NULL for an invocation whose runtime reports no end boundary', () => {
    persistPhaseObservability(database.db, payload());
    expect(listModelInvocations(database.db, 'sess-1')[0]?.endedAt).toBeNull();
  });

  it('persists NULL for a session whose runtime reports no end', () => {
    const base = payload();
    const { endedAt: _dropped, ...openSession } = base.sessions[0]!;
    persistPhaseObservability(database.db, { ...base, sessions: [openSession] });
    expect(listAgentSessions(database.db, `${TASK_ID}-plan-1`)[0]?.endedAt).toBeNull();
  });
});

describe('buildTaskTimeline (TASK-128)', () => {
  let dbDir: string;
  let database: WorkbenchDatabase;

  beforeEach(async () => {
    dbDir = await mkdtemp(join(tmpdir(), 'awb-obs-timeline-'));
    database = createDatabase(join(dbDir, 'workbench.sqlite'));
    seed(database);

    // A plan attempt that ran 5s and produced a candidate.
    persistPhaseObservability(
      database.db,
      payload({ startedAt: '2026-09-04T00:00:00.000Z', endedAt: '2026-09-04T00:00:05.000Z', outcome: 'candidate' }),
    );
    // An exercise attempt that ran 30s, spent 20s in QA, and ended in repair.
    persistPhaseObservability(
      database.db,
      payload({
        phaseAttemptId: `${TASK_ID}-exercise-1`,
        phase: 'exercise',
        sessions: [],
        runtimeAttribution: {
          environmentSetupMs: 0,
          dependencyInstallMs: 1000,
          modelWaitMs: 0,
          modelGenerationMs: 4000,
          toolExecutionMs: 0,
          testExecutionMs: 0,
          serviceStartupMs: 0,
          qaExecutionMs: 20_000,
          artifactProcessingMs: 0,
          githubOperationMs: 0,
          humanWaitMs: 0,
          retryBackoffMs: 0,
        },
        startedAt: '2026-09-04T00:00:10.000Z',
        endedAt: '2026-09-04T00:00:40.000Z',
        outcome: 'repair',
      }),
    );

    insertEvidence(database.db, {
      id: 'ev-qa',
      taskId: TASK_ID,
      runId: `${TASK_ID}-run`,
      phaseAttemptId: `${TASK_ID}-exercise-1`,
      kind: 'qa-video',
      status: 'passed',
      claimIds: [],
      contractVersion: 1,
      repositorySnapshotId: 'snap',
      policyVersion: 'v1',
      artifactIds: [],
      summary: 'checkout flow recorded',
      createdAt: '2026-09-04T00:00:39.000Z',
    });
    insertEvidence(database.db, {
      id: 'ev-unit',
      taskId: TASK_ID,
      runId: `${TASK_ID}-run`,
      phaseAttemptId: `${TASK_ID}-exercise-1`,
      kind: 'unit-test',
      status: 'passed',
      claimIds: [],
      contractVersion: 1,
      repositorySnapshotId: 'snap',
      policyVersion: 'v1',
      artifactIds: [],
      summary: '42 tests passed',
      createdAt: '2026-09-04T00:00:38.000Z',
    });
    insertArtifact(database.db, {
      id: 'art-1',
      sha256: 'abc',
      mediaType: 'video/webm',
      byteSize: 1024,
      relativePath: 'v.webm',
      taskId: TASK_ID,
      runId: `${TASK_ID}-run`,
      phaseAttemptId: `${TASK_ID}-exercise-1`,
      kind: 'qa-video',
      retention: 'task',
      createdAt: '2026-09-04T00:00:39.000Z',
    });
  });

  afterEach(async () => {
    database.close();
    await rm(dbDir, { recursive: true, force: true });
  });

  it('orders phases by start and reports each duration and outcome', () => {
    const timeline = buildTaskTimeline(database.db, TASK_ID);
    expect(timeline.phases.map((p) => [p.phase, p.durationMs, p.outcome])).toEqual([
      ['plan', 5000, 'candidate'],
      ['exercise', 30_000, 'repair'],
    ]);
  });

  it('attaches the runtime attribution split to each phase', () => {
    const exercise = buildTaskTimeline(database.db, TASK_ID).phases[1];
    expect(exercise?.runtimeAttribution?.qaExecutionMs).toBe(20_000);
    expect(exercise?.runtimeAttribution?.dependencyInstallMs).toBe(1000);
  });

  it('separates QA evidence from the rest and lists artifacts', () => {
    const exercise = buildTaskTimeline(database.db, TASK_ID).phases[1];
    expect(exercise?.qa.map((e) => e.kind)).toEqual(['qa-video']);
    expect(exercise?.evidence.map((e) => e.kind)).toEqual(['unit-test']);
    expect(exercise?.artifacts.map((a) => a.id)).toEqual(['art-1']);
  });

  it('names the longest phase and totals wall-clock, QA time and cost', () => {
    const timeline = buildTaskTimeline(database.db, TASK_ID);
    expect(timeline.longestPhase).toEqual({ phase: 'exercise', attemptNumber: 1, durationMs: 30_000 });
    expect(timeline.totals.durationMs).toBe(35_000);
    expect(timeline.totals.qaExecutionMs).toBe(20_000);
    expect(timeline.totals.inputTokens).toBe(500);
    expect(timeline.totals.outputTokens).toBe(120);
    expect(timeline.totals.costUsd).toBe(0.01);
    expect(timeline.totals.openAttempts).toBe(0);
  });

  it('counts an attempt with no end as open rather than as zero duration', () => {
    persistPhaseObservability(
      database.db,
      payload({ phaseAttemptId: `${TASK_ID}-verify-1`, phase: 'verify', sessions: [] }),
    );
    const timeline = buildTaskTimeline(database.db, TASK_ID);
    const verify = timeline.phases.find((p) => p.phase === 'verify');
    expect(verify?.durationMs).toBeNull();
    expect(verify?.outcome).toBeNull();
    expect(timeline.totals.openAttempts).toBe(1);
    expect(timeline.totals.durationMs).toBe(35_000);
  });

  it('carries the session duration through to the timeline', () => {
    const plan = buildTaskTimeline(database.db, TASK_ID).phases[0];
    expect(plan?.sessions).toHaveLength(1);
    expect(plan?.sessions[0]?.role).toBe('planner');
  });
});
