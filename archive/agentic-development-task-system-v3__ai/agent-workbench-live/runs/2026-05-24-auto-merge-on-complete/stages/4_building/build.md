# Build report

## What changed

`agent-workbench complete <id>` now performs `git merge --no-ff <worktree_branch>` into the parent branch as part of the `human_review → done` transition. Successful completes record `completion_ref: merge:<full-sha>` and emit a `WorktreeMerged` event; conflicting merges run `git merge --abort`, emit `MergeConflict`, and leave the run in `human_review`. The board surfaces legacy `done` runs whose `completion_ref` still starts with `local-branch:` with a `⚠ unmerged` badge. The three pre-existing orphan runs (`2026-05-22-context-graph`, `…-audit-unit-tests-for-duplication`, `…-token-efficiency-tracking`) had their `completion_ref` backfilled via a one-shot script.

## Files changed

- `agent-workbench-live/lib/repos.py` — added `MergeConflictError`, `worktree_is_clean`, `worktree_dirty_files`, `current_branch`, `resolve_parent_branch`, `merge_no_ff`. All git logic lives behind this module; `cmd_complete` is a thin orchestrator.
- `agent-workbench-live/lib/cli/cmd_complete.py` — rewritten. Pre-flights the worktree, calls `merge_no_ff` inside the per-run lock, emits `WorktreeMerged` on success / `MergeConflict` on failure. Adds `--no-merge` escape hatch + keeps `--completion-ref` override.
- `agent-workbench-live/schemas/events.jsonl` — appended `WorktreeMerged` and `MergeConflict` schema entries.
- `agent-workbench-live/lib/board/source.py` — `RunSnapshot.completion_ref: str | None` carries the raw label from `metadata.completion`.
- `agent-workbench-live/lib/board/app.py` — `done` cards print `⚠ unmerged (completion_ref is a label, not a merge SHA)` when `completion_ref` starts with `local-branch:`.
- `agent-workbench-live/.claude/commands/complete.md` — pre-flight one-liner + failure-mode docs (dirty worktree, conflict, detached HEAD) + escape-hatch flags.
- `docs/lifecycle.md` — `done` section rewritten: lists the new pre-flight + merge steps, `--no-merge` / `--completion-ref` escape hatches, and clarifies that `done` now means accepted **and** merged.
- `agent-workbench-live/tools/backfill_completion_refs.py` — one-shot script (run once, idempotent on re-run) that rewrites the three orphan runs' `completion_ref` from `local-branch:<branch>` to `merge:<full-sha>` (`c6357454…`, `a02dd167…`, `271ab584…`).
- `agent-workbench-live/runs/2026-05-22-{context-graph,audit-unit-tests-for-duplication,token-efficiency-tracking}/metadata.yaml` — backfill applied.
- `agent-workbench-live/tests/test_repos.py` — NEW. 15 unit tests covering the new helpers.
- `agent-workbench-live/tests/test_board_snapshot.py` — extended `seed_run` with `completion_ref`; added `TestUnmergedBadge` (3 tests) + `test_completion_ref_passthrough`.
- `agent-workbench-live/tests/test_cmd_board.py` — one-line fix for `_make_snapshot` defaults (`completion_ref=None`) to keep tests compatible with the new `RunSnapshot` field.
- `agent-workbench-live/tests/test_e2e.py` — extended `TestE2EHappyPath.test_happy_path` to make a worktree commit and assert `completion_ref: merge:<40-char-sha>` + `WorktreeMerged` event. Added `TestE2ECompleteMerge` (dirty refusal, conflict abort, `--no-merge` legacy flow). Added `_meta(run_dir)` helper that parses metadata.yaml via `lib.yaml_io`.

## Reviewer reading order

