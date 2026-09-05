import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WorkbenchDatabase } from '@awb/database';
import { backfillTaskSummaries } from '@awb/database';
import { initDataDir } from '@awb/config';
import { openWorkbenchDatabase } from './db.js';
import { SemanticEventBus } from './event-bus.js';
import { registerRepositoryRoutes } from './routes/repositories.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebSocketRoute } from './routes/websocket.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerStatusRoute } from './routes/status.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerOverviewRoute } from './routes/overview.js';
import { registerExecutionTreeRoute } from './routes/execution-tree.js';
import { registerTimelineRoute } from './routes/timeline.js';
import { createTaskScheduler } from './scheduler-runtime.js';
import type { TaskScheduler } from './scheduler.js';

export interface DaemonServer {
  app: FastifyInstance;
  database: WorkbenchDatabase;
  eventBus: SemanticEventBus;
  scheduler: TaskScheduler;
  close: () => Promise<void>;
}

export async function buildServer(): Promise<DaemonServer> {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  const database = openWorkbenchDatabase();
  const { layout } = initDataDir();
  const eventBus = new SemanticEventBus();
  const scheduler = createTaskScheduler(database);

  // Project a summary for any task created before the projection existed, so the list/board/overview
  // show every task immediately on boot rather than only after its next workflow write.
  backfillTaskSummaries(database.db);

  app.get('/api/health', async () => ({ status: 'ok' }));
  registerStatusRoute(app);

  registerRepositoryRoutes(app, database);
  registerTaskRoutes(app, database, scheduler);
  registerOverviewRoute(app, database);
  registerExecutionTreeRoute(app, database);
  registerTimelineRoute(app, database);
  registerWebSocketRoute(app, eventBus, database);
  registerInternalRoutes(app, database, eventBus, scheduler);
  registerMediaRoutes(app, database, layout.artifactsDir);

  // Boot reconciliation + safety-net poll: re-derive DAG eligibility from SQLite so a restart (or a
  // missed release-push) still starts any blocked task whose parent has released.
  scheduler.start();

  return {
    app,
    database,
    eventBus,
    scheduler,
    close: async () => {
      scheduler.stop();
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
