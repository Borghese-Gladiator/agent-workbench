import { eq, inArray } from 'drizzle-orm';
import type { TaskPhase, RunCondition, DeliveryState, TaskSize } from '@awb/domain';
import {
  tasks,
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
 * read from SQLite instead of a session-scoped in-memory array (TASK-27). Also owns `runs` and
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
  /** Task size class (TASK-51); set at intake as a hint or once the classifier decides. */
  size?: TaskSize;
}

export function upsertTask(db: DrizzleDb, input: UpsertTaskInput): void {
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
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

export function getTask(db: DrizzleDb, taskId: string): TaskRow | undefined {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
}

export function listTasks(db: DrizzleDb): TaskRow[] {
  return db.select().from(tasks).all();
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
 * rows survive (TASK-37). Returns false when the task row was absent (nothing deleted).
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

    // program-design artifacts (FK → tasks, TASK-52)
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
    tx.delete(tasks).where(eq(tasks.id, taskId)).run();
  });

  return true;
}
