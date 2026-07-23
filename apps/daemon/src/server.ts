import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WorkbenchDatabase } from '@awb/database';
import { openWorkbenchDatabase } from './db.js';
import { SemanticEventBus } from './event-bus.js';
import { registerRepositoryRoutes } from './routes/repositories.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebSocketRoute } from './routes/websocket.js';
import { registerInternalRoutes } from './routes/internal.js';

export interface DaemonServer {
  app: FastifyInstance;
  database: WorkbenchDatabase;
  eventBus: SemanticEventBus;
  close: () => Promise<void>;
}

export async function buildServer(): Promise<DaemonServer> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  const database = openWorkbenchDatabase();
  const eventBus = new SemanticEventBus();

  app.get('/api/health', async () => ({ status: 'ok' }));

  registerRepositoryRoutes(app, database);
  registerTaskRoutes(app, database);
  registerWebSocketRoute(app, eventBus);
  registerInternalRoutes(app, database, eventBus);

  return {
    app,
    database,
    eventBus,
    close: async () => {
      await app.close();
      database.close();
    },
  };
}

/**
 * Binds to loopback only — this daemon owns GitHub credentials and the workbench database, so it
 * must never listen on a non-loopback interface.
 */
export async function startServer(port = 4417): Promise<DaemonServer> {
  const server = await buildServer();
  await server.app.listen({ port, host: '127.0.0.1' });
  return server;
}
