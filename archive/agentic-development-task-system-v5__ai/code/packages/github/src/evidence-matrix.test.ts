import { describe, expect, it } from 'vitest';
import { renderEvidenceMatrix } from './evidence-matrix.js';
import type { Evidence } from '@awb/domain';

function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'ev-1',
    taskId: 'task-1',
    runId: 'run-1',
    phaseAttemptId: 'pa-1',
    kind: 'unit-test',
    status: 'passed',
    claimIds: ['claim-1'],
    contractVersion: 1,
    repositorySnapshotId: 'snap-1',
    policyVersion: 'v1',
    artifactIds: [],
    summary: 'all good',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('renderEvidenceMatrix', () => {
  it('renders a markdown table row per evidence item', () => {
    const md = renderEvidenceMatrix(
      [makeEvidence({ kind: 'unit-test', status: 'passed' }), makeEvidence({ kind: 'qa-video', status: 'failed' })],
      'a'.repeat(40),
    );
    expect(md).toContain('| unit-test | passed |');
    expect(md).toContain('| qa-video | failed |');
  });

  it('includes a shortened candidate SHA in the heading', () => {
    const sha = 'b'.repeat(40);
    const md = renderEvidenceMatrix([makeEvidence()], sha);
    expect(md).toContain(sha.slice(0, 12));
  });

  it('renders a placeholder row when there is no evidence', () => {
    const md = renderEvidenceMatrix([], 'c'.repeat(40));
    expect(md).toContain('no evidence recorded');
  });

  it('renders claim ids joined by comma, or an em-dash placeholder when empty', () => {
    const withClaims = renderEvidenceMatrix([makeEvidence({ claimIds: ['c1', 'c2'] })], 'd'.repeat(40));
    expect(withClaims).toContain('c1, c2');

    const withoutClaims = renderEvidenceMatrix([makeEvidence({ claimIds: [] })], 'd'.repeat(40));
    expect(withoutClaims).toMatch(/\| — \|/);
  });
});
