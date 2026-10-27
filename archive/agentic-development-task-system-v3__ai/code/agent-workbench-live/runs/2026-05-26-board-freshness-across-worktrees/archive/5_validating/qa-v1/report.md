# QA report

## Summary

- **tests_passed**: true (for the surface area changed by this run; the 8 pre-existing failures on master are unrelated, see below)
- **known_issues_count**: 0

## What ran

Three unittest invocations from the workbench root inside this run's worktree (see `commands.txt`). The targeted runs verify the two new test classes; the full discover run confirms no regressions in the rest of the 355-test suite.

## Results

### Unit tests

**Targeted: `tests.test_runs.TestWorktreeCacheTTL` (5 tests)** — all pass.
- `test_cache_hit_within_ttl_invokes_git_once` — two reads within TTL → one `subprocess.run` call.
- `test_cache_miss_past_ttl_invokes_git_again` — second read after TTL boundary → two `subprocess.run` calls.
- `test_config_supplies_ttl` — TTL configured via `cfg.raw["board"]["worktree_cache_ttl_seconds"]` is honored when `ttl=None`.
- `test_failure_path_caches_empty_for_ttl` — `subprocess.run` raising `OSError` populates the empty cache; second call within TTL returns the cached empty tuple without retrying git.
- `test_zero_or_negative_ttl_clamped_to_minimum` (post-review) — `_resolve_worktree_cache_ttl` clamps 0, negative, and yaml-configured 0 values to `_WORKTREE_CACHE_TTL_MIN_SECONDS` (0.05s).

**Targeted: `tests.test_board_freshness` (7 tests)** — all pass.
- `TestMultiRootScheduling::test_schedule_path_is_idempotent` — duplicate `_schedule_path(p)` calls produce one observer schedule.
- `TestMultiRootScheduling::test_schedule_worktree_runs_dirs_picks_up_existing_worktrees` — observer scheduled at the resolved worktree-side `runs/` path.
- `TestMultiRootScheduling::test_schedule_worktree_runs_dirs_dedupes_multiple_runs` — multiple runs in one worktree → one observer schedule (post-refactor: iterates worktrees, not runs).
- `TestMultiRootScheduling::test_schedule_worktree_runs_dirs_skips_worktree_with_no_runs_dir` (post-review) — a worktree without a `runs/` dir is skipped cleanly without raising.
- `TestMultiRootScheduling::test_schedule_path_handles_observer_exception` — `Observer.schedule` raising → no entry added to `_watched_paths`.
- `TestPeriodicRescan::test_rescan_picks_up_new_worktree_via_ttl_not_reset_caches` (post-review) — end-to-end TTL path with a monkey-patched monotonic clock: rescan within TTL hits cache (no new schedule); rescan after advancing past TTL re-fetches and schedules the new worktree.
- `TestPeriodicRescan::test_rescan_idempotent` — repeated rescans on a stable worktree set don't add duplicate schedules even when the cache is force-busted between calls.

### Full-suite regression check

`python3 -m unittest discover tests` — 355 tests, 8 failures, 0 errors.

All 8 failures are pre-existing on master:
- `test_backfill_base_ref_sha.TestBackfillBaseRefSha.test_*` (5 tests) — unrelated backfill CLI tooling.
- `test_e2e.TestE2EHappyPath.test_happy_path` — stop-banner text drift; banner has been updated to use `/start` but the assertion expects `agent-workbench start`.
- `test_human_review.TestSnapshotRender.test_bounce_pass2_snapshot` and `test_happy_snapshot` — snapshot tests pin a `2026-05-22` date; today is 2026-05-26.

Confirmed pre-existing by running the same three failing-test names against the master copy at `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/` — all three reproduce on master without any of this run's changes.

### Integration tests

Not separately invoked — the targeted board freshness + TTL tests exercise integration between `lib/runs.py`'s cache machinery and `lib/board/app.py`'s scheduling logic via synthetic git worktrees created by `_init_repo` / `_add_worktree`.

### Lint / typecheck

Not run. The workbench has no enforced lint or typecheck job per the repo's tooling. Manual readability + symbol resolution checks were performed during the post-review revision.

### Browser / Playwright

N/A — this is a Python TUI / library change.

### Smoke scripts

Not run. The brief's AC7 perf smoke was deferred to a follow-up (per review.md F-002).

## Captured artifacts

None. The test invocations produce textual unittest output only; no screenshots, traces, or recordings are warranted for this kind of change.
