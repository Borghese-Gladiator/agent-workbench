import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase } from '@awb/database';
import { SqliteArtifactMetadataStore, listArtifactsByTask } from '@awb/database';
import { ArtifactStore } from '@awb/evidence';

/** QA-media artifact kinds that the Evidence Viewer can play/preview locally. */
const PLAYABLE_KINDS = new Set(['qa-video', 'qa-video-gif', 'screenshot', 'browser-trace']);

/**
 * Read-only routes serving committed QA media bytes to the local Evidence Viewer, so a run's
 * recording is watchable without opening the PR (TASK-58). The daemon is the single reader/writer
 * of the artifact store, so it wires an `ArtifactStore` over the SQLite metadata + the durable
 * content-addressed blob dir and streams bytes with the artifact's real content-type. Loopback-only
 * like the rest of the daemon (server.ts binds 127.0.0.1).
 */
export function registerMediaRoutes(app: FastifyInstance, database: WorkbenchDatabase, artifactsDir: string): void {
  const store = new ArtifactStore(artifactsDir, new SqliteArtifactMetadataStore(database.db));

  // List a task's playable QA-media artifacts (id + kind + mediaType), newest first.
  app.get<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId/media',
    async (request) => {
      const artifacts = listArtifactsByTask(database.db, request.params.taskId)
        .filter((a) => PLAYABLE_KINDS.has(a.kind))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return artifacts.map((a) => ({ id: a.id, kind: a.kind, mediaType: a.mediaType, byteSize: a.byteSize }));
    },
  );

  // Stream one artifact's bytes with its real content-type (GIF/WEBM/PNG render inline in <img>/<video>).
  app.get<{ Params: { artifactId: string } }>('/api/artifacts/:artifactId/content', async (request, reply) => {
    const found = store.get(request.params.artifactId);
    if (!found) {
      reply.code(404);
      return { error: `No artifact ${request.params.artifactId}` };
    }
    if (!(await store.exists(request.params.artifactId))) {
      reply.code(404);
      return { error: `Artifact ${request.params.artifactId} has no bytes on disk` };
    }
    reply.header('content-type', found.record.mediaType);
    reply.header('content-length', String(found.record.byteSize));
    return reply.send(createReadStream(found.path));
  });
}
