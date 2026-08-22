---
name: build-ui
description: Build polished greenfield React interfaces using Tailwind CSS and shadcn/ui with a restrained Linear/Vercel/Raycast-style product aesthetic. Use when creating a new app, site, dashboard, tool, prototype, or standalone view that has no established visual language yet, especially when the user asks to design, polish, beautify, or build a frontend from scratch. Do not use when editing or extending an existing styled frontend; in that case preserve the existing design system instead.
---

# Build UI

Build the interface as if it belongs to a mature product team with one house style: restrained, precise, fast-looking, typography-led, neutral, and quietly premium.

Optimize for coherence over novelty. Generic is acceptable. Sloppy is not.

## Default stack

Use these defaults unless the project already specifies otherwise:

* React
* Tailwind CSS
* shadcn/ui
* Radix primitives through shadcn where applicable
* lucide-react for icons

Do not introduce another component library unless the task requires a component shadcn cannot reasonably cover.

## Design direction

Aim for the visual territory of Linear, Vercel, and Raycast without copying any one product.

Default characteristics:

* neutral or near-neutral surfaces
* one restrained accent color
* strong typographic hierarchy
* compact controls with generous page-level spacing
* thin borders instead of heavy shadows
* subtle elevation only where layering matters
* small-to-medium radii rather than bubbly cards
* crisp iconography
* dense information architecture without visual clutter
* motion that feels fast and functional
* excellent dark mode

Avoid visual novelty unless the user asks for it.

## Hard bans

Do not default to any of these:

* gradients as decoration
* giant rounded cards everywhere
* glassmorphism
* neon glows
* floating blobs or abstract background shapes
* excessive shadows
* rainbow palettes
* oversized hero text in application UIs
* center-aligned dashboard content
* cards inside cards inside cards
* a border around every possible region
* icons inside colored circles unless meaning requires it
* decorative charts or fake analytics
* gratuitous animations
* one-off arbitrary Tailwind values when a standard token exists

If the interface still looks good after removing an effect, remove the effect.

## Establish the system first

Before building more than a tiny one-screen UI, define a small visual system in code or in a short `design.md`.

Specify:

* surface and text tokens for light and dark
* one accent color
* border color
* semantic success, warning, and destructive colors
* radius scale
* shadow/elevation policy
* type ramp
* spacing rhythm
* max content width
* sidebar/header behavior

Keep the system intentionally small. Prefer 8 useful tokens over 30 theoretical ones.

## Color

Start neutral.

Use a palette structurally similar to:

* background: near-white / near-black
* surface: one subtle step away from background
* elevated surface: one additional step
* foreground: near-black / near-white
* muted foreground: mid neutral
* border: low-contrast neutral
* accent: one saturated but controlled hue

Use the accent sparingly for primary actions, selected states, focus, and important emphasis.

Do not use the accent as large-area background fill unless the user explicitly wants a branded or marketing-heavy look.

Prefer semantic CSS variables and shadcn-compatible tokens such as:

```css
--background
--foreground
--card
--card-foreground
--popover
--popover-foreground
--primary
--primary-foreground
--secondary
--secondary-foreground
--muted
--muted-foreground
--accent
--accent-foreground
--destructive
--border
--input
--ring
```

Define both light and dark values from the start.

## Typography

Let typography do most of the visual work.

Default to a clean sans-serif already available in the project. If choosing a web-safe or system stack, prefer a modern system sans stack. Do not add a custom font dependency unless it materially improves the product.

Use a compact ramp such as:

* 12px: metadata, labels, table auxiliaries
* 14px: controls, secondary text, dense body text
* 16px: primary body text
* 20px: section heading
* 24px: page heading
* 30–36px: rare product/marketing heading

Use 2–3 weights total.

Prefer medium weight for labels and controls, semibold for headings, normal for body copy.

Keep application headings relatively compact. A dashboard page title usually does not need to be 48px.

## Spacing

Use a 4px base rhythm.

Prefer these values:

`4, 8, 12, 16, 20, 24, 32, 40, 48, 64`

Within components, keep spacing compact. Between major page sections, increase spacing substantially.

A reliable default:

* icon-to-label: 8px
* field label-to-control: 6–8px
* control groups: 12–16px
* card padding: 16–24px
* section gap: 32–48px
* page padding: 16px mobile, 24–32px desktop

Avoid arbitrary margins. Prefer `gap-*` on stacks, flex, and grid containers.

## Radius and borders

Default radius language:

* controls: 6–8px
* cards/panels: 8–12px
* dialogs/popovers: 10–12px
* pills: only for tags, statuses, segmented controls, and true pill-shaped UI

Do not make every rectangle `rounded-2xl`.

Use 1px subtle borders for separation. Use shadows only for overlays, menus, dialogs, or clear elevation changes.

## Page composition

Build the shell before the details.

For application UIs, prefer one of these structures:

1. sidebar + top content header + main region
2. compact top navigation + constrained main region
3. split-pane workspace for tools that need persistent context

Keep the main content aligned to a consistent grid.

For most product pages:

* put page title and description at top-left
* put the primary action at top-right when appropriate
* keep filters/search close to the content they affect
* reserve full-width treatment for content that benefits from it
* constrain reading-heavy content to a narrower measure

Do not wrap every section in a Card. Use whitespace and separators first; use Card when the content is genuinely a distinct surface or interactive object.

