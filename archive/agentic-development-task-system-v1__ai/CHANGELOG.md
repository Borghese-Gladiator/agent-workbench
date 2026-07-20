# Changelog

All notable changes to `agentic-development-task-system__ai` across the full development history.

---

## v0.3.8

### feat: board ergonomics — inline edit, keyboard nav, command palette, awaiting-input

- **Inline editing:** click card/drawer title, description, or acceptance criteria to edit in place via new `InlineTextField` primitive. Enter commits, Escape cancels; drag-and-drop disabled while editing.
- **Keyboard nav on the board:** j/k/h/l + arrows move selection across columns, Enter edits the title, Space opens the drawer, Escape cancels, n/e open the command palette in create mode, ? shows a cheat-sheet modal. Input-guarded.
- **Command palette:** ⌘K / Ctrl+K (and a new navbar button) opens a searchable dialog over work items + epics with "Create as task/epic" shortcuts and inline creation forms that POST directly to the existing routes.
- **Awaiting-input notification:** new `ingest set-awaiting` subcommand toggles the existing `work_items.awaiting_input` flag via a `work_item.updated` envelope. Pulsing amber dot on cards, (N) awaiting chip in the board header, and a (N)-prefix on `document.title`. Drawer shows a banner with a one-click "Clear" escape hatch.
- `PATCH /api/work-items/:id` now accepts `tags: string[]` via a new `replaceTagsForWorkItem` repo helper.

**Files changed (12):** `package.json`, `src/cli/ingest.main.ts`, `src/cli/ingest.test.ts` (+70 lines), `src/cli/ingest.ts`, `src/client/App.tsx`, `src/client/components/CommandPalette.tsx` (new, 579 lines), `src/client/components/WorkItemDrawer.tsx`, `src/client/components/ui/InlineTextField.tsx` (new, 134 lines), `src/client/pages/BoardPage.tsx` (+349 lines), `src/client/services/hooks.ts`, `src/server/db/repositories/work-item-tags.ts` (new), `src/server/routes/work-items.ts`.

---

## v0.3.7

### feat: auto /color and /rename on session start
Apply tab color (from `epic.color`, defaulting to blue) and rename to the work item title when launching Claude inside a new tmux session. Re-apply on resume since slash commands don't survive `--resume`.

### feat: ordering, lanes, batches, single-parent dependencies
Bulk-create used to lose order once rows hit the DB — every task tied at `sort_order=0` because `handleWorkItemCreated` hard-coded it, the payload schema didn't carry it, and chokidar emitted files in filesystem order. No way to express "these can run in parallel" or "this one has to wait."

v0.3.7 carries `sort_order` / `lane` / `batch_id` / `depends_on_id` end-to-end from the batch CLI through the ingest payload, processor, DB, and board UI. `ready_to_start` and `blocked_by_title` are derived in SQL; `depends_on_id` is a soft reference so out-of-order arrival doesn't trigger FK errors.

- migration 003: `lane`, `batch_id`, `depends_on_id` on `work_items` + `batch_id` on epics
- `runBatch`: one `batch_id` per call, index→UUID dep resolution, cycle check, `sort_start`/`sort_step` auto-sequence, forward/self-ref rejection
- `task` subcommand: `--sort-order`, `--lane`, `--depends-on-id` flags
- watcher: serialized handler + path dedupe
- `PATCH /work-items/:id`: field whitelist, rejects `batch_id` mutation
- board: lane-colored left border, ready/waiting dot, lane filter, epic groups sorted by `(sort_order, title)`
- drawer: Lane, Depends on, Batch rows
- `connection.ts`: `TASKBOARD_DB_PATH` env override for isolated tests

CLI tests 174/174, repo tests 22/22, typecheck clean. Bumps 0.3.5 → 0.3.7 (0.3.6 landed without a version bump). Renames the prior v0.3.7 plan to v0.3.8.

---

