import { z } from 'zod';
import { TaskSizeSchema } from './contract.js';

export const TaskPhaseSchema = z.enum([
  'specify',
  'plan',
  'program-design',
  'prepare',
  'implement',
  'verify',
  'exercise',
  'challenge',
  'release',
  'assimilate',
]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const RunConditionSchema = z.enum([
  'running',
  'awaiting-human',
  'awaiting-external',
  'blocked',
  'failed',
  'cancelled',
  'completed',
]);
export type RunCondition = z.infer<typeof RunConditionSchema>;

export const DeliveryStateSchema = z.enum([
  'not-started',
  'branch-ready',
  'draft-pr-open',
  'awaiting-review',
  'merged',
  'closed',
]);
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const CompletionCandidateSchema = z.object({
  phase: TaskPhaseSchema,
  phaseAttemptId: z.string(),
  repositorySnapshotId: z.string(),
  contractVersion: z.number().int().positive(),
  planVersion: z.number().int().positive(),
  baseSha: z.string().optional(),
  candidateSha: z.string().optional(),
  environmentDigest: z.string().optional(),
  policyVersion: z.string(),
  evidenceIds: z.array(z.string()),
  openFindingIds: z.array(z.string()),
  artifactManifestHash: z.string(),
});
export type CompletionCandidate = z.infer<typeof CompletionCandidateSchema>;

export const HumanGateReasonSchema = z.enum([
  'first-time-repository-trust',
  'task-contract-approval',
  'pr-readiness',
  'new-dependency',
  'public-api-change',
  'auth-change',
  'sensitive-change',
  'scope-expansion',
  'unvalidated-privileged-command',
  'host-access-request',
  'external-network-request',
  'planner-critic-non-convergence',
  'flaky-baseline',
  'repeated-failure-no-progress',
  'budget-exceeded',
  'qa-inconclusive',
  'reviewer-product-decision',
  'waiver-request',
  'slice-diff-exceeds-cap',
]);
export type HumanGateReason = z.infer<typeof HumanGateReasonSchema>;

export const HumanGateSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  phase: TaskPhaseSchema,
  reason: HumanGateReasonSchema,
  summary: z.string(),
  createdAt: z.string(),
});
export type HumanGate = z.infer<typeof HumanGateSchema>;

export const FindingRefSchema = z.object({
  id: z.string(),
  severity: z.enum(['blocker', 'high', 'medium', 'low', 'note']),
  category: z.string(),
  description: z.string(),
});
export type FindingRef = z.infer<typeof FindingRefSchema>;

/**
 * Aggregate agent usage a phase attempt consumed, reported by the Activity back to the Workflow so
 * it can accumulate `tokenUsageTotal` + `runtimeMsByPhase` (TASK-11). Optional on every result
 * variant — phases with no agent session (or the mock runtime) simply omit it.
 */
export const PhaseUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  runtimeMs: z.number().int().nonnegative(),
});
export type PhaseUsage = z.infer<typeof PhaseUsageSchema>;

export const PhaseAttemptResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('candidate'),
    candidate: CompletionCandidateSchema,
    usage: PhaseUsageSchema.optional(),
    /**
     * The task size the specify phase classified (TASK-51). Only the specify candidate sets this; the
     * Workflow reads it to derive the run's `phaseSet`. Omitted by every other phase.
     */
    size: TaskSizeSchema.optional(),
  }),
  z.object({
    outcome: z.literal('repair'),
    target: z.literal('implement'),
    findings: z.array(FindingRefSchema),
    usage: PhaseUsageSchema.optional(),
  }),
  z.object({
    outcome: z.literal('replan'),
    target: z.enum(['plan', 'specify']),
    findings: z.array(FindingRefSchema),
    usage: PhaseUsageSchema.optional(),
  }),
  z.object({
    outcome: z.literal('await-human'),
    gate: HumanGateSchema,
    usage: PhaseUsageSchema.optional(),
  }),
  z.object({
    outcome: z.literal('blocked'),
    reason: z.string(),
    usage: PhaseUsageSchema.optional(),
  }),
  z.object({
    outcome: z.literal('cancelled'),
    usage: PhaseUsageSchema.optional(),
  }),
]);
export type PhaseAttemptResult = z.infer<typeof PhaseAttemptResultSchema>;

export const CompletionDecisionSchema = z.object({
  complete: z.boolean(),
  reasons: z.array(z.string()),
  missing: z.array(z.string()),
});
export type CompletionDecision = z.infer<typeof CompletionDecisionSchema>;
