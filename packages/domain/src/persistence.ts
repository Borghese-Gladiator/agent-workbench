import { z } from 'zod';
import { TaskContractSchema, TaskSizeSchema } from './contract.js';
import { ImplementationPlanSchema, ProgramDesignSchema } from './plan.js';
import { WorkspaceLeaseSchema } from './workspace.js';
import { EvidenceSchema, FindingSchema, ArtifactRecordSchema } from './evidence.js';
import { HumanGateSchema } from './lifecycle.js';

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
  /**
   * The task's pending human gate, when it is parked awaiting a decision. Carried on the snapshot so
   * the daemon can persist the gate reason into the task-summary projection — the durable list/board
   * read model — without a live Temporal query. Absent when no gate is pending. This is the write
   * path that keeps the projection's `pending_gate_reason` fresh once a task parks awaiting-human
   * (the state where the `tasks` row otherwise froze).
   */
  pendingHumanGate: HumanGateSchema.optional(),
  worktreePath: z.string().optional(),
  lease: WorkspaceLeaseSchema.optional(),
  verificationEvidence: z.array(EvidenceSchema),
  qaEvidence: z.array(EvidenceSchema),
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
});
export type RunStateSnapshot = z.infer<typeof RunStateSnapshotSchema>;
