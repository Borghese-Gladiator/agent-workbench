import type { LoopBudget, UnmetCriteria, FindingRef } from '@awb/domain';
import { isNoProgress, type NoProgressState } from './no-progress.js';

/**
 * The state slice `evaluateLoopBudget` reads. Kept structural (not the whole TaskWorkflowState) so
 * the stop-decision stays a pure function testable without a workflow.
 */
export interface LoopBudgetState {
  attemptNumber: number;
  tokenUsageTotal: { inputTokens: number; outputTokens: number };
  runtimeMsByPhase: Partial<Record<string, number>>;
  noProgress?: NoProgressState;
}

/**
 * Pure autonomy stop-decision (TASK-105). Returns the terminal `stopReason` when the loop must
 * halt WITHOUT proving every claim, or `undefined` to keep looping. Precedence: a genuinely-stuck
 * no-progress signal wins over budget exhaustion (a stuck loop is more actionable to report than a
 * bare budget number). The Workflow, never an agent, calls this and terminates with UnmetCriteria
 * instead of escalating to a human.
 */
export function evaluateLoopBudget(
  state: LoopBudgetState,
  budget: LoopBudget,
  noProgressThreshold: number,
): UnmetCriteria['stopReason'] | undefined {
  if (state.noProgress && isNoProgress(state.noProgress, noProgressThreshold)) {
    return 'genuinely-stuck';
  }
  const totalTokens = state.tokenUsageTotal.inputTokens + state.tokenUsageTotal.outputTokens;
  const totalRuntimeMs = Object.values(state.runtimeMsByPhase).reduce<number>((sum, ms) => sum + (ms ?? 0), 0);
  if (
    state.attemptNumber >= budget.maxPhaseAttempts ||
    totalTokens >= budget.maxTotalTokens ||
    totalRuntimeMs >= budget.maxWallClockMs
  ) {
    return 'budget-exhausted';
  }
  return undefined;
}

/**
 * Assemble the terminal UnmetCriteria record (TASK-105/106) the Workflow returns instead of parking
 * on a human gate. Unproven claims come from the completion decision's `missing`; the last candidate
 * SHA and any blocking findings + unmet dependencies are threaded through so the draft PR body can
 * render an honest met/unmet checklist.
 */
export function buildUnmetCriteria(input: {
  unprovenClaimIds: string[];
  stopReason: UnmetCriteria['stopReason'];
  lastCandidateSha?: string;
  blockingFindings?: FindingRef[];
  unmetDependencies?: string[];
}): UnmetCriteria {
  return {
    unprovenClaimIds: input.unprovenClaimIds,
    stopReason: input.stopReason,
    lastCandidateSha: input.lastCandidateSha,
    blockingFindings: input.blockingFindings ?? [],
    ...(input.unmetDependencies && input.unmetDependencies.length > 0
      ? { unmetDependencies: input.unmetDependencies }
      : {}),
  };
}
