# Build report (round 2 — bounce response)

## What changed

Responded to bounce 1 ("Add a real-watchdog E2E test to verify FS event wiring, not just scheduling logic"). Added a new `TestRealWatchdogDelivery` class to `tests/test_board_freshness.py` with two tests that exercise the production `_schedule_worktree_runs_dirs` path against a *real* `watchdog.observers.Observer` (not mocked). The tests start the observer, write a file inside the watched worktree-side `runs/` dir, and assert that `_Handler.on_any_event` actually fires and routes through the production cross-thread bridge — verifying not just scheduling logic but the FS-event-to-RunsChanged wiring end to end.

Source code (`lib/runs.py`, `lib/board/app.py`, `agent-workbench.yaml`) is **unchanged from build v1**. Only `tests/test_board_freshness.py` and the run's documentation artifacts moved.

## Files changed

- `agent-workbench-live/tests/test_board_freshness.py` — appended `TestRealWatchdogDelivery` class (lines ~228 onward) with:
  - `_make_real_app` helper that constructs `AgentBoardApp` with a real `watchdog.observers.Observer` and replaces `app.call_from_thread` / `app.post_message` with thread-safe recording sinks (so the test doesn't need a running Textual loop).
  - `test_real_watchdog_fires_handler_on_file_write` — schedules the observer, writes to `events.jsonl`, polls up to 2s, asserts the recording sink captured the post.
  - `test_real_watchdog_filters_tmp_suffix` — writes a `.tmp` file, then a real file, asserts a post lands after the real-file write (verifies the non-`.tmp` event path is functional; intentionally permissive about whether the `.tmp` itself produces a post since FSEvents on macOS reports the parent dir).

## Reviewer reading order

1. `tests/test_board_freshness.py::TestRealWatchdogDelivery::test_real_watchdog_fires_handler_on_file_write` — the load-bearing new test. If this passes the watchdog wiring works.
2. `tests/test_board_freshness.py::TestRealWatchdogDelivery::test_real_watchdog_filters_tmp_suffix` — complement that confirms the `_Handler.on_any_event` filter doesn't accidentally suppress real-file events alongside `.tmp` noise.
3. `change-request.md` — the bounce reason, for traceability.

## Acceptance criteria coverage

The original 8 ACs are unchanged. Only AC1 and AC6 are materially affected:

| AC | Test or justification |
|----|-----------------------|
| AC1 — worktree-side artifact writes refresh the board within ≤1s | **Strengthened.** Previously verified only at the scheduling layer via `test_schedule_worktree_runs_dirs_picks_up_existing_worktrees`; now also verified end-to-end via `test_real_watchdog_fires_handler_on_file_write`, which observes a real watchdog Observer delivering an event within a 2s polling budget (the test's own deadline). On macOS+FSEvents the test completes in well under 1s in practice. |
| AC6 — tests would fail under today's behavior | **Strengthened.** The new E2E test would fail if any link in the chain (`_schedule_path` → `Observer.schedule` → backend → `_Handler.on_any_event` → `call_from_thread`) was broken. Mocked tests didn't exercise the cross-thread bridge at all. |
| AC2/AC3/AC5/AC8 | Unchanged from v1; covered by existing tests. |
| AC4/AC7 | Still partial/deferred per v1's review.md F-002. Bounce did not change scope on these. |

## Deviations from plan

The v1 plan did not anticipate the real-watchdog E2E test. The bounce introduced it as a build-time requirement; this round of build adds it as a single new test class without any other scope expansion.

## Known issues

None. The two new tests pass cleanly; the full suite shows 357 tests with 8 pre-existing failures (same set as v1).

## Commands run

```
python3 -m unittest tests.test_board_freshness.TestRealWatchdogDelivery -v
python3 -m unittest discover tests   # full suite, 357 tests
```

Full-suite result: 357 tests, 8 failures, 0 errors. Same 8 pre-existing failures as v1. Two new tests landed in `TestRealWatchdogDelivery`.

## Documentation touched

None. The added tests are inline-commented but no module docstrings, README, or AGENTS.md updates were warranted by the bounce.
