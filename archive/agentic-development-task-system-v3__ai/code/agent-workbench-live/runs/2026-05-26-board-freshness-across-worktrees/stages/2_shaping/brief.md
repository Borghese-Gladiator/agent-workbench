# Brief

## Goal

After the per-worktree run-dir landing, the live board's freshness machinery still assumes runs live under master's `cfg.runs_path`. Two coupled defects remain:

1. The `watchdog.observers.Observer` is scheduled only on master's `runs/`, so artifact writes inside worktree-side run dirs fire no FS events. The board only sees those changes via the 1Hz fallback timer, with up to ~1s lag — and any longer-lived UI freshness expectations break entirely if the fallback is later relaxed.
2. The process-lifetime `_WORKTREE_CACHE` in `lib/runs.py` never expires. New worktrees created after the board started are invisible until the board restarts, even though `iter_all_runs` is otherwise correct.

Close both gaps so the live board reflects worktree-side artifact writes promptly and discovers worktrees created mid-session, without inflating `git worktree list` cost or destabilizing the short-lived-CLI cache contract that's correct today.

## User-facing behavior

For someone running `agent-workbench board` in a long session:

- When any run — including a run living inside a worktree — writes a new artifact (shape/plan/build/validate output, an `events.jsonl` line, a stage transition), the board column refreshes within the documented bound for the chosen strategy (≤ 2s if a TTL is used; ≤ 30s for periodic re-scan; immediate via watchdog if multi-root scheduling covers the path).
- When the user starts a new worktree (via `new-run` for a self-modifying target, or any other path that calls `git worktree add`) while the board is running, the new worktree's runs become visible on the board within the documented bound — no restart required.
- `complete` / `abandon` terminal transitions, including the disappearance of the previously-visible `human_review` row, are visible without manual restart.
- Short-lived CLI commands (`shape`, `plan`, `validate`, `complete`, `list`, etc.) continue to see consistent worktree-list data within their own ~milliseconds-long process lifetime; nothing about their behavior changes.

## Acceptance criteria

1. **Worktree-side artifact writes refresh the board.** A self-modifying run transitioning through `validate → followups → human_review` on a worktree-side run dir shows the column change on the live board with ≤ 1s lag (matching today's 1Hz floor at worst). No manual restart.
2. **New worktrees appear without restart.** Starting the board, then creating a new worktree (e.g. via `new-run` for a self-modifying target), causes the new worktree's run to appear within a documented bound that ships with the implementation (the bound is the chosen strategy's worst case — TTL window, re-scan interval, or watchdog latency).
3. **Terminal transitions clean up cleanly.** `complete` / `abandon` of a worktree-side run causes the corresponding row to advance to its terminal state and the prior `human_review` card to disappear on the live board within the documented bound, with no stale row left over.
4. **`git worktree list` cost is measured and bounded.** The implementation reports the per-call cost on the workbench's own repo at the current worktree count (~3 worktrees) and at a stress count (≥ 10 worktrees), and the chosen strategy's worst-case rate of `git worktree list` calls beats today's worst case (today is once-per-process for short-lived calls, and never beyond that for the board because of the no-TTL cache).
5. **Cache contract documented.** `lib/runs.py`'s module docstring explains the cache shape so the next change in this area doesn't re-introduce the no-TTL-for-long-running-processes bug. The contract distinguishes long-running consumers (board) from short-lived ones (CLI subcommands).
6. **Tests would fail under today's behavior.** New tests exist that exercise the chosen freshness path end-to-end — e.g. a board-driver (`snapshot.build` or `AgentBoardApp` harness) test against a synthetic workbench that creates a new worktree mid-test and asserts the new run appears within the bound; and at least one test that pins the cache behavior (TTL expiry, invalidation-hook contract, or absence-of-cache for `iter_all_runs`, depending on which strategy wins).
7. **Performance smoke test.** `snapshot.build(cfg)` is measured at N=3, N=10, and N≥20 synthetic worktrees, and the chosen strategy stays under a documented per-tick budget (e.g. 100ms median).
8. **No regression in `RunSnapshot` / renderers.** Existing board tests (`tests/test_board_*.py` or wherever board coverage lives) pass without modification.

