import { and, asc, eq, inArray } from 'drizzle-orm';
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
  evidence,
  artifacts,
} from '../schema/index.js';
import type { DrizzleDb } from '../connection.js';
import type {
  PhaseAttemptRow,
  AgentSessionRow,
  ModelInvocationRow,
  ContextCompositionRow,
  RuntimeAttributionRow,
} from '../row-types.js';
import { ensureRunAndPhaseAttempt, refreshTaskSummary } from './tasks.js';

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

    // Close the phase attempt (TASK-124). `ended_at`/`outcome` are the whole point of the row for a
    // reader; they were never written before. `started_at` is only overwritten when the caller
    // supplies an EARLIER one, so a re-persist of the same attempt cannot push the start forward.
    if (payload.startedAt !== undefined || payload.endedAt !== undefined || payload.outcome !== undefined) {
      const existing = tx
        .select({ startedAt: phaseAttempts.startedAt })
        .from(phaseAttempts)
        .where(eq(phaseAttempts.id, payload.phaseAttemptId))
        .all()[0];
      const set: Partial<typeof phaseAttempts.$inferInsert> = {};
      if (payload.startedAt !== undefined && (!existing || payload.startedAt < existing.startedAt)) {
        set.startedAt = payload.startedAt;
      }
      if (payload.endedAt !== undefined) set.endedAt = payload.endedAt;
      if (payload.outcome !== undefined) set.outcome = payload.outcome;
      if (Object.keys(set).length > 0) {
        tx.update(phaseAttempts).set(set).where(eq(phaseAttempts.id, payload.phaseAttemptId)).run();
      }
    }

    // Refresh the durable projection inside the same tx so the task summary never lags a token write.
    refreshTaskSummary(txDb, payload.taskId);
  });
}

/**
 * Execution-tree level 1: the phase attempts for a task, ordered phase then attempt number, each
 * carrying its `retryOf` back-pointer. Feeds the Task Detail execution tree + Usage & Time.
 */
export function listPhaseAttempts(db: DrizzleDb, taskId: string): PhaseAttemptRow[] {
  return db
    .select()
    .from(phaseAttempts)
    .where(eq(phaseAttempts.taskId, taskId))
    .orderBy(asc(phaseAttempts.phase), asc(phaseAttempts.attemptNumber))
    .all();
}

/** Execution-tree level 2: the agent sessions under a phase attempt, ordered by start time. */
export function listAgentSessions(db: DrizzleDb, phaseAttemptId: string): AgentSessionRow[] {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.phaseAttemptId, phaseAttemptId))
    .orderBy(asc(agentSessions.startedAt))
    .all();
}

/** Execution-tree leaf: the model invocations under an agent session, ordered by start time. */
export function listModelInvocations(db: DrizzleDb, agentSessionId: string): ModelInvocationRow[] {
  return db
    .select()
    .from(modelInvocations)
    .where(eq(modelInvocations.agentSessionId, agentSessionId))
    .orderBy(asc(modelInvocations.startedAt))
    .all();
}

