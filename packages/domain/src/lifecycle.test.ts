import { describe, expect, it } from 'vitest';
import {
  LoopBudgetSchema,
  UnmetCriteriaSchema,
  UnmetCriteriaStopReasonSchema,
  HumanGateReasonSchema,
  PhaseAttemptResultSchema,
} from './lifecycle.js';

describe('LoopBudgetSchema', () => {
  it('round-trips a valid budget', () => {
    const budget = { maxPhaseAttempts: 5, maxTotalTokens: 1_000_000, maxWallClockMs: 3_600_000 };
    expect(LoopBudgetSchema.parse(budget)).toEqual(budget);
  });

  it('rejects a non-positive dimension', () => {
    expect(() => LoopBudgetSchema.parse({ maxPhaseAttempts: 0, maxTotalTokens: 1, maxWallClockMs: 1 })).toThrow();
  });
});

describe('UnmetCriteriaSchema', () => {
  it('round-trips a fully-populated non-convergence record', () => {
    const unmet = {
      unprovenClaimIds: ['claim-1', 'claim-2'],
      lastCandidateSha: 'a'.repeat(40),
      blockingFindings: [{ id: 'f1', severity: 'blocker' as const, category: 'correctness', description: 'boom' }],
      stopReason: 'converged-unmet' as const,
      unmetDependencies: ['TASK-90'],
    };
    expect(UnmetCriteriaSchema.parse(unmet)).toEqual(unmet);
  });

  it('accepts a minimal record (no sha, no deps)', () => {
    const unmet = { unprovenClaimIds: ['c1'], blockingFindings: [], stopReason: 'budget-exhausted' as const };
    expect(UnmetCriteriaSchema.parse(unmet)).toEqual(unmet);
  });

  it('exposes exactly the three terminal stop reasons', () => {
    expect(UnmetCriteriaStopReasonSchema.options).toEqual([
      'converged-unmet',
      'budget-exhausted',
      'genuinely-stuck',
    ]);
  });
});

describe('HumanGateReasonSchema (pruned)', () => {
  it('no longer includes the removed blocking-gate reasons', () => {
    for (const removed of ['task-contract-approval', 'pr-readiness', 'repeated-failure-no-progress', 'budget-exceeded']) {
      expect(() => HumanGateReasonSchema.parse(removed)).toThrow();
    }
  });

  it('still includes the retained advisory reasons', () => {
    expect(HumanGateReasonSchema.parse('qa-inconclusive')).toBe('qa-inconclusive');
    expect(HumanGateReasonSchema.parse('first-time-repository-trust')).toBe('first-time-repository-trust');
  });
});

describe('PhaseAttemptResultSchema unmet-criteria variant', () => {
  it('parses a terminal unmet-criteria result', () => {
    const result = PhaseAttemptResultSchema.parse({
      outcome: 'unmet-criteria',
      unmetCriteria: {
        unprovenClaimIds: ['c1'],
        blockingFindings: [],
        stopReason: 'genuinely-stuck',
      },
    });
    expect(result.outcome).toBe('unmet-criteria');
  });
});
