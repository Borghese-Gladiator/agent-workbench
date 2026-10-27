import type { TaskSummaryWithRepository } from './tasks.js';

/**
 * A cross-task rollup over `task_summary` (TASK-121).
 *
 * `task_summary` already answers "how did THIS task go". Nothing answered "how did that batch of
 * tasks go" — so after driving N tickets in one dogfooding run, an operator had to open each task
 * individually to find out what the run actually produced. This is the missing aggregate.
 *
 * Pure: it takes rows the caller already selected and returns the summary. Which tasks form a
 * "batch" is the caller's decision (a time window, one repository, one retry/DAG root), and keeping
 * that out of here is what lets the same rollup serve every one of those groupings.
 */
export interface BatchRollup {
  taskCount: number;
  /** Counts keyed by `derivedStatus`, the same vocabulary the task list and board use. */
  byStatus: Record<string, number>;
  /** Tasks that opened a pull request, and the URLs, so the batch links straight to its output. */
  pullRequests: { taskId: string; title: string | null; url: string }[];
  /**
   * Tasks a human should look at: one that stopped on an unmet criterion, or that ended in a
   * non-successful terminal state. This is the batch's actual worklist.
   */
  needsAttention: { taskId: string; title: string | null; reason: string }[];
  /** Findings still open across the whole batch. */
  openFindingCount: number;
  totals: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** The window the batch actually spans, from the rows themselves. Null when the batch is empty. */
  window: { from: string; to: string } | null;
}

/** Terminal conditions that are NOT a clean finish, and what to call each on the worklist. */
const UNSUCCESSFUL_CONDITIONS: Record<string, string> = {
  failed: 'ended failed',
  abandoned: 'abandoned — no workflow backs it',
  blocked: 'blocked',
  cancelled: 'cancelled',
};

export function summarizeTaskBatch(rows: TaskSummaryWithRepository[]): BatchRollup {
  const rollup: BatchRollup = {
    taskCount: rows.length,
    byStatus: {},
    pullRequests: [],
    needsAttention: [],
    openFindingCount: 0,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: null },
    window: null,
  };

  let costSeen = false;
  let cost = 0;

  for (const row of rows) {
    rollup.byStatus[row.derivedStatus] = (rollup.byStatus[row.derivedStatus] ?? 0) + 1;
    rollup.openFindingCount += row.openFindingCount;
    rollup.totals.inputTokens += row.inputTokens;
    rollup.totals.outputTokens += row.outputTokens;
    // `costUsd` stays null for a batch where NO task recorded a cost, so an empty rollup reads as
    // "not measured" rather than as a confident $0.00.
    if (row.costUsd !== null) {
      costSeen = true;
      cost += row.costUsd;
    }

    if (row.pullRequestUrl) {
      rollup.pullRequests.push({ taskId: row.taskId, title: row.title, url: row.pullRequestUrl });
    }

    const reason = row.pendingGateReason
      ? `unmet: ${row.pendingGateReason}`
      : UNSUCCESSFUL_CONDITIONS[row.condition];
    if (reason) {
      rollup.needsAttention.push({ taskId: row.taskId, title: row.title, reason });
    }

    const at = row.updatedAt;
    if (!rollup.window) rollup.window = { from: at, to: at };
    else {
      if (at < rollup.window.from) rollup.window.from = at;
      if (at > rollup.window.to) rollup.window.to = at;
    }
  }

  if (costSeen) rollup.totals.costUsd = cost;
  return rollup;
}
