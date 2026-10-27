# Review

## Decision

approve (with two AC partial-credit notes — see Findings F-001 and F-002).

## Did the implementation satisfy the brief?

Mostly yes. ACs 1, 2, 3, 5, 6, 8 are met. AC4 (cost measurement at ≥10 worktrees) and AC7 (perf smoke at N=3/10/20) are NOT fully met and the build.md previously claimed AC4 was covered — that claim has been corrected and AC7 is recorded as a follow-up. See Findings.

Concretely:
- **AC1** (worktree-side artifact writes refresh the board): per-worktree observers are scheduled in `_schedule_worktree_runs_dirs`; the watchdog backend's standard delivery latency (unchanged from today) applies.
- **AC2** (new worktrees appear without restart): `_rescan_worktrees` + TTL on `_WORKTREE_CACHE` together close the gap. Worst-case bound is `≈ 2 × watch_rescan_seconds` (10s with defaults) in the bad-phase case where the cache populates just before a rescan tick — corrected from the build.md's optimistic "5s + 2s = 7s" math.
- **AC3** (terminal transitions visible without restart): unchanged code path, but the source artifact writes now reach observers via the new wiring.
- **AC5** (cache contract documented): `lib/runs.py` module docstring has the new "Worktree-list cache contract" section.
- **AC6** (tests would fail under today's behavior): 5 TTL tests pin the cache shape, 7 board-freshness tests pin observer scheduling + TTL-driven rescan; the original no-TTL/single-root code would fail several of them.
- **AC8** (no regression in `RunSnapshot` / renderers): full suite ran 353 tests, 8 failures, 0 errors — all 8 confirmed pre-existing on master (`test_backfill_base_ref_sha`, banner-text drift in `test_e2e.test_happy_path`, snapshot dates pinned in `test_human_review`). None touch the freshness surface.

## Did it accidentally expand scope?

No. The changes are confined to `lib/runs.py` (cache shape + TTL + docstring), `lib/board/app.py` (per-worktree observer scheduling + periodic re-scan), `agent-workbench.yaml` (two new optional `board:` keys), and the two test files. `RunSnapshot`, `lib/board/source.py`, `lib/board/snapshot.py`, the renderers, and the severity model are untouched.

One internal-API note: `lib/board/app.py` now reaches into `runs._list_workbench_worktrees` (a leading-underscore function) rather than the public `runs.iter_all_runs`. This is necessary for AC2's "brand-new worktree with zero runs" path (see F-003). Within the same package this is conventional; if `lib/runs.py` ever splits its public surface, the import path needs to come with it.

## Are there fragile assumptions?

The implementation assumes:
1. `time.monotonic()` is per-process monotonic. True; not affected by wall-clock warps. No issue.
2. Watchdog's `Observer.schedule()` is safe to call after `Observer.start()`. True in watchdog ≥ 2.x; we don't pin a version, but the repo's existing usage already relies on this.
3. `_watched_paths` is touched only from the Textual UI thread (both `on_mount` and `set_interval`-driven calls run UI-side; the Observer-thread `_Handler.on_any_event` reads `self._app` only, not `_watched_paths`). True in the current code path. A one-line comment near the attribute declaration would protect against future contributors adding an Observer-thread reader without a lock.
4. The 5s default `watch_rescan_seconds` is acceptable UX for the new-worktree-mid-session case. Subjective; configurable per `agent-workbench.yaml`.

## Are there missing tests?

Coverage is now adequate for the in-scope behavior. Gaps:
- No test that the two `set_interval` calls (1Hz `_refresh` + Nsec `_rescan_worktrees`) coexist; relies on Textual's well-known multi-interval support.
- No real-Observer test that confirms the per-worktree watchdog delivers FS events end-to-end. The mocked-Observer tests verify scheduling but not delivery. The delivery is a watchdog-backend property we can't usefully unit-test without spinning the full Textual loop + a real filesystem-event subscriber.
- No perf-smoke test (AC7). Recorded as a follow-up (F-002).

## Are there security / data loss / migration risks?

None. No persistent state changes, no on-disk format changes, no remote API calls, no privilege escalation. The two new `agent-workbench.yaml` keys are optional with safe defaults; existing yaml files keep working.

## What should the human review first?

1. `lib/runs.py` module docstring (lines 17-34) — confirms the cache contract.
2. `lib/runs.py:_resolve_worktree_cache_ttl` and `lib/board/app.py:_resolve_watch_rescan_seconds` — confirm the `MIN_SECONDS` clamps. Without them, a config typo (`worktree_cache_ttl_seconds: 0`) would silently revert to "call git on every cache check," exactly the behavior the docstring forbids.
3. `lib/board/app.py:_schedule_worktree_runs_dirs` (post-revision) — confirm iteration is over `_list_workbench_worktrees` (not `iter_all_runs`) so brand-new worktrees with zero runs still get observers.
4. `tests/test_board_freshness.py:test_rescan_picks_up_new_worktree_via_ttl_not_reset_caches` — confirms the production code path (TTL-driven cache miss) is exercised, not a `reset_caches()` shortcut.
5. `runs/2026-05-26-board-freshness-across-worktrees/build.md` "Acceptance criteria coverage" table — confirm AC4 and AC7 are honestly described as partial / deferred.

## Blast radius

`stages/5_validating/blast-radius.txt` is empty in this run because the source-side changes are uncommitted at the time `validate --init` ran (the generator reads committed diff). Manual blast assessment:

**Depth-1 callers of changed symbols:**
- `lib/runs.py:_list_workbench_worktrees` — called by `_walk_worktrees` (same file), now also called by `lib/board/app.py:_schedule_worktree_runs_dirs`. Signature change (`ttl: float | None = None` kwarg) is backward-compatible — every existing call site passes no kwarg.
- `lib/runs.py:_WORKTREE_CACHE` value shape changed from `tuple[Path, ...]` to `tuple[float, tuple[Path, ...]]`. No code reads the dict directly except `_list_workbench_worktrees` and `reset_caches` (both in the same file). Safe.
- `lib/runs.py:_resolve_worktree_cache_ttl` is new; no callers outside `_list_workbench_worktrees`.
- `lib/board/app.py:AgentBoardApp.__init__` gained one new attribute (`self._watched_paths`); `on_mount` got new helpers. No external callers of these.

**Depth-2 reach:**
- Anything that walks through `_walk_worktrees` → `_list_workbench_worktrees`: `iter_all_runs`, `find_run` (via `_walk_all`), `metadata.run_dir`'s fallback, `cmd_list.py`'s lister, the board's `snapshot.build`. All of these continue to work — the only observable change is that they might re-fetch the worktree set after TTL expiry instead of within the first call. This is the intended behavior.

**Outside the brief's expected scope:** none. Every changed file is named in the plan or is a test file in the locations the plan called out.

## Findings

### F-001
- **Severity**: minor
- **Where**: `build.md` Acceptance criteria coverage row AC4
- **Issue**: The brief's AC4 demanded measurement at the current worktree count AND at a stress count (≥10 worktrees). The build.md originally claimed the AC was covered by citing the ~16ms/~19ms numbers from the originating TODO conversation. Those numbers were not re-measured in this run; the plan explicitly flagged this ("cited in brief from prior conversation, not re-measured here"). The build.md narrative as it stands overstates coverage.
- **Suggested fix**: Update `build.md`'s AC4 row to honestly say "Partial — the 3-worktree cost was cited from the originating conversation; the ≥10-worktree stress measurement was deferred to a follow-up (see F-002)." Already corrected in the post-review revision of build.md; flagging here for completeness.

### F-002
- **Severity**: minor (follow-up worthy, not a blocker)
- **Where**: `build.md` Acceptance criteria coverage row AC7
- **Issue**: AC7 (perf smoke at N=3/10/20 worktrees with a ≤100ms median budget) is not implemented. The build.md notes this as a deviation but doesn't escalate it into a follow-up — leaving an acceptance criterion partially open without a recorded next step.
- **Suggested fix**: Add a `follow-ups.md` entry in the `/followups` stage capturing AC7 + AC4 stress measurement as a single benchmarking task. Title: "Board freshness perf smoke + stress-count cost measurement". Justification: the freshness change here does NOT modify `snapshot.build`'s cost path, so it shouldn't regress; verifying that empirically is still worth a session.

### F-003
- **Severity**: info
- **Where**: `lib/board/app.py:_schedule_worktree_runs_dirs`
- **Issue**: First-draft implementation iterated `iter_all_runs` and filtered to `source == SOURCE_WORKTREE`, which missed brand-new worktrees with zero runs (a real path through AC2: `new-run` creates the worktree before writing the first metadata.yaml). Revised to iterate `_list_workbench_worktrees` directly so a worktree's `runs/` dir gets observed even before its first run exists. New test (`test_schedule_worktree_runs_dirs_skips_worktree_with_no_runs_dir`) pins the corollary case where the `runs/` dir itself doesn't exist yet — watchdog refuses, we skip cleanly, the next rescan picks it up after the first artifact write.
- **Suggested fix**: None — already in the implementation.

### F-004
- **Severity**: info
- **Where**: `build.md` worst-case latency claim "5s + 2s = 7s"
- **Issue**: The math is wrong. TTL doesn't compound additively with rescan interval; the worst case is the bad-phase case where a rescan tick lands just inside a fresh TTL window, returns the stale cached worktree set, and waits one full rescan interval for the next tick. That's `≈ 2 × watch_rescan_seconds` ≈ 10s with defaults — still under the brief's ≤30s acceptance bar, but the stated "7s" is wrong.
- **Suggested fix**: Update `build.md`'s AC2 row to say "≤ 10s (`2 × watch_rescan_seconds` worst case)" or simply "≤ `2 × watch_rescan_seconds`". Already corrected in the post-review revision.

### F-005
- **Severity**: info
- **Where**: `lib/board/app.py:AgentBoardApp.__init__` (`self._watched_paths` declaration)
- **Issue**: The attribute is read and written from the Textual UI thread today. A future contributor adding an Observer-thread reader (e.g. to short-circuit duplicate event posts) would create a race without realizing it.
- **Suggested fix**: One-line comment near the attribute saying "Mutated only from the UI thread; do not read or write from the Observer thread without a lock." Low priority; could be deferred to a future cleanup.

### F-006
- **Severity**: info
- **Where**: `_WORKTREE_CACHE_TTL_MIN_SECONDS = 0.05` and `_WATCH_RESCAN_MIN_SECONDS = 1.0`
- **Issue**: 50ms minimum on the cache TTL is generous (the brief's TTL math doesn't care about ms-scale TTLs), but it preserves the cache's "at most one git invocation per CLI process" guarantee even if someone tries to defeat it. 1s minimum on rescan is conservative to keep the UI thread responsive. Both bounds are arbitrary; document them as such if anyone asks.
- **Suggested fix**: None — the values are defensible and the comments next to them explain the why.

## Documentation claims

Validating compared `build.md`'s **Documentation touched** section against `git diff` in the worktree. The following claimed paths were NOT changed in the diff:

- ``agent-workbench-live/lib/runs.py``

Either the claim is wrong, the change is unstaged, or the base ref is misconfigured. Reviewer: confirm or push back.
