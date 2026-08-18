# @awb/policy

## Purpose

The conditional human-gate trigger conditions — pure predicates, independent
of Temporal/database/agent concerns.

## Responsibilities

- `conditionalPlanGateReasons` — evaluates the eight conditional plan-time
  triggers (new dependency, public API change, auth change, sensitive
  change, scope expansion, unvalidated/privileged command, host-access
  request, external-network request) and returns which ones fired.
- `plannerCriticNonConvergence`, `flakyBaselineBlocksCompletion`,
  `qaRemainsInconclusive`, `reviewerFindingRequiresProductDecision`,
  `waiverRequested` — the remaining conditional triggers, each a small pure
  function so every condition is independently unit-tested. (The
  `repeatedFailureNoProgress` / `tokenOrRuntimeBudgetExceeded` predicates and
  the `MANDATORY_GATE_REASONS` / `isMandatoryGate` mandatory-gate list were
  removed in the autonomy pivot, TASK-104/105: the loop no longer blocks on a
  human — budget exhaustion and no-progress now terminate as `UnmetCriteria`
  via `packages/workflow`'s `evaluateLoopBudget`, and repository trust is a
  one-time config flag, not a per-run gate.)
- `requiresPlanApprovalGate` — encodes "do not require routine human plan
  approval for ordinary low-risk tasks": only high risk or an
  actual conditional trigger forces a gate.

## Does NOT

- Create or persist `HumanGate` rows — callers (phase Activities in
  `workers/temporal-worker`) use these predicates to decide whether to
  construct one.
- Decide loop termination. Budget exhaustion / no-progress routing lives in
  `packages/workflow`'s `evaluateLoopBudget`, which terminates the loop as
  `UnmetCriteria` (a draft PR) rather than escalating to a human; this package
  covers only the conditional plan-gate table.

## Dependencies

`@awb/domain`.
