import { eq, inArray } from 'drizzle-orm';
import type {
  TaskPhase,
  RunCondition,
  DeliveryState,
  ScheduleState,
  TaskSize,
  HumanGateReason,
} from '@awb/domain';
import { deriveTaskStatus } from '@awb/domain';
import {
  tasks,
  taskSummary,
  runs,
  phaseAttempts,
  programDesigns,
  agentSessions,
  modelInvocations,
  toolInvocations,
  commandExecutions,
  semanticEvents,
  runtimeAttribution,
  contextComposition,
  findings,
  evidence,
  evidenceClaims,
  evidenceDependencies,
  artifacts,
  humanDecisions,
  waivers,
  plans,
  planSlices,
  planClaimCoverage,
  taskContracts,
  acceptanceClaims,
  pullRequests,
  pullRequestFeedback,
  workspaceLeases,
  repositories,
} from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import type { TaskRow } from '../row-types.js';

/** The deterministic single-run id for a task (see ensureRun). */
export function runIdForTask(taskId: string): string {
  return `${taskId}-run`;
}

/** Recovers the taskId from a run id produced by runIdForTask. */
export function taskIdFromRunId(runId: string): string {
  return runId.endsWith('-run') ? runId.slice(0, -'-run'.length) : runId;
}

/**
 * Task-row lifecycle helpers. The daemon persists a `tasks` row when a task is created and updates
 * its phase/condition/delivery-state as the workflow advances, so `task show` and `GET /api/tasks`
 * read from SQLite instead of a session-scoped in-memory array. Also owns `runs` and
 * `phase_attempts`, which evidence/artifact rows reference by foreign key — those parent rows must
 * exist before a child evidence row is inserted.
 */

export interface UpsertTaskInput {
  id: string;
  repositoryId: string;
  prompt: string;
  phase?: TaskPhase;
  condition?: RunCondition;
  deliveryState?: DeliveryState;
  /** Task size class; set at intake as a hint or once the classifier decides. */
  size?: TaskSize;
  /** Stacked-PR edge (TASK-72): set once at creation, never cleared by a later sync. */
  parentTaskId?: string;
  baseBranch?: string;
  /** Scheduler-owned DAG state (task DAG orchestration). Written authoritatively by the daemon
   *  scheduler; a lifecycle sync that omits it must not change it. */
  scheduleState?: ScheduleState;
  /** Optional concise title (set at create). Lineage/title are insert-only — later syncs ignore them. */
  title?: string;
  /** The task this one retries; set at create for a retry, establishing cross-task lineage. */
  retryOfTaskId?: string;
  /** Head of the retry chain; set at create (defaults to this task's own id for an original). */
  rootTaskId?: string;
}

