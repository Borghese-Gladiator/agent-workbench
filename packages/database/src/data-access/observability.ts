import { eq } from 'drizzle-orm';
import type { PhaseObservability, TokenBreakdown } from '@awb/domain';
import {
  agentSessions,
  modelInvocations,
  runtimeAttribution,
  contextComposition,
} from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import { ensureRunAndPhaseAttempt } from './tasks.js';

/**
 * Persists a phase attempt's observability (spec §27, TASK-22): agent_sessions + their
 * model_invocations, the per-attempt runtime-attribution buckets, and per-session context-composition
 * buckets. Written only by the daemon (single writer). Idempotent per id so a phase re-run overwrites
 * rather than duplicates.
 */
export function persistPhaseObservability(db: DrizzleDb, payload: PhaseObservability): void {
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const txDb = tx as unknown as DrizzleDb;
    ensureRunAndPhaseAttempt(txDb, {
      runId: payload.runId,
      phaseAttemptId: payload.phaseAttemptId,
      phase: payload.phase,
    });

    // Runtime attribution — one row per phase attempt (unique index enforces it).
    const raRow = {
      id: payload.phaseAttemptId,
      taskId: payload.taskId,
      runId: payload.runId,
      phaseAttemptId: payload.phaseAttemptId,
      phase: payload.phase,
      ...payload.runtimeAttribution,
      createdAt: now,
    };
    tx.insert(runtimeAttribution)
      .values(raRow)
      .onConflictDoUpdate({ target: runtimeAttribution.phaseAttemptId, set: raRow })
      .run();

    for (const session of payload.sessions) {
      const sessionRow = {
        id: session.id,
        taskId: session.taskId,
        runId: session.runId,
        phaseAttemptId: session.phaseAttemptId,
        phase: session.phase,
        runtime: session.runtime,
        model: session.model ?? null,
        resumeSessionId: session.resumeSessionId ?? null,
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? null,
      };
      tx.insert(agentSessions).values(sessionRow).onConflictDoUpdate({ target: agentSessions.id, set: sessionRow }).run();

      for (const inv of session.modelInvocations) {
        const invRow = {
          id: inv.id,
          agentSessionId: session.id,
          provider: inv.provider,
          model: inv.model,
          inputTokens: inv.inputTokens,
          outputTokens: inv.outputTokens,
          cachedInputTokens: inv.cachedInputTokens ?? null,
          costUsd: inv.costUsd ?? null,
          startedAt: inv.startedAt,
          endedAt: inv.endedAt ?? null,
        };
        tx.insert(modelInvocations).values(invRow).onConflictDoUpdate({ target: modelInvocations.id, set: invRow }).run();
      }

      if (session.contextComposition) {
        const ccRow = {
          id: session.id,
          taskId: session.taskId,
          agentSessionId: session.id,
          phase: session.phase,
          role: session.role,
          ...session.contextComposition,
          createdAt: now,
        };
        tx.insert(contextComposition)
          .values(ccRow)
          .onConflictDoUpdate({ target: contextComposition.agentSessionId, set: ccRow })
          .run();
      }
    }
  });
}

/**
 * By-model token/cost rollup for a task (spec §27 — the finer breakdown `task show` reports beyond
 * the flat total). Joins model_invocations through agent_sessions to the task.
 */
export function getTokenBreakdown(db: DrizzleDb, taskId: string): TokenBreakdown {
  const rows = db
    .select({
      model: modelInvocations.model,
      inputTokens: modelInvocations.inputTokens,
      outputTokens: modelInvocations.outputTokens,
      cachedInputTokens: modelInvocations.cachedInputTokens,
      costUsd: modelInvocations.costUsd,
    })
    .from(modelInvocations)
    .innerJoin(agentSessions, eq(agentSessions.id, modelInvocations.agentSessionId))
    .where(eq(agentSessions.taskId, taskId))
    .all();

  const byModel: TokenBreakdown['byModel'] = {};
  const totals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
  for (const r of rows) {
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cachedInputTokens += r.cachedInputTokens ?? 0;
    totals.costUsd += r.costUsd ?? 0;
    const m = (byModel[r.model] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.costUsd += r.costUsd ?? 0;
  }
  return { totals, byModel };
}

export function getRuntimeAttribution(db: DrizzleDb, taskId: string) {
  return db.select().from(runtimeAttribution).where(eq(runtimeAttribution.taskId, taskId)).all();
}

/**
 * Reconstructs the builder's per-slice resume tokens for a task from the persisted `agent_sessions`
 * rows (TASK-32). The implement phase writes one session per slice with id
 * `${taskId}-implement-${attempt}-${sliceId}` and its `resume_session_id`; this parses the slice id
 * back out (the id is opaque otherwise) and keeps the latest non-null token per slice, so a worker
 * restart resumes each slice's transcript. Returns undefined when no resume tokens are persisted.
 */
export function getBuilderResumeSessions(db: DrizzleDb, taskId: string): Record<string, string> | undefined {
  const rows = db
    .select({
      id: agentSessions.id,
      resumeSessionId: agentSessions.resumeSessionId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.taskId, taskId))
    .all();

  const implementPrefix = `${taskId}-implement-`;
  const bySlice: Record<string, string> = {};
  const bestAttempt: Record<string, number> = {};
  for (const row of rows) {
    if (!row.resumeSessionId || !row.id.startsWith(implementPrefix)) continue;
    // id === `${taskId}-implement-${attempt}-${sliceId}` — the attempt is the first segment, the
    // sliceId is everything after it. Keep the highest-attempt token per slice so the most recent
    // resume wins (row order from the DB is unspecified; compare attempt numbers, not string order).
    const suffix = row.id.slice(implementPrefix.length);
    const firstDash = suffix.indexOf('-');
    if (firstDash < 0) continue;
    const attempt = Number.parseInt(suffix.slice(0, firstDash), 10);
    const sliceId = suffix.slice(firstDash + 1);
    if (!sliceId || !Number.isFinite(attempt)) continue;
    if (bestAttempt[sliceId] === undefined || attempt >= bestAttempt[sliceId]) {
      bestAttempt[sliceId] = attempt;
      bySlice[sliceId] = row.resumeSessionId;
    }
  }
  return Object.keys(bySlice).length > 0 ? bySlice : undefined;
}
