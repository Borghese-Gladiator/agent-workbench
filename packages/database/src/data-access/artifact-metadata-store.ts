import type { ArtifactRecord } from '@awb/domain';
import type { ArtifactMetadataStore } from '@awb/evidence';
import type { DrizzleDb } from '../connection.js';
import {
  insertArtifact,
  getArtifact,
  getArtifactBySha256,
  listArtifactsByTask,
  listArtifactsByCandidateSha,
  deleteArtifact,
  listAllArtifacts,
} from './run-lifecycle.js';

/**
 * SQLite-backed `ArtifactMetadataStore` over the `artifacts` table — the durable counterpart to
 * `InMemoryArtifactMetadataStore` that the comment in `packages/evidence/src/artifact-store.ts`
 * anticipates. Used on the DAEMON side (the single writer): an `ArtifactStore` wired with this reads
 * and writes artifact metadata straight to SQLite. The worker keeps the in-memory store during a
 * phase and flushes metadata through the daemon via the run-state snapshot, so it never opens a write
 * handle (single-writer invariant, spec §8).
 */
export class SqliteArtifactMetadataStore implements ArtifactMetadataStore {
  constructor(private readonly db: DrizzleDb) {}

  insert(record: ArtifactRecord): void {
    insertArtifact(this.db, record);
  }

  get(id: string): ArtifactRecord | undefined {
    return getArtifact(this.db, id);
  }

  getBySha256(sha256: string): ArtifactRecord | undefined {
    return getArtifactBySha256(this.db, sha256);
  }

  listByTask(taskId: string): ArtifactRecord[] {
    return listArtifactsByTask(this.db, taskId);
  }

  listByCandidateSha(candidateSha: string): ArtifactRecord[] {
    return listArtifactsByCandidateSha(this.db, candidateSha);
  }

  delete(id: string): void {
    deleteArtifact(this.db, id);
  }

  all(): ArtifactRecord[] {
    return listAllArtifacts(this.db);
  }
}
