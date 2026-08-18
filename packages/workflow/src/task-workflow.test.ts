import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PhaseAttemptResult, TaskPhase, UnmetCriteria } from '@awb/domain';
import {
  TaskWorkflow,
  cancelSignal,
  getCurrentStateQuery,
} from './task-workflow.js';
import { createScriptedActivities } from './test-activities.js';
import type { TaskWorkflowInput } from './workflow-types.js';

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createLocal();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

let taskQueueCounter = 0;

function candidate(phase: TaskPhase, candidateSha?: string): PhaseAttemptResult {
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
      ...(candidateSha ? { candidateSha } : {}),
    },
  };
}

function unmetCriteriaResult(unmet: UnmetCriteria): PhaseAttemptResult {
  return { outcome: 'unmet-criteria', unmetCriteria: unmet };
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

function repairWithFinding(id: string): PhaseAttemptResult {
  return {
    outcome: 'repair',
    target: 'implement',
    findings: [{ id, severity: 'high', category: 'correctness', description: 'same defect' }],
  };
}

function replan(target: 'plan' | 'program-design' | 'specify'): PhaseAttemptResult {
  return { outcome: 'replan', target, findings: [] };
}

async function runWithActivities(
  script: Partial<Record<TaskPhase, PhaseAttemptResult[]>>,
  driveWorkflow: (handle: import('@temporalio/client').WorkflowHandle) => Promise<void>,
  args: TaskWorkflowInput = { taskId: 'task-1', repositoryId: 'repo-1' },
) {
  const taskQueue = `awb-test-queue-${++taskQueueCounter}`;
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath: new URL('../dist/task-workflow.js', import.meta.url).pathname,
    activities: createScriptedActivities(script),
  });

  let handle!: import('@temporalio/client').WorkflowHandle;
  const result = await worker.runUntil(async () => {
    handle = await testEnv.client.workflow.start(TaskWorkflow, {
      taskQueue,
      workflowId: `test-${Date.now()}-${Math.random()}`,
      args: [args],
    });
    await Promise.all([driveWorkflow(handle), handle.result()]);
    return handle.result();
  });
  return { handle, result };
}

