# Human review — 2026-05-22-bounce-snap

## Files

- **Brief** — [brief.md](<RUN_ROOT>/stages/2_shaping/brief.md)
- **Plan** — [plan.md](<RUN_ROOT>/stages/3_planning/plan.md)
- **Build (diffs + AC coverage)** — [build.md](<RUN_ROOT>/stages/4_building/build.md)
- **QA report** — [report.md](<RUN_ROOT>/stages/5_validating/qa/report.md)
- **Review decision** — [review.md](<RUN_ROOT>/stages/5_validating/review.md)
- **Audit** — [audit.md](<RUN_ROOT>/audit.md)

## Summary of changes

- Added the missing `echo "goodbye, world"` line to the case arm.
- 1 file(s) touched: bin/cli
- AC coverage: 1/1 covered

→ Full diff: `<RUN_ROOT>/stages/4_building/build.md`

## Testing

**Unit tests**

`python -m pytest tests/ -q`

```
Subcommand prints `goodbye, world` and exits 0. AC-1 passes.
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

Review decision: **approve**.

Full QA report:

`<RUN_ROOT>/stages/5_validating/qa/report.md`

## Run timeline

- [<HH:MM:SS>] SHAPING — entered shaping
- [<HH:MM:SS>] PLANNING — entered planning
- [<HH:MM:SS>] PLANNING — assumption ASM-001: Bash is available.
- [<HH:MM:SS>] PLANNING — decision DR-001: Dispatch case statement.
- [<HH:MM:SS>] READY — entered ready
- [<HH:MM:SS>] BUILDING — worktree at `<TMP>/worktrees/<TEST_REPO>/20260522__bounce-snap` on `agent/bounce-snap`
- [<HH:MM:SS>] BUILDING — worktree on `agent/bounce-snap` at `<TMP>/worktrees/<TEST_REPO>/20260522__bounce-snap`
- [<HH:MM:SS>] VALIDATING — entered validating
- [<HH:MM:SS>] VALIDATING — scope creep: none
- [<HH:MM:SS>] VALIDATING — review decision: request_changes
- [<HH:MM:SS>] VALIDATING — tests_passed=false; known_issues=1
- [<HH:MM:SS>] FOLLOWUPS — entered followups
- [<HH:MM:SS>] FOLLOWUPS — 1 follow-up(s) recorded (bug_risk)
- [<HH:MM:SS>] FOLLOWUPS — handoff record created
- [<HH:MM:SS>] HUMAN_REVIEW — handed off
- [<HH:MM:SS>] BUILDING — bounced — AC-1 not covered
- [<HH:MM:SS>] BUILDING — bounce requested — AC-1 not covered
- [<HH:MM:SS>] VALIDATING — entered validating
- [<HH:MM:SS>] VALIDATING — scope creep: none
- [<HH:MM:SS>] VALIDATING — review decision: approve
- [<HH:MM:SS>] VALIDATING — tests_passed=true; known_issues=0
- [<HH:MM:SS>] FOLLOWUPS — entered followups
- [<HH:MM:SS>] FOLLOWUPS — 1 follow-up(s) recorded (no_followups)
- [<HH:MM:SS>] FOLLOWUPS — handoff record created
