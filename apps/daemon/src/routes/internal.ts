import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase, TaskSummaryContext } from '@awb/database';
import { upsertTask, persistRunStateSnapshot, insertSemanticEvent, persistPhaseObservability } from '@awb/database';
import {
  RunStateSnapshotSchema,
  SemanticEventSchema,
  PhaseObservabilitySchema,
  TaskStateSyncSchema,
} from '@awb/domain';
import { getRepository, refreshRepositorySnapshot, persistValidatedStartCommand } from '@awb/repository';
import type { SemanticEventBus } from '../event-bus.js';
import type { TaskScheduler } from '../scheduler.js';

/**
 * Internal worker→daemon data channel. The worker's Activities hold only a read-only DB
 * handle; every WRITE they need goes through these loopback-only routes so the daemon stays the
 * single application writer (spec §8 / docs/storage.md). Not a public API — the daemon binds
 * 127.0.0.1 only (server.ts). A failed persist returns a non-2xx so the worker fails the phase
 * rather than advancing on unpersisted state.
 */
export function registerInternalRoutes(
  app: FastifyInstance,
  database: WorkbenchDatabase,
  eventBus: SemanticEventBus,
  scheduler: TaskScheduler,
): void {
  // Task DAG orchestration: the release phase notifies the daemon the moment a task's DRAFT PR
  // opens (it reached pr-readiness). The scheduler starts any blocked children stacked on it.
  // Best-effort for the caller — the poll/boot reconcile is the correctness backstop — so failures
  // here still return 200 (the worker must not fail the release phase on a scheduling hiccup).
  app.post<{ Params: { taskId: string } }>('/internal/task-released/:taskId', async (request) => {
    try {
      await scheduler.onParentReleased(request.params.taskId);
    } catch {
      // swallowed: reconcile() will re-derive eligibility on the next tick
    }
    return { ok: true };
  });

  // The Workflow's lifecycle sync (TASK-123). Every phase transition, loop-back, human-gate park and
  // terminal state lands here, so `tasks` (and through it `task_summary`, which `awb fleet` reads)
  // tracks the Workflow instead of freezing at `specify | running`.
  app.put<{ Params: { taskId: string }; Body: unknown }>('/internal/tasks/:taskId', async (request, reply) => {
    const parsed = TaskStateSyncSchema.safeParse({
      ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
      taskId: request.params.taskId,
    });
    if (!parsed.success) {
      reply.code(400);
      return { error: `Invalid task-state sync: ${parsed.error.message}` };
    }
    try {
      const summaryContext: TaskSummaryContext = {};
      if (parsed.data.pendingGateReason !== undefined) {
        summaryContext.pendingGateReason = parsed.data.pendingGateReason;
      }
      upsertTask(
        database.db,
        {
          id: parsed.data.taskId,
          repositoryId: parsed.data.repositoryId,
          prompt: parsed.data.prompt,
          phase: parsed.data.phase,
          condition: parsed.data.condition,
          deliveryState: parsed.data.deliveryState,
        },
        summaryContext,
      );
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

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
      // The run-state snapshot is authoritative for the current gate state, so push it into the
      // projection on every write: a present `pendingHumanGate` sets the reason, its absence clears it
      // (gate resolved). This keeps task_summary fresh once the bare `tasks` row stops moving at a
      // human gate. `candidateSha` is only forwarded when the snapshot carries it (undefined preserves
      // the prior value — a run-state write without a candidate must not wipe the last known SHA).
      const summaryContext: TaskSummaryContext = {
        pendingGateReason: parsed.data.pendingHumanGate ?? null,
      };
      if (parsed.data.candidateSha !== undefined) summaryContext.candidateSha = parsed.data.candidateSha;
      upsertTask(
        database.db,
        {
          id: parsed.data.taskId,
          repositoryId: parsed.data.repositoryId,
          prompt: parsed.data.prompt ?? '',
        },
        summaryContext,
      );
      persistRunStateSnapshot(database.db, parsed.data);
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // The real discovery write, invoked by the RepositoryDiscoveryWorkflow's
  // discoverRepository activity. The write stays daemon-side (single writer); the public
  // /api/repositories/:id/refresh route starts the workflow rather than writing inline.
  app.post<{ Params: { id: string } }>('/internal/repositories/:id/discover', async (request, reply) => {
    const repository = await getRepository(database.db, request.params.id);
    if (!repository) {
      reply.code(404);
      return { error: `No repository with id ${request.params.id}` };
    }
    try {
      const snapshot = await refreshRepositorySnapshot(database.db, repository);
      return { snapshotId: snapshot.id };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Persist a `start` command that was inferred/discovered over a task worktree and then proven to
  // boot under browser QA, so the next exercise run reuses it (Tier-1) instead of re-inferring. Write
  // stays daemon-side (single writer); the worker calls this only after a successful dev-server boot.
  app.post<{ Params: { id: string }; Body: { command: string; cwd: string; validatedAtSha?: string } }>(
    '/internal/repositories/:id/commands',
    async (request, reply) => {
      const repository = await getRepository(database.db, request.params.id);
      if (!repository) {
        reply.code(404);
        return { error: `No repository with id ${request.params.id}` };
      }
      if (!request.body?.command || !request.body?.cwd) {
        reply.code(400);
        return { error: 'command and cwd are required' };
      }
      try {
        await persistValidatedStartCommand(database.db, request.params.id, {
          command: request.body.command,
          cwd: request.body.cwd,
          validatedAtSha: request.body.validatedAtSha,
        });
        return { ok: true };
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Body: unknown }>('/internal/observability', async (request, reply) => {
    const parsed = PhaseObservabilitySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: `Invalid observability payload: ${parsed.error.message}` };
    }
    try {
      persistPhaseObservability(database.db, parsed.data);
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
      // The daemon assigns the authoritative per-run sequence; publish the stored event so live
      // WebSocket clients and the reconnect catch-up route agree on ordering.
      const stored = insertSemanticEvent(database.db, parsed.data);
      // Deliver live to any connected WebSocket clients in this same process (single hop, no poll).
      eventBus.publish(stored);
      return { ok: true, sequence: stored.sequence };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
}
