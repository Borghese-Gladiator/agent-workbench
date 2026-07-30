import { describe, it, expect } from 'vitest';
import { deriveTaskStatus } from './task-status.js';

describe('deriveTaskStatus', () => {
  it.each([
    ['running', 'specify', 'Queued', 'neutral'],
    ['running', 'plan', 'Planning', 'progress'],
    ['running', 'implement', 'Running', 'progress'],
    ['awaiting-human', 'plan', 'Waiting for input', 'attention'],
    ['awaiting-external', 'release', 'Waiting for input', 'attention'],
    ['completed', 'assimilate', 'Completed', 'success'],
    ['failed', 'implement', 'Failed', 'danger'],
    ['cancelled', 'plan', 'Cancelled', 'neutral'],
    ['blocked', 'verify', 'Blocked', 'danger'],
  ])('condition=%s phase=%s → %s (%s)', (condition, phase, label, tone) => {
    const status = deriveTaskStatus(condition, phase);
    expect(status.label).toBe(label);
    expect(status.tone).toBe(tone);
    expect(status.icon).not.toBe('');
  });

  it('falls back to Running for an unknown condition', () => {
    expect(deriveTaskStatus('mystery', 'implement').label).toBe('Running');
  });
});
