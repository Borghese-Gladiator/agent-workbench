import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  TaskWorkflow,
  approveContractUpdate,
  rejectContractUpdate,
  approvePlanUpdate,
  rejectPlanUpdate,
  cancelSignal,
  pullRequestMergedSignal,
  pullRequestClosedSignal,
  pullRequestFeedbackReceivedSignal,
  getCurrentStateQuery,
  getOpenFindingsQuery,
  getPendingHumanGateQuery,
} from '@awb/workflow';
import type { WorkbenchDatabase } from '@awb/database';
import { upsertTask, listTasks, getTokenBreakdown, getRuntimeAttribution } from '@awb/database';
import { getTemporalClient, workflowIdFor } from '../temporal-client.js';
import { TASK_QUEUE } from '../temporal-worker-constants.js';

export interface CreatedTaskRecord {
  taskId: string;
  repositoryId: string;
  workflowId: string;
  prompt: string;
  createdAt: string;
}

export function registerTaskRoutes(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.post<{ Body: { repositoryId: string; prompt: string } }>('/api/tasks', async (request, reply) => {
    const client = await getTemporalClient();
    const taskId = randomUUID();
    const { repositoryId, prompt } = request.body;
    const workflowId = workflowIdFor(repositoryId, taskId);

    await client.workflow.start(TaskWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [{ taskId, repositoryId, prompt }],
    });

    // Persist the task row so it survives a daemon restart and `task show` reads lifecycle state
    // from SQLite (TASK-27), replacing the previous session-scoped in-memory array.
    upsertTask(database.db, { id: taskId, repositoryId, prompt });

    reply.code(201);
    return { taskId, repositoryId, workflowId };
  });

  app.get('/api/tasks', async () => {
    return listTasks(database.db).map(
      (t): CreatedTaskRecord => ({
        taskId: t.id,
        repositoryId: t.repositoryId,
        workflowId: workflowIdFor(t.repositoryId, t.id),
        prompt: t.prompt,
        createdAt: t.createdAt,
      }),
    );
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
        // §27 breakdown from SQLite (not Workflow state, which stays compact — docs/temporal-workflows).
        const tokenBreakdown = getTokenBreakdown(database.db, request.params.taskId);
        const runtimeAttribution = getRuntimeAttribution(database.db, request.params.taskId);
        return { state, openFindings, pendingHumanGate, tokenBreakdown, runtimeAttribution };
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

  app.post<{ Params: { repositoryId: string; taskId: string }; Body: { mergeCommitSha: string } }>(
    '/api/tasks/:repositoryId/:taskId/pr-merged',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.signal(pullRequestMergedSignal, { mergeCommitSha: request.body.mergeCommitSha });
        return { ok: true };
      } catch (err) {
        reply.code(404);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId/pr-closed',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.signal(pullRequestClosedSignal);
        return { ok: true };
      } catch (err) {
        reply.code(404);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string }; Body: { feedbackId: string } }>(
    '/api/tasks/:repositoryId/:taskId/pr-feedback',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.signal(pullRequestFeedbackReceivedSignal, { feedbackId: request.body.feedbackId });
        return { ok: true };
      } catch (err) {
        reply.code(404);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
