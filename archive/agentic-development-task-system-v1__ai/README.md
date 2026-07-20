# Agentic-driven Development

A fully local, browser-based dashboard for managing Claude Code development workflows. Supports issue ingestion and approval, Kanban task tracking, terminal session management, adversarial review, and activity logging — all backed by SQLite.

## Quick Start

```bash
npm install
npm run dev          # starts server (port 3001) + Vite client concurrently
```

Or run them separately:

```bash
npm run dev:server   # Express + ingest watcher on :3001
npm run dev:client   # Vite dev server on :5173 (proxies /api to :3001)
```

Then open http://localhost:5173.

## Seeding & Wiping the Database

Seed sample data (initiatives, epics, agents, work items, artifacts, activity events):

```bash
npm run seed                                  # runs src/server/db/seed.ts
```

Wipe the database (see `scripts/wipe.ts` for full scope options):

```bash
npx tsx scripts/wipe.ts --scope tasks         # DELETE work_items + dependents (default)
npx tsx scripts/wipe.ts --scope epics         # DELETE epics only (work_items kept, epic_id nulled)
npx tsx scripts/wipe.ts --scope all           # DELETE everything except agents
npx tsx scripts/wipe.ts --scope all --agents  # also wipe agents
npx tsx scripts/wipe.ts --scope all --ingest-files   # also delete files in data/ingest/*
npx tsx scripts/wipe.ts --scope tasks --dry-run      # report counts, roll back
npx tsx scripts/wipe.ts --scope tasks --yes          # skip confirmation prompt
```

## Ingest CLI — Adding Tasks, Epics, and Comments

The ingest CLI writes JSON envelopes to `data/ingest/inbox/`. The watcher (running inside the dev server) picks them up and inserts into the DB.

```bash
# Create a task (kind defaults to "task"; use --kind bug for bugs)
npm run ingest -- task --title "Fix login bug" --kind bug --tags "frontend,auth"

# Attach task to an epic or parent work item
npm run ingest -- task --title "Add toggle" --epic-id <epic-uuid> --parent-id <parent-uuid>

# Full task options
npm run ingest -- task \
  --title "Add dark mode" \
  --kind task \
  --body "Allow toggling between light and dark themes" \
  --status triage \
  --epic-id <epic-uuid> \
  --parent-id <parent-uuid> \
  --assigned-agent-id executor-01 \
  --branch-name feat/dark-mode \
  --acceptance-criteria "Theme persists across reloads" \
  --tags "frontend,ui,theme"

# Create an epic
npm run ingest -- epic --title "Auth overhaul" --description "Rewrite auth middleware" --initiative-id <initiative-uuid>

# Add a comment to a work item
npm run ingest -- comment --work-item-id <uuid> --body "Looks good to me"
```

Each invocation prints the path of the written envelope plus the generated `entity_id`. Start the dev server (or just the watcher) for the file to be processed.

## Architecture

```
src/
  server/
    db/
      schema.sql              # Base SQLite DDL (11 tables)
      migrations/             # Incremental migrations (adds comments, claude_session_id, …)
      connection.ts           # Singleton DB with WAL + FK enforcement
      migrate.ts              # Idempotent migration runner
      seed.ts                 # Sample data seeder (npm run seed)
      repositories/           # Prepared-statement data access per table
        initiatives.ts, epics.ts, work-items.ts, work-item-tags.ts,
        agents.ts, sessions.ts, task-session-links.ts,
        reviews.ts, artifacts.ts, comments.ts,
        activity-events.ts, ingest-files.ts
    ingest/
      watcher.ts              # Chokidar file watcher for data/ingest/inbox/
      validator.ts            # Zod-based JSON validation
      processor.ts            # Event dispatch (13 event types)
    routes/                   # Express route modules
    terminal/                 # Terminal/PTY management
    index.ts                  # Express entry point
  cli/
    ingest.ts                 # Pure envelope builders + write-to-inbox
    ingest.main.ts            # CLI entry (npm run ingest)
    ingest.test.ts            # Unit tests
  shared/
    types.ts                  # All domain TypeScript types
    schemas.ts                # Zod schemas for ingest event validation
    constants.ts              # Status enums, transitions, directory names
  client/
    App.tsx                   # React shell with router + React Query
    router.tsx                # Route definitions
    pages/                    # Page components
    components/               # Shared UI components
    services/                 # React Query hooks
scripts/
  wipe.ts                     # Truncate tables (see --scope options)
```

## How Ingest Works

External tools (Claude Code hooks, planners, agents) communicate with the system by dropping JSON files into a watched inbox directory.

### Directory structure

The system watches `data/ingest/inbox/` in each configured repo. Directories are created automatically on startup.

