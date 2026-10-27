import { createHash } from 'node:crypto';
import type { Evidence } from '@awb/domain';

export interface FreshnessExpectation {
  candidateSha?: string;
  environmentDigest?: string;
  contractVersion: number;
  planVersion?: number;
}

/**
 * An Evidence record is "fresh" only when every identifier it was produced under matches the
 * task's CURRENT values exactly (product spec §11: "Results are tied to the exact candidate SHA"
 * / "environment digest" / etc). A mismatch on any single field makes the evidence stale — this
 * is a strict equality check, not a heuristic, by design.
 */
export function isEvidenceFresh(evidence: Evidence, expected: FreshnessExpectation): boolean {
  if (expected.candidateSha !== undefined && evidence.candidateSha !== expected.candidateSha) return false;
  if (expected.environmentDigest !== undefined && evidence.environmentDigest !== expected.environmentDigest) {
    return false;
  }
  if (evidence.contractVersion !== expected.contractVersion) return false;
  if (expected.planVersion !== undefined && evidence.planVersion !== expected.planVersion) return false;
  return true;
}

export function anyEvidenceStale(evidenceList: Evidence[], expected: FreshnessExpectation): boolean {
  return evidenceList.some((e) => !isEvidenceFresh(e, expected));
}

/**
 * A stable, order-independent hash over a set of artifact ids — used as the
 * `CompletionCandidate.artifactManifestHash` (product spec §10). Same artifact set, any order, ->
 * same hash; a differing artifact set -> a different hash.
 */
export function computeArtifactManifestHash(artifactIds: string[]): string {
  const sorted = [...artifactIds].sort();
  return createHash('sha256').update(sorted.join(',')).digest('hex');
}
