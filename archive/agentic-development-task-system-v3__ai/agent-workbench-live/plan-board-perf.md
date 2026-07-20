# Board perf + usability fixes — plan

## Brief

The live board (`bin/agent-workbench board`) is unusable: every refresh takes
~2.7s for 6 visible runs (18 on disk), the 1Hz fallback timer fires constantly,
and every refresh blows away all `RunCard` widgets — so the scrollbar resets
and the UI feels permanently "loading."

Root causes (profiled, see chat audit above):

- `metadata.run_dir` is called on every `load_run_snapshot`, which falls through
  to `runs.find_run` for worktree-side runs, which re-walks every worktree and
  re-parses every metadata.yaml — `O(runs × worktrees × runs_per_worktree)`
  YAML parses per snapshot (~585 reads for 18 runs).
- `is_self_modifying` runs `git rev-parse --git-common-dir` once per run-resolve
  → ~150 git subprocesses per snapshot.
- The 1Hz fallback timer assumes refresh is cheap; it isn't, so the UI is
  always behind.
- Watchdog events fire per filesystem event with no debounce — a single
  `metrics.jsonl` append during a build can trigger dozens of `RunsChanged`.
- `StatusColumn.update_column` calls `remove_children()` + remounts every card
  on every refresh, killing scroll position and burning CPU.
- Subtitle shows `HH:MM:SS` and rerenders every second — pure visual flicker.

User's insight to fold in: most fields on a `RunSnapshot` (run_id, repo_name,
branch_name, worktree_path, created_at, scope_kind, …) are **invariant for the
lifetime of the run**. Only a handful change (status, updated_at, recent
events, build iterations, diff stats, metrics). The board should cache the
invariant skeleton per run and only re-read the volatile parts.

Implements audit items 1, 2, 3, 4 (expanded), 6, 7, 10. Lands in two PRs so
the big-impact backend changes ship before the Textual-side rewiring.

## Changes

### PR1 — backend: cut snapshot cost by >100×

