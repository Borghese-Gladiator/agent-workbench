import { describe, expect, it } from 'vitest';
import { isEvidenceFresh, anyEvidenceStale, computeArtifactManifestHash } from './evidence-freshness.js';
import type { Evidence } from '@awb/domain';

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev-1',
    taskId: 'task-1',
    runId: 'run-1',
    phaseAttemptId: 'pa-1',
    kind: 'unit-test',
    status: 'passed',
    claimIds: [],
    contractVersion: 1,
    planVersion: 1,
    repositorySnapshotId: 'snap-1',
    candidateSha: 'sha-a',
    environmentDigest: 'digest-a',
    policyVersion: 'v1',
    artifactIds: [],
    summary: 'ok',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const expected = { candidateSha: 'sha-a', environmentDigest: 'digest-a', contractVersion: 1, planVersion: 1 };

describe('isEvidenceFresh', () => {
  it('is fresh when every identifier matches exactly', () => {
    expect(isEvidenceFresh(makeEvidence(), expected)).toBe(true);
  });

  it('is stale when the candidate SHA differs', () => {
    expect(isEvidenceFresh(makeEvidence({ candidateSha: 'sha-b' }), expected)).toBe(false);
  });

  it('is stale when the environment digest differs', () => {
    expect(isEvidenceFresh(makeEvidence({ environmentDigest: 'digest-b' }), expected)).toBe(false);
  });

  it('is stale when the contract version differs', () => {
    expect(isEvidenceFresh(makeEvidence({ contractVersion: 2 }), expected)).toBe(false);
  });

  it('is stale when the plan version differs', () => {
    expect(isEvidenceFresh(makeEvidence({ planVersion: 2 }), expected)).toBe(false);
  });
});

describe('anyEvidenceStale', () => {
  it('is false when all evidence is fresh', () => {
    expect(anyEvidenceStale([makeEvidence(), makeEvidence()], expected)).toBe(false);
  });

  it('is true when any single evidence item is stale', () => {
    expect(anyEvidenceStale([makeEvidence(), makeEvidence({ candidateSha: 'sha-stale' })], expected)).toBe(true);
  });
});

describe('computeArtifactManifestHash', () => {
  it('is identical regardless of artifact id order', () => {
    expect(computeArtifactManifestHash(['a', 'b', 'c'])).toBe(computeArtifactManifestHash(['c', 'a', 'b']));
  });

  it('differs when the artifact id set differs', () => {
    expect(computeArtifactManifestHash(['a', 'b'])).not.toBe(computeArtifactManifestHash(['a', 'b', 'c']));
  });
});
