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
  state/attempt number/token usage/runtime-by-phase/open findings, renders
  the read-only unmet-criteria report, and a Cancel button.
- **Evidence Viewer** (`/evidence`) — shows only
  `latestCandidateEvidenceIds` (plain IDs) since no daemon route yet
  exposes `Evidence`/artifact records for video/trace/assertion detail. The
  UI displays this limitation visibly rather than fabricating data.
- **Settings** (`/settings`) — a minimal placeholder (daemon base URL only)
  since no daemon config-read route exists yet.

## Unmet-criteria report (read-only)

`GatePanel` and the four approve/reject calls behind it are DELETED
(TASK-107). There is no approval queue, because the workbench no longer waits
for a human (TASK-104).

When a task's bounded loop stops before proving every acceptance claim, the
detail page renders `state.unmetCriteria` as a read-only banner: the stop
reason, the phase it stopped in, and the claims that went unproven. The action
a human takes is on the draft PR on GitHub, not in this UI.

## Does NOT

- Import `packages/*` directly, or perform any filesystem/git/shell
  operation — all of that is the daemon's job.
- Aggregate data the daemon doesn't yet expose (all-tasks-across-
  repositories, all-pending-gates, evidence/finding detail) — every page
  is honest in the UI itself about what it can and cannot show given
  current daemon capability, rather than fabricating placeholder data.

## Dependencies

`react`, `react-dom`, `react-router-dom`.
