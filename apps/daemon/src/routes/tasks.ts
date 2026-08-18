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
import {
  upsertTask,
  listTaskSummaries,
  getTaskSummary,
  deleteTask,
  getTaskDeliveredBranch,
  getTokenBreakdown,
  getRuntimeAttribution,
  listFindingsByTask,
  type TaskSummaryWithRepository,
} from '@awb/database';
import type { TaskSize, TaskFreshness } from '@awb/domain';
import { validateTaskDag, TaskDagValidationError, type TaskDagSpec } from '@awb/domain';
import { routeFeedback, NO_ROUTING_SIGNAL, type FeedbackRoutingSignal } from '@awb/github';
import { getTemporalClient, workflowIdFor } from '../temporal-client.js';
import { taskQueueName } from '../temporal-worker-constants.js';
import type { TaskScheduler } from '../scheduler.js';

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
  // Additive projection fields (TASK-81): the list now reads the durable task_summary projection, so
  // it keeps moving after a task parks awaiting-human. The base shape above is preserved.
  derivedStatus: string;
  attemptCount: number;
  openFindingCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  pendingGateReason: string | null;
  candidateSha: string | null;
  pullRequestUrl: string | null;
  title: string | null;
  retryOfTaskId: string | null;
  rootTaskId: string | null;
  indexedAt: string;
}

function toCreatedTaskRecord(t: TaskSummaryWithRepository): CreatedTaskRecord {
  return {
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
    title: t.title,
    retryOfTaskId: t.retryOfTaskId,
    rootTaskId: t.rootTaskId,
    indexedAt: t.indexedAt,
  };
}

