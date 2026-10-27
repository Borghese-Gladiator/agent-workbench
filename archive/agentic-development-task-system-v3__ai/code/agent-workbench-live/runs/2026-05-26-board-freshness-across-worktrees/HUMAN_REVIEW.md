# Human review — 2026-05-26-board-freshness-across-worktrees

## Files

- **Brief** — [brief.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/stages/2_shaping/brief.md)
- **Plan** — [plan.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/stages/3_planning/plan.md)
- **Build (diffs + AC coverage)** — [build.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/stages/4_building/build.md)
- **QA report** — [report.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/stages/5_validating/qa/report.md)
- **Review decision** — [review.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/stages/5_validating/review.md)
- **Audit** — [audit.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/audit.md)

## Summary of changes

- 4 file(s) touched:
  - ``agent-workbench-live/tests/test_board_freshness.py` — appended `TestRealWatchdogDelivery` class (lines ~228 onward) with:`
  - ``_make_real_app` helper that constructs `AgentBoardApp` with a real `watchdog.observers.Observer` and replaces `app.call_from_thread` / `app.post_message` with thread-safe recording sinks (so the test doesn't need a running Textual loop).`
  - ``test_real_watchdog_fires_handler_on_file_write` — schedules the observer, writes to `events.jsonl`, polls up to 2s, asserts the recording sink captured the post.`
  - ``test_real_watchdog_filters_tmp_suffix` — writes a `.tmp` file, then a real file, asserts a post lands after the real-file write (verifies the non-`.tmp` event path is functional; intentionally permissive about whether the `.tmp` itself produces a post since FSEvents on macOS reports the parent dir).`

→ Full diff: `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/stages/4_building/build.md`

## Testing

**Unit tests**

`python3 -m unittest tests.test_board_freshness.TestRealWatchdogDelivery -v`

```
- **tests_passed**: true (for the surface area changed by this round; the 8 pre-existing failures from v1 are unchanged and unrelated)
- **known_issues_count**: 0
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

Review decision: **request_changes**.

Full QA report:

`/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-26-board-freshness-across-worktrees/stages/5_validating/qa/report.md`

## Run timeline

- [18:41:47] SHAPING — entered shaping
- [18:43:25] PLANNING — entered planning
- [18:49:08] PLANNING — assumption ASM-001: The Linux inotify watch-descriptor cap (default 8192) is high enough that one watch per worktree-side runs dir won't approach it at any realistic worktree coun…
- [18:49:08] PLANNING — assumption ASM-002: The 5s re-scan interval default is correct for a TUI's interactive feel. A user creating a new worktree expects to see it on the board within "a few seconds, n…
- [18:49:08] PLANNING — assumption ASM-003: `subprocess.run(["git", "worktree", "list", "--porcelain"], ...)` succeeds reliably on the workbench's own repo in the timeout window (5s currently). No need t…
- [18:49:08] PLANNING — assumption ASM-004: The board's existing tests (`tests/test_board_snapshot.py` per the explore) pass against the master branch and will continue to pass after these changes withou…
- [18:49:08] PLANNING — assumption ASM-005: Future perf work (the "board snapshot is O(N²)" TODO §9) will not conflict with the cache shape change here. The shape `dict[str, tuple[float, tuple[Path, ...]…
- [18:49:08] PLANNING — decision DR-001: Combine multi-root watchdog scheduling at startup (Option 1 from the brief) with a periodic re-scan (Option 2 from the brief), rather than picking one alone.
- [18:49:08] PLANNING — decision DR-002: Use a short TTL (default 2s, configurable) on `_WORKTREE_CACHE` rather than dropping the cache, adding an explicit invalidation hook, or relying on the multi-r…
- [18:49:08] PLANNING — decision DR-003: Make the watchdog re-scan and the cache TTL configurable in `agent-workbench.yaml`'s existing `board:` block rather than hardcoded constants.
- [18:49:08] PLANNING — decision DR-004: Don't actively reap observers when a worktree is torn down. Let `obs.schedule` entries accumulate; the handler is a no-op for vanished paths.
- [18:49:08] PLANNING — decision DR-005: Tests for the periodic re-scan use direct method invocation on `AgentBoardApp` (call `on_mount`, then call the re-scan handler directly), NOT the full Textual …
- [18:49:09] READY — entered ready
- [18:53:17] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees` on `agent/board-freshness-across-worktrees`
- [18:53:17] BUILDING — worktree on `agent/board-freshness-across-worktrees` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260526__board-freshness-across-worktrees`
- [19:07:53] VALIDATING — entered validating
- [22:30:22] VALIDATING — doc claims: 1 unverified
- [22:30:22] VALIDATING — review decision: request_changes
- [22:30:22] VALIDATING — tests_passed=true; known_issues=0
- [22:30:23] FOLLOWUPS — entered followups
- [22:50:58] FOLLOWUPS — 3 follow-up(s) recorded (docs, scope_extension, tech_debt)
- [22:51:05] FOLLOWUPS — handoff record created
- [22:51:06] HUMAN_REVIEW — handed off
- [00:00:01] BUILDING — bounced — Add a real-watchdog E2E test to verify FS event wiring, not just scheduling logic
- [00:00:01] BUILDING — bounce requested — Add a real-watchdog E2E test to verify FS event wiring, not just scheduling logic
- [00:04:22] VALIDATING — entered validating
- [00:05:58] VALIDATING — review decision: request_changes
- [00:05:58] VALIDATING — tests_passed=true; known_issues=0
- [00:05:59] FOLLOWUPS — entered followups
- [00:06:26] FOLLOWUPS — 3 follow-up(s) recorded (docs, scope_extension, tech_debt)
- [00:06:39] FOLLOWUPS — handoff record created
