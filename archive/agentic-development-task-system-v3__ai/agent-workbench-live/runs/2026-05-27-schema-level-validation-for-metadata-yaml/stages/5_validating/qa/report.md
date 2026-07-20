# QA report

## Summary

- **tests_passed**: yes (for this run's work) — 28/28 in `tests.test_metadata`, 413/415 across the suite. The 2 failures are pre-existing snapshot tests in `test_human_review.py`.
- **known_issues_count**: 0 (no issues attributable to this run's work)

## What ran

- Full unit-test suite via stdlib `unittest discover` against `agent-workbench-live/tests`.
- Targeted re-run of just `tests.test_metadata` (the file most heavily modified by this run) to keep its output isolated.
- Manual-QA script `qa/artifacts/validate_real_runs.py` that pulls all 20 real-run `metadata.yaml` files from master at `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/`, validates each against the new schema, and reports real-vs-unknown-key problem counts. This implements acceptance criterion #2 as an out-of-test-suite cross-check.

No lint / typecheck / Playwright / smoke-script passes were run — the project is stdlib-only Python with no linter or type checker configured.

## Results

### Unit tests

Full suite: `Ran 415 tests in 93.242s. FAILED (failures=2)`. The 2 failures are:

- `tests.test_human_review.TestSnapshotRender.test_happy_snapshot`
- `tests.test_human_review.TestSnapshotRender.test_bounce_pass2_snapshot`

Both compare a rendered `HUMAN_REVIEW.md` against a date-baked `*.expected.md` fixture whose `run_id` is `2026-05-22-{happy,bounce}-snap`. Today's run (2026-05-27) regenerates the rendering with `2026-05-27-*-snap`, plus 152-char diffs from changed `created_at` timestamps. The fixtures live under `tests/snapshots/` and have not been touched by this run (`git diff master -- agent-workbench-live/tests/snapshots/ agent-workbench-live/tests/test_human_review.py` is empty). The builder also flagged these as pre-existing in `docs/LOG.md`. Pre-existing status confirmed.

`tests.test_metadata` (this run's focus): `Ran 28 tests in 0.565s. OK`. Breakdown:

- `TestMetadata` — 8 tests, all pre-existing, all pass.
- `TestValidator` — 12 tests, new in this run. Cover the schema walker against synthetic dicts: missing-top-level required (10 subTests), missing-nested required (10 subTests under `target.repo`, `target.worktree`, `validation`), wrong-type at root and nested, enum violations on `status` and `target.repo.mode`, `eq_violation` on `schema_version`, unknown keys at root + nested, free-form passthrough for `scope`/`artifacts`, `int`-rejects-`bool`.
- `TestValidationMode` — 5 tests, new. Drive `metadata.load()` end-to-end with on-disk config mutations to flip warn/strict mode.
- `TestDuplicateMetadataIntegrity` — 2 tests, new. Plant a second `metadata.yaml` under `stages/1_draft/` and assert hard-fail in both warn and strict modes.
- `TestRealRunsLoadClean` — 1 test, new. Walks the master-side `runs/*/metadata.yaml` and asserts each validates with zero non-`unknown_key` problems. Skipped if master path is unreachable.

Logs:

- `qa/artifacts/full-suite.log`
- `qa/artifacts/test-metadata.log`

### Integration tests

No separate integration tier — `test_e2e.py` and `test_integration.py` are bundled into the unit suite above. Both run clean.

### Lint / typecheck

Not run. Project is stdlib-only with no linter or type checker.

### Browser / Playwright

Not applicable — no UI surface in this change.

### Smoke scripts

`qa/artifacts/validate_real_runs.py` (manual-QA real-runs script):

```
found 20 runs

  OK    2026-05-18-poker: 0 real, 0 unknown
  OK    2026-05-21-better-worktree-name-template: 0 real, 0 unknown
  OK    2026-05-22-audit-unit-tests-for-duplication: 0 real, 0 unknown
  OK    2026-05-22-context-graph: 0 real, 0 unknown
  OK    2026-05-22-human-review-polish: 0 real, 0 unknown
  OK    2026-05-22-s2-attrs: 0 real, 0 unknown
  OK    2026-05-22-shogi-core: 0 real, 0 unknown
  OK    2026-05-22-token-efficiency-tracking: 0 real, 0 unknown
  OK    2026-05-24-auto-merge-on-complete: 0 real, 0 unknown
  OK    2026-05-24-cli-stop-banner-on-agent-stopping-transitions: 0 real, 0 unknown
  OK    2026-05-24-fix-generated-lines-base-ref-head: 0 real, 0 unknown
  OK    2026-05-24-token-efficiency-pass-2: 0 real, 0 unknown
  OK    2026-05-25-base-ref-sha-plumbing-across-remaining-con: 0 real, 0 unknown
  OK    2026-05-25-each-worktree-owns-its-own-run-dir: 0 real, 0 unknown
  OK    2026-05-25-generalize-stage-context-md: 0 real, 0 unknown
  OK    2026-05-25-lifecycle-papercuts-lock-ready-banner: 0 real, 0 unknown
  OK    2026-05-25-shengji-browser-game: 0 real, 0 unknown
  OK    2026-05-25-structured-human-review-handoff: 0 real, 0 unknown
  OK    2026-05-26-board-freshness-across-worktrees: 0 real, 0 unknown
  OK    2026-05-27-campaign-performance-summary-drs: 0 real, 0 unknown

RESULT: every real run validates clean under warn-mode rules (zero non-unknown_key problems).
```

Acceptance criterion #2 met: all 20 real runs load clean under default mode. Notably, the `unknown_key` count is also zero across the board — meaning the schema is a precise (not just sufficient) fit for the metadata shape already in use.

## What was NOT tested

- **No multi-process / concurrency test of the duplicate-file guard.** The guard runs in-process and races against a hypothetical concurrent writer aren't covered. Out of scope — the only documented writer is `metadata.save()` and it's single-threaded.
- **No fuzzing of the schema walker.** Property-based tests against `_walk` would catch edge cases the parametrized cases miss. Out of scope for this run; current schema has no such shapes.
- **No bench / load test of the new `rglob`-per-load cost.** The board hot path uses `_load_run_from_dir` in `lib/runs.py` which reads YAML directly and bypasses `metadata.load()` (verified by reading `lib/board/source.py:505-511` and `lib/runs.py:326-338`). Only `cmd_*` paths trigger the new validator, once per command — perceptibly cheap.

## Captured artifacts

- `qa/artifacts/full-suite.log` — verbose output of all 415 tests.
- `qa/artifacts/test-metadata.log` — verbose output of the 28 metadata tests.
- `qa/artifacts/validate_real_runs.py` — the manual-QA script.
- `qa/artifacts/validate_real_runs.log` — its output (also reproduced above).