## v0.3.6

### feat: bulk-create via ingest batch subcommand + skill layout fix
Add `batch` subcommand to the ingest CLI that accepts a single JSON payload (inline or stdin) describing an optional epic plus N task rows, fans into the existing `work_item.created` / `epic.created` envelopes, and validates all-or-nothing so a failed row never leaves a half-populated inbox. Supports `defaults` for shared fields, cascading `epic_id` precedence, tag union, and `_`-prefixed row annotations.

Restructure project skills into the correct `.claude/skills/<name>/SKILL.md` directory layout so they register with Claude Code's skill loader and surface in `/`. Loose `.md` files at the skills root were silently dropped by the loader since v0.3.0. Rename `taskboard-mass-ingest` to `bulk-create` and add the missing `taskboard-delete-task` / `taskboard-delete-epic` skills for the existing delete CLI subcommands.

---

## v0.3.5

### feat: ingest CLI delete subcommands for tasks, epics, comments, initiatives
Adds `delete-task`, `delete-epic`, `delete-comment`, `delete-initiative` subcommands to the ingest CLI. Each writes a `*.deleted` envelope to `data/ingest/inbox/`, and the watcher/processor applies the delete via the repository layer — same event-sourced pattern as creates. FK constraints handle cascades; activity rows are preserved as audit trail.

---

## v0.4.0 (plan)

### docs: plan v0.4.0 — orchestration parity
Addresses four gaps surfaced by comparison against ComposioHQ/agent-orchestrator: worktree-per-session isolation, opt-in PR linking with explicit link/unlink, a single `needs_input` flag on sessions for glanceable "waiting on you" signal, and a reaction hook that generates CI-fix / respond-to-review system comments on linked PRs (mirroring the v0.3.3 adversarial-review pattern).

---

## v0.3.4

### feat: trim adversarial review comment to task-specific content
Drop the boilerplate template (Task description, Working directory, Branch, Focus on / Constraints / Prefer buckets with `[risk area N]` / `[constraint N]` placeholders). The comment now emits just the invocation line plus an Acceptance criteria block when criteria are present — nothing fabricated, nothing the reviewer model would invent anyway.

Call-site signature is preserved; `body` and `branch_name` remain on `ReviewPromptWorkItem` for API stability (currently unused).

---

## v0.3.3

### feat: adversarial review comment on in-review transition
Auto-create a system comment with a pre-filled `/codex:adversarial-review` prompt when a work item enters In Review. The comment renders in the existing comment list with Copy and (when a session is linked) Send-to-terminal actions; the Send action pastes via `tmux send-keys -l` so the user can edit placeholders before hitting Enter themselves.

Also wraps the transition's writes in a single better-sqlite3 transaction for atomicity, and adds `POST /api/sessions/:id/paste` backing the Send-to-terminal button.

---

## v0.3.2

### feat: replace agent cards with session cards
- `ActivityPage`: new `SessionCard` component (collapsed/expanded), wrapping layout, mobile-friendly
- `GET /api/sessions`: LEFT JOIN `work_items` for `workItemTitle`; reconcile dead sessions to `'disconnected'` via tmux liveness check
- Remove `getAgentDashboard`, `GET /api/agents/dashboard`, `useAgentDashboard` hook
- Open Terminal button resumes exited/disconnected sessions before navigating
- Bump version 0.3.1 → 0.3.2

### fix(tsconfig): add "types": ["node"] for node:* module intellisense

### fix(seed): remove stale scripts/seed.ts, make src seed idempotent, refresh README
The old `scripts/seed.ts` referenced pre-v0.3 repositories (issues, tasks, task-tags, issue-task-drafts) and an unresolved `@server/*` alias. The canonical seed at `src/server/db/seed.ts` now wipes the tables it writes to up front, so `npm run seed` is safe to rerun. README updated with current seed/wipe/ingest CLI usage and the `work_items` schema.

