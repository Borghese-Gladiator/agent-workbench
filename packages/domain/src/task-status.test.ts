import { describe, it, expect } from 'vitest';
import type { RunCondition, TaskPhase } from './lifecycle.js';
import {
  deriveTaskStatus,
  DERIVED_STATUS_LABEL,
  ATTENTION_STATUSES,
  type DerivedTaskStatus,
} from './task-status.js';

describe('deriveTaskStatus', () => {
  it.each<[RunCondition, TaskPhase, DerivedTaskStatus]>([
    ['completed', 'release', 'completed'],
    ['failed', 'implement', 'failed'],
    ['cancelled', 'plan', 'cancelled'],
    ['blocked', 'implement', 'blocked'],
    ['awaiting-human', 'plan', 'awaiting-human'],
    ['awaiting-external', 'verify', 'awaiting-external'],
    ['running', 'specify', 'queued'],
    ['running', 'plan', 'planning'],
    ['running', 'implement', 'running'],
    ['running', 'release', 'running'],
  ])('condition=%s phase=%s → %s', (condition, phase, expected) => {
    expect(deriveTaskStatus(condition, phase)).toBe(expected);
  });

  it('condition wins over phase (a completed task in specify is completed, not queued)', () => {
    expect(deriveTaskStatus('completed', 'specify')).toBe('completed');
  });
});

describe('status metadata', () => {
  it('has a label for every derived status', () => {
    const statuses = Object.keys(DERIVED_STATUS_LABEL) as DerivedTaskStatus[];
    for (const s of statuses) {
      expect(DERIVED_STATUS_LABEL[s]).toBeTruthy();
    }
  });

  it('attention set is exactly the human-needs-to-look subset', () => {
    expect([...ATTENTION_STATUSES].sort()).toEqual(['awaiting-human', 'blocked', 'failed']);
  });
});
