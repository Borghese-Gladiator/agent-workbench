import { describe, expect, it } from 'vitest';
import type { ModelUsage } from '@awb/domain';
import {
  estimateContextComposition,
  reconcileContextComposition,
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
