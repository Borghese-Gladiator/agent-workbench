# Build report

## What changed

Closed the two board freshness gaps from the per-worktree run-dir landing. `lib/board/app.py:AgentBoardApp.on_mount` now schedules a watchdog `Observer` against every worktree-side `runs/` dir at startup (not just master's `cfg.runs_path`) and adds a second `set_interval` that periodically re-scans the worktree set to schedule observers on worktrees created mid-session. `lib/runs.py:_WORKTREE_CACHE` gained a short TTL (default 2.0s, configurable via `agent-workbench.yaml` -> `board.worktree_cache_ttl_seconds`) so the long-running board picks up new worktrees within TTL seconds while short-lived CLI calls (sub-second lifetime) keep their effectively-free cache.

## Files changed

- `agent-workbench-live/lib/runs.py` — added `time` import, `_WORKTREE_CACHE` value shape change to `(populated_at_monotonic, tuple)`, new `_WORKTREE_CACHE_TTL_DEFAULT_SECONDS` + `_WORKTREE_CACHE_TTL_MIN_SECONDS` constants (post-review: floor at 0.05s so a misconfigured `worktree_cache_ttl_seconds: 0` doesn't silently defeat the cache), new `_resolve_worktree_cache_ttl(cfg, override)` helper that applies the floor, `_list_workbench_worktrees` now honours TTL and accepts a `ttl` kwarg, module docstring extended with a "Worktree-list cache contract" section.
- `agent-workbench-live/lib/board/app.py` — added `runs` import, new module-level `_WATCH_RESCAN_DEFAULT_SECONDS` + `_WATCH_RESCAN_MIN_SECONDS` constants (post-review: floor at 1.0s), new `_resolve_watch_rescan_seconds(cfg)` helper that applies the floor, `AgentBoardApp.__init__` gained `self._watched_paths: set[str]`, `on_mount` now calls `_schedule_path(runs_path.resolve())` + `_schedule_worktree_runs_dirs()` + `set_interval(rescan_seconds, self._rescan_worktrees)`, three new methods (`_schedule_path`, `_schedule_worktree_runs_dirs`, `_rescan_worktrees`). Post-review: `_schedule_worktree_runs_dirs` iterates `runs._list_workbench_worktrees` directly (not `iter_all_runs`) so brand-new worktrees with zero runs still get observers when their `runs/` dir exists.
- `agent-workbench-live/agent-workbench.yaml` — added two new keys under existing `board:` block: `worktree_cache_ttl_seconds: 2.0` and `watch_rescan_seconds: 5.0`.
- `agent-workbench-live/tests/test_runs.py` — added `TestWorktreeCacheTTL` class with 4 tests (cache-hit-within-TTL, cache-miss-past-TTL, config-supplies-TTL, failure-path-caches-empty).
- `agent-workbench-live/tests/test_board_freshness.py` — new file with `TestMultiRootScheduling` (4 tests) and `TestPeriodicRescan` (2 tests) classes.

## Reviewer reading order

1. `agent-workbench-live/lib/runs.py` (module docstring + `_list_workbench_worktrees`) — the cache contract is the source of truth; everything else hangs off the TTL behavior described here.
2. `agent-workbench-live/lib/board/app.py:on_mount` and the three new helpers — the per-worktree observer scheduling + periodic re-scan are the user-visible behavior change.
3. `agent-workbench-live/agent-workbench.yaml` — confirm the two new keys are under the existing `board:` block with safe defaults.
4. `agent-workbench-live/tests/test_runs.py:TestWorktreeCacheTTL` — confirms the TTL semantics are pinned (hit, miss, config-override, failure stickiness).
5. `agent-workbench-live/tests/test_board_freshness.py` — confirms idempotency of `_schedule_path`, multi-root pickup, dedupe across runs sharing a parent, and that `_rescan_worktrees` picks up new worktrees without double-scheduling existing ones.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| AC1 — worktree-side artifact writes refresh the board within ≤1s | `tests/test_board_freshness.py::TestMultiRootScheduling::test_schedule_worktree_runs_dirs_picks_up_existing_worktrees` confirms the per-worktree observer is scheduled; the 1s lag bound is delivered by the watchdog backend's standard latency (unchanged from today's master-only observer, just now applied to worktree paths too). Not directly asserted at sub-second resolution because the test harness uses a mock Observer; the watchdog backend itself is third-party and trusted. |
| AC2 — new worktrees appear within documented bound without restart | `tests/test_board_freshness.py::TestPeriodicRescan::test_rescan_picks_up_new_worktree_via_ttl_not_reset_caches` confirms a worktree created after initial scheduling gets observed once cache TTL expires and the rescan tick runs. Corrected worst-case visibility = `2 × watch_rescan_seconds` ≈ 10s with defaults (bad-phase case where the cache populates just before a rescan tick, returns stale, then waits one full rescan interval). Under the brief's ≤30s bar. (Earlier draft said "5s + 2s = 7s"; that math was wrong — TTL doesn't compound additively with rescan interval. See review.md F-004.) |
| AC3 — terminal transitions clean up cleanly | Out of scope for the source code changes — `complete`/`abandon` already drive the right transitions; the freshness change just ensures the row update is observed promptly. Manual QA item (see "Commands run"). |
| AC4 — `git worktree list` cost measured and bounded | **Partial.** The 3-worktree cost (~16ms median / ~19ms p90) was cited from the originating TODO conversation; NOT re-measured in this run, and the stress count (≥10 worktrees) was not measured at all. The TTL strategy bounds call frequency to at most one per TTL window per call site (forbidden values clamped via `_WORKTREE_CACHE_TTL_MIN_SECONDS`), which beats today's "every cache hit" worst case for long-running consumers, but empirical verification at higher worktree counts is deferred to a follow-up (see review.md F-002). Earlier draft of this row overclaimed coverage. |
| AC5 — cache contract documented | `lib/runs.py` module docstring extended with "Worktree-list cache contract" section. Verified by reading the file. |
| AC6 — tests would fail under today's behavior | `TestWorktreeCacheTTL::test_cache_miss_past_ttl_invokes_git_again` would fail under the old process-lifetime cache. `TestPeriodicRescan::test_rescan_picks_up_new_worktree_via_ttl_not_reset_caches` would fail under the old single-root observer and also under any cache shape that doesn't honor TTL. |
| AC7 — performance smoke at N=3/10/20 | **Not implemented.** Deferred to a follow-up (see review.md F-002 — bundled with AC4's stress measurement). The freshness change does not modify `snapshot.build`'s cost path, so it should not regress; empirical verification is still worth a session and is recorded in `follow-ups.md`. |
| AC8 — no regression in `RunSnapshot`/renderers | Full test suite run: 353 tests, 8 failures, 0 errors. All 8 failures confirmed pre-existing on master via spot-check (`test_backfill_base_ref_sha`, `test_e2e.test_happy_path` for banner-text drift, `test_human_review` snapshot tests pinned to 2026-05-22 dates). Tests touching `lib/board/source.py`, `lib/board/snapshot.py`, `RunSnapshot`, or `tests/test_board_snapshot.py` all pass. |

## Deviations from plan

- **No `Board` dataclass added to `lib/config.py`.** The plan (Change 4) proposed adding typed `Board` config fields. On reading `lib/config.py`, the existing `board.stale_human_review_hours` field is accessed via `cfg.raw.get("board", {}).get(...)` with no `Board` dataclass; adding one for these two new fields would have been an inconsistent abstraction. Followed the existing pattern instead — `lib/runs.py:_resolve_worktree_cache_ttl` and `lib/board/app.py:_resolve_watch_rescan_seconds` both read via `cfg.raw["board"]` with defaults. Config is still configurable via yaml (per DR-003); the mechanism is shimmed rather than typed. If anyone later wants to type-tighten board config, the natural follow-up is to add a `Board` dataclass with all three fields at once.
- **No performance smoke benchmark.** Plan Change 7 proposed `scripts/bench_board_freshness.py` measuring `snapshot.build(cfg)` at N=3/10/20 worktrees. Skipped because (a) the brief lists it as "informational, not a regression gate" and (b) the freshness change here does not modify `snapshot.build`'s cost path — it only changes when observers fire and how often the worktree cache refetches. The cost claim from the originating TODO (~16ms median per `git worktree list` call) was the input data for picking TTL=2.0s; we did not re-validate it. Surfaced as a follow-up candidate.

## Known issues

- Dead observer schedules are not actively reaped when a worktree is torn down (per DR-004). Bounded by typical worktree churn; not a real problem at reasonable counts.

## Commands run

```
python3 -m unittest tests.test_runs.TestWorktreeCacheTTL -v
python3 -m unittest tests.test_board_freshness -v
python3 -m unittest discover tests   # full suite, 353 tests
```

Full-suite result: 353 tests, 8 failures, 0 errors. All 8 failures confirmed pre-existing on master via running the same test names against the master copy at `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/`.

Manual QA (deferred to validation stage):
- Start `agent-workbench board` against this workbench; confirm a worktree-side run row updates within ≤1s of an `events.jsonl` write.
- Start the board, then run `new-run` for a self-modifying target so a new worktree is created mid-session; confirm the row appears within ≤7s without restart.

## Documentation touched

- `agent-workbench-live/lib/runs.py` module docstring (the "Worktree-list cache contract" section). This is the inline docstring that other workbench code reads when wondering what the cache shape is, and it satisfies AC5.

Otherwise: none needed — the change is internal to the workbench's board freshness machinery and has no user-facing surface beyond the two new optional config keys (themselves documented inline in `agent-workbench.yaml` next to where they're defined).
