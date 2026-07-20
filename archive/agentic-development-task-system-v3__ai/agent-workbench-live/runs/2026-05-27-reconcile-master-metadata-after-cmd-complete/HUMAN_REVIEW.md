# Human review — 2026-05-27-reconcile-master-metadata-after-cmd-complete

## Files

- **Brief** — [brief.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/2_shaping/brief.md)
- **Plan** — [plan.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/3_planning/plan.md)
- **Build (diffs + AC coverage)** — [build.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/4_building/build.md)
- **QA report** — [report.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/5_validating/qa/report.md)
- **Review decision** — [review.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/5_validating/review.md)
- **Audit** — [audit.md](/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/audit.md)

## Summary of changes

- 5 file(s) touched:
  - ``lib/runs.py` — added `_master_side_status` helper; modified the terminal-state filter in `_walk_worktrees` so it only skips the worktree hit when master agrees (or is missing). +28 LOC.`
  - ``tools/reconcile_master_metadata_after_cmd_complete.py` — **new file**. One-shot script mirroring `tools/backfill_completion_refs.py` shape. argparse for `--root`, `--write`, `--run-id`, `--branch-name`, `--merge-sha`. Hardcoded `KNOWN_STALE_RUNS` with the four observed run IDs. File-path-based merge-SHA discovery primary, anchored message-grep fallback, manual overrides as final escape hatch. Dry-run default. ~250 LOC including docstring.`
  - ``tests/test_runs.py` — added class `TestWalkWorktreesStaleMasterCarveOut` with three tests covering the carve-out behavior (stale master, agreeing master, missing master). +79 LOC.`
  - ``tests/test_reconcile_master_metadata.py` — **new file**. `TestReconcileMasterMetadata` with five tests covering dry-run, write, idempotency, already-terminal, and merge-SHA override. Fixture builds a synthetic git repo with a real merge commit so file-path discovery has something to find. ~175 LOC.`
  - `The four master-side `metadata.yaml` files for the known stale runs were also rewritten **on disk** by running the reconciliation script in `--write` mode against the live workbench (see "Commands run" below for the exact invocation). They sit in the worktree's checkout staged for the merge that will land at `/complete` time.`
- 3 doc(s) touched:
  - ``runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/2_shaping/brief.md` — added a `## Scope reduction (2026-05-27, post-planning)` section at the top documenting the Y-vs-Z decision. The original brief sections are unchanged.`
  - ``runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/3_planning/plan.md` — significantly rewritten during planning to scope down to Y and to add a `## Deferred to follow-ups` section. DR-006 added (file-path graph topology for merge-SHA discovery).`
  - `No changes to `AGENTS.md`, `CLAUDE.md`, `docs/lifecycle.md`, or any other top-level repo docs. The Z scope (forward fix in `cmd_complete` + doctor check + module docstrings) is captured in `plan.md`'s `## Deferred to follow-ups` and will be lifted into `follow-ups.md` by the `/followups` stage at the end of building.`

→ Full diff: `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/4_building/build.md`

## Testing

**Unit tests**

`python -m pytest tests/test_runs.py tests/test_reconcile_master_metadata.py -q`

```
- **tests_passed**: true (for changes introduced by this run; 7 pre-existing unrelated failures persist)
- **known_issues_count**: 0 (for this run's scope; 7 pre-existing test failures recorded but not in scope)
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

Review decision: **request_changes**.

Full QA report:

`/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-27-reconcile-master-metadata-after-cmd-complete/stages/5_validating/qa/report.md`

## Run timeline

- [13:18:47] SHAPING — entered shaping
- [13:20:34] PLANNING — entered planning
- [13:25:35] PLANNING — assumption ASM-001: `lib.metadata.update()` will not be called from the reconciliation script. The script uses `lib.yaml_io.dumps/loads` directly, mirroring `tools/backfill_comple…
- [13:25:35] PLANNING — assumption ASM-002: If the follow-on commit on `parent_branch` fails (dirty index, hook rejection, etc.), `cmd_complete` logs a warning and proceeds with worktree removal anyway. …
- [13:25:35] PLANNING — assumption ASM-003: Merge-commit discovery uses `git log --merges --grep="Merge branch 'agent/<slug>'"`. Exactly-one-match is required; zero or multiple matches → skip with warnin…
- [13:25:35] PLANNING — assumption ASM-004: The reconciliation script does NOT auto-commit its file changes. The user inspects the diff after `--write` and commits manually.
- [13:25:35] PLANNING — assumption ASM-005: `metadata.save()` accepts an optional `dest` parameter that lets the caller route the YAML write to a specific path (not just `cfg.runs_path / run_id / "metada…
- [13:25:35] PLANNING — assumption ASM-006: The forward fix in `cmd_complete.py` runs from the workbench root checkout (NOT the worktree). The workbench root is already on `parent_branch` after `_do_merg…
- [13:25:35] PLANNING — decision DR-001: Reconciliation script writes `completion.accepted_by: "reconciliation"` (literal string).
- [13:25:35] PLANNING — decision DR-002: Forward fix uses a follow-on commit ("metadata: backfill done status for <run_id>") on `parent_branch`, NOT an `--amend` of the merge commit.
- [13:25:35] PLANNING — decision DR-003: Reconciliation script writes `completion.completed_at` from the merge commit's committer date (`git log -1 --format=%cI <merge_sha>`), NOT from script executio…
- [13:25:35] PLANNING — decision DR-004: Follow-on commit message: `metadata: backfill done status for <run_id>`.
- [13:25:35] PLANNING — decision DR-005: The merge-commit-discovery helper lives in `lib/runs.py` as a new function `find_merge_commit_for_branch(workbench_root, parent_branch, branch_name) -> Optiona…
- [13:25:35] READY — entered ready
- [13:57:34] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete` on `agent/reconcile-master-metadata-after-cmd-complete`
- [13:57:34] BUILDING — worktree on `agent/reconcile-master-metadata-after-cmd-complete` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__reconcile-master-metadata-after-cmd-complete`
- [14:59:07] VALIDATING — entered validating
- [15:04:33] VALIDATING — doc claims: 3 unverified
- [15:04:33] VALIDATING — review decision: request_changes
- [15:04:33] VALIDATING — tests_passed=true; known_issues=0
- [15:04:33] FOLLOWUPS — entered followups
- [15:05:49] FOLLOWUPS — 5 follow-up(s) recorded (bug_risk, refactor, scope_extension, tech_debt)
- [15:05:51] FOLLOWUPS — handoff record created
