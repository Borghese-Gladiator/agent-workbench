---
name: review-py-fastapi-backend
description: Code review for a Python FastAPI backend managed with Poetry. Use when the detected repo profile is `py-fastapi-backend`. Reviews routes, services, models, and tests for correctness and house conventions.
profile: py-fastapi-backend
---

# Backend Reviewer (Python / FastAPI / Poetry)

Adapted from OpenAI's `gh-address-comments` skill, then specialized to this repo. The
official skill's shape holds — **check preconditions, inspect what needs attention,
number the findings, then apply fixes** — specialized here from "address existing PR
comments" to "produce the review" for a **Python / FastAPI** backend managed with
**Poetry**.

## Preconditions
- Review **ONLY the changed files in the current worktree** (`git diff`), not the whole
  tree. This skill is injected into a stage agent running with `--setting-sources ''`,
  so assume **no `gh`, no plugins, no network** — work from the local diff alone.
- For every finding, **quote the exact lines** and cite `file:line`.
- This is a **Poetry** project. Dependencies live in `pyproject.toml` (+ `poetry.lock`);
  commands run via `poetry run`. Flag any `pip install`, bare `requirements.txt`, or a
  dependency added to code but missing from `pyproject.toml` / not reflected in the
  lockfile.

## What to check (in priority order)

1. **Correctness first.** Wrong behavior, unhandled error paths, missing `await` on a
   coroutine, blocking IO inside an `async def` route (use async clients / run in a
   threadpool), mutable default arguments, off-by-one, swallowed exceptions. A
   passing-but-wrong endpoint is the worst outcome.

2. **FastAPI conventions.**
   - Request/response bodies are **Pydantic models** with explicit types, not bare
     dicts. Flag `response_model` omissions where a schema is expected.
   - Dependencies (`Depends(...)`) for shared setup (db session, auth, settings) rather
     than re-instantiating per handler.
   - Correct **status codes** (201 on create, 204 on delete, `HTTPException` with the
     right code on failure) — not a 200 with an error body.
   - Don't block the event loop: async route → async db/HTTP client, or offload.

3. **Tests — pytest conventions.**
   - Use `parametrize` to collapse cases that differ only in inputs/expected output.
   - Use fixtures for shared setup; don't rebuild the app/client per test by hand.
   - Test the route through the app (e.g. `TestClient` / `httpx.AsyncClient`), not the
     handler function in isolation, when the behavior depends on FastAPI wiring.
   - Fewer tests, stronger assertions; assert status code AND body shape.

4. **Typing + models.** Honor type hints; flag `Any` where a concrete type or Pydantic
   model is known. Keep ORM models and API schemas distinct.

5. **Reuse over reinvention.** Before approving new code, point to the existing
   dependency/service/schema it should have used. **Quote where the established pattern
   lives.**

## Number the findings, then apply
Enumerate every finding (1, 2, 3…), one-line summary each, so the fix set is
reviewable. Then apply the fixes for blocking and should-fix items; leave nits as
comments.

## Output
A Markdown report grouped by severity (Blocking / Should-fix / Nit). Each finding:
`file:line` + quoted code + the concrete fix. End with the required ```json block:
`{ "verdict": "approve" | "request_changes", "blocking": <n>, "should_fix": <n>, "nits": <n> }`.
