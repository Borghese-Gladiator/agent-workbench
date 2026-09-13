import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase } from '@awb/database';
import { listTaskSummaries, summarizeTaskBatch } from '@awb/database';

/**
 * The cross-task rollup behind `awb fleet rollup` (TASK-121).
 *
 * `task_summary` answers "how did THIS task go". Nothing answered "how did that batch go", so after
 * driving N tickets an operator had to open each task individually to learn what the run produced.
 *
 * The route owns SELECTION (which tasks form the batch) and `summarizeTaskBatch` owns the
 * arithmetic, so the same rollup serves every grouping.
 */
export function registerRollupRoute(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.get<{ Querystring: { repositoryId?: string; sinceMs?: string; rootTaskId?: string } }>(
    '/api/tasks/rollup',
    async (request) => {
      const { repositoryId, rootTaskId } = request.query;
      const sinceMs = Number(request.query.sinceMs ?? '');
      const rows = listTaskSummaries(database.db, repositoryId ? { repositoryId } : undefined).filter((row) => {
        // A retry chain or a stacked DAG shares a root, which is the natural "these ran together".
        if (rootTaskId && row.rootTaskId !== rootTaskId && row.taskId !== rootTaskId) return false;
        if (!Number.isFinite(sinceMs) || sinceMs <= 0) return true;
        return Date.now() - Date.parse(row.updatedAt) <= sinceMs;
      });
      return summarizeTaskBatch(rows);
    },
  );
}