### fix(watcher): resolve repo path via inbox→repo map, not parent-dir counting
The watcher derived `repoPath` by walking three `..` up from the inbox file, which landed at `<repo>/data` instead of `<repo>`. Joining `INGEST_DIR` back on produced `data/data/ingest/processed/...` paths. Register each inbox→repo mapping when the watcher starts and look it up by dirname, removing the coupling to `INGEST_DIR` depth.

### fix(wipe): clear session FK before deleting work_items; add --dry-run
The `NO ACTION` FK from `terminal_sessions.primary_work_item_id` to `work_items(id)` blocked `--scope all/tasks` whenever a session referenced a work item. Null out that column first, and handle the `comments` table (migration 002) with a table-exists guard so the wipe also works on pre-migration DBs.

Also adds `--dry-run`: runs the deletes inside a transaction, reports per-table counts, then rolls back so nothing is actually changed. Skips the confirmation prompt since no data is touched.

Test fixtures now seed a session with a dangling `primary_work_item_id` to exercise the FK path, and a new test asserts that dry-run reports counts without mutating the DB.

---

## v0.3.1

### feat: task comments — editable list on detail + drawer, ingest parity
- New `comments` table (migration 002), repository, and REST routes (GET/POST/PATCH/DELETE)
- `CommentList` component with composer + inline edit/delete; wired into `WorkItemDetailPage` and the Board `WorkItemDrawer` (compact)
- Ingest parity: `comment.created`/`updated`/`deleted` event handlers + Zod schemas
- `GET /api/work-items/:id` now returns comments inline so agents reading a task see them without an extra request
- New `comment` subcommand in the ingest CLI for agent-originated comments
- Migration regression fix: `comments` is incremental-only — not in `EXPECTED_TABLES` and not in base `schema.sql` (prevented base-schema replay)

### feat: database wipe script with scoped resets and tests
Adds `scripts/wipe.ts` for resetting `taskboard.sqlite` after generating temp data. Supports `--scope tasks|epics|all`, with optional `--agents` and `--ingest-files` flags, an interactive confirmation, and a `--yes` bypass. Includes `tests/wipe.test.ts` covering every scope, cascade behavior, and ingest-file cleanup.

---

## v0.3.0

### feat: task ingestion CLI, skills, and consolidate data dirs
Add an ingest CLI (`src/cli/ingest.ts`) that generates validated JSON envelopes for tasks and epics, writing them to the inbox for the existing Chokidar watcher to process. Includes Claude Code skills (`taskboard-create-task`, `taskboard-create-epic`) as thin wrappers.

Consolidate `.taskboard/` into `data/ingest/` so all runtime data lives under a single `data/` directory. Update seed script to write ingest JSON envelopes alongside DB inserts for audit trail parity. Update README, AGENTS.md, and architecture docs to reflect current schema.

---

## v0.2.0

### feat: terminal emulator — tmux-backed Claude Code sessions
Add a real terminal emulator to the Terminal tab, backed by tmux sessions and xterm.js. Each work item can spawn a Claude Code session that persists across browser refreshes.

**Server:**
- tmux session manager (create, attach, kill, send-keys)
- WebSocket relay bridging xterm.js ↔ node-pty ↔ tmux
- Session REST API (create, list, get, resume, close)
- Ticket prompt assembly from DB (title, body, criteria, subtasks)
- Claude session ID capture via regex for `--resume` support
- Migration: add `claude_session_id` column to `terminal_sessions`

**Client:**
- `TerminalPage` with tab bar, session info bar, and xterm.js viewport
- Epic-colored terminal tabs matching work item's epic
- New session dialog (pick from in-progress work items)
- Session resume support (`claude --resume <id>`)
- React Query hooks for session CRUD
- Board page: terminal icon on cards with active sessions
- Work item detail: View Terminal Session link + Start Session button
- Extract shared `epicColorToCss` to `utils/colors.ts`

