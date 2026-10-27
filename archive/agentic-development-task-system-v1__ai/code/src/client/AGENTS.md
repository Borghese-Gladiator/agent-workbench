# Client Guidelines

## API Calls
- All HTTP calls go through `api/client.ts` — no raw `fetch` in components or pages
- Use TanStack Query hooks from `api/hooks.ts` for all data fetching
- Mutations should also use TanStack Query's `useMutation`

## Components
- Pages live in `pages/` — one file per route
- Shared UI components live in `components/`
- Extract components when conditional logic grows; prefer clarity over DRY

## Styling
- Tailwind CSS v4 — use `@theme` directives, not `tailwind.config.js`
- Styles in `index.css` or component-level Tailwind classes

## State
- Server state: TanStack Query (never duplicate in local state)
- UI-only state: Zustand stores
- Route state: React Router params/search params

## Adding a New Page
1. Create `pages/<PageName>.tsx`
2. Add route in `router.tsx`
3. Add query hook in `api/hooks.ts` if new data is needed
4. Add API function in `api/client.ts` if new endpoint is needed
