import type { TaskPhase, PhaseAttemptResult } from '@awb/domain';
import type { TaskWorkflowState } from '@awb/workflow';

/**
 * Real `runPhase` Activity implementation. For each phase, this is where agent sessions get
 * created, repository/workspace/verification/qa/review packages get called, and a typed
 * PhaseAttemptResult gets returned — this Activity itself performs no completion judgment, it
 * only assembles the CompletionCandidate (or repair/replan/await-human/blocked/cancelled outcome)
 * for the Workflow to hand to `evaluatePhaseCompletion`.
 *
 * Milestone 3 ships the Workflow shape and a stub that always returns a trivial "blocked" result,
 * since the actual phase implementations (planner, builder, verifier, QA, reviewer) depend on
 * packages built in later milestones (agent-gateway, verification, qa, review). Wiring real
 * per-phase logic here is tracked per-milestone rather than stubbed silently forever.
 */
export async function runPhase(input: {
  phase: TaskPhase;
  state: TaskWorkflowState;
}): Promise<PhaseAttemptResult> {
  return {
    outcome: 'blocked',
    reason: `Phase "${input.phase}" has no real implementation yet — Milestone 3 ships only the Workflow shape.`,
  };
}
