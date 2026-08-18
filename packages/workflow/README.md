# @awb/workflow

## Purpose

The Temporal `TaskWorkflow` and the deterministic completion/routing policy
it depends on — the core of the whole system's lifecycle enforcement.

## Responsibilities

- `evaluate-completion.ts` — `evaluatePhaseCompletion(candidate, context)`,
  the only function permitted to decide a `TaskPhase` is complete. Pure,
  exhaustively tested per-phase.
- `loop-routing.ts` — `routeLoop`, the per-finding-category loop-routing table.
  (Human-gate escalation was removed in the autonomy pivot; TASK-104.)
- `loop-budget.ts` — `evaluateLoopBudget`/`buildUnmetCriteria`, the pure
  bounded-autonomy stop-decision: exhaustion or a genuinely-stuck loop
  terminates as `UnmetCriteria` (a draft PR), never a human escalation.
- `no-progress.ts` — the crypto-free no-progress tracker
  (`NoProgressState`/`recordAttempt`/`isNoProgress`) the Workflow folds each
  repair attempt into; safe to import into the Temporal Workflow sandbox.
- `failure-fingerprint.ts` — deterministic failure fingerprinting (uses
  `node:crypto`, so Activity-only) plus a re-export of the no-progress tracker.
- `invalidation.ts` — the evidence invalidation cascade:
  which phases' evidence goes stale when contract/plan/candidate-SHA/QA
  scenario versions change.
- `task-workflow.ts` — the `TaskWorkflow` function itself: Updates
  (`approveContract`, `approvePlan`, `extendBudget`, ...), Signals (`cancel`,
  `pullRequestMerged`, ...), Queries (`getCurrentState`, ...), and the
  9-phase loop that interprets `PhaseAttemptResult`s.

## Does NOT

- Perform any I/O. This package (specifically `task-workflow.ts`) must stay
  deterministic — no filesystem, database, git, process, agent, or network
  access. All of that lives in Activities (`workers/temporal-worker`), which
  is why this package depends on nothing but `@awb/domain` (see
  `docs/dependencies.md`).
- Let an agent decide completion. Agents return `PhaseAttemptResult`;
  `evaluatePhaseCompletion` is the only completion authority.

## Testing note

`task-workflow.test.ts` uses `TestWorkflowEnvironment.createLocal()` (real
time), not `createTimeSkipping()` — this suite drives the workflow with
wall-clock polling from outside (queries/signals/updates), and time-skipping
fights that by racing the clock forward whenever the workflow is idle,
producing spurious client-side execution timeouts.

## Dependencies

`@awb/domain`, `@temporalio/workflow`, `@temporalio/activity`,
`@temporalio/common` (+ `@temporalio/testing`/`@temporalio/worker`/
`@temporalio/client` as devDependencies for tests only).
