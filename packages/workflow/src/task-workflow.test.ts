import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhaseAttemptResult, TaskPhase, TaskStateSync } from '@awb/domain';
import {
  TaskWorkflow,
  extendBudgetUpdate,
  cancelSignal,
  pullRequestMergedSignal,
  pullRequestClosedSignal,
  getCurrentStateQuery,
  getUnmetCriteriaQuery,
} from './task-workflow.js';
import { createScriptedActivities, THROW, type ScriptEntry } from './test-activities.js';
import type { TaskWorkflowInput } from './workflow-types.js';

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  // createLocal (real-time), not createTimeSkipping: these tests drive the workflow with
  // wall-clock polling from outside (waitForCondition), not in-workflow timers, so
  // time-skipping's "advance the clock when idle" behavior fights the test driver and produces
  // spurious client-side execution timeouts.
  testEnv = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

let taskQueueCounter = 0;

function candidate(phase: TaskPhase): PhaseAttemptResult {
  return {
    outcome: 'candidate',
    candidate: {
      phase,
      phaseAttemptId: `${phase}-attempt`,
      repositorySnapshotId: 'snapshot-1',
      contractVersion: 1,
      planVersion: 1,
      policyVersion: 'v1',
      evidenceIds: [`evidence-${phase}`],
      openFindingIds: [],
      artifactManifestHash: 'deadbeef',
    },
  };
}

/**
 * A phase reporting "I cannot prove this claim" (TASK-105). This replaced `await-human`: the
 * workflow records the reason and routes to the draft-PR terminal instead of parking.
 */
function unmet(reason: 'qa-inconclusive' | 'waiver-request', detail = 'test unmet criterion'): PhaseAttemptResult {
  return { outcome: 'unmet', reason, detail, unprovenClaims: ['claim-1'], findings: [] };
}

/** The full happy-path script every phase needs to walk from specify to a released draft PR. */
const FULL_ROUTE: Partial<Record<TaskPhase, ScriptEntry[]>> = {
  specify: [candidate('specify')],
  plan: [candidate('plan')],
  prepare: [candidate('prepare')],
  implement: [candidate('implement')],
  verify: [candidate('verify')],
  exercise: [candidate('exercise')],
  challenge: [candidate('challenge')],
  release: [candidate('release')],
};

function candidateWithUsage(
  phase: TaskPhase,
  usage: { inputTokens: number; outputTokens: number; runtimeMs: number },
): PhaseAttemptResult {
  return { ...candidate(phase), usage };
}

function sizedSpecifyCandidate(size: 'S' | 'M' | 'L'): PhaseAttemptResult {
  const base = candidate('specify');
  if (base.outcome !== 'candidate') throw new Error('unreachable');
  return { ...base, size };
}

function repair(): PhaseAttemptResult {
  return { outcome: 'repair', target: 'implement', findings: [] };
}

function replan(target: 'plan' | 'program-design' | 'specify'): PhaseAttemptResult {
  return { outcome: 'replan', target, findings: [] };
}

async function runWithActivities(
  script: Partial<Record<TaskPhase, ScriptEntry[]>>,
  driveWorkflow: (handle: import('@temporalio/client').WorkflowHandle) => Promise<void>,
  args: TaskWorkflowInput = { taskId: 'task-1', repositoryId: 'repo-1' },
  syncLog?: TaskStateSync[],
) {
  // Each test gets its own task queue — Temporal's native runtime refuses two concurrent Worker
  // registrations on the same (namespace, task queue), and this suite creates workers per-test.
  const taskQueue = `awb-test-queue-${++taskQueueCounter}`;
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    // Temporal's Worker bundles workflow code from a real file on disk — point at the built
    // dist output (this test suite requires `pnpm --filter @awb/workflow build` to have run),
    // not the TypeScript source.
    workflowsPath: new URL('../dist/task-workflow.js', import.meta.url).pathname,
    activities: createScriptedActivities(script, syncLog ? { syncLog } : {}),
  });

  let handle!: import('@temporalio/client').WorkflowHandle;
  const result = await worker.runUntil(async () => {
    handle = await testEnv.client.workflow.start(TaskWorkflow, {
      taskQueue,
      workflowId: `test-${Date.now()}-${Math.random()}`,
      args: [args],
    });
    // The worker only polls for the duration of this callback — await the workflow's own
    // completion here (racing with driveWorkflow, which issues signals/updates while it runs),
    // not just the human-interaction script, or the worker stops before the workflow finishes.
    await Promise.all([driveWorkflow(handle), handle.result()]);
    return handle.result();
  });
  return { handle, result };
}

