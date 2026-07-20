import { z } from 'zod';

export const PlanSliceSchema = z.object({
  id: z.string(),
  objective: z.string(),
  claimIds: z.array(z.string()),
  likelyPaths: z.array(z.string()),
  requiredTargetedChecks: z.array(z.string()),
  dependencies: z.array(z.string()),
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
