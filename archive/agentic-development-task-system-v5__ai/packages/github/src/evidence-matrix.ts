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
