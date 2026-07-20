import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { ImplementationPlanStatus } from '@awb/domain';
import { tasks } from './tasks.js';

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  contractVersion: integer('contract_version').notNull(),
  version: integer('version').notNull(),
  summary: text('summary').notNull(),
  affectedAreasJson: text('affected_areas_json').notNull(),
  risksJson: text('risks_json').notNull(),
  status: text('status').notNull().$type<ImplementationPlanStatus>(),
});

export const planSlices = sqliteTable('plan_slices', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => plans.id),
  objective: text('objective').notNull(),
  claimIdsJson: text('claim_ids_json').notNull(),
  likelyPathsJson: text('likely_paths_json').notNull(),
  requiredTargetedChecksJson: text('required_targeted_checks_json').notNull(),
  dependenciesJson: text('dependencies_json').notNull(),
});

export const planClaimCoverage = sqliteTable('plan_claim_coverage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  planId: text('plan_id')
    .notNull()
    .references(() => plans.id),
  claimId: text('claim_id').notNull(),
  planSliceIdsJson: text('plan_slice_ids_json').notNull(),
  qaScenarioIdsJson: text('qa_scenario_ids_json').notNull(),
});
