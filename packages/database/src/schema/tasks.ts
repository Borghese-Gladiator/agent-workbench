import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { TaskPhase, RunCondition, DeliveryState, TaskSize } from '@awb/domain';
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
});