## Hierarchy

Every screen must answer these immediately:

1. Where am I?
2. What is the most important information?
3. What can I do next?

Use one visually dominant primary action per view.

Use muted text aggressively for metadata and explanation instead of introducing extra colors.

Keep destructive actions visually quiet until context makes them relevant.

## shadcn/ui first

Use shadcn components before creating primitives from scratch.

Prefer components such as:

* Button
* Input
* Textarea
* Select
* Checkbox
* RadioGroup
* Switch
* Tabs
* Dialog
* Sheet
* Popover
* DropdownMenu
* Tooltip
* Command
* Table
* Badge
* Avatar
* Separator
* Skeleton
* Sonner/Toast where available

Compose these into app-specific components such as:

* PageHeader
* FilterBar
* DataTable
* EmptyState
* SettingsSection
* ResourceList
* DetailPanel
* SearchCommand

Do not duplicate variants of the same composite without a clear reason.

## Buttons

Keep button hierarchy simple:

* `default`: primary action
* `secondary` or `outline`: normal secondary action
* `ghost`: low-emphasis contextual action
* `destructive`: destructive confirmation or explicit destructive action

Avoid several filled buttons competing in one region.

Use icon-only buttons only when the icon is universally recognizable or has a tooltip.

## Forms

Make forms boring in the best way.

Use:

* labels above controls
* helper/error text directly below
* consistent field widths
* clear grouping
* visible focus states
* inline validation only when useful

Do not use placeholder text as the only label.

For long settings forms, group controls into titled sections separated by whitespace or separators rather than putting each field in a card.

## Tables and dense data

Favor tables for genuinely tabular information rather than inventing card grids.

Use:

* compact row height
* muted secondary columns
* tabular numerals for numeric data when available
* right alignment for numeric values
* persistent column alignment
* row hover only when rows are interactive
* subtle separators

Keep bulk actions, search, filters, and pagination visually attached to the table.

## Empty, loading, and error states

Design these deliberately.

Empty state:

* concise title
* one sentence of explanation at most
* one primary next action when useful
* optional simple icon

Loading state:

* use skeletons matching final geometry
* avoid full-page spinners for content-heavy views

Error state:

* explain what failed in plain language
* provide a recovery action if one exists
* avoid alarming styling unless the error is destructive or blocking

## Icons

Use lucide-react by default.

Use icons at 14–18px in controls and 18–20px in navigation unless the context needs otherwise.

Keep stroke weight visually consistent.

Do not mix icon families.

Do not use an icon when text alone is clearer.

## Motion

Use motion sparingly and quickly.

Good uses:

* dropdown/popover enter/exit
* dialog/sheet transitions
* accordion expansion
* selection-state transitions
* subtle hover/focus feedback

Typical duration: 100–200ms.

Avoid ornamental movement, parallax, or long easing sequences in application UI.

## Responsive behavior

Design mobile-first, then increase information density with width.

Verify around 360px and at a wide desktop width.

On small screens:

* collapse sidebars into a Sheet/drawer when needed
* stack page-header actions
* allow tables to scroll only when a better mobile representation would distort the data
* turn split panes into navigable single panes
* keep tap targets roughly 44px where practical

Avoid breakpoint proliferation. Prefer fluid grids and a few deliberate breakpoints.

## Accessibility

Treat accessibility as baseline quality.

* preserve visible keyboard focus
* use semantic elements
* keep body-text contrast at WCAG AA
* associate labels and fields correctly
* give icon-only controls accessible names
* preserve sensible tab order
* ensure dialogs and menus use accessible primitives
* do not communicate status by color alone

Rely on Radix/shadcn behavior where appropriate rather than recreating interaction semantics manually.

## Implementation style

Keep React components simple and composable.

Prefer:

* small app-specific components
* declarative arrays for repeated navigation or actions
* shared Tailwind utilities through `cn()`
* semantic variants via `class-variance-authority` when the codebase already uses it
* CSS variables for theme tokens

Avoid:

* giant monolithic page components
* style objects for ordinary styling
* inline hex colors
* arbitrary values like `mt-[13px]` without strong reason
* duplicated Tailwind class strings for a repeated pattern

## Quality pass

Before considering the UI complete, inspect it as a whole and simplify.

Check:

* Is the page hierarchy obvious in under three seconds?
* Is there exactly one dominant action?
* Are there unnecessary cards?
* Are there unnecessary borders?
* Are radii too large?
* Is the accent color overused?
* Are headings larger than they need to be?
* Is there enough space between major sections?
* Are controls internally compact and aligned?
* Does dark mode look designed rather than inverted?
* Does the mobile layout feel intentional?
* Could any decorative effect be removed without losing meaning?

When in doubt, remove decoration before adding more.

## Definition of done

Finish only when:

* React + Tailwind + shadcn/ui are used consistently unless the project requires otherwise
* the screen follows the restrained Linear/Vercel/Raycast-inspired house style
* light and dark tokens are coherent
* typography and spacing use a limited scale
* hierarchy and primary action are obvious
* primitive controls come from shadcn where practical
* mobile and desktop layouts both work
* loading, empty, and error states exist where relevant
* keyboard/focus behavior is preserved
* arbitrary one-off styling is minimized
* decorative excess has been removed

If an existing styled frontend is present, do not apply this visual language over it. Match the product that already exists.
