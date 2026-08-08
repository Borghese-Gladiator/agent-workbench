import { z } from 'zod';

/**
 * TASK-42: an expected per-claim QA assertion the planner emits — the specific state transition
 * (or value) the QA author must observe for a behavioral claim. Gives the QA author a target and
 * lets the exercise gate check that an assertion actually exercises the claim's observable
 * behaviour, not merely that some scenario ran for it.
 */
export const ExpectedAssertionSchema = z.object({
  claimId: z.string(),
  /** Human-readable description of the transition/value to observe (e.g. "a higher rank beats a lower one"). */
  observes: z.string(),
  kind: z.enum(['state-transition', 'value-match']),
});
export type ExpectedAssertion = z.infer<typeof ExpectedAssertionSchema>;

export const PlanSliceSchema = z.object({
  id: z.string(),
  objective: z.string(),
  claimIds: z.array(z.string()),
  likelyPaths: z.array(z.string()),
  requiredTargetedChecks: z.array(z.string()),
  dependencies: z.array(z.string()),
  /**
   * QA scenario identifiers this slice exercises. A behavioral claim with `qaEvidenceRequired`
   * is only satisfied at the plan gate when a slice covering it declares at least one scenario
   * (see everyBehavioralClaimHasQaScenario). Optional so non-behavioral plans/fixtures are unaffected.
   */
  qaScenarioIds: z.array(z.string()).optional(),
  /** TASK-42: expected per-claim QA assertions this slice's scenarios must observe. */
  expectedAssertions: z.array(ExpectedAssertionSchema).optional(),
});
export type PlanSlice = z.infer<typeof PlanSliceSchema>;

export const PlanRiskSchema = z.object({
  id: z.string(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  mitigation: z.string().optional(),
});
export type PlanRisk = z.infer<typeof PlanRiskSchema>;

export const ClaimCoverageSchema = z.object({
  claimId: z.string(),
  planSliceIds: z.array(z.string()),
  qaScenarioIds: z.array(z.string()),
  /** TASK-42: the expected assertions covering this claim, aggregated from its covering slices. */
  expectedAssertions: z.array(ExpectedAssertionSchema).optional(),
});
export type ClaimCoverage = z.infer<typeof ClaimCoverageSchema>;

export const ImplementationPlanStatusSchema = z.enum([
  'draft',
  'critic_rejected',
  'accepted',
  'superseded',
]);
export type ImplementationPlanStatus = z.infer<typeof ImplementationPlanStatusSchema>;

export const ImplementationPlanSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  contractVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  summary: z.string(),
  affectedAreas: z.array(z.string()),
  slices: z.array(PlanSliceSchema),
  risks: z.array(PlanRiskSchema),
  claimCoverage: z.array(ClaimCoverageSchema),
  status: ImplementationPlanStatusSchema,
});
export type ImplementationPlan = z.infer<typeof ImplementationPlanSchema>;
