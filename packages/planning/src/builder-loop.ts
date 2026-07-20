import {
  computeFailureFingerprint,
  initialNoProgressState,
  recordAttempt,
  isNoProgress,
  type FailureFingerprintInput,
  type NoProgressState,
} from '@awb/workflow';
import type { PlanSlice } from '@awb/domain';

export interface SliceAssignment {
  slice: PlanSlice;
  allowedScope: string[];
  tokenBudget: number;
  runtimeBudgetMs: number;
  openFindingIds: string[];
}

export interface SliceAttemptOutcome {
  /** True when this attempt's targeted checks passed and the slice can be considered done. */
  success: boolean;
  /** Present when the attempt failed a targeted check — used for the failure fingerprint / no-progress detection. */
  failure?: FailureFingerprintInput;
  /** True when this attempt produced no meaningful diff (an edit/revert loop signal, product spec §21). */
  noMeaningfulDiff?: boolean;
}

export interface RunSliceLoopInput {
  assignment: SliceAssignment;
  /** Executes one bounded builder attempt (inspect -> edit -> run targeted checks -> inspect diff) and reports the outcome. */
  runAttempt: (attemptNumber: number) => Promise<SliceAttemptOutcome>;
  maxAttempts?: number;
  noProgressThreshold?: number;
}

export type SliceLoopResult =
  | { outcome: 'success'; attempts: number }
  | { outcome: 'no-progress'; attempts: number; state: NoProgressState }
  | { outcome: 'budget-exhausted'; attempts: number };

/**
 * Runs one plan slice's bounded builder loop (product spec §21): inspect, make a bounded edit,
 * run targeted checks, inspect the diff, repair, checkpoint, proceed. Detects no-progress via
 * repeated identical failure fingerprints or repeated no-diff attempts and stops rather than
 * looping indefinitely — the caller (a phase Activity) turns "no-progress" into a repair/
 * await-human PhaseAttemptResult, this function itself never emits one.
 */
export async function runSliceLoop(input: RunSliceLoopInput): Promise<SliceLoopResult> {
  const maxAttempts = input.maxAttempts ?? 10;
  const noProgressThreshold = input.noProgressThreshold ?? 3;
  let state = initialNoProgressState();
  let noDiffStreak = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = await input.runAttempt(attempt);

    if (outcome.success) {
      return { outcome: 'success', attempts: attempt };
    }

    if (outcome.noMeaningfulDiff) {
      noDiffStreak += 1;
      if (noDiffStreak >= noProgressThreshold) {
        return { outcome: 'no-progress', attempts: attempt, state };
      }
      continue;
    }
    noDiffStreak = 0;

    if (outcome.failure) {
      const fingerprint = computeFailureFingerprint(outcome.failure);
      state = recordAttempt(state, fingerprint);
      if (isNoProgress(state, noProgressThreshold)) {
        return { outcome: 'no-progress', attempts: attempt, state };
      }
    }
  }

  return { outcome: 'budget-exhausted', attempts: maxAttempts };
}
