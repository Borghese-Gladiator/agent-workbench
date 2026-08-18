---
name: build-ui
description: Build a beautiful, coherent UI from scratch — greenfield frontends, new apps, standalone views, or the first screens of a product that has no established visual style yet. Covers layout, a type scale, spacing rhythm, color/token discipline, light/dark, responsive rules, and a component-kit-first approach. Use ONLY when creating a UI with no existing style to match. Do NOT use when editing, extending, or adding to an existing frontend — there you match the established style instead.
---

# Build a UI from scratch

Produce a greenfield UI that reads as one coherent system: consistent spacing,
a real type scale, a disciplined token-driven palette that works in light and
dark, responsive layout, and components assembled from a kit rather than
hand-rolled one screen at a time.

This is a *craft* skill, not a workflow skill. It does not boot the stack, drive
the workbench, or open PRs. It shapes the frontend code you write when there is
no established style to inherit.

## When this fires — and when it MUST NOT

**Invoke ONLY when building a UI from scratch:**

- a new app, site, or standalone tool with no frontend yet
- the first screens of a product that has no visual language yet
- a self-contained artifact / prototype / demo page built fresh
- an explicit ask to "design", "make it look good", "build a polished UI"

**DO NOT invoke when editing or extending an existing frontend.** If the target
already has a frontend — components, tokens, a CSS/theme file, a design system,
or even a consistent ad-hoc style — that established style is authoritative.
Adding a button, a page, a modal, or a section to a styled app is an *edit*, not
a from-scratch build. In that case:

- match the existing tokens, spacing, type scale, and component patterns
- reuse the app's components and utilities; do not introduce a parallel style
- skip this skill entirely — its guidance would fight the established look

Quick test: *is there already a style here that a reasonable reviewer would
expect me to match?* If yes → edit-mode, do not use this skill. If genuinely
nothing to match → from-scratch, continue.

## Reuse, don't duplicate

Two built-in skills already carry deep craft. Defer to them rather than
restating their rules here:

- **`artifact-design`** — general visual/artifact design craft. Read it first
  for any from-scratch UI; treat it as the base layer this skill builds on.
- **`dataviz`** — MANDATORY before writing any chart, graph, plot, dashboard,
  stat tile, meter, KPI row, sparkline, or data-viz color. Do not hand-pick
  chart colors here; use its palette + validator.

This skill only adds the greenfield-app-specific scaffolding (tokens, layout,
responsive, kit-first) that those two do not spell out for a full frontend.

## Optional first step: a `design.md`

For anything beyond a single small screen, write a short `design.md` in the
project before building. It makes the output meaningfully more coherent because
every screen then references one source of truth instead of drifting. Keep it
tight — a page, not a spec:

```markdown
# Design

## Vibe
One or two lines: the feeling (calm/dense/playful/serious) and any reference.

## Tokens
- color: brand, neutrals, semantic (success/warn/danger/info), surface, text
- radius, shadow/elevation, border
- Define every token in BOTH light and dark.

## Type scale
Font family(ies) + the ramp (e.g. 12 / 14 / 16 / 20 / 24 / 32 / 48) and weights.

## Spacing
The base unit (usually 4px) and the allowed steps (4/8/12/16/24/32/48/64).

## Layout
Max content width, grid/columns, breakpoints, nav pattern.

## Components
The kit in use, plus any app-specific composites.
```

Skip `design.md` for a genuinely one-off tiny screen; still apply the rules below.

## The rules

### Tokens first, values never
Define semantic design tokens once and reference them everywhere. Never sprinkle
raw hex, raw px colors, or one-off shadows across components.

- Name by role, not value: `--color-surface`, `--color-text`, `--color-primary`,
  `--color-border`, `--color-success/warn/danger`, not `--blue-500` scattered inline.
- Radius, elevation/shadow, and border widths are tokens too.
- Every token has a light value and a dark value. No exceptions.

### Light and dark are both first-class
Design both from the start; do not bolt dark on later.

- Drive theming off tokens + a single `.dark` (or `prefers-color-scheme`) switch.
- Don't just invert — dark surfaces are near-black-with-hue, text is off-white,
  and shadows give way to subtle borders/elevation. Re-check contrast in dark.
- Target WCAG AA contrast (4.5:1 body text, 3:1 large text / UI) in both modes.

### A real type scale
Pick a modular ramp and stick to it; never type arbitrary font sizes.

- A small fixed set of sizes (e.g. 12 / 14 / 16 / 20 / 24 / 32 / 48).
- Two or three weights max. Set line-height by role (tight for headings,
  ~1.5 for body). Constrain body measure to ~60–75ch.

### Spacing rhythm on one unit
All spacing is multiples of one base unit (usually 4px). Use a fixed step set
(4 / 8 / 12 / 16 / 24 / 32 / 48 / 64). Consistent gaps and padding are the single
biggest driver of a "designed" feel. Prefer layout primitives (stack/cluster/grid
gap) over ad-hoc margins.

### Responsive by default
Design mobile-first and let layout reflow; don't build desktop-only then patch.

- A few deliberate breakpoints, not dozens of one-offs.
- Fluid where sensible (`clamp()`, `min()`, grid `auto-fit`/`minmax`) so fewer
  breakpoints are needed. Cap content width for readability on large screens.
- Verify at a narrow width (~360px) and a wide one; no horizontal scroll, no
  overlap, tap targets ≥ ~44px.

### Component-kit first
Assemble from a component library; do not hand-roll bespoke buttons, inputs,
dialogs, and menus per screen.

- Prefer an established kit (e.g. shadcn/ui + Radix, or the project's chosen kit)
  for accessible, consistent primitives. This repo's `apps/web` uses a shadcn-style
  kit — mirror that approach for new frontends here.
- Build app-specific *composites* from kit primitives; keep one canonical version
  of each pattern (one Card, one PageHeader, one EmptyState) and reuse it.
- Kit components must still consume your tokens so the whole thing stays coherent.

### Layout & hierarchy
- Establish a clear layout shell (nav + content region) before filling screens.
- One primary action per view; use size, weight, and color to rank importance.
- Align to a grid; give content room to breathe. Empty, loading, and error
  states are part of the design, not an afterthought.

## Definition of done
- Tokens defined for every color/radius/shadow, in light AND dark.
- One type scale and one spacing unit used consistently across screens.
- Layout is responsive and verified narrow + wide with no overflow.
- UI is assembled from a component kit; shared composites are not duplicated.
- Any charts went through `dataviz`; general craft checked against `artifact-design`.
- If the target already had a style, this skill was NOT used — the existing style
  was matched instead.
