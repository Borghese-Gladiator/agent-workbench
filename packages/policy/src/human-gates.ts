import type { HumanGateReason } from '@awb/domain';

/**
 * Conditional human-gate trigger conditions (product spec §14). Each function answers "does this
 * specific condition require a HumanGate right now" — pure and independent of the others, so the
 * caller (a phase Activity) evaluates whichever conditions are relevant to what it just observed
 * and creates a HumanGate for the first one that returns true.
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

export function conditionalPlanGateReasons(inputs: PlanGateInputs): HumanGateReason[] {
  const reasons: HumanGateReason[] = [];
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
 * A routine low-risk task must not require a human plan approval (product spec §14: "Do not
 * require a routine human plan approval for ordinary low-risk tasks"). Returns true only when at
 * least one conditional trigger actually fired.
 */
export function requiresPlanApprovalGate(isHighRisk: boolean, conditionalReasons: HumanGateReason[]): boolean {
  return isHighRisk || conditionalReasons.length > 0;
}