## Non-goals

- Re-architecting the board's renderer or source layer. `RunSnapshot`, `lib/board/source.py`, `lib/board/snapshot.py` are correct post-A1 and stay as-is.
- Replacing watchdog with a different FS-event library.
- Building a daemon, message bus, IPC channel, or socket between CLI commands and the board. (One CLI-side signal file or `os.utime` touch is allowed if the investigation surfaces it as the right answer — but a new long-lived daemon is out of scope.)
- Supporting non-git worktree change detection (NFS, network-mounted, fuse-backed worktrees).
- Changing the 1Hz fallback frequency. It's the safety net, not the target — the watchdog/cache changes should make it irrelevant on the happy path, not faster.
- Solving board-wide perf problems unrelated to freshness (e.g. snapshot-build cost, YAML parse cost, `metadata.run_dir` recursion). That work belongs to a separate TODO and is explicitly out of scope here. Where this work touches the same code (e.g. `_WORKTREE_CACHE`), the change must not pre-empt or contradict the perf-focused work; document the contract so both can coexist.
- Removing the worktree-list cache entirely for short-lived CLI processes. The cache is correct in that regime and must stay.

## Good examples

- **Multi-root watchdog at startup** that walks `runs.iter_all_runs(cfg)` once in `AgentBoardApp.on_mount` and calls `obs.schedule(_Handler(self), <worktree-side runs dir>, recursive=True)` per unique path. ~10 lines. Catches all artifact writes inside already-existing worktrees instantly. Pairs naturally with a small cache TTL or a periodic re-scan to handle the "worktree created after startup" case.
- **Short TTL on `_WORKTREE_CACHE`**: keyed cache value becomes `(populated_at_monotonic, tuple_of_worktrees)`; readers compare `time.monotonic() - populated_at < TTL` before reuse. CLI processes that exit in < TTL still get the cache benefit (the TTL never elapses within their lifetime); the board ticks naturally repopulate. The TTL is configurable in `agent-workbench.yaml` so the perf vs. freshness trade-off is tunable later.
- **Single recursive observer at `cfg.worktrees_path`** for the very simplest fix, IF the noise from product-code edits doesn't drown the `_Handler` filter. The investigation has to demonstrate the noise floor is acceptable before this option is picked.
- **Documenting the contract** in `lib/runs.py`'s module docstring as part of the same change. The next person should not need to discover the long-running vs. short-lived split by re-reading this brief.

## Bad examples

- Dropping `_WORKTREE_CACHE` entirely. `git worktree list` was measured at ~16ms median / ~19ms p90 / ~1.6% of one CPU at 1Hz at today's 3-worktree count. The user explicitly rejected this fix in the originating conversation and asked for an explore-then-decide approach.
- Adding a polling loop that calls `git worktree list` on every board tick "to be safe." Same cost problem as above, just hidden behind a different control flow.
- Watching the entire monorepo root recursively. Far too noisy — every product-code edit anywhere in the tree would fire a board refresh.
- Plumbing a new IPC channel or daemon between CLI commands and the board. The architecture statement is filesystem-events + 1Hz fallback; a new long-lived daemon contradicts that.
- Auto-restarting the board from a CLI command when a new worktree appears. The board is the user's TUI; CLI commands don't get to restart it.
- Changing `RunSnapshot` shape, the severity model, or the renderers. Those are not the bug.

## Constraints

