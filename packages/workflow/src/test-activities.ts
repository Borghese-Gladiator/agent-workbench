import type { PhaseAttemptResult, TaskPhase } from '@awb/domain';
import type { TaskWorkflowState } from './workflow-types.js';
import type { TaskActivities } from './task-workflow.js';

/**
 * A scriptable fake `runPhase` activity implementation for Temporal workflow tests. Each call
 * consumes the next scripted result for the current phase (or repeats the last one if the script
 * for that phase is exhausted), so tests can express "verify fails once, then passes" etc.
 */
export function createScriptedActivities(
  script: Partial<Record<TaskPhase, PhaseAttemptResult[]>>,
): TaskActivities {
  const cursors = new Map<TaskPhase, number>();

  return {
    async runPhase({ phase, state }: { phase: TaskPhase; state: TaskWorkflowState }): Promise<PhaseAttemptResult> {
      const results = script[phase] ?? [defaultCandidate(phase, state)];
      const cursor = cursors.get(phase) ?? 0;
      const result = results[Math.min(cursor, results.length - 1)] as PhaseAttemptResult;
      cursors.set(phase, cursor + 1);
      return result;
    },
    async syncTaskState(): Promise<void> {},
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
