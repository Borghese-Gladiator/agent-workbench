import { describe, expect, it } from 'vitest';
import type { FleetTaskRow, BatchRollup } from '@awb/database';
import { formatAge, formatAttempt, renderTable, renderMarkdown, renderRollup } from './fleet.js';

function row(overrides: Partial<FleetTaskRow> = {}): FleetTaskRow {
  return {
    taskId: 'abcd1234-0000-0000-0000-000000000000',
    repositoryId: 'repo-1',
    repositoryName: 'games',
    promptLine: 'Implement President',
    phase: 'implement',
    condition: 'running',
    deliveryState: 'not-started',
    size: 'M',
    attempt: 1,
    bouncedFrom: null,
    lastOutcome: null,
    activity: 'writing engine tests',
    activityType: 'tool',
    activityAgeSec: 125,
    openFindings: 0,
    topFinding: null,
    pr: null,
    parentTaskId: null,
    updatedAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatAge', () => {
  it('renders seconds/minutes/hours/days and a dash for null', () => {
    expect(formatAge(null)).toBe('—');
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(125)).toBe('2m');
    expect(formatAge(7200)).toBe('2h');
    expect(formatAge(172800)).toBe('2d');
  });
});

describe('formatAttempt', () => {
  it('is #N on a clean pass and #N ↩phase after a bounce', () => {
    expect(formatAttempt(row({ attempt: 1, bouncedFrom: null }))).toBe('#1');
    expect(formatAttempt(row({ attempt: 3, bouncedFrom: 'verify' }))).toBe('#3 ↩verify');
  });
});

describe('renderMarkdown', () => {
  it('emits a header, separator, and one row per task with the bounce + activity signal', () => {
    const md = renderMarkdown([
      row({ taskId: 'president-xxxx', attempt: 3, bouncedFrom: 'verify', openFindings: 1, activityAgeSec: 120 }),
    ]);
    const lines = md.split('\n');
    expect(lines[0]).toContain('| TASK | REPO | PHASE |');
    expect(lines[1]).toContain('| --- |');
    expect(lines[2]).toContain('#3 ↩verify');
    expect(lines[2]).toContain('writing engine tests (2m)');
    expect(lines[2]).toContain('1 open');
  });

  it('escapes pipe characters in cell values', () => {
    const md = renderMarkdown([row({ activity: 'a|b' })]);
    expect(md).toContain('a\\|b');
  });
});

describe('renderTable', () => {
  it('says so when there are no tasks', () => {
    expect(renderTable([])).toBe('No tasks.');
  });

  it('aligns columns and shows the PR cell', () => {
    const table = renderTable([row({ pr: { number: 42, url: 'u', isDraft: true, state: 'open' } })]);
    expect(table).toContain('TASK');
    expect(table).toContain('#42 draft');
  });
});

// TASK-121: the CLI's job is to make the batch answerable at a glance — what came out, what still
// needs a look, what it cost.
describe('renderRollup (TASK-121)', () => {
  const empty: BatchRollup = {
    taskCount: 0,
    byStatus: {},
    pullRequests: [],
    needsAttention: [],
    openFindingCount: 0,
    totals: { inputTokens: 0, outputTokens: 0, costUsd: null },
    window: null,
  };

  it('says so plainly when the batch is empty', () => {
    expect(renderRollup(empty)).toBe('No tasks in that batch.');
  });

  it('renders the counts, the PRs, the worklist and the totals', () => {
    const out = renderRollup({
      ...empty,
      taskCount: 3,
      byStatus: { completed: 2, failed: 1 },
      pullRequests: [{ taskId: 'aaaaaaaa1111', title: 'Add the endpoint', url: 'https://github.com/o/r/pull/7' }],
      needsAttention: [{ taskId: 'bbbbbbbb2222', title: 'Fix the flake', reason: 'unmet: qa-inconclusive' }],
      openFindingCount: 4,
      totals: { inputTokens: 1234, outputTokens: 567, costUsd: 0.6513 },
      window: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-01T06:00:00.000Z' },
    });

    expect(out).toContain('3 task(s): 2 completed, 1 failed');
    expect(out).toContain('Pull requests opened: 1');
    expect(out).toContain('https://github.com/o/r/pull/7');
    expect(out).toContain('Needs attention: 1');
    expect(out).toContain('unmet: qa-inconclusive');
    expect(out).toContain('Open findings: 4');
    expect(out).toContain('$0.6513');
  });

  it('reports an unmeasured cost as such rather than as $0.00', () => {
    const out = renderRollup({ ...empty, taskCount: 1, byStatus: { running: 1 } });
    expect(out).toContain('cost not measured');
    expect(out).not.toContain('$0.0000');
  });
});
