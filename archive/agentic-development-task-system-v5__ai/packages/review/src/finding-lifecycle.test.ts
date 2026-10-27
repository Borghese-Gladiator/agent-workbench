import { describe, expect, it } from 'vitest';
import type { Finding } from '@awb/domain';
import { invalidateFinding, resolveFinding, waiveFinding } from './finding-lifecycle.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    taskId: 'task-1',
    severity: 'high',
    category: 'correctness',
    claimIds: [],
    description: 'something',
    status: 'open',
    ...overrides,
  };
}

describe('resolveFinding', () => {
  it('sets status to resolved', () => {
    expect(resolveFinding(finding()).status).toBe('resolved');
  });

  it('does not mutate the input', () => {
    const original = finding();
    resolveFinding(original);
    expect(original.status).toBe('open');
  });
});

describe('invalidateFinding', () => {
  it('sets status to invalid given a non-empty reason', () => {
    expect(invalidateFinding(finding(), 'reproduction does not hold on current candidate').status).toBe('invalid');
  });

  it.each(['', '   '])('throws when reason is %j', (reason) => {
    expect(() => invalidateFinding(finding(), reason)).toThrow(/non-empty reason/);
  });
});

describe('waiveFinding', () => {
  it('sets status to waived given a human-approved waiver with a reason', () => {
    const result = waiveFinding(finding(), { humanApproved: true, reason: 'accepted risk for this release' });
    expect(result.status).toBe('waived');
  });

  it('throws when humanApproved is false', () => {
    expect(() => waiveFinding(finding(), { humanApproved: false, reason: 'because' })).toThrow(/humanApproved/);
  });

  it('throws when reason is empty', () => {
    expect(() => waiveFinding(finding(), { humanApproved: true, reason: '' })).toThrow(/non-empty reason/);
  });
});
