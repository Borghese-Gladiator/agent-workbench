import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskContract, ImplementationPlan, ProgramDesign, TaskSize, Evidence } from '@awb/domain';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';

/**
 * Per-task state accumulated across phase Activity calls. Previously a bare module-level `Map` read
 * and written directly by all nine phases; now reached only through the `RunStateStore` seam below,
 * so a durable `@awb/database`-backed impl drops in without touching phase code.
 */
export interface TaskRunState {
  /** The repository this task belongs to; threaded so the durable store can key persisted rows. */
  repositoryId?: string;
  /** Task size class, classified in the specify phase; drives the run's phase set. */
  size?: TaskSize;
  contract?: TaskContract;
  plan?: ImplementationPlan;
  /** Program-design artifact, produced for L tasks and fed to the builder as slice context. */
  programDesign?: ProgramDesign;
  builderSessionId?: string;
  /**
   * Provider resume tokens for the builder, keyed by plan-slice id. Persisted durably so a
   * Temporal retry — even after a worker restart — resumes the slice's prior transcript instead of
   * cold-starting. Keyed by slice (stable across attempts), NOT by attempt number.
   */
  builderResumeSessions?: Record<string, string>;
  baseSha?: string;
  /** Real candidate SHA produced by the builder (Stage 2); downstream phases key evidence off it. */
  candidateSha?: string;
  worktreePath?: string;
  /** Real workspace lease when the claude runtime materialized an actual git worktree (Stage 1). */
  lease?: import('@awb/domain').WorkspaceLease;
  verificationEvidence: Evidence[];
  qaEvidence: Evidence[];
  reviewerSessionId?: string;
  /**
   * DURABLE RECORD of the adversarial review's findings. Contrast with `repairFindings` below —
   * these two look alike (both `Finding[]`) but play opposite roles; do NOT merge them:
   *   • lifecycle:  ACCUMULATED and kept — never auto-cleared.
   *   • written by: the `challenge` phase only.
   *   • read by:    the PR/evidence surface + audit trail (a permanent record of what review found).
   *   • purpose:    "what the reviewer found," preserved for humans reading the PR later.
   */
  reviewFindings: import('@awb/domain').Finding[];
  /**
   * CONSUME-ONCE MESSAGE to the next implement attempt. Same `Finding[]` type as `reviewFindings`
   * above, opposite role — keep them separate:
   *   • lifecycle:  set on a code-fixable block, then CLEARED the moment the builder consumes it, so
   *                 a later clean pass never re-surfaces stale findings.
   *   • written by: any code-fixable gate — `challenge` (its open review findings, verbatim) OR
   *                 `exercise`/QA (findings synthesized from the gate's block reasons).
   *   • read by:    the `implement` handler, which renders them into the builder's re-prompt
   *                 (description + path/line + proposed remediation) so it re-implements knowing
   *                 exactly what to fix instead of re-running blind.
   *   • purpose:    "what the NEXT builder attempt must fix," a transient hand-off, not a record.
   */
  repairFindings?: import('@awb/domain').Finding[];
  artifactStore: ArtifactStore;
  artifactsDir?: string;
  /** Whether prepare successfully installed the worktree's dependencies (real path). */
  dependenciesInstalled?: boolean;
}

/**
 * The seam a durable store swaps in behind: `load` returns the task's accumulated state (creating a fresh one on first
 * access), `save` persists mutations, `remove` drops it (assimilate cleanup). The current in-memory
 * impl preserves today's behavior exactly — a worker restart still loses state (documented
 * limitation) — but the nine phase call sites no longer touch a module global, so the SQLite-backed
 * impl is a single drop-in rather than a nine-site rewrite.
 */
export interface RunStateStore {
  load(taskId: string): Promise<TaskRunState>;
  save(taskId: string, state: TaskRunState): Promise<void>;
  remove(taskId: string): Promise<void>;
}

export class InMemoryRunStateStore implements RunStateStore {
  private readonly states = new Map<string, TaskRunState>();

  async load(taskId: string): Promise<TaskRunState> {
    let state = this.states.get(taskId);
    if (!state) {
      const artifactsDir = await mkdtemp(join(tmpdir(), 'awb-run-phase-artifacts-'));
      state = {
        verificationEvidence: [],
        qaEvidence: [],
        reviewFindings: [],
        artifactStore: new ArtifactStore(artifactsDir, new InMemoryArtifactMetadataStore()),
        artifactsDir,
      };
      this.states.set(taskId, state);
    }
    return state;
  }

  async save(taskId: string, state: TaskRunState): Promise<void> {
    this.states.set(taskId, state);
  }

  async remove(taskId: string): Promise<void> {
    this.states.delete(taskId);
  }
}
