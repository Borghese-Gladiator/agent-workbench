import { describe, expect, it } from 'vitest';
import { summarizeTaskBatch } from './batch-rollup.js';
import type { TaskSummaryWithRepository } from './tasks.js';

function row(overrides: Partial<TaskSummaryWithRepository> = {}): TaskSummaryWithRepository {
  return {
    taskId: 'task-1',
    repositoryId: 'repo-1',
    repositoryName: 'repo',
    prompt: 'do the thing',
    title: 'Do the thing',
    retryOfTaskId: null,
    rootTaskId: 'task-1',
    phase: 'release',
    condition: 'completed',
    deliveryState: 'draft-pr-open',
    size: 'M',
    derivedStatus: 'completed',
    attemptCount: 1,
    openFindingCount: 0,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.5,
    pendingGateReason: null,
    candidateSha: 'abc123',
    pullRequestUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T01:00:00.000Z',
    indexedAt: '2026-09-01T01:00:00.000Z',
    ...overrides,
  };
}

// TASK-121: `task_summary` answered "how did THIS task go". Nothing answered "how did that batch
// go", so after driving N tickets an operator opened each task individually to find out.
describe('summarizeTaskBatch (TASK-121)', () => {
  it('counts terminal states, sums tokens and cost, and spans the real window', () => {
    const rollup = summarizeTaskBatch([
      row({ taskId: 'a', derivedStatus: 'completed', updatedAt: '2026-09-01T01:00:00.000Z' }),
      row({ taskId: 'b', derivedStatus: 'completed', updatedAt: '2026-09-01T05:00:00.000Z' }),
      row({ taskId: 'c', derivedStatus: 'failed', condition: 'failed', updatedAt: '2026-09-01T03:00:00.000Z' }),
    ]);

    expect(rollup.taskCount).toBe(3);
    expect(rollup.byStatus).toEqual({ completed: 2, failed: 1 });
    expect(rollup.totals).toEqual({ inputTokens: 300, outputTokens: 60, costUsd: 1.5 });
    // The window comes from the rows themselves, not from the caller's filter.
    expect(rollup.window).toEqual({ from: '2026-09-01T01:00:00.000Z', to: '2026-09-01T05:00:00.000Z' });
  });

  it('lists every pull request the batch opened', () => {
    const rollup = summarizeTaskBatch([
      row({ taskId: 'a', pullRequestUrl: 'https://github.com/o/r/pull/1' }),
      row({ taskId: 'b', pullRequestUrl: null }),
    ]);
    expect(rollup.pullRequests).toEqual([{ taskId: 'a', title: 'Do the thing', url: 'https://github.com/o/r/pull/1' }]);
  });

  // The worklist is the point of the rollup: which of these N tasks does a human have to open.
  it.each([
    { label: 'an unmet criterion', patch: { pendingGateReason: 'qa-inconclusive' as const }, reason: 'unmet: qa-inconclusive' },
    { label: 'a failed run', patch: { condition: 'failed' as const }, reason: 'ended failed' },
    { label: 'an abandoned run', patch: { condition: 'abandoned' as const }, reason: 'abandoned — no workflow backs it' },
    { label: 'a cancelled run', patch: { condition: 'cancelled' as const }, reason: 'cancelled' },
  ])('flags $label as needing attention', ({ patch, reason }) => {
    const rollup = summarizeTaskBatch([row({ taskId: 'x', ...patch })]);
    expect(rollup.needsAttention).toEqual([{ taskId: 'x', title: 'Do the thing', reason }]);
  });

  it('leaves a clean completed task off the worklist', () => {
    expect(summarizeTaskBatch([row()]).needsAttention).toEqual([]);
  });

  // A batch where nothing recorded a cost must read as "not measured", never as a confident $0.00.
  it('reports a null cost when no task recorded one', () => {
    const rollup = summarizeTaskBatch([row({ costUsd: null }), row({ taskId: 'b', costUsd: null })]);
    expect(rollup.totals.costUsd).toBeNull();
    expect(rollup.totals.inputTokens).toBe(200);
  });

  it('sums only the tasks that did record a cost', () => {
    const rollup = summarizeTaskBatch([row({ costUsd: null }), row({ taskId: 'b', costUsd: 0.25 })]);
    expect(rollup.totals.costUsd).toBe(0.25);
  });

  it('returns an empty rollup with a null window for an empty batch', () => {
    expect(summarizeTaskBatch([])).toEqual({
      taskCount: 0,
      byStatus: {},
      pullRequests: [],
      needsAttention: [],
      openFindingCount: 0,
      totals: { inputTokens: 0, outputTokens: 0, costUsd: null },
      window: null,
    });
  });

  it('totals open findings across the batch', () => {
    const rollup = summarizeTaskBatch([row({ openFindingCount: 2 }), row({ taskId: 'b', openFindingCount: 3 })]);
    expect(rollup.openFindingCount).toBe(5);
  });
});
