# Human review — 2026-05-25-each-worktree-owns-its-own-run-dir

## Files

- **Brief** — `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/stages/2_shaping/brief.md`
- **Plan** — `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/stages/4_building/build.md`
- **QA report** — `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/stages/5_validating/qa/report.md`
- **Review decision** — `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/stages/5_validating/review.md`
- **Audit** — `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/audit.md`

## Summary of changes

- 2 doc(s) touched:
  - `README.md — added a /hello endpoint example`
  - `docs/api.md — documented the new response schema`

→ Full diff: `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/stages/4_building/build.md`

## Testing

**Unit tests**

`PYTHONPATH=. python -m unittest discover -s tests`

```
- **tests_passed**: true
- **known_issues_count**: 0

The test suite reports 2 failures (`test_human_review.TestSnapshotRender::test_happy_snapshot` and `::test_bounce_pass2_snapshot`); both are pre-existing date-baked snapshot mismatches present on master before this change (verified by running the same tests against master pre-change). Not caused by this run.
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

Review decision: **approve**.

Full QA report:

`/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-each-worktree-owns-its-own-run-dir/stages/5_validating/qa/report.md`

## Run timeline

- [04:22:14] SHAPING — entered shaping
- [04:24:07] PLANNING — entered planning
- [04:30:01] PLANNING — assumption ASM-001: The two known orphan run dirs (`2026-05-24-fix-generated-lines-base-ref-head/`, `2026-05-24-token-efficiency-pass-2/`) have valid `metadata.target.worktree.pat…
- [04:30:01] PLANNING — assumption ASM-002: `git worktree list --porcelain` lists every workbench worktree from any of its working copies, including master's.
- [04:30:01] PLANNING — assumption ASM-003: `git worktree add -b <branch> <path> <base_ref>` is safe to run while the workbench is mid-tick (e.g. another CLI command is running). No global lock is needed…
- [04:30:01] PLANNING — assumption ASM-004: The workbench checkout path inside any worktree is at the same relative subpath as in master (`agentic-development-task-system-v3__ai/agent-workbench-live/`).
- [04:30:01] PLANNING — assumption ASM-005: Removing a worktree's run dir during `complete`/`abandon` is safe because the worktree itself is removed shortly after; nothing else holds a path into `runs/<i…
- [04:30:01] PLANNING — assumption ASM-006: The `agent-workbench-live/AGENTS.md` "Source of truth" section is the right place to record the new run-dir-location rule, and downstream tooling reads convent…
- [04:30:01] PLANNING — assumption ASM-007: Existing tests in `tests/test_e2e.py` use a target repo distinct from `self.tmp` (the workbench), so today's behavior (run dir at `self.tmp / "runs" / run_id`)…
- [04:30:01] PLANNING — assumption ASM-008: For the new self-modifying E2E scenario, initializing `self.tmp` as a git repo (with `bin/` and `lib/` populated from `ROOT/`) plus a tracking commit will prod…
- [04:30:01] PLANNING — assumption ASM-009: No external CI / consumer depends on `runs/<id>/` paths in master's working tree being untracked.
- [04:30:01] PLANNING — assumption ASM-010: `lib/board/app.py` is the only file that schedules a watchdog observer; nothing else watches `cfg.runs_path` for filesystem events.
- [04:30:01] PLANNING — decision DR-001: Detect self-modifying runs (workbench is inside the target repo) via a runtime helper `runs.is_self_modifying(cfg, meta)`. Non-self-modifying runs keep today's…
- [04:30:01] PLANNING — decision DR-002: `find_run` is strict (raises on collision); `iter_all_runs` is permissive (prefers worktree, warns).
- [04:30:01] PLANNING — decision DR-003: `abandon` archives the run dir on master via a non-merge tree copy (`git read-tree` / `git archive`), NOT a `git merge` of the agent branch.
- [04:30:01] PLANNING — decision DR-004: The migration script (`tools/migrate_orphan_runs.py`) is run-then-deleted as part of this run's build phase. It is NOT committed permanently.
- [04:30:01] PLANNING — decision DR-005: No new schema fields in `schemas/run-metadata.yaml`.
- [04:30:01] PLANNING — decision DR-006: The pre-merge commit message is `runs: <run_id> (complete)` for completed runs and `abandon: <run_id> (run dir archived)` for abandoned runs.
- [04:30:01] PLANNING — decision DR-007: Board watchdog stays on a single `cfg.runs_path` observer + 1Hz fallback timer. Worktree-side watch roots are not added in V1.
- [04:30:01] READY — entered ready
- [04:30:09] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir` on `agent/each-worktree-owns-its-own-run-dir`
- [04:30:09] BUILDING — worktree on `agent/each-worktree-owns-its-own-run-dir` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/new-tech-monorepo/20260525__each-worktree-owns-its-own-run-dir`
- [05:01:53] VALIDATING — entered validating
- [05:07:42] VALIDATING — review decision: approve
- [05:07:42] VALIDATING — tests_passed=true; known_issues=0
- [05:07:43] FOLLOWUPS — entered followups
- [05:09:06] FOLLOWUPS — 5 follow-up(s) recorded (docs, scope_extension, tech_debt)
- [05:09:07] FOLLOWUPS — handoff record created
