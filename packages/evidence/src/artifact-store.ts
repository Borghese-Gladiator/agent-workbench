import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ArtifactKind, ArtifactRecord, ArtifactRetention } from '@awb/domain';

export interface ArtifactMetadataStore {
  insert(record: ArtifactRecord): void;
  get(id: string): ArtifactRecord | undefined;
  getBySha256(sha256: string): ArtifactRecord | undefined;
  listByTask(taskId: string): ArtifactRecord[];
  listByCandidateSha(candidateSha: string): ArtifactRecord[];
  delete(id: string): void;
  all(): ArtifactRecord[];
}

/** In-memory metadata store; a SQLite-backed implementation lives in @awb/database consumers. */
export class InMemoryArtifactMetadataStore implements ArtifactMetadataStore {
  private byId = new Map<string, ArtifactRecord>();

  insert(record: ArtifactRecord): void {
    this.byId.set(record.id, record);
  }

  get(id: string): ArtifactRecord | undefined {
    return this.byId.get(id);
  }

  getBySha256(sha256: string): ArtifactRecord | undefined {
    for (const record of this.byId.values()) {
      if (record.sha256 === sha256) return record;
    }
    return undefined;
  }

  listByTask(taskId: string): ArtifactRecord[] {
    return [...this.byId.values()].filter((r) => r.taskId === taskId);
  }

  listByCandidateSha(candidateSha: string): ArtifactRecord[] {
    return [...this.byId.values()].filter((r) => r.candidateSha === candidateSha);
  }

  delete(id: string): void {
    this.byId.delete(id);
  }

  all(): ArtifactRecord[] {
    return [...this.byId.values()];
  }
}

export interface PutArtifactInput {
  /** Path to a source file to stream in, OR a readable stream / Buffer. */
  source: string | Readable | Buffer;
  mediaType: string;
  kind: ArtifactKind;
  retention: ArtifactRetention;
  taskId?: string;
  runId?: string;
  phaseAttemptId?: string;
  candidateSha?: string;
}

export class ArtifactStore {
  constructor(
    private readonly rootDir: string,
    private readonly metadata: ArtifactMetadataStore,
  ) {}

  private shaPath(sha256: string): string {
    const prefix = sha256.slice(0, 2);
    return join(this.rootDir, 'sha256', prefix, sha256);
  }

  /** Streams the source to a temp file while hashing it in a single pass, then atomically renames into place. Deduplicates by content. */
  async put(input: PutArtifactInput): Promise<ArtifactRecord> {
    const tempPath = join(this.rootDir, `.tmp-${randomUUID()}`);
    await mkdir(dirname(tempPath), { recursive: true });

    const hash = createHash('sha256');
    let byteSize = 0;

    const source = input.source;
    const readable: Readable =
      typeof source === 'string'
        ? createReadStream(source)
        : Buffer.isBuffer(source)
          ? Readable.from(source)
          : source;

    const writeStream = createWriteStream(tempPath);
    await pipeline(
      readable,
      async function* (chunks) {
        for await (const chunk of chunks as AsyncIterable<Buffer>) {
          hash.update(chunk);
          byteSize += chunk.length;
          yield chunk;
        }
      },
      writeStream,
    );

    const sha256 = hash.digest('hex');
    const finalPath = this.shaPath(sha256);

    const existing = this.metadata.getBySha256(sha256);
    if (existing) {
      await unlink(tempPath).catch(() => undefined);
      return existing;
    }

    await mkdir(dirname(finalPath), { recursive: true });
    await rename(tempPath, finalPath);

    const record: ArtifactRecord = {
      id: randomUUID(),
      sha256,
      mediaType: input.mediaType,
      byteSize,
      relativePath: join('sha256', sha256.slice(0, 2), sha256),
      taskId: input.taskId,
      runId: input.runId,
      phaseAttemptId: input.phaseAttemptId,
      candidateSha: input.candidateSha,
      kind: input.kind,
      retention: input.retention,
      createdAt: new Date().toISOString(),
    };
    this.metadata.insert(record);
    return record;
  }

  get(id: string): { record: ArtifactRecord; path: string } | undefined {
    const record = this.metadata.get(id);
    if (!record) return undefined;
    return { record, path: this.shaPath(record.sha256) };
  }

  async exists(id: string): Promise<boolean> {
    const record = this.metadata.get(id);
    if (!record) return false;
    try {
      await stat(this.shaPath(record.sha256));
      return true;
    } catch {
      return false;
    }
  }

  async verify(id: string): Promise<boolean> {
    const record = this.metadata.get(id);
    if (!record) return false;
    const path = this.shaPath(record.sha256);
    try {
      const hash = createHash('sha256');
      await pipeline(createReadStream(path), async function* (chunks) {
        for await (const chunk of chunks as AsyncIterable<Buffer>) {
          hash.update(chunk);
          yield chunk;
        }
      });
      return hash.digest('hex') === record.sha256;
    } catch {
      return false;
    }
  }

  async delete(id: string): Promise<void> {
    const record = this.metadata.get(id);
    if (!record) return;
    this.metadata.delete(id);
    const stillReferenced = this.metadata.getBySha256(record.sha256);
    if (!stillReferenced) {
      await unlink(this.shaPath(record.sha256)).catch(() => undefined);
    }
  }

  listByTask(taskId: string): ArtifactRecord[] {
    return this.metadata.listByTask(taskId);
  }

  listByCandidateSha(candidateSha: string): ArtifactRecord[] {
    return this.metadata.listByCandidateSha(candidateSha);
  }

  /** All metadata records this store knows about — used to snapshot artifact metadata for durability. */
  allRecords(): ArtifactRecord[] {
    return this.metadata.all();
  }

  /** Removes files on disk with retention "temporary" whose metadata record no longer exists, and prunes orphan blobs. */
  async garbageCollect(): Promise<{ removed: number }> {
    let removed = 0;
    const liveHashes = new Set(this.metadata.all().map((r) => r.sha256));
    const shaRoot = join(this.rootDir, 'sha256');

    let prefixes: string[];
    try {
      prefixes = await readdir(shaRoot);
    } catch {
      return { removed: 0 };
    }

    for (const prefix of prefixes) {
      const prefixDir = join(shaRoot, prefix);
      let files: string[];
      try {
        files = await readdir(prefixDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!liveHashes.has(file)) {
          await rm(join(prefixDir, file), { force: true });
          removed += 1;
        }
      }
    }
    return { removed };
  }
}
