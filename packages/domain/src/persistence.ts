import { z } from 'zod';
import { TaskContractSchema, TaskSizeSchema } from './contract.js';
import { ImplementationPlanSchema, ProgramDesignSchema } from './plan.js';
import { WorkspaceLeaseSchema } from './workspace.js';
import { EvidenceSchema, FindingSchema, ArtifactRecordSchema } from './evidence.js';
import {
  HumanGateReasonSchema,
  TaskPhaseSchema,
  RunConditionSchema,
  DeliveryStateSchema,
} from './lifecycle.js';

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
   * The gate reason the task is currently parked on (awaiting-human), carried so the daemon can push
   * it into the task_summary projection on a run-state write — the state where the bare `tasks` row
   * stops moving and the list/board would otherwise go stale on the pending reason. Absent when the
   * task is not gated.
   */
  pendingHumanGate: HumanGateReasonSchema.optional(),
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

/**
 * The lifecycle state of one task as the Workflow currently holds it, crossing the worker→daemon
 * boundary on every transition. The Workflow decides these three fields, so they are the only
 * honest source for `tasks.phase` / `tasks.condition` / `tasks.delivery_state` — before TASK-123 no
 * production path wrote them at all and every row stayed frozen at `specify | running`.
 */
export const TaskStateSyncSchema = z.object({
  taskId: z.string().min(1),
  repositoryId: z.string().min(1),
  prompt: z.string(),
  phase: TaskPhaseSchema,
  condition: RunConditionSchema,
  deliveryState: DeliveryStateSchema,
  /**
   * The gate the task parked on, projected into `task_summary`. Explicit `null` clears a resolved
   * gate; an omitted field leaves whatever the projection already holds.
   */
  pendingGateReason: HumanGateReasonSchema.nullable().optional(),
});
export type TaskStateSync = z.infer<typeof TaskStateSyncSchema>;
