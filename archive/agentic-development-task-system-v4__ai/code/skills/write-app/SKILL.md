---
name: write-app
description: Enterprise code-writing for the Klaviyo `app` repo (Python / Django). Use when the detected repo profile is `app` at the implementation stage. Writes test-first code that mirrors a quoted existing precedent module and its tests.
profile: app
---

# Code Writer (Klaviyo `app` — Python / Django)

Write the change **test-first**, mirroring existing precedent. This repo demands that
new code look like the code around it; the precedent you quote is the spec for shape,
and the tests you write first are the spec for behavior.

## Preconditions
- Implement **ONLY the approved Execution Plan** in the current worktree — do not
  re-plan or re-scope. Assume **no network / no `gh`**.
- The test tree mirrors `src/learning/app/` under `tests/`. Unit tests run via
  `bin/pytest -m unit <path>`.

## How to write
1. **Locate precedent BEFORE writing.** For each module you will touch or create, find
   the nearest existing module and its mirror test file, read them, and **quote the
   `file:line` you are following** — in your output, before the new code appears. If no
   precedent exists for a behavior, say so explicitly.
2. **Write the test first.** Add the failing test case(s) in the mirror `tests/` path,
   shaped like the precedent test you quoted, THEN write the implementation that makes
   them pass. Run `bin/pytest -m unit <path>` to prove it.
3. **Follow conventions.** Use `@pytest.mark.parametrize` for case tables and shared
   `fixtures` for setup — focused, parametrized tests, not a sprawling suite. Model
   changes carry a migration. Keep querysets lazy and filtered in the DB, not in
   Python — no `.all()` then filter-in-memory.
4. **Match the neighbour.** New code mirrors the layout/imports/naming of neighbouring
   modules under `src/learning/app/` — the precedent you quoted, not your own style.

## Output
A Markdown diff report: for each change, the precedent quoted (`file:line`), the test(s)
written first, then the implementation. **Show the test command output proving the new
test failed before the implementation and passes after** (`bin/pytest -m unit <path>`) —
an implementation without that failing→passing evidence is not done. End with the
required ```json block:
`{ "precedentCitations": ["src/learning/app/.../x.py:12", ...], "testsWritten": [{ "file": "tests/.../test_x.py", "cases": ["...", "..."] }], "changes": ["..."], "commands": ["bin/pytest -m unit <path>"] }`.
`precedentCitations` MUST cite the real existing `app` files/lines you mirrored (not
placeholders); `testsWritten` MUST be non-empty and list the test files/cases you added
before the implementation code.
