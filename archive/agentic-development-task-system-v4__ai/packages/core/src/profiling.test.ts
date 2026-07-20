import { describe, expect, it } from 'vitest';
import {
  activity,
  crossStageRepeatedReads,
  eventGaps,
  type ProfileEvent,
  pairToolCalls,
  profileStage,
  readPathsOf,
  repeatedReadsInRun,
  resultBytes,
  toolLatency,
  toolVolume,
  turnStats,
  waits,
} from './profiling.js';

/**
 * Build a synthetic event stream from a compact step list. Each step is one
 * event; tool calls/results auto-advance seq + a clock so latency is derivable.
 */
let seq = 0;
let clock = 0;
function reset() {
  seq = 0;
  clock = 0;
}
function ev(type: string, payload: unknown, dtMs = 0): ProfileEvent {
  clock += dtMs;
  seq += 1;
  return { seq, type, payload, createdAt: new Date(clock).toISOString() };
}
const text = (t: string) => ev('assistant_text', { text: t });
const call = (name: string, input: Record<string, unknown>) => ev('tool_call', { name, input });
const result = (status: string, summary: string, dtMs: number) =>
  ev('tool_result', { status, summary }, dtMs);

describe('pairToolCalls', () => {
  it('pairs each call with the next result by adjacency and computes latency', () => {
    reset();
    const events = [
      text('starting'),
      call('Read', { file_path: '/a.ts' }),
      result('ok', 'contents', 300),
      call('Bash', { command: 'ls' }),
      result('ok', 'a\nb', 50),
    ];
    const pairs = pairToolCalls(events);
    expect(pairs.map((p) => p.name)).toEqual(['Read', 'Bash']);
    expect(pairs[0]?.latencyMs).toBe(300);
    expect(pairs[1]?.latencyMs).toBe(50);
    expect(pairs[0]?.status).toBe('ok');
  });

  it('leaves a call unmatched when another call precedes any result', () => {
    reset();
    const events = [
      call('Read', { file_path: '/a.ts' }), // no result before next call
      call('Read', { file_path: '/b.ts' }),
      result('ok', 'x', 10),
    ];
    const pairs = pairToolCalls(events);
    expect(pairs[0]?.latencyMs).toBeNull();
    expect(pairs[0]?.status).toBeNull();
    expect(pairs[1]?.latencyMs).toBe(10);
  });

  it('is robust to out-of-order seq', () => {
    reset();
    const a = call('Read', { file_path: '/a.ts' });
    const r = result('ok', 'x', 100);
    const pairs = pairToolCalls([r, a]); // reversed
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.latencyMs).toBe(100);
  });
});

describe('toolLatency', () => {
  it('groups by tool and surfaces the slowest calls + unmatched count', () => {
    reset();
    const events = [
      call('Bash', { command: 'a' }),
      result('ok', '', 100),
      call('Bash', { command: 'b' }),
      result('ok', '', 300),
      call('Read', { file_path: '/x' }),
      result('ok', '', 20),
      call('Read', { file_path: '/y' }), // unmatched (end of stream)
    ];
    const lat = toolLatency(pairToolCalls(events), 2);
    expect(lat.byTool.Bash?.maxMs).toBe(300);
    expect(lat.byTool.Bash?.medianMs).toBe(100);
    expect(lat.byTool.Read?.count).toBe(1);
    expect(lat.slowest[0]?.latencyMs).toBe(300);
    expect(lat.slowest).toHaveLength(2);
    expect(lat.unmatched).toBe(1);
  });
});

describe('toolVolume', () => {
  it('counts calls and batches split by assistant_text', () => {
    reset();
    const events = [
      text('think'),
      call('Read', { file_path: '/a' }), // batch 1
      call('Read', { file_path: '/b' }), // same batch (no text between)
      text('more'),
      call('Bash', { command: 'x' }), // batch 2
    ];
    const v = toolVolume(events);
    expect(v.toolCalls).toBe(3);
    expect(v.batches).toBe(2);
    expect(v.batchingRatio).toBeCloseTo(2 / 3);
  });

  it('reports a fully serial stream as ratio 1.0', () => {
    reset();
    const events = [
      call('Bash', { command: 'a' }),
      text('t'),
      call('Bash', { command: 'b' }),
      text('t'),
      call('Bash', { command: 'c' }),
    ];
    const v = toolVolume(events);
    expect(v.batchingRatio).toBe(1);
  });
});

describe('activity', () => {
  it('classifies reads, commands, tests, and writes with a work ratio', () => {
    reset();
    const events = [
      call('Read', { file_path: '/a.ts' }),
      result('ok', '', 1),
      call('Read', { file_path: '/a.ts' }),
      result('ok', '', 1), // repeat read of same file
      call('Bash', { command: 'python -m pytest -q' }),
      result('ok', '', 1),
      call('Bash', { command: 'ls' }),
      result('ok', '', 1),
      call('Write', { file_path: '/new.ts' }),
      result('ok', '', 1),
    ];
    const a = activity(pairToolCalls(events));
    expect(a.filesRead).toBe(2);
    expect(a.distinctFilesRead).toBe(1);
    expect(a.commandsRun).toBe(2);
    expect(a.testsRun).toBe(1);
    expect(a.filesWritten).toBe(1);
    expect(a.workRatio).toBeCloseTo(1 / 5);
  });
});

