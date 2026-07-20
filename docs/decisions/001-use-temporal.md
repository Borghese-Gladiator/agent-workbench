# 001 — Use Temporal for lifecycle orchestration

## Decision

Use the Temporal TypeScript SDK, backed by a local Temporal dev server with
SQLite persistence, as the durable execution engine for the task lifecycle
(one `TaskWorkflow` per task).

## Why

- **Durable execution for free.** A crash mid-task (daemon restart, machine
  sleep) resumes from workflow history instead of restarting the task from
  scratch. v2/v3/v4 all hand-rolled partial versions of this and never fully
  solved crash recovery (v4's own notes: "boot-time crash recovery being only
  half-hardened, no periodic liveness watchdog").
- **Long-lived waits without polling.** A task can sit at a human-approval
  gate for hours or days; Temporal Updates/Signals block efficiently instead
  of the daemon busy-polling a database column.
- **Explicit, inspectable state machine.** The lifecycle becomes a Workflow
  function the SDK can replay and test (`@temporalio/testing`), not a
  convention enforced by discipline across route handlers (v4's lifecycle was
  a hand-written Express service — correct, but every enforcement point had
  to be manually reasoned about).
- **Retries that don't re-run everything.** Temporal's activity retry model
  plus this design's own `PhaseAttemptResult` routing means a failed
  verification loops back to `implement` with just the relevant findings —
  not a full context/token reset, which was an explicit v4 pain point
  ("Retries reran with the entirety of the cached tokens and increased costs
  by a decent amount").

## Alternatives considered

- **Hand-rolled state machine + SQLite** (what v4 did). Rejected: works, but
  every durability/resumability/timeout guarantee has to be re-implemented
  and re-verified by hand, and v4's own archival notes list exactly the gaps
  that fell out of that approach.
- **A generic job queue (BullMQ, etc.) with a hand-rolled state column.**
  Rejected: gives retry/backoff but not workflow-level determinism, replay,
  or long-lived signal/update semantics — would still need a hand-rolled
  layer on top for the actual lifecycle logic.
- **LangGraph or another agent-orchestration framework.** Rejected — this is
  explicitly called out as out of scope; those frameworks orchestrate agent
  *steps*, not durable business-process lifecycle with human gates, and this
  system needs the latter far more than the former.

## Consequences

- Workflow code (`packages/workflow`) must stay deterministic — no direct
  I/O, no `Date.now()`, no non-deterministic randomness. Everything else is
  an Activity. This is a real constraint that shapes the whole
  `packages/workflow` vs. `workers/temporal-worker` split (see
  `docs/dependencies.md`).
- The system now depends on a local Temporal server process being up
  (`temporal server start-dev`) — one more thing to start/stop, though it's a
  single binary with no external dependencies of its own.
- Workflow IDs (`awb/task/{repositoryId}/{taskId}`) become a stable identity
  or a task across its whole lifetime, including PR-feedback handling after
  initial delivery — this shaped the decision to keep one `TaskWorkflow`
  execution alive through PR feedback rather than modeling delivery as a
  separate workflow.
