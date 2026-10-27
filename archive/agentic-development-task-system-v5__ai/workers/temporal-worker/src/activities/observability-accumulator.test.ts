import { describe, expect, it } from 'vitest';
import type { ModelUsage } from '@awb/domain';
import {
  estimateContextComposition,
  reconcileContextComposition,
  ObservabilityAccumulator,
} from './observability-accumulator.js';

const CONTEXT_BUCKETS = [
  'contractTokens',
  'planTokens',
  'diffTokens',
  'evidenceTokens',
  'findingsTokens',
  'repositoryMapTokens',
  'memoryTokens',
  'instructionTokens',
] as const;
const bucketSum = (c: ReturnType<typeof estimateContextComposition>): number =>
  CONTEXT_BUCKETS.reduce((sum, k) => sum + c[k], 0);

describe('estimateContextComposition', () => {
  it('counts injected project memory into the memoryTokens bucket (TASK-50 read side)', () => {
    const withoutMemory = estimateContextComposition({ contract: { objective: 'x' } }, 'instr');
    expect(withoutMemory.memoryTokens).toBe(0);

    const withMemory = estimateContextComposition(
      { contract: { objective: 'x' }, memory: [{ kind: 'pitfall', statement: 'clicking Join opens N sockets' }] },
      'instr',
    );
    // The metric must reflect what was actually sent — a payload carrying `memory` yields a non-zero
    // bucket (regression guard: the planner site once estimated from an object that omitted memory).
    expect(withMemory.memoryTokens).toBeGreaterThan(0);
  });

  it('maps known payload keys to their buckets', () => {
    const c = estimateContextComposition({ contract: 'abcd', plan: 'efgh', priorFindings: 'ij' }, 'kl');
    expect(c.contractTokens).toBeGreaterThan(0);
    expect(c.planTokens).toBeGreaterThan(0);
    expect(c.findingsTokens).toBeGreaterThan(0);
    expect(c.instructionTokens).toBeGreaterThan(0);
    expect(c.diffTokens).toBe(0);
  });

  it('flags the raw chars/4 estimate as estimated (unmeasured provenance)', () => {
    const c = estimateContextComposition({ contract: 'abcd', plan: 'efgh' }, 'ij');
    expect(c.estimated).toBe(true);
  });
});

describe('reconcileContextComposition', () => {
  const usage = (inputTokens: number): ModelUsage => ({
    provider: 'anthropic',
    model: 'claude',
    inputTokens,
    outputTokens: 0,
    cachedInputTokens: 999,
  });

  it('scales the buckets to sum EXACTLY to the measured inputTokens and marks them measured', () => {
    const estimate = estimateContextComposition(
      { contract: 'x'.repeat(400), plan: 'y'.repeat(200), diff: 'z'.repeat(100) },
      'i'.repeat(80),
    );
    const reconciled = reconcileContextComposition(estimate, usage(1234));
    expect(bucketSum(reconciled)).toBe(1234);
    expect(reconciled.estimated).toBe(false);
    // Proportions preserved: contract (largest source) stays the largest reconciled bucket.
    expect(reconciled.contractTokens).toBeGreaterThan(reconciled.planTokens);
  });

  it('does NOT fold cache-read tokens into the fresh-input buckets', () => {
    const estimate = estimateContextComposition({ contract: 'x'.repeat(400) }, '');
    const reconciled = reconcileContextComposition(estimate, usage(100));
    // cachedInputTokens (999) is attributed on model_invocations, not here — sum stays the fresh 100.
    expect(bucketSum(reconciled)).toBe(100);
  });

  it('leaves the estimate flagged _estimated when no usage is reported (mock runtime)', () => {
    const estimate = estimateContextComposition({ contract: 'x'.repeat(400) }, '');
    const reconciled = reconcileContextComposition(estimate, undefined);
    expect(reconciled.estimated).toBe(true);
    expect(bucketSum(reconciled)).toBe(bucketSum(estimate));
  });
});

