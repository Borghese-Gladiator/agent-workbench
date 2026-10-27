import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import type { TaskPhase } from '@awb/domain';
import { tasks, phaseAttempts, runs } from './tasks.js';

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  phaseAttemptId: text('phase_attempt_id')
    .notNull()
    .references(() => phaseAttempts.id),
  phase: text('phase').notNull().$type<TaskPhase>(),
  runtime: text('runtime').notNull(),
  model: text('model'),
  /**
   * The provider's resumable session token for this agent session. Persisted so a Temporal
   * retry — even after a worker restart — can resume the transcript rather than cold-start. Null for
   * sessions whose provider exposes no resume handle (e.g. the mock runtime historically).
   */
  resumeSessionId: text('resume_session_id'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
});

export const modelInvocations = sqliteTable('model_invocations', {
  id: text('id').primaryKey(),
  agentSessionId: text('agent_session_id')
    .notNull()
    .references(() => agentSessions.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cachedInputTokens: integer('cached_input_tokens'),
  cacheCreationInputTokens: integer('cache_creation_input_tokens'),
  costUsd: real('cost_usd'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
});

export const toolInvocations = sqliteTable('tool_invocations', {
  id: text('id').primaryKey(),
  agentSessionId: text('agent_session_id')
    .notNull()
    .references(() => agentSessions.id),
  tool: text('tool').notNull(),
  inputSummary: text('input_summary'),
  resultSummary: text('result_summary'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
});

export const commandExecutions = sqliteTable('command_executions', {
  id: text('id').primaryKey(),
  agentSessionId: text('agent_session_id').references(() => agentSessions.id),
  phaseAttemptId: text('phase_attempt_id')
    .notNull()
    .references(() => phaseAttempts.id),
  commandId: text('command_id'),
  command: text('command').notNull(),
  cwd: text('cwd').notNull(),
  exitCode: integer('exit_code'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
});

export const semanticEvents = sqliteTable('semantic_events', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  sequence: integer('sequence').notNull(),
  occurredAt: text('occurred_at').notNull(),
  phase: text('phase').notNull().$type<TaskPhase>(),
  phaseAttemptId: text('phase_attempt_id')
    .notNull()
    .references(() => phaseAttempts.id),
  producer: text('producer').notNull(),
  type: text('type').notNull(),
  summary: text('summary').notNull(),
  payloadJson: text('payload_json'),
  artifactId: text('artifact_id'),
});
