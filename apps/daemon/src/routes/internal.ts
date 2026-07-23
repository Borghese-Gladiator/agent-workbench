import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase } from '@awb/database';
import { upsertTask, persistRunStateSnapshot, insertSemanticEvent } from '@awb/database';
import { RunStateSnapshotSchema, SemanticEventSchema } from '@awb/domain';
import type { SemanticEventBus } from '../event-bus.js';

/**
 * Internal worker→daemon data channel (TASK-21/27). The worker's Activities hold only a read-only DB
 * handle; every WRITE they need goes through these loopback-only routes so the daemon stays the
 * single application writer (spec §8 / docs/storage.md). Not a public API — the daemon binds
 * 127.0.0.1 only (server.ts). A failed persist returns a non-2xx so the worker fails the phase
 * rather than advancing on unpersisted state (Decision 003).
 */
export function registerInternalRoutes(
  app: FastifyInstance,
  database: WorkbenchDatabase,
  eventBus: SemanticEventBus,
): void {
  app.put<{ Params: { taskId: string }; Body: { repositoryId: string; prompt: string; phase?: string; condition?: string; deliveryState?: string } }>(
    '/internal/tasks/:taskId',
    async (request, reply) => {
      try {
        upsertTask(database.db, {
          id: request.params.taskId,
          repositoryId: request.body.repositoryId,
          prompt: request.body.prompt,
          phase: request.body.phase as never,
          condition: request.body.condition as never,
          deliveryState: request.body.deliveryState as never,
        });
        return { ok: true };
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.put<{ Params: { taskId: string } }>('/internal/run-state/:taskId', async (request, reply) => {
    const parsed = RunStateSnapshotSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: `Invalid run-state snapshot: ${parsed.error.message}` };
    }
    if (parsed.data.taskId !== request.params.taskId) {
      reply.code(400);
      return { error: 'taskId in path and body must match' };
    }
    try {
      // The task row must exist before its lifecycle children (FK); upsert it from the snapshot.
      upsertTask(database.db, {
        id: parsed.data.taskId,
        repositoryId: parsed.data.repositoryId,
        prompt: parsed.data.prompt ?? '',
      });
      persistRunStateSnapshot(database.db, parsed.data);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post<{ Body: unknown }>('/internal/events', async (request, reply) => {
    const parsed = SemanticEventSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: `Invalid semantic event: ${parsed.error.message}` };
    }
    try {
      insertSemanticEvent(database.db, parsed.data);
      // Deliver live to any connected WebSocket clients in this same process (single hop, no poll).
      eventBus.publish(parsed.data);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
