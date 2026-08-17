import { z } from 'zod';
import { TaskContractSchema, TaskSizeSchema } from './contract.js';
import { ImplementationPlanSchema, ProgramDesignSchema } from './plan.js';
import { WorkspaceLeaseSchema } from './workspace.js';
import { EvidenceSchema, FindingSchema, ArtifactRecordSchema } from './evidence.js';

/**
 * The serializable snapshot of the worker's per-task run-state that crosses the worker→daemon
 * boundary. The worker's live `TaskRunState` also holds an `ArtifactStore` instance (a
 * class, not data) — that is intentionally excluded here; only its content-addressed metadata rows
 * (`artifacts`) are persisted. The daemon fans this out to the run-lifecycle data-access helpers in
 * one transaction, so the daemon stays the single writer (docs/storage.md).
 */
export const RunStateSnapshotSchema = z.object({
  taskId: z.string(),
  repositoryId: z.string(),
  prompt: z.string().optional(),
  /** Task size class, classified at specify and driving the phase set. */
  size: TaskSizeSchema.optional(),
  contract: TaskContractSchema.optional(),
  plan: ImplementationPlanSchema.optional(),
  /** Program-design artifact, produced for L tasks between plan and prepare. */
  programDesign: ProgramDesignSchema.optional(),
  baseSha: z.string().optional(),
  candidateSha: z.string().optional(),
  worktreePath: z.string().optional(),
  lease: WorkspaceLeaseSchema.optional(),
  verificationEvidence: z.array(EvidenceSchema),
  qaEvidence: z.array(EvidenceSchema),
  /**
   * DURABLE RECORD of the adversarial review's findings — accumulated, kept, feeds the PR/audit
   * trail. NOT the same as `repairFindings` below (a consume-once re-prompt message); same type,
   * opposite role.
   */
  reviewFindings: z.array(FindingSchema),
  artifacts: z.array(ArtifactRecordSchema),
  dependenciesInstalled: z.boolean().optional(),
  /**
   * Builder resume tokens keyed by plan-slice id. Populated on load from the persisted
   * `agent_sessions.resume_session_id` rows so a worker restart resumes each slice's transcript. The
   * durable source of truth is the agent_sessions table (written via the observability path); this
   * field carries the reconstructed map back onto the worker's `TaskRunState`.
   */
  builderResumeSessions: z.record(z.string(), z.string()).optional(),
  /**
   * CONSUME-ONCE MESSAGE to the next implement attempt: the findings a code-fixable gate (challenge
   * review or exercise/QA) last blocked on, carried forward so the builder re-prompt says exactly
   * what to fix, then cleared once consumed. NOT the persisted `reviewFindings` record above — same
   * `Finding[]` type, opposite role (transient hand-off vs. permanent record).
   */
  repairFindings: z.array(FindingSchema).optional(),
});
export type RunStateSnapshot = z.infer<typeof RunStateSnapshotSchema>;
