import { randomUUID } from 'node:crypto';
import type { QaEvidenceContext } from './shared.js';

export function makeQaEvidenceContext(overrides: Partial<QaEvidenceContext> = {}): QaEvidenceContext {
  return {
    taskId: `task-${randomUUID()}`,
    runId: `run-${randomUUID()}`,
    phaseAttemptId: `phase-${randomUUID()}`,
    repositorySnapshotId: `snapshot-${randomUUID()}`,
    contractVersion: 1,
    policyVersion: 'v1',
    claimIds: [],
    ...overrides,
  };
}
