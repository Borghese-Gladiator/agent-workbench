import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { AcceptanceClaimCategory, TaskContractStatus, TaskRisk } from '@awb/domain';
import { tasks } from './tasks.js';

export const taskContracts = sqliteTable('task_contracts', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  version: integer('version').notNull(),
  objective: text('objective').notNull(),
  constraintsJson: text('constraints_json').notNull(),
  nonGoalsJson: text('non_goals_json').notNull(),
  risk: text('risk').notNull().$type<TaskRisk>(),
  status: text('status').notNull().$type<TaskContractStatus>(),
});

export const acceptanceClaims = sqliteTable('acceptance_claims', {
  id: text('id').primaryKey(),
  taskContractId: text('task_contract_id')
    .notNull()
    .references(() => taskContracts.id),
  description: text('description').notNull(),
  category: text('category').notNull().$type<AcceptanceClaimCategory>(),
  deterministicEvidenceRequired: integer('deterministic_evidence_required', {
    mode: 'boolean',
  }).notNull(),
  qaEvidenceRequired: integer('qa_evidence_required', { mode: 'boolean' }).notNull(),
  humanJudgmentRequired: integer('human_judgment_required', { mode: 'boolean' }).notNull(),
});
