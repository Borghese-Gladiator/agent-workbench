# UI Roadmap — plan (phased PRs)

Status: PLAN (REVISED 2026-08-08 after a walkthrough critique). Grounded in a full API +
SQLite audit. Implement in the phase order below; each phase is one reviewable PR off
`timothyshee/ui-roadmap`.

## REVISION: state coherence comes before aggregate views

A walkthrough found a real data-integrity bug, confirmed live against the daemon:
task `f47a0d8e` reads `phase=specify, condition=running` in the SQLite-backed
`GET /api/tasks` list (frozen at 19:56:20) but the live Temporal workflow is
`phase=challenge, condition=awaiting-human` with a `pr-readiness` gate on the `release`
phase. **The `tasks` row stopped being written once the task parked awaiting-human**, so
the list is stale — a Board/Overview built on it would mis-column the task and Approvals
would miss it. (The detail page's own "phase=challenge but gate.phase=release" is NOT a
bug: a release gate legitimately references a later phase than `state.phase`; it's a
legibility problem — present them clearly.)

Consequence — REVISED build order (supersedes the table below where they differ):
1. **State coherence + freshness FIRST.** Summary updates on every workflow transition
   (incl. gate open/park); API exposes `workflowUpdatedAt`/`indexedAt`/`isPossiblyStale`;
   Task Detail keeps reading live Temporal and says so when the index is behind.
2. **Generalized human-gate decision + reusable GatePanel** — one route for EVERY
   `HumanGateReason` incl. `pr-readiness` (today display-only = the walkthrough dead-end),
   stale-gate guard. Finish the human-in-the-loop slice before more pages.
3. Task Detail rework (compact header, gate-on-top, tabs, readable tokens/runtime,
   freshness, Evidence→Verification).
4. Titles + retry lineage (`retryOfTaskId`/`rootTaskId`; title from first-sentence fallback).
5. Tasks + **Board as a `/tasks?view=board` view** (NOT a separate sidebar item),
   read-only, canonical-derived-status columns. Then `/`→board as default landing.
6. Approvals = awaiting-human summaries + live detail on selection + shared GatePanel.
7. Repository Detail (create-task primary, indexing health, commands, scoped tasks; simple
   path input, NO wizard).

DEFERRED (my calls, user asleep): Overview page, global Usage, global Activity — all
would be decorative on not-yet-trusted data. DROPPED: repository wizard, Run page, Jira,
draggable board, shell restyle (already good). Sidebar stays lean: Tasks / Repositories /
Approvals / Settings. Board default-landing only after phase 5.

Fixture note: the repeated identical task/repo rows are dogfood FIXTURE data (same prompt
across days of my own runs), not a normal-operation duplicate bug — but add canonical-path
uniqueness feedback in the repo phase anyway (cheap).

---
### Original phase table (kept for the per-item data-audit; order is superseded above)

## The one fact that drives sequencing

The rich data the redesign wants **already exists in SQLite** — the
`phase_attempts → agent_sessions → model_invocations` FK tree, `runtime_attribution`
(12 buckets/attempt), `context_composition` (8 buckets/session), `human_decisions`
(gate records), `findings`, `evidence`, per-invocation tokens + cost. What's missing
is almost entirely the **read path**: there is no `/api` route (and usually no query)
that exposes any of it, and the task **list** is a bare `tasks`+repo-name join with no
rollups. Two fields (`tokenBreakdown`, `runtimeAttribution`) are already returned by
the task-detail route but silently dropped by the web client's types.

So: build the data/read foundation first (Phase 0), then the pages that consume it.
Pages built before the foundation would have to fake or re-aggregate data client-side.

Also decided (item 10 — explicitly NOT doing): no Run page, no Jira integration, no
draggable workflow board. The board is a **read-only status view** driven by
`deriveTaskStatus`, not a drag-to-transition kanban.

## What each roadmap item needs, and where it lands

| # | Item | New daemon/data work needed | Phase |
| --- | --- | --- | --- |
| 9 | Retry lineage + shared task-summary projection | **New:** projection table + rollup query; lineage column + capture | 0 |
| 8 | Task-level Usage | Mostly **client typing** (`tokenBreakdown`/`runtimeAttribution` already on wire); by-session/invocation read = new query+route | 1 |
| 4 | Task Detail as the center (Phase Attempts → Agent Sessions → Model Invocations) | **New:** read queries + route for the session/invocation tree; UI restructure | 1 |
| 7 | Evidence → "Verification" tab inside Task Detail; drop from nav | Uses existing media + evidence reads; nav + IA change | 1 |
| 2 | Board at `/board` driven by `deriveTaskStatus` | Reads the Phase-0 projection | 2 |
| 1 | Overview at `/` (factory health + needs-attention) | Reads the Phase-0 projection + approvals count | 2 |
| 5 | Approvals as a real cross-task queue | **New:** list-all-pending-gates query + route | 3 |
| 6 | Repositories + Repo Detail health/commands/policies/activity | **New:** route surfacing snapshot units/commands/services/facts (data modeled, `getRepositoryCommands` exists, unrouted) | 4 |
| 3 | Keep `/tasks` dense table (search/filter/sort/bulk) | Bulk actions = batch over existing routes; can adopt projection | 2 (light) / 4 (bulk) |

## Phases (one PR each)

### Phase 0 — data foundation (item 9). No user-visible UI.
The enabler everything else reads. Two pieces:

