import { randomUUID } from 'node:crypto';
import type { Evidence, EvidenceKind, EvidenceStatus } from '@awb/domain';

/**
 * TASK-42: how strong an assertion is, so the gate can distinguish "the feature is wired and
 * live" from "the feature is correct".
 *  - `liveness`   — the step merely did not throw (navigate/click succeeded, an element exists).
 *                   Proves the wiring is alive; proves nothing about behaviour.
 *  - `state-transition` — observed that an action produced the expected post-action state
 *                   (e.g. a card was beaten, a element appeared/disappeared).
 *  - `value-match` — compared an observed value against an expected value.
 * A scenario made only of `liveness` assertions is trivially weak (see `scenarioStrength`).
 */
export type QaAssertionStrength = 'liveness' | 'state-transition' | 'value-match';

/**
 * One structured, typed assertion result. Per product spec §23: "A video alone does not pass
 * QA. Structured assertions determine pass or failure." Every QA executor produces a list of
 * these independent of whatever recording/trace artifact it also captures.
 */
export interface QaAssertionResult {
  name: string;
  passed: boolean;
  detail?: string;
  /** TASK-42: assertion strength; defaults to `liveness` when a producer omits it. */
  strength?: QaAssertionStrength;
}

/** True when an assertion observes real behaviour (a state transition or a value comparison). */
export function isStrongAssertion(a: QaAssertionResult): boolean {
  return a.strength === 'state-transition' || a.strength === 'value-match';
}

/**
 * TASK-42: classify a scenario's assertions. A scenario is `weak` when every assertion is a
 * liveness check (did-not-throw / existence) — it passes exactly like one that exercises the
 * real behaviour, so the challenge phase treats it as a QA-quality finding rather than a silent
 * pass. `strong` means at least one assertion observes a state transition or a value.
 */
export function scenarioStrength(assertions: QaAssertionResult[]): 'weak' | 'strong' {
  return assertions.some(isStrongAssertion) ? 'strong' : 'weak';
}

/**
 * TASK-42: whether a browser QA run hit a policy-blocking runtime signal — an unhandled console
 * error, a failed/4xx+ network request, or a leaked/duplicate WebSocket open. Feeds the exercise
 * gate's `policyBlockingErrorsPresent` (was hard-coded false), so a page that throws errors or
 * opens N>1 sockets per action no longer passes QA.
 */
export function policyBlockingErrorsPresent(input: {
  consoleErrors: string[];
  failedRequests: string[];
  socketAnomalies: string[];
}): boolean {
  return (
    input.consoleErrors.length > 0 ||
    input.failedRequests.length > 0 ||
    input.socketAnomalies.length > 0
  );
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
