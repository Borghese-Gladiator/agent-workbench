import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import type { EvidenceKind, EvidenceStatus, FindingSeverity, FindingCategory, FindingStatus, ArtifactKind, ArtifactRetention } from '@awb/domain';
import { tasks, runs, phaseAttempts } from './tasks.js';

export const findings = sqliteTable('findings', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  candidateSha: text('candidate_sha'),
  severity: text('severity').notNull().$type<FindingSeverity>(),
  category: text('category').notNull().$type<FindingCategory>(),
  claimIdsJson: text('claim_ids_json').notNull(),
  path: text('path'),
  line: integer('line'),
  description: text('description').notNull(),
  reproductionJson: text('reproduction_json'),
  proposedRemediation: text('proposed_remediation'),
  status: text('status').notNull().$type<FindingStatus>(),
});

export const evidence = sqliteTable('evidence', {
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
  kind: text('kind').notNull().$type<EvidenceKind>(),
  status: text('status').notNull().$type<EvidenceStatus>(),
  claimIdsJson: text('claim_ids_json').notNull(),
  contractVersion: integer('contract_version').notNull(),
  planVersion: integer('plan_version'),
  repositorySnapshotId: text('repository_snapshot_id').notNull(),
  baseSha: text('base_sha'),
  candidateSha: text('candidate_sha'),
  environmentDigest: text('environment_digest'),
  scenarioVersion: integer('scenario_version'),
  policyVersion: text('policy_version').notNull(),
  artifactIdsJson: text('artifact_ids_json').notNull(),
  summary: text('summary').notNull(),
  createdAt: text('created_at').notNull(),
});

/** Join table: no corresponding domain entity, links evidence rows to the claims they cover. */
export const evidenceClaims = sqliteTable('evidence_claims', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  evidenceId: text('evidence_id')
    .notNull()
    .references(() => evidence.id),
  claimId: text('claim_id').notNull(),
});

/** Join table: no corresponding domain entity, tracks evidence supersession/dependency edges. */
export const evidenceDependencies = sqliteTable('evidence_dependencies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  evidenceId: text('evidence_id')
    .notNull()
    .references(() => evidence.id),
  dependsOnEvidenceId: text('depends_on_evidence_id')
    .notNull()
    .references(() => evidence.id),
});

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  sha256: text('sha256').notNull(),
  mediaType: text('media_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  relativePath: text('relative_path').notNull(),
  taskId: text('task_id').references(() => tasks.id),
  runId: text('run_id').references(() => runs.id),
  phaseAttemptId: text('phase_attempt_id').references(() => phaseAttempts.id),
  candidateSha: text('candidate_sha'),
  kind: text('kind').notNull().$type<ArtifactKind>(),
  retention: text('retention').notNull().$type<ArtifactRetention>(),
  createdAt: text('created_at').notNull(),
});

export const humanDecisions = sqliteTable('human_decisions', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  phase: text('phase').notNull(),
  reason: text('reason').notNull(),
  decision: text('decision').notNull(),
  notes: text('notes'),
  decidedAt: text('decided_at').notNull(),
});

export const waivers = sqliteTable('waivers', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id),
  findingId: text('finding_id').references(() => findings.id),
  reason: text('reason').notNull(),
  approvedBy: text('approved_by'),
  createdAt: text('created_at').notNull(),
});
