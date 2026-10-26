import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase } from '@awb/database';
import { buildTaskTimeline } from '@awb/database';

/**
 * Wires GET /api/tasks/:repositoryId/:taskId/timeline — the post-hoc read-back surface behind
 * `awb task timeline`. Deliberately a pure SQLite read with no Temporal handle: a timeline is asked
 * for AFTER a run, when the Workflow may be closed, terminated, or purged from history.
 */
export function registerTimelineRoute(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.get<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId/timeline',
    async (request, reply) => {
      const timeline = buildTaskTimeline(database.db, request.params.taskId);
      if (timeline.phases.length === 0) {
        reply.code(404);
        return { error: `No recorded phase attempts for task ${request.params.taskId}.` };
      }
      return timeline;
    },
  );
}