/** Records every condition the workflow passed through, so a test can assert it NEVER entered awaiting-human. */
async function collectConditions(handle: import('@temporalio/client').WorkflowHandle, seen: Set<string>): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 8_000) {
    try {
      const state = await handle.query(getCurrentStateQuery);
      seen.add(state.condition);
      if (state.phase === 'assimilate') return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('TaskWorkflow — autonomy pivot', () => {
  it('advances a routine task specify→…→release to succeeded with ZERO awaiting-human transitions', async () => {
    const seen = new Set<string>();
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        release: [candidate('release', 'f'.repeat(40))],
      },
      async (handle) => {
        await collectConditions(handle, seen);
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
    // The whole point of the pivot: the loop never parks on a human.
    expect(seen.has('awaiting-human')).toBe(false);
    expect(result.unmetCriteria).toBeUndefined();
  }, 30_000);

  it('all-claims-proven terminates succeeded without any merge/close signal', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        release: [candidate('release')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
    expect(result.condition).toBe('completed');
  }, 30_000);

  it('a release non-convergence terminates with a populated UnmetCriteria, never awaiting-human', async () => {
    const seen = new Set<string>();
    const unmet: UnmetCriteria = {
      unprovenClaimIds: ['claim-1'],
      lastCandidateSha: 'a'.repeat(40),
      blockingFindings: [{ id: 'f1', severity: 'blocker', category: 'correctness', description: 'still failing' }],
      stopReason: 'converged-unmet',
      unmetDependencies: ['TASK-90'],
    };
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        release: [unmetCriteriaResult(unmet)],
      },
      async (handle) => {
        await collectConditions(handle, seen);
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(seen.has('awaiting-human')).toBe(false);
    expect(result.unmetCriteria).toBeDefined();
    expect(result.unmetCriteria?.stopReason).toBe('converged-unmet');
    expect(result.unmetCriteria?.unprovenClaimIds).toEqual(['claim-1']);
    expect(result.unmetCriteria?.unmetDependencies).toEqual(['TASK-90']);
  }, 30_000);

  it('an over-budget task diverts to release and terminates with a budget-exhausted UnmetCriteria', async () => {
    const seen = new Set<string>();
    // implement repairs with DISTINCT findings each attempt (so it is never genuinely-stuck — it
    // makes "progress") but each attempt burns tokens; a tiny token budget trips budget-exhausted.
    const burnRepair = (id: string): PhaseAttemptResult => ({
      ...repairWithFinding(id),
      usage: { inputTokens: 500, outputTokens: 500, runtimeMs: 10 },
    });
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        implement: [burnRepair('a'), burnRepair('b'), burnRepair('c'), burnRepair('d')],
        release: [candidate('release', 'b'.repeat(40))],
      },
      async (handle) => {
        await collectConditions(handle, seen);
      },
      {
        taskId: 'task-1',
        repositoryId: 'repo-1',
        loopBudget: { maxPhaseAttempts: 100, maxTotalTokens: 1500, maxWallClockMs: 3_600_000 },
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(seen.has('awaiting-human')).toBe(false);
    expect(result.unmetCriteria?.stopReason).toBe('budget-exhausted');
  }, 30_000);

  it('a genuinely-stuck task (identical repairs) terminates with a genuinely-stuck UnmetCriteria', async () => {
    const seen = new Set<string>();
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        // Same finding id every attempt → same fingerprint → genuinely-stuck once it repeats 3x.
        implement: [repairWithFinding('same'), repairWithFinding('same'), repairWithFinding('same'), repairWithFinding('same')],
        release: [candidate('release')],
      },
      async (handle) => {
        await collectConditions(handle, seen);
      },
      { taskId: 'task-1', repositoryId: 'repo-1', loopBudget: { maxPhaseAttempts: 100, maxTotalTokens: 1_000_000, maxWallClockMs: 3_600_000 } },
    );
    expect(result.phase).toBe('assimilate');
    expect(seen.has('awaiting-human')).toBe(false);
    expect(result.unmetCriteria?.stopReason).toBe('genuinely-stuck');
  }, 30_000);

  it('classifies size S at specify and skips plan + program-design (TASK-51)', async () => {
    const { result } = await runWithActivities(
      { specify: [sizedSpecifyCandidate('S')] },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
    expect(result.size).toBe('S');
    expect(result.phaseSet).not.toContain('plan');
    expect(result.phaseSet).not.toContain('program-design');
  }, 30_000);

  it('classifies size L at specify and runs program-design (TASK-51/52)', async () => {
    const { result } = await runWithActivities(
      {
        specify: [sizedSpecifyCandidate('L')],
        'program-design': [candidate('program-design')],
      },
      async () => {},
    );
    expect(result.phase).toBe('assimilate');
    expect(result.size).toBe('L');
    expect(result.phaseSet).toContain('program-design');
  }, 30_000);

  it('resumes from a continue-as-new resumeState instead of starting fresh (TASK-26)', async () => {
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
    expect(result.tokenUsageTotal).toEqual({ inputTokens: 600, outputTokens: 120 });
    expect(result.runtimeMsByPhase.specify).toBe(500);
    expect(result.runtimeMsByPhase.plan).toBe(1500);
    expect(result.runtimeMsByPhase.implement).toBe(3000);
  }, 30_000);

  it('loops verify failure back to implement, then succeeds on repair (no human gate)', async () => {
    const seen = new Set<string>();
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        plan: [candidate('plan')],
        verify: [repair(), candidate('verify')],
      },
      async (handle) => {
        await collectConditions(handle, seen);
      },
    );
    expect(result.phase).toBe('assimilate');
    expect(seen.has('awaiting-human')).toBe(false);
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

  it('routes a challenge replan back to program-design on an L run, then completes (TASK-60)', async () => {
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

  it('marks the task cancelled on a cancel signal', async () => {
    const { result } = await runWithActivities(
      {
        specify: [candidate('specify')],
        // plan replans to itself indefinitely, so the run keeps looping until the cancel lands.
        plan: Array.from({ length: 50 }, () => replan('plan')),
      },
      async (handle) => {
        await new Promise((r) => setTimeout(r, 200));
        await handle.signal(cancelSignal);
      },
    );
    expect(result.condition).toBe('cancelled');
  }, 30_000);
});