/** Per-session context-composition buckets for the Usage & Time section. Undefined when none recorded. */
export function getSessionContextComposition(
  db: DrizzleDb,
  agentSessionId: string,
): ContextCompositionRow | undefined {
  return db
    .select()
    .from(contextComposition)
    .where(eq(contextComposition.agentSessionId, agentSessionId))
    .all()[0];
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
 * Runtime attribution for a task keyed by phase attempt. The execution tree joins this per attempt so
 * one call answers "which phase took the time, and inside it was it the model, the tests, or the QA"
 * — previously the caller had to know to query a table the tree never mentioned.
 */
export function getRuntimeAttributionByAttempt(
  db: DrizzleDb,
  taskId: string,
): Map<string, RuntimeAttributionRow> {
  const rows = db.select().from(runtimeAttribution).where(eq(runtimeAttribution.taskId, taskId)).all();
  return new Map(rows.map((r) => [r.phaseAttemptId, r]));
}

/** Elapsed ms between two ISO timestamps, or null when either is missing or unparsable. */
export function durationMs(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
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

/** The QA evidence kinds — the proof a QA run actually executed, as opposed to a test or build. */
const QA_EVIDENCE_KINDS = new Set(['qa-video', 'browser-trace', 'terminal-recording', 'screenshot']);

/** One agent session inside a phase attempt, with its real measured duration. */
export interface TimelineSession {
  id: string;
  role: string;
  runtime: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

/** One evidence row, reduced to what a timeline reader needs. */
export interface TimelineEvidence {
  id: string;
  kind: string;
  status: string;
  summary: string;
}

export interface TimelineArtifact {
  id: string;
  kind: string;
  mediaType: string;
  byteSize: number;
}

/** One phase attempt: how long it took, how it ended, where the time went, and what it produced. */
export interface TimelinePhase {
  phaseAttemptId: string;
  phase: string;
  attemptNumber: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: string | null;
  retryOf: string | null;
  runtimeAttribution: RuntimeAttributionRow | null;
  sessions: TimelineSession[];
  /** QA evidence only (video / trace / recording / screenshot) — "which QA ran". */
  qa: TimelineEvidence[];
  /** Every other evidence row produced under this attempt (tests, builds, static checks, review). */
  evidence: TimelineEvidence[];
  artifacts: TimelineArtifact[];
}

export interface TaskTimeline {
  taskId: string;
  phases: TimelinePhase[];
  totals: {
    /** Wall-clock summed over the attempts that closed. Attempts still open contribute nothing. */
    durationMs: number;
    /** How many attempts have no `ended_at` yet — the honest caveat on `durationMs`. */
    openAttempts: number;
    qaExecutionMs: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheCreationInputTokens: number;
    costUsd: number;
  };
  /** The attempt that consumed the most wall-clock, or null when nothing has closed yet. */
  longestPhase: { phase: string; attemptNumber: number; durationMs: number } | null;
}

/**
 * Assembles the post-hoc timeline for one task: every phase attempt in start order with its
 * duration, outcome, runtime-attribution split, sessions, QA, evidence, artifacts, and the task's
 * token/cost total. Pure SQLite read — it never queries Temporal, so it still answers for a task
 * whose Workflow is long gone. This is what `awb task timeline` renders.
 */
export function buildTaskTimeline(db: DrizzleDb, taskId: string): TaskTimeline {
  const attribution = getRuntimeAttributionByAttempt(db, taskId);

  const evidenceRows = db.select().from(evidence).where(eq(evidence.taskId, taskId)).all();
  const artifactRows = db.select().from(artifacts).where(eq(artifacts.taskId, taskId)).all();

  const evidenceByAttempt = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const list = evidenceByAttempt.get(row.phaseAttemptId) ?? [];
    list.push(row);
    evidenceByAttempt.set(row.phaseAttemptId, list);
  }
  const artifactsByAttempt = new Map<string, typeof artifactRows>();
  for (const row of artifactRows) {
    if (!row.phaseAttemptId) continue;
    const list = artifactsByAttempt.get(row.phaseAttemptId) ?? [];
    list.push(row);
    artifactsByAttempt.set(row.phaseAttemptId, list);
  }

  const phases: TimelinePhase[] = listPhaseAttempts(db, taskId)
    .map((attempt) => {
      const attemptEvidence = evidenceByAttempt.get(attempt.id) ?? [];
      return {
        phaseAttemptId: attempt.id,
        phase: attempt.phase,
        attemptNumber: attempt.attemptNumber,
        startedAt: attempt.startedAt,
        endedAt: attempt.endedAt,
        durationMs: durationMs(attempt.startedAt, attempt.endedAt),
        outcome: attempt.outcome,
        retryOf: attempt.retryOf,
        runtimeAttribution: attribution.get(attempt.id) ?? null,
        sessions: listAgentSessions(db, attempt.id).map((session) => ({
          id: session.id,
          role: sessionRole(db, session.id),
          runtime: session.runtime,
          model: session.model,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          durationMs: durationMs(session.startedAt, session.endedAt),
        })),
        qa: attemptEvidence.filter((e) => QA_EVIDENCE_KINDS.has(e.kind)).map(toTimelineEvidence),
        evidence: attemptEvidence.filter((e) => !QA_EVIDENCE_KINDS.has(e.kind)).map(toTimelineEvidence),
        artifacts: (artifactsByAttempt.get(attempt.id) ?? []).map((a) => ({
          id: a.id,
          kind: a.kind,
          mediaType: a.mediaType,
          byteSize: a.byteSize,
        })),
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.phaseAttemptId.localeCompare(b.phaseAttemptId));

  const tokens = getTokenBreakdown(db, taskId);
  let longestPhase: TaskTimeline['longestPhase'] = null;
  let totalDuration = 0;
  let openAttempts = 0;
  let qaExecutionMs = 0;
  for (const phase of phases) {
    qaExecutionMs += phase.runtimeAttribution?.qaExecutionMs ?? 0;
    if (phase.durationMs === null) {
      openAttempts += 1;
      continue;
    }
    totalDuration += phase.durationMs;
    if (!longestPhase || phase.durationMs > longestPhase.durationMs) {
      longestPhase = { phase: phase.phase, attemptNumber: phase.attemptNumber, durationMs: phase.durationMs };
    }
  }

  return {
    taskId,
    phases,
    totals: {
      durationMs: totalDuration,
      openAttempts,
      qaExecutionMs,
      inputTokens: tokens.totals.inputTokens,
      outputTokens: tokens.totals.outputTokens,
      cachedInputTokens: tokens.totals.cachedInputTokens,
      cacheCreationInputTokens: tokens.totals.cacheCreationInputTokens,
      costUsd: tokens.totals.costUsd,
    },
    longestPhase,
  };
}

function toTimelineEvidence(row: { id: string; kind: string; status: string; summary: string }): TimelineEvidence {
  return { id: row.id, kind: row.kind, status: row.status, summary: row.summary };
}

/**
 * The session's role. `agent_sessions` has no role column — the role lives on the per-session
 * context_composition row — so fall back to `unknown` when no context was recorded for it.
 */
function sessionRole(db: DrizzleDb, agentSessionId: string): string {
  return getSessionContextComposition(db, agentSessionId)?.role ?? 'unknown';
}
