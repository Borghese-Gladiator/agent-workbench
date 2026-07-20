---
name: theme-linear
description: Apply Linear's design language (near-black canvas, four-tier surface ladder, lavender-blue accent, hairline borders, dense quiet UI) to the Agent Workbench frontend. Use when styling or restyling apps/web — new pages, components, or theme tokens — so the result matches Linear's look. Reference for the Linear board/card layout too.
---

# Theme: Linear

The canonical token reference is **`docs/design/linear-design.md`** (Linear's published
DESIGN.md, kept verbatim). Read it before touching theme tokens. This skill says how to
**map** that marketing reference onto our dark **product** UI in `apps/web`.

## When to use
- Adding or restyling any page/component in `apps/web` and you want it to read as Linear.
- Editing theme tokens in `apps/web/src/styles.css`.
- Building list/board/card surfaces (e.g. the Task Board) that should match Linear's
  density and hierarchy.

## Core principles (carry these into every change)
1. **Depth via surfaces, not shadows.** Use the surface ladder (canvas → surface-1 →
   surface-2/3) to separate layers. Avoid `shadow-*`; a hairline border + a one-step
   surface change is how Linear shows elevation.
2. **One chromatic accent.** Lavender `#5e6ad2` is reserved for: brand mark, primary
   button, focus ring, active-nav indicator, link emphasis. Do **not** introduce a
   second accent hue; status colors (ok/warn/danger) are the only other chroma and stay
   muted.
3. **Hairline borders everywhere.** `#23252a` for normal hairlines; cards and columns are
   separated by these, not by heavy contrast.
4. **Ink tiers for text.** Ink `#f7f8f8` (primary) → ink-subtle `#8a8f98` (secondary) →
   ink-tertiary `#62666d` (meta/labels). Map onto `--foreground` / `--muted-foreground`.
5. **Dense and quiet.** Tight radii (6–8px on controls/cards, pill for badges), compact
   spacing, small uppercase eyebrow labels (`text-[10px] tracking-wider`), tabular-nums
   for counts.

## Token mapping → `apps/web/src/styles.css` (`.dark`)
Our tokens are OKLCH; convert the Linear hexes. The intended mapping:

| Token | Linear role | Hex |
|-------|-------------|-----|
| `--background` | Canvas | `#010102` |
| `--card` / `--popover` | Surface-1 | `#0f1011` |
| `--secondary` / `--muted` / `--accent` | Surface-2/3 | `#141516` / `#18191a` |
| `--primary` / `--ring` | Accent | `#5e6ad2` |
| `--border` / `--input` | Hairline | `#23252a` |
| `--foreground` | Ink | `#f7f8f8` |
| `--muted-foreground` | Ink Subtle | `#8a8f98` |
| `--ok` / `--warn` / `--danger` | Semantic (kept muted) | — |

Provide a `--surface-2` / `--surface-3` for board column wells and nested rows.

## Linear board/card layout (Task Board)
- Columns fill the viewport height and scroll horizontally; each has a status icon +
  label + count (tabular-nums). Cards sit at the top of the full-height well.
- Columns are **not** the 16 raw lifecycle stages. The board collapses them into 8
  columns built around the four human-approval gates (where work waits on YOU), with the
  agent-only stretches folded into coarse work buckets — see `BOARD_COLUMNS` in
  `apps/web/src/pages/Board.tsx`:
  `Drafting Brief → Needs Brief Approval → Planning → Needs Plan Approval → In Progress
   → Needs Review → Needs Delivery Approval → Done`.
  Gate columns use the warn-tone slash glyph; work buckets use the dot/dashed glyph; Done
  uses the ok-tone check. (Note: `baseline_evidence` is PRE-implementation — it captures
  the repo's green pre-change state — so it lives in Planning, not In Progress.)
- Cards are **equal size** (fixed height, full column width), separated by hairlines.
- Card anatomy: monospace/eyebrow ID at top, title clamped to 2 lines, a project pill,
  a status badge, a muted created-date footer. Show only data we have on `Task` — never
  invent assignee/estimate/priority fields.

## Reuse, don't reinvent
Style with the existing `ui/` primitives (`Badge`, `Card`, `Button`) and Tailwind tokens
above — no ad-hoc hex values in components. If a primitive needs a Linear variant, add it
to the `ui/` component (e.g. a badge variant), don't inline styles per call site.
