import { eq, desc, and } from 'drizzle-orm';
import { TaskPhaseSchema } from '@awb/domain';
import type { TaskPhase, RunCondition, DeliveryState, TaskSize, FindingSeverity } from '@awb/domain';
import {
  tasks,
  repositories,
  phaseAttempts,
  semanticEvents,
  findings,
  pullRequests,
} from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import { runIdForTask } from './tasks.js';

const PHASE_ORDER: readonly TaskPhase[] = TaskPhaseSchema.options;

function phaseIndex(phase: string): number {
  const idx = PHASE_ORDER.indexOf(phase as TaskPhase);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

export interface FleetPrRef {
  number: number | null;
  url: string | null;
  isDraft: boolean;
  state: string;
}

export interface FleetTaskRow {
  taskId: string;
  repositoryId: string;
  repositoryName: string | null;
  promptLine: string;
  phase: TaskPhase;
  condition: RunCondition;
  deliveryState: DeliveryState;
  size: TaskSize | null;
  /** Attempt number of the current phase (1 = first pass). */
  attempt: number;
  /** The furthest phase this run ever reached, when it has since regressed to an earlier phase. */
  bouncedFrom: TaskPhase | null;
  /** Outcome recorded on the most recent completed attempt of the current phase, if any. */
  lastOutcome: string | null;
  /** Latest semantic-event summary — what the task is doing right now. */
  activity: string | null;
  activityType: string | null;
  /** Age of the latest event in whole seconds, relative to `now`. */
  activityAgeSec: number | null;
  openFindings: number;
  topFinding: { severity: FindingSeverity; description: string } | null;
  pr: FleetPrRef | null;
  parentTaskId: string | null;
  updatedAt: string;
}

function firstLine(prompt: string): string {
  const line = prompt.split('\n', 1)[0]?.trim() ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** Attempt/bounce signal for a task, read from its phase_attempts. */
function attemptSignal(
  db: DrizzleDb,
  taskId: string,
  currentPhase: string,
): { attempt: number; bouncedFrom: TaskPhase | null; lastOutcome: string | null } {
  const rows = db
    .select({
      phase: phaseAttempts.phase,
      attemptNumber: phaseAttempts.attemptNumber,
      startedAt: phaseAttempts.startedAt,
      outcome: phaseAttempts.outcome,
    })
    .from(phaseAttempts)
    .where(eq(phaseAttempts.taskId, taskId))
    .all();

  if (rows.length === 0) {
    return { attempt: 1, bouncedFrom: null, lastOutcome: null };
  }

  const currentPhaseRows = rows.filter((r) => r.phase === currentPhase);
  const attempt =
    currentPhaseRows.length > 0 ? Math.max(...currentPhaseRows.map((r) => r.attemptNumber)) : 1;

  // The most recent attempt of the current phase that carries an outcome (a completed prior attempt).
  const lastOutcome =
    currentPhaseRows
      .filter((r) => r.outcome != null)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .at(-1)?.outcome ?? null;

  // Regression: the furthest phase ever reached is later in the order than where we are now.
  const furthestReached = rows.reduce(
    (max, r) => (phaseIndex(r.phase) > phaseIndex(max) ? r.phase : max),
    rows[0]!.phase,
  );
  const bouncedFrom =
    phaseIndex(furthestReached) > phaseIndex(currentPhase) ? (furthestReached as TaskPhase) : null;

  return { attempt, bouncedFrom, lastOutcome };
}

/**
 * Composes one legible status row per task from SQLite in a single call — no per-task Temporal query.
 * Surfaces the signals a human or an agent needs to monitor a fleet at a glance: current activity,
 * whether a run bounced back to an earlier phase, open findings, and any delivered PR. `now` is
 * injectable for deterministic tests.
 */
export function getFleetStatus(db: DrizzleDb, now: Date = new Date()): FleetTaskRow[] {
  const taskRows = db
    .select({
      id: tasks.id,
      repositoryId: tasks.repositoryId,
      prompt: tasks.prompt,
      phase: tasks.phase,
      condition: tasks.condition,
      deliveryState: tasks.deliveryState,
      size: tasks.size,
      parentTaskId: tasks.parentTaskId,
      updatedAt: tasks.updatedAt,
      repositoryName: repositories.name,
    })
    .from(tasks)
    .leftJoin(repositories, eq(tasks.repositoryId, repositories.id))
    .orderBy(desc(tasks.updatedAt))
    .all();

  return taskRows.map((t): FleetTaskRow => {
    const { attempt, bouncedFrom, lastOutcome } = attemptSignal(db, t.id, t.phase);

    const latestEvent = db
      .select({
        summary: semanticEvents.summary,
        type: semanticEvents.type,
        occurredAt: semanticEvents.occurredAt,
      })
      .from(semanticEvents)
      .where(eq(semanticEvents.runId, runIdForTask(t.id)))
      .orderBy(desc(semanticEvents.sequence))
      .limit(1)
      .all()[0];

    const activityAgeSec = latestEvent
      ? Math.max(0, Math.round((now.getTime() - new Date(latestEvent.occurredAt).getTime()) / 1000))
      : null;

    const openFindingRows = db
      .select({ severity: findings.severity, description: findings.description })
      .from(findings)
      .where(and(eq(findings.taskId, t.id), eq(findings.status, 'open')))
      .all();

    const prRow = db
      .select({
        number: pullRequests.number,
        url: pullRequests.url,
        isDraft: pullRequests.isDraft,
        state: pullRequests.state,
      })
      .from(pullRequests)
      .where(eq(pullRequests.taskId, t.id))
      .orderBy(desc(pullRequests.updatedAt))
      .limit(1)
      .all()[0];

    return {
      taskId: t.id,
      repositoryId: t.repositoryId,
      repositoryName: t.repositoryName ?? null,
      promptLine: firstLine(t.prompt),
      phase: t.phase,
      condition: t.condition,
      deliveryState: t.deliveryState,
      size: t.size ?? null,
      attempt,
      bouncedFrom,
      lastOutcome,
      activity: latestEvent?.summary ?? null,
      activityType: latestEvent?.type ?? null,
      activityAgeSec,
      openFindings: openFindingRows.length,
      topFinding: openFindingRows[0]
        ? {
            severity: openFindingRows[0].severity as FindingSeverity,
            description: openFindingRows[0].description,
          }
        : null,
      pr: prRow
        ? { number: prRow.number, url: prRow.url, isDraft: prRow.isDraft, state: prRow.state }
        : null,
      parentTaskId: t.parentTaskId ?? null,
      updatedAt: t.updatedAt,
    };
  });
}
