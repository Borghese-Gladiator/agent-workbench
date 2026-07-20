import { describe, expect, it } from 'vitest';
import type { ImplementationPlan, TaskContract } from '@awb/domain';
import { reviewerExaminedAllRequiredInputs } from './review-runner.js';
import type { ReviewInputs } from './review-inputs.js';

const taskContract: TaskContract = {
  id: 'contract-1',
  taskId: 'task-1',
  version: 1,
  objective: 'do the thing',
  constraints: [],
  nonGoals: [],
  risk: 'low',
  claims: [],
  status: 'approved',
};

const plan: ImplementationPlan = {
  id: 'plan-1',
  taskId: 'task-1',
  contractVersion: 1,
  version: 1,
  summary: 'the plan',
  affectedAreas: [],
  slices: [],
  risks: [],
  claimCoverage: [],
  status: 'accepted',
};

function baseInputs(overrides: Partial<ReviewInputs> = {}): ReviewInputs {
  return {
    taskContract,
    plan,
    finalDiff: 'diff --git a/x b/x',
    relevantSourcePaths: ['src/x.ts'],
    testPaths: ['src/x.test.ts'],
    verificationEvidenceIds: ['ev-1'],
    qaEvidenceIds: ['qa-1'],
    repositoryInvariants: ['no direct db access from routes'],
    ...overrides,
  };
}

describe('reviewerExaminedAllRequiredInputs', () => {
  it('is true when all required fields are present and non-empty', () => {
    expect(reviewerExaminedAllRequiredInputs(baseInputs())).toBe(true);
  });

  it.each([
    ['finalDiff', { finalDiff: '' }],
    ['finalDiff whitespace-only', { finalDiff: '   ' }],
    ['verificationEvidenceIds', { verificationEvidenceIds: [] as string[] }],
    ['qaEvidenceIds', { qaEvidenceIds: [] as string[] }],
  ])('is false when %s is missing/empty', (_label, overrides) => {
    expect(reviewerExaminedAllRequiredInputs(baseInputs(overrides))).toBe(false);
  });
});
