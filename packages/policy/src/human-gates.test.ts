import { describe, expect, it } from 'vitest';
import {
  conditionalPlanGateReasons,
  plannerCriticNonConvergence,
  flakyBaselineBlocksCompletion,
  repeatedFailureNoProgress,
  tokenOrRuntimeBudgetExceeded,
  qaRemainsInconclusive,
  reviewerFindingRequiresProductDecision,
  waiverRequested,
  isMandatoryGate,
  requiresPlanApprovalGate,
  MANDATORY_GATE_REASONS,
  type PlanGateInputs,
} from './human-gates.js';

const noTriggers: PlanGateInputs = {
  introducesNewDependency: false,
  changesPublicApi: false,
  changesAuthOrAuthorization: false,
  touchesPaymentsSecretsOrDestructiveMigration: false,
  expandsTaskScope: false,
  requiresUnvalidatedOrPrivilegedCommand: false,
  requestsHostAccessOutsideWorktree: false,
  requestsArbitraryExternalNetworkAccess: false,
};

describe('conditionalPlanGateReasons', () => {
  it('returns no reasons when nothing triggers', () => {
    expect(conditionalPlanGateReasons(noTriggers)).toEqual([]);
  });

  it('flags a new dependency', () => {
    expect(conditionalPlanGateReasons({ ...noTriggers, introducesNewDependency: true })).toEqual(['new-dependency']);
  });

  it('flags a public API change', () => {
    expect(conditionalPlanGateReasons({ ...noTriggers, changesPublicApi: true })).toEqual(['public-api-change']);
  });

  it('flags an auth/authorization change', () => {
    expect(conditionalPlanGateReasons({ ...noTriggers, changesAuthOrAuthorization: true })).toEqual(['auth-change']);
  });

  it('flags payments/secrets/destructive migrations as a sensitive change', () => {
    expect(
      conditionalPlanGateReasons({ ...noTriggers, touchesPaymentsSecretsOrDestructiveMigration: true }),
    ).toEqual(['sensitive-change']);
  });

  it('flags scope expansion', () => {
    expect(conditionalPlanGateReasons({ ...noTriggers, expandsTaskScope: true })).toEqual(['scope-expansion']);
  });

  it('flags an unvalidated or privileged command requirement', () => {
    expect(
      conditionalPlanGateReasons({ ...noTriggers, requiresUnvalidatedOrPrivilegedCommand: true }),
    ).toEqual(['unvalidated-privileged-command']);
  });

  it('flags a host-access request outside the worktree', () => {
    expect(
      conditionalPlanGateReasons({ ...noTriggers, requestsHostAccessOutsideWorktree: true }),
    ).toEqual(['host-access-request']);
  });

  it('flags an arbitrary external network access request', () => {
    expect(
      conditionalPlanGateReasons({ ...noTriggers, requestsArbitraryExternalNetworkAccess: true }),
    ).toEqual(['external-network-request']);
  });

  it('accumulates multiple simultaneous triggers', () => {
    const result = conditionalPlanGateReasons({
      ...noTriggers,
      introducesNewDependency: true,
      changesAuthOrAuthorization: true,
    });
    expect(result.sort()).toEqual(['auth-change', 'new-dependency'].sort());
  });
});

describe('plannerCriticNonConvergence', () => {
  it('does not trigger below the max attempts', () => {
    expect(plannerCriticNonConvergence(2, 3)).toBe(false);
  });

  it('triggers once attempts reach the max', () => {
    expect(plannerCriticNonConvergence(3, 3)).toBe(true);
  });
});

describe('flakyBaselineBlocksCompletion', () => {
  it('does not trigger below the default threshold', () => {
    expect(flakyBaselineBlocksCompletion(1)).toBe(false);
  });

  it('triggers at the default threshold', () => {
    expect(flakyBaselineBlocksCompletion(2)).toBe(true);
  });

  it('honors a custom threshold', () => {
    expect(flakyBaselineBlocksCompletion(4, 5)).toBe(false);
    expect(flakyBaselineBlocksCompletion(5, 5)).toBe(true);
  });
});

describe('repeatedFailureNoProgress', () => {
  it('does not trigger below the default threshold of 3', () => {
    expect(repeatedFailureNoProgress(2)).toBe(false);
  });

  it('triggers at the default threshold of 3', () => {
    expect(repeatedFailureNoProgress(3)).toBe(true);
  });
});

describe('tokenOrRuntimeBudgetExceeded', () => {
  it('does not trigger when both budgets have headroom', () => {
    expect(tokenOrRuntimeBudgetExceeded(500, 1000, 1000, 5000)).toBe(false);
  });

  it('triggers when the token budget is exceeded', () => {
    expect(tokenOrRuntimeBudgetExceeded(1000, 1000, 100, 5000)).toBe(true);
  });

  it('triggers when the runtime budget is exceeded', () => {
    expect(tokenOrRuntimeBudgetExceeded(100, 1000, 5000, 5000)).toBe(true);
  });
});

describe('qaRemainsInconclusive', () => {
  it('triggers when any scenario is inconclusive', () => {
    expect(qaRemainsInconclusive(true)).toBe(true);
    expect(qaRemainsInconclusive(false)).toBe(false);
  });
});

describe('reviewerFindingRequiresProductDecision', () => {
  it('requires a product decision for a requirements-category finding', () => {
    expect(reviewerFindingRequiresProductDecision('requirements')).toBe(true);
  });

  it('does not require one for a correctness-category finding', () => {
    expect(reviewerFindingRequiresProductDecision('correctness')).toBe(false);
  });
});

describe('waiverRequested', () => {
  it('always requires a human gate when a waiver is requested', () => {
    expect(waiverRequested(true)).toBe(true);
    expect(waiverRequested(false)).toBe(false);
  });
});

describe('mandatory gates', () => {
  it('classifies exactly the three mandatory reasons as mandatory', () => {
    expect(MANDATORY_GATE_REASONS).toHaveLength(3);
    for (const reason of MANDATORY_GATE_REASONS) {
      expect(isMandatoryGate(reason)).toBe(true);
    }
  });

  it('does not classify a conditional reason as mandatory', () => {
    expect(isMandatoryGate('new-dependency')).toBe(false);
    expect(isMandatoryGate('scope-expansion')).toBe(false);
  });
});

describe('requiresPlanApprovalGate', () => {
  it('does not require approval for a routine low-risk plan with no conditional triggers', () => {
    expect(requiresPlanApprovalGate(false, [])).toBe(false);
  });

  it('requires approval for a high-risk plan even with no conditional triggers', () => {
    expect(requiresPlanApprovalGate(true, [])).toBe(true);
  });

  it('requires approval for a low-risk plan if a conditional trigger fired', () => {
    expect(requiresPlanApprovalGate(false, ['new-dependency'])).toBe(true);
  });
});
