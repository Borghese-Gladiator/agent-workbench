import type { UnmetCriterionReason } from '@awb/domain';

/**
 * Conditions that mark an acceptance claim unproven. Each function answers "does this specific
 * condition hold right now" — pure and independent of the others, so the caller (a phase Activity)
 * evaluates whichever conditions are relevant to what it just observed.
 *
 * These used to raise a human gate. Since the autonomy pivot (TASK-104) nothing waits on a human:
 * a condition that holds becomes a labelled unmet criterion in the draft PR's report instead.
 */

export interface PlanGateInputs {
  introducesNewDependency: boolean;
  changesPublicApi: boolean;
  changesAuthOrAuthorization: boolean;
  touchesPaymentsSecretsOrDestructiveMigration: boolean;
  expandsTaskScope: boolean;
  requiresUnvalidatedOrPrivilegedCommand: boolean;
  requestsHostAccessOutsideWorktree: boolean;
  requestsArbitraryExternalNetworkAccess: boolean;
}

export function conditionalPlanGateReasons(inputs: PlanGateInputs): UnmetCriterionReason[] {
  const reasons: UnmetCriterionReason[] = [];
  if (inputs.introducesNewDependency) reasons.push('new-dependency');
  if (inputs.changesPublicApi) reasons.push('public-api-change');
  if (inputs.changesAuthOrAuthorization) reasons.push('auth-change');
  if (inputs.touchesPaymentsSecretsOrDestructiveMigration) reasons.push('sensitive-change');
  if (inputs.expandsTaskScope) reasons.push('scope-expansion');
  if (inputs.requiresUnvalidatedOrPrivilegedCommand) reasons.push('unvalidated-privileged-command');
  if (inputs.requestsHostAccessOutsideWorktree) reasons.push('host-access-request');
  if (inputs.requestsArbitraryExternalNetworkAccess) reasons.push('external-network-request');
  return reasons;
}

export function plannerCriticNonConvergence(attemptCount: number, maxAttempts: number): boolean {
  return attemptCount >= maxAttempts;
}

export function flakyBaselineBlocksCompletion(sameCommandDifferentResultCount: number, threshold = 2): boolean {
  return sameCommandDifferentResultCount >= threshold;
}

export function repeatedFailureNoProgress(consecutiveIdenticalFingerprints: number, threshold = 3): boolean {
  return consecutiveIdenticalFingerprints >= threshold;
}

export function tokenOrRuntimeBudgetExceeded(
  usedTokens: number,
  tokenBudget: number,
  usedRuntimeMs: number,
  runtimeBudgetMs: number,
): boolean {
  return usedTokens >= tokenBudget || usedRuntimeMs >= runtimeBudgetMs;
}

export function qaRemainsInconclusive(anyScenarioInconclusive: boolean): boolean {
  return anyScenarioInconclusive;
}

export function reviewerFindingRequiresProductDecision(findingCategory: string): boolean {
  return findingCategory === 'requirements';
}

export function waiverRequested(waiverRequestPresent: boolean): boolean {
  return waiverRequestPresent;
}

/**
 * A routine low-risk change needs no extra scrutiny in the plan's report. Returns true only when the
 * change is high-risk or at least one conditional trigger actually fired, so an ordinary task's PR
 * is not padded with a risk section it does not need.
 *
 * The three mandatory gates this module used to export (`first-time-repository-trust`,
 * `task-contract-approval`, `pr-readiness`) are gone (TASK-104). Repository trust is now the
 * persisted `repositories.trusted` flag, checked once when the task is created; the other two were
 * deleted, because the workbench no longer asks a human for permission to continue.
 */
export function requiresPlanRiskReport(isHighRisk: boolean, conditionalReasons: UnmetCriterionReason[]): boolean {
  return isHighRisk || conditionalReasons.length > 0;
}