export function registerTaskRoutes(
  app: FastifyInstance,
  database: WorkbenchDatabase,
  scheduler: TaskScheduler,
): void {
  app.post<{
    Body: {
      repositoryId: string;
      prompt: string;
      size?: TaskSize;
      parentTaskId?: string;
      baseBranch?: string;
      title?: string;
      retryOfTaskId?: string;
    };
  }>('/api/tasks', async (request, reply) => {
    const client = await getTemporalClient();
    const taskId = randomUUID();
    const { repositoryId, prompt, size, parentTaskId, title, retryOfTaskId } = request.body;

    // Retry lineage (TASK-83/84): a retry task points at the task it retries and shares the retry
    // chain's root. Resolve the root from the parent summary (its rootTaskId, or the parent itself);
    // an original task's root defaults to its own id (set by upsertTask).
    const rootTaskId = resolveRootTaskId(retryOfTaskId, getTaskSummary(database.db, retryOfTaskId ?? ''));

    // Stacked PRs (TASK-72): a child task branches off — and its PR opens against — its parent's
    // delivered branch. An explicit baseBranch wins; otherwise resolve it from the parent task's
    // lease. A root task (neither) uses the repository default branch downstream.
    let baseBranch = request.body.baseBranch;
    if (!baseBranch && parentTaskId) {
      baseBranch = getTaskDeliveredBranch(database.db, parentTaskId);
      if (!baseBranch) {
        reply.code(409);
        return { error: `parent task ${parentTaskId} has no delivered branch yet (worktree not materialized)` };
      }
    }

    const workflowId = workflowIdFor(repositoryId, taskId);
    await client.workflow.start(TaskWorkflow, {
      taskQueue: taskQueueName(),
      workflowId,
      // An optional intake size hint (CLI --size) seeds the classifier; it still decides.
      args: [{ taskId, repositoryId, prompt, ...(size ? { size } : {}), ...(baseBranch ? { baseBranch } : {}) }],
    });

    // Persist the task row so it survives a daemon restart and `task show` reads lifecycle state
    // from SQLite, replacing the previous session-scoped in-memory array. This path starts the
    // workflow inline, so mark it `started` — the scheduler's reconcile must never re-start it.
    upsertTask(database.db, {
      id: taskId,
      repositoryId,
      prompt,
      scheduleState: 'started',
      ...(size ? { size } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(title ? { title } : {}),
      ...(retryOfTaskId && rootTaskId ? { retryOfTaskId, rootTaskId } : {}),
    });

    reply.code(201);
    return {
      taskId,
      repositoryId,
      workflowId,
      ...(baseBranch ? { baseBranch } : {}),
      ...(retryOfTaskId && rootTaskId ? { retryOfTaskId, rootTaskId } : {}),
    };
  });

  // Task DAG orchestration: declare a whole stacked-PR DAG atomically. Validates (unique keys,
  // known refs, acyclic, single-parent stacking) + topo-sorts BEFORE any write, then creates every
  // task row in one pass — roots `ready`, non-roots `blocked` with their `parent_task_id` edge.
  // Only the roots are started now; the scheduler starts each child when its parent releases its
  // draft PR. A validation failure writes nothing.
  app.post<{ Body: TaskDagSpec }>('/api/task-dags', async (request, reply) => {
    const { repositoryId, nodes } = request.body ?? {};
    let order: string[];
    try {
      order = validateTaskDag({ repositoryId, nodes });
    } catch (err) {
      reply.code(400);
      return { error: err instanceof TaskDagValidationError ? err.message : String(err) };
    }

    // Assign a persisted task id per spec key, then create rows parent-first (topo order).
    const idByKey = new Map<string, string>(nodes.map((n) => [n.key, randomUUID()]));
    const created: { key: string; taskId: string; parentTaskId?: string; scheduleState: string }[] = [];
    for (const key of order) {
      const node = nodes.find((n) => n.key === key)!;
      const taskId = idByKey.get(key)!;
      const parentTaskId = node.dependsOn ? idByKey.get(node.dependsOn) : undefined;
      const scheduleState = parentTaskId ? 'blocked' : 'ready';
      upsertTask(database.db, {
        id: taskId,
        repositoryId,
        prompt: node.prompt,
        scheduleState,
        ...(parentTaskId ? { parentTaskId } : {}),
      });
      created.push({ key, taskId, parentTaskId, scheduleState });
    }

    // Start the roots (the scheduler resolves eligibility + starts; children follow on release).
    await scheduler.reconcileReady();

    reply.code(201);
    return {
      repositoryId,
      tasks: created.map((c) => ({ key: c.key, taskId: c.taskId, parentTaskId: c.parentTaskId, scheduleState: c.scheduleState })),
    };
  });

  app.get('/api/tasks', async () => {
    // Reads the durable task_summary projection (not the bare tasks row) so the list keeps advancing
    // after a task parks awaiting-human, and carries the additive derived-status/rollup/lineage fields.
    return listTaskSummaries(database.db).map(toCreatedTaskRecord);
  });

  app.get<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId',
    async (request, reply) => {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(workflowIdFor(request.params.repositoryId, request.params.taskId));
      // These read from SQLite regardless of Temporal's health and are safe to compute up-front.
      const tokenBreakdown = getTokenBreakdown(database.db, request.params.taskId);
      const runtimeAttribution = getRuntimeAttribution(database.db, request.params.taskId);
      // Advisory maintainability annotations (category maintainability, severity note),
      // read from persisted findings. Non-blocking — surfaced for the human, distinct from the
      // blocking open findings above.
      const maintainabilityFindings = listFindingsByTask(database.db, request.params.taskId)
        .filter((f) => f.category === 'maintainability' && f.severity === 'note')
        .map((f) => ({ id: f.id, path: f.path, line: f.line, description: f.description }));
      const summary = getTaskSummary(database.db, request.params.taskId);

      try {
        const state = await handle.query(getCurrentStateQuery);
        const openFindings = await handle.query(getOpenFindingsQuery);
        const pendingHumanGate = await handle.query(getPendingHumanGateQuery);
        return {
          state,
          openFindings,
          pendingHumanGate,
          tokenBreakdown,
          runtimeAttribution,
          maintainabilityFindings,
          freshness: buildTaskFreshness(true, summary?.updatedAt ?? null, summary?.indexedAt ?? null),
        };
      } catch (err) {
        // Temporal is degraded (unreachable/timed-out). Rather than 404, stay responsive from the
        // durable projection so the detail page still renders — flagged liveUnavailable via freshness.
        if (!summary) {
          reply.code(404);
          return { error: err instanceof Error ? err.message : String(err) };
        }
        return {
          state: {
            taskId: summary.taskId,
            repositoryId: summary.repositoryId,
            phase: summary.phase,
            condition: summary.condition,
            deliveryState: summary.deliveryState,
          },
          openFindings: [],
          pendingHumanGate: summary.pendingGateReason
            ? { taskId: summary.taskId, phase: summary.phase, reason: summary.pendingGateReason }
            : undefined,
          tokenBreakdown,
          runtimeAttribution,
          maintainabilityFindings,
          freshness: buildTaskFreshness(false, null, summary.indexedAt),
        };
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

/**
 * Resolves the head of a retry chain for a newly-created retry task. When retrying task P, the new
 * task's root is P's own root (so a retry-of-a-retry keeps pointing at the original), falling back to
 * P itself when P is an original with no recorded root. Returns null when this is not a retry.
 */
export function resolveRootTaskId(
  retryOfTaskId: string | undefined,
  parentSummary: TaskSummaryWithRepository | undefined,
): string | null {
  if (!retryOfTaskId) return null;
  return parentSummary?.rootTaskId ?? retryOfTaskId;
}

/**
 * Computes the freshness envelope for the task-state route. `liveAvailable` reflects whether the live
 * Temporal query succeeded; `isIndexBehind` is true only when we have a live workflow timestamp that
 * is newer than the durable projection's indexedAt (the projection lags a live advance).
 */
export function buildTaskFreshness(
  liveAvailable: boolean,
  workflowUpdatedAt: string | null,
  indexedAt: string | null,
): TaskFreshness {
  const resolvedIndexedAt = indexedAt ?? new Date(0).toISOString();
  const isIndexBehind =
    liveAvailable && workflowUpdatedAt != null && indexedAt != null && workflowUpdatedAt > indexedAt;
  return {
    liveWorkflowAvailable: liveAvailable,
    workflowUpdatedAt,
    indexedAt: resolvedIndexedAt,
    isIndexBehind,
  };
}
