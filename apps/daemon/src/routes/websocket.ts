import type { FastifyInstance } from 'fastify';
import type { SemanticEventBus } from '../event-bus.js';

/**
 * Live semantic-event stream over WebSocket. On connect, a client should first fetch recent
 * events via a REST query keyed on `sequence` (not yet implemented as a route — tracked
 * separately) to catch up, then rely on this stream for new events going forward. This route
 * only pushes; it never re-sends history itself.
 */
export function registerWebSocketRoute(app: FastifyInstance, eventBus: SemanticEventBus): void {
  app.get('/api/events/stream', { websocket: true }, (socket) => {
    const unsubscribe = eventBus.subscribe((event) => {
      socket.send(JSON.stringify(event));
    });
    socket.on('close', () => {
      unsubscribe();
    });
  });
}
