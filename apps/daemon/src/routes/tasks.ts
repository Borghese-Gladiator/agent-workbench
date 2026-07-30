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
import { upsertTask, listTasksWithRepository, deleteTask, getTokenBreakdown, getRuntimeAttribution } from '@awb/database';
import { routeFeedback, NO_ROUTING_SIGNAL, type FeedbackRoutingSignal } from '@awb/github';
import { getTemporalClient, workflowIdFor } from '../temporal-client.js';
import { TASK_QUEUE } from '../temporal-worker-constants.js';

export interface CreatedTaskRecord {
  taskId: string;
  repositoryId: string;
  repositoryName: string | null;
  workflowId: string;
  prompt: string;
  phase: string;
  condition: string;
  deliveryState: string;
  createdAt: string;
  updatedAt: string;
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
    return listTasksWithRepository(database.db).map(
      (t): CreatedTaskRecord => ({
        taskId: t.id,
        repositoryId: t.repositoryId,
        repositoryName: t.repositoryName,
        workflowId: workflowIdFor(t.repositoryId, t.id),
        prompt: t.prompt,
        phase: t.phase,
        condition: t.condition,
        deliveryState: t.deliveryState,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
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

  app.delete<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId',
    async (request, reply) => {
      // Terminate the workflow first (best-effort) so a still-running run can't re-persist rows after
      // the cascade deletes them; then drop the task + every FK-descendant row (TASK-37).
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.terminate('task removed');
      } catch {
        // No running workflow (completed/failed/never-started) — nothing to terminate.
      }
      const removed = deleteTask(database.db, request.params.taskId);
      if (!removed) {
        reply.code(404);
        return { error: `No task ${request.params.taskId}` };
      }
      return { removed: request.params.taskId };
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

  // §29 PR-feedback ingest (TASK-25): classify one comment and route it — auto-loop clear
  // implementation defects (signal the workflow to re-enter the review loop) or return a
  // human-gate decision for anything ambiguous/scope/plan/contract-related. This is the runtime
  // caller for classifyFeedback/canAutoLoop/routeFeedback (previously unwired). A background
  // poller (getPrStatus + comment fetch) can drive this per new comment; the manual endpoint is
  // also the ingest point when feedback is pushed in.
  app.post<{
    Params: { repositoryId: string; taskId: string };
    Body: { feedbackId: string; body: string; signal?: Partial<FeedbackRoutingSignal> };
  }>('/api/tasks/:repositoryId/:taskId/pr-feedback-ingest', async (request, reply) => {
    const decision = routeFeedback(request.body.body, {
      ...NO_ROUTING_SIGNAL,
      ...(request.body.signal ?? {}),
    });
    if (decision.action === 'auto-loop') {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        await handle.signal(pullRequestFeedbackReceivedSignal, { feedbackId: request.body.feedbackId });
      } catch (err) {
        reply.code(404);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    // human-gate: the caller (UI/poller) surfaces a gate for a human to resolve; no auto signal.
    return { category: decision.category, action: decision.action };
  });
}
