# UI update — panels & sections

## Brief
Apply a "panels and sections" treatment across the four existing pages, inspired
by the observability-suite screenshots. Keep the existing Linear lavender-blue
accent (`#5e6ad2`) — adopt only the *structure*, not the green color:

- Framed bordered containers (panels) that group related content.
- Uppercase, tracked section-header labels ("STAGE LATENCY", "TOOL LATENCY
  BREAKDOWN") sitting at the top of each panel.
- Nested mini-panels / metric tiles inside a panel (the stat boxes).
- Monospace, tabular numerics for metrics.

No new pages. Existing pages only.

## Changes
1. New shared primitive `apps/web/src/components/ui/panel.tsx`
   - `Panel` — bordered, rounded `bg-card` container (the frame).
   - `PanelHeader` — uppercase tracked label + optional right-side action/eyebrow.
   - `PanelBody` — padded content slot.
   - `StatTile` — nested mini-panel: small uppercase label over a large
     mono/tabular value, on the `surface-2` step. Optional tone for the value.
   This is the one abstraction; every page composes it.

2. `pages/Usage.tsx` — biggest win. Wrap the recent-runs table in a Panel with a
   "RECENT RUNS" header + the session-count control in the header slot. Add a row
   of `StatTile`s above it (Total sessions / Total tokens / Total cost / Avg
   cost) rendered as skeletons (no runs backend yet), matching the table's
   placeholder honesty.

3. `pages/Board.tsx` — wrap the filter row + columns inside a Panel ("PIPELINE")
   with the project filter in the header slot. Columns keep their wells.

4. `pages/Projects.tsx` — wrap the registry table in a Panel ("REGISTRY") with
   the count in the header eyebrow.

5. `pages/TaskDetail.tsx` — light touch (it already has a resizable section
   layout + many tests). Convert the lifecycle rail header and the stage-cost
   bar to the section-header idiom; leave the resizable structure intact.

## Tests
### Unit
- New `panel.test.tsx`: Panel renders children; PanelHeader renders its label as
  an accessible heading; StatTile renders label + value.
- Existing page tests must still pass (Usage/Board/Projects/TaskDetail) — the
  panel wrapper must not change accessible roles/names the tests query.

### Manual (browser)
- `pnpm dev`, open each of the 4 pages.
- Usage: stat tiles + framed table, session dropdown still scopes rows.
- Board: framed pipeline panel, filter still works, create-task still opens.
- Projects: framed registry panel, New project dialog still opens.
- TaskDetail: open a task, lifecycle + stage sections read as panels; resizable
  drag still works; transcript/artifact flows unchanged.
