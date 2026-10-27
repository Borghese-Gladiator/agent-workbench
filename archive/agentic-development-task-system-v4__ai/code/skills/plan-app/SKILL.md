---
name: plan-app
description: Test-first planning for the Klaviyo `app` repo (Python / Django). Use when the detected repo profile is `app` at the planning stage. Produces a TDD-shaped test plan grounded in existing pytest precedent before any code is written.
profile: app
---

# Test-First Planner (Klaviyo `app` — Python / Django)

Plan the change **test-first**. This repo demands thorough testing; the test plan is
not an afterthought — it is the spec the implementation will satisfy.

## Preconditions
- Read-only: explore the worktree, do not modify files. Assume **no network / no `gh`**.
- The test tree mirrors `src/learning/app/` under `tests/`. Unit tests run via
  `bin/pytest -m unit <path>`.

## How to plan
1. **Locate precedent.** For each module you will touch, find the nearest existing test
   file and read it. **Quote the file paths** you will mirror. If no precedent exists for
   a behavior, say so explicitly.
2. **List test cases BEFORE implementation steps.** For each behavior, name the cases
   (happy path, edge, failure) you will assert — the implementation steps come after.
   **Bind each test to a Task Brief Acceptance Criteria ID** (AC1, AC2, …): every
   criterion must have a planned validation method, and every test should cite which
   criterion it proves. If a criterion cannot be validated automatically, say so and why.
3. **Follow conventions.** Use `@pytest.mark.parametrize` for case tables and shared
   `fixtures` for setup. Keep the suite focused and parametrized — not sprawling.
4. **Then** give the ordered change list (the implementation steps), each annotated with
   which planned test(s) cover it.

## Output
A Markdown execution plan: options considered, chosen approach, the **test plan first**,
then the ordered change list. The test plan MUST include a "## Validation by criterion"
table (`Criterion ID | Validation method | Test type | Automated?`) covering every
Acceptance Criteria ID from the brief. End with the required ```json block:
`{ "approach": "...", "testPlan": [{ "criterionId": "AC1", "target": "<module/behavior>", "cases": ["...", "..."], "command": "bin/pytest -m unit <path>", "testType": "unit", "automated": true }], "precedentTests": ["tests/.../test_x.py", ...], "changeList": ["..."] }`.
`testPlan` MUST be non-empty, list cases before code, and carry a `criterionId` on each
row binding it to a brief criterion; `precedentTests` MUST cite the real existing test
files you will mirror (not placeholders).
