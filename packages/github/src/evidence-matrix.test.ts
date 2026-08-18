import { describe, expect, it } from 'vitest';
import { renderEvidenceMatrix, buildClaimChecklist, renderClaimChecklist } from './evidence-matrix.js';
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

describe('buildClaimChecklist', () => {
  const sha = 'a'.repeat(40);

  it('marks a claim met when passing evidence references it', () => {
    const entries = buildClaimChecklist(
      [makeEvidence({ claimIds: ['c1'], status: 'passed', kind: 'unit-test', summary: 'ok' })],
      ['c1'],
      sha,
    );
    expect(entries[0]).toMatchObject({ claimId: 'c1', met: true });
    expect(entries[0]?.evidenceSummary).toContain('unit-test');
  });

  it('marks a claim unmet with a reason + last SHA when only failing evidence references it', () => {
    const entries = buildClaimChecklist(
      [makeEvidence({ claimIds: ['c1'], status: 'failed', kind: 'qa-video', summary: 'assertion failed' })],
      ['c1'],
      sha,
    );
    expect(entries[0]).toMatchObject({ claimId: 'c1', met: false, lastCandidateSha: sha });
    expect(entries[0]?.reason).toContain('qa-video failed');
  });

  it('marks a claim unmet when no evidence references it at all', () => {
    const entries = buildClaimChecklist([], ['c1'], sha);
    expect(entries[0]).toMatchObject({ claimId: 'c1', met: false });
    expect(entries[0]?.reason).toContain('no passing evidence');
  });
});

describe('renderClaimChecklist', () => {
  it('renders met rows checked with evidence and unmet rows unchecked with reason + SHA', () => {
    const md = renderClaimChecklist([
      { claimId: 'c1', met: true, evidenceSummary: 'unit-test: ok' },
      { claimId: 'c2', met: false, reason: 'qa-video failed', lastCandidateSha: 'b'.repeat(40) },
    ]);
    expect(md).toContain('- [x] `c1` — unit-test: ok');
    expect(md).toContain('- [ ] `c2` — qa-video failed (last candidate `bbbbbbbbbbbb`)');
    expect(md).toContain('### Acceptance criteria');
  });

  it('returns empty for no entries', () => {
    expect(renderClaimChecklist([])).toBe('');
  });
});
