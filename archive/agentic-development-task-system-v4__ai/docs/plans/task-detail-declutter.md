# Task Detail declutter

## Brief
The TaskDetail page is visually overloaded: a 4-line header (project, cost/turns,
title, stage·id·status·needs-approval), a lifecycle rail that resizes but can't
collapse, and a live agent terminal that always occupies the center. Reduce the
noise without losing information.

Decisions (confirmed with user):
1. Header → single meta line + icon-only Delete button (a menu for one action
   adds no value; an icon button drops the bulky red text button and keeps it
   one click).
2. Lifecycle rail → collapsible to a thin **dot strip** (stage state dots), edge toggle.
3. Live agent terminal → collapsible disclosure, **default open**.

## Changes (apps/web/src/pages/TaskDetail.tsx)
- **Header**: collapse to title + one meta row `project · stage · status-dot · cost`.
  - Replace the big status `Badge` with a small colored dot (active/done/abandoned).
  - Fold task id into the meta row as muted `code`, keep `cost`/`turns` inline.
  - Replace the bulky red "Delete task" button with a muted trash icon button
    (aria-label "Delete task"), so the toolbar stays clean but Delete is one click.
  - Keep `needs approval` as a small badge only when at a gate.
- **Lifecycle rail**: make the left `ResizablePanel` `collapsible` with
  `collapsedSize`, driven by an `ImperativePanelHandle` + a persisted
  `workbench:lifecycle-collapsed` flag (mirror App.tsx's sidebar hook). Edge
  toggle (Panel icons). When collapsed, render only the state dots (no labels,
  no artifacts), each still clickable to select the stage (which auto-expands).
- **Live terminal**: wrap the live `RunTerminal` in a disclosure header
  (`▾ agent · <stage> · streaming  [collapse]`), default open, mirroring the
  finished-run transcript disclosure already in place. Collapsing unmounts the
  live terminal view (keeps the SSE attach? — keep mounted but hidden to avoid
  re-attach flicker; use CSS hide). Decision: keep mounted, toggle visibility,
  so the stream keeps flowing and cost events keep arriving.

## Tests
### unit (TaskDetail.test.tsx)
- Existing tests must keep passing (Delete icon keeps the `Delete task` name).
- Add: lifecycle rail collapses to dots and hides stage labels; persists flag.
- Add: live terminal disclosure toggles visibility (default open).

### manual (browser)
1. Open a task with a live run → header is one meta line; cost pill present.
2. Click the lifecycle collapse toggle → rail shrinks to dots; reload → stays collapsed.
3. Click a dot while collapsed → stage selects, rail expands.
4. Click the live terminal collapse → stream hides, artifact is primary; expand → returns.
5. Click the trash icon → Delete task → confirm dialog works.
