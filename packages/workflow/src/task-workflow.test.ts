import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhaseAttemptResult, TaskPhase, TaskStateSync } from '@awb/domain';
import {
  TaskWorkflow,
  approveContractUpdate,
  extendBudgetUpdate,
  cancelSignal,
  pullRequestMergedSignal,
  pullRequestClosedSignal,
  getCurrentStateQuery,
  getPendingHumanGateQuery,
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

function awaitHuman(phase: TaskPhase, reason: Parameters<typeof makeGate>[1]): PhaseAttemptResult {
  return { outcome: 'await-human', gate: makeGate(phase, reason) };
}

function makeGate(phase: TaskPhase, reason: 'task-contract-approval' | 'pr-readiness' | 'qa-inconclusive') {
  return {
    id: `gate-${phase}`,
    taskId: 'task-1',
    phase,
    reason,
    summary: 'test gate',
    createdAt: new Date().toISOString(),
  };
}

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

  it('a human size override at the contract gate wins over the classifier (TASK-51)', async () => {
    // Classifier says L, but the human approves with size S — the run must skip plan/program-design.
    const { result } = await runWithActivities(
      {
        specify: [awaitHuman('specify', 'task-contract-approval'), sizedSpecifyCandidate('L')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          return state.condition === 'awaiting-human';
        });
        await handle.executeUpdate(approveContractUpdate, { args: [{ contractVersion: 1, size: 'S' }] });
      },
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

  it('blocks at specify awaiting contract approval, then resumes once approved', async () => {
    const { result } = await runWithActivities(
      {
        specify: [awaitHuman('specify', 'task-contract-approval'), candidate('specify')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          return state.condition === 'awaiting-human';
        });
        await handle.executeUpdate(approveContractUpdate, { args: [{ contractVersion: 1 }] });
      },
    );
    expect(result.phase).toBe('assimilate');
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
  it('counts a stuck runPhase throw toward repeated-failure-no-progress escalation (TASK-105)', async () => {
    let observedReason: string | undefined;
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        verify: [repair(), repair(), THROW, candidate('verify')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          if (state.condition === 'awaiting-human') {
            observedReason = (await handle.query(getPendingHumanGateQuery))?.reason;
            return true;
          }
          return false;
        }, 60_000);
        await handle.signal(cancelSignal);
      },
    );
    expect(observedReason).toBe('repeated-failure-no-progress');
    expect(result.condition).toBe('cancelled');
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

  it('escalates to a human gate after repeated identical repair outcomes, then resumes after extendBudget', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        verify: [repair(), repair(), repair(), candidate('verify')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          return state.condition === 'awaiting-human';
        });
        await handle.executeUpdate(extendBudgetUpdate, { args: [{ additionalMinutes: 30 }] });
      },
    );
    expect(result.phase).toBe('assimilate');
  }, 30_000);

  // TASK-75 problem (1): an exercise *evidence deficiency* now surfaces as an await-human
  // `qa-inconclusive` gate. It must park on the FIRST occurrence — no failureStreak, so it can
  // never reach the 3-strike `repeated-failure-no-progress` trap that a `repair → implement` loop
  // produced. Contrast with the escalation test above: three `repair()`s were needed to escalate.
  it('parks an exercise qa-inconclusive gate on first hit, not repeated-failure-no-progress (TASK-75)', async () => {
    let observedReason: string | undefined;
    let observedAfterOneExercise = false;
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        // The exercise handler returns this exact shape for a pure evidence deficiency (see
        // mapExerciseBlock). It is scripted ONCE — if the workflow looped it into implement and
        // re-ran exercise, the streak logic would eventually escalate with a DIFFERENT reason.
        exercise: [awaitHuman('exercise', 'qa-inconclusive')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          if (state.condition === 'awaiting-human') {
            const gate = await handle.query(getPendingHumanGateQuery);
            observedReason = gate?.reason;
            // Prove the gate opened while still ON the exercise phase (not after bouncing to
            // implement): attemptNumber is the first exercise attempt and phase is exercise.
            observedAfterOneExercise = state.phase === 'exercise';
            return true;
          }
          return false;
        });
        // Resolve the gate (as a human supplying QA config would) so the run can finish and the
        // test env tears down cleanly. Re-scripting exercise as a candidate lets it proceed.
        await handle.signal(cancelSignal);
      },
    );
    expect(observedReason).toBe('qa-inconclusive');
    expect(observedReason).not.toBe('repeated-failure-no-progress');
    expect(observedAfterOneExercise).toBe(true);
    expect(result.condition).toBe('cancelled');
  }, 30_000);

  // TASK-75 problem (2): a candidate that satisfies its claim and passes must EXIT the exercise
  // gate and reach pr-readiness — it must not accumulate any failure and must not park at
  // repeated-failure-no-progress. A clean exercise `candidate()` walks straight through to release.
  it('a passing exercise candidate reaches pr-readiness without a no-progress park (TASK-75)', async () => {
    let sawRepeatedFailurePark = false;
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        prepare: [candidate('prepare')],
        implement: [candidate('implement')],
        verify: [candidate('verify')],
        exercise: [candidate('exercise')],
        challenge: [candidate('challenge')],
        release: [awaitHuman('release', 'pr-readiness')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          const gate = await handle.query(getPendingHumanGateQuery);
          if (gate?.reason === 'repeated-failure-no-progress') sawRepeatedFailurePark = true;
          return state.phase === 'release' && state.condition === 'awaiting-human';
        });
        await handle.signal(pullRequestMergedSignal, { mergeCommitSha: 'abc123' });
      },
    );
    // Reached the pr-readiness gate (release) and never parked at a no-progress human gate.
    expect(sawRepeatedFailurePark).toBe(false);
    expect(result.phase).toBe('assimilate');
    expect(result.deliveryState).toBe('merged');
  }, 30_000);

  it('marks the task cancelled on a cancel signal', async () => {
    const { result } = await runWithActivities(
      {
        specify: [awaitHuman('specify', 'task-contract-approval')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          return state.condition === 'awaiting-human';
        });
        await handle.signal(cancelSignal);
      },
    );
    expect(result.condition).toBe('cancelled');
  }, 30_000);

  it('routes to assimilate with deliveryState "merged" on a pullRequestMerged signal', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        prepare: [candidate('prepare')],
        implement: [candidate('implement')],
        verify: [candidate('verify')],
        exercise: [candidate('exercise')],
        challenge: [candidate('challenge')],
        release: [awaitHuman('release', 'pr-readiness')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          return state.phase === 'release' && state.condition === 'awaiting-human';
        });
        await handle.signal(pullRequestMergedSignal, { mergeCommitSha: 'abc123' });
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.deliveryState).toBe('merged');
  }, 30_000);

  it('routes to assimilate with deliveryState "closed" on a pullRequestClosed signal', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        prepare: [candidate('prepare')],
        implement: [candidate('implement')],
        verify: [candidate('verify')],
        exercise: [candidate('exercise')],
        challenge: [candidate('challenge')],
        release: [awaitHuman('release', 'pr-readiness')],
      },
      async (handle) => {
        await waitForCondition(async () => {
          const state = await handle.query(getCurrentStateQuery);
          return state.phase === 'release' && state.condition === 'awaiting-human';
        });
        await handle.signal(pullRequestClosedSignal);
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.deliveryState).toBe('closed');
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

    it('writes the park and its gate reason when the run awaits a human', async () => {
      const syncLog: TaskStateSync[] = [];
      await runWithActivities(
        { specify: [awaitHuman('specify', 'task-contract-approval'), candidate('specify')] },
        async (handle) => {
          await waitForCondition(async () => {
            const state = await handle.query(getCurrentStateQuery);
            return state.condition === 'awaiting-human';
          });
          await handle.executeUpdate(approveContractUpdate, { args: [{ contractVersion: 1 }] });
        },
        { taskId: 'task-1', repositoryId: 'repo-1' },
        syncLog,
      );

      const park = syncLog.find((s) => s.condition === 'awaiting-human');
      expect(park).toBeDefined();
      expect(park?.phase).toBe('specify');
      expect(park?.pendingGateReason).toBe('task-contract-approval');
      // Resolving the gate clears the reason on the next write, so the row stops reading as gated.
      const afterPark = syncLog.slice(syncLog.indexOf(park!) + 1);
      expect(afterPark.some((s) => s.condition === 'running' && s.pendingGateReason === null)).toBe(true);
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
