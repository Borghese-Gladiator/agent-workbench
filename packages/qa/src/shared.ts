import { randomUUID } from 'node:crypto';
import type { Evidence, EvidenceKind, EvidenceStatus } from '@awb/domain';

/**
 * One structured, typed assertion result. Per product spec §23: "A video alone does not pass
 * QA. Structured assertions determine pass or failure." Every QA executor produces a list of
 * these independent of whatever recording/trace artifact it also captures.
 */
export interface QaAssertionResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface QaEvidenceContext {
  taskId: string;
  runId: string;
  phaseAttemptId: string;
  repositorySnapshotId: string;
  contractVersion: number;
  planVersion?: number;
  candidateSha?: string;
  baseSha?: string;
  environmentDigest?: string;
  scenarioVersion?: number;
  policyVersion: string;
  claimIds: string[];
}

/**
 * Derives Evidence.status from real assertion results plus whether the required
 * recording/trace artifact was actually produced (product spec §23):
 *  - "inconclusive" if execution itself errored/timed out before assertions could run — this
 *    takes priority over any assertion outcome, since an error means the scripted assertions
 *    never got a fair chance to run against real output
 *  - "failed" if execution completed and any assertion explicitly failed
 *  - "inconclusive" if the required artifact was never produced, even if assertions passed
 *  - "passed" only if every assertion passed AND the required artifact exists
 */
export function deriveQaStatus(
  assertions: QaAssertionResult[],
  requiredArtifactProduced: boolean,
  executionErrored: boolean,
): EvidenceStatus {
  if (executionErrored) return 'inconclusive';
  if (assertions.some((a) => !a.passed)) return 'failed';
  if (!requiredArtifactProduced) return 'inconclusive';
  return 'passed';
}

export interface ProduceQaEvidenceInput {
  kind: EvidenceKind;
  assertions: QaAssertionResult[];
  requiredArtifactProduced: boolean;
  executionErrored: boolean;
  artifactIds: string[];
  summary: string;
  context: QaEvidenceContext;
}

/** Builds the final Evidence record for a QA executor run, mirroring @awb/verification's pattern. */
export function produceQaEvidence(input: ProduceQaEvidenceInput): Evidence {
  const { kind, assertions, requiredArtifactProduced, executionErrored, artifactIds, summary, context } =
    input;
  const status = deriveQaStatus(assertions, requiredArtifactProduced, executionErrored);

  return {
    id: randomUUID(),
    taskId: context.taskId,
    runId: context.runId,
    phaseAttemptId: context.phaseAttemptId,
    kind,
    status,
    claimIds: context.claimIds,
    contractVersion: context.contractVersion,
    planVersion: context.planVersion,
    repositorySnapshotId: context.repositorySnapshotId,
    baseSha: context.baseSha,
    candidateSha: context.candidateSha,
    environmentDigest: context.environmentDigest,
    scenarioVersion: context.scenarioVersion,
    policyVersion: context.policyVersion,
    artifactIds,
    summary,
    createdAt: new Date().toISOString(),
  };
}
