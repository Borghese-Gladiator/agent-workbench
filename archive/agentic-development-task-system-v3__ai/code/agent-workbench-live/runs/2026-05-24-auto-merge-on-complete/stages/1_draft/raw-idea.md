# Auto-merge worktree branch on `human_review → done`

Today, `agent-workbench complete <id>` (which performs `human_review → done`) only:

1. writes a `TransitionApplied` event,
2. records `completion_ref = local-branch:<branch_name>` as a label in `metadata.completion`,
3. prints "done".

It never runs `git merge`, `git push`, or touches the worktree. As a result, "done" runs can ship without their deliverables ever landing on the parent branch — three runs (`2026-05-22-context-graph`, `2026-05-22-audit-unit-tests-for-duplication`, `2026-05-22-token-efficiency-tracking`) were left orphaned on per-run worktree branches before being cleaned up by hand.

We want `human_review → done` to mean both "human signed off" AND "code integrated into the parent branch." Chosen direction is **Option A**: extend `cmd_complete` to auto-merge.

## What `complete` should do

1. Verify the worktree at `metadata.target.worktree.path` is clean (`git status --porcelain` empty). Refuse cleanly otherwise.
2. Resolve the parent branch from `metadata.target.repo.base_ref`. Refuse if not a real branch.
3. Check out the parent branch in the target repo (not the worktree). Fail loudly if checkout isn't safe.
4. Run `git merge --no-ff <worktree_branch>` to create an explicit merge commit.
5. On success, record `completion_ref: merge:<sha>` from `git rev-parse HEAD`.
6. On conflict: `git merge --abort`, emit `MergeConflict` event, leave the run in `human_review`, non-zero exit code.

## What also needs to change

- New event type `WorktreeMerged` emitted on successful merge.
- New event type `MergeConflict` emitted on conflict abort. Both registered in `schemas/events.jsonl`.
- `lib/board/snapshot.py` warns (per-card badge) if any `done` run has `completion_ref` starting with `local-branch:` instead of `merge:`.
- Backfill: rewrite the three orphan runs' `completion_ref` to `merge:<sha>` using the known merge SHAs `c635745`, `a02dd16`, `271ab58`. No retro events.
- `/complete` slash-command help calls out that completing now merges.
- `docs/lifecycle.md` `done` row updated.

## Non-goals

- No auto-push to remote.
- No in-line conflict resolution — abort and bounce the human to manual resolution.
- No change to `abandoned`.
- No rebase/squash strategy — pin `--no-ff` for now.

## Origin

Discovered 2026-05-23 during a worktree audit. Full context lives in `docs/TODO.md` § 1.
