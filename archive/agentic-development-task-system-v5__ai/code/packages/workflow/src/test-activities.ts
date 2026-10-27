import type { PhaseAttemptResult, TaskPhase, TaskStateSync } from '@awb/domain';
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
 * How many times a {@link THROW} entry rejects before the cursor advances past it. A THROW models an
 * Activity whose Temporal retries are ALL exhausted, so it must keep rejecting across every retry of
 * the same call (Temporal re-invokes `runPhase` on each retry) — mirroring the workflow's own
 * `maximumAttempts: 3` — and only then let the workflow catch the exhausted failure and re-enter the
 * phase on the NEXT scripted entry. Advancing the cursor on the first throw (so a retry lands on the
 * following candidate and "succeeds") is exactly the nondeterminism that made the TASK-105 escalation
 * test flake, since whether the retried candidate arrived before the driver observed the gate was a
 * race.
 */
const THROW_RETRY_MAX = 3;

/**
 * Optional wiring for the scripted activities. `syncLog`, when given, collects every task-state sync
 * the workflow performs, in order — the assertion surface for the lifecycle-transition writes
 * (TASK-123).
 */
export interface ScriptedActivitiesOptions {
  syncLog?: TaskStateSync[];
}

/**
 * A scriptable fake `runPhase` activity implementation for Temporal workflow tests. Each call
 * consumes the next scripted result for the current phase (or repeats the last one if the script
 * for that phase is exhausted), so tests can express "verify fails once, then passes" etc. A
 * {@link THROW} entry makes the call reject on every Temporal retry until {@link THROW_RETRY_MAX}
 * rejections accumulate — standing in for an Activity whose retries are all exhausted — and only then
 * advances the cursor, so the workflow deterministically catches one exhausted failure per THROW.
 */
export function createScriptedActivities(
  script: Partial<Record<TaskPhase, ScriptEntry[]>>,
  options: ScriptedActivitiesOptions = {},
): TaskActivities {
  const cursors = new Map<TaskPhase, number>();
  const throwCounts = new Map<TaskPhase, number>();

  return {
    async syncTaskState(state: TaskStateSync): Promise<void> {
      options.syncLog?.push(state);
    },
    async runPhase({ phase, state }: { phase: TaskPhase; state: TaskWorkflowState }): Promise<PhaseAttemptResult> {
      const results = script[phase] ?? [defaultCandidate(phase, state)];
      const cursor = cursors.get(phase) ?? 0;
      const entry = results[Math.min(cursor, results.length - 1)] as ScriptEntry;
      if (entry === THROW) {
        // Keep rejecting on every retry of THIS call; advance the cursor only once the retries are
        // exhausted (so the workflow catches exactly one repair-loopback per THROW, then the next
        // phase entry consumes the following scripted entry).
        const seen = (throwCounts.get(phase) ?? 0) + 1;
        if (seen >= THROW_RETRY_MAX) {
          throwCounts.delete(phase);
          cursors.set(phase, cursor + 1);
        } else {
          throwCounts.set(phase, seen);
        }
        throw new Error(`scripted runPhase failure for phase ${phase}`);
      }
      cursors.set(phase, cursor + 1);
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