1. **`agent-workbench-live/lib/repos.py`** — start at `MergeConflictError`. The merge logic is here; everything else is wiring. Look for: pre-flight clean check, `--no-ff` invocation, conflict-file detection (`git diff --name-only --diff-filter=U`), the `git merge --abort` fallback, and the `git checkout -` restore on success.
2. **`agent-workbench-live/lib/cli/cmd_complete.py`** — read top-to-bottom. The `_do_merge` helper encapsulates pre-flight, merge call, and conflict-event emission so the main `run()` stays linear. Notice the `_CompleteError` sentinel: it's the only way to break out of the lock with a structured exit code while letting the existing `transitions.TransitionError` handler do its own thing.
3. **`agent-workbench-live/schemas/events.jsonl`** — the two appended lines. Confirm the `payload_required` lists match what `cmd_complete` actually emits.
4. **`agent-workbench-live/tests/test_repos.py`** — `TestMergeNoFf::test_conflict_aborts_and_raises` is the most informative: it constructs a real conflict, runs the helper, and asserts both the exception and the post-state (clean tree, parent branch checked out).
5. **`agent-workbench-live/tests/test_e2e.py`** — `TestE2ECompleteMerge` covers the three failure / escape-hatch paths end-to-end. `TestE2EHappyPath.test_happy_path` is the integration assertion: makes a real commit on the worktree branch, runs `complete`, then verifies the merge SHA on `main` AND the `WorktreeMerged` event.
6. **`agent-workbench-live/lib/board/{source,app}.py`** — the badge wiring. One field added to `RunSnapshot`, one conditional in the `done` branch of `_status_body`. The tests in `TestUnmergedBadge` lock the rendering.
7. **`docs/lifecycle.md`** — verify the `done` section's narrative matches what was implemented.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| 1. Success path: merge:<40-char-sha>, real merge commit on parent | `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` + `tests/test_repos.py::TestMergeNoFf::test_happy_merge_records_no_ff` |
| 2. Dirty worktree refusal, status stays human_review | `tests/test_e2e.py::TestE2ECompleteMerge::test_dirty_worktree_refuses` + `tests/test_repos.py::TestMergeNoFf::test_dirty_repo_refuses` |
| 3. Bad base_ref refusal | `tests/test_repos.py::TestResolveParentBranch::test_missing_branch_raises` + `tests/test_repos.py::TestCurrentBranch::test_detached_head_returns_none` |
| 4. Conflict: --abort, MergeConflict event, status stays human_review | `tests/test_e2e.py::TestE2ECompleteMerge::test_merge_conflict_aborts_and_stays_in_human_review` + `tests/test_repos.py::TestMergeNoFf::test_conflict_aborts_and_raises` |
| 5. WorktreeMerged + MergeConflict registered in events schema | `agent-workbench-live/schemas/events.jsonl` (lines 24-25). Validation enforced by `lib/events.append`; the e2e tests above implicitly cover write-time validation. |
| 6. Board shows ⚠ unmerged badge for `local-branch:` completion_refs | `tests/test_board_snapshot.py::TestUnmergedBadge::test_local_branch_completion_ref_renders_warning` + two siblings (positive: merge: doesn't warn; null: doesn't crash) |
| 7. Three orphan runs backfilled to merge:<full-sha> | `agent-workbench-live/runs/2026-05-22-*/metadata.yaml` rewritten by `tools/backfill_completion_refs.py`; idempotent re-run reports `already-backfilled: 3`. |
| 8. /complete slash command help calls out the merge | `agent-workbench-live/.claude/commands/complete.md` Pre-flight section + Failure modes section. |
| 9. lifecycle.md done row updated | `docs/lifecycle.md` § `done` rewritten end-to-end. |
| 10. Tests pass | 233 / 235 tests pass on this branch; the 2 failures (`test_human_review.TestSnapshotRender::test_happy_snapshot` + `test_bounce_pass2_snapshot`) are pre-existing date-baked snapshot failures present on `master` and unrelated to this work. |

## Deviations from plan

- **DR-001 holds:** I emit `WorktreeMerged` / `MergeConflict` from `cmd_complete` directly via `lib/events.append`, not via the transition engine. This kept the transition rule untouched and let the conflict path emit `MergeConflict` cleanly without a phantom rule.
- **DR-002 holds with one nuance:** on a successful merge, I restore the original branch via `git checkout -` ONLY when the original branch differed from the parent branch (otherwise `checkout -` would have no meaningful "previous" entry). This guard is in `lib/repos.merge_no_ff`.
- **DR-005 holds:** conflict path leaves the parent branch checked out so the human is dropped where they need to resolve.
- I added a new `--no-merge` flag I did not initially plan to expose. Reason: while writing the slash-command help I realized there's no escape valve for "the parent repo is in a weird state and I want to record done anyway, will merge by hand." Rather than force the human to pass `--completion-ref local-branch:agent/foo` verbatim (which they'd have to look up), `--no-merge` is a self-documenting shortcut that records the same legacy label. The board badge then flags the run until they merge. Mid-build addition, surfaced here for the reviewer.

## Known issues

None blocking. Two pre-existing test failures (`test_human_review.TestSnapshotRender`) live on master, are date-baked, and are unrelated to this work.

## Commands run

```
PYTHONPATH=… python -m unittest tests.test_repos -v          # 15/15
PYTHONPATH=… python -m unittest tests.test_board_snapshot -v # 38/38
PYTHONPATH=… python -m unittest tests.test_e2e -v            # 8/8
PYTHONPATH=… python -m unittest discover -s tests            # 233/235 (2 pre-existing failures)
python tools/backfill_completion_refs.py --dry-run           # 3 changes detected
python tools/backfill_completion_refs.py                     # changed: 3
python tools/backfill_completion_refs.py                     # already-backfilled: 3 (idempotency check)
```

## Documentation touched

- `docs/lifecycle.md` — `done` section rewritten to reflect Option A (accepted **and** merged; new pre-flight + failure-mode + escape-hatch sections).
- `agent-workbench-live/.claude/commands/complete.md` — pre-flight one-liner + failure-mode docs + `--no-merge` / `--completion-ref` escape hatches.
