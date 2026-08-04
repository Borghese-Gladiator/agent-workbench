import { randomUUID } from 'node:crypto';
import type {
  AcceptanceClaim,
  ClaimCoverage,
  ImplementationPlan,
  PlanRisk,
  PlanSlice,
} from '@awb/domain';

export interface DraftPlanInput {
  taskId: string;
  contractVersion: number;
  summary: string;
  affectedAreas?: string[];
  slices: Omit<PlanSlice, 'id'>[];
  risks?: Omit<PlanRisk, 'id'>[];
}

function buildClaimCoverage(claims: AcceptanceClaim[], slices: PlanSlice[]): ClaimCoverage[] {
  return claims.map((claim) => {
    const coveringSlices = slices.filter((s) => s.claimIds.includes(claim.id));
    return {
      claimId: claim.id,
      planSliceIds: coveringSlices.map((s) => s.id),
      // QA scenarios are derived from the covering slices' declared scenarios, not hand-authored,
      // so a behavioral claim's coverage is satisfied exactly when a slice that covers it declares
      // one. (Previously hardcoded to [], which made everyBehavioralClaimHasQaScenario impossible
      // to satisfy — the plan phase then always blocked as repeated-failure-no-progress.)
      qaScenarioIds: [...new Set(coveringSlices.flatMap((s) => s.qaScenarioIds ?? []))],
      // TASK-42: aggregate the expected per-claim assertions this claim's covering slices declare.
      expectedAssertions: coveringSlices
        .flatMap((s) => s.expectedAssertions ?? [])
        .filter((a) => a.claimId === claim.id),
    };
  });
}

/**
 * Constructs a draft ImplementationPlan from planner output, computing claim coverage
 * automatically from each slice's declared claimIds (so the planner cannot silently drop
 * coverage — the mapping is derived, not separately hand-authored).
 */
export function draftPlan(input: DraftPlanInput, claims: AcceptanceClaim[], version = 1): ImplementationPlan {
  const slices: PlanSlice[] = input.slices.map((s) => ({ ...s, id: randomUUID() }));
  const risks: PlanRisk[] = (input.risks ?? []).map((r) => ({ ...r, id: randomUUID() }));

  return {
    id: randomUUID(),
    taskId: input.taskId,
    contractVersion: input.contractVersion,
    version,
    summary: input.summary,
    affectedAreas: input.affectedAreas ?? [],
    slices,
    risks,
    claimCoverage: buildClaimCoverage(claims, slices),
    status: 'draft',
  };
}

export function revisePlan(previous: ImplementationPlan, input: DraftPlanInput, claims: AcceptanceClaim[]): ImplementationPlan {
  return draftPlan(input, claims, previous.version + 1);
}

export function acceptPlan(plan: ImplementationPlan): ImplementationPlan {
  return { ...plan, status: 'accepted' };
}

export function rejectPlanByCritic(plan: ImplementationPlan): ImplementationPlan {
  return { ...plan, status: 'critic_rejected' };
}

export function supersedePlan(plan: ImplementationPlan): ImplementationPlan {
  return { ...plan, status: 'superseded' };
}

/** True when every acceptance claim maps to at least one plan slice (product spec §11 Plan criterion). */
export function everyClaimMappedToSlice(plan: ImplementationPlan): boolean {
  return plan.claimCoverage.every((c) => c.planSliceIds.length > 0);
}

/** True when every behavioral claim maps to at least one QA scenario. Claims without qaEvidenceRequired are exempt. */
export function everyBehavioralClaimHasQaScenario(
  plan: ImplementationPlan,
  claims: AcceptanceClaim[],
): boolean {
  const behavioralClaimIds = new Set(
    claims.filter((c) => c.category === 'behavior' && c.qaEvidenceRequired).map((c) => c.id),
  );
  if (behavioralClaimIds.size === 0) return true;
  return plan.claimCoverage
    .filter((c) => behavioralClaimIds.has(c.claimId))
    .every((c) => c.qaScenarioIds.length > 0);
}

export function everySliceHasTargetedChecks(plan: ImplementationPlan): boolean {
  return plan.slices.every((s) => s.requiredTargetedChecks.length > 0);
}
