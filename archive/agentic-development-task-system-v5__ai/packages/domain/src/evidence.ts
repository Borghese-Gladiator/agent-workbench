import { z } from 'zod';

export const EvidenceKindSchema = z.enum([
  'static-check',
  'unit-test',
  'integration-test',
  'build',
  'qa-video',
  'browser-trace',
  'terminal-recording',
  'screenshot',
  'review',
  'human-approval',
  'waiver',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const EvidenceStatusSchema = z.enum(['passed', 'failed', 'inconclusive']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  phaseAttemptId: z.string(),
  kind: EvidenceKindSchema,
  status: EvidenceStatusSchema,
  claimIds: z.array(z.string()),
  contractVersion: z.number().int().positive(),
  planVersion: z.number().int().positive().optional(),
  repositorySnapshotId: z.string(),
  baseSha: z.string().optional(),
  candidateSha: z.string().optional(),
  environmentDigest: z.string().optional(),
  scenarioVersion: z.number().int().optional(),
  policyVersion: z.string(),
  artifactIds: z.array(z.string()),
  summary: z.string(),
  createdAt: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSeveritySchema = z.enum(['blocker', 'high', 'medium', 'low', 'note']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingCategorySchema = z.enum([
  'correctness',
  'security',
  'data-integrity',
  'maintainability',
  'test-gap',
  'performance',
  'accessibility',
  'requirements',
  'architecture',
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FindingStatusSchema = z.enum(['open', 'resolved', 'waived', 'invalid']);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  candidateSha: z.string().optional(),
  severity: FindingSeveritySchema,
  category: FindingCategorySchema,
  claimIds: z.array(z.string()),
  path: z.string().optional(),
  line: z.number().int().optional(),
  description: z.string(),
  reproduction: z.array(z.string()).optional(),
  proposedRemediation: z.string().optional(),
  status: FindingStatusSchema,
});
export type Finding = z.infer<typeof FindingSchema>;

export const ArtifactKindSchema = z.enum([
  'qa-video',
  'qa-video-gif',
  'browser-trace',
  'terminal-recording',
  'screenshot',
  'test-report',
  'command-log',
  'agent-input',
  'agent-output',
  'review-report',
  'repository-map',
  'program-design',
  'manifest',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactRetentionSchema = z.enum(['temporary', 'task', 'permanent']);
export type ArtifactRetention = z.infer<typeof ArtifactRetentionSchema>;

export const ArtifactRecordSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  mediaType: z.string(),
  byteSize: z.number().int().nonnegative(),
  relativePath: z.string(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  phaseAttemptId: z.string().optional(),
  candidateSha: z.string().optional(),
  kind: ArtifactKindSchema,
  retention: ArtifactRetentionSchema,
  createdAt: z.string(),
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
