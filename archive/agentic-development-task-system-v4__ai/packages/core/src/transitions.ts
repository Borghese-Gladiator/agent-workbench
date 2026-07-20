/**
 * Pure lifecycle transition rules.
 *
 * Each function takes the relevant slice of current task state plus an action,
 * and returns the resulting {stage, status} (or throws on an illegal move).
 * The daemon applies these and persists the result; it never decides the next
 * stage itself. Tests exercise these directly.
 */

import type { BounceTarget, Stage, TaskStatus } from './lifecycle.js';
import { stageNeedsHumanApproval } from './lifecycle.js';

export interface TaskState {
  stage: Stage;
  status: TaskStatus;
}

export interface TransitionResult {
  stage: Stage;
  status: TaskStatus;
  /** Optional note recorded on the new StageRun. */
  note?: string;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: Stage,
    public readonly action: string,
  ) {
    super(`Illegal transition: cannot '${action}' from stage '${from}'`);
    this.name = 'IllegalTransitionError';
  }
}

function expect(state: TaskState, action: string, ...allowed: Stage[]): void {
  if (state.status !== 'active') {
    throw new IllegalTransitionError(state.stage, `${action} (task is ${state.status})`);
  }
  if (!allowed.includes(state.stage)) {
    throw new IllegalTransitionError(state.stage, action);
  }
}

/**
 * Like {@link expect} but also permits the `ready_to_publish` status. Used by
 * closeout, which legitimately runs after delivery approval (publish stage,
 * status ready_to_publish) — not just while the task is still `active`.
 */
function expectPublishable(state: TaskState, action: string, ...allowed: Stage[]): void {
  if (state.status !== 'active' && state.status !== 'ready_to_publish') {
    throw new IllegalTransitionError(state.stage, `${action} (task is ${state.status})`);
  }
  if (!allowed.includes(state.stage)) {
    throw new IllegalTransitionError(state.stage, action);
  }
}

/** Intake -> generate the Task Brief; parks at human_brief_approval. */
export function generateTaskBrief(state: TaskState): TransitionResult {
  expect(state, 'generateTaskBrief', 'intake', 'task_brief');
  return { stage: 'human_brief_approval', status: 'active' };
}

/** Approve the brief -> worktree creation -> discovery. */
export function approveTaskBrief(state: TaskState): TransitionResult {
  expect(state, 'approveTaskBrief', 'human_brief_approval');
  // Worktree creation is an automatic (stubbed) step on the way to discovery.
  return { stage: 'discovery', status: 'active', note: 'brief approved; worktree created (stub)' };
}

/** Reject the brief -> back to task_brief for regeneration. */
export function rejectTaskBrief(state: TaskState): TransitionResult {
  expect(state, 'rejectTaskBrief', 'human_brief_approval');
  return { stage: 'task_brief', status: 'active', note: 'brief rejected' };
}

/**
 * Discovery + Execution Plan complete; parks at human_plan_approval.
 *
 * Discovery and planning are a single read-only stage: the agent reads the
 * codebase and produces one Execution Plan artifact (findings + chosen approach
 * + ordered change list + validation-by-criterion table). There is no separate
 * options stage — the plan commits to one approach, escalating to the operator
 * via the ask tool only for a genuine, convention-unresolvable fork.
 */
export function submitPlan(state: TaskState): TransitionResult {
  expect(state, 'submitPlan', 'discovery');
  return { stage: 'human_plan_approval', status: 'active' };
}

/** Approve the plan -> implementation. */
export function approveExecutionPlan(state: TaskState): TransitionResult {
  expect(state, 'approveExecutionPlan', 'human_plan_approval');
  return { stage: 'implementation', status: 'active', note: 'plan approved' };
}

/** Reject the plan -> back to discovery for revision. */
export function rejectExecutionPlan(state: TaskState): TransitionResult {
  expect(state, 'rejectExecutionPlan', 'human_plan_approval');
  return { stage: 'discovery', status: 'active', note: 'plan rejected' };
}

/** Mark implementation complete -> static checks (the first verification stage). */
export function completeImplementation(state: TaskState): TransitionResult {
  expect(state, 'completeImplementation', 'implementation');
  return { stage: 'static_checks', status: 'active' };
}

