# Linear Design System — Complete Reference

> Source: https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md
> Kept verbatim as the canonical reference for the Agent Workbench dark theme.
> When restyling the app, map these tokens into `apps/web/src/styles.css` (`.dark`).

## Overview

Linear's marketing design employs a near-black canvas (#010102) paired with a four-tier surface hierarchy and a single chromatic accent in lavender-blue (#5e6ad2). The system emphasizes "dense, technical, and quietly luxurious" aesthetics through product UI screenshots as the primary visual narrative.

## Color Palette

**Primary Accent:**
- Primary: `#5e6ad2`
- Hover: `#828fff`
- Focus: `#5e69d1`
- On Primary: `#ffffff`

**Surface Hierarchy:**
- Canvas: `#010102`
- Surface-1: `#0f1011`
- Surface-2: `#141516`
- Surface-3: `#18191a`
- Surface-4: `#191a1b`

**Borders:**
- Hairline: `#23252a`
- Hairline Strong: `#34343a`
- Hairline Tertiary: `#3e3e44`

**Text:**
- Ink: `#f7f8f8`
- Ink Muted: `#d0d6e0`
- Ink Subtle: `#8a8f98`
- Ink Tertiary: `#62666d`

**Inverse & Semantic:**
- Inverse Canvas: `#ffffff`
- Inverse Surface-1: `#f5f6f6`
- Inverse Surface-2: `#f6f7f7`
- Inverse Ink: `#000000`
- Brand Secure: `#7a7fad`
- Semantic Success: `#27a644`
- Semantic Overlay: `#000000`

## Typography Scale

| Role | Size | Weight | Line Height | Letter Spacing |
|------|------|--------|-------------|----------------|
| Display XL | 80px | 600 | 1.05 | -3.0px |
| Display LG | 56px | 600 | 1.10 | -1.8px |
| Display MD | 40px | 600 | 1.15 | -1.0px |
| Headline | 28px | 600 | 1.20 | -0.6px |
| Card Title | 22px | 500 | 1.25 | -0.4px |
| Subhead | 20px | 400 | 1.40 | -0.2px |
| Body LG | 18px | 400 | 1.50 | -0.1px |
| Body | 16px | 400 | 1.50 | -0.05px |
| Body SM | 14px | 400 | 1.50 | 0 |
| Caption | 12px | 400 | 1.40 | 0 |
| Button | 14px | 500 | 1.20 | 0 |
| Eyebrow | 13px | 500 | 1.30 | +0.4px |
| Mono | 13px | 400 | 1.50 | 0 |

**Families:** Linear Display, Linear Text, Linear Mono (with SF Pro Display, system-ui fallbacks)

## Spacing System

- XXS: 4px | XS: 8px | SM: 12px | MD: 16px
- LG: 24px | XL: 32px | XXL: 48px | Section: 96px

## Border Radius

- XS: 4px | SM: 6px | MD: 8px | LG: 12px
- XL: 16px | XXL: 24px | Pill/Full: 9999px

## Component Library

**Buttons:**
- Primary: Lavender fill, 8px 14px padding, 8px radius
- Secondary: Surface-1 fill with hairline border
- Tertiary: Canvas background, plain text
- Inverse: White fill, black text

**Cards:**
- Pricing/Feature: Surface-1, 24px padding, 12px radius
- Product Screenshot: Surface-1, 24px padding, 16px radius
- Testimonial: Surface-1, 32px padding, 12px radius
- CTA Banner: Surface-1, 48px padding, 12px radius

**Inputs:**
- Text Input: Surface-1, 8px 12px padding, 8px radius
- Focus Ring: 2px `#5e69d1` outline at 50% opacity

**Navigation:**
- Top Nav: Canvas background, 56px height
- Footer: Canvas background, 64px 32px padding

## Key Design Principles

1. **Depth via surfaces, not shadows.** The four-step ladder creates hierarchy without drop shadows.

2. "Use `{colors.primary}` lavender ONLY for: brand mark, primary CTA, focus ring, link emphasis."

3. **Product dominance.** Screenshots frame every section; marketing chrome is minimal.

4. **Aggressive display tracking** (up to -3.0px at 80px) contrasts with body at -0.05px.

5. "Don't ship a light-mode marketing page" or "introduce a second chromatic accent."

## Responsive Breakpoints

- Desktop XL: 1440px
- Desktop: 1280px (3-up card grid)
- Tablet: 1024px (2-up cards)
- Mobile LG: 768px (hamburger nav, accordion pricing)
- Mobile: 480px (single column, display-xl scales to ~36px)

Touch targets: ≥40px for CTAs, ≥44px for form inputs on mobile.

---

**Note:** Linear's typefaces are proprietary; Inter or Geist Sans approximate the display and text families at weights 500–700. Geist Mono or JetBrains Mono substitute for the custom mono cut.
