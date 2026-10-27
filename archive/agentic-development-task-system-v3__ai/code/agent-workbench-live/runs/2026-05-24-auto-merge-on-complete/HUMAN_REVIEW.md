# Human review — 2026-05-24-auto-merge-on-complete

## Files

- **Brief** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/stages/2_shaping/brief.md`
- **Plan** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/stages/4_building/build.md`
- **QA report** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/stages/5_validating/qa/report.md`
- **Review decision** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/stages/5_validating/review.md`
- **Audit** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/audit.md`

## Summary of changes

- 13 file(s) touched:
  - ``agent-workbench-live/lib/repos.py` — added `MergeConflictError`, `worktree_is_clean`, `worktree_dirty_files`, `current_branch`, `resolve_parent_branch`, `merge_no_ff`. All git logic lives behind this module; `cmd_complete` is a thin orchestrator.`
  - ``agent-workbench-live/lib/cli/cmd_complete.py` — rewritten. Pre-flights the worktree, calls `merge_no_ff` inside the per-run lock, emits `WorktreeMerged` on success / `MergeConflict` on failure. Adds `--no-merge` escape hatch + keeps `--completion-ref` override.`
  - ``agent-workbench-live/schemas/events.jsonl` — appended `WorktreeMerged` and `MergeConflict` schema entries.`
  - ``agent-workbench-live/lib/board/source.py` — `RunSnapshot.completion_ref: str | None` carries the raw label from `metadata.completion`.`
  - ``agent-workbench-live/lib/board/app.py` — `done` cards print `⚠ unmerged (completion_ref is a label, not a merge SHA)` when `completion_ref` starts with `local-branch:`.`
  - ``agent-workbench-live/.claude/commands/complete.md` — pre-flight one-liner + failure-mode docs (dirty worktree, conflict, detached HEAD) + escape-hatch flags.`
  - ``docs/lifecycle.md` — `done` section rewritten: lists the new pre-flight + merge steps, `--no-merge` / `--completion-ref` escape hatches, and clarifies that `done` now means accepted **and** merged.`
  - ``agent-workbench-live/tools/backfill_completion_refs.py` — one-shot script (run once, idempotent on re-run) that rewrites the three orphan runs' `completion_ref` from `local-branch:<branch>` to `merge:<full-sha>` (`c6357454…`, `a02dd167…`, `271ab584…`).`
  - …and 5 more
- 2 doc(s) touched:
  - ``docs/lifecycle.md` — `done` section rewritten to reflect Option A (accepted **and** merged; new pre-flight + failure-mode + escape-hatch sections).`
  - ``agent-workbench-live/.claude/commands/complete.md` — pre-flight one-liner + failure-mode docs + `--no-merge` / `--completion-ref` escape hatches.`

→ Full diff: `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/stages/4_building/build.md`

## Testing

**Unit tests**

`PYTHONPATH=$AW python -m unittest tests.test_repos -v`

```
- **tests_passed**: true
- **known_issues_count**: 0
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

Review decision: **approve**.

Full QA report:

`/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-24-auto-merge-on-complete/stages/5_validating/qa/report.md`

## Run timeline

- [19:03:33] SHAPING — entered shaping
- [19:04:31] PLANNING — entered planning
- [19:10:35] PLANNING — assumption ASM-001: The three orphan runs' merge SHAs (`c635745`, `a02dd16`, `271ab58`) are full prefixes of commits that exist on the v3 monorepo's `master` branch.
- [19:10:35] PLANNING — assumption ASM-002: All current `done` runs were authored via the workbench's `cmd_complete`, so their `completion_ref` starts with `local-branch:` (the default in today's code).
- [19:10:35] PLANNING — assumption ASM-003: The user wants the parent branch's HEAD restored after a successful merge (i.e. they'll do `git push` themselves and probably want to be back on their working …
- [19:10:35] PLANNING — assumption ASM-004: The merge runs in the **target repo** (`metadata.target.repo.path`), not in the worktree. The worktree's HEAD is on the feature branch; switching the worktree …
- [19:10:35] PLANNING — decision DR-001: Emit `WorktreeMerged` and `MergeConflict` from `cmd_complete` directly via `lib/events.append`, NOT through the transition engine's `emits:` list.
- [19:10:35] PLANNING — decision DR-002: Run the merge inside the per-run lock, but allow the merge to mutate the target repo's checked-out branch as a side effect. Restore the original branch with `g…
- [19:10:35] PLANNING — decision DR-003: Pin `--no-ff` for the merge strategy. Do not make the strategy configurable in this run.
- [19:10:35] PLANNING — decision DR-004: The backfill is a one-shot script in `tools/`, NOT a CLI subcommand.
- [19:10:35] PLANNING — decision DR-005: On the conflict path, leave the parent branch checked out in the target repo as-is *after* `git merge --abort`. Do not auto-restore the user's original branch …
- [19:10:35] READY — entered ready
- [19:10:43] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260524__auto-merge-on-complete` on `agent/auto-merge-on-complete`
- [19:10:43] BUILDING — worktree on `agent/auto-merge-on-complete` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260524__auto-merge-on-complete`
- [19:24:55] VALIDATING — entered validating
- [19:29:06] VALIDATING — doc claims: 2 unverified
- [19:29:06] VALIDATING — review decision: approve
- [19:29:06] VALIDATING — tests_passed=true; known_issues=0
- [19:29:06] FOLLOWUPS — entered followups
- [19:30:05] FOLLOWUPS — 5 follow-up(s) recorded (bug_risk, docs, refactor, scope_extension, tech_debt)
- [19:30:06] FOLLOWUPS — handoff record created
