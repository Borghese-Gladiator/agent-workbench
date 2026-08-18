import { z } from 'zod';
import { TaskPhaseSchema, RunConditionSchema, DeliveryStateSchema, ScheduleStateSchema } from './lifecycle.js';

export const TaskSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  prompt: z.string(),
  phase: TaskPhaseSchema,
  condition: RunConditionSchema,
  deliveryState: DeliveryStateSchema,
  /** Stacked-PR edge (TASK-72): the parent task this one stacks on. Its delivered branch becomes
   *  this task's base. Undefined for a root task (PR#0), whose base stays the repo default branch. */
  parentTaskId: z.string().optional(),
  /** The base branch this task's worktree/branch is created from and its PR opens against. When set
   *  (typically the parent's delivered branch), it overrides the repository default branch. */
  baseBranch: z.string().optional(),
  /** Scheduler-owned DAG state (task DAG orchestration): `blocked` until the parent releases its
   *  draft PR, then `ready`, then `started`. Defaults to `ready` for a directly-created task. */
  scheduleState: ScheduleStateSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const RunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  createdAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

export const PhaseAttemptSchema = z.object({
  id: z.string(),
  runId: z.string(),
  taskId: z.string(),
  phase: TaskPhaseSchema,
  attemptNumber: z.number().int().positive(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  outcome: z.string().optional(),
});
export type PhaseAttempt = z.infer<typeof PhaseAttemptSchema>;

/**
 * Freshness envelope for the task-state route: tells the UI whether the durable `task_summary`
 * projection lags the live Temporal workflow. When Temporal is degraded the daemon still answers
 * from the projection (`liveWorkflowAvailable: false`) so list/detail stay responsive — there is
 * deliberately no Temporal fan-out on list pages.
 */
export const TaskFreshnessSchema = z.object({
  /** True when the daemon read live workflow state; false when it fell back to the durable projection. */
  liveWorkflowAvailable: z.boolean(),
  /** When the live workflow last advanced (null when unavailable or unknown). */
  workflowUpdatedAt: z.string().nullable(),
  /** When the durable projection row was last recomputed. */
  indexedAt: z.string(),
  /** True when the projection is known to lag the live workflow. */
  isIndexBehind: z.boolean(),
});
export type TaskFreshness = z.infer<typeof TaskFreshnessSchema>;