export function upsertTask(db: DrizzleDb, input: UpsertTaskInput, summaryContext?: TaskSummaryContext): void {
  const now = new Date().toISOString();
  const existing = db.select().from(tasks).where(eq(tasks.id, input.id)).all()[0];

  const row: TaskRow = {
    id: input.id,
    repositoryId: input.repositoryId,
    prompt: input.prompt,
    phase: input.phase ?? existing?.phase ?? 'specify',
    condition: input.condition ?? existing?.condition ?? 'running',
    deliveryState: input.deliveryState ?? existing?.deliveryState ?? 'not-started',
    size: input.size ?? existing?.size ?? null,
    parentTaskId: input.parentTaskId ?? existing?.parentTaskId ?? null,
    baseBranch: input.baseBranch ?? existing?.baseBranch ?? null,
    scheduleState: input.scheduleState ?? existing?.scheduleState ?? 'ready',
    // Title + lineage are set once, at first insert. Preserve the existing values on any later sync
    // (a sync-update never carries them), and default an original's root to its own id.
    title: existing?.title ?? input.title ?? null,
    retryOfTaskId: existing?.retryOfTaskId ?? input.retryOfTaskId ?? null,
    rootTaskId: existing?.rootTaskId ?? input.rootTaskId ?? input.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  db.insert(tasks)
    .values(row)
    .onConflictDoUpdate({
      target: tasks.id,
      set: {
        phase: row.phase,
        condition: row.condition,
        deliveryState: row.deliveryState,
        // Only advance size, never clear it — a later sync without a size must not wipe the classifier's decision.
        ...(input.size ? { size: input.size } : {}),
        // The stacking edge is set once at creation; a later phase/state sync must not wipe it.
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
        // The scheduler owns scheduleState; only overwrite when explicitly provided.
        ...(input.scheduleState ? { scheduleState: input.scheduleState } : {}),
        updatedAt: row.updatedAt,
      },
    })
    .run();

  // Keep the durable read model in lock-step with the task row on every transition — this is what
  // stops the list/board going stale once a task parks awaiting-human.
  refreshTaskSummary(db, input.id, summaryContext ?? {});
}

export function getTask(db: DrizzleDb, taskId: string): TaskRow | undefined {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
}

/**
 * The branch a task delivered on (its workspace lease's branch name) — the base a child task stacks
 * on (TASK-72). Undefined when the parent has no lease yet (worktree not materialized).
 */
export function getTaskDeliveredBranch(db: DrizzleDb, taskId: string): string | undefined {
  return db
    .select({ branchName: workspaceLeases.branchName })
    .from(workspaceLeases)
    .where(eq(workspaceLeases.taskId, taskId))
    .all()[0]?.branchName;
}

export function listTasks(db: DrizzleDb): TaskRow[] {
  return db.select().from(tasks).all();
}

/** Direct children of a task in the stacking DAG (task DAG orchestration): the tasks whose
 *  `parentTaskId` is this task. Used by the scheduler to unblock dependents when a parent releases. */
export function listTasksByParent(db: DrizzleDb, parentTaskId: string): TaskRow[] {
  return db.select().from(tasks).where(eq(tasks.parentTaskId, parentTaskId)).all();
}

/** Tasks whose workflow has not been started yet, awaiting their parent's release. */
export function listBlockedTasks(db: DrizzleDb): TaskRow[] {
  return db.select().from(tasks).where(eq(tasks.scheduleState, 'blocked')).all();
}

/** Tasks the scheduler may still start — anything not yet `started` (roots that are `ready` plus
 *  `blocked` children). Used by the reconcile sweep (poll + boot). */
export function listStartableTasks(db: DrizzleDb): TaskRow[] {
  return db.select().from(tasks).where(inArray(tasks.scheduleState, ['ready', 'blocked'])).all();
}

export interface TaskWithRepository extends TaskRow {
  repositoryName: string | null;
}

export function listTasksWithRepository(db: DrizzleDb): TaskWithRepository[] {
  return db
    .select({
      id: tasks.id,
      repositoryId: tasks.repositoryId,
      prompt: tasks.prompt,
      phase: tasks.phase,
      condition: tasks.condition,
      deliveryState: tasks.deliveryState,
      size: tasks.size,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      repositoryName: repositories.name,
    })
    .from(tasks)
    .leftJoin(repositories, eq(tasks.repositoryId, repositories.id))
    .all() as TaskWithRepository[];
}

/**
 * Extra, non-`tasks`-row context a summary recompute can be given by the caller when it is already in
 * hand (e.g. the run-state snapshot carries the pending gate). Everything here is OPTIONAL: when a
 * field is omitted, refreshTaskSummary keeps whatever the previous summary row had, so a partial
 * update (a plain task upsert with no gate info) never clobbers a gate reason set by an earlier
 * run-state write. Passing `null` explicitly clears the field (e.g. gate resolved).
 */
export interface TaskSummaryContext {
  pendingGateReason?: HumanGateReason | null;
  candidateSha?: string | null;
  pullRequestUrl?: string | null;
}

/** Row shape returned to summary readers (list/board/approvals), repo name joined in. */
export interface TaskSummaryWithRepository {
  taskId: string;
  repositoryId: string;
  repositoryName: string | null;
  prompt: string;
  /** Concise title (null → the client derives one from the prompt). */
  title: string | null;
  /** Cross-task retry lineage, joined from the tasks row. */
  retryOfTaskId: string | null;
  rootTaskId: string | null;
  phase: TaskPhase;
  condition: RunCondition;
  deliveryState: DeliveryState;
  size: TaskSize | null;
  derivedStatus: string;
  attemptCount: number;
  openFindingCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  pendingGateReason: HumanGateReason | null;
  candidateSha: string | null;
  pullRequestUrl: string | null;
  createdAt: string;
  updatedAt: string;
  indexedAt: string;
}

/**
 * Recomputes the durable `task_summary` row for a task from current SQLite state. The daemon calls it
 * on EVERY workflow transition it persists (task upsert, run-state snapshot, observability), so the
 * list/board/approval read model tracks the workflow even after a task parks awaiting-human (when the
 * bare `tasks` row stopped moving).
 *
 * Rollups are computed here, not stored incrementally, so the row is always internally consistent
 * with the child tables: tokens summed from model_invocations→agent_sessions, open findings counted,
 * phase-attempt count, latest candidate SHA and PR url. `context` supplies values not derivable from
 * the `tasks` row (the pending gate reason); omitted context fields preserve the prior row's value.
 * No-op when the task row is absent.
 */
export function refreshTaskSummary(db: DrizzleDb, taskId: string, context: TaskSummaryContext = {}): void {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
  if (!task) return;

  const prior = db.select().from(taskSummary).where(eq(taskSummary.taskId, taskId)).all()[0];

  // Token totals — sum invocations through their sessions to this task (same join as getTokenBreakdown).
  const invRows = db
    .select({
      inputTokens: modelInvocations.inputTokens,
      outputTokens: modelInvocations.outputTokens,
      costUsd: modelInvocations.costUsd,
    })
    .from(modelInvocations)
    .innerJoin(agentSessions, eq(agentSessions.id, modelInvocations.agentSessionId))
    .where(eq(agentSessions.taskId, taskId))
    .all();
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let anyCost = false;
  for (const r of invRows) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    if (r.costUsd != null) {
      costUsd += r.costUsd;
      anyCost = true;
    }
  }

  const attemptCount = db
    .select({ id: phaseAttempts.id })
    .from(phaseAttempts)
    .where(eq(phaseAttempts.taskId, taskId))
    .all().length;
  const openFindingCount = db
    .select({ status: findings.status })
    .from(findings)
    .where(eq(findings.taskId, taskId))
    .all()
    .filter((r) => r.status === 'open').length;

  const now = new Date().toISOString();
  const derivedStatus = deriveTaskStatus(task.condition, task.phase);

  // Preserve prior context values when the caller didn't supply them (a plain task upsert must not
  // wipe a gate reason a run-state write recorded). `null` in context explicitly clears.
  const pendingGateReason =
    context.pendingGateReason !== undefined
      ? context.pendingGateReason
      : (prior?.pendingGateReason as HumanGateReason | null | undefined) ?? null;
  const candidateSha =
    context.candidateSha !== undefined ? context.candidateSha : prior?.candidateSha ?? null;
  const pullRequestUrl =
    context.pullRequestUrl !== undefined ? context.pullRequestUrl : prior?.pullRequestUrl ?? null;

  const row = {
    taskId,
    repositoryId: task.repositoryId,
    phase: task.phase,
    condition: task.condition,
    deliveryState: task.deliveryState,
    size: task.size ?? null,
    derivedStatus,
    attemptCount,
    openFindingCount,
    inputTokens,
    outputTokens,
    costUsd: anyCost ? costUsd : null,
    pendingGateReason,
    candidateSha,
    pullRequestUrl,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    indexedAt: now,
  };

  db.insert(taskSummary).values(row).onConflictDoUpdate({ target: taskSummary.taskId, set: row }).run();
}

