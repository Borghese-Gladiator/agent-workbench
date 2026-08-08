import type { QaAssertionResult } from './shared.js';
import { isStrongAssertion } from './shared.js';

/**
 * TASK-42: check that QA actually exercises each behavioral claim's observable behaviour, not
 * merely that a scenario ran for it. `everyBehavioralClaimCovered` was hard-coded `true` at the
 * exercise gate; this computes it honestly.
 *
 * A behavioral claim is *covered* only when at least one QA assertion is both:
 *  - strong (a state-transition or value-match, not a liveness/existence check), and
 *  - passing.
 *
 * The planner's expected per-claim assertions (`ClaimCoverage.expectedAssertions`) declare the
 * transition the QA author must observe; when present for a claim they raise the bar — the claim
 * needs a passing strong assertion whose name references the claim (so a strong assertion for a
 * *different* claim doesn't vacuously cover this one).
 */
export interface BehavioralClaimCoverageInput {
  /** Ids of behavioral claims that require QA evidence. */
  behavioralClaimIds: string[];
  /** Assertions produced by the QA run. */
  assertions: QaAssertionResult[];
  /** claimId → whether the planner declared an expected assertion for it. */
  claimHasExpectedAssertion?: (claimId: string) => boolean;
  /** claimId → whether a given assertion is meant to exercise it (name/detail references the claim). */
  assertionCoversClaim?: (claimId: string, assertion: QaAssertionResult) => boolean;
}

export interface BehavioralClaimCoverageResult {
  everyBehavioralClaimCovered: boolean;
  /** Behavioral claim ids with no passing strong assertion exercising them. */
  missing: string[];
}

export function evaluateBehavioralClaimCoverage(
  input: BehavioralClaimCoverageInput,
): BehavioralClaimCoverageResult {
  const passingStrong = input.assertions.filter((a) => a.passed && isStrongAssertion(a));
  const missing: string[] = [];

  for (const claimId of input.behavioralClaimIds) {
    const expectsSpecific = input.claimHasExpectedAssertion?.(claimId) ?? false;
    const covered = expectsSpecific
      ? passingStrong.some((a) => input.assertionCoversClaim?.(claimId, a) ?? false)
      : passingStrong.length > 0;
    if (!covered) missing.push(claimId);
  }

  return { everyBehavioralClaimCovered: missing.length === 0, missing };
}
