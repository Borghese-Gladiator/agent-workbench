import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase, DrizzleDb } from '@awb/database';
import {
  listPhaseAttempts,
  listAgentSessions,
  listModelInvocations,
  getContextComposition,
  type AgentSessionRow,
  type ModelInvocationRow,
  type PhaseAttemptRow,
  type ContextCompositionRow,
} from '@awb/database';

export interface ModelInvocationNode extends ModelInvocationRow {}

export interface AgentSessionNode extends AgentSessionRow {
  invocations: ModelInvocationNode[];
  contextComposition: ContextCompositionRow | null;
}

export interface PhaseAttemptNode extends PhaseAttemptRow {
  sessions: AgentSessionNode[];
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
  const phaseAttempts: PhaseAttemptNode[] = listPhaseAttempts(db, taskId).map((attempt) => {
    const sessions: AgentSessionNode[] = listAgentSessions(db, attempt.id).map((session) => ({
      ...session,
      invocations: listModelInvocations(db, session.id),
      contextComposition: getContextComposition(db, session.id) ?? null,
    }));
    return { ...attempt, sessions };
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