```
<repo>/
  data/
    db/               # SQLite database
    ingest/
      inbox/          # Drop JSON event files here
      processed/      # Successfully ingested files are moved here
      rejected/       # Invalid files are moved here
      attachments/    # Optional referenced artifacts
    task_data/        # Filesystem markdown storage (future)
```

### Event format

Every ingest file follows a common envelope:

```json
{
  "event_id": "uuid",
  "event_type": "plan.proposed",
  "occurred_at": "2026-03-31T21:10:44Z",
  "source": "claude-hook",
  "actor": { "type": "agent", "id": "planner" },
  "payload": { }
}
```

### Supported event types

| Event | Description |
|-------|-------------|
| `epic.created` | New epic created |
| `work_item.created` | New task or bug created |
| `work_item.updated` | Generic work item field update |
| `work_item.status_changed` | Work item transitions between states |
| `work_item.assigned` | Agent assigned to a work item |
| `work_item.session_linked` | Terminal session linked to a work item |
| `session.declared` | New terminal session registered |
| `review.requested` | Work item moved to in_review |
| `review.completed` | Review outcome recorded |
| `artifact.attached` | File/note/log attached to a work item, epic, or session |
| `comment.created` | Comment added to a work item |
| `comment.updated` | Comment edited |
| `comment.deleted` | Comment removed |

### Ingest pipeline

1. Watcher detects new `.json` in inbox
2. Validates envelope schema (event_id, event_type, occurred_at, actor, payload)
3. Validates payload against event-type-specific Zod schema
4. Checks for duplicate by SHA-256 hash
5. Dispatches to handler: inserts DB records + activity event
6. Moves file to `processed/` (or `rejected/` on failure)

## Database

SQLite via `better-sqlite3`, stored at `data/db/taskboard.sqlite` (auto-created).

### Tables

| Table | Purpose |
|-------|---------|
| `initiatives` | Top-level groupings of related epics |
| `epics` | Collections of related work items |
| `work_items` | Tasks, bugs, and sub-tasks (via `parent_id`) with status lifecycle |
| `work_item_tags` | Many-to-many tags per work item |
| `agents` | Registered agents (planner, executor, reviewer, etc.) |
| `terminal_sessions` | Persistent terminal session records |
| `task_session_links` | Many-to-many work item / session associations with role |
| `reviews` | Review records (adversarial, standard, human) |
| `artifacts` | Files, diffs, notes, logs linked to work items / epics / sessions |
| `comments` | Threaded comments on work items (migration 002) |
| `activity_events` | Immutable append-only event log |
| `ingest_files` | Processed/rejected file tracking with SHA-256 dedup |

### Work item states

`triage` → `ready` → `in_progress` → `in_review` → `done`

Plus: `canceled`. See `src/shared/constants.ts` for the full transition map.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/ingest/status` | Watcher status (files processed/rejected, watched paths) |

Additional API routes are added in later phases.

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3001` | Server port |
| `WATCH_REPOS` | `process.cwd()` | Comma-separated repo paths to watch for ingest |

## Verification

```bash
# Type check (should produce no output)
npx tsc --noEmit

# Unit tests for ingest CLI
npx tsx src/cli/ingest.test.ts

# Unit tests for wipe script
npx tsx tests/wipe.test.ts

# E2e test: ingest a valid event, verify DB + file movement
npx tsx tests/e2e-ingest.ts

# E2e test: ingest an invalid file, verify rejection
npx tsx tests/e2e-reject.ts

# Manual: create a task via CLI (npm script wraps src/cli/ingest.main.ts)
npm run ingest -- task --title "Test task" --kind bug --tags "test"
# File appears in data/ingest/inbox/ — watcher processes it when dev server is running
```

## Phased Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| 1. Storage + Ingest | **Done** | SQLite schema, ingest pipeline, file watcher |
| 2. Issues + Approval | Planned | Issue inbox UI, approve/reject, task materialization |
| 3. Task Board | Planned | Kanban board, filters, task detail, status transitions |
| 4. Terminal Sessions | Planned | Session persistence, declaration, task linking |
| 5. Terminal Workspace | Planned | xterm.js, tabbed UI, PTY management |
| 6. Claude Session Awareness | Planned | Claude session ID tracking, provenance |
| 7. Review Flow | Planned | Adversarial review, outcome transitions |
| 8. Artifacts + Polish | Planned | Artifact management, activity feed, diagnostics |

## Tech Stack

- **Runtime**: Node.js + TypeScript (ESM)
- **Server**: Express
- **Database**: SQLite via better-sqlite3
- **Client**: React 18 + Vite + Tailwind CSS
- **State**: TanStack React Query + zustand
- **Validation**: Zod
- **File watching**: chokidar v4
