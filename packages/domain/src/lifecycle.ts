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
  // Terminal, and deliberately distinct from `failed`: no Temporal Workflow backs this row any
  // more, so the workbench cannot say whether the work succeeded. The daemon's reconcile pass is
  // the only writer (TASK-126); a Workflow never reports it.
  'abandoned',
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
 * Labels for an acceptance claim the autonomous loop could not prove (TASK-104/105). These were the
 * reasons a task used to PARK on a human gate. The workbench no longer waits for a human, so they
 * survive only as vocabulary for the unmet-criteria report the draft PR body renders.
 *
 * The three mandatory gates are gone, not renamed: `first-time-repository-trust` became the
 * persisted `repositories.trusted` flag checked once at task creation, and `task-contract-approval`
 * and `pr-readiness` were deleted outright.
 */
export const UnmetCriterionReasonSchema = z.enum([
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
]);
export type UnmetCriterionReason = z.infer<typeof UnmetCriterionReasonSchema>;

/**
 * The bound on an autonomous loop (TASK-105). The loop repairs and replans until the acceptance
 * claims are proven OR one of these limits is reached; it never waits for a human. Every limit is
 * checked in the Workflow, so the decision is deterministic and replay-safe.
 */
export const LoopBudgetSchema = z.object({
  /** Attempts at one phase, counting repair loop-backs, before the loop gives up on it. */
  maxAttemptsPerPhase: z.number().int().positive(),
  /** Input + output tokens summed across the whole task. */
  maxTotalTokens: z.number().int().positive(),
  /** Wall-clock milliseconds from the first phase attempt. */
  maxWallClockMs: z.number().int().positive(),
});
export type LoopBudget = z.infer<typeof LoopBudgetSchema>;

/**
 * The default budget a task runs under when the caller supplies none. Sized so an ordinary task
 * never reaches it and a genuinely stuck one stops within an hour rather than looping forever.
 */
export const DEFAULT_LOOP_BUDGET: LoopBudget = {
  maxAttemptsPerPhase: 3,
  maxTotalTokens: 2_000_000,
  maxWallClockMs: 4 * 60 * 60 * 1000,
};

/**
 * Why the loop stopped without proving every claim. Distinguishing these is the point: a task that
 * ran out of wall-clock is a different review problem from one that repeated the same failure.
 */
export const LoopStopReasonSchema = z.enum([
  /** The loop finished its route but a claim stayed unproven (e.g. QA inconclusive). */
  'converged-unmet',
  /** A `LoopBudget` limit was reached — attempts, tokens or wall-clock. */
  'budget-exhausted',
  /** The same failure fingerprint repeated with no progress between attempts. */
  'genuinely-stuck',
  /** A phase reported `blocked` — it could not run at all. */
  'phase-blocked',
]);
export type LoopStopReason = z.infer<typeof LoopStopReasonSchema>;

/**
 * The terminal outcome of a loop that stopped short of proving every acceptance claim (TASK-105).
 * It replaces the `awaiting-human` park: nothing waits on it, it is rendered into the draft PR body
 * (TASK-106) so a human reads the honest result on GitHub instead of in an approval queue.
 */
export const UnmetCriteriaSchema = z.object({
  stopReason: LoopStopReasonSchema,
  /** The phase the loop stopped in. */
  phase: TaskPhaseSchema,
  /** Acceptance claims (or labelled conditions) that no evidence proved. */
  unprovenClaims: z.array(z.string()),
  /** Labelled reasons drawn from the ex-gate vocabulary, for a machine reader. */
  reasons: z.array(UnmetCriterionReasonSchema),
  /** The last candidate commit the loop produced, if it produced one. */
  candidateSha: z.string().optional(),
  /** Ids of the blocking findings that were still open when the loop stopped. */
  findingIds: z.array(z.string()),
  /** One sentence a human can read without opening anything else. */
  detail: z.string(),
});
export type UnmetCriteria = z.infer<typeof UnmetCriteriaSchema>;

export const FindingRefSchema = z.object({
  id: z.string(),
  severity: z.enum(['blocker', 'high', 'medium', 'low', 'note']),
  category: z.string(),
  description: z.string(),
});
export type FindingRef = z.infer<typeof FindingRefSchema>;

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
  /**
   * The phase ran but could not prove an acceptance claim, and no further loop iteration will help
   * (TASK-105). This replaced `await-human`: the Workflow does not park on it — it records the
   * reason and routes to the draft-PR terminal, which reports the claim as unmet.
   */
  z.object({
    outcome: z.literal('unmet'),
    reason: UnmetCriterionReasonSchema,
    detail: z.string(),
    unprovenClaims: z.array(z.string()),
    findings: z.array(FindingRefSchema),
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