**Fixes:**
- postinstall script to chmod +x node-pty spawn-helper (macOS prebuild issue)
- Absolute tmux path resolution for non-interactive server environments

---

## v0.1.2

### feat: favicon, logo, and rename to Agent Task System
Add custom robot logo as favicon and top-nav branding. Rename app from "Agentic-Driven Development" to "Agent Task System" across HTML title, web manifest, and navigation bar.

### fix: crop logo to robot only, remove text for dark-background use
Remove "AGENT / TASK SYSTEM" text from logo SVG and crop viewBox to just the robot. Regenerate all favicon PNGs from the cropped SVG so the robot fills the icon at every size.

### fix: regenerate favicons from SVG with transparent background, use SVG as logo
Remove white background rect from source SVG and regenerate all favicon PNGs via sharp-cli. Add `logo.svg` to `public/` and use it as the nav logo (replacing the tiny 32×32 PNG). Add SVG favicon link for modern browsers.

### fix: replace favicon PNGs with transparent-background versions
Swap out the favicon assets that had a white background with new versions generated from an SVG source with transparency.

---

## v0.1.1

### feat: top tabs navigation, board redesign, inline editing
Replace left sidebar with centered horizontal tabs in the header bar (Issues, Tasks, Terminal, Activity). Redesign the board's epic grouping to use column headers at the top with collapsible epic rows below, matching Linear's layout with vertical column separators.

- Top nav: centered tabs with flex-1 spacers, text-xl font size
- Board: remove status/agent/epic filters, default group-by-epic, Switch toggle, collapsible epic rows with column shadow separators
- Epics page: names are links to detail pages, no inline editing
- Detail pages: inline-editable titles (click to edit, blur/Enter saves)
- Tasks view: hide expand caret when no plans, clickable preview titles
- Board drawer: title links to ticket page, remove "Open ticket" button
- Rename `/library` → `/tasks` with redirect, Board → Issues, Library → Tasks
- New shadcn Switch component (CSS-only, no radix dependency)

### feat: board column polish — full-width 1fr columns, status dots, card IDs, layout fixes
- Columns use `minmax(0, 1fr)` to fill viewport width instead of fixed 15rem
- Column gaps increased to `gap-1.5` (6px) for visible lane separation
- Column headers get colored status dot icons (gray/cyan/blue/purple/emerald)
- Cards show short ID (`#xxxxxxxx`) above title in monospace
- Card footer swapped: created date on left, assigned agent on right
- Column cells in epic rows use opaque `bg-card` (not `bg-card/80`)

### fix: widen board column gaps from 1px to 4px to match Linear

### fix: board column separators use gap with background bleed-through
Replace `border-r` separators with CSS grid `gap-px` where the grid wrapper background (`border/40`) shows through the 1px gaps between column cells (`bg-card/80`). Matches the Linear-style column lane effect where the page background is visible between columns.

---

## v0.1.0

### feat: Phase 1 — data model cleanup, epic detail page, ticket page improvements

**Data model:**
- Remove themes table and all references
- Remove story kind (only task/bug)
- Remove priority entirely
- Rename `backlog` → `triage`, remove `blocked` status
- Add `slug` to initiatives/epics/work_items
- Add `color` to epics (red/blue/green/yellow/purple/orange/pink/cyan)
- Add `category` (work/personal), `awaiting_input`, `active_session_id` to work_items

**UI:**
- Epic detail page at `/epics/:id`
- Ticket page: contextual back nav (epic for tasks, parent for subtasks)
- Ticket page: tags show kind + category first, then `|` separator, then alphabetical
- Board cards: blue/green left border for work/personal category
- Richer seed data with subtasks and plan artifacts

---

## v0.7.x (pre-v0.1.0 numbering)

### feat: v0.7.2 — clickable cards, kind icons, epic grouping, inline editing, ticket views

