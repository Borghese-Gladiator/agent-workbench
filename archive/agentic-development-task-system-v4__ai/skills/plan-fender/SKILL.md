---
name: plan-fender
description: Test-first planning for the Klaviyo `fender` repo (React / TypeScript). Use when the detected repo profile is `fender` at the planning stage. Produces a TDD-shaped test plan grounded in existing RTL precedent before any code is written.
profile: fender
---

# Test-First Planner (Klaviyo `fender` — React / TypeScript)

Plan the change **test-first**. This repo demands thorough testing; the test plan is
not an afterthought — it is the spec the implementation will satisfy.

## Preconditions
- Read-only: explore the worktree, do not modify files. Assume **no network / no `gh`**.
- Tests run via `turbo test`; React Testing Library is the convention.

## How to plan
1. **Locate precedent.** For each component/hook you will touch, find the nearest
   existing test and component and read them. **Quote the file paths** you will mirror.
   If no precedent exists for a behavior, say so explicitly.
2. **List test cases BEFORE implementation steps.** Name the cases (render, interaction,
   loading/error) you will assert — implementation steps come after.
   **Bind each test to a Task Brief Acceptance Criteria ID** (AC1, AC2, …): every
   criterion must have a planned validation method, and every test should cite which
   criterion it proves. If a criterion cannot be validated automatically, say so and why.
3. **Follow conventions.** Prefer `getByRole(role, { name })`; mock react-query with
   `buildSuccessfulUseQueryResult` / `buildLoadingUseQueryResult`; merge tests that share
   setup. Fewer tests, stronger assertions.
4. **Then** give the ordered change list (the implementation steps), each annotated with
   which planned test(s) cover it.

## Output
A Markdown execution plan: options considered, chosen approach, the **test plan first**,
then the ordered change list. The test plan MUST include a "## Validation by criterion"
table (`Criterion ID | Validation method | Test type | Automated?`) covering every
Acceptance Criteria ID from the brief. End with the required ```json block:
`{ "approach": "...", "testPlan": [{ "criterionId": "AC1", "target": "<component/behavior>", "cases": ["...", "..."], "command": "turbo test --filter=\"@klaviyo/<pkg>\"", "testType": "unit", "automated": true }], "precedentTests": ["src/.../X.test.tsx", ...], "changeList": ["..."] }`.
`testPlan` MUST be non-empty, list cases before code, and carry a `criterionId` on each
row binding it to a brief criterion; `precedentTests` MUST cite the real existing test
files you will mirror (not placeholders).
