import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  TaskWorkflow,
  approveContractUpdate,
  rejectContractUpdate,
  approvePlanUpdate,
  rejectPlanUpdate,
  decideGateUpdate,
  cancelSignal,
  pullRequestMergedSignal,
  pullRequestClosedSignal,
  pullRequestFeedbackReceivedSignal,
  getCurrentStateQuery,
  getOpenFindingsQuery,
  getPendingHumanGateQuery,
} from '@awb/workflow';
import type { WorkbenchDatabase } from '@awb/database';
import {
  upsertTask,
  listTaskSummaries,
  getTaskSummary,
  deleteTask,
  getTokenBreakdown,
  getRuntimeAttribution,
  listFindingsByTask,
} from '@awb/database';
import type { HumanGateReason, TaskFreshness, TaskSize } from '@awb/domain';
import { routeFeedback, NO_ROUTING_SIGNAL, type FeedbackRoutingSignal } from '@awb/github';
import { getTemporalClient, workflowIdFor } from '../temporal-client.js';
import { taskQueueName } from '../temporal-worker-constants.js';

export interface CreatedTaskRecord {
  taskId: string;
  repositoryId: string;
  repositoryName: string | null;
  workflowId: string;
  prompt: string;
  phase: string;
  condition: string;
  deliveryState: string;
  /** Task size class; null until the specify classifier sets it. */
  size: TaskSize | null;
  createdAt: string;
  updatedAt: string;
  // --- task-summary projection fields (additive; the list/board/approval read model) ---
  /** Canonical derived status (domain deriveTaskStatus). Clients must not re-derive. */
  derivedStatus: string;
  attemptCount: number;
  openFindingCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  pendingGateReason: HumanGateReason | null;
  candidateSha: string | null;
  pullRequestUrl: string | null;
  /** When the durable projection row was last recomputed — the freshness/index clock. */
  indexedAt: string;
  /** Concise title (null → derive from prompt). */
  title: string | null;
  /** Cross-task retry lineage. */
  retryOfTaskId: string | null;
  rootTaskId: string | null;
}

