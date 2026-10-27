import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { tasks } from './tasks.js';

export const pullRequests = sqliteTable('pull_requests', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  number: integer('number'),
  url: text('url'),
  state: text('state').notNull(),
  isDraft: integer('is_draft', { mode: 'boolean' }).notNull(),
  title: text('title').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const pullRequestFeedback = sqliteTable('pull_request_feedback', {
  id: text('id').primaryKey(),
  pullRequestId: text('pull_request_id')
    .notNull()
    .references(() => pullRequests.id),
  author: text('author'),
  path: text('path'),
  line: integer('line'),
  body: text('body').notNull(),
  resolved: integer('resolved', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
});