/** Reads the durable task-summary projection joined to repo name — the list/board/approval read model. */
export function listTaskSummaries(
  db: DrizzleDb,
  filter?: { repositoryId?: string },
): TaskSummaryWithRepository[] {
  const rows = db
    .select({
      taskId: taskSummary.taskId,
      repositoryId: taskSummary.repositoryId,
      repositoryName: repositories.name,
      prompt: tasks.prompt,
      title: tasks.title,
      retryOfTaskId: tasks.retryOfTaskId,
      rootTaskId: tasks.rootTaskId,
      phase: taskSummary.phase,
      condition: taskSummary.condition,
      deliveryState: taskSummary.deliveryState,
      size: taskSummary.size,
      derivedStatus: taskSummary.derivedStatus,
      attemptCount: taskSummary.attemptCount,
      openFindingCount: taskSummary.openFindingCount,
      inputTokens: taskSummary.inputTokens,
      outputTokens: taskSummary.outputTokens,
      costUsd: taskSummary.costUsd,
      pendingGateReason: taskSummary.pendingGateReason,
      candidateSha: taskSummary.candidateSha,
      pullRequestUrl: taskSummary.pullRequestUrl,
      createdAt: taskSummary.createdAt,
      updatedAt: taskSummary.updatedAt,
      indexedAt: taskSummary.indexedAt,
    })
    .from(taskSummary)
    .leftJoin(tasks, eq(taskSummary.taskId, tasks.id))
    .leftJoin(repositories, eq(taskSummary.repositoryId, repositories.id))
    .all() as TaskSummaryWithRepository[];

  return filter?.repositoryId ? rows.filter((r) => r.repositoryId === filter.repositoryId) : rows;
}

/** Reads one durable task-summary row (for the freshness comparison on the detail page). */
export function getTaskSummary(db: DrizzleDb, taskId: string): TaskSummaryWithRepository | undefined {
  return listTaskSummaries(db).find((r) => r.taskId === taskId);
}

