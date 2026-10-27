import { describe, expect, it } from 'vitest';
import { UsageAggregator } from './usage-aggregator.js';

describe('UsageAggregator', () => {
  it('accumulates totals across multiple record() calls', () => {
    const agg = new UsageAggregator();
    agg.record({ provider: 'anthropic', model: 'claude', inputTokens: 100, outputTokens: 20 });
    agg.record({ provider: 'anthropic', model: 'claude', inputTokens: 50, outputTokens: 10 });
    const totals = agg.totals();
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(30);
  });

  it('tracks cached input tokens and cost separately', () => {
    const agg = new UsageAggregator();
    agg.record({ provider: 'anthropic', model: 'claude', inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, costUsd: 0.01 });
    const totals = agg.totals();
    expect(totals.cachedInputTokens).toBe(80);
    expect(totals.costUsd).toBeCloseTo(0.01);
  });

  it('breaks down usage by model', () => {
    const agg = new UsageAggregator();
    agg.record({ provider: 'anthropic', model: 'claude-a', inputTokens: 100, outputTokens: 20 });
    agg.record({ provider: 'anthropic', model: 'claude-b', inputTokens: 10, outputTokens: 5 });
    const breakdown = agg.breakdownByModel();
    expect(breakdown['claude-a']).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(breakdown['claude-b']).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('starts at zero with no records', () => {
    const agg = new UsageAggregator();
    expect(agg.totals()).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 });
  });
});