/**
 * Static checks passed -> feature E2E, UNLESS the human opted to skip E2E at the
 * plan-approval gate, in which case we route straight to agent self-review.
 *
 * `static_checks` and `feature_e2e` are the two halves of the former single
 * `verification` stage; both roll up to "Verification" in the UI. Splitting them
 * lets the E2E stage park on a real test verdict independently of the static
 * shell gate, and lets the human skip E2E for non-UI / trivial changes.
 */
export function completeStaticChecks(
  state: TaskState,
  opts: { skipE2e?: boolean } = {},
): TransitionResult {
  expect(state, 'completeStaticChecks', 'static_checks');
  if (opts.skipE2e) {
    return {
      stage: 'agent_self_review',
      status: 'active',
      note: 'e2e skipped at plan approval',
    };
  }
  return { stage: 'feature_e2e', status: 'active' };
}

/** Feature E2E passed -> agent self-review. */
export function completeFeatureE2e(state: TaskState): TransitionResult {
  expect(state, 'completeFeatureE2e', 'feature_e2e');
  return { stage: 'agent_self_review', status: 'active' };
}

/** Agent self-review done -> human review gate. */
export function completeSelfReview(state: TaskState): TransitionResult {
  expect(state, 'completeSelfReview', 'agent_self_review');
  return { stage: 'human_review', status: 'active' };
}

/** Human review: complete -> delivery preparation. */
export function humanReviewComplete(state: TaskState): TransitionResult {
  expect(state, 'humanReviewComplete', 'human_review');
  return { stage: 'delivery_prep', status: 'active', note: 'human review: complete' };
}

/** Human review: bounce -> back to implementation or the plan stage. */
export function humanReviewBounce(state: TaskState, target: BounceTarget): TransitionResult {
  expect(state, 'humanReviewBounce', 'human_review');
  return { stage: target, status: 'active', note: `human review: bounced to ${target}` };
}

/** Delivery preparation produced a package -> delivery approval gate. */
export function completeDeliveryPrep(state: TaskState): TransitionResult {
  expect(state, 'completeDeliveryPrep', 'delivery_prep');
  return { stage: 'human_delivery_approval', status: 'active' };
}

/**
 * Approve delivery -> publish stage, status ready_to_publish.
 *
 * This is the pure state transition only. The actual publish (commit + PR or
 * merge, per the project's delivery policy) is performed by the daemon's
 * approveDelivery handler, which runs the delivery adapter alongside this
 * transition.
 */
export function approveDelivery(state: TaskState): TransitionResult {
  expect(state, 'approveDelivery', 'human_delivery_approval');
  return { stage: 'publish', status: 'ready_to_publish', note: 'delivery approved' };
}

/** Reject delivery -> back to delivery preparation. */
export function rejectDelivery(state: TaskState): TransitionResult {
  expect(state, 'rejectDelivery', 'human_delivery_approval');
  return { stage: 'delivery_prep', status: 'active', note: 'delivery rejected' };
}

/** Closeout -> done. Reachable from publish (post-approval) or closeout. */
export function closeout(state: TaskState): TransitionResult {
  expectPublishable(state, 'closeout', 'publish', 'closeout');
  return { stage: 'closeout', status: 'done', note: 'closed out' };
}

/** Terminal statuses a task can no longer transition out of. */
const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'abandoned'];

/**
 * Abandon the task -> terminal `abandoned` status (stage unchanged).
 *
 * The operator's escape hatch from ANY non-terminal stage — a wedged run, a
 * task parked at a gate, or work no longer needed. This is the single
 * "stop this task for good" transition; there is no separate review-only
 * abandon. Refuses an already-terminal task.
 */
export function abandonTask(state: TaskState): TransitionResult {
  if (TERMINAL_STATUSES.includes(state.status)) {
    throw new IllegalTransitionError(state.stage, `abandonTask (task is ${state.status})`);
  }
  return { stage: state.stage, status: 'abandoned', note: 'task abandoned' };
}

/** Convenience: does a stage currently await a human? Re-exported for callers. */
export { stageNeedsHumanApproval };
