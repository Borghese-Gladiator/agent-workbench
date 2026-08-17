import type { QaAssertionResult } from './shared.js';
import { isStrongAssertion } from './shared.js';

/**
 * Check that QA actually exercises each behavioral claim's observable behaviour, not
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

export interface UntouchedTargetInput {
  behavioralClaimIds: string[];
  claimTargetPaths: Map<string, string[]>;
  changedPaths: string[];
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathMatchesTarget(changed: string, target: string): boolean {
  const c = normalizePath(changed);
  const t = normalizePath(target);
  if (c === t) return true;
  return c.startsWith(`${t}/`) || t.startsWith(`${c}/`);
}

/**
 * Behavioral claim ids whose committed diff misses the mark: the plan associated the claim with
 * at least one target path (`PlanSlice.likelyPaths` on a slice covering the claim), yet the
 * committed `base..candidate` diff touches none of them. Non-empty ⇒ a no-op / off-target
 * candidate (e.g. a builder that committed only `package-lock.json` for a README claim), which
 * the exercise gate must reject. A claim with no declared target paths is never reported — the
 * plan gave nothing to compare against, so blocking on it would be a false negative.
 */
export function behavioralClaimsWithUntouchedTarget(input: UntouchedTargetInput): string[] {
  const untouched: string[] = [];
  for (const claimId of input.behavioralClaimIds) {
    const targets = (input.claimTargetPaths.get(claimId) ?? []).filter(Boolean);
    if (targets.length === 0) continue;
    const touched = targets.some((t) => input.changedPaths.some((c) => pathMatchesTarget(c, t)));
    if (!touched) untouched.push(claimId);
  }
  return untouched;
}
