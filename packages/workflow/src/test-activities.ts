import type { PhaseAttemptResult, TaskPhase } from '@awb/domain';
import type { TaskWorkflowState } from './workflow-types.js';
import type { TaskActivities } from './task-workflow.js';

/**
 * Sentinel a script entry can carry to make the fake `runPhase` THROW on that call, simulating an
 * Activity whose Temporal retries were exhausted (e.g. a genuinely stuck phase that stopped
 * heartbeating). The workflow folds such a failure into its no-progress accounting.
 */
export const THROW = Symbol('runPhase-throws');
export type ScriptEntry = PhaseAttemptResult | typeof THROW;

/**
 * A scriptable fake `runPhase` activity implementation for Temporal workflow tests. Each call
 * consumes the next scripted result for the current phase (or repeats the last one if the script
 * for that phase is exhausted), so tests can express "verify fails once, then passes" etc. A
 * {@link THROW} entry makes that call reject, standing in for an exhausted-retry Activity failure.
 */
export function createScriptedActivities(
  script: Partial<Record<TaskPhase, ScriptEntry[]>>,
): TaskActivities {
  const cursors = new Map<TaskPhase, number>();

  return {
    async runPhase({ phase, state }: { phase: TaskPhase; state: TaskWorkflowState }): Promise<PhaseAttemptResult> {
      const results = script[phase] ?? [defaultCandidate(phase, state)];
      const cursor = cursors.get(phase) ?? 0;
      const entry = results[Math.min(cursor, results.length - 1)] as ScriptEntry;
      cursors.set(phase, cursor + 1);
      if (entry === THROW) {
        throw new Error(`scripted runPhase failure for phase ${phase}`);
      }
      return entry;
    },
  };
}

function defaultCandidate(phase: TaskPhase, state: TaskWorkflowState): PhaseAttemptResult {
  return {
    outcome: 'candidate',
    candidate: {
      phase,
      phaseAttemptId: `${state.taskId}-${phase}-${state.attemptNumber}`,
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
