import { eq } from 'drizzle-orm';
import type { PhaseObservability, TokenBreakdown, PhaseTokenSpend, TokenSpendByPhase, TaskPhase } from '@awb/domain';
import {
  agentSessions,
  modelInvocations,
  runtimeAttribution,
  contextComposition,
} from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import { ensureRunAndPhaseAttempt } from './tasks.js';

/**
 * Persists a phase attempt's observability: agent_sessions + their
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
          cacheCreationInputTokens: inv.cacheCreationInputTokens ?? null,
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
 * By-model token/cost rollup for a task — the finer breakdown `task show` reports beyond
 * the flat total. Joins model_invocations through agent_sessions to the task.
 */
export function getTokenBreakdown(db: DrizzleDb, taskId: string): TokenBreakdown {
  const rows = db
    .select({
      model: modelInvocations.model,
      inputTokens: modelInvocations.inputTokens,
      outputTokens: modelInvocations.outputTokens,
      cachedInputTokens: modelInvocations.cachedInputTokens,
      cacheCreationInputTokens: modelInvocations.cacheCreationInputTokens,
      costUsd: modelInvocations.costUsd,
    })
    .from(modelInvocations)
    .innerJoin(agentSessions, eq(agentSessions.id, modelInvocations.agentSessionId))
    .where(eq(agentSessions.taskId, taskId))
    .all();

  const byModel: TokenBreakdown['byModel'] = {};
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
  };
  for (const r of rows) {
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cachedInputTokens += r.cachedInputTokens ?? 0;
    totals.cacheCreationInputTokens += r.cacheCreationInputTokens ?? 0;
    totals.costUsd += r.costUsd ?? 0;
    const m = (byModel[r.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: 0,
    });
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.cachedInputTokens += r.cachedInputTokens ?? 0;
    m.cacheCreationInputTokens += r.cacheCreationInputTokens ?? 0;
    m.costUsd += r.costUsd ?? 0;
  }
  return { totals, byModel };
}

/**
 * Per-phase token spend for a task (TASK-79). Joins model_invocations → agent_sessions for the
 * cache split (fresh / cache-read / cache-write / output / cost) grouped by phase, and
 * context_composition → agent_sessions for the static-vs-injected context split. The two sources are
 * aggregated separately (never cross-joined) so a phase with multiple invocations and one context row
 * — or vice versa — is never double-counted. Rows are ranked by total spend (fresh + cache) descending
 * so the top-offender phases surface first. `static` = the fixed instruction/prompt scaffolding;
 * `injected` = task-specific context (contract/plan/diff/evidence/findings/repo-map/memory).
 */
export function getTokenSpendByPhase(db: DrizzleDb, taskId: string): TokenSpendByPhase {
  const emptyRow = (phase: string): PhaseTokenSpend => ({
    phase,
    freshInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    staticContextTokens: 0,
    injectedContextTokens: 0,
  });

  const byPhase = new Map<string, PhaseTokenSpend>();
  const rowFor = (phase: string): PhaseTokenSpend => {
    let row = byPhase.get(phase);
    if (!row) {
      row = emptyRow(phase);
      byPhase.set(phase, row);
    }
    return row;
  };

  const invRows = db
    .select({
      phase: agentSessions.phase,
      inputTokens: modelInvocations.inputTokens,
      outputTokens: modelInvocations.outputTokens,
      cachedInputTokens: modelInvocations.cachedInputTokens,
      cacheCreationInputTokens: modelInvocations.cacheCreationInputTokens,
      costUsd: modelInvocations.costUsd,
    })
    .from(modelInvocations)
    .innerJoin(agentSessions, eq(agentSessions.id, modelInvocations.agentSessionId))
    .where(eq(agentSessions.taskId, taskId))
    .all();

  for (const r of invRows) {
    const row = rowFor(r.phase);
    row.freshInputTokens += r.inputTokens;
    row.cacheReadTokens += r.cachedInputTokens ?? 0;
    row.cacheCreationTokens += r.cacheCreationInputTokens ?? 0;
    row.outputTokens += r.outputTokens;
    row.costUsd += r.costUsd ?? 0;
  }

  const ccRows = db
    .select({
      phase: contextComposition.phase,
      contractTokens: contextComposition.contractTokens,
      planTokens: contextComposition.planTokens,
      diffTokens: contextComposition.diffTokens,
      evidenceTokens: contextComposition.evidenceTokens,
      findingsTokens: contextComposition.findingsTokens,
      repositoryMapTokens: contextComposition.repositoryMapTokens,
      memoryTokens: contextComposition.memoryTokens,
      instructionTokens: contextComposition.instructionTokens,
    })
    .from(contextComposition)
    .where(eq(contextComposition.taskId, taskId))
    .all();

  for (const r of ccRows) {
    const row = rowFor(r.phase);
    row.staticContextTokens += r.instructionTokens;
    row.injectedContextTokens +=
      r.contractTokens +
      r.planTokens +
      r.diffTokens +
      r.evidenceTokens +
      r.findingsTokens +
      r.repositoryMapTokens +
      r.memoryTokens;
  }

  const rows = [...byPhase.values()].sort(
    (a, b) =>
      b.freshInputTokens + b.cacheReadTokens + b.cacheCreationTokens -
      (a.freshInputTokens + a.cacheReadTokens + a.cacheCreationTokens),
  );

  const totals = rows.reduce((acc, r) => {
    acc.freshInputTokens += r.freshInputTokens;
    acc.cacheReadTokens += r.cacheReadTokens;
    acc.cacheCreationTokens += r.cacheCreationTokens;
    acc.outputTokens += r.outputTokens;
    acc.costUsd += r.costUsd;
    acc.staticContextTokens += r.staticContextTokens;
    acc.injectedContextTokens += r.injectedContextTokens;
    return acc;
  }, emptyRow('(totals)'));

  return { byPhase: rows, totals };
}

export function getRuntimeAttribution(db: DrizzleDb, taskId: string) {
  return db.select().from(runtimeAttribution).where(eq(runtimeAttribution.taskId, taskId)).all();
}

/**
 * Reconstructs the builder's per-slice resume tokens for a task from the persisted `agent_sessions`
 * rows. The implement phase writes one session per slice with id
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
