import type { ExpectedAssertion } from '@awb/domain';
import type { QaAssertionResult } from './shared.js';
import { isStrongAssertion } from './shared.js';
import type { BrowserQaStep } from './browser-qa.js';

/**
 * Optional per-claim control/assertion selector hints so `buildInteractiveScenarioSteps` can
 * resolve a real control + assertion target from an otherwise prose `ExpectedAssertion.observes`.
 * Keyed in the caller by claimId. When a hint is absent, the helper still emits a step whose
 * selectors are derived from `observes` text so the scenario is grounded in the declared transition.
 */
export interface InteractiveStepHint {
  observes: string;
  /** CSS/text selector of the control to click to trigger the transition. */
  controlSelector?: string;
  /** CSS/text selector whose post-action state/text is asserted. */
  assertionSelector?: string;
  /** Text the assertion element should contain (produces an `expectText` value-match). */
  assertionText?: string;
  /** When the control opens a WebSocket, also emit a repeated-click `expectNoDuplicateSocket`. */
  socketOpening?: boolean;
}

/**
 * Translate each planner-declared `ExpectedAssertion` into real browser steps so the exercise
 * scenario actually observes the claimed transition instead of only navigating. Each assertion
 * yields a click on its control followed by a strong assertion:
 *  - `state-transition` → `expectVisible`/`expectHidden` on the assertion target
 *  - `value-match`      → `expectText` when a target value is hinted, else `expectVisible`
 * A socket-opening control additionally gets a repeated-click `expectNoDuplicateSocket` step.
 *
 * Selectors come from the per-claim `hints` when provided; otherwise they fall back to a
 * text-selector derived from the `observes` prose so the step is at least grounded in the claim.
 */
export function buildInteractiveScenarioSteps(
  expectedAssertions: ExpectedAssertion[],
  hints?: Record<string, InteractiveStepHint>,
): BrowserQaStep[] {
  const steps: BrowserQaStep[] = [];
  for (const ea of expectedAssertions) {
    const hint = hints?.[ea.claimId];
    const controlSelector = hint?.controlSelector ?? `text=${ea.observes}`;
    const assertionSelector = hint?.assertionSelector ?? controlSelector;

    steps.push({ kind: 'click', selector: controlSelector });

    if (ea.kind === 'value-match' && hint?.assertionText !== undefined) {
      steps.push({ kind: 'expectText', selector: assertionSelector, equals: hint.assertionText });
    } else {
      steps.push({ kind: 'expectVisible', selector: assertionSelector });
    }

    if (hint?.socketOpening) {
      steps.push({ kind: 'expectNoDuplicateSocket', selector: controlSelector });
    }
  }
  return steps;
}

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
