import { describe, expect, it } from 'vitest';
import type { StageRun, Task } from './entities.js';
import { agentRunDurationMs, formatDuration, stageRunDurationMs, taskElapsedMs } from './timing.js';

describe('formatDuration', () => {
  it.each([
    [-100, '0s'],
    [0, '0s'],
    [400, '0.4s'],
    [9_900, '9.9s'],
    [12_000, '12s'],
    [90_000, '1m 30s'],
    [120_000, '2m'],
    [3_600_000, '1h'],
    [3_900_000, '1h 5m'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('clamps non-finite input to 0s', () => {
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

function stageRun(over: Partial<StageRun>): StageRun {
  return {
    id: 'sr1',
    taskId: 't1',
    stage: 'discovery',
    status: 'completed',
    enteredAt: '2026-06-17T00:00:00.000Z',
    completedAt: '2026-06-17T00:00:05.000Z',
    note: null,
    ...over,
  };
}

describe('stageRunDurationMs', () => {
  it('uses completedAt - enteredAt for a completed run', () => {
    expect(stageRunDurationMs(stageRun({}))).toBe(5_000);
  });

  it('measures an in-progress run against now', () => {
    const now = Date.parse('2026-06-17T00:00:03.000Z');
    const run = stageRun({ status: 'in_progress', completedAt: null });
    expect(stageRunDurationMs(run, now)).toBe(3_000);
  });

  it('returns null when enteredAt is unparseable', () => {
    expect(stageRunDurationMs(stageRun({ enteredAt: 'nonsense' }))).toBeNull();
  });
});

function task(over: Partial<Task>): Task {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'T',
    rawRequest: 'r',
    stage: 'discovery',
    status: 'active',
    worktreeId: null,
    worktreeMode: 'worktree',
    createdAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:10.000Z',
    ...over,
  };
}

describe('taskElapsedMs', () => {
  it('measures an active task against now', () => {
    const now = Date.parse('2026-06-17T00:00:30.000Z');
    expect(taskElapsedMs(task({ status: 'active' }), now)).toBe(30_000);
  });

  it.each([
    'done',
    'abandoned',
  ] as const)('measures a %s task to updatedAt, ignoring now', (status) => {
    const now = Date.parse('2026-06-17T01:00:00.000Z');
    expect(taskElapsedMs(task({ status }), now)).toBe(10_000);
  });

  it('returns null when createdAt is unparseable', () => {
    expect(taskElapsedMs(task({ createdAt: 'nonsense' }))).toBeNull();
  });
});

describe('agentRunDurationMs', () => {
  it('uses finishedAt - startedAt for a finished run', () => {
    const run = {
      startedAt: '2026-06-17T00:00:00.000Z',
      finishedAt: '2026-06-17T00:00:45.000Z',
    };
    expect(agentRunDurationMs(run)).toBe(45_000);
  });

  it('measures a still-running session against now', () => {
    const now = Date.parse('2026-06-17T00:00:20.000Z');
    const run = { startedAt: '2026-06-17T00:00:00.000Z', finishedAt: null };
    expect(agentRunDurationMs(run, now)).toBe(20_000);
  });

  it('returns null when startedAt is unparseable', () => {
    expect(agentRunDurationMs({ startedAt: 'nonsense', finishedAt: null })).toBeNull();
  });
});
