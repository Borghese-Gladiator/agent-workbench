import { describe, expect, it } from 'vitest';
import type { Finding } from '@awb/domain';
import {
  allowedToolsForRole,
  everyFindingResolvedInvalidatedOrWaived,
  noBlockerOrHighFindingOpen,
  reviewerSessionDiffersFromBuilder,
  runAdversarialReview,
} from './review-runner.js';
import type { ReviewInputs } from './review-inputs.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    taskId: 'task-1',
    severity: 'medium',
    category: 'correctness',
    claimIds: [],
    description: 'something',
    status: 'open',
    ...overrides,
  };
}

describe('allowedToolsForRole', () => {
  it('returns the adversarial-reviewer capability list from the capability broker', () => {
    const tools = allowedToolsForRole();
    expect(tools).toContain('finding.write');
    expect(tools).toContain('probe.request');
    expect(tools).not.toContain('worktree.write');
  });
});

describe('runAdversarialReview', () => {
  it('delegates to the caller-supplied runReviewer and passes through its result', async () => {
    const reviewInputs = {} as ReviewInputs;
    const result = await runAdversarialReview({
      taskId: 'task-1',
      cwd: '/tmp/worktree',
      reviewInputs,
      runReviewer: async (inputs) => {
        expect(inputs).toBe(reviewInputs);
        return {
          reviewerSessionId: 'session-reviewer-1',
          completed: true,
          findings: [finding()],
          summary: 'reviewed',
        };
      },
    });

    expect(result.reviewerSessionId).toBe('session-reviewer-1');
    expect(result.completed).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toBe('reviewed');
  });
});

describe('reviewerSessionDiffersFromBuilder', () => {
  it('is true when session ids differ', () => {
    expect(reviewerSessionDiffersFromBuilder('reviewer-1', 'builder-1')).toBe(true);
  });

  it('is false when session ids are the same', () => {
    expect(reviewerSessionDiffersFromBuilder('same-session', 'same-session')).toBe(false);
  });
});

describe('noBlockerOrHighFindingOpen', () => {
  it('is true with no findings', () => {
    expect(noBlockerOrHighFindingOpen([])).toBe(true);
  });

  it('is true when blocker/high findings are not open', () => {
    expect(
      noBlockerOrHighFindingOpen([
        finding({ severity: 'blocker', status: 'resolved' }),
        finding({ severity: 'high', status: 'waived' }),
      ]),
    ).toBe(true);
  });

  it('is true when only low/medium/note findings are open', () => {
    expect(
      noBlockerOrHighFindingOpen([finding({ severity: 'medium', status: 'open' }), finding({ severity: 'note', status: 'open' })]),
    ).toBe(true);
  });

  it.each(['blocker', 'high'] as const)('is false when a %s finding is open', (severity) => {
    expect(noBlockerOrHighFindingOpen([finding({ severity, status: 'open' })])).toBe(false);
  });
});

describe('everyFindingResolvedInvalidatedOrWaived', () => {
  it('is true with no findings', () => {
    expect(everyFindingResolvedInvalidatedOrWaived([])).toBe(true);
  });

  it.each(['resolved', 'invalid', 'waived'] as const)('is true when every finding is %s', (status) => {
    expect(everyFindingResolvedInvalidatedOrWaived([finding({ status }), finding({ status })])).toBe(true);
  });

  it('is false when any finding is still open', () => {
    expect(everyFindingResolvedInvalidatedOrWaived([finding({ status: 'resolved' }), finding({ status: 'open' })])).toBe(false);
  });
});
