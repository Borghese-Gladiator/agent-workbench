import type { FastifyInstance } from 'fastify';
import {
  registerRepository,
  approveRepository,
  getRepository,
  listRepositories,
  refreshRepositorySnapshot,
  getLatestSnapshot,
} from '@awb/repository';
import type { WorkbenchDatabase } from '@awb/database';

export function registerRepositoryRoutes(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.post<{ Body: { canonicalPath: string; name?: string } }>('/api/repositories', async (request, reply) => {
    try {
      const repository = await registerRepository(database.db, {
        canonicalPath: request.body.canonicalPath,
        name: request.body.name,
      });
      reply.code(201);
      return repository;
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/api/repositories', async () => {
    return listRepositories(database.db);
  });

  app.get<{ Params: { id: string } }>('/api/repositories/:id', async (request, reply) => {
    const repository = await getRepository(database.db, request.params.id);
    if (!repository) {
      reply.code(404);
      return { error: `No repository with id ${request.params.id}` };
    }
    const latestSnapshot = await getLatestSnapshot(database.db, request.params.id);
    return { repository, latestSnapshot };
  });

  app.post<{ Params: { id: string } }>('/api/repositories/:id/refresh', async (request, reply) => {
    const repository = await getRepository(database.db, request.params.id);
    if (!repository) {
      reply.code(404);
      return { error: `No repository with id ${request.params.id}` };
    }
    const snapshot = await refreshRepositorySnapshot(database.db, repository);
    return snapshot;
  });

  app.post<{ Params: { id: string } }>('/api/repositories/:id/approve', async (request, reply) => {
    const repository = await getRepository(database.db, request.params.id);
    if (!repository) {
      reply.code(404);
      return { error: `No repository with id ${request.params.id}` };
    }
    await approveRepository(database.db, request.params.id);
    return { ok: true };
  });
}
