# Brief — Better worktree name template

## Goal

Worktree directory names should carry a date prefix so multiple runs on the
same brief don't collide and a glance at `worktrees/` tells you when each
run was started. Match the existing `LOCAL_worktrees/<YYYYMM>_<branch>/`
convention this repo already uses, scaled down to per-run granularity.

## Acceptance criteria

- AC-1: `make_worktree_path(cfg, repo_name, worktree_name)` returns a path
  whose last segment is `<YYYYMMDD>__<worktree_name>`.
- AC-2: The date is the run's creation date (`run_id` already carries it
  as a `YYYY-MM-DD` prefix; we reuse that source of truth).
- AC-3: `branch_name` continues to be `agent/<worktree_name>` — branches
  do NOT get the date prefix (avoids long branch names; matches existing
  policy).
- AC-4: Existing in-flight runs (created before this change) keep their
  pre-change worktree paths. No retroactive renames.
- AC-5: Unit tests for `lib/run_ids.py` cover the new behavior directly.
- AC-6: Integration test confirms a fresh `new-run` + `start` puts the
  worktree at a path containing today's `YYYYMMDD`.

## Non-goals

- Changing `run_id` format (already `YYYY-MM-DD-<slug>`).
- Changing `branch_prefix` (stays `agent/`).
- Migrating existing runs.

## Risks

- The `worktree_name_template` field in `agent-workbench.yaml` is currently
  unused by the code (it's read but never substituted). Leaving it
  declarative is fine; we'll update the value for documentation purposes.

## Files likely to change

- agent-workbench-live/lib/run_ids.py
- agent-workbench-live/agent-workbench.yaml
- agent-workbench-live/tests/test_integration.py
