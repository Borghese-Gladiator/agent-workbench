import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import type { TaskPhase, RunCondition, DeliveryState, ScheduleState, TaskSize } from '@awb/domain';
import { repositories } from './repository.js';

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  prompt: text('prompt').notNull(),
  phase: text('phase').notNull().$type<TaskPhase>(),
  condition: text('condition').notNull().$type<RunCondition>(),
  deliveryState: text('delivery_state').notNull().$type<DeliveryState>(),
  /** Task size class; nullable until the specify classifier sets it. */
  size: text('size').$type<TaskSize>(),
  /** Stacked-PR edge (TASK-72): parent task + base branch override; both null for a root task. */
  parentTaskId: text('parent_task_id'),
  baseBranch: text('base_branch'),
  /** Scheduler-owned DAG state; defaults to 'ready' (directly-created task). */
  scheduleState: text('schedule_state').notNull().$type<ScheduleState>().default('ready'),
  /** Optional concise label; when null the UI derives a title from the prompt's first sentence. */
  title: text('title'),
  /** The task this one retries (cross-task; retry creates a new task). Null for an original. */
  retryOfTaskId: text('retry_of_task_id'),
  /** Head of the retry chain; equals `id` for an original, copied from the parent for a retry. */
  rootTaskId: text('root_task_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  createdAt: text('created_at').notNull(),
});

export const phaseAttempts = sqliteTable('phase_attempts', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  phase: text('phase').notNull().$type<TaskPhase>(),
  attemptNumber: integer('attempt_number').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  outcome: text('outcome'),
  /** The prior phase-attempt id this one retries; null on a first attempt. */
  retryOf: text('retry_of'),
});

/**
 * Durable, denormalized per-task read model. The daemon recomputes a row on every workflow
 * transition (see refreshTaskSummary) so list/board/approval pages read this instead of a live
 * Temporal query per task. `derivedStatus` comes from the domain deriveTaskStatus; `indexedAt` is
 * the projection clock the detail page compares against live workflow state for freshness.
 */
export const taskSummary = sqliteTable('task_summary', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  phase: text('phase').notNull().$type<TaskPhase>(),
  condition: text('condition').notNull().$type<RunCondition>(),
  deliveryState: text('delivery_state').notNull().$type<DeliveryState>(),
  size: text('size').$type<TaskSize>(),
  derivedStatus: text('derived_status').notNull(),
  attemptCount: integer('attempt_count').notNull().default(0),
  openFindingCount: integer('open_finding_count').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd'),
  pendingGateReason: text('pending_gate_reason'),
  candidateSha: text('candidate_sha'),
  pullRequestUrl: text('pull_request_url'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  indexedAt: text('indexed_at').notNull(),
});
