# @awb/daemon

## Purpose

The local Fastify daemon — the composition root that owns the workbench
SQLite database, is a Temporal client (never a Temporal worker), and will
own the artifact store and GitHub credentials as those integrations land.
Binds to `127.0.0.1` only.

## Responsibilities

- `server.ts` — `buildServer()`/`startServer()`: wires the database,
  in-process semantic-event bus, and HTTP/WebSocket routes.
- `routes/repositories.ts` — `POST/GET /api/repositories`,
  `GET /api/repositories/:id`, `POST /api/repositories/:id/refresh`,
  `POST /api/repositories/:id/approve` — thin wrappers over
  `@awb/repository`.
- `routes/tasks.ts` — `POST /api/tasks` (starts a real `TaskWorkflow` via
  `@temporalio/client`), `GET /api/tasks/:repositoryId/:taskId` (queries
  current state/open findings/pending human gate),
  `POST .../approve-contract`, `.../reject-contract`, `.../approve-plan`,
  `.../reject-plan`, `.../cancel` (Updates/Signals against the running
  workflow).
- `routes/websocket.ts` — live `SemanticEvent` stream over
  `/api/events/stream`. On reconnect, a client should first catch up via a
  REST query keyed on `sequence` (not yet a route — tracked as follow-up),
  then rely on this stream going forward.
- `temporal-client.ts` — lazy `@temporalio/client` connection + the
  `awb/task/{repositoryId}/{taskId}` workflow-ID convention.
- `db.ts` — `openWorkbenchDatabase()`: intentionally **not** cached at
  module scope (a real daemon process only calls this once; module-level
  caching silently broke test isolation across `AWB_DATA_DIR` values — a
  real bug found and fixed during this milestone's own test-writing).

## Does NOT

- Run as a Temporal worker — `workers/temporal-worker` owns Activities and
  workflow execution; this app is a client only.
- Cache its Temporal client or database handle across `AWB_DATA_DIR`
  changes — see `db.ts`'s comment for why that's deliberate.

## Dependencies

`@awb/config`, `@awb/database`, `@awb/domain`, `@awb/repository`,
`@awb/workflow`, `@temporalio/client`, `fastify`, `@fastify/websocket`.
`@awb/evidence` is listed in `package.json` for the artifact-serving routes
this app will need once the web UI's evidence viewer lands, but nothing
imports it yet — don't assume artifact routes exist until they're actually
wired.
