import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase, DrizzleDb } from '@awb/database';
import {
  listPhaseAttempts,
  listAgentSessions,
  listModelInvocations,
  getSessionContextComposition,
  getRuntimeAttributionByAttempt,
  durationMs,
  type AgentSessionRow,
  type ModelInvocationRow,
  type PhaseAttemptRow,
  type ContextCompositionRow,
  type RuntimeAttributionRow,
} from '@awb/database';

export interface ModelInvocationNode extends ModelInvocationRow {}

export interface AgentSessionNode extends AgentSessionRow {
  invocations: ModelInvocationNode[];
  contextComposition: ContextCompositionRow | null;
  /** Measured session duration, or null while the session has no end. */
  durationMs: number | null;
}

export interface PhaseAttemptNode extends PhaseAttemptRow {
  sessions: AgentSessionNode[];
  /**
   * Where this attempt's wall-clock went, by category. Joined in so one call answers "which phase
   * took the time, and inside it was it the model, the tests, or the QA" — the tree used to omit it
   * and a reader had to know to query `runtime_attribution` separately.
   */
  runtimeAttribution: RuntimeAttributionRow | null;
  /** Attempt duration, or null while the attempt is still open. */
  durationMs: number | null;
}

export interface ExecutionTreeResponse {
  taskId: string;
  phaseAttempts: PhaseAttemptNode[];
}

/**
 * Assembles the nested Phase Attempt → Agent Session → Model Invocation tree for one task from the
 * three level readers plus per-session context-composition. Pure read: it never fans out to Temporal.
 */
export function buildExecutionTree(db: DrizzleDb, taskId: string): ExecutionTreeResponse {
  const attribution = getRuntimeAttributionByAttempt(db, taskId);
  const phaseAttempts: PhaseAttemptNode[] = listPhaseAttempts(db, taskId).map((attempt) => {
    const sessions: AgentSessionNode[] = listAgentSessions(db, attempt.id).map((session) => ({
      ...session,
      invocations: listModelInvocations(db, session.id),
      contextComposition: getSessionContextComposition(db, session.id) ?? null,
      durationMs: durationMs(session.startedAt, session.endedAt),
    }));
    return {
      ...attempt,
      sessions,
      runtimeAttribution: attribution.get(attempt.id) ?? null,
      durationMs: durationMs(attempt.startedAt, attempt.endedAt),
    };
  });
  return { taskId, phaseAttempts };
}

/** Wires GET /api/tasks/:repositoryId/:taskId/execution-tree — the single execution-tree route. */
export function registerExecutionTreeRoute(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.get<{ Params: { repositoryId: string; taskId: string } }>(
    '/api/tasks/:repositoryId/:taskId/execution-tree',
    async (request) => buildExecutionTree(database.db, request.params.taskId),
  );
}
