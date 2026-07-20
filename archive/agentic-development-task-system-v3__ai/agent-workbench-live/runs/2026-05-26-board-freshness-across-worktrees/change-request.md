# Change Request — 2026-05-26-board-freshness-across-worktrees

## Bounce 1 — 2026-05-26T22:00:00Z — timothy.shee

**Scope:** Tests
**Severity:** Tweak (small diff)
**Plan/brief impact:** No, just rebuild

### Specific changes requested

The current validation relied entirely on unit tests with `mock.MagicMock()` for the watchdog `Observer`. That verifies scheduling logic but does NOT verify the real `watchdog` event wiring (filesystem change → `_Handler.on_any_event` → `RunsChanged` Textual message). User explicitly asked for an end-to-end test against the real watchdog stack before accepting the run.

Required:
- Add at least one test that uses a real `watchdog.observers.Observer` (not mocked) scheduled on a worktree-side `runs/` dir via the production code path (`_schedule_worktree_runs_dirs` or `on_mount`'s equivalent).
- Write a file inside that watched dir.
- Assert that `_Handler.on_any_event` actually fires and that the path the production code took (post `call_from_thread`) is exercised. If the Textual `call_from_thread` is hard to drive without a running app, fall back to asserting the `_Handler` was invoked (e.g. monkey-patch `call_from_thread` to record invocations).
- Use a short timeout (≤ 2s) so the test doesn't hang on a backend regression.

### References

- Handoff: `runs/2026-05-26-board-freshness-across-worktrees/HUMAN_REVIEW.md`
- Review: `runs/2026-05-26-board-freshness-across-worktrees/stages/5_validating/review.md`
- Build report: `runs/2026-05-26-board-freshness-across-worktrees/stages/4_building/build.md`
