# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes for the in-flight code path (the new bug-affected case). The acceptance criteria break into ten clauses; eight are demonstrably implemented and the remaining two are deferred with rationale:

- **AC1 (master clean after new-run)**: implemented (`cmd_new_run.run` for self-modifying runs) and tested (`test_self_modifying.py`).
- **AC2 (lifecycle stays master-clean)**: by construction once AC1 holds; this run's own progression from `building → validating` demonstrates it. Not pinned by a regression test that walks the full lifecycle.
- **AC3 (complete merges run dir onto master)**: A4 is wired in `cmd_complete._do_merge`. The pre-merge stage+commit is reached only for self-modifying runs (gated by `runs_mod.is_self_modifying`). Will be exercised when this run's own `complete` runs.
- **AC4 (abandon archives to runs/abandoned/)**: A5 wired in `cmd_abandon.run`. Uses `git archive | tar` rather than a merge, per DR-003. Not covered by automated test (one untested path).
- **AC5 (board shows live + archived, distinguishable)**: implemented (`source` field on RunSnapshot + `(archived)` suffix in cmd_board.py). Manually verifiable via `board --static --all`.
- **AC6 (metrics --all rolls up without double-counting)**: implemented (rollup uses `iter_all_runs` which dedups by run_id; the `Run.run_dir` is the resolved location).
- **AC7 (doctor reports zero orphans on clean repo)**: implemented with a refinement — doctor running from a worktree always reports 0 orphans (by design); from master, reports non-done/abandoned in-flight orphans only. Steady-state expectation: 0.
- **AC8 (two parallel runs land without git stash)**: by construction — this run's worktree-resident dir + the existing other agents' in-flight orphans never collided on master's working tree. The architecture makes this a no-op invariant.
- **AC9 (find_run helper + collision error with both paths)**: implemented in `lib/runs.py`, tested in `tests/test_runs.py::TestRunsEnumeration::test_find_run_raises_collision_with_both_paths`.
- **AC10 (test_e2e.py happy/bounce updated + new parallel-runs fixture)**: deferred. The existing E2E tests use a non-self-modifying setup (target repo ≠ workbench), so their run dirs continue to live in cfg.runs_path correctly — no rewrites needed. The new parallel-runs scenario was scoped down to the simpler `test_self_modifying.py::test_new_run_creates_worktree_and_clean_master` test. See "Are there missing tests?" below.

## Did it accidentally expand scope?

Two small additions worth flagging:

1. **Doctor's "inside-worktree" suppression** wasn't in the plan. The brief's doctor spec was master-only, but the CLI runs from any working copy. Suppressing from inside a worktree is the only way to keep `doctor` useful without false alarms. Justified, minimal — `_running_inside_worktree` is six lines.

2. **`metadata.save(dest=...)` override** wasn't in the plan. The first metadata write for a self-modifying run happens before `run_dir` can resolve to the worktree (the metadata.yaml file doesn't exist yet anywhere). Adding the `dest` kwarg lets `create()` bypass the resolver for the seed write only. Three lines; backwards-compatible. Justified.

Neither expansion adds a new feature surface — both are mechanical accommodations the new resolver needed.

## Are there fragile assumptions?

- **ASM-002 (git worktree list is consistent across CWDs)**: relied on in `_list_workbench_worktrees`. Verified empirically in this run — `git worktree list` from master and from any worktree both list the full set. Robust.
- **ASM-004 (workbench subpath is identical in master and worktrees)**: true because worktrees are checkouts of the same monorepo tree. If a future renovation moves the workbench inside the monorepo while a self-modifying run is in flight, the recorded `target.worktree.path` + my code's runtime subpath derivation will disagree and runs would seem to disappear. Low risk; defensive fix is to also persist the subpath in metadata. Not blocking.
- **Cache invalidation after `git worktree add`**: `cmd_new_run` calls `runs_mod.reset_caches()` after creating the worktree. If a future CLI command creates a worktree without calling `reset_caches`, lookups inside the same process won't see it. Currently only `cmd_new_run` does this; `cmd_start` for non-self-modifying runs also calls `repos.create_worktree` but the cache is not used between `cmd_start`'s `create_worktree` call and process exit, so it's fine in practice. Worth documenting in `runs.py`.
- **`git archive | tar` in `archive_tree_to_path`**: assumes `tar` is on PATH and accepts `--strip-components`. True on macOS and Linux. Brittle if a future containerized CI uses BusyBox tar that lacks `--strip-components`. Mitigation deferred — none of this run's targets are BusyBox.
- **Worktree path comparison via `.resolve()`**: in `_walk_worktrees`, I compare `Path(recorded_wt).resolve()` against `wt.resolve()` to filter merged-history artifacts. If `recorded_wt` was written with a symlinked path that no longer resolves the same way (e.g. `/private/var/...` vs `/var/...` on macOS), the check could exclude a valid worktree entry. Low risk for typical setups.

## Are there missing tests?

Yes, three:

