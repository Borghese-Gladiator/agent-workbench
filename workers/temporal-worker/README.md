# @awb/temporal-worker

## Purpose

The Temporal worker process: registers `TaskWorkflow` (from `@awb/workflow`)
and all Activities, and is the only process that actually executes phase
logic (agent sessions, command execution, git/worktree operations, etc.).

## Responsibilities

- `src/index.ts` — worker bootstrap (`startWorker()`), pointed at the built
  `@awb/workflow` dist output for workflow bundling.
- `src/activities/run-phase.ts` — the real `runPhase` Activity. As of
  Milestone 3 this is a stub that always returns `{ outcome: "blocked" }`,
  since real per-phase logic depends on packages landing in later milestones
  (agent-gateway, verification, qa, review). Wiring it up is tracked
  per-milestone, not silently deferred forever.

## Does NOT

- Contain lifecycle/completion logic itself — that's `@awb/workflow`. This
  package's activities are thin wrappers that delegate to the packages that
  actually do the work (repository, workspace, agent-gateway, verification,
  qa, review, github) once those exist.

## Dependencies

`@awb/domain`, `@awb/workflow`, `@temporalio/worker`, `@temporalio/activity`.
