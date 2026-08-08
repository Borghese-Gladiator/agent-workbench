import type { Finding } from '@awb/domain';
import type { ReviewInputs } from './review-inputs.js';

/**
 * An advisory maintainability review, distinct from correctness.
 *
 * WSFF's thesis is correctness ≠ maintainability, and maintainability has no reliable model
 * self-signal ("if a model could tell good code from bad it would have written the good version").
 * Every other gate (verify, QA, the adversarial reviewer) answers *does it work*. This pass
 * instead *surfaces candidates* for human attention — new duplication, tight coupling / layering
 * violations, single-caller abstractions, naming inconsistent with the surrounding code — as
 * advisory annotations that never block the run.
 *
 * By construction every finding it emits is advisory: category `maintainability`, severity `note`.
 * The challenge gate only blocks on open `blocker`/`high` findings, so these are non-blocking; we
 * additionally clamp them here so a mis-scripted reviewer cannot turn an advisory note into a
 * blocker.
 */
export interface MaintainabilityReviewInput {
  taskId: string;
  reviewInputs: ReviewInputs;
  /**
   * Produces the reviewer's raw maintainability observations for a single fresh session. The
   * caller owns adapter.createSession + adapter.execute (same pattern as runAdversarialReview);
   * this function owns only the surrounding shape + the advisory clamp.
   */
  runReviewer: (reviewInputs: ReviewInputs) => Promise<MaintainabilityReviewSessionResult>;
}

export interface MaintainabilityReviewSessionResult {
  reviewerSessionId: string;
  completed: boolean;
  /** Raw candidate findings; severity/category are re-clamped to advisory regardless of input. */
  findings: Finding[];
  summary: string;
}

export interface MaintainabilityReviewResult {
  reviewerSessionId: string;
  completed: boolean;
  /** Advisory-only findings (category `maintainability`, severity `note`, status `open`). */
  findings: Finding[];
  summary: string;
}

/** Forces a finding to be advisory: maintainability category, note severity. */
export function toAdvisoryFinding(finding: Finding): Finding {
  return { ...finding, category: 'maintainability', severity: 'note' };
}

export async function runMaintainabilityReview(
  input: MaintainabilityReviewInput,
): Promise<MaintainabilityReviewResult> {
  const sessionResult = await input.runReviewer(input.reviewInputs);
  return {
    reviewerSessionId: sessionResult.reviewerSessionId,
    completed: sessionResult.completed,
    findings: sessionResult.findings.map(toAdvisoryFinding),
    summary: sessionResult.summary,
  };
}

/**
 * True when every finding is advisory (maintainability + note). Guards the invariant that this
 * pass can never contribute a blocking finding to the challenge gate.
 */
export function everyFindingIsAdvisory(findings: Finding[]): boolean {
  return findings.every((f) => f.category === 'maintainability' && f.severity === 'note');
}
