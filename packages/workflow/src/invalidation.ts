import type { TaskPhase } from '@awb/domain';

/**
 * Invalidation cascade (product spec §11). Given which identifiers changed between an existing
 * piece of evidence and the task's current state, determines which downstream phases' evidence
 * must be considered stale and re-attempted. Pure lookup — the caller (an Activity) is
 * responsible for actually comparing versions/SHAs and for re-running the invalidated phases.
 */
export interface VersionChange {
  contractChanged: boolean;
  planChanged: boolean;
  candidateShaChanged: boolean;
  qaScenarioChanged: boolean;
}

const PHASES_AFTER_PLAN: TaskPhase[] = ['implement', 'verify', 'exercise', 'challenge', 'release'];
const PHASES_AFTER_IMPLEMENT: TaskPhase[] = ['verify', 'exercise', 'challenge', 'release'];
const PHASES_AFTER_EXERCISE: TaskPhase[] = ['exercise', 'challenge', 'release'];

/** Returns the set of phases whose evidence must be invalidated given what changed. */
export function invalidatedPhases(change: VersionChange): Set<TaskPhase> {
  const invalidated = new Set<TaskPhase>();

  if (change.contractChanged) {
    invalidated.add('plan');
    for (const phase of PHASES_AFTER_PLAN) invalidated.add(phase);
  }

  if (change.planChanged) {
    // "implementation mapping" (plan slice -> code) is invalidated too, not just what runs after it.
    for (const phase of PHASES_AFTER_PLAN) invalidated.add(phase);
  }

  if (change.candidateShaChanged) {
    for (const phase of PHASES_AFTER_IMPLEMENT) invalidated.add(phase);
  }

  if (change.qaScenarioChanged) {
    for (const phase of PHASES_AFTER_EXERCISE) invalidated.add(phase);
  }

  return invalidated;
}

/** A target-branch reconciliation during Release that changes the candidate SHA routes back to Verify (spec §11). */
export function releaseReconciliationRoutesToVerify(candidateShaChangedDuringReconciliation: boolean): boolean {
  return candidateShaChangedDuringReconciliation;
}
