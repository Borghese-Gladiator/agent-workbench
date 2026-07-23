import type { FastifyInstance } from 'fastify';
import {
  registerRepository,
  approveRepository,
  getRepository,
  listRepositories,
  getLatestSnapshot,
} from '@awb/repository';
import type { WorkbenchDatabase } from '@awb/database';
import { RepositoryDiscoveryWorkflow, discoveryWorkflowIdFor } from '@awb/workflow';
import { getTemporalClient } from '../temporal-client.js';
import { TASK_QUEUE } from '../temporal-worker-constants.js';

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
    // Discovery is a first-class Temporal workflow (spec §9/§15, TASK-26). Run it to completion and
    // return its result; the actual snapshot write happens in the workflow's activity, daemon-side.
    const client = await getTemporalClient();
    const handle = await client.workflow.start(RepositoryDiscoveryWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: discoveryWorkflowIdFor(request.params.id),
      args: [{ repositoryId: request.params.id }],
    });
    return handle.result();
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