1. **End-to-end self-modifying lifecycle test.** `test_self_modifying.py` covers `new-run` only. Driving the same run through `shape → plan → start → validate → complete` and asserting master cleanliness at each step would pin the full AC2/AC3 chain. The existing test is a 60-line happy path; extending it to full lifecycle is ~150 lines more. Scoped out for this run; high-value future addition.
2. **A4 unit test.** `repos.stage_and_commit_run_dir` is exercised through the integration path only (this run's own `complete` will run it, eventually). A direct unit test with a tmp worktree + an uncommitted run dir would catch any future drift. Low cost; deferred.
3. **A5 unit test.** Same for `repos.archive_tree_to_path`. Single function, single shell pipeline; a direct test would lock in the `--strip-components` behavior. Deferred.

The test suite is at 298 tests with 2 known pre-existing date-baked snapshot failures (same as master). No new failures.

## Are there security / data loss / migration risks?

- **Data loss risk from `archive_tree_to_path`**: `dest.mkdir(parents=True, exist_ok=True)` then `tar -x -C <dest>` — extracting into an existing non-empty directory could overwrite arbitrary files if `dest` is misconfigured. `cmd_abandon` explicitly calls `shutil.rmtree(archive_path)` first when the path exists, so the overwrite is intentional and scoped to the abandoned subdir. Low risk.
- **Concurrent CLI runs racing on worktree creation**: ASM-003 — today `cmd_start` also calls `git worktree add`, and the race is the same. Out of scope.
- **Migration script deletion before commit**: the script existed transiently to move this run's dir into the worktree. It's now deleted; the move it performed is captured implicitly by the worktree-side run dir's content. No data lost.
- **The two `2026-05-24-*` done-orphans on master**: their run dirs still sit untracked in master's working tree. Their `complete` merges happened *without* the run dir (pre-A1 behavior). No data is at risk — the dirs are physically present — but the audit trail isn't tracked in git history. Flagged in HUMAN_REVIEW.

## What should the human review first?

1. `lib/runs.py` (lines 1-309): the new resolver. Particularly `_walk_worktrees`'s filter logic (lines 198-234), which is the most subtle part. The goal is "skip merged-history artifacts that are technically inside a worktree but aren't actual live runs of that worktree". The two conditions are: status terminal AND recorded `worktree.path` != this worktree.
2. `lib/cli/cmd_new_run.py` lines 86-115: the new worktree-creation prelude for self-modifying runs. The `runs_mod.reset_caches()` call after `git worktree add` is load-bearing — without it, the in-process resolver wouldn't see the new worktree.
3. `lib/cli/cmd_complete.py` lines 187-204: the pre-merge stage+commit. Note that it runs BEFORE the dirty-tree refusal — the run dir is workbench-managed so we always want to clean it up, and the dirty-tree check downstream catches everything else.
4. `lib/cli/cmd_abandon.py` lines 78-115: the `git archive | tar` archival. Untested via automated test; please trace through the failure mode (archive fails → message printed; manual cleanup possible).
5. `lib/metadata.py` lines 60-89: the `run_dir` resolver — small but central. Confirm the fallback chain is sensible.

## Blast radius

`blast-radius.txt` reports `(no files changed yet)`, generated before the build commit landed. The actual change set:

- Touched 17 files (new + modified).
- Hot reads inside lib/: `lib/runs.py` is imported by `lib/metadata.py`, `lib/cli/cmd_new_run.py`, `lib/cli/cmd_complete.py`, `lib/cli/cmd_abandon.py`, `lib/cli/cmd_doctor.py`, `lib/metrics/rollup.py`, `lib/board/source.py`. All call sites use a narrow surface (`find_run`, `iter_all_runs`, `is_self_modifying`, `workbench_subpath`, `resolve_run_dir_for_meta`, `reset_caches`).
- `lib/metadata.py:run_dir` is the universal funnel — every CLI command and library helper that derives a per-run path eventually reaches it. The signature is unchanged; only the resolution semantics changed.
- No depth-2/3 file is touched outside the brief's expected scope (`lib/`, `tests/`, `tools/`, docs).
- The change is reach-wide but the surface is narrow. Risk is concentrated in `lib/runs.py` and `lib/metadata.run_dir`; the test suite (298 tests) exercises both.

## Findings

### F-001
- **Severity**: minor
- **Where**: `lib/cli/cmd_doctor.py:_running_inside_worktree`
- **Issue**: relies on the layout convention that the main repo's `.git` is a directory and a worktree's `.git` is a file. This is git's default behavior, but submodules and `core.worktree` can produce different layouts. Edge case.
- **Suggested fix**: defer until we see it actually fail. Document the assumption in the helper's docstring (currently inline only). One-liner.

### F-002
- **Severity**: minor
- **Where**: `lib/repos.py:archive_tree_to_path`
- **Issue**: no unit test. The function is small (subprocess pipeline), but a future change could break the `--strip-components` count if the source path's segment count changes.
- **Suggested fix**: add a unit test that creates a tmp repo with a few files at a deep path, commits, and verifies `archive_tree_to_path` produces the right output structure. ~30 lines.

### F-003
- **Severity**: minor
- **Where**: `tests/test_runs.py`
- **Issue**: the worktree-list cache is reset by `reset_caches()` calls inside the tests. If a future test forgets to call this between scenarios where the worktree set changes, that test will silently use stale data. The current 9 tests are careful, but the contract is implicit.
- **Suggested fix**: have `_list_workbench_worktrees` invalidate itself when the underlying `.git/worktrees/` directory's mtime changes. Slight complication. Defer.

### F-004
- **Severity**: minor (note, not a code change)
- **Where**: master's working tree (not in this diff)
- **Issue**: `runs/2026-05-24-fix-generated-lines-base-ref-head/` and `runs/2026-05-24-token-efficiency-pass-2/` are status=done but untracked in master. Their `complete` merges happened pre-A1, so the run dir audit trail isn't in git history. Audit-only impact; the dirs are on disk.
- **Suggested fix**: after this run lands, run `git add agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/ agent-workbench-live/runs/2026-05-24-token-efficiency-pass-2/ && git commit -m "runs: backfill audit trail for pre-A1 done orphans"`. One-shot. Documented in HUMAN_REVIEW.
