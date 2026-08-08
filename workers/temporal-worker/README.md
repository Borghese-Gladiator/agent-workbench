# @awb/temporal-worker

## Purpose

The Temporal worker process: registers `TaskWorkflow` (from `@awb/workflow`)
and all Activities, and is the only process that actually executes phase
logic (agent sessions, command execution, git/worktree operations, etc.).

## Responsibilities

- `src/index.ts` — worker bootstrap (`startWorker()`), pointed at the built
  `@awb/workflow` dist output for workflow bundling.
- `src/activities/` — the Activities. `run-phase.ts` is the real `runPhase`
  Activity (a hub that dispatches each lifecycle phase), and ~20 support modules
  around it do the actual per-phase work (contract, planner, builder, worktree,
  delivery, browser QA) plus run-state persistence, observability, and the
  slice guardrail. **See `src/activities/AGENTS.md` for the full module map** —
  read that before opening `run-phase.ts`.

## Does NOT

- Contain lifecycle/completion logic itself — that's `@awb/workflow`. This
  package's Activities delegate to the domain packages that do the work
  (repository, workspace, agent-gateway, verification, qa, review, github); the
  only phase-advancement decision is `evaluatePhaseCompletion` in
  `@awb/workflow`, which Activities call but never override.

## Dependencies

`@temporalio/worker` + `@temporalio/activity`, and the domain packages the
Activities delegate to — `@awb/workflow` (deterministic completion policy),
`@awb/domain`, and the I/O libraries: `agent-gateway`, `capability-broker`,
`config`, `database`, `evidence`, `execution`, `github`, `planning`, `qa`,
`repository`, `repository-memory`, `review`, `telemetry`, `verification`,
`workspace`. (Full graph: `docs/dependencies.md`.)
