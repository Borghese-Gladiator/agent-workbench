import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhaseAttemptResult, TaskPhase } from '@awb/domain';
import {
  TaskWorkflow,
  approveContractUpdate,
  extendBudgetUpdate,
  cancelSignal,
  pullRequestMergedSignal,
  pullRequestClosedSignal,
  getCurrentStateQuery,
} from './task-workflow.js';
import { createScriptedActivities } from './test-activities.js';

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

function makeGate(phase: TaskPhase, reason: 'task-contract-approval' | 'pr-readiness') {
  return {
    id: `gate-${phase}`,
    taskId: 'task-1',
    phase,
    reason,
    summary: 'test gate',
    createdAt: new Date().toISOString(),
  };
}

function repair(): PhaseAttemptResult {
  return { outcome: 'repair', target: 'implement', findings: [] };
}

function replan(target: 'plan' | 'specify'): PhaseAttemptResult {
  return { outcome: 'replan', target, findings: [] };
}

async function runWithActivities(
  script: Partial<Record<TaskPhase, PhaseAttemptResult[]>>,
  driveWorkflow: (handle: import('@temporalio/client').WorkflowHandle) => Promise<void>,
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
    activities: createScriptedActivities(script),
  });

  let handle!: import('@temporalio/client').WorkflowHandle;
  const result = await worker.runUntil(async () => {
    handle = await testEnv.client.workflow.start(TaskWorkflow, {
      taskQueue,
      workflowId: `test-${Date.now()}-${Math.random()}`,
      args: [{ taskId: 'task-1', repositoryId: 'repo-1' }],
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
});

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitForCondition timed out');
}