describe('resultBytes (proxy)', () => {
  it('sums summary chars and finds the largest, flagged as a proxy', () => {
    reset();
    const events = [
      call('Bash', { command: 'cat big' }),
      result('ok', 'x'.repeat(500), 1),
      call('Read', { file_path: '/a' }),
      result('ok', 'short', 1),
    ];
    const rb = resultBytes(pairToolCalls(events));
    expect(rb.totalChars).toBe(505);
    expect(rb.maxChars).toBe(500);
    expect(rb.largest?.name).toBe('Bash');
    expect(rb.isProxy).toBe(true);
  });
});

describe('repeatedReadsInRun', () => {
  it('reports only files read more than once', () => {
    reset();
    const events = [
      call('Read', { file_path: '/dup' }),
      result('ok', '', 1),
      call('Read', { file_path: '/dup' }),
      result('ok', '', 1),
      call('Read', { file_path: '/once' }),
      result('ok', '', 1),
    ];
    const r = repeatedReadsInRun(pairToolCalls(events));
    expect(r).toEqual([{ path: '/dup', times: 2 }]);
  });
});

describe('waits', () => {
  it('captures denials, errored calls, and adjacent retries', () => {
    reset();
    const events = [
      call('Bash', { command: 'pwd; ls' }), // compound — denied
      result('error', 'Compound commands (;) are not allowed.', 1),
      call('Bash', { command: 'pwd; ls' }), // identical re-issue = retry
      result('error', 'Compound commands (;) are not allowed.', 1),
      ev('result', { denials: ['Bash'], isError: false, subtype: 'success' }),
    ];
    const pairs = pairToolCalls(events);
    const w = waits(events, pairs);
    expect(w.permissionDenials).toEqual(['Bash']);
    expect(w.erroredCalls).toBe(2);
    expect(w.retries).toBe(1);
  });
});

describe('crossStageRepeatedReads', () => {
  it('flags a file an earlier stage read that a later stage reads again', () => {
    const repeats = crossStageRepeatedReads([
      { stage: 'discovery', readPaths: ['engine.py', 'engine.py', 'cli.py'] },
      { stage: 'implementation', readPaths: ['engine.py', 'server.py'] },
    ]);
    // engine.py: counted once per stage, appears in 2 stages -> repeat.
    expect(repeats).toEqual([{ path: 'engine.py', stages: ['discovery', 'implementation'] }]);
  });
});

describe('readPathsOf', () => {
  it('extracts Read paths in order', () => {
    reset();
    const events = [
      call('Read', { file_path: '/a' }),
      result('ok', '', 1),
      call('Bash', { command: 'ls' }),
      result('ok', '', 1),
      call('Read', { file_path: '/b' }),
      result('ok', '', 1),
    ];
    expect(readPathsOf(events)).toEqual(['/a', '/b']);
  });
});

/**
 * Self-validating test: reconstruct the SHAPE of the known-bad Reversi
 * implementation run (docs/profiling-audit-findings.md) and confirm the metrics
 * surface the regression we built them to catch — duplicate repo survey, a
 * mostly-survey work ratio, and a denied compound-Bash call.
 */
describe('profileStage — known-bad implementation shape', () => {
  it('surfaces duplicate survey, low work ratio, and a denial', () => {
    reset();
    const events = [
      text('I will start by reading the repo'),
      // duplicate orientation survey (the real run did pwd;ls;cat then repeated)
      call('Bash', { command: 'pwd; ls reversi/ tests/; cat pyproject.toml' }),
      result('error', 'Compound commands (;) are not allowed.', 200),
      call('Bash', { command: 'pwd' }),
      result('ok', '/repo', 50),
      call('Bash', { command: 'ls reversi/ tests/' }),
      result('ok', 'engine.py\ncli.py', 60),
      call('Bash', { command: 'cat pyproject.toml' }),
      result('ok', '[project]...', 40),
      call('Read', { file_path: 'pyproject.toml' }), // re-read what cat already showed
      result('ok', '[project]...', 30),
      // a little real work
      call('Write', { file_path: 'reversi/server.py' }),
      result('ok', 'written', 80),
      call('Bash', { command: 'python -m pytest -q' }),
      result('ok', '3 passed', 1200),
      ev('result', { denials: ['Bash'], isError: false, subtype: 'success' }),
    ];
    const p = profileStage('implementation', events);

    // Mostly survey: 1 write out of 7 calls.
    expect(p.activity.filesWritten).toBe(1);
    expect(p.volume.toolCalls).toBe(7);
    expect(p.activity.workRatio).toBeLessThan(0.2);
    // The denied compound command shows up as both an error and a denial.
    expect(p.waits.erroredCalls).toBe(1);
    expect(p.waits.permissionDenials).toEqual(['Bash']);
    // A test was run; the slowest call is the pytest run.
    expect(p.activity.testsRun).toBe(1);
    expect(p.toolLatency.slowest[0]?.latencyMs).toBe(1200);
    // No `turn` events in this stream → empty turn stats, not a crash.
    expect(p.turns.rows).toEqual([]);
    expect(p.turns.slowest).toBeNull();
  });
});

