# apps/web design system

A small, dependency-free component set shared across the dashboard. Compose UI from these
primitives and the tokens in `../design/tokens.css` rather than hand-rolling styles or adding a UI
library — see the running reference at the **/styleguide** route.

## Tokens

`design/tokens.css` is the single source of truth for color, spacing (`--space-1..6`), radius
(`--radius-*`), and type. Light is the default; dark is applied under `prefers-color-scheme: dark`.
Status tones (`--tone-*`) back both `StatusBadge` and any tone-driven surface.

## Primitives

| Component | Purpose |
| --- | --- |
| `Button` | The one button. `variant="primary\|secondary\|danger"`; defaults to `type="button"`. |
| `PageHeader` | Page `<h1>` + optional right-aligned action slot. |
| `StatusBadge` | Icon + text status pill; tone drives color (never color alone). |
| `Note` | Plain always-present explainer box. |
| `InfoNotice` | Compact dismissible banner with icon + optional Learn more link. |
| `ErrorText` | Inline error, announced via `role="alert"`. |
| `Field` | Labelled form-field wrapper; associates a real `<label>` with its control by id. |
| `Modal` | Accessible dialog: focus trap, focus restore, Escape to close. |
| `ConfirmDialog` | Confirmation modal for destructive actions. |
| `DropdownMenu` | Overflow actions menu; closes on outside-click / Escape. |
| `CopyButton` | One-click copy with a transient "Copied" confirmation. |
| `Toast` / `ToastProvider` / `useToast` | Transient notifications in a polite live region. |
| `RelativeTime` | Relative label (`3 minutes ago`) with the exact time in a tooltip. |
| `RepositorySelect` | Searchable repo picker — shows names, yields the repository id (no UUID typing). |
| `TaskLookupForm` | Shared repository + task-id lookup (Approvals, Evidence). |
| `SkeletonRows` | Placeholder table rows for the loading state. |
| `CreateTaskModal` | Task-creation dialog with validation and loading/error states. |

## Conventions

- Icon-only buttons carry an accessible label (`aria-label`).
- Dialogs use `role="dialog"` + `aria-modal` and manage focus.
- Anything status-related pairs an icon with text — never rely on color alone.
- New primitives get a test (`*.test.tsx`) and a section in `StyleguidePage`.
