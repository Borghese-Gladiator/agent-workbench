---
name: write-fender
description: Enterprise code-writing for the Klaviyo `fender` repo (React / TypeScript). Use when the detected repo profile is `fender` at the implementation stage. Writes test-first code that mirrors a quoted neighbouring component/hook and its RTL tests.
profile: fender
---

# Code Writer (Klaviyo `fender` — React / TypeScript)

Write the change **test-first**, mirroring existing precedent. This repo demands that
new code look like the code around it; the precedent you quote is the spec for shape,
and the tests you write first are the spec for behavior.

## Preconditions
- Implement **ONLY the approved Execution Plan** in the current worktree — do not
  re-plan or re-scope. Assume **no network / no `gh`**.
- Tests run via `turbo test --filter="@klaviyo/<pkg>"`; React Testing Library is the
  convention.

## How to write
1. **Locate precedent BEFORE writing.** For each component/hook you will touch or
   create, find the nearest existing component/hook and its test, read them, and
   **quote the `file:line` you are following** — in your output, before the new code
   appears. If no precedent exists for a behavior, say so explicitly.
2. **Write the test first.** Add the failing RTL test case(s) next to the precedent
   test you quoted, THEN write the implementation that makes them pass. Run
   `turbo test --filter="@klaviyo/<pkg>"` to prove it.
3. **Follow conventions.** Prefer `getByRole(role, { name })` over `getByTestId` /
   `getByText`; mock react-query with `buildSuccessfulUseQueryResult` (defined data) /
   `buildLoadingUseQueryResult` (loading, data undefined); merge tests that share
   setup; drop `waitFor` when `getByRole` resolves synchronously. Fewer tests,
   stronger assertions.
4. **Match the neighbour.** Conditional logic goes in **explicit JSX branches**, not
   dynamic prop objects; extract a component when conditional logic grows. New code
   mirrors the precedent you quoted, not your own style.

## Output
A Markdown diff report: for each change, the precedent quoted (`file:line`), the test(s)
written first, then the implementation. **Show the test command output proving the new
test failed before the implementation and passes after**
(`turbo test --filter="@klaviyo/<pkg>"`) — an implementation without that failing→passing
evidence is not done. End with the required ```json block:
`{ "precedentCitations": ["src/.../Button.tsx:12", ...], "testsWritten": [{ "file": "src/.../X.test.tsx", "cases": ["...", "..."] }], "changes": ["..."], "commands": ["turbo test --filter=\"@klaviyo/<pkg>\""] }`.
`precedentCitations` MUST cite the real existing `fender` files/lines you mirrored (not
placeholders); `testsWritten` MUST be non-empty and list the test files/cases you added
before the implementation code.