**Decision (2026-08-08): materialized `task_summary` table** (not query-time
aggregation) — matches item 9's "shared SQLite projection" wording; pages read one
indexed table, survives restarts. The cost (keeping the row in sync inside the write
handlers) is accepted.

1. **Task-summary projection.** A denormalized per-task row carrying what the list,
   board, and overview all need without live Temporal queries or N aggregations:
   `task_id, repository_id, phase, condition, delivery_state, size, status_label`
   (from `deriveTaskStatus`), `attempt_count`, `open_finding_count`,
   `input_tokens/output_tokens/cost_usd` (rolled from `model_invocations`),
   `pending_gate_reason?`, `latest_phase_outcome`, `created_at/updated_at`.
   - Maintained by the daemon on the same `/internal/tasks` + `/internal/observability`
     writes that already fire (worker → daemon). No new worker code; the daemon
     recomputes the affected task's summary row inside those existing handlers.
   - New migration `0006_task_summary.sql` (must sort after all `0004_*`/`0005_*`),
     drizzle mirror in `schema/`, export from `schema/index.ts`.
**Decisions (2026-08-08):**
- **Status derivation lifts to `@awb/domain`** — `deriveTaskStatus(condition,phase)` becomes
  canonical in domain; `apps/web/src/lib/task-status.ts` re-exports it and keeps only the
  Badge-variant mapping. Satisfies "domain logic not in React" + gives the Board (item 2) one
  source of truth. The daemon projection uses the domain function directly.
- **Gate reason IS captured in Phase 0** (user choice) via the existing `/internal/run-state`
  write path, NOT a new route: add optional `pendingHumanGate` to `RunStateSnapshotSchema`, the
  workflow includes it when pushing the snapshot, and the daemon projects `pending_gate_reason`
  from it. No new worker→daemon channel.

2. **Retry lineage.** Add an explicit edge so a re-attempt points at what it retries.
   Minimal: `phase_attempts.retry_of TEXT NULL REFERENCES phase_attempts(id)` populated
   where the workflow currently just bumps `attempt_number`. Surface `attempt_number`
   ordering + `retry_of` in the projection / detail read.

- Route: `GET /api/tasks` switches to reading the projection (same response shape as
  today, extra fields additive). Add `GET /api/overview` returning factory-health
  counts computed from the projection (used by Phase 2).
- Tests: projection stays consistent across create → advance → retry → delete;
  rollup sums match a direct `model_invocations` sum; lineage edge set on a real retry.

### Phase 1 — Task Detail is the product (items 4, 8, 7).
- **Type the dropped fields:** extend the web client `TaskStateResponse` with
  `tokenBreakdown` + `runtimeAttribution` (already returned by the detail route).
- **New read for the session tree:** `listPhaseAttempts(taskId)` +
  `listAgentSessions(phaseAttemptId)` + `listModelInvocations(agentSessionId)` (+
  context-composition per session), one route `GET /api/tasks/:r/:t/activity` (or fold
  into detail). These queries do not exist yet — new data-access + route.
- **UI:** restructure Task Detail around **Phase Attempts → Agent Sessions → Model
  Invocations**, with a **Usage** section (task-level: by-model tokens + cost, runtime
  buckets) and a **Verification** tab that absorbs the current Evidence page (media +
  evidence + findings). Remove Evidence from the sidebar (item 7).

### Phase 2 — Board, Overview, keep Tasks (items 2, 1, 3-light).
- **`/board`:** columns = the `deriveTaskStatus` label set (Queued, Planning, Running,
  Waiting for input, Blocked, Completed, Failed, Cancelled); cards read the projection;
  read-only (item 10). Sidebar gains Board.
- **`/` Overview:** factory-health tiles (counts by status, tasks needing attention =
  pending gates + blocked + failed) from `GET /api/overview`; Repositories moves off
  `/` to `/repositories`.
- **`/tasks`:** keep the dense table; adopt projection fields (attempt/finding/token
  columns) — no behavior change to search/filter/sort.

### Phase 3 — Approvals queue (item 5).
- **New:** `listPendingHumanGates()` across all active tasks + `GET /api/approvals`.
  Today gates are only reachable one task at a time via a live workflow query; the
  `human_decisions` table has no list query. Decide source: cheap path = derive pending
  gates from the projection's `pending_gate_reason`; authoritative path = query live
  workflows for active tasks. Plan: projection-backed list, with the gate action still
  going through the existing per-task approve/reject routes.
- **UI:** `/approvals` becomes a cross-task queue (task, repo, gate reason, age, act
  inline) instead of the repo-id/task-id lookup form.

### Phase 4 — Repositories health + Tasks bulk actions (items 6, 3-bulk).
- **New route** surfacing snapshot `units/commands/services/qa_surfaces/facts` (data
  modeled; `getRepositoryCommands` exists but is unrouted) + repo activity (tasks per
  repo from the projection) + scoped usage (sum projection tokens by repo).
- **Repo Detail:** health, discovered commands, policies, activity, scoped usage.
- **`/tasks` bulk actions:** multi-select → batch cancel/delete over existing routes.

## Guardrails
- Respect the invariants: browser → `/api` JSON only; domain logic stays in core; the
  daemon owns SQLite/disk/git; no runtime string branches. The projection is maintained
  in the daemon, not the worker or the browser.
- Migrations are additive numbered `.sql` + drizzle mirror; name `0006+` to sort last.
- Each phase ships with unit tests + a real-browser check of the new pages.
```
```
