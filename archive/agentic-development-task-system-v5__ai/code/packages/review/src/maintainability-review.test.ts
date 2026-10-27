import { describe, expect, it } from 'vitest';
import type { Finding } from '@awb/domain';
import { noBlockerOrHighFindingOpen } from './review-runner.js';
import {
  everyFindingIsAdvisory,
  runMaintainabilityReview,
  toAdvisoryFinding,
} from './maintainability-review.js';
import type { ReviewInputs } from './review-inputs.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    taskId: 'task-1',
    severity: 'medium',
    category: 'correctness',
    claimIds: [],
    description: 'duplicate helper copy-pasted',
    status: 'open',
    ...overrides,
  };
}

describe('runMaintainabilityReview (TASK-53)', () => {
  it('surfaces duplication as an advisory maintainability finding', async () => {
    const result = await runMaintainabilityReview({
      taskId: 'task-1',
      reviewInputs: {} as ReviewInputs,
      runReviewer: async () => ({
        reviewerSessionId: 'session-maint-1',
        completed: true,
        findings: [finding({ description: 'copy-pastes formatDate() instead of importing it' })],
        summary: 'one duplication candidate',
      }),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.category).toBe('maintainability');
    expect(result.findings[0]?.severity).toBe('note');
  });

  it('clamps even a blocker-severity raw finding down to an advisory note', async () => {
    const result = await runMaintainabilityReview({
      taskId: 'task-1',
      reviewInputs: {} as ReviewInputs,
      runReviewer: async () => ({
        reviewerSessionId: 's',
        completed: true,
        // A mis-scripted reviewer tries to emit a blocking correctness finding.
        findings: [finding({ severity: 'blocker', category: 'correctness' })],
        summary: 'x',
      }),
    });

    expect(everyFindingIsAdvisory(result.findings)).toBe(true);
    // The advisory findings can never trip the challenge gate's blocking predicate.
    expect(noBlockerOrHighFindingOpen(result.findings)).toBe(true);
  });
});

describe('toAdvisoryFinding', () => {
  it('forces maintainability category and note severity', () => {
    const advisory = toAdvisoryFinding(finding({ severity: 'high', category: 'architecture' }));
    expect(advisory.category).toBe('maintainability');
    expect(advisory.severity).toBe('note');
    expect(advisory.description).toBe('duplicate helper copy-pasted');
  });
});
