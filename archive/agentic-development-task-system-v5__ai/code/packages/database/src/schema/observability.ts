import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { TaskPhase } from '@awb/domain';
import { tasks, runs, phaseAttempts } from './tasks.js';
import { agentSessions } from './sessions.js';

/** The 12 runtime-attribution buckets (spec §27), accrued per phase attempt. */
export const runtimeAttribution = sqliteTable('runtime_attribution', {
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
  environmentSetupMs: integer('environment_setup_ms').notNull().default(0),
  dependencyInstallMs: integer('dependency_install_ms').notNull().default(0),
  modelWaitMs: integer('model_wait_ms').notNull().default(0),
  modelGenerationMs: integer('model_generation_ms').notNull().default(0),
  toolExecutionMs: integer('tool_execution_ms').notNull().default(0),
  testExecutionMs: integer('test_execution_ms').notNull().default(0),
  serviceStartupMs: integer('service_startup_ms').notNull().default(0),
  qaExecutionMs: integer('qa_execution_ms').notNull().default(0),
  artifactProcessingMs: integer('artifact_processing_ms').notNull().default(0),
  githubOperationMs: integer('github_operation_ms').notNull().default(0),
  humanWaitMs: integer('human_wait_ms').notNull().default(0),
  retryBackoffMs: integer('retry_backoff_ms').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

/** The 8 context-composition buckets (spec §27), per agent session. */
export const contextComposition = sqliteTable('context_composition', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  agentSessionId: text('agent_session_id')
    .notNull()
    .references(() => agentSessions.id),
  phase: text('phase').notNull().$type<TaskPhase>(),
  role: text('role').notNull(),
  contractTokens: integer('contract_tokens').notNull().default(0),
  planTokens: integer('plan_tokens').notNull().default(0),
  diffTokens: integer('diff_tokens').notNull().default(0),
  evidenceTokens: integer('evidence_tokens').notNull().default(0),
  findingsTokens: integer('findings_tokens').notNull().default(0),
  repositoryMapTokens: integer('repository_map_tokens').notNull().default(0),
  memoryTokens: integer('memory_tokens').notNull().default(0),
  instructionTokens: integer('instruction_tokens').notNull().default(0),
  /** Provenance: 1 = chars/4 estimate, 0 = reconciled to the invocation's measured input tokens. */
  estimated: integer('estimated').notNull().default(1),
  createdAt: text('created_at').notNull(),
});
