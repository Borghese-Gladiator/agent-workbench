# @awb/review

## Purpose

Deterministic scaffolding around the adversarial-review phase (product spec
§24): review-input assembly, the single-fresh-session review runner, the
Challenge-phase completion-gate predicates, finding lifecycle transitions,
and the probe-request shape.

## Responsibilities

- `review-inputs.ts` — `ReviewInputs`: the task contract, accepted plan,
  final diff, verification/QA evidence IDs, and repository invariants a
  reviewer must be given.
- `review-runner.ts` — `runAdversarialReview()`: unlike the planner↔critic
  exchange, review is one fresh read-only session per attempt, not a
  back-and-forth loop. The caller supplies a `runReviewer` callback that
  owns the actual `adapter.createSession`/`execute` calls (same pattern as
  `@awb/planning`'s planner-critic loop). Also exports the four Challenge
  completion-gate predicates from spec §11:
  `reviewerSessionDiffersFromBuilder`, `noBlockerOrHighFindingOpen`,
  `everyFindingResolvedInvalidatedOrWaived`,
  `reviewerExaminedAllRequiredInputs` (a documented non-empty/presence
  proxy — it proves the required inputs were supplied, not that the
  reviewer actually reasoned about them).
- `finding-lifecycle.ts` — `resolveFinding`/`invalidateFinding` (requires a
  reason)/`waiveFinding` (requires human approval), mirroring
  `@awb/verification`'s waiver-validity pattern.
- `probe.ts` — `ProbeRequest`: structurally has no patch/edit field, so a
  probe request cannot represent a code change by construction (spec §24:
  "may request deterministic probes but may not edit code").

## Does NOT

- Execute probes — that's `@awb/verification`/`@awb/execution`'s job once
  an Activity wires a probe request to a real command.
- Prove semantic reviewer diligence — `reviewerExaminedAllRequiredInputs`
  is explicitly a cheap proxy, not a claim about review quality.

## Dependencies

`@awb/domain`, `@awb/agent-gateway`, `@awb/capability-broker`,
`@awb/evidence`.
