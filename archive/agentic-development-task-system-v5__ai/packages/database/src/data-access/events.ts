import { and, eq, gt, asc } from 'drizzle-orm';
import type { SemanticEvent } from '@awb/domain';
import { semanticEvents } from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import type { SemanticEventRow } from '../row-types.js';
import { ensureRunAndPhaseAttempt } from './tasks.js';

/**
 * Semantic-event persistence. The worker's agent sessions emit normalized
 * `SemanticEvent`s; the daemon writes them here (single writer) and serves the reconnect catch-up
 * query keyed on `sequence`. The raw provider stream is never stored — only the compact
 * semantic summary; `payloadJson` holds small structured payloads (e.g. a Finding) only.
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

/**
 * Persists a semantic event and returns it with its authoritative `sequence`. The daemon (single
 * writer) assigns the sequence as `max(sequence for run) + 1` inside the same transaction, so
 * ordering is race-free regardless of how the worker filled the field — the reconnect catch-up
 * depends on a gapless monotonic sequence per run. Idempotent by event id.
 */
export function insertSemanticEvent(db: DrizzleDb, event: SemanticEvent): SemanticEvent {
  return db.transaction((tx) => {
    const txDb = tx as unknown as DrizzleDb;
    ensureRunAndPhaseAttempt(txDb, {
      runId: event.runId,
      phaseAttemptId: event.phaseAttemptId,
      phase: event.phase,
    });
    // Re-persisting the same event id keeps its original sequence (idempotent); a new id gets the next.
    const existing = tx.select().from(semanticEvents).where(eq(semanticEvents.id, event.id)).all()[0];
    const sequence = existing ? existing.sequence : maxSemanticEventSequence(txDb, event.runId) + 1;
    const stored: SemanticEvent = { ...event, sequence };
    const row = eventToRow(stored);
    tx.insert(semanticEvents).values(row).onConflictDoUpdate({ target: semanticEvents.id, set: row }).run();
    return stored;
  });
}

/** Reconnect catch-up: events for a run with sequence > afterSequence, in order. */
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
