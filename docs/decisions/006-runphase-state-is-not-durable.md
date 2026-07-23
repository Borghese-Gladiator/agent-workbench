# 006 — `runPhase`'s cross-phase state is in-memory only, not durable

## Decision

`workers/temporal-worker/src/activities/run-phase.ts` threads state between
phases (the draft contract, the accepted plan, accumulated QA evidence, the
worktree path, etc.) via a plain in-memory `Map<taskId, TaskRunState>`
inside the Activity module — not a SQLite row, not a Temporal Workflow-local
variable.

## Why

Temporal's own durability guarantee covers the *Workflow's* state
(`TaskWorkflowState` in `packages/workflow`) — phase, condition, attempt
number, open finding IDs, pending gate. That part survives a worker crash
and replay correctly, by construction, because the Workflow SDK persists
Workflow history. Activities are explicitly documented by Temporal itself
as *not* getting this guarantee the same way — an Activity is expected to
either be stateless per invocation or to externalize any state it needs
across invocations to a real store (a database, a filesystem, etc.).

For the MVP wiring done in this rebuild (see `workers/temporal-worker`'s
README and the commit wiring the real `runPhase`), building that external
store now — persisting `TaskContract`/`ImplementationPlan`/evidence rows to
the workbench SQLite database from inside an Activity — was scoped out
deliberately to land the full 9-phase real-wiring milestone in one pass,
matching this rebuild's overall milestone sequencing (the daemon, which
should own that persistence, landed in the *same* milestone as this
wiring, and Activities in this MVP don't yet call back into the daemon's
data layer at all).

## Consequences — read this before assuming crash recovery works

- **If the Temporal worker process restarts mid-task, `runPhase`'s
  in-memory state for any in-flight task is lost.** The Workflow itself
  will still be there (Temporal replays it correctly), and it will call
  `runPhase` again for whatever phase it was in — but `run-phase.ts`'s
  `getOrCreateTaskRunState` will silently create a *fresh* empty state
  rather than recovering the real one, since there's nothing to recover
  from. This is very likely to reintroduce exactly the kind of "lifecycle
  moved forward on a lie" problem that Decision 003 exists to prevent, if
  it isn't fixed before this MVP's ideas are relied upon past prototype
  use.
- **Do not treat the current wiring as satisfying "boot-time crash
  recovery."** The daemon and worker processes both restarting cleanly and
  reconnecting to Temporal is real and works (Temporal's own guarantee);
  Activity-level state surviving a *worker* restart specifically does not,
  yet.
- The fix, when undertaken, is straightforward given the schema already
  exists: have `runPhase` read/write `TaskContract`/`ImplementationPlan`/
  `Evidence` rows through the workbench SQLite database (via the same
  `@awb/database` the daemon already uses) instead of the in-memory map —
  this requires the Activity to either open its own DB handle or receive
  one from the daemon, a decision explicitly left open for whoever picks
  this up.

## Status

**Resolved (TASK-27).** The `RunStateStore` seam now has a durable,
`@awb/database`-backed implementation (`SqliteRunStateStore` in
`workers/temporal-worker/src/activities/sqlite-run-state-store.ts`) used on the
claude runtime. It reads persisted lifecycle rows through a read-only DB handle
and writes exclusively through the daemon's internal routes
(`/internal/run-state`), so the daemon remains the single application writer
(spec §8 / `docs/storage.md`, TASK-21). A worker restart mid-task now resumes
with the real contract/plan/candidate-SHA/evidence intact rather than a fresh
empty state, closing the "lifecycle moved forward on a lie" gap Decision 003
guards against. The mock runtime keeps `InMemoryRunStateStore` (deterministic
tests create no real rows), selected by `resolveRunStateStore` in
`run-phase.ts`.
