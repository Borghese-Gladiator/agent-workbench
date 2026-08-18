import type { Evidence } from '@awb/domain';

/**
 * Renders a Markdown evidence-matrix table for posting to a draft PR (product spec §28: "Add an
 * evidence matrix"). Pure formatting — the caller supplies already-fetched Evidence records.
 */
export function renderEvidenceMatrix(evidence: Evidence[], candidateSha: string): string {
  const rows = evidence
    .map((e) => `| ${e.kind} | ${e.status} | ${e.claimIds.join(', ') || '—'} | ${e.summary} |`)
    .join('\n');

  return [
    `### Evidence matrix (candidate \`${candidateSha.slice(0, 12)}\`)`,
    '',
    '| Kind | Status | Claims | Summary |',
    '| --- | --- | --- | --- |',
    rows || '| — | — | — | no evidence recorded |',
  ].join('\n');
}

/**
 * One per-claim row for the PR-body success checklist (autonomy pivot, TASK-106). A claim is `met`
 * when passing evidence proved it (link the evidence); otherwise `unmet` with a reason and the last
 * candidate SHA so a reviewer can see exactly what remains before merge.
 */
export interface ClaimChecklistEntry {
  claimId: string;
  met: boolean;
  /** Human-readable evidence summary for a met claim (rendered as the "proof" cell). */
  evidenceSummary?: string;
  /** Optional deep link to the evidence for a met claim (e.g. an evidence matrix anchor). */
  evidenceUrl?: string;
  /** Why an unmet claim is not yet proven. */
  reason?: string;
  /** The last candidate SHA the loop produced, cited on unmet rows. */
  lastCandidateSha?: string;
}

/**
 * Map planned acceptance-claim ids to met/unmet checklist rows sourced from evidence. A claim is met
 * when at least one PASSED evidence record references it; unmet otherwise. Reuses the same Evidence
 * records the evidence matrix renders from, so the checklist and the matrix never disagree.
 */
export function buildClaimChecklist(
  evidence: Evidence[],
  plannedClaimIds: string[],
  candidateSha: string,
): ClaimChecklistEntry[] {
  return plannedClaimIds.map((claimId) => {
    const proving = evidence.find((e) => e.status === 'passed' && e.claimIds.includes(claimId));
    if (proving) {
      return { claimId, met: true, evidenceSummary: `${proving.kind}: ${proving.summary}` };
    }
    const failing = evidence.find((e) => e.status !== 'passed' && e.claimIds.includes(claimId));
    return {
      claimId,
      met: false,
      reason: failing ? `${failing.kind} ${failing.status}: ${failing.summary}` : 'no passing evidence recorded',
      lastCandidateSha: candidateSha,
    };
  });
}

/**
 * Render the per-claim met/unmet checklist as GitHub task-list Markdown for the PR body. Met rows
 * are checked and cite their evidence; unmet rows are unchecked and cite the reason + last candidate
 * SHA. Returns '' when there are no claims (the caller omits the section).
 */
export function renderClaimChecklist(entries: ClaimChecklistEntry[]): string {
  if (entries.length === 0) return '';
  const rows = entries.map((e) => {
    if (e.met) {
      const proof = e.evidenceUrl
        ? `[evidence](${e.evidenceUrl})`
        : e.evidenceSummary ?? 'proven by passing evidence';
      return `- [x] \`${e.claimId}\` — ${proof}`;
    }
    const sha = e.lastCandidateSha ? ` (last candidate \`${e.lastCandidateSha.slice(0, 12)}\`)` : '';
    return `- [ ] \`${e.claimId}\` — ${e.reason ?? 'not yet proven'}${sha}`;
  });
  return ['### Acceptance criteria', '', ...rows].join('\n');
}
