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
  insertTaskDependency,
  listTasksWithRepository,
  deleteTask,
  getTaskDeliveredBranch,
  getTokenBreakdown,
  getRuntimeAttribution,
  listFindingsByTask,
  getFleetStatus,
  loadRunStateSnapshot,
} from '@awb/database';
import type { TaskSize } from '@awb/domain';
import {
  validateTaskDag,
  TaskDagValidationError,
  TaskDagSpecSchema,
  type TaskDagSpec,
} from '@awb/domain';
import { getChangedPaths, getDefaultBranch } from '@awb/repository';
import {
  routeFeedback,
  NO_ROUTING_SIGNAL,
  recoverAndDeliverDraft,
  type FeedbackRoutingSignal,
} from '@awb/github';
import { resolveLayout, resolvePlanningConfig } from '@awb/config';
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
}

/**
 * The base branch a recovered draft PR opens against. Mirrors the normal release path
 * (run-phase.ts: `runState.lease?.baseRef ?? 'main'`) so recovery and release cannot disagree about
 * where a branch forked from: for a stacked child that is its parent's branch, NOT the repo default.
 *
 * Extracted from the route so the rule is unit-testable without booting Temporal — the earlier
 * inline form guarded this with a condition that was always true, which no route test could catch.
 */
export async function resolveRecoveryBaseBranch(
  lease: { baseRef?: string } | undefined,
  repoDefaultBranch: () => Promise<string>,
): Promise<string> {
  if (lease?.baseRef) return lease.baseRef;
  try {
    return await repoDefaultBranch();
  } catch {
    return 'main';
  }
}

export function registerTaskRoutes(
  app: FastifyInstance,
  database: WorkbenchDatabase,
  scheduler: TaskScheduler,
): void {
  app.post<{
    Body: { repositoryId: string; prompt: string; size?: TaskSize; parentTaskId?: string; baseBranch?: string };
  }>('/api/tasks', async (request, reply) => {
    const client = await getTemporalClient();
    const taskId = randomUUID();
    const { repositoryId, prompt, size, parentTaskId } = request.body;

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
    // TASK-61 A/B: read the program-design toggle from config here (daemon has fs access) and thread
    // it into the input so the deterministic workflow never reads config live.
    const disableProgramDesign = resolvePlanningConfig(resolveLayout()).disableProgramDesign;
    await client.workflow.start(TaskWorkflow, {
      taskQueue: taskQueueName(),
      workflowId,
      // An optional intake size hint (CLI --size) seeds the classifier; it still decides.
      args: [
        {
          taskId,
          repositoryId,
          prompt,
          ...(size ? { size } : {}),
          ...(baseBranch ? { baseBranch } : {}),
          ...(disableProgramDesign ? { disableProgramDesign } : {}),
        },
      ],
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
    });

    reply.code(201);
    return { taskId, repositoryId, workflowId, ...(baseBranch ? { baseBranch } : {}) };
  });

  // Task DAG orchestration: declare a whole stacked-PR DAG atomically. Validates (unique keys,
  // known refs, acyclic, ≤1 'stack' parent per node — fan-in via 'after' edges is allowed, TASK-102)
  // + topo-sorts BEFORE any write, then creates every task row in one pass — roots `ready`, non-roots
  // `blocked`. The single 'stack' edge is mirrored on `parent_task_id` (git base); every edge (both
  // 'stack' and 'after') is written to `task_dependencies` for fan-in eligibility. Only the roots are
  // started now; the scheduler starts each child once all its predecessors release. Validation
  // failure writes nothing.
  app.post<{ Body: TaskDagSpec }>('/api/task-dags', async (request, reply) => {
    // Parse (and normalize dependsOn to typed edges) once; validate against the same spec.
    const parsed = TaskDagSpecSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.message };
    }
    const { repositoryId, nodes } = parsed.data;
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
      const edges = node.dependsOn ?? [];
      const stackEdge = edges.find((e) => e.mode === 'stack');
      const parentTaskId = stackEdge ? idByKey.get(stackEdge.ref) : undefined;
      const scheduleState = edges.length > 0 ? 'blocked' : 'ready';
      upsertTask(database.db, {
        id: taskId,
        repositoryId,
        prompt: node.prompt,
        scheduleState,
        ...(parentTaskId ? { parentTaskId } : {}),
      });
      for (const edge of edges) {
        insertTaskDependency(database.db, {
          taskId,
          dependsOnTaskId: idByKey.get(edge.ref)!,
          mode: edge.mode,
        });
      }
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
        size: t.size ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }),
    );
  });

  // Composed fleet view: one legible row per task (activity, bounce, findings, PR) in a single call,
  // read entirely from SQLite (no per-task Temporal query). This is the endpoint `awb fleet` renders.
  app.get('/api/tasks/fleet', async () => {
    return { tasks: getFleetStatus(database.db) };
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
        // Token breakdown from SQLite (not Workflow state, which stays compact — docs/temporal-workflows).
        const tokenBreakdown = getTokenBreakdown(database.db, request.params.taskId);
        const runtimeAttribution = getRuntimeAttribution(database.db, request.params.taskId);
        // Advisory maintainability annotations (category maintainability, severity note),
        // read from persisted findings. Non-blocking — surfaced for the human, distinct from the
        // blocking open findings above.
        const maintainabilityFindings = listFindingsByTask(database.db, request.params.taskId)
          .filter((f) => f.category === 'maintainability' && f.severity === 'note')
          .map((f) => ({ id: f.id, path: f.path, line: f.line, description: f.description }));
        return {
          state,
          openFindings,
          pendingHumanGate,
          tokenBreakdown,
          runtimeAttribution,
          maintainabilityFindings,
        };
      } catch (err) {
        reply.code(404);
        return { error: err instanceof Error ? err.message : String(err) };
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

  // Recover-and-land (TASK-114): open a DRAFT PR straight from a task's committed worktree branch,
  // for when implement completed but the run never reached `release` (verify hung/was killed, or the
  // stack was torn down). Reads the durable run-state snapshot for the worktree/branch/candidate SHA
  // + evidence, computes the changed paths, and delivers via the same primitive the release phase
  // uses. Never merges, never marks ready. This is the programmatic form of the hand-run rescue.
  app.post<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId/deliver-worktree',
    async (request, reply) => {
      const { repositoryId, taskId } = request.params;
      const snapshot = loadRunStateSnapshot(database.db, { taskId, repositoryId });
      const worktreePath = snapshot.worktreePath;
      const branchName = snapshot.lease?.branchName;
      const candidateSha = snapshot.candidateSha;
      if (!worktreePath || !branchName || !candidateSha) {
        reply.code(409);
        return {
          error:
            'deliver-worktree: no committed candidate for this task yet (missing worktree, branch, or candidate SHA) — nothing to deliver.',
        };
      }
      const baseBranch = await resolveRecoveryBaseBranch(snapshot.lease, () =>
        getDefaultBranch(worktreePath),
      );
      try {
        const changedPaths = await getChangedPaths(
          worktreePath,
          snapshot.baseSha ?? '0'.repeat(40),
          candidateSha,
        );
        const result = await recoverAndDeliverDraft({
          worktreePath,
          branchName,
          baseBranch,
          candidateSha,
          objective: snapshot.contract?.objective ?? snapshot.prompt ?? `Task ${taskId}`,
          changedPaths,
          evidence: snapshot.verificationEvidence ?? [],
          unmetReason: 'delivered via recover-and-land (verify did not complete)',
        });
        return { ok: true, prNumber: result.prNumber, prUrl: result.prUrl, title: result.title };
      } catch (err) {
        reply.code(502);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
