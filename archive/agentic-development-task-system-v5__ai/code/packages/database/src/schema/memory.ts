import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { repositories } from './repository.js';

export const memoryEntries = sqliteTable('memory_entries', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id').references(() => repositories.id),
  title: text('title').notNull(),
  body: text('body').notNull(),
  kind: text('kind').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Join/log table: no corresponding domain entity, links a memory entry to its source paths. */
export const memorySources = sqliteTable('memory_sources', {
  id: text('id').primaryKey(),
  memoryEntryId: text('memory_entry_id')
    .notNull()
    .references(() => memoryEntries.id),
  path: text('path'),
  taskId: text('task_id'),
  description: text('description'),
});

export const failureSignatures = sqliteTable('failure_signatures', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id').references(() => repositories.id),
  signature: text('signature').notNull(),
  summary: text('summary').notNull(),
  occurrenceCount: integer('occurrence_count').notNull(),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
});
