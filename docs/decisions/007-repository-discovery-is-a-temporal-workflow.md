# 007 — Repository discovery runs as a Temporal workflow

## Decision

`RepositoryDiscoveryWorkflow` (`packages/workflow/src/discovery-workflow.ts`) is
a first-class Temporal workflow, matching product spec §9/§15's intent that the
worker host both `TaskWorkflow` and `RepositoryDiscoveryWorkflow`. The public
daemon route `POST /api/repositories/:id/refresh` starts the workflow and returns
its result; the workflow calls a single `discoverRepository` activity that does
the real snapshot write daemon-side (via `POST /internal/repositories/:id/discover`
→ `refreshRepositorySnapshot`). The worker bundles both workflows through one
entrypoint (`packages/workflow/src/workflows.ts`).

## Why

- **Spec alignment (§9/§15).** The spec names `RepositoryDiscoveryWorkflow` as one
  of the two workflows the Temporal worker hosts. Before this change discovery ran
  as synchronous daemon-route logic (`refreshRepositorySnapshot` inline in the
  refresh route) — functional and already persisted, but an architecture deviation
  flagged by the 2026-07-21 spec-vs-code audit (TASK-26).
- **Durability + retries for free.** As an activity behind a workflow, discovery
  gets Temporal's retry policy (transient git/filesystem failures retry) and a
  durable execution record, the same guarantees the task lifecycle relies on.
- **Single-writer invariant preserved (spec §8, ADR 006 sibling).** The discovery
  activity does not open its own writer handle; it calls the daemon's internal
  discover route, so the snapshot write stays on the daemon — the single
  application writer. The public `/refresh` route only *starts* the workflow; the
  internal route does the write, so the two never recurse.

## Alternatives considered

- **Keep discovery as inline daemon-route logic, document the deviation.** This was
  the originally-proposed lighter option (discovery is already synchronous and
  persisted). Rejected: it leaves a standing spec deviation and denies discovery
  the retry/durability the workflow form provides; the extra surface is small (one
  thin workflow + one activity that delegates to the existing write path).

## Consequences

- The worker now bundles workflows through `workflows.ts` (both `TaskWorkflow` and
  `RepositoryDiscoveryWorkflow`), not `task-workflow.js` directly — Temporal loads
  one workflows module per worker.
- `POST /api/repositories/:id/refresh` is now asynchronous under the hood (starts a
  workflow and awaits its result) rather than a direct in-process call. The
  response shape changed from the raw snapshot to
  `{ repositoryId, snapshotId }`.
- A running Temporal server is now required for a repository refresh (it already was
  for task creation), so refresh cannot be served by the daemon alone.

## Status

Resolved (TASK-26). Implemented alongside the `TaskWorkflow` continue-as-new guard
(spec §34) in the same milestone; both are covered by workflow tests using
`TestWorkflowEnvironment.createLocal()`.
