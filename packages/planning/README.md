# @awb/planning

## Purpose

Task-contract generation, the bounded planner ↔ plan-critic loop, and the
builder's per-slice implementation loop (product spec §6, §20, §21).

## Responsibilities

- `contract.ts` — `draftContract`/`reviseContract` and status transitions
  (draft → awaiting_approval → approved/rejected/superseded), plus
  `contractCompletionInputs()` which feeds `@awb/workflow`'s
  `CompletionContext.specify` shape directly.
- `plan.ts` — `draftPlan`/`revisePlan`: claim coverage (`ClaimCoverage`) is
  **derived** from each `PlanSlice`'s declared `claimIds`, never
  hand-authored separately, so a planner can't silently omit coverage.
  Also the three Plan-phase completion predicates
  (`everyClaimMappedToSlice`, `everyBehavioralClaimHasQaScenario`,
  `everySliceHasTargetedChecks`).
- `planner-critic-loop.ts` — `runPlannerCriticLoop()`: the bounded
  planner↔critic exchange (product spec §20). The planner and critic are
  always fresh, separate sessions (callers pass in `runPlanner`/`runCritic`
  functions that create a new `AgentSession` each call — this package
  doesn't cache or reuse sessions across attempts). Returns `"accepted"` or
  `"non-convergent"` after `maxAttempts` — never loops unboundedly.
  `allowedToolsForRole()` derives the tool allowlist from
  `@awb/capability-broker` so callers don't hand-roll it.
- `builder-loop.ts` — `runSliceLoop()`: one plan slice's bounded builder
  loop (product spec §21), using `@awb/workflow`'s failure-fingerprinting
  and no-progress detection. Detects both repeated identical failures and
  repeated no-meaningful-diff attempts (an edit/revert loop), returning
  `"success"`, `"no-progress"`, or `"budget-exhausted"`.

## Does NOT

- Talk to an agent provider directly inside its own logic — `runPlanner`/
  `runCritic`/`runAttempt` are caller-supplied functions; this package only
  owns the loop/bounding logic, not session creation. See
  `mock-adapter-integration.test.ts` for how a caller wires this package to
  `@awb/agent-gateway`'s `MockAgentAdapter`.
- Persist contracts/plans to SQLite — that's the daemon's job once it
  exists (Milestone 10); this package returns fully-formed domain objects.
- Decide phase completion — `contractCompletionInputs()` and the Plan
  predicates feed `@awb/workflow`'s `evaluatePhaseCompletion`, they don't
  duplicate its decision.

## Dependencies

`@awb/domain`, `@awb/agent-gateway`, `@awb/capability-broker`,
`@awb/workflow`.
