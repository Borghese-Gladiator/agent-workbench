import { and, eq, inArray } from 'drizzle-orm';
import type {
  ContextComposition,
  PhaseObservability,
  PhaseTokenSpend,
  TaskPhase,
  TokenBreakdown,
  TokenSpendByPhase,
} from '@awb/domain';
import {
  agentSessions,
  modelInvocations,
  runtimeAttribution,
  contextComposition,
  tasks,
  phaseAttempts,
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
        const { estimated, ...ccBuckets } = session.contextComposition;
        const ccRow = {
          id: session.id,
          taskId: session.taskId,
          agentSessionId: session.id,
          phase: session.phase,
          role: session.role,
          ...ccBuckets,
          estimated: estimated ? 1 : 0,
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

/** One rollup row: tokens summed by repo/task/model/phase/outcome, with the task's retry-lineage parent. */
export interface CrossRepoTokenAggregate {
  repositoryId: string;
  taskId: string;
  model: string;
  phase: string;
  outcome: string;
  /** The task's lineage edge (`tasks.parent_task_id`) — the task this one was stacked on / retried from. */
  retryOfTaskId: string | null;
  sessions: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CrossRepoTokenReport {
  rows: CrossRepoTokenAggregate[];
  totals: { tokensIn: number; tokensOut: number; sessions: number };
}

/**
 * Cross-repo/cross-task token report. Joins model_invocations → agent_sessions → tasks (for the repo
 * and the retry-lineage parent) → phase_attempts (for the attempt outcome), then rolls up by
 * repo/task/model/phase/outcome. Distinct agent_sessions are counted per bucket. Optional filter
 * restricts to a set of repos and/or tasks; omit it to report across everything.
 */
export function getCrossRepoTokenReport(
  db: DrizzleDb,
  filter?: { repositoryIds?: string[]; taskIds?: string[] },
): CrossRepoTokenReport {
  const conditions: ReturnType<typeof inArray>[] = [];
  if (filter?.repositoryIds && filter.repositoryIds.length > 0) {
    conditions.push(inArray(tasks.repositoryId, filter.repositoryIds));
  }
  if (filter?.taskIds && filter.taskIds.length > 0) {
    conditions.push(inArray(agentSessions.taskId, filter.taskIds));
  }

  const rows = db
    .select({
      repositoryId: tasks.repositoryId,
      taskId: agentSessions.taskId,
      parentTaskId: tasks.parentTaskId,
      phase: agentSessions.phase,
      outcome: phaseAttempts.outcome,
      sessionId: agentSessions.id,
      model: modelInvocations.model,
      inputTokens: modelInvocations.inputTokens,
      outputTokens: modelInvocations.outputTokens,
      cachedInputTokens: modelInvocations.cachedInputTokens,
      cacheCreationInputTokens: modelInvocations.cacheCreationInputTokens,
    })
    .from(modelInvocations)
    .innerJoin(agentSessions, eq(agentSessions.id, modelInvocations.agentSessionId))
    .innerJoin(tasks, eq(tasks.id, agentSessions.taskId))
    .leftJoin(phaseAttempts, eq(phaseAttempts.id, agentSessions.phaseAttemptId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();

  const byKey = new Map<string, CrossRepoTokenAggregate>();
  const sessionsSeen = new Map<string, Set<string>>();
  const totals = { tokensIn: 0, tokensOut: 0, sessions: 0 };
  const totalSessions = new Set<string>();

  for (const r of rows) {
    const outcome = r.outcome ?? 'unknown';
    const key = `${r.repositoryId}\0${r.taskId}\0${r.model}\0${r.phase}\0${outcome}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = {
        repositoryId: r.repositoryId,
        taskId: r.taskId,
        model: r.model,
        phase: r.phase,
        outcome,
        retryOfTaskId: r.parentTaskId,
        sessions: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      byKey.set(key, agg);
      sessionsSeen.set(key, new Set());
    }
    agg.tokensIn += r.inputTokens;
    agg.tokensOut += r.outputTokens;
    agg.cacheReadTokens += r.cachedInputTokens ?? 0;
    agg.cacheWriteTokens += r.cacheCreationInputTokens ?? 0;
    const seen = sessionsSeen.get(key)!;
    if (!seen.has(r.sessionId)) {
      seen.add(r.sessionId);
      agg.sessions += 1;
    }
    totals.tokensIn += r.inputTokens;
    totals.tokensOut += r.outputTokens;
    totalSessions.add(r.sessionId);
  }

  totals.sessions = totalSessions.size;
  const collator = new Intl.Collator();
  const sorted = [...byKey.values()].sort(
    (a, b) =>
      collator.compare(a.repositoryId, b.repositoryId) ||
      collator.compare(a.taskId, b.taskId) ||
      collator.compare(a.model, b.model) ||
      collator.compare(a.phase, b.phase) ||
      collator.compare(a.outcome, b.outcome),
  );
  return { rows: sorted, totals };
}

/**
 * Per-session context-composition for a task, with the `estimated` provenance flag surfaced as a
 * boolean (SQLite stores 1/0). Lets a Usage view distinguish buckets reconciled to measured input
 * tokens (`estimated: false`) from an unmeasured chars/4 guess (`estimated: true`).
 */
export function getContextComposition(
  db: DrizzleDb,
  taskId: string,
): Array<ContextComposition & { agentSessionId: string; phase: TaskPhase; role: string }> {
  const rows = db.select().from(contextComposition).where(eq(contextComposition.taskId, taskId)).all();
  return rows.map((r) => ({
    contractTokens: r.contractTokens,
    planTokens: r.planTokens,
    diffTokens: r.diffTokens,
    evidenceTokens: r.evidenceTokens,
    findingsTokens: r.findingsTokens,
    repositoryMapTokens: r.repositoryMapTokens,
    memoryTokens: r.memoryTokens,
    instructionTokens: r.instructionTokens,
    estimated: r.estimated === 1,
    agentSessionId: r.agentSessionId,
    phase: r.phase,
    role: r.role,
  }));
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
