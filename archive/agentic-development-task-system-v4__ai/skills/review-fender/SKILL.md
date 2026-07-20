---
name: review-fender
description: Code review for the Klaviyo `fender` repo (React / TypeScript, turbo monorepo of @klaviyo/* packages). Use when the detected repo profile is `fender`. Reviews components, hooks, and tests for correctness and house conventions.
profile: fender
---

# Frontend Reviewer (Klaviyo `fender` — React / TypeScript)

Specialized to the Klaviyo `fender` turbo monorepo (`@klaviyo/*` packages). The shape
holds — **check preconditions, inspect what needs attention, number the findings, then
apply fixes** — for a React / TypeScript frontend.

## Preconditions
- Review **ONLY the changed files in the current worktree** (`git diff`), not the whole
  tree. This skill runs in a stage agent with `--setting-sources ''`, so assume **no
  `gh`, no plugins, no network** — work from the local diff alone.
- For every finding, **quote the exact lines** and cite `file:line`.
- Tests run via `turbo test`; types via package-specific `turbo check-types`
  (CI uses stricter project-reference resolution than the root-level check).

## What to check (in priority order)

1. **Correctness first.** Wrong behavior, missing dependency-array entries in hooks,
   stale closures, unhandled loading/error states, key collisions in lists, effects that
   should be derived state. A passing-but-wrong render is the worst outcome.

2. **React / TS conventions.**
   - Conditional logic is extracted into **explicit JSX branches**, not dynamic prop
     objects; extract a component when conditional logic grows. **Quote the neighbouring
     pattern** the change should match.
   - Types are sound — flag `any` added where surrounding code is typed.
   - react-query usage matches existing mock-builder conventions
     (`buildSuccessfulUseQueryResult` needs defined data; `buildLoadingUseQueryResult`
     for loading states with data undefined).

3. **Tests — React Testing Library conventions.**
   - Prefer `getByRole(role, { name })` over `getByTestId` / `getByText` /
     `getByTextTranslated`.
   - Assert **behaviour**, not third-party component internals.
   - Merge tests that share setup and differ only in assertions; remove `waitFor` when
     `getByRole` resolves synchronously.
   - Fewer tests, stronger assertions.

4. **Reuse over reinvention.** Before approving a new component/hook/util, point to the
   existing one it should have used. **Quote where the established pattern lives.**

## Number the findings, then apply
Enumerate every finding (1, 2, 3…), one-line summary each, so the fix set is
reviewable. Then apply the fixes for blocking and should-fix items; leave nits as
comments.

## Output
A Markdown report grouped by severity (Blocking / Should-fix / Nit). Each finding:
`file:line` + quoted code + the concrete fix. End with the required ```json block:
`{ "verdict": "approve" | "request_changes", "blocking": <n>, "should_fix": <n>, "nits": <n>, "precedentCitations": ["file:line", ...], "checks": [{ "item": "...", "result": "pass" | "fail" | "na", "note": "..." }] }`.
`precedentCitations` MUST cite the real `fender` files/lines whose conventions you
compared against (not placeholders); `checks` MUST cover tests (RTL `getByRole`),
component design, and reuse.
