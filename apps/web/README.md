# @awb/web

## Purpose

The local React/Vite dashboard. Talks only to `apps/daemon` over `/api`
(HTTP + WebSocket) — never imports a `packages/*` module, touches the
filesystem, or shells out.

## Pages

- **Repositories** (`/`) — list, register, and navigate to a repository.
  Manually verified end-to-end in a real browser against a real daemon.
- **Repository Detail** (`/repositories/:id`) — refresh (real snapshot
  discovery) and approve. Manually verified end-to-end.
- **Tasks** (`/tasks`) — lists tasks created this daemon process's lifetime
  (backed by `GET /api/tasks`, an in-memory list — resets on daemon
  restart, not persisted to SQLite) plus a create-task form.
- **Task Detail** (`/tasks/:repositoryId/:taskId`) — polls
  `GET /api/tasks/:repositoryId/:taskId` every 2s (chosen over the
  WebSocket stream for MVP simplicity); shows phase/condition/delivery
  state/attempt number/token usage/runtime-by-phase/open findings, and a
  Cancel button.
- **Evidence Viewer** (`/evidence`) — shows only
  `latestCandidateEvidenceIds` (plain IDs) since no daemon route yet
  exposes `Evidence`/artifact records for video/trace/assertion detail. The
  UI displays this limitation visibly rather than fabricating data.
- **Settings** (`/settings`) — a minimal placeholder (daemon base URL only)
  since no daemon config-read route exists yet.

## Human gates removed

The autonomy pivot (TASK-104..107) removed all human-approval gates, so this
dashboard no longer has an `/approvals` page or a `GatePanel`. Tasks run
autonomously to a terminal draft PR; non-convergence is reported in the PR body
as UnmetCriteria rather than surfaced as an actionable approval queue.

## Does NOT

- Import `packages/*` directly, or perform any filesystem/git/shell
  operation — all of that is the daemon's job.
- Aggregate data the daemon doesn't yet expose (all-tasks-across-
  repositories, evidence/finding detail) — every page is honest in the UI
  itself about what it can and cannot show given current daemon capability,
  rather than fabricating placeholder data.
- Surface or action human-approval gates — the autonomy pivot removed them.

## Dependencies

`react`, `react-dom`, `react-router-dom`.