describe('turnStats', () => {
  const turn = (payload: Record<string, unknown>) => ev('turn', payload);

  it('collects per-turn rows + aggregate ttft stats + the slowest turn', () => {
    reset();
    const events = [
      turn({
        index: 1,
        ttftMs: 50_000,
        inputTokens: 30_000,
        cacheReadInputTokens: 0,
        outputTokens: 800,
      }),
      call('Read', { file_path: 'a.ts' }),
      result('ok', '...', 30),
      turn({
        index: 2,
        ttftMs: 70_000,
        inputTokens: 120_000,
        cacheReadInputTokens: 90_000,
        outputTokens: 1200,
      }),
      call('Write', { file_path: 'b.ts' }),
      result('ok', 'written', 40),
      turn({
        index: 3,
        ttftMs: 12_000,
        inputTokens: 135_000,
        cacheReadInputTokens: 130_000,
        outputTokens: 200,
      }),
    ];
    const s = turnStats(events);

    expect(s.rows).toHaveLength(3);
    expect(s.rows.map((r) => r.ttftMs)).toEqual([50_000, 70_000, 12_000]);
    // Aggregate over the three ttft samples (median is lower-middle).
    expect(s.ttft).toMatchObject({ count: 3, minMs: 12_000, maxMs: 70_000, medianMs: 50_000 });
    // The slowest turn is #2 — the one whose ttft rose WITH input tokens (H1 signal).
    expect(s.slowest?.index).toBe(2);
    expect(s.slowest?.inputTokens).toBe(120_000);
  });

  it('tolerates a turn with a null ttft (unmeasurable) without dropping the row', () => {
    reset();
    const s = turnStats([
      turn({ index: 1, ttftMs: null, inputTokens: 1000 }),
      turn({ index: 2, ttftMs: 8_000, inputTokens: 2000 }),
    ]);
    expect(s.rows).toHaveLength(2);
    // Only the measurable sample feeds the aggregate.
    expect(s.ttft.count).toBe(1);
    expect(s.slowest?.index).toBe(2);
  });
});

describe('eventGaps', () => {
  // One event with independently-controlled receive and insert times (ms epoch).
  const g = (s: number, type: string, recvMs: number, insertMs = recvMs): ProfileEvent => ({
    seq: s,
    type,
    payload: null,
    receivedAt: new Date(recvMs).toISOString(),
    createdAt: new Date(insertMs).toISOString(),
  });

  it('returns no gaps for an empty or single-event stream', () => {
    expect(eventGaps([]).gaps).toEqual([]);
    expect(eventGaps([g(1, 'assistant_text', 100)]).gaps).toEqual([]);
    expect(eventGaps([]).modelGap.count).toBe(0);
  });

  it('measures the model gap between consecutive receive times', () => {
    const r = eventGaps([
      g(1, 'tool_result', 1_000),
      g(2, 'assistant_text', 6_000),
      g(3, 'tool_call', 6_500),
    ]);
    expect(r.gaps).toHaveLength(2);
    expect(r.gaps[0]).toMatchObject({
      seq: 2,
      boundary: 'tool_result→assistant_text',
      modelMs: 5_000,
    });
    expect(r.gaps[1]).toMatchObject({ seq: 3, boundary: 'assistant_text→tool_call', modelMs: 500 });
    expect(r.modelGap).toMatchObject({ count: 2, minMs: 500, maxMs: 5_000 });
  });

  it('computes persist gap from createdAt − receivedAt of the later event', () => {
    // Event 2 was received at 2_000 but not inserted until 2_300 → 300ms persist delay.
    const r = eventGaps([g(1, 'turn', 1_000), g(2, 'assistant_text', 2_000, 2_300)]);
    expect(r.gaps[0]?.modelMs).toBe(1_000);
    expect(r.gaps[0]?.persistMs).toBe(300);
    expect(r.persistGap.maxMs).toBe(300);
  });

  it('ranks the slowest model gaps descending, capped at topN', () => {
    const r = eventGaps(
      [
        g(1, 'turn', 0),
        g(2, 'tool_call', 100),
        g(3, 'tool_result', 5_100),
        g(4, 'assistant_text', 5_200),
      ],
      2,
    );
    expect(r.slowest.map((x) => x.modelMs)).toEqual([5_000, 100]);
  });

  it('falls back to createdAt for legacy events missing receivedAt', () => {
    const legacy = (s: number, type: string, insertMs: number): ProfileEvent => ({
      seq: s,
      type,
      payload: null,
      createdAt: new Date(insertMs).toISOString(),
    });
    const r = eventGaps([legacy(1, 'turn', 1_000), legacy(2, 'assistant_text', 4_000)]);
    // Model gap still derivable from insert times; persist gap is unmeasurable (no receivedAt).
    expect(r.gaps[0]?.modelMs).toBe(3_000);
    expect(r.gaps[0]?.persistMs).toBeNull();
    expect(r.persistGap.count).toBe(0);
  });
});
