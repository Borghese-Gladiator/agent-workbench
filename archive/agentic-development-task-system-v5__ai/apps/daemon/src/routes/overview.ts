import type { FastifyInstance } from 'fastify';
import type { WorkbenchDatabase, DrizzleDb, TaskSummaryWithRepository } from '@awb/database';
import { listTaskSummaries } from '@awb/database';
import { ATTENTION_STATUSES, type DerivedTaskStatus } from '@awb/domain';

export interface OverviewActivityItem {
  taskId: string;
  repositoryId: string;
  repositoryName: string | null;
  title: string | null;
  derivedStatus: string;
  at: string;
}

export interface OverviewResponse {
  factoryHealth: {
    total: number;
    running: number;
    awaitingHuman: number;
    blocked: number;
    failed: number;
    completed: number;
  };
  needsAttention: TaskSummaryWithRepository[];
  currentState: Record<string, number>;
  recentActivity: OverviewActivityItem[];
}

const RECENT_ACTIVITY_LIMIT = 20;

/**
 * Composes the durable Overview payload entirely from the task_summary projection: factory-health
 * counts, the needs-attention set (ATTENTION_STATUSES), per-derived-status counts, and a recent-activity
 * feed ordered by last index time. Deliberately no Temporal fan-out — Overview must stay responsive.
 */
export function buildOverview(db: DrizzleDb): OverviewResponse {
  const summaries = listTaskSummaries(db);

  const currentState: Record<string, number> = {};
  const factoryHealth = { total: 0, running: 0, awaitingHuman: 0, blocked: 0, failed: 0, completed: 0 };
  const needsAttention: TaskSummaryWithRepository[] = [];

  for (const s of summaries) {
    factoryHealth.total += 1;
    currentState[s.derivedStatus] = (currentState[s.derivedStatus] ?? 0) + 1;
    switch (s.derivedStatus) {
      case 'running':
      case 'planning':
      case 'queued':
        factoryHealth.running += 1;
        break;
      case 'awaiting-human':
        factoryHealth.awaitingHuman += 1;
        break;
      case 'blocked':
        factoryHealth.blocked += 1;
        break;
      case 'failed':
        factoryHealth.failed += 1;
        break;
      case 'completed':
        factoryHealth.completed += 1;
        break;
      default:
        break;
    }
    if (ATTENTION_STATUSES.has(s.derivedStatus as DerivedTaskStatus)) needsAttention.push(s);
  }

  const recentActivity: OverviewActivityItem[] = [...summaries]
    .sort((a, b) => b.indexedAt.localeCompare(a.indexedAt))
    .slice(0, RECENT_ACTIVITY_LIMIT)
    .map((s) => ({
      taskId: s.taskId,
      repositoryId: s.repositoryId,
      repositoryName: s.repositoryName,
      title: s.title,
      derivedStatus: s.derivedStatus,
      at: s.indexedAt,
    }));

  return { factoryHealth, needsAttention, currentState, recentActivity };
}

/** Wires GET /api/overview returning the durable OverviewResponse (no Temporal fan-out). */
export function registerOverviewRoute(app: FastifyInstance, database: WorkbenchDatabase): void {
  app.get('/api/overview', async () => buildOverview(database.db));
}
