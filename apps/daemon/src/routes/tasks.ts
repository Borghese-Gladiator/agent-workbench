import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  TaskWorkflow,
  approveContractUpdate,
  rejectContractUpdate,
  approvePlanUpdate,
  rejectPlanUpdate,
  cancelSignal,
  getCurrentStateQuery,
  getOpenFindingsQuery,
  getPendingHumanGateQuery,
} from '@awb/workflow';
import { getTemporalClient, workflowIdFor } from '../temporal-client.js';
import { TASK_QUEUE } from '../temporal-worker-constants.js';

export function registerTaskRoutes(app: FastifyInstance): void {
  app.post<{ Body: { repositoryId: string; prompt: string } }>('/api/tasks', async (request, reply) => {
    const client = await getTemporalClient();
    const taskId = randomUUID();
    const { repositoryId } = request.body;

    await client.workflow.start(TaskWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId: workflowIdFor(repositoryId, taskId),
      args: [{ taskId, repositoryId }],
    });

    reply.code(201);
    return { taskId, repositoryId, workflowId: workflowIdFor(repositoryId, taskId) };
  });

  app.get<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        const state = await handle.query(getCurrentStateQuery);
        const openFindings = await handle.query(getOpenFindingsQuery);
        const pendingHumanGate = await handle.query(getPendingHumanGateQuery);
        return { state, openFindings, pendingHumanGate };
      } catch (err) {
        reply.code(404);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string }; Body: { contractVersion: number } }>(
    '/api/tasks/:repositoryId/:taskId/approve-contract',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.executeUpdate(approveContractUpdate, { args: [{ contractVersion: request.body.contractVersion }] });
        return { ok: true };
      } catch (err) {
        reply.code(409);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string }; Body: { reason: string } }>(
    '/api/tasks/:repositoryId/:taskId/reject-contract',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.executeUpdate(rejectContractUpdate, { args: [{ reason: request.body.reason }] });
        return { ok: true };
      } catch (err) {
        reply.code(409);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string }; Body: { planVersion: number } }>(
    '/api/tasks/:repositoryId/:taskId/approve-plan',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.executeUpdate(approvePlanUpdate, { args: [{ planVersion: request.body.planVersion }] });
        return { ok: true };
      } catch (err) {
        reply.code(409);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string }; Body: { reason: string } }>(
    '/api/tasks/:repositoryId/:taskId/reject-plan',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.executeUpdate(rejectPlanUpdate, { args: [{ reason: request.body.reason }] });
        return { ok: true };
      } catch (err) {
        reply.code(409);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId/cancel',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.signal(cancelSignal);
        return { ok: true };
      } catch (err) {
        reply.code(404);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
