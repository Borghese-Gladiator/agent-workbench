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
- `requiresPlanRiskReport` — encodes "say nothing extra about an ordinary
  low-risk task": only high risk or an actual conditional trigger adds a risk
  section to the plan's report.

## Does NOT

- Park a task on a human. Since the autonomy pivot (TASK-104) there are no
  human gates: callers (phase Activities in `workers/temporal-worker`) use
  these predicates to LABEL an unmet acceptance criterion, which the draft PR
  reports. The three mandatory gates are gone — repository trust is the
  persisted `repositories.trusted` flag, and contract approval and PR
  readiness were deleted.
- Duplicate `packages/workflow`'s `shouldStopLooping` (repeated-failure /
  budget-exhaustion routing during the phase loop) — this package covers the
  broader conditional table; `packages/workflow`'s version is scoped
  specifically to the loop's stop decision.

## Dependencies

`@awb/domain`.
