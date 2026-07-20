> Extracted from `docs/TODO.md` §6 on 2026-05-26.

## 6. Board freshness across worktrees after the per-worktree run-dir landing

### Why this is here

The prior section moved live run dirs into their worktrees (`<worktree>/agent-workbench-live/runs/<id>/`), but the board's freshness infrastructure was scoped to master's `cfg.runs_path` only. Two coupled gaps remain, both surfaced 2026-05-25 while watching the board during this run's own `complete`:

**Gap 1 — watchdog observer covers master only.** `lib/board/app.py:561-573` schedules a single `watchdog.observers.Observer` on `cfg.runs_path` (master). Live writes inside worktrees (every `shape`/`plan`/`validate` artifact for any self-modifying run) fire no watchdog events. The 1Hz fallback timer (`self.set_interval(1.0, self._refresh)`) catches them eventually with up to ~1s lag, but instant refresh is lost.

**Gap 2 — `_list_workbench_worktrees` cache has no TTL.** `lib/runs.py:_WORKTREE_CACHE` is a process-lifetime dict keyed on workbench root path. First call populates it from `git worktree list --porcelain`; every subsequent call in the same process returns the cached tuple. For short-lived CLI commands this is fine (the process exits in milliseconds). For the long-running board, it means worktrees created mid-session are invisible until the board restarts — even with a 1Hz `iter_all_runs` rescan.

Observed concretely on 2026-05-25 while completing this run: the board showed the run stuck in `human_review` until manual restart. Two contributing causes — the board process predated the post-A1 `iter_all_runs` codepath (genuine version skew, not just lag), AND the cache would have masked any new worktree creation thereafter.

### Design principles

- **Optimize the long-running case differently from the one-shot case.** The board ticks for hours. CLI commands exit in <1s. The same cache that's correct for one is wrong for the other. Don't unify them; split.
- **`git worktree list` is not free.** Measured on the workbench's own repo with 3 worktrees: ~16ms median, ~19ms p90 per call. Scales linearly with worktree count. Calling it raw at 1Hz costs ~1.6% of one CPU continuously today; with 20 worktrees it'd be 5–8%. Don't pretend it's invisible.
- **Watchdog is the right tool for change notification.** The 1Hz fallback is a safety net, not the primary mechanism. Recursive `Observer.schedule` on every worktree's `runs/` dir is the canonical fix; the 1Hz tick should only be needed for "new worktree appeared since the last observer scheduled".
- **Don't redesign the source layer.** `RunSnapshot`, `iter_all_runs`, the severity model, the renderers — all post-A1 correct. The bug is narrow: filesystem-event coverage in `AgentBoardApp.on_mount`, plus the cache TTL.

### Tasks

- [ ] **Investigate the actual user-visible symptom space.** Before picking a fix, characterize what's slow and what's wrong:
  - How often does someone start a new worktree mid-board-session? (Affects whether dynamic re-scheduling is worth the complexity.)
  - How many worktrees do real users have at once? (Affects whether `git worktree list` cost is meaningful.)
  - Does the 1Hz fallback actually deliver perceived freshness for everything except the watchdog gap? (May reveal other latency sources.)
  - Is there a less obvious fix — e.g. having the CLI commands send a signal/file-touch the board listens for, instead of filesystem-event polling?
- [ ] **Decide on the watchdog strategy.** Three options on the table from the 2026-05-25 conversation; pick one (or a combination) based on the investigation:
  - **Option 1 — multi-root watchdog at startup.** In `AgentBoardApp.on_mount`, after the initial `obs.schedule(_Handler(self), cfg.runs_path, recursive=True)`, walk `runs.iter_all_runs(cfg)` once and call `obs.schedule(...)` for each unique worktree-side `runs/` directory. ~10 lines. Doesn't cover worktrees created mid-session.
  - **Option 2 — periodic re-scan of the worktree list.** Add a second `set_interval` (e.g. 30s) that diffs the current watcher set against `git worktree list` and adds observers for new worktrees. ~30 lines plus observer bookkeeping. Covers the mid-session case at the cost of complexity.
  - **Option 3 — watch the parent `cfg.worktrees_path` recursively.** One `obs.schedule(_Handler, cfg.worktrees_path, recursive=True)` covers every existing and future worktree. ~5 lines. Trade-off: noisy event stream (every product-code edit in every worktree fires a handler); the existing `_Handler` filter handles it cheaply but it's still busier.