/**
 * Projects a summary row for every task that lacks one — run once at daemon startup so tasks created
 * before the projection existed (or before this migration) appear in the list/board immediately,
 * rather than only after their next workflow write. Idempotent: recomputes from current SQLite state.
 */
export function backfillTaskSummaries(db: DrizzleDb): number {
  const allTaskIds = db
    .select({ id: tasks.id })
    .from(tasks)
    .all()
    .map((r) => r.id);
  const summarized = new Set(
    db
      .select({ id: taskSummary.taskId })
      .from(taskSummary)
      .all()
      .map((r) => r.id),
  );
  let created = 0;
  for (const id of allTaskIds) {
    if (summarized.has(id)) continue;
    refreshTaskSummary(db, id);
    created += 1;
  }
  return created;
}

/**
 * Ensures a `runs` row exists for a task (evidence/artifacts/semantic-events FK to it). One run per
 * task in this MVP — the run id is derived deterministically so repeated calls are idempotent.
 */
export function ensureRun(db: DrizzleDb, taskId: string): string {
  const runId = runIdForTask(taskId);
  const existing = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
  if (!existing) {
    db.insert(runs).values({ id: runId, taskId, createdAt: new Date().toISOString() }).run();
  }
  return runId;
}

/**
 * Ensures the `runs` + `phase_attempts` parents a semantic-event row references (FK), derived from
 * the event's own `runId`/`phaseAttemptId`/`phase`. The task row must already exist (the worker
 * persists run-state before/alongside events); this only fills in the run + attempt scaffolding so
 * an event can be inserted even if no evidence was recorded for that attempt yet.
 */
export function ensureRunAndPhaseAttempt(
  db: DrizzleDb,
  input: { runId: string; phaseAttemptId: string; phase: TaskPhase },
): void {
  const taskId = taskIdFromRunId(input.runId);
  const existingRun = db.select().from(runs).where(eq(runs.id, input.runId)).all()[0];
  if (!existingRun) {
    db.insert(runs).values({ id: input.runId, taskId, createdAt: new Date().toISOString() }).run();
  }
  const existingAttempt = db.select().from(phaseAttempts).where(eq(phaseAttempts.id, input.phaseAttemptId)).all()[0];
  if (!existingAttempt) {
    // Attempt number is the trailing integer of the id (`${taskId}-${phase}-${n}`) when present.
    const lastDash = input.phaseAttemptId.lastIndexOf('-');
    const parsed = lastDash >= 0 ? Number.parseInt(input.phaseAttemptId.slice(lastDash + 1), 10) : NaN;
    db.insert(phaseAttempts)
      .values({
        id: input.phaseAttemptId,
        runId: input.runId,
        taskId,
        phase: input.phase,
        attemptNumber: Number.isFinite(parsed) ? parsed : 1,
        startedAt: new Date().toISOString(),
      })
      .run();
  }
}

/**
 * Ensures a `phase_attempts` row exists for a (task, phase, attempt). The id matches the
 * `phaseAttemptId` the driver builds (`${taskId}-${phase}-${attemptNumber}`, see
 * phase-driver.ts buildPhaseAttempt) so evidence produced under that attempt links correctly.
 */
export function ensurePhaseAttempt(
  db: DrizzleDb,
  input: { taskId: string; phase: TaskPhase; attemptNumber: number },
): string {
  const runId = ensureRun(db, input.taskId);
  const id = `${input.taskId}-${input.phase}-${input.attemptNumber}`;
  const existing = db.select().from(phaseAttempts).where(eq(phaseAttempts.id, id)).all()[0];
  if (!existing) {
    db.insert(phaseAttempts)
      .values({
        id,
        runId,
        taskId: input.taskId,
        phase: input.phase,
        attemptNumber: input.attemptNumber,
        startedAt: new Date().toISOString(),
      })
      .run();
  }
  return id;
}

/**
 * Deletes a task and every descendant row across the ~24 FK-linked tables, in one transaction and in
 * FK-safe order (children before parents), so `foreign_keys=ON` never rejects a delete and no orphaned
 * rows survive. Returns false when the task row was absent (nothing deleted).
 *
 * Rows carrying `task_id` directly are deleted by that column; join/detail tables that only FK to an
 * intermediate parent (agent sessions, evidence, plans, contracts, pull requests) are deleted via an
 * `inArray` over the parent ids resolved for this task.
 *
 * NOTE: `memory_sources` is deliberately NOT touched. Despite carrying a `task_id` text column it has
 * no FK to `tasks` (it FKs `memory_entries`, which is repo-scoped), so it never blocks this delete and
 * removing it would orphan repository-scoped memory.
 */
