import { createCapabilityBroker } from '@awb/capability-broker';
import type { Finding } from '@awb/domain';
import type { ReviewInputs } from './review-inputs.js';

/** Capability-scoped tool list for the adversarial-reviewer role, ready to pass into CreateAgentSessionInput. */
export function allowedToolsForRole(): string[] {
  return [...createCapabilityBroker('adversarial-reviewer').listGranted()];
}

export interface AdversarialReviewInput {
  taskId: string;
  cwd: string;
  reviewInputs: ReviewInputs;
  /**
   * Produces the reviewer's findings for a single fresh session. The caller is responsible for
   * calling adapter.createSession + adapter.execute (same pattern as the planner/plan-critic
   * loop) — this function only owns the surrounding shape, not the provider-specific prompt.
   */
  runReviewer: (reviewInputs: ReviewInputs) => Promise<AdversarialReviewSessionResult>;
}

/** What the caller-supplied runReviewer callback must report back about the session it ran. */
export interface AdversarialReviewSessionResult {
  reviewerSessionId: string;
  completed: boolean;
  findings: Finding[];
  summary: string;
}

export interface AdversarialReviewResult {
  reviewerSessionId: string;
  completed: boolean;
  findings: Finding[];
  summary: string;
}

/**
 * Runs a single fresh adversarial-review session (product spec §24). Unlike the planner <-> critic
 * loop, review is not a back-and-forth with another agent — it is one read-only session per
 * attempt, whose findings are returned to the caller for downstream lifecycle handling and
 * completion-gate evaluation.
 */
export async function runAdversarialReview(input: AdversarialReviewInput): Promise<AdversarialReviewResult> {
  const sessionResult = await input.runReviewer(input.reviewInputs);
  return {
    reviewerSessionId: sessionResult.reviewerSessionId,
    completed: sessionResult.completed,
    findings: sessionResult.findings,
    summary: sessionResult.summary,
  };
}

/**
 * Completion-gate predicates matching product spec §11's Challenge criteria.
 */

/** Spec §11: "The reviewer session differs from the builder session." */
export function reviewerSessionDiffersFromBuilder(reviewerSessionId: string, builderSessionId: string): boolean {
  return reviewerSessionId !== builderSessionId;
}

/** Spec §11: no open finding at blocker or high severity. */
export function noBlockerOrHighFindingOpen(findings: Finding[]): boolean {
  return !findings.some((f) => f.status === 'open' && (f.severity === 'blocker' || f.severity === 'high'));
}

/** True only if every finding's status is resolved, invalid, or waived — never "open". */
export function everyFindingResolvedInvalidatedOrWaived(findings: Finding[]): boolean {
  return findings.every((f) => f.status === 'resolved' || f.status === 'invalid' || f.status === 'waived');
}

/**
 * A cheap presence/non-empty proxy check across the required ReviewInputs fields. This does NOT
 * prove the reviewer actually read or reasoned about any of these inputs — it only proves the
 * caller supplied them. Treat it as a necessary-but-not-sufficient precondition, not a semantic
 * verification of reviewer diligence.
 */
export function reviewerExaminedAllRequiredInputs(reviewInputs: ReviewInputs): boolean {
  return (
    reviewInputs.taskContract !== undefined &&
    reviewInputs.plan !== undefined &&
    reviewInputs.finalDiff.trim().length > 0 &&
    reviewInputs.verificationEvidenceIds.length > 0 &&
    reviewInputs.qaEvidenceIds.length > 0
  );
}