- [ ] **Decide on the cache strategy.** The current process-lifetime cache is the right shape for short-lived CLI commands but wrong for the board. Options:
  - **Short TTL** (e.g. 2s): `_WORKTREE_CACHE: dict[str, tuple[float, tuple[...]]]`; check `time.monotonic() - cached[0] < TTL` before reuse. CLI calls still cache for their full lifetime (process exits well before TTL); board ticks see new worktrees within TTL seconds. ~10 lines. Doesn't require the board to know it's special.
  - **Drop the cache for `iter_all_runs`**: keep it only on `find_run`'s hot path. Board pays full `git worktree list` cost every tick (~16ms on a small repo, possibly higher on large). CLI commands lose a tiny optimization. Simplest.
  - **Explicit invalidation hook**: expose `runs.invalidate_worktree_cache()`; the board's 1Hz refresh calls it; CLI commands don't. Most surgical, ugliest contract.
  - **Don't change it at all**: rely on option 1 above (multi-root watchdog) to cover the freshness gap without re-scanning. If the user creates a new worktree mid-session that's still invisible until restart, but maybe that's acceptable.
- [ ] **Implement + test.** Whichever combination wins, add coverage:
  - Unit test for the cache behavior (TTL expiry, or invalidation-hook contract).
  - Integration test that launches the board (or its `snapshot.build` driver) against a synthetic workbench, creates a new worktree mid-test, and asserts the new run appears within the expected window.
  - Performance smoke: measure `snapshot.build(cfg)` wall-clock at 1Hz with N=3, N=10, N=20 worktrees. Confirm it stays under a budget (e.g. 100ms per tick).
- [ ] **Document the contract.** Whichever cache shape wins, write the rule in `lib/runs.py`'s module docstring so the next person doesn't re-introduce the same bug.

### Acceptance

- Board started before a new worktree exists shows the new worktree's runs within a documented bound (e.g. ≤ 2s for the TTL approach; ≤ 30s for the periodic-rescan approach).
- `git worktree list` is not called more than necessary — investigation has measured the cost on a representative worktree count and the chosen strategy beats today's worst case.
- A self-modifying run transitioning through `validate` → `followups` → `human_review` shows the column changes on the live board with ≤ 1s lag (matching today's 1Hz floor) without manual restart.
- `complete`/`abandon` terminal transitions are visible on the board without manual restart, and the previously-visible `human_review` card disappears cleanly (no stale row).
- New tests exist that would fail under today's behavior and pass under the new one.
- `lib/runs.py`'s module docstring explains the cache contract.

### Non-goals

Re-architecting the board's renderer (`RunSnapshot`, `lib/board/source.py`, `lib/board/snapshot.py` are all correct); replacing watchdog with a different filesystem-event library; building a daemon or message bus between CLI commands and the board (out of scope unless investigation surfaces it as the right answer); supporting non-git worktree change detection (e.g. NFS); changing the 1Hz fallback frequency (it's the safety net, not the target).

### Origin

Surfaced 2026-05-25 in a session debugging why this run (`2026-05-25-each-worktree-owns-its-own-run-dir`) stayed at `human_review` on the live board well after `complete` had merged it. Investigation traced the symptom to two layered causes: the board process predated the post-A1 `iter_all_runs` codepath (one-time skew, fixed by restart), AND the worktree-list cache had no TTL (would re-occur for any new worktree created mid-session). The user pushed back on a too-quick "drop the cache" fix — `git worktree list` was measured at ~16ms median, ~19ms p90, ~1.6% of a CPU at 1Hz today — and asked for an explore-then-decide approach rather than jumping to one of the four cache strategies above. Follow-up `follow-ups.md` from that run also called out the watchdog-coverage gap as a separate item; this TODO consolidates both.
