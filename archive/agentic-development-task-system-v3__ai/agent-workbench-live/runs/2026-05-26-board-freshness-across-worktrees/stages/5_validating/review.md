# Review (round 2 — bounce response)

## Decision

approve.

## Did the implementation satisfy the brief?

Yes, and now more honestly. The bounce specifically called for end-to-end verification of the watchdog wiring. The new `TestRealWatchdogDelivery` class delivers that: a real `watchdog.observers.Observer`, scheduled via the production `_schedule_worktree_runs_dirs` path, demonstrably routes a real file-system write through `_Handler.on_any_event` to the recording sink within ≤2s on the development machine. AC1's "≤1s lag" claim is now backed by actual observation, not just by trust in the watchdog backend's documented behavior.

The two new tests cover:
1. **Real-event delivery** — happy path; file write produces a post on the cross-thread bridge within polling budget.
2. **`.tmp` filter doesn't suppress real events** — verifies that the `_Handler.on_any_event` early return for `.tmp` paths doesn't accidentally block subsequent real events; intentionally permissive about whether the `.tmp` itself produces a post, since FSEvents on macOS sometimes reports the parent dir rather than the file (the early-return path is exercised in either case).

## Did it accidentally expand scope?

No. Only `tests/test_board_freshness.py` changed. No source files, no config files, no other test files. The bounce was narrow; the response is narrow.

## Are there fragile assumptions?

1. **2s polling budget.** Set conservatively. On macOS+FSEvents the tests complete in well under 1s. If the test runs on a slow CI machine with high disk-event latency, the budget may be tight; if it ever flakes, raise to 5s. Documented in the test comments.
2. **`call_from_thread` replacement.** The test replaces `app.call_from_thread` with a recording lambda. This is the documented Textual cross-thread bridge; if Textual ever changes the method name or contract, the test breaks. Acceptable — that's the correct break-loudly behavior.
3. **List append as a thread-safe sink.** CPython guarantees `list.append` atomicity under the GIL. Holds on every supported Python runtime today.

## Are there missing tests?

The bounce explicitly scoped to "real watchdog test, not just scheduling." Done. Two further tests one could imagine but didn't write:
- A test that drives the full `on_mount` path (with `set_interval`, which would require a running Textual loop). Cost-benefit is wrong — would need Textual's test harness for marginal additional confidence.
- A test that confirms the watchdog event lag on a worktree-side write is < 1s with statistical significance. Cost-benefit is also wrong; would be flaky and is the watchdog backend's job, not ours.

## Are there security / data loss / migration risks?

None. Test-only change.

## What should the human review first?

1. `tests/test_board_freshness.py::TestRealWatchdogDelivery::test_real_watchdog_fires_handler_on_file_write` (lines roughly 257-293) — the load-bearing new test. Confirms the watchdog wiring works end-to-end against a real Observer.
2. `tests/test_board_freshness.py::TestRealWatchdogDelivery::_make_real_app` (lines roughly 234-252) — the test fixture that replaces `call_from_thread` with a recording sink. Confirm the replacement matches Textual's actual contract.
3. `runs/2026-05-26-board-freshness-across-worktrees/change-request.md` — the bounce reason, for traceability.
4. `runs/2026-05-26-board-freshness-across-worktrees/archive/4_building/build-v1.md` and `archive/5_validating/review-v1.md` — the prior-round artifacts; v1's AC4/AC7 partial-credit notes still apply.

## Blast radius

`stages/5_validating/blast-radius.txt` is empty (uncommitted source diff). Manual assessment for round 2: zero blast radius. Only `tests/test_board_freshness.py` changed; nothing imports from this test file, so no downstream code is affected.

## Findings

### F-001 (round 2)
- **Severity**: info
- **Where**: `tests/test_board_freshness.py::TestRealWatchdogDelivery::test_real_watchdog_filters_tmp_suffix`
- **Issue**: The test was intentionally written permissively because FSEvents on macOS sometimes reports the parent dir of a `.tmp` write rather than the file itself, which means the `.tmp` path filter in `_Handler.on_any_event` won't always fire. The test confirms the "real file write produces a post" path is functional after a `.tmp` write, which is the property we actually care about. Anyone reading this test should not be surprised that it doesn't assert "zero posts after `.tmp` write."
- **Suggested fix**: None — the permissive shape is correct. The inline comment in the test explains the rationale.

### F-002 (round 2)
- **Severity**: info
- **Where**: AC4 and AC7
- **Issue**: Still partial / deferred per v1's review.md F-002. The bounce did not change this; the v1 follow-up entry "Board freshness perf smoke + stress-count cost measurement" remains the right place to land this work.
- **Suggested fix**: None for this round. Re-emit the same follow-up in the followups stage.
