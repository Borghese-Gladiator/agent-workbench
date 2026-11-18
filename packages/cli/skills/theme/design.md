# Design spec: <product name>

The awb default theme. It is dense, quiet and fast, in the style of Linear. `globals.css` holds the values. This page says how to use them. A component that needs a value not on this page means this page is wrong: change the page first.

## Color tokens

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `background` | `oklch(0.995 0 0)` | `oklch(0.16 0.005 286)` | page ground |
| `card` | `oklch(0.985 0.001 286)` | `oklch(0.19 0.005 286)` | one step off the background |
| `popover` | `oklch(1 0 0)` | `oklch(0.215 0.006 286)` | menus, dialogs: things that float |
| `foreground` | `oklch(0.21 0.006 286)` | `oklch(0.97 0.002 286)` | primary text |
| `muted-foreground` | `oklch(0.52 0.012 286)` | `oklch(0.68 0.012 286)` | secondary text, metadata |
| `border` | `oklch(0.915 0.003 286)` | `oklch(0.3 0.008 286)` | hairlines, dividers |
| `primary` | `oklch(0.55 0.16 276)` | `oklch(0.65 0.15 276)` | the accent |
| `success` | `oklch(0.6 0.13 155)` | `oklch(0.7 0.13 155)` | done, healthy |
| `warning` | `oklch(0.72 0.15 75)` | `oklch(0.78 0.14 75)` | needs attention |
| `destructive` | `oklch(0.58 0.2 27)` | `oklch(0.66 0.19 25)` | delete, failed |
| `status-backlog` | `oklch(0.65 0.01 286)` | `oklch(0.6 0.01 286)` | status icon: not started |
| `status-progress` | `oklch(0.72 0.15 75)` | `oklch(0.78 0.14 75)` | status icon: in progress |
| `status-done` | `oklch(0.55 0.16 276)` | `oklch(0.65 0.15 276)` | status icon: done |
| `status-canceled` | `oklch(0.6 0.01 286)` | `oklch(0.5 0.01 286)` | status icon: canceled |

Accent: one indigo hue. Use it for the primary action, the selected row, focus rings and links. Do not use it for headings, decoration, large fills or every icon. One screen has one accent color. Status colors appear only in small status icons.

Neutrals have a slight cool tint (hue 286), so gray surfaces do not look dead. Dark mode is the main design. Check it first, then derive light mode from it.

## Type ramp

Inter, with the system stack as fallback. The base size is 13px (set on `body` in `globals.css`). Headings have a letter spacing of -0.01em.

| Role | Class | Weight | Used for |
| --- | --- | --- | --- |
| `heading` | `text-lg` | semibold | page title in the content area, when the header has no breadcrumb |
| `subheading` | `text-sm` | semibold | section titles |
| `body` | `text-sm` | normal | content, table rows |
| `label` | `text-sm` | medium | controls, field labels |
| `small` | `text-xs` | normal / medium | metadata, table auxiliaries |
| `mono` | `font-mono text-xs` | normal | code, ids |

## Spacing and density

Base unit 4px. Steps: 1, 2, 3, 4, 6, 8, 12 (Tailwind units).

- list row: `h-8` (32px), `px-3`
- control (button, input, select): `h-7` (28px), `px-2.5`
- related elements: `gap-1.5` to `gap-2`
- sections: `gap-6` to `gap-8`
- page padding: `p-4` mobile, `p-6` desktop

## Radius and elevation

- `--radius` is 0.375rem. Controls use `rounded-md`, panels `rounded-lg`, dialogs `rounded-xl`.
- Elevation: a 1px border and one surface step. Cards have no shadow.
- One soft shadow (`shadow-lg`) on popovers, menus, dialogs and sheets only.

## Layout

- App shell: 224px sidebar on `md` and up, with the `sidebar` color. Use a Sheet below `md`. Header 40px, sticky, with a breadcrumb at the left and the one primary action at the right.
- Sidebar items: `h-7`, `text-sm`, 16px icon. The selected item has the `accent` background. It has no accent-color fill.
- Content max width: `max-w-6xl` for apps, `max-w-prose` for reading.
- Breakpoints: `md` shows the sidebar. `lg` adds side panels.

## Lists, not cards

- Show a set of records as dense rows. Do not use a grid of cards.
- A row has, from left to right: a status icon, an id in `mono` and `muted-foreground`, the title, then metadata at the right.
- A row hovers with the `accent` background. The selected row has a 2px `primary` bar at the left edge.
- Group rows under a small header: the group name, a count, and a collapse toggle.
- Use a detail panel at the right for one record. Do not open a new page for it.

## Keyboard

- `Cmd+K` opens a Command palette with the shadcn `Command` component. It lists every page and every action.
- Show the key in each tooltip and menu item, with the shadcn `Kbd` style at `text-xs`.
- `j` and `k` move the selected row. `Enter` opens it.

## Icons, empty states and motion

- Icons: lucide-react, 16px, stroke width 1.5. Use no other size in the sidebar or in rows.
- Empty state: one line of text in `muted-foreground` and one button. No illustration.
- Motion: 150ms, `ease-out`. Animate only menus, dialogs, sheets, accordions and hover or focus feedback. No page transitions.

## Checks before done

- [ ] Every token has a light and a dark value.
- [ ] No hex or rgb value in a component.
- [ ] No arbitrary Tailwind values. The base size 13px comes from `globals.css`.
- [ ] Six type sizes or fewer.
- [ ] Rows are 32px high and controls are 28px high.
- [ ] A record set is a list of rows, not a grid of cards.
- [ ] One accent color on each screen.
- [ ] Dark mode reads as designed, not inverted.
