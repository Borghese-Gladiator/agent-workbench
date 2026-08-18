import { describe, expect, it } from 'vitest';
import type { LoopBudget } from '@awb/domain';
import { evaluateLoopBudget, buildUnmetCriteria } from './loop-budget.js';
import { initialNoProgressState, recordAttempt } from './failure-fingerprint.js';

const BUDGET: LoopBudget = { maxPhaseAttempts: 5, maxTotalTokens: 1000, maxWallClockMs: 10_000 };

function baseState(overrides: Partial<Parameters<typeof evaluateLoopBudget>[0]> = {}) {
  return {
    attemptNumber: 1,
    tokenUsageTotal: { inputTokens: 0, outputTokens: 0 },
    runtimeMsByPhase: {},
    ...overrides,
  };
}

describe('evaluateLoopBudget', () => {
  it('returns undefined with headroom on every dimension', () => {
    expect(evaluateLoopBudget(baseState(), BUDGET, 3)).toBeUndefined();
  });

  it('returns budget-exhausted when phase attempts hit the cap', () => {
    expect(evaluateLoopBudget(baseState({ attemptNumber: 5 }), BUDGET, 3)).toBe('budget-exhausted');
  });

  it('returns budget-exhausted when total tokens hit the cap', () => {
    expect(
      evaluateLoopBudget(baseState({ tokenUsageTotal: { inputTokens: 600, outputTokens: 400 } }), BUDGET, 3),
    ).toBe('budget-exhausted');
  });

  it('returns budget-exhausted when wall-clock runtime hits the cap', () => {
    expect(
      evaluateLoopBudget(baseState({ runtimeMsByPhase: { implement: 6000, verify: 4000 } }), BUDGET, 3),
    ).toBe('budget-exhausted');
  });

  it('returns genuinely-stuck when the same failure repeats past threshold', () => {
    let noProgress = initialNoProgressState();
    noProgress = recordAttempt(noProgress, 'same');
    noProgress = recordAttempt(noProgress, 'same');
    noProgress = recordAttempt(noProgress, 'same');
    expect(evaluateLoopBudget(baseState({ noProgress }), BUDGET, 3)).toBe('genuinely-stuck');
  });

  it('prefers genuinely-stuck over budget-exhausted when both fire', () => {
    let noProgress = initialNoProgressState();
    noProgress = recordAttempt(noProgress, 'x');
    noProgress = recordAttempt(noProgress, 'x');
    noProgress = recordAttempt(noProgress, 'x');
    expect(evaluateLoopBudget(baseState({ attemptNumber: 5, noProgress }), BUDGET, 3)).toBe('genuinely-stuck');
  });

  it('does not report stuck below threshold', () => {
    let noProgress = initialNoProgressState();
    noProgress = recordAttempt(noProgress, 'y');
    noProgress = recordAttempt(noProgress, 'y');
    expect(evaluateLoopBudget(baseState({ noProgress }), BUDGET, 3)).toBeUndefined();
  });
});

describe('buildUnmetCriteria', () => {
  it('assembles a populated record and omits empty dependency lists', () => {
    const unmet = buildUnmetCriteria({
      unprovenClaimIds: ['c1', 'c2'],
      stopReason: 'converged-unmet',
      lastCandidateSha: 'abc',
      blockingFindings: [{ id: 'f1', severity: 'blocker', category: 'correctness', description: 'boom' }],
    });
    expect(unmet.unprovenClaimIds).toEqual(['c1', 'c2']);
    expect(unmet.stopReason).toBe('converged-unmet');
    expect(unmet.lastCandidateSha).toBe('abc');
    expect(unmet.blockingFindings).toHaveLength(1);
    expect(unmet.unmetDependencies).toBeUndefined();
  });

  it('includes unmet dependencies when supplied', () => {
    const unmet = buildUnmetCriteria({
      unprovenClaimIds: [],
      stopReason: 'budget-exhausted',
      unmetDependencies: ['TASK-90'],
    });
    expect(unmet.unmetDependencies).toEqual(['TASK-90']);
    expect(unmet.blockingFindings).toEqual([]);
  });
});
