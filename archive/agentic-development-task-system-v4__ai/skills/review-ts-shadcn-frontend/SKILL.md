---
name: review-ts-shadcn-frontend
description: Code review for a TypeScript + shadcn/ui + Tailwind frontend. Use when the detected repo profile is `ts-shadcn-frontend`. Reviews React components, tests, and styling for correctness and house conventions.
profile: ts-shadcn-frontend
---

# Frontend Reviewer (TS / shadcn / Tailwind)

Adapted from OpenAI's `gh-address-comments` skill, then specialized to this repo. The
official skill's shape holds — **check your preconditions, inspect what needs
attention, number the findings, then apply fixes** — specialized here from "address
existing PR comments" to "produce the review" for a **TypeScript / shadcn/ui /
Tailwind** frontend (this repo's `apps/web`).

## Preconditions
- Review **ONLY the changed files in the current worktree** (`git diff`), not the whole
  tree. This skill is injected into a stage agent running with `--setting-sources ''`,
  so assume **no `gh`, no plugins, no network** — work from the local diff alone.
- For every finding, **quote the exact lines** and cite `file:line`.

## What to check (in priority order)

1. **Correctness first.** Wrong behavior, broken state updates, missing `await`,
   stale closures in effects, incorrect dependency arrays, off-by-one in lists/keys,
   unhandled loading/error states. A passing-but-wrong component is the worst outcome.

2. **Tests — enforce the house query priority.**
   - `getByRole(role, { name })` MUST be preferred over `getByTestId`, `getByText`.
     Flag any new `getByTestId` that could be a role query.
   - Merge tests with identical setup that differ only in assertions.
   - Remove `waitFor` when the query resolves synchronously.
   - Don't test third-party component internals (e.g. Radix/shadcn primitives).
   - Fewer tests, stronger assertions.

3. **Component design.**
   - Extract a component when conditional logic grows — prefer clarity over DRY.
   - Prefer explicit JSX branches over dynamic prop objects.

4. **Styling.** Use existing Tailwind tokens / shadcn variants rather than ad-hoc
   hex values or one-off spacing. Reuse the `ui/` primitives already in the repo
   (`apps/web/src/components/ui/`); flag a hand-rolled button/input/dialog when a
   `ui/` equivalent exists.

5. **Reuse over reinvention.** Before approving new code, point to the existing
   helper/component it should have used. **Quote where the established pattern lives.**

## Number the findings, then apply
Mirroring the official skill's numbered-thread flow: enumerate every finding (1, 2,
3…), one-line summary each, so the fix set is reviewable. Then apply the fixes for
blocking and should-fix items; leave nits as comments.

## Output
A Markdown report grouped by severity (Blocking / Should-fix / Nit). Each finding:
`file:line` + quoted code + the concrete fix. End with the required ```json block:
`{ "verdict": "approve" | "request_changes", "blocking": <n>, "should_fix": <n>, "nits": <n> }`.
