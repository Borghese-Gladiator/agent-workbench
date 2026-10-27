---
name: review-app
description: Code review for the Klaviyo `app` repo (Python / Django, managed with bin/pytest). Use when the detected repo profile is `app`. Reviews models, views, services, and tests for correctness and house conventions.
profile: app
---

# Backend Reviewer (Klaviyo `app` — Python / Django)

Specialized to the Klaviyo `app` monorepo (`src/learning/app/` Django code, `tests/`
mirroring it). The shape holds — **check preconditions, inspect what needs attention,
number the findings, then apply fixes** — for a Python / Django backend.

## Preconditions
- Review **ONLY the changed files in the current worktree** (`git diff`), not the whole
  tree. This skill runs in a stage agent with `--setting-sources ''`, so assume **no
  `gh`, no plugins, no network** — work from the local diff alone.
- For every finding, **quote the exact lines** and cite `file:line`.
- Unit tests run via `bin/pytest -m unit <path>`; the test tree mirrors
  `src/learning/app/` under `tests/`. Flag changed code whose mirror test file was not
  touched.

## What to check (in priority order)

1. **Correctness first.** Wrong behavior, unhandled error paths, swallowed exceptions,
   mutable default arguments, off-by-one, N+1 queries, missing `select_related`/
   `prefetch_related` where a loop hits the DB. A passing-but-wrong path is the worst
   outcome.

2. **Django conventions.**
   - Model changes carry a migration; migrations are reviewed for backwards
     compatibility (no destructive op without a plan). Quote the neighbouring migration
     pattern the change should follow.
   - Querysets are lazy and filtered in the DB, not in Python; no `.all()` then
     filter-in-memory.
   - New code mirrors the layout/imports of neighbouring modules under
     `src/learning/app/` — **quote the neighbour you matched.**

3. **Tests — pytest conventions.**
   - Use `@pytest.mark.parametrize` to collapse cases that differ only in
     inputs/expected output.
   - Use fixtures for shared setup; don't rebuild objects per test by hand.
   - Keep tests focused and parametrized — no sprawling suite. Fewer tests, stronger
     assertions.
   - Changed code has a corresponding unit test discoverable by `bin/pytest -m unit`.

4. **Typing.** Honor existing type hints; flag `Any` where a concrete type is known in
   surrounding code.

5. **Reuse over reinvention.** Before approving new code, point to the existing
   service/util/model it should have used. **Quote where the established pattern lives.**

## Number the findings, then apply
Enumerate every finding (1, 2, 3…), one-line summary each, so the fix set is
reviewable. Then apply the fixes for blocking and should-fix items; leave nits as
comments.

## Output
A Markdown report grouped by severity (Blocking / Should-fix / Nit). Each finding:
`file:line` + quoted code + the concrete fix. End with the required ```json block:
`{ "verdict": "approve" | "request_changes", "blocking": <n>, "should_fix": <n>, "nits": <n>, "precedentCitations": ["file:line", ...], "checks": [{ "item": "...", "result": "pass" | "fail" | "na", "note": "..." }] }`.
`precedentCitations` MUST cite the real `app` files/lines whose conventions you compared
against (not placeholders); `checks` MUST cover tests, Django conventions, and reuse.