export function registerTaskRoutes(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.post<{ Body: { repositoryId: string; prompt: string; size?: TaskSize; title?: string; retryOfTaskId?: string } }>('/api/tasks', async (request, reply) => {
    const client = await getTemporalClient();
    const taskId = randomUUID();
    const { repositoryId, prompt, size, title, retryOfTaskId } = request.body;
    const workflowId = workflowIdFor(repositoryId, taskId);

    // Cross-task retry lineage: a retry's root is its parent's root (or the parent itself if the
    // parent is an original). Resolve it from the parent's summary row so a whole family shares one root.
    let rootTaskId: string | undefined;
    if (retryOfTaskId) {
      const parent = getTaskSummary(database.db, retryOfTaskId);
      rootTaskId = parent?.rootTaskId ?? retryOfTaskId;
    }

    await client.workflow.start(TaskWorkflow, {
      taskQueue: taskQueueName(),
      workflowId,
      // An optional intake size hint (CLI --size) seeds the classifier; it still decides.
      args: [{ taskId, repositoryId, prompt, ...(size ? { size } : {}) }],
    });

    // Persist the task row so it survives a daemon restart and `task show` reads lifecycle state
    // from SQLite, replacing the previous session-scoped in-memory array. Title + lineage are set
    // here at create (insert-only in upsertTask).
    upsertTask(database.db, {
      id: taskId,
      repositoryId,
      prompt,
      ...(size ? { size } : {}),
      ...(title ? { title } : {}),
      ...(retryOfTaskId ? { retryOfTaskId } : {}),
      ...(rootTaskId ? { rootTaskId } : {}),
    });

    reply.code(201);
    return { taskId, repositoryId, workflowId };
  });

  app.get('/api/tasks', async () => {
    // Read the durable task-summary projection (kept fresh on every workflow transition) rather than
    // a live Temporal query per task — so the list stays truthful even for parked/awaiting-human
    // tasks, and carries the rollups the board/approval queue need.
    return listTaskSummaries(database.db).map(
      (t): CreatedTaskRecord => ({
        taskId: t.taskId,
        repositoryId: t.repositoryId,
        repositoryName: t.repositoryName,
        workflowId: workflowIdFor(t.repositoryId, t.taskId),
        prompt: t.prompt,
        phase: t.phase,
        condition: t.condition,
        deliveryState: t.deliveryState,
        size: t.size ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        derivedStatus: t.derivedStatus,
        attemptCount: t.attemptCount,
        openFindingCount: t.openFindingCount,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        costUsd: t.costUsd,
        pendingGateReason: t.pendingGateReason,
        candidateSha: t.candidateSha,
        pullRequestUrl: t.pullRequestUrl,
        indexedAt: t.indexedAt,
        title: t.title,
        retryOfTaskId: t.retryOfTaskId,
        rootTaskId: t.rootTaskId,
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

        // Self-heal the durable projection from the live workflow state we just read. The worker
        // pushes state on every transition (syncTaskState), but opening a task is also a natural
        // point to reconcile — so even a task whose worker sync was missed (e.g. the daemon was down
        // when it parked) has its list/board row corrected the moment someone views it. This is what
        // makes the list and detail agree.
        upsertTask(
          database.db,
          {
            id: request.params.taskId,
            repositoryId: request.params.repositoryId,
            prompt: state.prompt ?? '',
            phase: state.phase,
            condition: state.condition,
            deliveryState: state.deliveryState,
          },
          { pendingGateReason: pendingHumanGate ? pendingHumanGate.reason : null },
        );

        // Token breakdown from SQLite (not Workflow state, which stays compact — docs/temporal-workflows).
        const tokenBreakdown = getTokenBreakdown(database.db, request.params.taskId);
        const runtimeAttribution = getRuntimeAttribution(database.db, request.params.taskId);
        // Advisory maintainability annotations (category maintainability, severity note),
        // read from persisted findings. Non-blocking — surfaced for the human, distinct from the
        // blocking open findings above.
        const maintainabilityFindings = listFindingsByTask(database.db, request.params.taskId)
          .filter((f) => f.category === 'maintainability' && f.severity === 'note')
          .map((f) => ({ id: f.id, path: f.path, line: f.line, description: f.description }));

        // Freshness: the detail page reads LIVE workflow state, so it can tell the user when the
        // durable summary (which the list/board read) is behind. After the self-heal above the two
        // agree, so isIndexBehind is false here — but the field is part of the contract so the client
        // can render a freshness banner in cases the daemon can't reach the workflow.
        const summary = getTaskSummary(database.db, request.params.taskId);
        const freshness: TaskFreshness = {
          liveWorkflowAvailable: true,
          workflowUpdatedAt: null,
          indexedAt: summary?.indexedAt ?? new Date().toISOString(),
          isIndexBehind: false,
        };

        return {
          state,
          openFindings,
          pendingHumanGate,
          tokenBreakdown,
          runtimeAttribution,
          maintainabilityFindings,
          freshness,
        };
      } catch (err) {
        // The workflow is unreachable (completed+evicted, terminated, or the worker is down). Fall
        // back to the durable projection so the detail page still renders, and flag that live state
        // is unavailable and the index may be behind.
        const summary = getTaskSummary(database.db, request.params.taskId);
        if (!summary) {
          reply.code(404);
          return { error: err instanceof Error ? err.message : String(err) };
        }
        const freshness: TaskFreshness = {
          liveWorkflowAvailable: false,
          workflowUpdatedAt: null,
          indexedAt: summary.indexedAt,
          isIndexBehind: true,
        };
        reply.code(200);
        return { summary, freshness, liveUnavailable: true };
      }
    },
  );

  app.post<{ Params: { repositoryId: string; taskId: string }; Body: { contractVersion: number; size?: TaskSize } }>(
    '/api/tasks/:repositoryId/:taskId/approve-contract',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      try {
        // A human may override the classified size at the gate; it wins over the classifier.
        const { contractVersion, size } = request.body;
        await handle.executeUpdate(approveContractUpdate, { args: [{ contractVersion, ...(size ? { size } : {}) }] });
        if (size) upsertTask(database.db, { id: request.params.taskId, repositoryId: request.params.repositoryId, prompt: '', size });
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

  // Generalized gate decision — the ONE route the UI uses to act on any pending human gate,
  // whatever its reason (the per-reason approve/reject-contract/plan routes above remain for their
  // specific flows). The gateId in the path is the stale-gate guard: the workflow rejects a decision
  // whose gateId isn't the currently-pending one. On success the summary is refreshed so the list /
  // board / approval queue reflect the resolved gate immediately.
  app.post<{
    Params: { repositoryId: string; taskId: string; gateId: string };
    Body: { decision: 'approve' | 'deny'; comment?: string };
  }>('/api/tasks/:repositoryId/:taskId/gates/:gateId/decision', async (request, reply) => {
    const { repositoryId, taskId, gateId } = request.params;
    const { decision, comment } = request.body;
    if (decision !== 'approve' && decision !== 'deny') {
      reply.code(400);
      return { error: `decision must be "approve" or "deny", got ${JSON.stringify(decision)}` };
    }
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowIdFor(repositoryId, taskId));
    try {
      await handle.executeUpdate(decideGateUpdate, { args: [{ gateId, decision, ...(comment ? { comment } : {}) }] });
      // Reconcile the projection from the now-updated live state (gate cleared / condition changed).
      const state = await handle.query(getCurrentStateQuery);
      const pendingHumanGate = await handle.query(getPendingHumanGateQuery);
      upsertTask(
        database.db,
        { id: taskId, repositoryId, prompt: state.prompt ?? '', phase: state.phase, condition: state.condition, deliveryState: state.deliveryState },
        { pendingGateReason: pendingHumanGate ? pendingHumanGate.reason : null },
      );
      return { ok: true };
    } catch (err) {
      // A stale/absent gate is a conflict (the task moved on), not a 500.
      reply.code(409);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.delete<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId',
    async (request, reply) => {
      // Terminate the workflow first (best-effort) so a still-running run can't re-persist rows after
      // the cascade deletes them; then drop the task + every FK-descendant row.
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

  // PR-feedback ingest: classify one comment and route it — auto-loop clear
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
