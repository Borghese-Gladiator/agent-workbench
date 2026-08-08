import { z } from 'zod';
import {
  TaskPhaseSchema,
  RunConditionSchema,
  DeliveryStateSchema,
  HumanGateReasonSchema,
} from './lifecycle.js';
import { TaskSizeSchema } from './contract.js';

export const TaskSchema = z.object({
  id: z.string(),
  repositoryId: z.string(),
  prompt: z.string(),
  phase: TaskPhaseSchema,
  condition: RunConditionSchema,
  deliveryState: DeliveryStateSchema,
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
  /** The prior phase-attempt this one retries, when the workflow re-ran the phase. Null on first try. */
  retryOf: z.string().nullable().optional(),
});
export type PhaseAttempt = z.infer<typeof PhaseAttemptSchema>;

/**
 * The one canonical read model for a task across the list, board, approval queue, repository task
 * list, and (later) overview. Derived from the durable `task_summary` projection the daemon keeps in
 * sync on every workflow transition — NOT a live Temporal query — so list-style pages never fan out
 * one workflow query per task. Freshness fields let the UI say "the index is behind live state"
 * instead of silently showing stale data (the walkthrough's core failure).
 */
export const TaskSummarySchema = z.object({
  taskId: z.string(),
  repositoryId: z.string(),
  repositoryName: z.string().nullable(),
  prompt: z.string(),
  phase: TaskPhaseSchema,
  condition: RunConditionSchema,
  deliveryState: DeliveryStateSchema,
  size: TaskSizeSchema.nullable(),
  /** Canonical derived status (domain deriveTaskStatus) — do not re-derive on the client. */
  derivedStatus: z.string(),
  attemptCount: z.number().int().nonnegative(),
  openFindingCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  pendingGateReason: HumanGateReasonSchema.nullable(),
  candidateSha: z.string().nullable(),
  pullRequestUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** When the durable projection row was last recomputed (the index clock). */
  indexedAt: z.string(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

/**
 * Freshness contract for the composite task-detail response: the detail page reads LIVE workflow
 * state, so it can compare the workflow clock to the index clock and tell the user when the durable
 * summary (which the list/board read) is behind.
 */
export const TaskFreshnessSchema = z.object({
  liveWorkflowAvailable: z.boolean(),
  workflowUpdatedAt: z.string().nullable(),
  indexedAt: z.string(),
  isIndexBehind: z.boolean(),
});
export type TaskFreshness = z.infer<typeof TaskFreshnessSchema>;
