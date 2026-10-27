import { describe, expect, it } from 'vitest';
import type { Finding } from '@awb/domain';
import { computeDecaySignals, decaySpanAttributes } from './decay-metrics.js';

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'f-1',
    taskId: 'task-1',
    severity: 'medium',
    category: 'correctness',
    claimIds: [],
    description: 'x',
    status: 'open',
    ...overrides,
  };
}

describe('computeDecaySignals', () => {
  it('computes diff size, reviewed ratio, and finding density', () => {
    const signals = computeDecaySignals({
      diffLineStats: { added: 30, removed: 20, filesChanged: 3 },
      // 25 reviewed lines out of 50 changed → ratio 0.5.
      reviewedDiffText: Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n'),
      findings: [
        finding({ id: 'a', severity: 'blocker', status: 'open' }),
        finding({ id: 'b', severity: 'high', status: 'resolved' }),
        finding({ id: 'c', severity: 'low', category: 'maintainability' }),
      ],
    });

    expect(signals.diffLines).toBe(50);
    expect(signals.filesChanged).toBe(3);
    expect(signals.reviewedDiffLines).toBe(25);
    expect(signals.reviewedRatio).toBe(0.5);
    expect(signals.findingCount).toBe(3);
    // Only the open blocker counts; the high one is resolved.
    expect(signals.blockerHighCount).toBe(1);
    expect(signals.maintainabilityFindingCount).toBe(1);
    expect(signals.findingDensityPerKloc).toBeCloseTo((3 / 50) * 1000);
  });

  it('handles an empty diff without dividing by zero (nothing unreviewed, zero density)', () => {
    const signals = computeDecaySignals({
      diffLineStats: { added: 0, removed: 0, filesChanged: 0 },
      reviewedDiffText: '',
      findings: [],
    });
    expect(signals.diffLines).toBe(0);
    expect(signals.reviewedRatio).toBe(1);
    expect(signals.findingDensityPerKloc).toBe(0);
  });

  it('clamps the reviewed ratio to at most 1 when the reviewed text exceeds numstat lines', () => {
    const signals = computeDecaySignals({
      diffLineStats: { added: 2, removed: 0, filesChanged: 1 },
      reviewedDiffText: 'a\nb\nc\nd\ne',
      findings: [],
    });
    expect(signals.reviewedRatio).toBe(1);
  });
});

describe('decaySpanAttributes', () => {
  it('flattens signals into awb.decay.* attributes', () => {
    const attrs = decaySpanAttributes(
      computeDecaySignals({
        diffLineStats: { added: 10, removed: 0, filesChanged: 1 },
        reviewedDiffText: 'a\nb',
        findings: [],
      }),
    );
    expect(attrs['awb.decay.diff_lines']).toBe(10);
    expect(attrs['awb.decay.files_changed']).toBe(1);
    expect(attrs['awb.decay.reviewed_diff_lines']).toBe(2);
    expect(attrs['awb.decay.reviewed_ratio']).toBe(0.2);
    expect(attrs['awb.decay.finding_count']).toBe(0);
  });
});
