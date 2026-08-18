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

/**
 * Scheduler-owned lifecycle axis (task DAG orchestration), distinct from `deliveryState` (which is
 * workflow-owned and, on the persisted task row, frozen at creation). The daemon scheduler writes
 * this authoritatively: `blocked` = row created but its workflow NOT started, waiting on the
 * parent task to release its draft PR; `ready` = eligible / a root node; `started` = the workflow
 * has been started (never re-start).
 */
export const ScheduleStateSchema = z.enum(['blocked', 'ready', 'started']);
export type ScheduleState = z.infer<typeof ScheduleStateSchema>;

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

/**
 * Conditional advisory gate reasons (autonomy pivot, TASK-104): the workbench no longer BLOCKS on a
 * human for any of these — the loop runs to a terminal draft PR regardless. What remains is the
 * pruned vocabulary of reasons that still label WHY a change wanted attention, reused as
 * unmet-criteria stop labels and PR-body annotations. The removed values —
 * `task-contract-approval`, `pr-readiness`, `repeated-failure-no-progress`, `budget-exceeded` —
 * were mandatory blocking gates; they are gone entirely (see `UnmetCriteriaStopReason`).
 */
export const HumanGateReasonSchema = z.enum([
  'first-time-repository-trust',
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
  'qa-inconclusive',
  'reviewer-product-decision',
  'waiver-request',
]);
export type HumanGateReason = z.infer<typeof HumanGateReasonSchema>;

/**
 * Bounded-autonomy budget (TASK-105). The Workflow checks it each phase attempt; exhaustion
 * terminates the task as `UnmetCriteria` (stop reason `budget-exhausted`) — it never escalates to a
 * human. A draft PR still opens with an honest met/unmet checklist.
 */
export const LoopBudgetSchema = z.object({
  maxPhaseAttempts: z.number().int().positive(),
  maxTotalTokens: z.number().int().positive(),
  maxWallClockMs: z.number().int().positive(),
});
export type LoopBudget = z.infer<typeof LoopBudgetSchema>;

/**
 * The three terminal non-convergence stop reasons (TASK-105). Replaces the deleted blocking gates:
 * - `converged-unmet`   — the loop finished its phases but some acceptance claim is still unproven.
 * - `budget-exhausted`  — a LoopBudget dimension (attempts/tokens/wall-clock) was exceeded.
 * - `genuinely-stuck`   — the same failure fingerprint repeated past threshold (no progress).
 */
export const UnmetCriteriaStopReasonSchema = z.enum([
  'converged-unmet',
  'budget-exhausted',
  'genuinely-stuck',
]);
export type UnmetCriteriaStopReason = z.infer<typeof UnmetCriteriaStopReasonSchema>;

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
 * Terminal non-convergence record (TASK-105/106). When the loop cannot prove every acceptance
 * claim — because it exhausted its budget, got genuinely stuck, or converged with claims still
 * unmet — the Workflow terminates with this instead of parking on a human gate. It is rendered
 * into the draft PR body as an honest met/unmet checklist; the draft PR is still opened.
 */
export const UnmetCriteriaSchema = z.object({
  /** Acceptance-claim ids that remain unproven (from the completion decision's `missing`). */
  unprovenClaimIds: z.array(z.string()),
  /** The last candidate commit SHA the loop produced, if any. */
  lastCandidateSha: z.string().optional(),
  /** Blocking review findings that stopped convergence. */
  blockingFindings: z.array(FindingRefSchema),
  /** Why the loop stopped without proving every claim. */
  stopReason: UnmetCriteriaStopReasonSchema,
  /**
   * Unmet upstream dependencies the success predicate needed but could not satisfy — e.g. TASK-90
   * (interactive QA). Rendered as unmet dependencies in the PR body.
   */
  unmetDependencies: z.array(z.string()).optional(),
});
export type UnmetCriteria = z.infer<typeof UnmetCriteriaSchema>;

/**
 * Aggregate agent usage a phase attempt consumed, reported by the Activity back to the Workflow so
 * it can accumulate `tokenUsageTotal` + `runtimeMsByPhase`. Optional on every result
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
     * The task size the specify phase classified. Only the specify candidate sets this; the
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
    // `program-design` is a valid replan target on L runs: a structural finding routes to
    // the program-design phase, not plan. M/S runs (no program-design phase) still use plan/specify.
    target: z.enum(['plan', 'program-design', 'specify']),
    findings: z.array(FindingRefSchema),
    usage: PhaseUsageSchema.optional(),
  }),
  z.object({
    outcome: z.literal('await-human'),
    gate: HumanGateSchema,
    usage: PhaseUsageSchema.optional(),
  }),
  z.object({
    // Terminal non-convergence (autonomy pivot, TASK-105/106): a phase (release on non-convergence)
    // or the Workflow itself emits this instead of `await-human`. The task ends at a draft PR whose
    // body carries the met/unmet checklist; no human wait state is entered.
    outcome: z.literal('unmet-criteria'),
    unmetCriteria: UnmetCriteriaSchema,
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
