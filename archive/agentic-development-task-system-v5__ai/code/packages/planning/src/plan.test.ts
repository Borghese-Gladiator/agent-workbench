import { describe, expect, it } from 'vitest';
import {
  draftPlan,
  revisePlan,
  acceptPlan,
  rejectPlanByCritic,
  supersedePlan,
  everyClaimMappedToSlice,
  everyBehavioralClaimHasQaScenario,
  everySliceHasTargetedChecks,
} from './plan.js';
import type { AcceptanceClaim } from '@awb/domain';

function makeClaim(overrides: Partial<AcceptanceClaim> = {}): AcceptanceClaim {
  return {
    id: overrides.id ?? 'claim-1',
    description: 'does the thing',
    category: 'behavior',
    deterministicEvidenceRequired: true,
    qaEvidenceRequired: true,
    humanJudgmentRequired: false,
    ...overrides,
  };
}

describe('draftPlan', () => {
  it('computes claim coverage automatically from slice claimIds', () => {
    const claim = makeClaim({ id: 'claim-1' });
    const plan = draftPlan(
      {
        taskId: 'task-1',
        contractVersion: 1,
        summary: 'add feature',
        slices: [
          { objective: 'implement backend', claimIds: ['claim-1'], likelyPaths: [], requiredTargetedChecks: ['unit'], dependencies: [] },
        ],
      },
      [claim],
    );
    expect(plan.claimCoverage).toHaveLength(1);
    expect(plan.claimCoverage[0]?.claimId).toBe('claim-1');
    expect(plan.claimCoverage[0]?.planSliceIds).toHaveLength(1);
  });

  it('leaves a claim with no slices mapping to it with empty coverage', () => {
    const claim = makeClaim({ id: 'claim-uncovered' });
    const plan = draftPlan(
      { taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [] },
      [claim],
    );
    expect(plan.claimCoverage[0]?.planSliceIds).toEqual([]);
  });

  // Expected per-claim assertions aggregate from covering slices into ClaimCoverage.
  it('aggregates a slice\'s expected assertions into the covered claim', () => {
    const claim = makeClaim({ id: 'claim-1' });
    const plan = draftPlan(
      {
        taskId: 'task-1',
        contractVersion: 1,
        summary: 'add feature',
        slices: [
          {
            objective: 'engine',
            claimIds: ['claim-1'],
            likelyPaths: [],
            requiredTargetedChecks: ['unit'],
            dependencies: [],
            expectedAssertions: [
              { claimId: 'claim-1', observes: 'a higher rank beats a lower one', kind: 'state-transition' },
            ],
          },
        ],
      },
      [claim],
    );
    expect(plan.claimCoverage[0]?.expectedAssertions).toEqual([
      { claimId: 'claim-1', observes: 'a higher rank beats a lower one', kind: 'state-transition' },
    ]);
  });
});

describe('revisePlan', () => {
  it('increments the plan version', () => {
    const claim = makeClaim();
    const first = draftPlan({ taskId: 'task-1', contractVersion: 1, summary: 'v1', slices: [] }, [claim]);
    const revised = revisePlan(first, { taskId: 'task-1', contractVersion: 1, summary: 'v2', slices: [] }, [claim]);
    expect(revised.version).toBe(2);
  });
});

describe('plan status transitions', () => {
  it('accepts, critic-rejects, and supersedes', () => {
    const claim = makeClaim();
    const plan = draftPlan({ taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [] }, [claim]);
    expect(acceptPlan(plan).status).toBe('accepted');
    expect(rejectPlanByCritic(plan).status).toBe('critic_rejected');
    expect(supersedePlan(plan).status).toBe('superseded');
  });
});

describe('everyClaimMappedToSlice', () => {
  it('is true when every claim has at least one slice', () => {
    const claim = makeClaim({ id: 'c1' });
    const plan = draftPlan(
      { taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [{ objective: 'o', claimIds: ['c1'], likelyPaths: [], requiredTargetedChecks: ['t'], dependencies: [] }] },
      [claim],
    );
    expect(everyClaimMappedToSlice(plan)).toBe(true);
  });

  it('is false when a claim has no slice', () => {
    const claim = makeClaim({ id: 'c1' });
    const plan = draftPlan({ taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [] }, [claim]);
    expect(everyClaimMappedToSlice(plan)).toBe(false);
  });
});

describe('everyBehavioralClaimHasQaScenario', () => {
  it('is true (vacuously) when there are no qa-required behavioral claims', () => {
    const claim = makeClaim({ category: 'correctness', qaEvidenceRequired: false });
    const plan = draftPlan({ taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [] }, [claim]);
    expect(everyBehavioralClaimHasQaScenario(plan, [claim])).toBe(true);
  });

  it('is false when a qa-required behavioral claim has no qaScenarioIds', () => {
    const claim = makeClaim({ id: 'c1', category: 'behavior', qaEvidenceRequired: true });
    const plan = draftPlan(
      { taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [{ objective: 'o', claimIds: ['c1'], likelyPaths: [], requiredTargetedChecks: ['t'], dependencies: [] }] },
      [claim],
    );
    expect(everyBehavioralClaimHasQaScenario(plan, [claim])).toBe(false);
  });

  it('is true when the claim coverage includes qaScenarioIds', () => {
    const claim = makeClaim({ id: 'c1', category: 'behavior', qaEvidenceRequired: true });
    const plan = draftPlan(
      { taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [{ objective: 'o', claimIds: ['c1'], likelyPaths: [], requiredTargetedChecks: ['t'], dependencies: [] }] },
      [claim],
    );
    plan.claimCoverage[0]!.qaScenarioIds = ['scenario-1'];
    expect(everyBehavioralClaimHasQaScenario(plan, [claim])).toBe(true);
  });

  // Regression for the plan-stall bug: buildClaimCoverage must derive qaScenarioIds from
  // the covering slices, not hardcode []. A slice that declares a scenario for its behavioral claim
  // makes the gate pass without any post-draft mutation.
  it('derives coverage qaScenarioIds from the slices so the gate passes', () => {
    const claim = makeClaim({ id: 'c1', category: 'behavior', qaEvidenceRequired: true });
    const plan = draftPlan(
      {
        taskId: 'task-1',
        contractVersion: 1,
        summary: 'x',
        slices: [
          { objective: 'o', claimIds: ['c1'], likelyPaths: [], requiredTargetedChecks: ['t'], dependencies: [], qaScenarioIds: ['qa-o'] },
        ],
      },
      [claim],
    );
    expect(plan.claimCoverage[0]?.qaScenarioIds).toEqual(['qa-o']);
    expect(everyBehavioralClaimHasQaScenario(plan, [claim])).toBe(true);
  });
});

describe('everySliceHasTargetedChecks', () => {
  it('is true when every slice has at least one targeted check', () => {
    const claim = makeClaim({ id: 'c1' });
    const plan = draftPlan(
      { taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [{ objective: 'o', claimIds: ['c1'], likelyPaths: [], requiredTargetedChecks: ['unit'], dependencies: [] }] },
      [claim],
    );
    expect(everySliceHasTargetedChecks(plan)).toBe(true);
  });

  it('is false when a slice has no targeted checks', () => {
    const claim = makeClaim({ id: 'c1' });
    const plan = draftPlan(
      { taskId: 'task-1', contractVersion: 1, summary: 'x', slices: [{ objective: 'o', claimIds: ['c1'], likelyPaths: [], requiredTargetedChecks: [], dependencies: [] }] },
      [claim],
    );
    expect(everySliceHasTargetedChecks(plan)).toBe(false);
  });
});
