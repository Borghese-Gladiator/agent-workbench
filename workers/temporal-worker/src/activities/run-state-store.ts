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
  /** Durable RECORD of the adversarial review's findings — feeds the PR/audit trail. Accumulated. */
  reviewFindings: import('@awb/domain').Finding[];
  /**
   * Consume-once MESSAGE to the next implement attempt: the open findings a code-fixable gate last
   * blocked on (challenge's real review findings, or synthesized ones from a QA/exercise block), so
   * the builder re-implements knowing exactly what to fix — description, path/line, and proposed
   * remediation — instead of re-running blind. Distinct from `reviewFindings` (a persisted record):
   * this is cleared once the builder consumes it, so a later clean pass never re-surfaces it.
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
