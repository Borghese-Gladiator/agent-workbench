import { and, eq, gt, asc } from 'drizzle-orm';
import type { SemanticEvent } from '@awb/domain';
import { semanticEvents } from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import type { SemanticEventRow } from '../row-types.js';
import { ensureRunAndPhaseAttempt } from './tasks.js';

/**
 * Semantic-event persistence (TASK-22/23). The worker's agent sessions emit normalized
 * `SemanticEvent`s; the daemon writes them here (single writer) and serves the reconnect catch-up
 * query keyed on `sequence` (spec §31). The raw provider stream is never stored — only the compact
 * semantic summary (spec §19); `payloadJson` holds small structured payloads (e.g. a Finding) only.
 */

function eventToRow(event: SemanticEvent): SemanticEventRow {
  return {
    id: event.id,
    runId: event.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    phase: event.phase,
    phaseAttemptId: event.phaseAttemptId,
    producer: event.producer,
    type: event.type,
    summary: event.summary,
    payloadJson: event.payloadJson === undefined ? null : JSON.stringify(event.payloadJson),
    artifactId: event.artifactId ?? null,
  };
}

function rowToEvent(row: SemanticEventRow): SemanticEvent {
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    occurredAt: row.occurredAt,
    phase: row.phase,
    phaseAttemptId: row.phaseAttemptId,
    producer: row.producer as SemanticEvent['producer'],
    type: row.type as SemanticEvent['type'],
    summary: row.summary,
    ...(row.payloadJson != null ? { payloadJson: JSON.parse(row.payloadJson) } : {}),
    ...(row.artifactId != null ? { artifactId: row.artifactId } : {}),
  };
}

export function insertSemanticEvent(db: DrizzleDb, event: SemanticEvent): void {
  db.transaction((tx) => {
    ensureRunAndPhaseAttempt(tx as unknown as DrizzleDb, {
      runId: event.runId,
      phaseAttemptId: event.phaseAttemptId,
      phase: event.phase,
    });
    const row = eventToRow(event);
    tx.insert(semanticEvents).values(row).onConflictDoUpdate({ target: semanticEvents.id, set: row }).run();
  });
}

/** Reconnect catch-up (spec §31): events for a run with sequence > afterSequence, in order. */
export function listSemanticEventsAfter(
  db: DrizzleDb,
  runId: string,
  afterSequence: number,
): SemanticEvent[] {
  return db
    .select()
    .from(semanticEvents)
    .where(and(eq(semanticEvents.runId, runId), gt(semanticEvents.sequence, afterSequence)))
    .orderBy(asc(semanticEvents.sequence))
    .all()
    .map(rowToEvent);
}

/** Highest sequence assigned for a run so far, or -1 if none — the worker's monotonic counter seed. */
export function maxSemanticEventSequence(db: DrizzleDb, runId: string): number {
  const rows = db
    .select()
    .from(semanticEvents)
    .where(eq(semanticEvents.runId, runId))
    .orderBy(asc(semanticEvents.sequence))
    .all();
  const last = rows[rows.length - 1];
  return last ? last.sequence : -1;
}
