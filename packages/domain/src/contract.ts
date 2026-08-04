import { z } from 'zod';

export const AcceptanceClaimCategorySchema = z.enum([
  'behavior',
  'correctness',
  'compatibility',
  'security',
  'accessibility',
  'performance',
  'operability',
]);
export type AcceptanceClaimCategory = z.infer<typeof AcceptanceClaimCategorySchema>;

export const AcceptanceClaimSchema = z.object({
  id: z.string(),
  description: z.string(),
  category: AcceptanceClaimCategorySchema,
  deterministicEvidenceRequired: z.boolean(),
  qaEvidenceRequired: z.boolean(),
  humanJudgmentRequired: z.boolean(),
});
export type AcceptanceClaim = z.infer<typeof AcceptanceClaimSchema>;

export const TaskContractStatusSchema = z.enum([
  'draft',
  'awaiting_approval',
  'approved',
  'rejected',
  'superseded',
]);
export type TaskContractStatus = z.infer<typeof TaskContractStatusSchema>;

export const TaskRiskSchema = z.enum(['low', 'medium', 'high']);
export type TaskRisk = z.infer<typeof TaskRiskSchema>;

export const SuccessCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  measurable: z.boolean(),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

export const TaskContractSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  version: z.number().int().positive(),
  objective: z.string(),
  problemStatement: z.string(),
  successCriteria: z.array(SuccessCriterionSchema),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  risk: TaskRiskSchema,
  claims: z.array(AcceptanceClaimSchema),
  status: TaskContractStatusSchema,
});
export type TaskContract = z.infer<typeof TaskContractSchema>;