**Board:**
- Cards clickable → slide-over detail drawer with "Open ticket" link
- Kind icons (BookOpen/CheckSquare/Bug) replace kind badges before title
- Group-by-epic toggle with swim lanes per epic
- Priority badges removed from card face

**Epics:**
- Inline-editable epic titles (click to edit, Enter to save)
- Inline-editable work item titles within epic detail
- Create Epic button with initiative picker
- Status dropdown on each epic row
- Link icon on work items to open full ticket view

**Activity:**
- Agent cards moved from Library to top of Activity tab

**Library:**
- Two-panel layout: epic tree (left) + preview (right)
- Tree shows epics > stories > plan artifacts
- Click story → preview description, tags, plans
- Click plan artifact → render markdown content

**New pages:**
- `WorkItemDetailPage` at `/work-items/:id` — full ticket view
- `KindIcon` component for consistent kind iconography
- `WorkItemDrawer` component for board slide-over

### feat: v0.7.0 — hierarchy overhaul, dead code purge, fresh schema
Replace the flat Issue/Task/Project/Workflow model with a proper hierarchy: Theme > Initiative > Epic > WorkItem (story/task/bug) > Sub-task.

Delete 30+ files (10 pages, 11 routes, 7 repos, 4 domain files, 3 migrations). Simplify from 11 task statuses to 7. Reduce UI from 10 tabs to 5 (Board, Epics, Library, Terminal placeholder, Activity).

Add seed script with sample data for development.

---

## v0.6.0

### feat: UI redesign with shadcn/ui, dark theme, and Figma-matched design
Install shadcn/ui component library (Button, Badge, Dialog, Select, Input, Textarea, Label, Separator) with Radix UI primitives and lucide-react icons. Add CSS theme variables with proper dark mode using oklch colors. Redesign all 13 pages and 4 components to match the Figma design: top header bar, icon-based sidebar, sticky page headers, semi-transparent status badges, bordered card sections, activity timelines, and consistent theme token usage.

---

## v0.5.0

### feat: projects, workflows, worktrees, chat, docs, agent dashboard
Add 6 new capabilities building toward the ticket-to-PR pipeline:

- Projects: first-class entity grouping issues/tasks with DB, API, and UI
- Workflow Runs: 11-state pipeline orchestrator (pending → completed)
- Git Worktrees: auto-create isolated worktrees when tasks start running
- Conversational Interface: chat UI with slash commands (`/create`, `/status`)
- Markdown Docs Library: browse agent-produced documents
- Agent Dashboard: computed status (working/assigned/reviewing/idle)

Infrastructure: incremental migration system (`schema_migrations` table), 3 new DB tables (projects, workflow_runs, conversations + messages), `project_id` FK on issues and tasks.

### feat: add artifact API routes, ingest diagnostics page, and artifact display in UI
- Add `getArtifactsForSession` and `getArtifactById` to artifacts repository
- Create `/api/artifacts` routes (CRUD by task, issue, session)
- Add `useArtifactsForTask`, `useArtifactsForIssue`, `useIngestFiles` hooks
- Display artifacts section on `TaskDetailPage` and `IssueDetailPage`
- Create `IngestPage` with status filter and file table
- Add Ingest nav item to sidebar

### feat: add review API routes and review submission UI
Add review CRUD endpoints (list by task, create with status transition, get by ID) and a `ReviewForm` component on the task detail page that allows submitting reviews when a task is in `needs_review` status.

### feat: add session API routes and enrich task UI with session data
Add complete CRUD + link endpoints for sessions at `/api/sessions`. Enrich task list with session counts and task detail with full session data. Add client-side hooks for sessions and improve session rendering in `TaskDetailPage`.

### feat: add `TaskUpdatedPayloadSchema` and DB admin endpoints (backup/export)

### fix: add typed request params to artifact routes

---

## v0.4.0 (pre-hierarchy era)

