import { describe, expect, it } from 'vitest';
import { runSliceLoop, type SliceAssignment, type SliceAttemptOutcome } from './builder-loop.js';
import type { PlanSlice } from '@awb/domain';

const slice: PlanSlice = {
  id: 'slice-1',
  objective: 'implement feature',
  claimIds: [],
  likelyPaths: [],
  requiredTargetedChecks: ['unit'],
  dependencies: [],
};

const assignment: SliceAssignment = {
  slice,
  allowedScope: ['src/'],
  tokenBudget: 100_000,
  runtimeBudgetMs: 60_000,
  openFindingIds: [],
};

const failureBase = {
  command: 'pnpm test',
  exitCode: 1,
  failingTestIds: ['a.test.ts'],
  normalizedErrorClass: 'AssertionError',
  topRelevantStackFrame: 'src/foo.ts:1',
};

describe('runSliceLoop', () => {
  it('succeeds on the first attempt', async () => {
    const result = await runSliceLoop({
      assignment,
      runAttempt: async (): Promise<SliceAttemptOutcome> => ({ success: true }),
    });
    expect(result).toEqual({ outcome: 'success', attempts: 1 });
  });

  it('succeeds after a transient failure that is not repeated', async () => {
    let call = 0;
    const result = await runSliceLoop({
      assignment,
      runAttempt: async (): Promise<SliceAttemptOutcome> => {
        call += 1;
        if (call === 1) return { success: false, failure: failureBase };
        return { success: true };
      },
    });
    expect(result.outcome).toBe('success');
  });

  it('detects no-progress after the same failure fingerprint repeats to the threshold', async () => {
    const result = await runSliceLoop({
      assignment,
      noProgressThreshold: 3,
      runAttempt: async (): Promise<SliceAttemptOutcome> => ({ success: false, failure: failureBase }),
    });
    expect(result.outcome).toBe('no-progress');
    if (result.outcome === 'no-progress') {
      expect(result.attempts).toBe(3);
    }
  });

  it('does not treat different failures as no-progress', async () => {
    let call = 0;
    const result = await runSliceLoop({
      assignment,
      maxAttempts: 4,
      noProgressThreshold: 3,
      runAttempt: async (): Promise<SliceAttemptOutcome> => {
        call += 1;
        if (call < 4) {
          return { success: false, failure: { ...failureBase, exitCode: call } };
        }
        return { success: true };
      },
    });
    expect(result.outcome).toBe('success');
  });

  it('detects no-progress from repeated no-meaningful-diff attempts (edit/revert loop)', async () => {
    const result = await runSliceLoop({
      assignment,
      noProgressThreshold: 3,
      runAttempt: async (): Promise<SliceAttemptOutcome> => ({ success: false, noMeaningfulDiff: true }),
    });
    expect(result.outcome).toBe('no-progress');
  });

  it('reports budget-exhausted after maxAttempts with no success and no no-progress detection', async () => {
    const result = await runSliceLoop({
      assignment,
      maxAttempts: 3,
      noProgressThreshold: 10,
      runAttempt: async (attemptNumber): Promise<SliceAttemptOutcome> => ({
        success: false,
        failure: { ...failureBase, exitCode: attemptNumber },
      }),
    });
    expect(result.outcome).toBe('budget-exhausted');
  });

  it('resets the no-diff streak once a real (non-no-diff) failure occurs', async () => {
    let call = 0;
    const result = await runSliceLoop({
      assignment,
      maxAttempts: 6,
      noProgressThreshold: 2,
      runAttempt: async (): Promise<SliceAttemptOutcome> => {
        call += 1;
        if (call === 1) return { success: false, noMeaningfulDiff: true };
        if (call === 2) return { success: false, failure: { ...failureBase, exitCode: 99 } };
        if (call === 3) return { success: false, noMeaningfulDiff: true };
        return { success: true };
      },
    });
    expect(result.outcome).toBe('success');
  });
});
