# Design spec: <product name>

The awb default theme. `globals.css` holds the values. This page says how to use them. A component that needs a value not on this page means this page is wrong: change the page first.

## Color tokens

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `background` | `oklch(0.995 0 0)` | `oklch(0.155 0.004 286)` | page ground |
| `card` | `oklch(0.985 0.001 286)` | `oklch(0.19 0.005 286)` | one step off the background |
| `popover` | `oklch(1 0 0)` | `oklch(0.215 0.006 286)` | menus, dialogs: things that float |
| `foreground` | `oklch(0.21 0.006 286)` | `oklch(0.97 0.002 286)` | primary text |
| `muted-foreground` | `oklch(0.52 0.012 286)` | `oklch(0.68 0.012 286)` | secondary text, metadata |
| `border` | `oklch(0.915 0.003 286)` | `oklch(0.28 0.007 286)` | hairlines, dividers |
| `primary` | `oklch(0.55 0.16 276)` | `oklch(0.65 0.15 276)` | the accent |
| `success` | `oklch(0.6 0.13 155)` | `oklch(0.7 0.13 155)` | done, healthy |
| `warning` | `oklch(0.72 0.15 75)` | `oklch(0.78 0.14 75)` | needs attention |
| `destructive` | `oklch(0.58 0.2 27)` | `oklch(0.66 0.19 25)` | delete, failed |

Accent: one indigo hue. Use it for the primary action, the selected state, focus rings and links. Do not use it for headings, decoration, large fills or every icon.

Neutrals have a slight cool tint (hue 286), so gray surfaces do not look dead.

## Type ramp

System sans stack. No web font unless the brand needs one.

| Role | Class | Weight | Used for |
| --- | --- | --- | --- |
| `heading` | `text-2xl` | semibold | page title, one per page |
| `subheading` | `text-xl` / `text-base` | semibold | section titles |
| `body` | `text-sm` (app) / `text-base` (reading) | normal | content |
| `label` | `text-sm` | medium | controls, field labels |
| `small` | `text-xs` | normal / medium | metadata, table auxiliaries |
| `mono` | `font-mono text-xs` | normal | code, ids |

## Spacing

Base unit 4px. Steps: 1, 2, 3, 4, 6, 8, 12, 16 (Tailwind units).

- control padding: `px-3 py-2`
- related elements: `gap-2` to `gap-3`
- sections: `gap-8` to `gap-12`
- page padding: `p-4` mobile, `p-6` to `p-8` desktop

## Radius and elevation

- `--radius` is 0.5rem. Controls use `rounded-md`, panels `rounded-lg`, dialogs `rounded-xl`.
- Elevation: a border plus one surface step. Shadows (`shadow-sm`, `shadow-lg`) only on popovers, menus, dialogs and sheets.

## Layout

- App shell: 240px sidebar on `md` and up; a Sheet below `md`. Header 56px, sticky.
- Content max width: `max-w-6xl` for apps, `max-w-prose` for reading.
- Breakpoints: `sm` stacks header actions in a row, `md` shows the sidebar, `lg` adds side panels.

## Motion

- 150ms, `ease-out`.
- Animate only menus, dialogs, sheets, accordions and hover or focus feedback.

## Checks before done

- [ ] Every token has a light and a dark value.
- [ ] No hex or rgb value in a component.
- [ ] No arbitrary Tailwind values without a written reason here.
- [ ] Six type sizes or fewer.
- [ ] Dark mode reads as designed, not inverted.
