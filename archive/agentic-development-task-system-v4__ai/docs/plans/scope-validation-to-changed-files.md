# Plan: scope validation/baseline tests to the task's changed files

## Brief
`validation_demo` runs the project's `testCommand` (`bin/pytest -m unit` for the
enterprise `app` project) against the WHOLE repo, and on any failure
`captureBaseline` re-runs the SAME whole-repo suite on the pre-change checkout.
For a 65-line, single-file change this runs the entire app unit suite twice —
multi-minute, CPU-bound, and `spawnSync` is synchronous so it freezes the daemon
event loop (no HTTP/SSE) for up to the 15-min validation timeout. Observed live on
core-242: daemon frozen ~6 min mid-recording while `bin/pytest -m unit` ran on
`~/Klaviyo/Repos/app@master`.

Validation must be bounded to what the task changed.

## Changes
- `packages/validation/src/index.ts`: add `scopeTestCommand(command, changedTestPaths)`
  — when the command is pytest-shaped AND there are changed test paths, append them
  so pytest runs only those node ids/files. Pure string helper, unit-testable, no I/O.
  - pytest detection: command matches `/\bpytest\b/`.
  - Only scope `kind === 'test'` (typecheck/lint stay whole-repo: they're fast and
    path-scoping them is project-specific). Actually app has no typecheck/lint
    configured, so test is the only heavy one here.
  - If no changed TEST paths, leave the command unchanged (a source-only change with
    no touched test file still runs the full suite — correct, we can't know which
    tests cover it; but log it). Refinement: map changed `src/.../foo.py` →
    `tests/.../test_foo.py` is out of scope for v1; v1 scopes by changed test files.
- `apps/daemon/src/service.ts`:
  - In `runValidationDemo`: compute `changedTestPaths` once (from worktree status
    `changedFiles`, filtered to test files), and pass a scoped command into the
    static-half `test` run.
  - In `captureBaseline`: accept the SAME `changedTestPaths` so the baseline runs the
    identical scoped set on the pre-change checkout (apples-to-apples). Thread it as a
    param instead of recomputing.
  - Changed-test detection: a path under a `tests/` dir or matching `test_*.py` /
    `*_test.py` / `*.test.*` / `*.spec.*` (covers pytest + jest/vitest shapes).

## Tests
### unit
- `packages/validation`: `scopeTestCommand`
  - pytest + changed test paths -> appends them
  - pytest + no changed test paths -> unchanged
  - non-pytest command -> unchanged
  - command with existing args -> paths appended after
- `apps/daemon`: changed-test-path filter picks test files, ignores source/docs.

### manual
- Re-run `node scripts/demo.mjs --scenario core-242 --keep`; confirm the static-half
  test + baseline run only the touched `test_catalog_datasource.py`, finish in
  seconds, daemon stays responsive (no health timeouts), recording has no freeze.
