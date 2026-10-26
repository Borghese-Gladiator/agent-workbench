import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  registerRepository,
  approveRepository,
  getRepository,
  listRepositories,
  getLatestSnapshot,
} from '@awb/repository';
import type { WorkbenchDatabase } from '@awb/database';
import { getRepositoryCommands, listTaskSummaries } from '@awb/database';
import { RepositoryDiscoveryWorkflow, discoveryWorkflowIdFor } from '@awb/workflow';
import { loadConfig, resolveLayout } from '@awb/config';
import { getTemporalClient } from '../temporal-client.js';
import { taskQueueName } from '../temporal-worker-constants.js';

/** `[]` when `awb init` hasn't run yet — registration itself doesn't require a config.yaml. */
function loadEnterpriseRepoRoots(): string[] {
  const layout = resolveLayout();
  if (!existsSync(layout.configFile)) return [];
  return loadConfig(layout).enterpriseRepoRoots;
}

export function registerRepositoryRoutes(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.post<{ Body: { canonicalPath: string; name?: string } }>('/api/repositories', async (request, reply) => {
    try {
      const repository = await registerRepository(database.db, {
        canonicalPath: request.body.canonicalPath,
        name: request.body.name,
        enterpriseRepoRoots: loadEnterpriseRepoRoots(),
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
    // Surface the discovered/validated commands and the repo-scoped tasks (from the durable
    // projection) plus a scoped token-usage rollup, so the repo detail page reads one route.
    const commands = getRepositoryCommands(database.db, request.params.id);
    const tasks = listTaskSummaries(database.db, { repositoryId: request.params.id });
    const scopedTokenUsage = tasks.reduce(
      (acc, t) => {
        acc.inputTokens += t.inputTokens;
        acc.outputTokens += t.outputTokens;
        if (t.costUsd != null) {
          acc.costUsd = (acc.costUsd ?? 0) + t.costUsd;
        }
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, costUsd: null as number | null },
    );
    return { repository, latestSnapshot, commands, tasks, scopedTokenUsage };
  });

  app.post<{ Params: { id: string } }>('/api/repositories/:id/refresh', async (request, reply) => {
    const repository = await getRepository(database.db, request.params.id);
    if (!repository) {
      reply.code(404);
      return { error: `No repository with id ${request.params.id}` };
    }
    // Discovery is a first-class Temporal workflow. Run it to completion and
    // return its result; the actual snapshot write happens in the workflow's activity, daemon-side.
    const client = await getTemporalClient();
    const handle = await client.workflow.start(RepositoryDiscoveryWorkflow, {
      taskQueue: taskQueueName(),
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
