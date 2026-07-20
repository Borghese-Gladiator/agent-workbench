import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ExecutionProfile, WorkspaceLeaseState } from '@awb/domain';
import { repositories } from './repository.js';
import { tasks } from './tasks.js';

export const workspaceLeases = sqliteTable('workspace_leases', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  baseRef: text('base_ref').notNull(),
  baseSha: text('base_sha').notNull(),
  branchName: text('branch_name').notNull(),
  worktreePath: text('worktree_path').notNull(),
  executionProfile: text('execution_profile').notNull().$type<ExecutionProfile>(),
  allocatedPortsJson: text('allocated_ports_json').notNull(),
  state: text('state').notNull().$type<WorkspaceLeaseState>(),
  createdAt: text('created_at').notNull(),
});
