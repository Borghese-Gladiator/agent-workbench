import type { FastifyInstance } from 'fastify';
import type { TaskScheduler, ReconcileDisposition } from '../scheduler.js';

/**
 * The recovery route behind `awb reconcile` (TASK-111).
 *
 * After a network partition the worker→daemon→SQLite writes are lost while the daemon is down, so
 * the Temporal history advances while the database stays frozen. This re-syncs every non-terminal
 * row FROM Temporal and reports what it found, so the operator can tell a task that was merely
 * behind from one that is genuinely dead — instead of reading Temporal history by hand.
 *
 * It is a POST because it writes, and it is safe to run repeatedly: a second pass over an
 * already-corrected row reports `in-sync` and writes nothing.
 */
export function registerReconcileRoute(app: FastifyInstance, scheduler: TaskScheduler): void {
  app.post('/api/reconcile', async () => {
    const entries = await scheduler.reconcileFromWorkflows();
    const counts: Record<ReconcileDisposition, number> = {
      'in-sync': 0,
      resynced: 0,
      abandoned: 0,
      unreachable: 0,
    };
    for (const entry of entries) counts[entry.disposition] += 1;
    return { scanned: entries.length, counts, tasks: entries };
  });
}