- `git worktree list --porcelain` is the canonical source of truth for the worktree set. Do not infer worktrees from filesystem state alone.
- The board runs Textual on a single UI thread. Anything added to `on_mount` or `set_interval` is on that thread and must remain non-blocking (no per-tick `subprocess.run` without a bound).
- The watchdog `Observer` API is the existing primitive. Stay on it.
- Short-lived CLI calls must not see any regression — `_WORKTREE_CACHE` for their lifetime is load-bearing and must remain effectively free.
- `lib/runs.py` is also used by non-board callers (`metadata.run_dir`'s fallback, `find_run`, `cmd_list.py`). Any cache shape change must be safe for all callers.
- The current `cfg.worktrees_path` and `cfg.runs_path` config keys stay where they are. No new top-level config keys unless the chosen strategy genuinely needs one (e.g. a single `board.refresh.worktree_ttl_seconds` field if a TTL ships and needs tuning).

## Assumptions

- The "worktree mid-session" case is rare but real (the originating run hit it; new-run for a self-modifying target creates a worktree mid-session by design). The implementation will pick a strategy that handles it within a documented bound, not skip it.
- Per the originating conversation, the chosen strategy will be one of the four listed (multi-root watchdog at startup, periodic re-scan, recursive parent observer, short TTL) or a small combination of them. The brief does not pre-commit to one — that's a planning-stage decision after the planner reads the code.
- The 1Hz fallback timer is retained as-is. It serves as the last line of defense if both watchdog and cache strategies have edge cases.
- `RunSnapshot` and downstream renderers do not need changes. If the planner discovers otherwise during code-reading, that surfaces as a planning risk, not a brief-level scope expansion.
- The performance acceptance bar (≤ 100ms median per tick at the stress worktree count) is a working hypothesis. If measurement shows the bar is too aggressive given the chosen strategy, it can be relaxed during planning with a recorded justification.
- Existing board tests (`tests/test_board_*.py` per the originating TODO) are the right surface to extend with the new freshness/cache tests. The planner will confirm the exact path during code-reading.

## Suggested QA scenarios

1. **Worktree-side artifact write refresh.** Start the board against a synthetic workbench with one worktree-side run. From a sibling shell, append a line to that run's `events.jsonl` (simulating a stage transition write). Assert the board row's `updated_at` reflects the new write within the documented bound.
2. **New worktree mid-session.** Start the board against a synthetic workbench with zero worktrees. From a sibling shell, run `agent-workbench new-run --new-repo-path …` (or `git worktree add` directly against a synthetic monorepo) so a new worktree appears. Assert the new run shows up on the board within the documented bound (e.g. ≤ 2s for TTL, ≤ 30s for periodic re-scan).
3. **`complete` makes the row terminal-and-clean.** Take a run from `human_review` to `done` via `complete` from a sibling shell while the board is running. Assert the row transitions to `done` and that no stale `human_review` row lingers.
4. **`abandon` makes the row terminal-and-clean.** Same as above for the abandon path.
5. **Cache TTL expiry (if a TTL is the chosen strategy).** In a unit test, call the worktree-list function twice with > TTL between calls; assert `git worktree list` is invoked twice. Then call twice within TTL; assert it's invoked once.
6. **Invalidation-hook contract (if that's the chosen strategy instead).** Unit test that calls `runs.invalidate_worktree_cache()` between two reads and asserts a re-fetch happens.
7. **Performance smoke.** Measure `snapshot.build(cfg)` wall-clock with synthetic workbenches at N=3, N=10, N=20 worktrees. Assert median per-tick stays under the chosen budget. Report numbers in the build log even if no assertion fires.
8. **No regression on short-lived CLI cost.** A timing test that exercises a CLI command (`agent-workbench list`) against a workbench with multiple worktrees; assert `git worktree list` is invoked at most once per CLI process even after the cache shape changes.
9. **`lib/runs.py` docstring is the source of truth.** Lint/doc check that the module docstring exists, mentions the long-running-vs-short-lived contract, and names the TTL / invalidation / no-cache strategy actually shipped.