**1. Plumb `Run` through `snapshot.build` → `load_run_snapshot`** (audit #1)

- `lib/board/snapshot.py:71` — change the loop to consume `Run` objects from
  `runs.iter_all_runs(cfg)` directly instead of `metadata.list_runs(cfg)` →
  `metadata.load`.
- `lib/board/source.py:439` — give `load_run_snapshot` an optional
  `pre_resolved: Run | None = None` parameter. When supplied, use
  `pre_resolved.run_dir` and `pre_resolved.metadata` instead of calling
  `metadata.load` / `metadata.run_dir`.
- `lib/board/source.py:523` — `lifecycle.stage_dir(cfg, run_id, "building")`
  also calls `metadata.run_dir` (via `_run_root` at lib/lifecycle.py:84). Add
  a `run_root: pathlib.Path | None = None` kwarg to `lifecycle.stage_dir`
  (threaded through `_resolve_stage_dir`) so the board can pass
  `pre_resolved.run_dir` and skip the re-resolve. Other callers continue to
  work unchanged.

Acceptance: profile shows `metadata.run_dir` called ≤ 18 times per snapshot
(was 180), `runs.find_run` not called in the steady-state path (was 18).

**2. Cache `is_self_modifying` / `_git_common_dir`** (audit #2)

- `lib/runs.py:110` — add a module-level
  `_GIT_COMMON_DIR_CACHE: dict[str, pathlib.Path | None]` keyed on the
  absolute starting path. No TTL — deterministic for the process lifetime.
- `lib/runs.py:76` — `is_self_modifying` calls `_git_common_dir` twice
  (`wb_root` + `repo_path`); caching there is enough.
- Extend `reset_caches()` at lib/runs.py:413 to also clear the new cache.

Acceptance: `subprocess.run` count drops from ~150/snapshot to ≤ 2 across
the whole process lifetime.

**3. Cache parsed metadata + events between snapshots, keyed on `(path, mtime_ns)`** (audit #3)

- `lib/board/source.py` — add two module-level caches alongside `_DIFF_CACHE`
  (lib/board/source.py:32):
  - `_META_CACHE: dict[str, tuple[int, dict]]` — key = resolved metadata path
    string, value = `(mtime_ns, parsed_dict)`.
  - `_EVENTS_CACHE: dict[str, tuple[int, list[dict]]]` — same shape, keyed on
    `events.jsonl` path.
- `_iter_events` (lib/board/source.py:232) and the metadata load step in
  `load_run_snapshot` (lib/board/source.py:452) consult these caches: stat
  once; if `st_mtime_ns` matches the cache entry, return the cached parse.
- Add a `_reset_board_caches()` helper for tests (mirrors lib/runs.py:413).
  It clears every new board-side cache plus `_DIFF_CACHE`.

Acceptance: warm snapshot timing < 50ms on the current 18-run dataset.

**4. Volatile-vs-invariant snapshot split** (audit #4, expanded per user)

The user's point: most `RunSnapshot` fields are write-once-by-`new-run` and
never change. Stop re-deriving them every tick.

- Introduce a new frozen dataclass `RunCore` in `lib/board/source.py` holding
  fields that **never change once written**:
  - `run_id`, `scope_kind`, `repo_name`, `repo_path`, `repo_path_tail`,
    `branch_name`, `worktree_name`, `run_dir`, `worktree_path`, `created_at`,
    `source`.
- `RunSnapshot` keeps the volatile fields (status, updated_at, ages, events,
  build/validation/diff/metrics, severity flags, recent_events) and gains a
  `core: RunCore` field for the invariant chunk. Existing access patterns
  preserved by either (a) keeping the existing top-level fields as
  `@property` shims that proxy to `self.core`, or (b) mechanically updating
  the two call sites that read these fields (lib/board/app.py renderer,
  lib/cli/cmd_board.py static renderer). I lean (b) — fewer surprises —
  but will use (a) if (b) bloats the diff.
- Module-level `_CORE_CACHE: dict[str, RunCore]` keyed on `run_id`. Populated
  on first sighting. Invalidated only on explicit `_reset_board_caches()` —
  never expires while the process is up. If a run ever changes repo or
  worktree path mid-flight, the user has bigger problems.
- `load_run_snapshot` builds the volatile fields on every call (cheap once
  #3 is in place) and attaches the cached `RunCore`.

In the snapshot loop in `snapshot.build`:

- For every `Run` in `runs.iter_all_runs`, check `run.run_id`:
  - **not in `_CORE_CACHE`** → full path: build `RunCore` + volatile fields,
    cache the core.
  - **in `_CORE_CACHE`** → skip core construction; only read `metadata.yaml`
    (cached by mtime per #3) and `events.jsonl` (likewise) for the volatile
    fields.
- Runs present in `_CORE_CACHE` but missing from this enumeration → drop their
  core. Cheap; the cache is tens of entries.

Acceptance: on steady state (no new runs added), snapshot rebuild touches only
status + events + metrics on disk; warm timing < 20ms.

**6. Cache AC parse / metrics scan on `(path, mtime_ns)`** (audit #6)

- `lib/board/source.py:255` `_parse_ac_coverage` — wrap result in a
  `_AC_CACHE: dict[str, tuple[int, tuple[int|None, int|None, bool]]]` keyed
  on the build.md path; check `st_mtime_ns` before re-parsing.
- `lib/board/source.py:692` `_quick_metrics_from_jsonl` — wrap in
  `_METRICS_CACHE` keyed on `metrics.jsonl` path with same mtime guard.
- Both clear from `_reset_board_caches()`.

Acceptance: a snapshot of an idle dataset where build.md and metrics.jsonl
haven't changed performs zero re-parses of either file.

### PR2 — UI: diff-update cards, debounce events, fix the clock

**7. Diff-update cards instead of remount-all** (audit #7)

- `lib/board/app.py:469` `StatusColumn.update_column` — track mounted cards
  in `self._cards: dict[str, RunCard]` keyed on `run_id`. On update:
  - For each incoming run: if `run_id` in `self._cards`, call the new
    `card.apply(run, …)` method (see below) and re-evaluate severity classes
    (`add_class("-blocking") / remove_class("-warning")` etc). Else mount a
    new card and record it.
  - For each `run_id` in `self._cards` but not in incoming: `card.remove()`
    and drop from the dict.
  - After the diff, ensure DOM order matches the incoming order. Use
    `self._body.move_child(card, before=…)` only where a card is out of
    place (cheap when nothing moved). If `move_child` isn't available on the
    pinned Textual version, fall back to "remove the misplaced subset and
    remount in order" — still O(misplaced) not O(all).
- `RunCard.__init__` (lib/board/app.py:423) currently sets severity classes
  once. Refactor:
  - New `RunCard.apply(run, *, compact, workbench_root, show_paths)` instance
    method updates the `Text` via `self.update(_card_text(...))` and resets
    severity classes.
  - `__init__` becomes: store args, call `self.apply(run, …)`.

Acceptance: in the running TUI, scrolling a column then waiting through 3
refresh cycles leaves `scroll_y` unchanged. A new card appearing scrolls the
column only when the user is already at the top.

**4 (continued) — debounce + filter watchdog events; drop the 1Hz timer** (audit #4)

- `lib/board/app.py:514` — replace per-event `post_message` with a coalesced
  one:
  - The handler bumps a `self._app._fs_dirty` flag and records the latest
    event timestamp on `self._app._fs_dirty_at = time.monotonic()`.
  - A new app-side `set_interval(0.2, self._drain_fs_events)` checks: if
    `_fs_dirty` is set AND ≥150ms since `_fs_dirty_at`, clear the flag and
    post one `RunsChanged`. Quiet-window debounce — every event resets the
    clock; bursts collapse to a single refresh.
- Path filter inside `on_any_event` (lib/board/app.py:518):
  - Already drops `.tmp` (lib/board/app.py:523). Extend:
    - drop paths whose basename starts with `.` (vim swapfiles, fsevents
      droppings on macOS).
    - drop paths containing `/archive/` (historical writes, never visible).
- `set_interval(1.0, self._refresh)` at lib/board/app.py:589 → drop entirely,
  or replace with `set_interval(60.0, self._refresh)`. `format_age`
  (lib/board/snapshot.py:104) floors to minutes, so a 60s tick is correct.
  Debounced watchdog handles fast-changing state; the 60s tick is just a
  safety net for the case where inotify silently drops an event.

Acceptance: starting the board and idling for 30s on a quiescent dataset
results in zero `_refresh` calls (no fs activity, no 1Hz tick). A single
`metadata.save` produces exactly one `_refresh` after a ~150ms quiet window.
A burst of 100 events in 50ms produces exactly one `_refresh`.

**10. Drop seconds from the subtitle** (audit #10)

- `lib/board/app.py:701` — change
  `f"… {snap.now.strftime('%H:%M:%S')}"` → `f"… {snap.now.strftime('%H:%M')}"`.
- Bonus: the `Header(show_clock=True)` at lib/board/app.py:577 already
  renders a clock, so the subtitle timestamp is redundant. Decision in the
  PR — keep both at minute granularity, or drop the subtitle timestamp
  entirely and leave just `total_runs · watch`.

Acceptance: subtitle no longer changes once per second.

## Tests

### Unit — PR1

- `tests/board/test_snapshot_perf.py` (new) — synthetic dataset of N runs in
  a tmp workbench root. Time `snapshot.build` cold + warm; assert warm
  < 100ms for N=50. Tolerant threshold so CI noise doesn't flake.
- `tests/board/test_source_caches.py` (new) — for each new cache
  (`_META_CACHE`, `_EVENTS_CACHE`, `_AC_CACHE`, `_METRICS_CACHE`,
  `_CORE_CACHE`, `_GIT_COMMON_DIR_CACHE`):
  - Warm the cache. Assert a second call doesn't touch disk
    (monkey-patch `pathlib.Path.read_text` and assert call count).
  - Bump the file's mtime. Assert the cache reloads.
  - `_reset_board_caches()` empties every cache.
- `tests/board/test_load_run_snapshot.py` (extend existing if present, else
  new) — verify `load_run_snapshot` accepts and honors `pre_resolved: Run`,
  and that omitting it preserves the existing behavior.
- `tests/runs/test_is_self_modifying_cached.py` (new) — call
  `is_self_modifying` 100× in a loop; assert `subprocess.run` invoked at
  most twice (`wb_root` + `repo_path`).

### Unit — PR2

- `tests/board/test_status_column_diff.py` (new) — drive `StatusColumn`
  through `update_column` cycles:
  - Same set of runs, mutated status → existing cards reused (assert by id)
    and severity classes updated.
  - New run appears → mounted at the right position; existing cards keep
    their identity.
  - Run vanishes → removed; surviving cards unaffected.
- `tests/board/test_handler_debounce.py` (new) — feed `_Handler` 100 fake
  events in 50ms; assert exactly one `RunsChanged` posted after the quiet
  window. Use a fake clock so the test doesn't sleep.
- `tests/board/test_subtitle_no_seconds.py` (new) — render two snapshots 1.5s
  apart; assert the subtitle string is identical.

### Manual

Backend (PR1) — Python harness, no TUI required:

```
python3 - <<'PY'
import pathlib, time
from lib import config as config_mod
from lib.board import snapshot as snap
cfg = config_mod.load(pathlib.Path('.'))
snap.build(cfg)           # warm
t = [time.perf_counter()]
for _ in range(10): snap.build(cfg); t.append(time.perf_counter())
gaps = [(b-a)*1000 for a, b in zip(t, t[1:])]
print('per-snapshot ms:', [f'{x:.1f}' for x in gaps])
print('mean:', sum(gaps)/len(gaps))
PY
```

Pre-PR1 baseline: ~2760ms mean. Target post-PR1: < 50ms warm.

UI (PR2) — actions to perform in the running TUI:

1. `bin/agent-workbench board` — open the live board.
2. Scroll a tall column to the middle. Wait ≥ 90s. Assert: scroll position
   didn't move; no visible flicker; subtitle changes at most twice in 90s.
3. In another shell, append a line to one run's `events.jsonl`. Assert that
   card's events band updates within ~250ms and no other card flickers.
4. Start a build in another worktree (or `touch` a new run's metadata.yaml).
   Assert the new run's card appears without resetting any column's scroll.
5. Delete a run's directory (in a throwaway scratch workbench). Assert its
   card disappears, neighbors stay put.

## Sequence

1. Land PR1 first — pure backend, biggest user-visible win (the "always
   loading" feeling is mostly the 2.7s snapshot blocking the UI thread).
2. Land PR2 once PR1 is green. The Textual-side fixes are most valuable on
   top of a snappy backend; on top of the old 2.7s snapshot they'd still feel
   sluggish even with perfect diffing.

## Out of scope (explicitly skipped per user)

- Audit items #5 (off-thread snapshot worker), #8 (manual scroll restore),
  #9 (loading indicator), #11 (more bindings), #12 (severity flash).
- Existing `plan.md` in this directory is for the unrelated "auto-remove
  worktree on `/complete`" change — leaving it alone, naming this file
  `plan-board-perf.md`.
