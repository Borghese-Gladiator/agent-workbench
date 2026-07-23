import { eq } from 'drizzle-orm';
import type { TaskPhase, RunCondition, DeliveryState } from '@awb/domain';
import { tasks, runs, phaseAttempts } from '../schema/index.js';
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
