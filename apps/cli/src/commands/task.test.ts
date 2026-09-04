import { describe, expect, it } from 'vitest';
import {
  deriveTaskTitle,
  formatAttribution,
  formatDuration,
  renderTimeline,
  runIdForTaskId,
  eventsQueryFor,
  type TimelineResponse,
} from './task.js';

describe('deriveTaskTitle', () => {
  it.each([
    ['first sentence up to a period', 'Add a compression seam. Then wire it in.', 'Add a compression seam'],
    ['stops at a question mark', 'Why is the socket leaking? It reopens on click.', 'Why is the socket leaking'],
    ['collapses interior whitespace and newlines', 'Fix   the\n\n  gate\tlogic.', 'Fix the gate logic'],
    ['strips a lone trailing terminator on a single-sentence prompt', 'Ship the report!', 'Ship the report'],
    ['keeps a prompt with no sentence terminator whole', 'add cross-repo token report', 'add cross-repo token report'],
  ])('%s', (_desc, prompt, expected) => {
    expect(deriveTaskTitle(prompt)).toBe(expected);
  });

  it('truncates a long first sentence to maxLength with an ellipsis', () => {
    const prompt = 'a'.repeat(200);
    const title = deriveTaskTitle(prompt, 20);
    expect(title).toHaveLength(20);
    expect(title.endsWith('…')).toBe(true);
  });

  it('returns a placeholder for an empty or whitespace-only prompt', () => {
    expect(deriveTaskTitle('')).toBe('(no prompt)');
    expect(deriveTaskTitle('   \n\t ')).toBe('(no prompt)');
  });

  it('returns a placeholder when the prompt is only sentence punctuation', () => {
    expect(deriveTaskTitle('...')).toBe('(no prompt)');
  });
});

describe('runIdForTaskId (TASK-128 logs fix)', () => {
  it('suffixes the task id, which is how semantic_events.run_id is keyed', () => {
    expect(runIdForTaskId('abc-123')).toBe('abc-123-run');
  });

  it('does not return the bare task id — that query matched nothing and printed no events', () => {
    expect(runIdForTaskId('abc-123')).not.toBe('abc-123');
  });
});

describe('eventsQueryFor (TASK-128 logs fix)', () => {
  it('asks for the suffixed run id, not the bare task id', () => {
    expect(eventsQueryFor('abc-123')).toContain('runId=abc-123-run');
  });

  it('asks from -1, because afterSequence is exclusive and sequences start at 0', () => {
    // afterSequence=0 silently dropped the first event of every run.
    expect(eventsQueryFor('abc-123')).toContain('afterSequence=-1');
    expect(eventsQueryFor('abc-123')).not.toContain('afterSequence=0');
  });
});

describe('formatDuration', () => {
  it.each([
    [null, '-'],
    [0, '0ms'],
    [999, '999ms'],
    [1500, '1.5s'],
    [59_999, '60.0s'],
    [60_000, '1m00s'],
    [125_000, '2m05s'],
  ])('renders %s as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('formatAttribution', () => {
  it('lists only non-zero buckets, biggest first', () => {
    expect(
      formatAttribution({ modelGenerationMs: 4000, testExecutionMs: 9000, qaExecutionMs: 0, toolExecutionMs: 500 }),
    ).toBe('tests 9.0s  model 4.0s  tools 500ms');
  });

  it('returns an empty string when there is no attribution row', () => {
    expect(formatAttribution(null)).toBe('');
  });
});

const timeline = (over: Partial<TimelineResponse> = {}): TimelineResponse => ({
  taskId: 'task-1',
  phases: [
    {
      phaseAttemptId: 'task-1-plan-1',
      phase: 'plan',
      attemptNumber: 1,
      startedAt: '2026-09-04T00:00:00.000Z',
      endedAt: '2026-09-04T00:00:05.000Z',
      durationMs: 5000,
      outcome: 'candidate',
      runtimeAttribution: { modelGenerationMs: 5000 },
      sessions: [{ id: 's1', role: 'planner', runtime: 'claude', model: 'opus', durationMs: 4800 }],
      qa: [],
      evidence: [],
      artifacts: [],
    },
    {
      phaseAttemptId: 'task-1-exercise-1',
      phase: 'exercise',
      attemptNumber: 1,
      startedAt: '2026-09-04T00:00:10.000Z',
      endedAt: '2026-09-04T00:00:40.000Z',
      durationMs: 30_000,
      outcome: 'repair',
      runtimeAttribution: { qaExecutionMs: 20_000, modelGenerationMs: 4000 },
      sessions: [],
      qa: [{ id: 'ev-1', kind: 'qa-video', status: 'passed', summary: 'checkout flow' }],
      evidence: [{ id: 'ev-2', kind: 'unit-test', status: 'passed', summary: '42 tests' }],
      artifacts: [{ id: 'a1', kind: 'qa-video', mediaType: 'video/webm', byteSize: 1024 }],
    },
  ],
  totals: {
    durationMs: 35_000,
    openAttempts: 0,
    qaExecutionMs: 20_000,
    inputTokens: 5000,
    outputTokens: 900,
    cachedInputTokens: 100,
    cacheCreationInputTokens: 50,
    costUsd: 0.1234,
  },
  longestPhase: { phase: 'exercise', attemptNumber: 1, durationMs: 30_000 },
  ...over,
});

describe('renderTimeline', () => {
  it('answers which phase took longest, what QA ran, and what it cost', () => {
    const out = renderTimeline(timeline()).join('\n');
    expect(out).toContain('Longest phase: exercise #1 (30.0s)');
    expect(out).toContain('qa qa-video: passed — checkout flow');
    expect(out).toContain('Cost: $0.1234');
  });

  it('names each phase with its duration and outcome', () => {
    const out = renderTimeline(timeline()).join('\n');
    expect(out).toContain('plan #1');
    expect(out).toContain('5.0s');
    expect(out).toContain('candidate');
    expect(out).toContain('exercise #1');
    expect(out).toContain('repair');
  });

  it('shows where the time went inside a phase', () => {
    const out = renderTimeline(timeline()).join('\n');
    expect(out).toContain('where: qa 20.0s  model 4.0s');
  });

  it('reports an open attempt as (open) rather than a zero duration', () => {
    const open = timeline({
      phases: [{ ...timeline().phases[0]!, durationMs: null, endedAt: null, outcome: null }],
      totals: { ...timeline().totals, openAttempts: 1 },
      longestPhase: null,
    });
    const out = renderTimeline(open).join('\n');
    expect(out).toContain('(open)');
    expect(out).toContain('1 attempts still open');
    expect(out).not.toContain('Longest phase');
  });

  it('reports the token split including the cache halves', () => {
    const out = renderTimeline(timeline()).join('\n');
    expect(out).toContain('Tokens: 5000 in / 900 out (cache read 100, cache write 50)');
  });
});
