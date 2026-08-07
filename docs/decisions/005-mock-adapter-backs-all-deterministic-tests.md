# 005 — A scriptable mock agent adapter backs every deterministic test

## Decision

`@awb/agent-gateway`'s `MockAgentAdapter` — not a real model call, not a
record/replay fixture of a real model's output — is what every Temporal
lifecycle test, planner-critic-loop test, builder-loop test, and adversarial-
review test runs against. It implements the exact same `CodingAgentAdapter`
interface the real `ClaudeAgentAdapter` implements, and is scripted per
`(taskId, role)` pair with an ordered queue of turns (findings, file
changes, command results, usage, timeouts, crashes, repeated failure
signatures).

## Why

A mock adapter for automated tests was a founding requirement (a "deterministic
and scriptable" fake agent adapter), but the reason it matters this much for
*this specific rebuild* is direct: v4's archival notes state "QA artifacts were different
every time... it was RNG if it produced something I could use to actually
verify functionality." Any test suite that depends on what a real model
happens to output on a given run inherits that same non-determinism. A
scriptable fake with the identical interface as the real adapter means:

- Every Temporal test (`packages/workflow/src/task-workflow.test.ts`) and
  every real-wiring test (`workers/temporal-worker/src/run-phase-e2e.test.ts`)
  runs in seconds, deterministically, with zero API cost, and passes or
  fails for a *specific, reproducible* reason every time.
- The interface boundary itself gets exercised for real — `createSession`/
  `execute`/`interrupt`/`dispose` are genuinely called, not skipped — so a
  bug in how a caller uses the adapter interface (wrong role, wrong
  session lifecycle, ignoring the abort signal) surfaces in these tests
  even though no real model is involved.
- Swapping in the real `ClaudeAgentAdapter` later requires no changes to
  any caller — planner/critic/builder/reviewer code only ever depends on
  `CodingAgentAdapter`, never on which concrete adapter is wired in.

## Alternatives considered

- **Record real Claude Code sessions and replay their exact output.**
  Rejected: still non-deterministic to *produce* the fixtures (a live
  session each time you need a new scenario), brittle to replay exactly
  (any schema drift in the real SDK's event shape breaks old fixtures
  silently), and doesn't test the interface boundary itself as directly as
  a hand-scripted fake tied to the same types.
- **Skip automated testing for anything agent-shaped, rely on manual
  verification only.** Rejected outright — this is precisely the pattern
  this rebuild exists to move away from.

## Consequences

- Every package that calls into an agent role (`@awb/planning`,
  `@awb/review`, and the real `runPhase` Activity in
  `workers/temporal-worker`) is written against the `CodingAgentAdapter`
  interface, never against `MockAgentAdapter` or `ClaudeAgentAdapter`
  directly, so this substitutability is enforced by the type system, not
  just convention.
- Real-model verification (does the *real* Claude Code adapter actually
  produce useful plans/implementations/reviews) is explicitly a separate,
  manual, opt-in concern — see `docs/testing.md`'s "What is manual, and
  why" section — not something the automated suite claims to prove.