### feat: add issue/draft editing repos and improve API error parsing
Add `updateIssue`, `updateDraft`, `deleteDraft`, `getMaxOrdinal`, `reorderDrafts`, and `getDraftById` repository functions for v0.4.0 issue editing. Fix API client to prefer `err.error` over `err.message` for server error responses.

---

## v0 (initial)

### create: agentic-development-task-system__ai — Phase 0 + API routes

**feat: implement Phase 1 storage and ingest foundation**
SQLite schema (12 tables), Zod-validated JSON ingest pipeline with chokidar file watcher, Express server, React client shell, and e2e tests. Supports `plan.proposed` and 9 other event types with dedup, validation, and file movement to processed/rejected directories.

**feat: add API routes, plan approval flow, and connected frontend pages**
Wire up Express routes for plans (approve/reject with task materialization), tasks (CRUD + status transitions), agents, activity events, and ingest files. Build real React pages: plan inbox with approve/reject, Kanban task board, task detail, plan detail, and activity feed — all connected to the backend via React Query hooks.

**feat: restructure repo with AGENTS.md, skills dir, and organized docs**
Add AI-native project structure: root `AGENTS.md` (north star), local `AGENTS.md` files for server and client guardrails, `.claude/skills/` directory for reusable workflows, `docs/architecture.md` extracted from README, and `docs/plans/` with versioned plan files.

**feat: complete Phase 3 — task board filters, standalone creation, transition validation**
Add tag/repo/worktree/agent filter dropdowns to the Kanban board, standalone task creation form (`POST /api/tasks`), server-side transition validation using `ALLOWED_TASK_TRANSITIONS`, and a `GET /api/tasks/tags` endpoint for the tag filter. Also fixes the `assigned_agent_id` query param name mismatch in the client.

**feat: add database seed script with realistic sample data**
Creates `scripts/seed.ts` that populates the DB with 4 agents, 2 issues (1 draft, 1 approved), 7 tasks across various statuses, tags, activity events, and a review.

**refactor: rename "Plan" to "Issue" throughout codebase, rebrand to "Agentic-driven Development"**
Renames the domain concept from Plan to Issue across schema, types, API routes, UI pages, hooks, fixtures, and docs. Updates branding from "Agentic Tasks" to "Agentic-driven Development". Existing DB must be recreated (table names changed).

**fix: task board fills page and plan dates display correctly**
Add snake_case→camelCase transform in `apiFetch` to fix "NaNy ago" on plans (API returns snake_case keys but frontend types expect camelCase). Make task board columns stretch to fill viewport with proper overflow.

**fix: guard StatusBadge against undefined status and fix duplicate key warnings**

**fix: replace relative imports with @client/@shared aliases to avoid Vite proxy collision**
Relative imports like `'../api/hooks'` resolved to URL paths like `/api/hooks.ts`, which Vite's `/api` proxy intercepted and forwarded to the backend instead of serving the source file — causing a 404 and blank screen.

**fix: remove @server alias from Vite**
Remove `@server` alias from Vite config to prevent accidental bundling of Node-only server code into the browser build.

---

## Chores / Housekeeping

- **chore: rename app to "TS Agent Orchestrator"** — Update browser tab title and top-nav header label. Logo SVG intentionally unchanged.
- **chore: clean up stale files and add .DS_Store to gitignore** — Remove `agent_task_system_cute.svg` (superseded by `public/logo.svg`), `favicon_io/` (duplicated in `public/`), `asdf/` (empty junk), and `plan.md` (scratch).
- **fix: package.json version number**
- **refactor: rename folder to `services`**
- **refactor: consolidate plans/ into docs/plans/**
- **refactor: re-version plan docs** — All plan files updated to use v0.0.x / v0.x.0 numbering, reserving proper milestone markers. Updated v0.4.0 to use "issue" terminology matching the codebase rename.
- **rename plan files with descriptive names and tool suffixes**
