# Build UI

Read this before any UI work. It sets the stack, the default theme, and the PWA rules.

## 1. Decide what applies

- The repo already has a styled frontend: match it. Use its stack, its tokens and its components. Skip sections 3 and 5. Sections 4 and 6 still apply.
- The task or the repo names a stack or a theme: use it. The rest of this file fills only the gaps.
- Nothing is specified: use everything in this file.

## 2. Stack

Unless something else is specified:

- React + TypeScript, with Vite for a new app.
- Tailwind CSS v4.
- shadcn/ui for every primitive (Button, Input, Select, Dialog, Sheet, DropdownMenu, Tabs, Table, Tooltip, Command, Badge, Skeleton, Sonner). Add them with `npx shadcn@latest add <name>`. Do not write a primitive that shadcn has.
- lucide-react for icons. Do not mix icon families.
- No second component library.

## 3. Default theme

When the app has no theme, use the awb default design system in the `theme/` folder next to this file:

1. Run `npx shadcn@latest init`.
2. Replace the token blocks (`:root`, `.dark`, `@theme inline`) in the generated CSS file with `theme/globals.css`.
3. Copy `theme/design.md` to `design.md` at the app root. Change the product name. Change the accent only if the task asks for a brand color.
4. Every color, radius and size in a component comes from those tokens. No hex values and no arbitrary values like `mt-[13px]` in components.

Dark mode: toggle the `dark` class on `<html>`. Default to the system setting.

## 4. Design rules

The look is restrained and product-like: neutral surfaces, one accent, strong type, thin borders. Coherent beats novel.

Composition:
- Build the shell first: sidebar + header + main, or top nav + constrained main.
- Page title and description top-left. The one primary action top-right.
- Every screen answers: where am I, what matters most, what can I do next.
- Exactly one filled primary button per region.
- Use whitespace and separators first. Use a Card only for a real distinct object.
- Use a table for tabular data, not a card grid. Right-align numbers, use `tabular-nums`.

Type and space:
- Sizes 12 / 14 / 16 / 20 / 24 px. 30+ only on marketing pages.
- Weights: normal for body, medium for labels and controls, semibold for headings.
- 4px rhythm: 4, 8, 12, 16, 24, 32, 48, 64. Use `gap-*`, not ad hoc margins.
- Radius: 6–8px controls, 8–12px panels. Pills only for badges and segmented controls.

Do not use: decorative gradients, glassmorphism, glows, background blobs, heavy shadows, rainbow palettes, giant hero text in an app, centered dashboards, cards inside cards, a border around every region, icons in colored circles, fake charts, decorative animation.

If the UI still looks good after you remove an effect, remove it.

States: every data view has a loading state (Skeleton in the final shape), an empty state (title, one sentence, one action), and an error state (plain words, a retry when one exists).

Motion: 100–200ms, only for menus, dialogs, sheets, accordions and state changes.

Responsive: mobile first. Check at 360px and at 1440px. The sidebar becomes a Sheet on small screens. Tap targets about 44px.

Accessibility: visible focus, semantic elements, labels on every field, accessible names on icon-only buttons, WCAG AA contrast, status not shown by color alone.

## 5. A new web app is always a PWA

When the task creates a new web app, make it an installable PWA.

With Vite:

1. `npm i -D vite-plugin-pwa @vite-pwa/assets-generator`
2. Add one square `public/logo.svg`. Run `npx pwa-assets-generator --preset minimal-2023 public/logo.svg`.
3. In `vite.config.ts`:
   ```ts
   VitePWA({
     registerType: "autoUpdate",
     manifest: {
       name: "<App name>",
       short_name: "<Short>",
       description: "<one line>",
       theme_color: "<background token, light>",
       background_color: "<background token, light>",
       display: "standalone",
       start_url: "/",
       icons: [
         { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
         { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
         { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
       ],
     },
     workbox: { navigateFallback: "/index.html" },
   })
   ```
4. In `index.html`: `<meta name="theme-color">`, `<link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png">`, and the viewport meta.
5. The service worker runs only in a build. Start the app in the run file with `npm run build && npx vite preview --port {port} --strictPort`.

With Next.js (only when specified): use `app/manifest.ts` and `@serwist/next`.

Add these claims to the task, so `awb prove` checks the PWA:

- "`/manifest.webmanifest` returns JSON with a name, `display: standalone` and a 512x512 icon."
- "After the first load, the page has an active service worker."
- "After the first load, the page reloads and shows its main heading while the browser is offline."

## 6. Check before you commit

- The page hierarchy is clear in three seconds.
- One dominant action per view.
- No stray hex values, no arbitrary Tailwind values.
- Dark mode looks designed, not inverted.
- 360px and 1440px both look intentional.
- Loading, empty and error states exist.
- You removed every decoration that adds no meaning.
