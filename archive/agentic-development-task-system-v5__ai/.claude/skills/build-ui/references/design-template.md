# Design spec — <product name>

Fill this in BEFORE writing a component. Keep it small: 8 useful tokens beat 30 theoretical ones.
Every value here is the single source of truth — a component that needs a value not on this page
means the page is wrong, not that the component gets an exception.

## Color tokens

Define light AND dark in the same row. A token with no dark value is the defect this file exists to
catch.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `background` | | | page ground |
| `surface` | | | one step off the background |
| `surface-elevated` | | | one further step, only where layering means something |
| `foreground` | | | primary text |
| `muted-foreground` | | | secondary text, captions |
| `border` | | | hairlines, dividers |
| `accent` | | | primary action, selection, focus |
| `success` | | | |
| `warning` | | | |
| `destructive` | | | |

**Accent policy.** One hue. Used for: primary actions, selected state, focus rings, and genuinely
important emphasis. Not for: headings, decoration, or every icon.

## Type ramp

Six sizes at most. Name the role, not the pixel value.

| Role | Size / line-height | Weight | Used for |
| --- | --- | --- | --- |
| `display` | | | one per page, at most |
| `heading` | | | section titles |
| `subheading` | | | |
| `body` | | | |
| `small` | | | captions, table cells |
| `mono` | | | code, ids, SHAs |

## Spacing rhythm

Base unit: `___`. Allowed steps: `___`. Anything else is an exception that needs a reason.

- control padding (internal, compact): `___`
- gap between related elements: `___`
- gap between sections: `___`
- page-level padding: `___`

## Radius and elevation

- radius scale: `___` (small to medium; bubbly cards are a ban)
- elevation policy: thin borders by default; shadow only where something genuinely floats
- which components may use a shadow: `___`

## Layout

- max content width: `___`
- sidebar: width, collapse behavior, breakpoint
- header: fixed or scrolling, height
- breakpoints and what changes at each

## Motion

- duration: `___`
- easing: `___`
- what animates: `___` (fast and functional; nothing decorative)

## Checks before done

- [ ] Every token above has both a light and a dark value.
- [ ] No hex/rgb value appears in a component that is not in this table.
- [ ] No arbitrary Tailwind values (`[13px]`, `[#f3f4f6]`) outside a documented exception.
- [ ] The type ramp uses six sizes or fewer.
- [ ] Dark mode reads as designed, not as an inversion.