describe('ObservabilityAccumulator.recordSession timestamps (TASK-125)', () => {
  const base = {
    sessionId: 'sess-1',
    taskId: 'task-1',
    runId: 'task-1-run',
    phaseAttemptId: 'task-1-plan-1',
    phase: 'plan',
    role: 'planner',
    runtime: 'claude',
  } as const;

  const usage: ModelUsage = { provider: 'anthropic', model: 'claude-opus', inputTokens: 100, outputTokens: 20 };

  const drain = (acc: ObservabilityAccumulator) =>
    acc.toPayload({
      taskId: base.taskId,
      runId: base.runId,
      phaseAttemptId: base.phaseAttemptId,
      phase: 'plan',
      attemptNumber: 1,
    });

  it('persists the measured interval, not a single write-time stamp', () => {
    const acc = new ObservabilityAccumulator();
    const startedAtMs = Date.now() - 42_000;
    acc.recordSession({ ...base, usage, runtimeMs: 42_000, startedAtMs });

    const session = drain(acc)?.sessions[0];
    expect(session?.startedAt).toBe(new Date(startedAtMs).toISOString());
    expect(session?.endedAt).not.toBe(session?.startedAt);
    const elapsed = Date.parse(session!.endedAt!) - Date.parse(session!.startedAt);
    expect(elapsed).toBeGreaterThanOrEqual(42_000);
  });

  it('reconstructs the start from runtimeMs when no start was measured', () => {
    const acc = new ObservabilityAccumulator();
    acc.recordSession({ ...base, usage, runtimeMs: 5000 });

    const session = drain(acc)?.sessions[0];
    const elapsed = Date.parse(session!.endedAt!) - Date.parse(session!.startedAt);
    expect(elapsed).toBe(5000);
  });

  it('gives two sessions of different length different durations', () => {
    const acc = new ObservabilityAccumulator();
    const now = Date.now();
    acc.recordSession({ ...base, sessionId: 'short', usage, runtimeMs: 1000, startedAtMs: now - 1000 });
    acc.recordSession({ ...base, sessionId: 'long', usage, runtimeMs: 60_000, startedAtMs: now - 60_000 });

    const durations = (drain(acc)?.sessions ?? []).map(
      (s) => Date.parse(s.endedAt!) - Date.parse(s.startedAt),
    );
    expect(durations[0]).not.toBe(durations[1]);
    expect(durations[1]).toBeGreaterThan(durations[0]!);
  });

  it('leaves the model invocation end unset — no in-tree runtime reports one', () => {
    const acc = new ObservabilityAccumulator();
    acc.recordSession({ ...base, usage, runtimeMs: 1000, startedAtMs: Date.now() - 1000 });

    const invocation = drain(acc)?.sessions[0]?.modelInvocations[0];
    expect(invocation?.startedAt).toBeDefined();
    expect(invocation?.endedAt).toBeUndefined();
  });
});

describe('ObservabilityAccumulator.toPayload close fields (TASK-124)', () => {
  const attempt = {
    taskId: 'task-1',
    runId: 'task-1-run',
    phaseAttemptId: 'task-1-plan-1',
    phase: 'plan',
    attemptNumber: 1,
  } as const;

  it('returns undefined when nothing was recorded and the attempt is not closing', () => {
    expect(new ObservabilityAccumulator().toPayload(attempt)).toBeUndefined();
  });

  it('returns a payload for close fields alone, so a throwing attempt still closes', () => {
    const payload = new ObservabilityAccumulator().toPayload({
      ...attempt,
      startedAt: '2026-09-04T00:00:00.000Z',
      endedAt: '2026-09-04T00:00:01.000Z',
      outcome: 'failed',
    });
    expect(payload?.outcome).toBe('failed');
    expect(payload?.endedAt).toBe('2026-09-04T00:00:01.000Z');
    expect(payload?.sessions).toEqual([]);
  });
});
