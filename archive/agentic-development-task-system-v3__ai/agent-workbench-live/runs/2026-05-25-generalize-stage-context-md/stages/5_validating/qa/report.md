# QA report — rebuild (after bounce 1)

## Summary

- **tests_passed**: true (342/344 full suite; 5 new tests added; 2 pre-existing snapshot failures unrelated)
- **known_issues_count**: 0 blocking (3 carried minor findings — F-001 silent fallback, F-002 visual heading noise, F-004 informational gap; details in `review.md`)

## What ran

- 5 new unit tests in `tests/test_validate_context_build.py`:
  - `test_diff_section_with_symbolic_head_and_sha` (TODO §3 item 2a positive case)
  - `test_diff_section_with_symbolic_head_no_sha_falls_back` (documented-degradation case)
  - `test_blast_radius_with_symbolic_head_and_sha` (blast-radius parallel)
  - `test_uncommitted_changes_appear_in_files_changed` (uncommitted-coverage extension)
  - `test_untracked_files_appear_in_files_changed` (untracked-coverage extension)
- 2 new deterministic E2E assertion blocks in `tests/test_e2e.py::TestE2EHappyPath::test_happy_path`:
  - Post-`/start`: assert `build-context.md` exists at the staged path; assert 5 load-bearing headings present.
  - Post-`/validate --init`: assert BOTH `build-context.md` AND `validate-context.md` exist (the cross-stage contract).
- Full pytest suite — `python -m pytest tests/` from the worktree.
- Live regeneration of this run's own `validate-context.md` and `blast-radius.txt` via direct helper invocation, confirming the §3 item 2a fix + uncommitted/untracked extension work on a real run.

## Results

### Unit tests

`tests/test_validate_context_build.py` — **14 passed, 0 failed** (was 9 pre-rebuild; +5 new cases). Log: `qa/artifacts/pytest_full_rebuild.log`.

`tests/test_build_context.py` — **16 passed, 0 failed** (unchanged from pass-1; no edits to that module in this rebuild).

`tests/test_e2e.py::TestE2EHappyPath::test_happy_path` — **passes** with the new staged-layout + cross-stage assertion blocks.

### Integration tests

Full suite — **342 passed, 2 failed** (the 2 failures are pre-existing `test_human_review.py::TestSnapshotRender` snapshot tests with date drift; also fail on master; not introduced by this rebuild). Net: +5 tests from pre-rebuild's 337-passed baseline.

### Lint / typecheck

Not run — same justification as pass-1 (no lint/typecheck infrastructure in this repo).

### Browser / Playwright

N/A.

### Smoke scripts

- Regenerated this run's own `validate-context.md` and `blast-radius.txt` via direct `validate_context.build` + `build_blast_radius` calls (script at `/tmp/regen_validate_context.py`, contents in `qa/commands.txt`). Confirmed live output:
  - `blast-radius.txt` depth-1 lists 7 real changed files (was `(no files changed yet)` pre-rebuild).
  - `validate-context.md` `## Final diff` has an empty committed-range block (no commits yet) AND a populated `### Uncommitted (worktree vs HEAD)` block with the real diffstat AND a populated `## Files changed` with `Committed` / `Uncommitted` / `Untracked` subsections.

## Captured artifacts

- `qa/artifacts/pytest_full_rebuild.log` — full suite log (live tail captured the summary).
- `runs/2026-05-25-generalize-stage-context-md/stages/5_validating/validate-context.md` — the live, non-degraded curated context for this rebuild.
- `runs/2026-05-25-generalize-stage-context-md/stages/5_validating/blast-radius.txt` — the live, non-empty blast radius.

## Known issues (informational, not blocking)

1. **F-001 carried** — silent `(not set)` fallback in `build_context._worktree_block`. Not addressed by this bounce.
2. **F-002 carried** — visual heading noise in `build-context.md` inlined template. Not addressed.
3. **F-004 new (informational)** — bounce rebuilds don't generate their own `build-context.md` because `human_review → building` doesn't go through `cmd_start.run`. The rebuild's curated entry was `change-request.md` instead. Future TODO §1 expansion could close this; out of scope.

## Untested / out of scope

- **No combined committed-AND-uncommitted unit test.** Each is covered in isolation; a combined-case test was deemed low-value (rendering is independent).
- **No E2E assertion that the rebuild's regenerated `validate-context.md` contains "Uncommitted".** The cross-stage E2E asserts file existence but not the new content. Adding `self.assertIn("Uncommitted", ...)` after a synthetic-staged-edit step in `test_happy_path` would close the gap. Recorded as a follow-up.
- **TODO §3 items 2b (board/source.py, doc_claims.py), 2c (backfill tool), 2d (BaseRefResolved event)** — out of scope for this run; remain in TODO §3.
