import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase } from '@awb/database';
import { listSemanticEventsAfter } from '@awb/database';
import type { SemanticEventBus } from '../event-bus.js';

/**
 * Live semantic-event stream over WebSocket + the reconnect catch-up REST route (spec §31, TASK-23).
 * On (re)connect a client first calls `GET /api/events?runId=…&afterSequence=N` to backfill any
 * events it missed while disconnected, then relies on the WebSocket for new events. The WebSocket
 * only pushes; it never re-sends history — the catch-up route (reading the durable `semantic_events`
 * table by monotonic `sequence`) is the sole source of missed history.
 */
export function registerWebSocketRoute(
  app: FastifyInstance,
  eventBus: SemanticEventBus,
  database: WorkbenchDatabase,
): void {
  app.get('/api/events/stream', { websocket: true }, (socket) => {
    const unsubscribe = eventBus.subscribe((event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on('close', () => {
      unsubscribe();
    });
  });

  app.get<{ Querystring: { runId?: string; afterSequence?: string } }>(
    '/api/events',
    async (request, reply) => {
      const { runId, afterSequence } = request.query;
      if (!runId) {
        reply.code(400);
        return { error: 'runId query parameter is required' };
      }
      const after = afterSequence === undefined ? -1 : Number(afterSequence);
      if (Number.isNaN(after)) {
        reply.code(400);
        return { error: 'afterSequence must be a number' };
      }
      return { events: listSemanticEventsAfter(database.db, runId, after) };
    },
  );
}
