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

/**
 * Task size class (TASK-51 / WSFF 80/20). Drives which planning phases run: `S` skips plan +
 * program-design (single-shot straight to a slice), `M` runs one combined plan artifact but skips
 * program-design, `L` runs the full plan + program-design. Lives on the contract (like `risk`) so a
 * human sees it and can override it at the contract gate.
 */
export const TaskSizeSchema = z.enum(['S', 'M', 'L']);
export type TaskSize = z.infer<typeof TaskSizeSchema>;

export const TaskContractSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  version: z.number().int().positive(),
  objective: z.string(),
  /**
   * TASK-54: the problem the task solves, aligned on with the human at the specify gate before any
   * planning spend. What the acceptance claims must satisfy is captured by `claims`; this is the
   * human-facing "why".
   */
  problemStatement: z.string(),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  risk: TaskRiskSchema,
  size: TaskSizeSchema,
  claims: z.array(AcceptanceClaimSchema),
  status: TaskContractStatusSchema,
});
export type TaskContract = z.infer<typeof TaskContractSchema>;
