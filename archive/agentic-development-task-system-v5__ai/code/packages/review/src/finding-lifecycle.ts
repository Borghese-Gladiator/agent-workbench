import type { Finding } from '@awb/domain';

/** Marks a finding resolved (the underlying issue was fixed). */
export function resolveFinding(finding: Finding): Finding {
  return { ...finding, status: 'resolved' };
}

/**
 * Marks a finding invalid (the reviewer was wrong / it doesn't apply). Requires a non-empty
 * reason string, since an invalidated finding needs justification to meet the evidence-quality
 * bar (product spec §24).
 */
export function invalidateFinding(finding: Finding, reason: string): Finding {
  if (reason.trim().length === 0) {
    throw new Error('invalidateFinding requires a non-empty reason');
  }
  return { ...finding, status: 'invalid' };
}

/**
 * A finding waiver, mirroring @awb/verification's waiver validity pattern (a waiver only counts
 * if it was human-approved). `reason` documents why the finding is being waived despite being
 * valid (e.g. accepted risk, out of scope for this task).
 */
export interface FindingWaiver {
  humanApproved: boolean;
  reason: string;
}

/** Marks a finding waived. Requires a human-approval marker — an agent cannot waive its own finding. */
export function waiveFinding(finding: Finding, waiver: FindingWaiver): Finding {
  if (!waiver.humanApproved) {
    throw new Error('waiveFinding requires humanApproved: true');
  }
  if (waiver.reason.trim().length === 0) {
    throw new Error('waiveFinding requires a non-empty reason');
  }
  return { ...finding, status: 'waived' };
}