export function deleteTask(db: DrizzleDb, taskId: string): boolean {
  const existing = db.select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
  if (!existing) return false;

  db.transaction((tx) => {
    const sessionIds = tx
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.taskId, taskId))
      .all()
      .map((r) => r.id);
    const evidenceIds = tx
      .select({ id: evidence.id })
      .from(evidence)
      .where(eq(evidence.taskId, taskId))
      .all()
      .map((r) => r.id);
    const planIds = tx
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.taskId, taskId))
      .all()
      .map((r) => r.id);
    const contractIds = tx
      .select({ id: taskContracts.id })
      .from(taskContracts)
      .where(eq(taskContracts.taskId, taskId))
      .all()
      .map((r) => r.id);
    const prIds = tx
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(eq(pullRequests.taskId, taskId))
      .all()
      .map((r) => r.id);
    const runIds = tx
      .select({ id: runs.id })
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .all()
      .map((r) => r.id);

    // 1. agent-session detail tables (FK → agent_sessions)
    if (sessionIds.length > 0) {
      tx.delete(modelInvocations).where(inArray(modelInvocations.agentSessionId, sessionIds)).run();
      tx.delete(toolInvocations).where(inArray(toolInvocations.agentSessionId, sessionIds)).run();
    }
    // 2-3. context + command executions carry task_id / phase_attempt_id, but delete by session too
    tx.delete(contextComposition).where(eq(contextComposition.taskId, taskId)).run();
    if (sessionIds.length > 0) {
      tx.delete(commandExecutions).where(inArray(commandExecutions.agentSessionId, sessionIds)).run();
    }
    // 4. agent sessions
    tx.delete(agentSessions).where(eq(agentSessions.taskId, taskId)).run();

    // 5. evidence join tables (FK → evidence)
    if (evidenceIds.length > 0) {
      tx.delete(evidenceClaims).where(inArray(evidenceClaims.evidenceId, evidenceIds)).run();
      tx.delete(evidenceDependencies).where(inArray(evidenceDependencies.evidenceId, evidenceIds)).run();
    }
    // 6. evidence
    tx.delete(evidence).where(eq(evidence.taskId, taskId)).run();
    // 7-8. waivers (FK → findings) before findings
    tx.delete(waivers).where(eq(waivers.taskId, taskId)).run();
    tx.delete(findings).where(eq(findings.taskId, taskId)).run();

    // 9-10. plan children (FK → plans) before plans
    if (planIds.length > 0) {
      tx.delete(planClaimCoverage).where(inArray(planClaimCoverage.planId, planIds)).run();
      tx.delete(planSlices).where(inArray(planSlices.planId, planIds)).run();
    }
    tx.delete(plans).where(eq(plans.taskId, taskId)).run();

    // program-design artifacts (FK → tasks)
    tx.delete(programDesigns).where(eq(programDesigns.taskId, taskId)).run();

    // 11-12. contract claims (FK → task_contracts) before contracts
    if (contractIds.length > 0) {
      tx.delete(acceptanceClaims).where(inArray(acceptanceClaims.taskContractId, contractIds)).run();
    }
    tx.delete(taskContracts).where(eq(taskContracts.taskId, taskId)).run();

    // 13-14. PR feedback (FK → pull_requests) before pull requests
    if (prIds.length > 0) {
      tx.delete(pullRequestFeedback).where(inArray(pullRequestFeedback.pullRequestId, prIds)).run();
    }
    tx.delete(pullRequests).where(eq(pullRequests.taskId, taskId)).run();

    // 15-19. remaining task/run/phase-attempt children
    tx.delete(runtimeAttribution).where(eq(runtimeAttribution.taskId, taskId)).run();
    if (runIds.length > 0) {
      tx.delete(semanticEvents).where(inArray(semanticEvents.runId, runIds)).run();
    }
    tx.delete(artifacts).where(eq(artifacts.taskId, taskId)).run();
    tx.delete(workspaceLeases).where(eq(workspaceLeases.taskId, taskId)).run();
    tx.delete(humanDecisions).where(eq(humanDecisions.taskId, taskId)).run();

    // 20-22. scaffolding parents last
    tx.delete(phaseAttempts).where(eq(phaseAttempts.taskId, taskId)).run();
    tx.delete(runs).where(eq(runs.taskId, taskId)).run();
    // task_summary FKs tasks(id), so drop the projection row before the task row.
    tx.delete(taskSummary).where(eq(taskSummary.taskId, taskId)).run();
    tx.delete(tasks).where(eq(tasks.id, taskId)).run();
  });

  return true;
}
