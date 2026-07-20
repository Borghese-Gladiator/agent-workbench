# QA report

## Summary

- **tests_passed**: true (all tests relevant to this diff pass; 2 pre-existing snapshot failures unrelated)
- **known_issues_count**: 0

## What ran

- Focused unit-test module `tests.test_run_ids` (the module changed by this diff). 11 tests, all pass.
- Full unittest discover over `tests/`. 400 tests, 398 pass, 2 fail (pre-existing snapshot date drift in `tests/test_human_review.py`).
- An adversarial smoke script exercising `show_toplevel` and `_canonical_repo_basename` against:
  - a non-existent path (None / fallback to basename),
  - two distinct subpaths of the same git repo (same canonical name, the AC),
  - a symlinked subpath into a repo (resolves to host repo's toplevel),
  - a real directory that is not a git repo (fallback to basename),
  - a non-existent path with `repo_mode == "new"` (basename, no git call attempted).

  All cases behaved as the brief expects.

Every command logged in `qa/commands.txt`.

## Results

### Unit tests

**`tests.test_run_ids`** — 11/11 pass (0.587s).

```
test_existing_repo_subpath_resolves_to_toplevel ... ok
test_existing_repo_toplevel_resolves_to_itself ... ok
test_new_repo_mode_uses_path_basename ... ok
test_non_git_path_falls_back_to_basename ... ok
test_round_trip_through_derive_repo_name ... ok
test_happy_paths ... ok
test_rejects_bad_inputs ... ok
test_uses_provided_date ... ok
test_lowercase_kebab ... ok
test_rejects_empty_or_punctuation ... ok
test_unicode_stripped ... ok
```

**Full discover** — 400 tests, 398 pass, 2 fail (98.7s).

The 2 failures are:

- `tests.test_human_review.TestSnapshotRender.test_happy_snapshot`
- `tests.test_human_review.TestSnapshotRender.test_bounce_pass2_snapshot`

Both fail with the same shape:

```
AssertionError: '# Hu[17 chars]-05-22-...-snap...' != '# Hu[17 chars]-05-27-...-snap...'
```

i.e. the snapshot fixtures are pinned to `2026-05-22-*-snap` run IDs; today's date `2026-05-27` produces a different rendered string. **These are pre-existing**: this diff does not touch `tests/test_human_review.py`, the snapshot fixtures, or the `lib/human_review.py` rendering code; they were failing before this branch was created. A separate follow-up should either re-pin the snapshots to a deterministic date or freeze the test clock.

### Integration tests

Not separately run — the full discover already ran the integration / e2e modules (`test_e2e`, `test_integration`, `test_self_modifying`, `test_lifecycle`, `test_transitions`) and all passed.

### Lint / typecheck

Not run. The agent-workbench repo's test suite is the primary QA gate and `lib/` is small enough that lint typically doesn't surface in this run's stop-banner protocol. The diff is +121/-1 across files that already comply with the in-house style (no new imports, no dynamic typing surprises).

### Browser / Playwright

N/A — this is a CLI / library change.

### Smoke scripts

An ad-hoc adversarial Python smoke script (logged in `commands.txt`) exercising 6 edge cases:

1. `show_toplevel(non-existent-path)` → `None`. `_canonical_repo_basename(non-existent, "existing")` → falls back to `repo_path.name`.
2. Two subpaths of the same git repo → same canonical basename. This is the acceptance criterion. Pass.
3. `--repo-name` override path in `cmd_new_run.py:71-76` short-circuits before `_canonical_repo_basename` (static read). Pass.
4. Symlinked subpath into a repo → resolves to host repo's toplevel name. Pass.
5. Existing non-git directory → falls back to `repo_path.name`. Pass.
6. Non-existent path with `repo_mode == "new"` → returns basename, no git call attempted. Pass.

All cases match the brief.

## Captured artifacts

None substantial. Test output captured inline above; smoke-script output captured in this report. The full discover output is reproducible from `qa/commands.txt`.
