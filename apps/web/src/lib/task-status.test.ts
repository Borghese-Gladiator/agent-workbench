import { describe, expect, it } from 'vitest';
import {
  DERIVED_STATUS_LABEL,
  deriveTaskStatus,
  statusPresentation,
  type DerivedTaskStatus,
} from './task-status.js';

describe('statusPresentation', () => {
  it('maps every canonical status to its label', () => {
    for (const status of Object.keys(DERIVED_STATUS_LABEL) as DerivedTaskStatus[]) {
      expect(statusPresentation(status).label).toBe(DERIVED_STATUS_LABEL[status]);
    }
  });

  it('falls back to outline for an unknown status', () => {
    expect(statusPresentation('mystery')).toEqual({ label: 'mystery', badgeVariant: 'outline' });
  });
});

describe('deriveTaskStatus (mirror of domain)', () => {
  it.each([
    ['running', 'specify', 'queued'],
    ['running', 'plan', 'planning'],
    ['running', 'implement', 'running'],
    ['completed', 'deliver', 'completed'],
    ['failed', 'implement', 'failed'],
    ['blocked', 'qa', 'blocked'],
    ['awaiting-human', 'plan', 'awaiting-human'],
  ])('condition=%s phase=%s → %s', (condition, phase, expected) => {
    expect(deriveTaskStatus(condition, phase)).toBe(expected);
  });
});
