# Architecture

## Overview

```
┌─────────────────────────────────────────────────────┐
│                    Browser (:5173)                   │
│  React 18 + React Router + TanStack Query + Zustand │
└──────────────────────┬──────────────────────────────┘
                       │ /api/* (proxied)
┌──────────────────────▼──────────────────────────────┐
│                  Express (:3001)                     │
│  routes/ → domain/ → db/repositories/               │
└──────────┬─────────────────────┬────────────────────┘
           │                     │
┌──────────▼──────────┐  ┌──────▼─────────────────────┐
│  SQLite (WAL mode)  │  │  Ingest Pipeline           │
│  data/db/           │  │  data/ingest/inbox/ →        │
│  taskboard.sqlite   │  │    validate → process →     │
│                     │  │    processed/ | rejected/   │
└─────────────────────┘  └─────────────────────────────┘
```

## Source Layout

```
src/
  server/
    db/
      schema.sql              # Full SQLite DDL (12 tables)
      connection.ts           # Singleton DB with WAL + FK enforcement
      migrate.ts              # Idempotent migration runner
      repositories/           # Prepared-statement data access per table
    ingest/
      watcher.ts              # Chokidar file watcher for data/ingest/inbox/
      validator.ts            # Zod-based JSON validation
      processor.ts            # Event dispatch (10 event types)
    domain/                   # Business logic
    routes/                   # Express route modules
    terminal/                 # Terminal/PTY management
    index.ts                  # Express entry point
  shared/
    types.ts                  # All domain TypeScript types
    schemas.ts                # Zod schemas for ingest event validation
    constants.ts              # Status enums, transitions, directory names
  client/
    App.tsx                   # React shell with router + React Query
    router.tsx                # Route definitions
    pages/                    # Page components
    components/               # Shared UI components
    api/                      # HTTP client + React Query hooks
```

## Database

SQLite via `better-sqlite3`, stored at `data/db/taskboard.sqlite` (auto-created).

### Tables

| Table | Purpose |
|-------|---------|
| `agents` | Registered agents (planner, executor, reviewer, etc.) |
| `plans` | Plans with status lifecycle (draft/approved/rejected/archived) |
| `plan_task_drafts` | Proposed tasks within a plan, materialized on approval |
| `tasks` | Flat task records with 11-state lifecycle |
| `task_tags` | Tags per task |
| `terminal_sessions` | Persistent terminal session records |
| `task_session_links` | Many-to-many task/session associations with role |
| `reviews` | Review records (adversarial, standard, human) |
| `artifacts` | Files, diffs, notes, logs linked to tasks/plans/sessions |
| `activity_events` | Immutable append-only event log |
| `ingest_files` | Processed/rejected file tracking with SHA-256 dedup |

### Task States

`backlog` → `ready` → `assigned` → `running` → `needs_review` → `succeeded` → `archived`

Plus: `waiting`, `blocked`, `failed`, `canceled`. See `src/shared/constants.ts` for the full transition map.

## Ingest Pipeline

External tools (Claude Code hooks, planners, agents) communicate by dropping JSON files into `data/ingest/inbox/`.

### Flow

1. Watcher detects new `.json` in inbox
2. Validates envelope schema (event_id, event_type, occurred_at, actor, payload)
3. Validates payload against event-type-specific Zod schema
4. Checks for duplicate by SHA-256 hash
5. Dispatches to handler: inserts DB records + activity event
6. Moves file to `processed/` (or `rejected/` on failure)

### Supported Event Types

| Event | Description |
|-------|-------------|
| `plan.proposed` | Planner submits a plan with task drafts for approval |
| `task.created` | New standalone task |
| `task.updated` | Generic task field update |
| `task.status_changed` | Task transitions between states |
| `task.assigned` | Agent assigned to a task |
| `task.session_linked` | Terminal session linked to a task |
| `session.declared` | New terminal session registered |
| `review.requested` | Task moved to needs_review |
| `review.completed` | Review outcome recorded |
| `artifact.attached` | File/note/log attached to a task, plan, or session |
