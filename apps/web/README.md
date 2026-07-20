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
  the pending human gate via the shared `GatePanel`, and a Cancel button.
- **Human Approvals** (`/approvals`) — a repositoryId+taskId lookup reusing
  `GatePanel`, since there is no daemon route aggregating pending gates
  across all tasks yet. The UI says so explicitly.
- **Evidence Viewer** (`/evidence`) — shows only
  `latestCandidateEvidenceIds` (plain IDs) since no daemon route yet
  exposes `Evidence`/artifact records for video/trace/assertion detail. The
  UI displays this limitation visibly rather than fabricating data.
- **Settings** (`/settings`) — a minimal placeholder (daemon base URL only)
  since no daemon config-read route exists yet.

## `GatePanel` gate-reason mapping

`task-contract-approval` → approve/reject-contract buttons.
`pr-readiness` → display-only (no daemon route exists for release-phase
approval yet). Any other reason while `phase === "plan"` → approve/reject-
plan buttons as a best-effort mapping. Everything else is display-only.
Note: `TaskWorkflowState` doesn't carry `contractVersion`/`planVersion`
directly, so `attemptNumber` (defaulting to 1) stands in as the closest
available value for those Update calls — a real fix needs the daemon to
thread the actual version through.

## Does NOT

- Import `packages/*` directly, or perform any filesystem/git/shell
  operation — all of that is the daemon's job.
- Aggregate data the daemon doesn't yet expose (all-tasks-across-
  repositories, all-pending-gates, evidence/finding detail) — every page
  is honest in the UI itself about what it can and cannot show given
  current daemon capability, rather than fabricating placeholder data.

## Dependencies

`react`, `react-dom`, `react-router-dom`.