describe('TaskWorkflow', () => {
  it('runs the full happy-path lifecycle to completion with the mock adapter', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
      },
      async () => {
        // no human interaction needed — every phase yields a candidate immediately
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
  }, 30_000);

  it('classifies size S at specify and skips plan + program-design (TASK-51)', async () => {
    // The specify candidate reports size S. `plan` and `program-design` are NEVER scripted; if the
    // run walked them it would stall (scripted activities have no default for an unlisted phase only
    // when accessed — here reaching assimilate proves they were skipped). We also assert phaseSet.
    let finalPhaseSet: TaskPhase[] | undefined;
    const { result } = await runWithActivities(
      {
        specify: [sizedSpecifyCandidate('S')],
      },
      async (h) => {
        // capture the phaseSet once specify has advanced
        await waitForCondition(async () => {
          const state = await h.query(getCurrentStateQuery);
          finalPhaseSet = state.phaseSet;
          return state.phase !== 'specify';
        });
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.size).toBe('S');
    expect(result.phaseSet).toBeDefined();
    expect(result.phaseSet).not.toContain('plan');
    expect(result.phaseSet).not.toContain('program-design');
    expect(finalPhaseSet).not.toContain('plan');
  }, 30_000);

  it('classifies size L at specify and runs program-design (TASK-51/52)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [sizedSpecifyCandidate('L')],
        // program-design must be scripted or the run would block there
        'program-design': [candidate('program-design')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
    expect(result.size).toBe('L');
    expect(result.phaseSet).toContain('program-design');
  }, 30_000);

  it('omits program-design on an L run when disableProgramDesign is threaded (TASK-61)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [sizedSpecifyCandidate('L')],
      },
      async () => {},
      { taskId: 'task-1', repositoryId: 'repo-1', disableProgramDesign: true },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.size).toBe('L');
    expect(result.phaseSet).not.toContain('program-design');
  }, 30_000);

  // TASK-104 removed the contract gate where a human used to override the classifier. The intake
  // hint is the only remaining override, and it must still beat the classifier.
  it('an intake size hint wins over the classifier (TASK-51/104)', async () => {
    const { result } = await runWithActivities(
      { specify: [sizedSpecifyCandidate('L')] },
      async () => {},
      { taskId: 'task-1', repositoryId: 'repo-1', size: 'S' },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.size).toBe('S');
    expect(result.phaseSet).not.toContain('program-design');
  }, 30_000);

  it('resumes from a continue-as-new resumeState instead of starting fresh (TASK-26)', async () => {
    // Seed a state already at `release`. If resumeState is honored, only release+assimilate run;
    // specify/plan/etc. are never scripted, so a fresh-start workflow would stall on the missing
    // specify script. Reaching assimilate/completed proves the re-seed path.
    const resumeState = {
      taskId: 'task-1',
      repositoryId: 'repo-1',
      prompt: 'resumed',
      phase: 'release' as const,
      condition: 'running' as const,
      deliveryState: 'not-started' as const,
      attemptNumber: 0,
      latestCandidateEvidenceIds: [],
      openFindingIds: [],
      tokenUsageTotal: { inputTokens: 42, outputTokens: 7 },
      runtimeMsByPhase: { plan: 1234 },
    };
    const { result } = await runWithActivities(
      { release: [candidate('release')] },
      async () => {},
      { taskId: 'task-1', repositoryId: 'repo-1', prompt: 'resumed', resumeState },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
    // Accumulated usage carried over from the prior run is preserved across the re-seed.
    expect(result.tokenUsageTotal.inputTokens).toBe(42);
    expect(result.runtimeMsByPhase.plan).toBe(1234);
  }, 30_000);

  it('aggregates token usage across phases and runtime per phase (TASK-11)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidateWithUsage('specify', { inputTokens: 100, outputTokens: 20, runtimeMs: 500 })],
        plan: [candidateWithUsage('plan', { inputTokens: 200, outputTokens: 40, runtimeMs: 1500 })],
        implement: [candidateWithUsage('implement', { inputTokens: 300, outputTokens: 60, runtimeMs: 3000 })],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
    // Tokens sum across the whole task; runtime is bucketed per phase.
    expect(result.tokenUsageTotal).toEqual({ inputTokens: 600, outputTokens: 120 });
    expect(result.runtimeMsByPhase.specify).toBe(500);
    expect(result.runtimeMsByPhase.plan).toBe(1500);
    expect(result.runtimeMsByPhase.implement).toBe(3000);
  }, 30_000);

  // TASK-104: the three mandatory gates are gone. A routine task must walk the whole route with
  // ZERO `awaiting-human` transitions — this is the headline acceptance check for the pivot.
  it('advances specify through release with no awaiting-human transition (TASK-104)', async () => {
    const syncLog: TaskStateSync[] = [];
    const { result } = await runWithActivities(
      FULL_ROUTE,
      async () => {},
      { taskId: 'task-1', repositoryId: 'repo-1' },
      syncLog,
    );
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
    expect(result.deliveryState).toBe('draft-pr-open');
    expect(syncLog.map((entry) => entry.condition)).not.toContain('awaiting-human');
    expect(result.unmetCriteria).toBeUndefined();
  }, 30_000);

  it('loops verify failure back to implement, then succeeds on repair', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        verify: [repair(), candidate('verify')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
  }, 30_000);

  // TASK-105: a genuinely stuck phase (the runPhase Activity exhausting its retries — e.g. a hung
  // verify command that stopped heartbeating and tripped heartbeatTimeout) must NOT crash the
  // Workflow or silently replay. It is folded into the same no-progress accounting a repaired
  // failure uses: the throw is caught, treated as a repair, and the run recovers on the next pass.
  it('does not crash the workflow when runPhase throws — folds it into the repair loop (TASK-105)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        // First verify attempt throws (retries exhausted); the workflow catches it, repairs via
        // implement, and the second verify attempt yields a candidate so the run completes.
        verify: [THROW, candidate('verify')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
  }, 60_000);

  // TASK-105: a stuck-phase Activity failure is COUNTED on the same failure streak a repaired failure
  // uses, so it drives escalation to a `repeated-failure-no-progress` human gate rather than a silent
  // replay. Two repairs then a throw on verify reach NO_PROGRESS_THRESHOLD — the throw is the final
  // strike (a single THROW keeps the real activity-retry backoff paid just once). createScriptedActivities
  // holds the THROW across all of its retries before advancing, so the escalation is deterministic.
  it('counts a stuck runPhase throw toward the genuinely-stuck stop (TASK-105)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        verify: [repair(), repair(), THROW, candidate('verify')],
        release: [candidate('release')],
      },
      async () => {},
    );
    // The stop is terminal and autonomous: no park, and the run still opened its draft PR.
    expect(result.unmetCriteria?.stopReason).toBe('genuinely-stuck');
    expect(result.unmetCriteria?.reasons).toEqual(['repeated-failure-no-progress']);
    expect(result.deliveryState).toBe('draft-pr-open');
    expect(result.condition).toBe('failed');
  }, 90_000);

  it('routes a plan-critic rejection (replan) back to plan', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [replan('plan'), candidate('plan')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
  }, 30_000);

  it('routes a requirements finding at challenge back to specify', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify'), candidate('specify')],
        plan: [candidate('plan'), candidate('plan')],
        challenge: [replan('specify'), candidate('challenge')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
  }, 30_000);

  it('routes a challenge replan back to program-design on an L run, then completes (TASK-60)', async () => {
    // Classify L so program-design is in the phase set, then have challenge replan to it exactly once
    // (its first scripted result) before yielding a candidate. Reaching assimilate is itself the proof:
    // the workflow accepts `program-design` as a replan target, jumps back to it, re-completes it, and
    // drives forward again. If program-design were not a valid replan target the run could not converge.
    const { result } = await runWithActivities(
      {
        specify: [sizedSpecifyCandidate('L')],
        'program-design': [candidate('program-design'), candidate('program-design')],
        challenge: [replan('program-design'), candidate('challenge')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
    expect(result.size).toBe('L');
    expect(result.phaseSet).toContain('program-design');
  }, 30_000);

  // TASK-105: repeated identical repairs stop the loop and route to the draft PR. This is the
  // behaviour that replaced the `repeated-failure-no-progress` park.
  it('stops the loop after repeated identical repairs and terminates at the draft PR (TASK-105/106)', async () => {
    const syncLog: TaskStateSync[] = [];
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        verify: [repair(), repair(), repair(), candidate('verify')],
        release: [candidate('release')],
      },
      async () => {},
      { taskId: 'task-1', repositoryId: 'repo-1' },
      syncLog,
    );
    expect(result.unmetCriteria?.stopReason).toBe('genuinely-stuck');
    expect(result.unmetCriteria?.phase).toBe('verify');
    expect(result.deliveryState).toBe('draft-pr-open');
    expect(syncLog.map((entry) => entry.condition)).not.toContain('awaiting-human');
  }, 30_000);

  // TASK-105: the budget is the other stop. A task that keeps replanning burns attempts at one
  // phase; once `maxAttemptsPerPhase` is reached the loop stops rather than iterating forever.
  it('stops the loop when the per-phase attempt budget is exhausted (TASK-105)', async () => {
    const { result } = await runWithActivities(
      {
        // `specify` replans to itself, so every iteration re-enters specify and never advances.
        specify: [replan('specify'), replan('specify'), replan('specify'), candidate('specify')],
        release: [candidate('release')],
      },
      async () => {},
      {
        taskId: 'task-1',
        repositoryId: 'repo-1',
        loopBudget: { maxAttemptsPerPhase: 2, maxTotalTokens: 1_000_000, maxWallClockMs: 3_600_000 },
      },
    );
    expect(result.unmetCriteria?.stopReason).toBe('budget-exhausted');
    expect(result.unmetCriteria?.reasons).toEqual(['budget-exceeded']);
    expect(result.deliveryState).toBe('draft-pr-open');
  }, 30_000);

  // `extendBudget` no longer releases a park — it raises the ceiling of a run that is still going.
  it('extendBudget raises the budget of a live run (TASK-105)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        implement: [candidate('implement')],
      },
      async (handle) => {
        await handle.executeUpdate(extendBudgetUpdate, { args: [{ additionalMinutes: 30 }] });
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.loopBudget?.maxWallClockMs).toBe(4 * 60 * 60 * 1000 + 30 * 60_000);
  }, 30_000);

  // TASK-75/105: an exercise *evidence deficiency* is an `unmet` outcome. It stops the loop on the
  // FIRST occurrence — no failureStreak, so it can never be mislabelled as repeated-failure — and
  // the task still terminates at a draft PR carrying the unproven claim.
  it('stops on a first-hit exercise qa-inconclusive, not repeated-failure (TASK-75/105)', async () => {
    let observedPhase: string | undefined;
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        // Scripted ONCE. If the workflow looped it into implement and re-ran exercise, the streak
        // logic would eventually stop with a DIFFERENT reason.
        exercise: [unmet('qa-inconclusive', 'No QA scenario covered the behavioral claim.')],
        release: [candidate('release')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const criteria = await handle.query(getUnmetCriteriaQuery);
          if (criteria) {
            observedPhase = criteria.phase;
            return true;
          }
          return false;
        });
      },
    );
    expect(result.unmetCriteria?.stopReason).toBe('converged-unmet');
    expect(result.unmetCriteria?.reasons).toEqual(['qa-inconclusive']);
    expect(result.unmetCriteria?.unprovenClaims).toEqual(['claim-1']);
    expect(result.unmetCriteria?.detail).toBe('No QA scenario covered the behavioral claim.');
    // The stop was recorded while still ON exercise, not after bouncing through implement.
    expect(observedPhase).toBe('exercise');
    // And it still delivered: every task terminates at a draft PR (TASK-106).
    expect(result.deliveryState).toBe('draft-pr-open');
    expect(result.condition).toBe('failed');
  }, 30_000);

  // TASK-106: a phase that cannot run at all is terminal too — it reports `blocked`, and the
  // workflow routes to release rather than waiting for a human to unblock it.
  it('routes a blocked phase to the draft-PR terminal (TASK-106)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [{ outcome: 'blocked', reason: 'no planner available' } as PhaseAttemptResult],
        release: [candidate('release')],
      },
      async () => {},
    );
    expect(result.unmetCriteria?.stopReason).toBe('phase-blocked');
    expect(result.unmetCriteria?.detail).toContain('no planner available');
    expect(result.deliveryState).toBe('draft-pr-open');
  }, 30_000);

  // TASK-75 problem (2): a candidate that satisfies its claim and passes must reach the draft PR
  // with no failure accumulated and no unmet report.
  it('a passing exercise candidate reaches the draft PR with every claim met (TASK-75/106)', async () => {
    const { result } = await runWithActivities(FULL_ROUTE, async () => {});
    expect(result.unmetCriteria).toBeUndefined();
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
    expect(result.deliveryState).toBe('draft-pr-open');
  }, 30_000);

  it('marks the task cancelled on a cancel signal', async () => {
    const { result } = await runWithActivities(
      { specify: [candidate('specify')], plan: [candidate('plan')] },
      async (handle) => {
        await handle.signal(cancelSignal);
      },
    );
    expect(result.condition).toBe('cancelled');
  }, 30_000);

  // The merge/close signals survive the pivot, but they can only land while the run is still going:
  // merging is an out-of-band human action on GitHub AFTER the workbench has already terminated.
  it.each([
    { signal: pullRequestMergedSignal, args: [{ mergeCommitSha: 'abc123' }], expected: 'merged' },
    { signal: pullRequestClosedSignal, args: [], expected: 'closed' },
  ])('records deliveryState "$expected" when the signal lands mid-run', async ({ signal, args, expected }) => {
    const { result } = await runWithActivities(
      { specify: [candidate('specify')], plan: [candidate('plan')] },
      async (handle) => {
        await handle.signal(signal as never, ...(args as never[]));
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.deliveryState).toBe(expected);
  }, 30_000);

  // TASK-123: before this, nothing in production wrote tasks.phase/condition after the row was
  // inserted, so every row in the fleet view read `specify | running` forever. The Workflow now
  // mirrors each transition it decides onto the task row through the syncTaskState Activity.
  describe('task-state sync (TASK-123)', () => {
    /** The phase/condition pairs the workflow reported, in order. */
    function transitions(log: TaskStateSync[]): string[] {
      return log.map((s) => `${s.phase}|${s.condition}`);
    }

    it('writes each phase transition as the run advances', async () => {
      const syncLog: TaskStateSync[] = [];
      await runWithActivities(
        { specify: [candidate('specify')], plan: [candidate('plan')] },
        async () => {},
        { taskId: 'task-1', repositoryId: 'repo-1', prompt: 'do the thing' },
        syncLog,
      );

      const seen = transitions(syncLog);
      expect(seen).toContain('specify|running');
      expect(seen).toContain('plan|running');
      expect(seen).toContain('implement|running');
      // Order matters: a monitor must never see `implement` before `plan`.
      expect(seen.indexOf('specify|running')).toBeLessThan(seen.indexOf('plan|running'));
      expect(seen.indexOf('plan|running')).toBeLessThan(seen.indexOf('implement|running'));
      // The terminal state is decided after the phase loop, where no phase Activity runs.
      expect(seen.at(-1)).toBe('assimilate|completed');
      // Every write carries the identity the daemon needs to upsert the row.
      for (const entry of syncLog) {
        expect(entry.taskId).toBe('task-1');
        expect(entry.repositoryId).toBe('repo-1');
        expect(entry.prompt).toBe('do the thing');
      }
    }, 30_000);

    it('writes the loop-back when verify bounces the run to implement', async () => {
      const syncLog: TaskStateSync[] = [];
      await runWithActivities(
        {
          specify: [candidate('specify')],
          plan: [candidate('plan')],
          verify: [repair(), candidate('verify')],
        },
        async () => {},
        { taskId: 'task-1', repositoryId: 'repo-1' },
        syncLog,
      );

      const seen = transitions(syncLog);
      const firstVerify = seen.indexOf('verify|running');
      expect(firstVerify).toBeGreaterThanOrEqual(0);
      // The bounce re-enters implement AFTER verify already ran once.
      expect(seen.slice(firstVerify)).toContain('implement|running');
    }, 30_000);

    // TASK-104/123: the projection column keeps its name but now carries the unmet-criterion
    // reason. The task never reads `awaiting-human`, and the reason reaches the row.
    it('writes the unmet-criterion reason, never an awaiting-human park', async () => {
      const syncLog: TaskStateSync[] = [];
      await runWithActivities(
        {
          specify: [candidate('specify')],
          plan: [candidate('plan')],
          exercise: [unmet('qa-inconclusive')],
          release: [candidate('release')],
        },
        async () => {},
        { taskId: 'task-1', repositoryId: 'repo-1' },
        syncLog,
      );

      expect(syncLog.map((entry) => entry.condition)).not.toContain('awaiting-human');
      expect(syncLog.some((entry) => entry.pendingGateReason === 'qa-inconclusive')).toBe(true);
      expect(syncLog.at(-1)?.condition).toBe('failed');
    }, 30_000);

    it('writes the terminal condition on a cancel signal', async () => {
      const syncLog: TaskStateSync[] = [];
      await runWithActivities(
        { specify: [candidate('specify')], plan: [candidate('plan')] },
        async (handle) => {
          await handle.signal(cancelSignal);
        },
        { taskId: 'task-1', repositoryId: 'repo-1' },
        syncLog,
      );

      expect(syncLog.at(-1)?.condition).toBe('cancelled');
    }, 30_000);

    it('does not repeat an identical write', async () => {
      const syncLog: TaskStateSync[] = [];
      await runWithActivities(
        { specify: [candidate('specify')], plan: [candidate('plan')] },
        async () => {},
        { taskId: 'task-1', repositoryId: 'repo-1' },
        syncLog,
      );

      const seen = transitions(syncLog);
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).not.toBe(seen[i - 1]);
      }
    }, 30_000);
  });
});

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitForCondition timed out');
}
