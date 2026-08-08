import { initDataDir } from '@awb/config';
import {
  createReadOnlyDatabase,
  loadRunStateSnapshot,
  getTask,
} from '@awb/database';
import { ArtifactStore, InMemoryArtifactMetadataStore } from '@awb/evidence';
import type { RunStateSnapshot } from '@awb/domain';
import { createDaemonClient, type DaemonClient } from '../daemon-client.js';
import type { RunStateStore, TaskRunState } from './run-state-store.js';

/**
 * Durable `RunStateStore`. Reads persisted lifecycle rows through a read-only DB handle and
 * writes exclusively through the daemon (single-writer invariant, docs/storage.md). A
 * worker restart mid-task therefore resumes with the real contract/plan/candidate-SHA/evidence
 * instead of the empty state the in-memory Map produced.
 *
 * The `ArtifactStore` keeps an in-memory metadata store during a phase — its blobs live in the
 * durable content-addressed dir (`layout.artifactsDir`), and its metadata rows are captured in the
 * snapshot on `save` and re-seeded from SQLite on `load`. This keeps `ArtifactMetadataStore`'s
 * synchronous interface intact while the async daemon write happens once per `save`.
 */
export class SqliteRunStateStore implements RunStateStore {
  private readonly cache = new Map<string, TaskRunState>();
  private readonly daemon: DaemonClient;

  constructor(daemon: DaemonClient = createDaemonClient()) {
    this.daemon = daemon;
  }

  async load(taskId: string): Promise<TaskRunState> {
    const cached = this.cache.get(taskId);
    if (cached) return cached;

    const { layout } = initDataDir();
    const artifactsDir = layout.artifactsDir;

    let snapshot: RunStateSnapshot | undefined;
    const db = createReadOnlyDatabase(layout.workbenchSqlite);
    try {
      const taskRow = getTask(db.db, taskId);
      if (taskRow) {
        snapshot = loadRunStateSnapshot(db.db, {
          taskId,
          repositoryId: taskRow.repositoryId,
          prompt: taskRow.prompt,
        });
      }
    } finally {
      db.close();
    }

    const metadata = new InMemoryArtifactMetadataStore();
    for (const record of snapshot?.artifacts ?? []) {
      metadata.insert(record);
    }
    const artifactStore = new ArtifactStore(artifactsDir, metadata);

    const state: TaskRunState = {
      repositoryId: snapshot?.repositoryId,
      size: snapshot?.size,
      contract: snapshot?.contract,
      plan: snapshot?.plan,
      programDesign: snapshot?.programDesign,
      baseSha: snapshot?.baseSha,
      candidateSha: snapshot?.candidateSha,
      worktreePath: snapshot?.worktreePath,
      lease: snapshot?.lease,
      builderResumeSessions: snapshot?.builderResumeSessions,
      verificationEvidence: snapshot?.verificationEvidence ?? [],
      qaEvidence: snapshot?.qaEvidence ?? [],
      reviewFindings: snapshot?.reviewFindings ?? [],
      artifactStore,
      artifactsDir,
      dependenciesInstalled: snapshot?.dependenciesInstalled,
    };
    this.cache.set(taskId, state);
    return state;
  }

  async save(taskId: string, state: TaskRunState): Promise<void> {
    this.cache.set(taskId, state);
    const snapshot = toSnapshot(taskId, state);
    await this.daemon.saveRunState(snapshot);
  }

  async remove(taskId: string): Promise<void> {
    // Keep the persisted rows for the audit trail (assimilate is terminal); drop only the cache.
    this.cache.delete(taskId);
  }
}

/**
 * Extracts the serializable `RunStateSnapshot` from a live `TaskRunState`. repositoryId is threaded
 * onto the run state from the workflow state by `runPhase`; the lease is a fallback for it.
 */
export function toSnapshot(taskId: string, state: TaskRunState): RunStateSnapshot {
  return {
    taskId,
    repositoryId: state.repositoryId ?? state.lease?.repositoryId ?? '',
    ...(state.size ? { size: state.size } : {}),
    ...(state.contract ? { contract: state.contract } : {}),
    ...(state.plan ? { plan: state.plan } : {}),
    ...(state.programDesign ? { programDesign: state.programDesign } : {}),
    ...(state.baseSha ? { baseSha: state.baseSha } : {}),
    ...(state.candidateSha ? { candidateSha: state.candidateSha } : {}),
    ...(state.worktreePath ? { worktreePath: state.worktreePath } : {}),
    ...(state.lease ? { lease: state.lease } : {}),
    ...(state.builderResumeSessions ? { builderResumeSessions: state.builderResumeSessions } : {}),
    verificationEvidence: state.verificationEvidence,
    qaEvidence: state.qaEvidence,
    reviewFindings: state.reviewFindings,
    artifacts: state.artifactStore.allRecords(),
    ...(state.dependenciesInstalled !== undefined
      ? { dependenciesInstalled: state.dependenciesInstalled }
      : {}),
  };
}
