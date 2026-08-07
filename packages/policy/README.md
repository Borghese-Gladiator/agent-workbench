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
  `repeatedFailureNoProgress`, `tokenOrRuntimeBudgetExceeded`,
  `qaRemainsInconclusive`, `reviewerFindingRequiresProductDecision`,
  `waiverRequested` — the remaining conditional triggers, each a small pure
  function so every condition is independently unit-tested.
- `MANDATORY_GATE_REASONS` / `isMandatoryGate` — the three gates that are
  never conditional (first-time repository trust, task-contract approval,
  PR readiness) — always required, not evaluated against a condition.
- `requiresPlanApprovalGate` — encodes "do not require routine human plan
  approval for ordinary low-risk tasks": only high risk or an
  actual conditional trigger forces a gate.

## Does NOT

- Create or persist `HumanGate` rows — callers (phase Activities in
  `workers/temporal-worker`) use these predicates to decide whether to
  construct one.
- Duplicate `packages/workflow`'s `shouldEscalateToHuman` (repeated-failure/
  budget-exhaustion routing during the phase loop) — this package covers
  the broader conditional-gate table; `packages/workflow`'s
  version is scoped specifically to the loop-routing escalation path.

## Dependencies

`@awb/domain`.
