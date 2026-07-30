# Plan: Tasks page redesign + shared UI primitives

## Brief
Redesign `apps/web` Tasks page around a scannable table and an intentional creation flow,
per the 14-point spec. Full spec in one pass. Build reusable UI primitives (Modal, Badge,
Dropdown, CopyButton, Toast, RelativeTime, page shell) in `apps/web/src/components/`, wired
into Tasks now; other pages adopt them in a follow-up. Preserve backend behavior and add no
new persistence system — only widen the existing task list payload with fields that already
exist on the SQLite `tasks` row plus a joined repository name.

## Backend changes (thin, no new persistence)
- `packages/database/src/data-access/tasks.ts`: add `listTasksWithRepository(db)` returning
  the existing TaskRow fields + `repositoryName` via a join on `repositories`. Keep `listTasks`.
- `apps/daemon/src/routes/tasks.ts`: `GET /api/tasks` returns
  `{ taskId, repositoryId, repositoryName, prompt, phase, condition, deliveryState, createdAt, updatedAt }`.
  Also expose repositories list already available via `/api/repositories` (used by the creation
  modal's repo selector — no new endpoint needed).
- No schema migration: `phase`/`condition`/`deliveryState`/`updatedAt` already persisted.

## Status model → badge mapping
`condition` (running | awaiting-human | awaiting-external | blocked | failed | cancelled | completed)
combined with `phase` (specify → … → assimilate):
- specify + running → **Queued**
- plan + running → **Planning**
- other phase + running → **Running**
- awaiting-human / awaiting-external → **Waiting for input**
- completed / failed / cancelled / blocked → same label
Badges use icon + text (never color alone).

## Frontend components (apps/web/src/components/)
- `Badge`, `Modal` (focus trap + return focus), `DropdownMenu` (row actions),
  `CopyButton` ("Copied" confirmation), `Toast`/`ToastProvider`, `RelativeTime`
  (relative label + exact tooltip), `RepositorySelect` (searchable, shows name, keeps id),
  `SkeletonRows`, `Tooltip`, `shortId(uuid)` util.
- Typography/shell: centered max-width container + spacing scale in styles.css.

## Tasks page (apps/web/src/pages/TasksPage.tsx)
- Header row: title + primary **Create task** button (opens Modal).
- Compact dismissible info notice (icon + copy + Learn more), copy reworded — no "process-lifetime".
- Controls: search + status filter + repository filter + sort; persisted in URL query params
  (useSearchParams); default sort newest-first.
- Structured table: Task | Repository | Status | Created | Actions. Short clickable id + copy,
  repo name (id in tooltip), 2-line prompt clamp, top-aligned rows, View details.
- Row actions dropdown (state-aware): View details, Copy task id, Open repository, Cancel,
  Delete (confirm). Cancel/Delete call existing endpoints.
- States: empty (with Create), no-filter-results (Clear filters), loading (skeleton), error
  (Retry, preserves creation form data).
- Live refresh: poll `GET /api/tasks` on an interval so active statuses update without manual refresh.
- Newly created task highlighted briefly.
- Responsive: collapse secondary metadata under prompt, hide nonessential columns, keep status,
  actions to overflow, no horizontal scroll.
- a11y: focus states, AA contrast, labelled icon buttons, keyboard-navigable rows, no full-row
  click that blocks text selection, dialog focus trap/return, real labels.

## Task details experience
Enhance existing `TaskDetailPage` (already reachable at `/tasks/:repo/:task`) so a row/id click
opens it — full prompt, ids with copy, repo name+id, status, timestamps, phase, timeline, findings,
gate, cancel. (Detail page already renders most of this; add prompt/repo-name/timestamps.)

## Tests (vitest + @testing-library/react)
- Creation modal: open, validation (disabled until repo+prompt valid), submit success/error/loading.
- Repo selector shows names, submits id.
- Table: renders rows, short id + copy, repo name, prompt clamp, status badge text.
- Filtering/search/sort incl. URL param persistence; Clear filters.
- Row navigation to detail.
- Copy actions ("Copied").
- Empty / loading (skeleton) / error (Retry, form preserved) states.
- Responsive behavior (column hiding via matchMedia mock or class assertions).
- Backend: `listTasksWithRepository` join; `GET /api/tasks` payload shape.

## Manual test (browser)
1. `awb up`, open web UI → Tasks.
2. Click Create task → modal opens, repo selector lists names, Create disabled until valid.
3. Submit → row appears highlighted with status badge + relative time; no UUID typed.
4. Search / filter by status+repo / change sort → URL updates, list filters; reload keeps state.
5. Row action menu → Copy id ("Copied"), Open repository, Cancel (confirm), Delete (confirm).
6. Click row → detail page with full prompt, ids+copy, timestamps, timeline.
7. Narrow window → columns collapse, status stays, no horizontal scroll.
8. Empty DB → empty state with Create; bad filter → no-results + Clear filters.
