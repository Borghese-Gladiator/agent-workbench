# Implementation plan

## Current repo understanding

Two coupled defects in the board's freshness machinery, both downstream of the per-worktree run-dir landing that moved live runs out of master's `runs/` and into each worktree's `<worktree>/agent-workbench-live/runs/`.

**Defect 1 — single-root watchdog Observer.** `lib/board/app.py:561-573` (`AgentBoardApp.on_mount`) creates one `watchdog.observers.Observer` and schedules `_Handler` against only `self._cfg.runs_path` (master's runs dir). File writes inside worktree-side run dirs — every shape/plan/build/validate artifact for any self-modifying run — fire no events through this observer. Freshness for those writes is delivered exclusively by the 1Hz fallback `set_interval(1.0, self._refresh)` (line 565), so worktree-side updates surface with up to ~1s lag and no instant-refresh path exists.

**Defect 2 — process-lifetime `_WORKTREE_CACHE`.** `lib/runs.py:303-362` declares `_WORKTREE_CACHE: dict[str, tuple[pathlib.Path, ...]] = {}`, keyed on the resolved workbench root. `_list_workbench_worktrees` populates it from `git worktree list --porcelain` on first call and returns the cached tuple thereafter. The function's docstring (lines 309-313) explicitly assumes "the worktree set is stable within a process" — true for short-lived CLI calls (< 1s) but false for the long-running `agent-workbench board` (hours). A worktree created mid-session is invisible to `iter_all_runs` (via `_walk_worktrees` at lines 232-264) until the board restarts, even though every other piece of `iter_all_runs` is correct.

The two defects compound: even if the user worked around the cache (e.g. by restarting the board), the watchdog scope alone would still make worktree-side writes feel laggy because they'd only ever come through the 1Hz timer. And even if the watchdog covered every existing worktree, a worktree created mid-session would have no observer scheduled on it and the cache wouldn't surface it.

Surrounding infrastructure (`RunSnapshot`, `lib/board/source.py`, `lib/board/snapshot.py`, the renderers, the severity model) is correct post-A1 and out of scope. The fix lives in two files: `lib/board/app.py` (observer wiring in `on_mount` + a new periodic re-scan) and `lib/runs.py` (cache shape).

Note on measurements (cited in brief from prior conversation, not re-measured here): `git worktree list --porcelain` was ~16ms median, ~19ms p90 on the workbench's own repo with 3 worktrees. Scales roughly linearly. At 1Hz with raw uncached calls, ~1.6% of one CPU today; at 20 worktrees would approach 5-8%. This bounds the "drop the cache entirely" option as unacceptable — the chosen strategy must keep call frequency well below 1Hz.

## Relevant files

**Touched (source):**
- `lib/board/app.py:485-573` — watchdog handler, app class, `on_mount`, `on_runs_changed`, `_refresh`.
- `lib/runs.py:303-367` — `_WORKTREE_CACHE` + `_list_workbench_worktrees` + `reset_caches`.
- `lib/runs.py:1-16` — module docstring (cache contract documentation lives here).
- `lib/config.py:18-22, 78-83` — `Paths` dataclass + `Config.runs_path`/`worktrees_path` properties.

**Touched (config):**
- `agent-workbench.yaml` lines 78-81 (existing `board:` block; we extend it with two new fields).

**Touched (tests):**
- `tests/test_runs.py` — extend with cache TTL test cases. (Existing file per the explore; confirm exact filename during build.)
- `tests/test_board_snapshot.py` — no changes expected (renderer-level coverage; out of scope).
- New: `tests/test_board_freshness.py` — board-level freshness tests (watchdog multi-root, periodic re-scan, new-worktree-mid-session). Single new file rather than scattering.

**Read-only (referenced for contract reasons, not changed):**
- `lib/board/snapshot.py` (`snapshot.build` calls `metadata.list_runs` → `iter_all_runs`).
- `lib/board/source.py` (`load_run_snapshot` per-run loader).
- `lib/metadata.py` (`list_runs` shim, `run_dir` resolver).

## Proposed changes

### Change 1 — Multi-root watchdog at startup (lib/board/app.py)

In `AgentBoardApp.on_mount`, after the existing single-root `obs.schedule(_Handler(self), str(runs_path), recursive=True)` (line 570), walk `iter_all_runs(cfg)` once and collect the unique set of worktree-side `runs/` parent directories. Schedule a `_Handler` on each. Track the scheduled paths in a new instance attribute `self._watched_paths: set[str]` so the periodic re-scan can diff against it.

This handles every worktree-side run dir that exists at board startup. Cost is bounded: one `iter_all_runs` walk (already O(N) and already paid by the initial `_refresh()` call on line 563, so it'll be cache-warm). Per-path `obs.schedule` is cheap.

### Change 2 — Periodic worktree re-scan (lib/board/app.py)

Add a second `set_interval` (default 5s; configurable via `cfg.board.watch_rescan_seconds`) that:
1. Calls `runs.iter_all_runs(cfg)` to get the current worktree-side run dir set (cheap because the TTL cache from Change 3 will usually have it).
2. Diffs against `self._watched_paths`.
3. For each new path, calls `obs.schedule(_Handler(self), str(path), recursive=True)` and adds to `self._watched_paths`.
4. Logs nothing (the watchdog scheduling is fire-and-forget; no observable failure mode that warrants log noise).

5s gives a documented worst-case "new worktree appears → board sees it" bound of 5s + TTL. With default TTL=2s, that's 7s worst case, well under the ≤30s acceptance bar.

Removed observers (worktrees torn down) are NOT cleaned up actively. `watchdog.observers.Observer` handles missing-path schedules gracefully — the handler just stops firing. We let the schedules accumulate (a worktree creation is rare; a worktree deletion is rarer). This avoids the bookkeeping for `obs.unschedule_all`-and-rebuild semantics that watchdog exposes inconsistently across backends.

### Change 3 — TTL on `_WORKTREE_CACHE` (lib/runs.py)

Change the cache shape from `dict[str, tuple[pathlib.Path, ...]]` to `dict[str, tuple[float, tuple[pathlib.Path, ...]]]`. The float is the populated-at monotonic timestamp.

```python
_WORKTREE_CACHE: dict[str, tuple[float, tuple[pathlib.Path, ...]]] = {}
_WORKTREE_CACHE_TTL_SECONDS: float = 2.0  # module default; overridable per Config
```

In `_list_workbench_worktrees`:
1. Check cached value.
2. If absent or `time.monotonic() - populated_at >= ttl`, re-fetch.
3. Store `(time.monotonic(), result)` on every populate (including the empty-result paths after subprocess failure, so a transient git failure doesn't make us hammer git for the full TTL window).

Add a `ttl: float | None = None` keyword arg to `_list_workbench_worktrees`. Pass `cfg.board.worktree_cache_ttl_seconds` from board callers. Default `None` means use the module default. CLI callers don't pass anything (so a CLI invocation < TTL still uses cache; one > TTL refetches, still fine — most CLI calls are sub-second).

`reset_caches` continues to clear the dict; signature stays.

### Change 4 — Config plumbing for the two TTLs (lib/config.py + agent-workbench.yaml)

Add to the existing `board:` block in `agent-workbench.yaml`:

```yaml
board:
  stale_human_review_hours: 24      # existing
  worktree_cache_ttl_seconds: 2.0   # new
  watch_rescan_seconds: 5.0          # new
```

Plumb through `lib/config.py`'s `Board` config dataclass. Both have safe defaults if missing from the file (backward compat with existing yamls).

### Change 5 — Module docstring on `lib/runs.py`

Append a paragraph to the existing docstring (lines 1-16) describing the cache contract:

```
_WORKTREE_CACHE is a process-lifetime cache of `git worktree list --porcelain`
output, with a short TTL (default 2s, configurable via cfg.board.worktree_cache_ttl_seconds).
The TTL is correct for both regimes: short-lived CLI calls (< 1s lifetime)
never see TTL expiry and pay the git cost at most once; the long-running board
ticks see new worktrees within TTL seconds, without paying git cost on every
tick. Do NOT remove the TTL or set it to 0; the board would call `git worktree
list` at the watchdog re-scan rate, which was measured at ~16ms median and
~1.6% of one CPU at 1Hz on a 3-worktree repo (scales linearly).
```

### Change 6 — Tests

**`tests/test_runs.py` additions:**
- TTL expiry: monkey-patch `time.monotonic` (or `runs.time.monotonic` if imported by name), populate cache, advance time past TTL, assert next call re-fetches (count `subprocess.run` invocations via `unittest.mock.patch` on `subprocess.run`).
- TTL non-expiry within window: same setup, advance time within TTL, assert single fetch.
- Config override: build a Config with `board.worktree_cache_ttl_seconds=10.0`, assert that's the TTL used (not the module default).
- Failure path stickiness: simulate `subprocess.run` raising; assert second call within TTL doesn't re-attempt.

**`tests/test_board_freshness.py` (new file):**
- Multi-root observer at startup: synthetic workbench with two worktree-side run dirs. Instantiate `AgentBoardApp` (don't run the UI loop — call `on_mount` directly, then unmount). Assert `self._watched_paths` contains master's runs dir plus both worktree-side dirs.
- Periodic re-scan picks up new worktree: synthetic workbench with one worktree. Instantiate app, call `on_mount`, then create a second worktree on disk and append its run dir to the worktree set (or use a fake `_list_workbench_worktrees`). Manually invoke the periodic re-scan callback. Assert the new path is now in `self._watched_paths`.
- Periodic re-scan idempotent: invoke the callback twice on a stable worktree set; assert no duplicate `obs.schedule` calls (mock `obs.schedule`, count invocations).

These tests use direct method invocation, NOT the Textual run loop — driving the UI would require a Textual test harness, which isn't worth standing up for these unit-level checks. The slash command's existing "tests/test_board_*.py" pattern (per the explore: `tests/test_board_snapshot.py`) is the precedent.

### Change 7 — Performance smoke (informational, not a regression gate)

Add a small benchmark script `scripts/bench_board_freshness.py` (or inline in `test_board_freshness.py` behind `pytest.mark.benchmark` if the suite already has the plumbing — confirm during build). Measures `snapshot.build(cfg)` median wall-clock at N=3, N=10, N=20 synthetic worktrees. Prints results; does not assert a budget (the brief's ≤100ms target is a working hypothesis to verify, not a hard pass/fail).

## Files likely to change

- `agent-workbench-live/lib/board/app.py`
- `agent-workbench-live/lib/runs.py`
- `agent-workbench-live/lib/config.py`
- `agent-workbench-live/agent-workbench.yaml`
- `agent-workbench-live/tests/test_runs.py` (extend)
- `agent-workbench-live/tests/test_board_freshness.py` (new)
- `agent-workbench-live/scripts/bench_board_freshness.py` (new, optional)

## Data model changes

- `_WORKTREE_CACHE` value shape: `tuple[pathlib.Path, ...]` → `tuple[float, tuple[pathlib.Path, ...]]`. Backward-incompatible for any code that reaches into the cache dict directly (none should — it's module-private with leading underscore).
- `lib/config.py` `Board` dataclass: add two float fields with defaults. No yaml backward-compat issue (loader tolerates missing fields).
- `agent-workbench.yaml`: two new keys under the existing `board:` block. Existing files without them keep working.

## UI changes

None visible to the user. The TUI's columns, severity styling, and bindings all stay as-is. The only observable behavior change is that worktree-side artifact writes refresh the board within the same instant-refresh window as master-side ones, and new worktrees show up without a board restart.

## Test plan

### Unit (lib/runs.py)
- TTL expiry — `subprocess.run` called twice across a TTL boundary.
- TTL non-expiry — `subprocess.run` called once within TTL.
- Config-supplied TTL overrides module default.
- Subprocess-failure stickiness — error result cached for TTL window.
- `reset_caches()` clears everything (regression test for the existing behavior).

### Unit (lib/board/app.py)
- Multi-root observer scheduling at `on_mount` against a synthetic workbench with N≥2 worktree-side run dirs.
- Periodic re-scan picks up a new worktree.
- Periodic re-scan is idempotent across calls.
- `_watched_paths` survives observer-failure (one bad path doesn't break scheduling for the rest).

### Integration
- One end-to-end test that uses `_make_self_modifying_workbench` (per existing patterns in tests/test_self_modifying.py per AGENTS.md) to:
  1. Create a synthetic monorepo + workbench + worktree.
  2. Spin up `AgentBoardApp` to the point of `on_mount` (no actual UI loop).
  3. Write a new event to a worktree-side `events.jsonl`.
  4. Manually flush the watchdog observer (or sleep + assert via the 1Hz fallback) and assert `_refresh` was invoked.

### Performance smoke
- `snapshot.build(cfg)` at N=3, N=10, N=20 synthetic worktrees. Median of 5 trials each. Print results; flag if > 200ms median (a hand-tuned "we expected ≤100ms" guard, not a regression gate).

## QA plan

These will be run by the human after `/start` and during validation. The agent should also run them automatically as part of the build's QA pass:

1. Start the board on a workbench that has at least one self-modifying worktree-side run not in a terminal state. Confirm the row shows the run.
2. From a sibling shell, append a synthetic event line to the worktree-side `events.jsonl`. Confirm the board's row's `updated_at` reflects the new write within ≤1s (the row should change visibly).
3. Start the board against a workbench. From a sibling shell, run `agent-workbench new-run` for a self-modifying target so a new worktree is created. Confirm the new run appears on the board within ≤7s (TTL + re-scan worst case).
4. Drive a worktree-side run from `human_review → done` via `/complete` from a sibling shell while the board is running. Confirm the row advances to `done` and the prior `human_review` row vanishes without a manual board restart.
5. Drive a worktree-side run from `human_review → abandoned` via `/abandon`. Same expectation.
6. With the board running, kill the watchdog Observer thread externally (process-level; admittedly hard to do cleanly — alternative: monkey-patch `obs.start` to no-op in a test mode and confirm the 1Hz fallback still produces correct columns).

## Risks

1. **Watchdog backend variance across platforms.** macOS uses FSEvents, Linux uses inotify. Both honor `recursive=True` but have different latency / fan-out characteristics. The brief's bound (≤1s) is met by both today; the multi-root extension shouldn't change that — each Observer's queue is independent. *Mitigation:* don't add platform-specific code paths; rely on watchdog's abstraction. If a regression appears, add a platform-specific note to `lib/runs.py`'s docstring rather than branching the logic.
2. **Observer schedule on a path that vanishes.** A worktree torn down via `git worktree remove` between `iter_all_runs` and `obs.schedule` could leave a dangling observer. *Mitigation:* `obs.schedule` against missing paths is silently a no-op on macOS+Linux; we accept the dead schedule. The cleanup story (above) is "accumulate, don't reap."
3. **TTL chosen wrong.** 2s default is a working hypothesis. *Mitigation:* configurable via `cfg.board.worktree_cache_ttl_seconds`. If a user finds 2s too slow (subjective), they can lower it; the perf-vs-freshness tradeoff is theirs to tune.
4. **CLI cost regression.** Adding a TTL check on every cache hit adds a `time.monotonic()` call (~50ns). *Mitigation:* this is below noise. If anyone benchmarks, the existing CLI runs in ~milliseconds and a few extra ns of monotonic-clock reads is invisible.
5. **Periodic re-scan accumulates work over time.** If a session creates and tears down many worktrees, `self._watched_paths` grows unboundedly (alongside dead `obs.schedule` entries). *Mitigation:* bounded by real human worktree churn (≤ dozens per day for even very active users). If this becomes a real problem, add a `_watched_paths` -size cap or active reaping in a future iteration. Not worth pre-optimizing.
6. **Multi-root Observer thread cost.** Each `obs.schedule` call adds a watch descriptor (inotify) or a separate stream (FSEvents). On macOS, FSEvents pools by parent; cost is near-flat. On Linux, inotify watches have a per-user kernel cap (default 8192). *Mitigation:* one watch per worktree-side runs dir at typical worktree counts (≤ 20) is far below the cap. Document the upper bound in `lib/runs.py`'s docstring if it ever becomes load-bearing.
7. **`iter_all_runs` cost in `on_mount`.** First call walks every run. *Mitigation:* this is the same call `_refresh()` already makes on line 563; we're not adding work, just reading its output. The TTL cache from Change 3 means the second call (in `on_mount`'s scheduling loop) is free.
8. **Test reliance on `_watched_paths` (a leading-underscore private attr).** Tests will read this directly. *Mitigation:* it's fine within the package's own tests — by convention, single-underscore attrs are package-internal, not module-internal. If we later refactor, the test imports break loudly, which is the desired failure mode.

## Definition of done

- All 8 acceptance criteria in `brief.md` pass against the implemented code.
- All new + existing unit and integration tests pass.
- `lib/runs.py`'s module docstring is updated with the cache contract paragraph.
- The performance smoke prints sub-200ms median at N=20 worktrees on the CI runner (or the local dev machine; the workbench has no CI runner of its own per docs).
- `agent-workbench board` against a workbench with ≥ 1 worktree-side run dir refreshes within ≤ 1s of a worktree-side write (manual QA, recorded in `build.md` Verification).
- `agent-workbench board` discovers a new worktree (created via `new-run --new-repo-path`) within ≤ 7s of the new-run command completing (manual QA).
- No changes to `RunSnapshot`, `lib/board/source.py`, `lib/board/snapshot.py`, the renderers, or the severity model.

## Preflight

| Field | Value |
|---|---|
| `repo_path` | `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai` |
| `repo_name` | `agentic-development-task-system-v3-ai` |
| `base_ref` | `master` (per metadata) |
| `branch_name` | `agent/board-freshness-across-worktrees` |
| `worktree_name` | `board-freshness-across-worktrees` |
| `worktree_path` | `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees` |

**Checks performed:**

- `metadata.yaml`'s target.repo.path resolves to an existing git repo. ✓
- `agent-workbench-live/lib/board/app.py`, `agent-workbench-live/lib/runs.py`, `agent-workbench-live/lib/config.py`, `agent-workbench-live/tests/test_runs.py` all exist at the expected paths. ✓
- The brief's acceptance criteria are testable from inside the workbench's own pytest suite (no external services needed). ✓
- No new top-level deps. The implementation uses `time.monotonic()` (stdlib), `subprocess` (already used), `watchdog` (already used), and the existing `Config` plumbing.

**Warnings:**

- The two slash-command docs `agent-workbench-live/.claude/commands/plan.md` and `.claude/commands/shape.md` reference an older "flat layout" with separate `preflight.md` / `assumptions.md` / `decisions.md` files. The implementation actually uses the staged single-file `plan.md` layout (`PLAN_TEMPLATES_FLAT = ("plan.md", ...)` vs. the staged path that only stages `plan.md`). The doc drift didn't block this run but should be cleaned up in a separate TODO; out of scope here.
- Existing board tests (per the explore: `tests/test_board_snapshot.py`) cover the snapshot model and renderer but NOT the watchdog or the 1Hz timer or the cache. The new `tests/test_board_freshness.py` file fills this gap.

## Decisions & assumptions

### DR-001
- **Decision**: Combine multi-root watchdog scheduling at startup (Option 1 from the brief) with a periodic re-scan (Option 2 from the brief), rather than picking one alone.
- **Rationale**: Option 1 alone misses worktrees created mid-session; Option 2 alone wastes effort scheduling-then-unscheduling on every tick. Together: Option 1 covers the common case for free (one scan at startup), Option 2 covers the rare new-worktree case at low frequency (5s). Worst-case new-worktree-to-visible bound is 5s + TTL (default 2s) = 7s, well under the brief's ≤30s acceptance bar.
- **Alternatives considered**: Option 3 (recursive observer on `cfg.worktrees_path`); Option 1 alone; Option 2 alone.
- **Why not the alternatives**: Option 3 watches `/Users/.../LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/...`, which contains many sibling worktrees including ones for *unrelated* repos (the explore confirmed the LOCAL_worktrees directory at this path contains repos beyond just agentic-development-task-system-v3-ai). Every product-code edit anywhere in any of those would fire `_Handler` even with the existing `.tmp` filter — high noise, mostly debouncing it later, not earlier. Option 1 alone fails the brief's AC #2. Option 2 alone is needlessly noisy (re-scans even when nothing changed) and harder to test for idempotency without a path-tracking set.

### DR-002
- **Decision**: Use a short TTL (default 2s, configurable) on `_WORKTREE_CACHE` rather than dropping the cache, adding an explicit invalidation hook, or relying on the multi-root watchdog alone.
- **Rationale**: TTL works in both regimes without the caller needing to know which regime it's in. Short-lived CLI calls (< 1s) never hit TTL expiry; the long-running board pays the git cost at most once per TTL window per call site. ~10 lines of code. The user explicitly asked (in the originating conversation, per brief.md Origin) for an explore-then-decide approach rather than jumping to "drop the cache"; this preserves the cache for the regime it was correct for.
- **Alternatives considered**: Drop the cache for `iter_all_runs`; explicit invalidation hook (`runs.invalidate_worktree_cache()`); rely solely on the multi-root watchdog (no cache change).
- **Why not the alternatives**: Drop-the-cache pays ~16ms per board tick × forever, growing with worktree count, with no benefit beyond simplicity. Invalidation-hook adds a contract the board has to remember to honor and a coupling between two modules that prefer to know nothing about each other. Watchdog-only doesn't address the AC #2 ("new worktrees appear without restart") path that strictly involves `iter_all_runs` discovering the new worktree set; AC #2 needs the cache to refresh.

### DR-003
- **Decision**: Make the watchdog re-scan and the cache TTL configurable in `agent-workbench.yaml`'s existing `board:` block rather than hardcoded constants.
- **Rationale**: The brief explicitly calls out the 2s and 5s defaults as working hypotheses. Users with different workflows (more worktrees, slower disks, etc.) need an escape hatch without forking the code. The existing `board.stale_human_review_hours` field is the precedent; we're extending an established pattern, not inventing one.
- **Alternatives considered**: Hardcoded module-level constants.
- **Why not the alternatives**: Hardcoded values make per-user tuning impossible without code edits. The cost of two new yaml fields is essentially zero given the existing `board:` block.

### DR-004
- **Decision**: Don't actively reap observers when a worktree is torn down. Let `obs.schedule` entries accumulate; the handler is a no-op for vanished paths.
- **Rationale**: Tear-down is rare (most worktrees stay around through a run's full lifecycle). The watchdog API for unscheduling is not perfectly uniform across platforms (inotify, FSEvents, polling backends). The simplest safe behavior is to leave dead schedules in place. Memory cost is one entry per ever-created-worktree, capped by real human worktree churn (≤ dozens).
- **Alternatives considered**: Diff the observer set against current worktrees on every re-scan, unschedule missing ones.
- **Why not the alternatives**: Adds complexity (per-path bookkeeping for unscheduling), exposes platform-specific watchdog edge cases (e.g. FSEvents stream restart), and yields negligible memory savings. The unbounded-growth concern is theoretical at typical worktree counts.

### DR-005
- **Decision**: Tests for the periodic re-scan use direct method invocation on `AgentBoardApp` (call `on_mount`, then call the re-scan handler directly), NOT the full Textual run loop or `App.run_test()`.
- **Rationale**: Textual's test harness is heavyweight relative to the unit-level checks needed here (observer set membership, idempotency of the re-scan, multi-root scheduling at startup). The existing `tests/test_board_snapshot.py` precedent uses direct snapshot model assertions, never spinning up the UI. Following that convention keeps tests fast and deterministic.
- **Alternatives considered**: Use `App.run_test()` to drive the full UI lifecycle and assert on resulting state.
- **Why not the alternatives**: Pulls in event-loop timing into the assertion path. The behavior under test (observer scheduling) is synchronous within `on_mount`; the UI loop adds nothing to the verification but adds a lot to the flake surface.

### ASM-001
- **Text**: The Linux inotify watch-descriptor cap (default 8192) is high enough that one watch per worktree-side runs dir won't approach it at any realistic worktree count.
- **Reason**: 8192 default >> the dozens of worktrees a single human session creates. The cap can also be raised system-wide if it ever became a constraint (`/proc/sys/fs/inotify/max_user_watches`).
- **Impact**: low

### ASM-002
- **Text**: The 5s re-scan interval default is correct for a TUI's interactive feel. A user creating a new worktree expects to see it on the board within "a few seconds, not a minute."
- **Reason**: Subjective UX call. The brief's AC #2 allows up to 30s for the periodic-rescan strategy; 5s is comfortably inside that.
- **Impact**: low (configurable; users can dial it down)

### ASM-003
- **Text**: `subprocess.run(["git", "worktree", "list", "--porcelain"], ...)` succeeds reliably on the workbench's own repo in the timeout window (5s currently). No need to add a watchdog around the git call itself.
- **Reason**: Today's behavior is exactly this; no reports of timeout-induced failures. The board has been running production-style sessions for weeks.
- **Impact**: low

### ASM-004
- **Text**: The board's existing tests (`tests/test_board_snapshot.py` per the explore) pass against the master branch and will continue to pass after these changes without modification.
- **Reason**: The snapshot/source/renderer surface isn't touched; only the watchdog wiring (which the existing tests don't exercise) and the cache shape (which is internal to `lib/runs.py` and not asserted on by the snapshot tests).
- **Impact**: medium — if this assumption is wrong, the validate stage will catch it; not worth running the whole suite during planning.

### ASM-005
- **Text**: Future perf work (the "board snapshot is O(N²)" TODO §9) will not conflict with the cache shape change here. The shape `dict[str, tuple[float, tuple[Path, ...]]]` is forward-compatible with any TTL-aware caller.
- **Reason**: §9's tasks operate on different layers (per-snapshot-build dedup, `metadata.run_dir` recursion, YAML parsing). The cache shape change here is orthogonal.
- **Impact**: low (no co-landing required; either order works)
