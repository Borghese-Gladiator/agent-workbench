import { z } from 'zod';
import { TaskContractSchema } from './contract.js';
import { ImplementationPlanSchema } from './plan.js';
import { WorkspaceLeaseSchema } from './workspace.js';
import { EvidenceSchema, FindingSchema, ArtifactRecordSchema } from './evidence.js';

/**
 * The serializable snapshot of the worker's per-task run-state that crosses the worker→daemon
 * boundary (TASK-27). The worker's live `TaskRunState` also holds an `ArtifactStore` instance (a
 * class, not data) — that is intentionally excluded here; only its content-addressed metadata rows
 * (`artifacts`) are persisted. The daemon fans this out to the run-lifecycle data-access helpers in
 * one transaction, so the daemon stays the single writer (spec §8 / docs/storage.md).
 */
export const RunStateSnapshotSchema = z.object({
  taskId: z.string(),
  repositoryId: z.string(),
  prompt: z.string().optional(),
  contract: TaskContractSchema.optional(),
  plan: ImplementationPlanSchema.optional(),
  baseSha: z.string().optional(),
  candidateSha: z.string().optional(),
  worktreePath: z.string().optional(),
  lease: WorkspaceLeaseSchema.optional(),
  verificationEvidence: z.array(EvidenceSchema),
  qaEvidence: z.array(EvidenceSchema),
  reviewFindings: z.array(FindingSchema),
  artifacts: z.array(ArtifactRecordSchema),
  dependenciesInstalled: z.boolean().optional(),
  /**
   * Builder resume tokens keyed by plan-slice id (TASK-32). Populated on load from the persisted
   * `agent_sessions.resume_session_id` rows so a worker restart resumes each slice's transcript. The
   * durable source of truth is the agent_sessions table (written via the observability path); this
   * field carries the reconstructed map back onto the worker's `TaskRunState`.
   */
  builderResumeSessions: z.record(z.string(), z.string()).optional(),
});
export type RunStateSnapshot = z.infer<typeof RunStateSnapshotSchema>;
