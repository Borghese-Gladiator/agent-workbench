/**
 * Lifecycle stages and the rules that govern movement between them.
 *
 * This module is pure: no IO, no dates-from-clock, no randomness. Every
 * transition is a deterministic function of (current state, action). That is
 * what makes the lifecycle testable and what keeps domain logic out of React
 * and out of the daemon's request handlers.
 */

/** Ordered lifecycle stages. Order is meaningful for board grouping + progress. */
export const STAGES = [
  'intake',
  'task_brief',
  'human_brief_approval',
  'discovery',
  'human_plan_approval',
  'implementation',
  'static_checks',
  'feature_e2e',
  'agent_self_review',
  'human_review',
  'delivery_prep',
  'human_delivery_approval',
  'publish',
  'closeout',
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

/** Human-facing label for a stage (the precise sub-step name). */
export const STAGE_LABELS: Record<Stage, string> = {
  intake: 'Intake',
  task_brief: 'Task Brief',
  human_brief_approval: 'Human Brief Approval',
  discovery: 'Discovery & Plan',
  human_plan_approval: 'Human Plan Approval',
  implementation: 'Implementation',
  static_checks: 'Static Checks',
  feature_e2e: 'Project E2E',
  agent_self_review: 'Agent Self-Review',
  human_review: 'Human Review',
  delivery_prep: 'Delivery Preparation',
  human_delivery_approval: 'Human Delivery Approval',
  publish: 'Publish',
  closeout: 'Closeout',
};

/**
 * The group a stage rolls up to in the lifecycle UI. Consecutive stages sharing
 * a group label are rendered as ONE expandable node (e.g. `static_checks` +
 * `feature_e2e` -> one "Verification" node, with each stage as a sub-step). A
 * stage with no entry is its own group, labeled by {@link STAGE_LABELS}.
 */
export const STAGE_GROUP_LABELS: Partial<Record<Stage, string>> = {
  static_checks: 'Verification',
  feature_e2e: 'Verification',
};

/** The display label for the rail GROUP a stage belongs to (group label or its own). */
export function stageGroupLabel(stage: Stage): string {
  return STAGE_GROUP_LABELS[stage] ?? STAGE_LABELS[stage];
}

/** Stages where the task is parked waiting on a human decision. */
export const HUMAN_APPROVAL_STAGES: readonly Stage[] = [
  'human_brief_approval',
  'human_plan_approval',
  'human_review',
  'human_delivery_approval',
];

export function stageNeedsHumanApproval(stage: Stage): boolean {
  return HUMAN_APPROVAL_STAGES.includes(stage);
}

/** Terminal stages — the task has reached an end state. */
export const TERMINAL_STAGES: readonly Stage[] = ['closeout'];

/**
 * Whether the driver may run this stage automatically (no human click).
 *
 * Auto-advanceable = NOT a human gate, NOT terminal, and NOT one of the
 * pre-first-gate stages (`intake` / `task_brief`). The decision (locked with
 * the user) is that a brand-new task stays manual until the human approves the
 * brief; only after that does the chain run on its own to the next gate.
 *
 * Note: worktree creation is NOT a stage. It is a side-effect of the
 * `approve-brief` action (which transitions human_brief_approval -> discovery
 * directly), so it never appears here or in the timeline.
 */
const NON_AUTO_ADVANCE_STAGES: readonly Stage[] = ['intake', 'task_brief'];

export function isAutoAdvanceable(stage: Stage): boolean {
  return (
    !stageNeedsHumanApproval(stage) &&
    !TERMINAL_STAGES.includes(stage) &&
    !NON_AUTO_ADVANCE_STAGES.includes(stage)
  );
}

/**
 * Task status is orthogonal to stage. A task is `active` while moving through
 * stages, becomes `ready_to_publish` after delivery approval (we do NOT push in
 * this increment), `done` after closeout, or `abandoned` when the operator
 * cancels it (from any stage — the single terminal-by-operator status).
 */
export const TASK_STATUSES = ['active', 'ready_to_publish', 'done', 'abandoned'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Outcome of a human review decision (cancel is a separate, stage-agnostic action). */
export const HUMAN_REVIEW_DECISIONS = ['complete', 'bounce'] as const;
export type HumanReviewDecision = (typeof HUMAN_REVIEW_DECISIONS)[number];

/** Where a bounce sends the task back to. */
export const BOUNCE_TARGETS = ['implementation', 'discovery'] as const;
export type BounceTarget = (typeof BOUNCE_TARGETS)[number];

export function isBounceTarget(value: unknown): value is BounceTarget {
  return typeof value === 'string' && (BOUNCE_TARGETS as readonly string[]).includes(value);
}

/**
 * The lifecycle actions a caller can POST to a task (`/api/tasks/:id/<action>`).
 * The canonical list: the daemon registers exactly these routes and MCP derives
 * its `do_action` enum from it, so the three surfaces can't drift. `review/*`
 * actions keep their slash — the route path includes it.
 */
export const LIFECYCLE_ACTIONS = [
  'generate-brief',
  'resume',
  'approve-brief',
  'reject-brief',
  'approve-plan',
  'reject-plan',
  'review/complete',
  'review/bounce',
  'approve-delivery',
  'reject-delivery',
  'abandon',
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];
