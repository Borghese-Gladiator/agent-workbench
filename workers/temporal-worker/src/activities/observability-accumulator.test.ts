import { describe, expect, it } from 'vitest';
import { estimateContextComposition } from './observability-accumulator.js';

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
});
