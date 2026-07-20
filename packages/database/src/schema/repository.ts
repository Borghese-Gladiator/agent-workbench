import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import type {
  RepositoryUnitLanguage,
  RepositoryUnitKind,
  CommandPurpose,
  CommandSource,
  CommandStatus,
  QaSurfaceKind,
  RepositoryFactKind,
  RepositoryFactConfidence,
} from '@awb/domain';

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  canonicalPath: text('canonical_path').notNull(),
  name: text('name').notNull(),
  remoteUrl: text('remote_url'),
  defaultBranch: text('default_branch').notNull(),
  trusted: integer('trusted', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const repositorySnapshots = sqliteTable('repository_snapshots', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  headSha: text('head_sha').notNull(),
  createdAt: text('created_at').notNull(),
  repositoryMapArtifactId: text('repository_map_artifact_id'),
});

export const repositoryUnits = sqliteTable('repository_units', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  snapshotId: text('snapshot_id').references(() => repositorySnapshots.id),
  root: text('root').notNull(),
  language: text('language').notNull().$type<RepositoryUnitLanguage>(),
  kind: text('kind').notNull().$type<RepositoryUnitKind>(),
  framework: text('framework'),
  packageManager: text('package_manager'),
  dependsOnJson: text('depends_on_json').notNull(),
});

export const repositoryCommands = sqliteTable('repository_commands', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  unitId: text('unit_id').references(() => repositoryUnits.id),
  purpose: text('purpose').notNull().$type<CommandPurpose>(),
  command: text('command').notNull(),
  cwd: text('cwd').notNull(),
  source: text('source').notNull().$type<CommandSource>(),
  status: text('status').notNull().$type<CommandStatus>(),
  validatedAtSha: text('validated_at_sha'),
  lastExitCode: integer('last_exit_code'),
});

export const repositoryServices = sqliteTable('repository_services', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  unitId: text('unit_id').references(() => repositoryUnits.id),
  name: text('name').notNull(),
  kind: text('kind').notNull().$type<'http-api' | 'web' | 'worker' | 'cli' | 'other'>(),
  startCommandId: text('start_command_id').references(() => repositoryCommands.id),
  healthcheckCommandId: text('healthcheck_command_id').references(() => repositoryCommands.id),
  defaultPort: integer('default_port'),
});

export const repositoryQaSurfaces = sqliteTable('repository_qa_surfaces', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  unitId: text('unit_id').references(() => repositoryUnits.id),
  kind: text('kind').notNull().$type<QaSurfaceKind>(),
  entrypoint: text('entrypoint').notNull(),
  description: text('description'),
});

export const repositoryFacts = sqliteTable('repository_facts', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  kind: text('kind').notNull().$type<RepositoryFactKind>(),
  statement: text('statement').notNull(),
  confidence: text('confidence').notNull().$type<RepositoryFactConfidence>(),
  observedAtSha: text('observed_at_sha').notNull(),
  sourcePathsJson: text('source_paths_json').notNull(),
  sourceHashesJson: text('source_hashes_json').notNull(),
  invalidatedByPathsJson: text('invalidated_by_paths_json').notNull(),
  supersededBy: text('superseded_by'),
});

/** Join/log table: no corresponding domain entity, one row per (fact, source path) pair. */
export const repositoryFactSources = sqliteTable('repository_fact_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  factId: text('fact_id')
    .notNull()
    .references(() => repositoryFacts.id),
  path: text('path').notNull(),
  sha256: text('sha256'),
});

export const repositorySymbols = sqliteTable('repository_symbols', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  snapshotId: text('snapshot_id').references(() => repositorySnapshots.id),
  path: text('path').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  signature: text('signature'),
  startLine: integer('start_line'),
  endLine: integer('end_line'),
});

/** Join/log table: no corresponding domain entity, edges between symbols/units. */
export const repositoryDependencies = sqliteTable('repository_dependencies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repositoryId: text('repository_id')
    .notNull()
    .references(() => repositories.id),
  fromUnitId: text('from_unit_id')
    .notNull()
    .references(() => repositoryUnits.id),
  toUnitId: text('to_unit_id')
    .notNull()
    .references(() => repositoryUnits.id),
  kind: text('kind').notNull(),
  weight: real('weight'),
});
