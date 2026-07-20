# Brief

## Goal

Close the lifecycle gap where `agent-workbench complete <id>` (the `human_review → done` transition) marks a run as accepted but never integrates the worktree branch into the parent branch. After this work, reaching `done` means BOTH "human signed off" AND "code merged into the parent branch." The lifecycle must make it impossible to silently land in `done` while the deliverables live only on a per-run worktree branch.

This is Option A from `docs/TODO.md` § 1: extend `cmd_complete` to perform the merge as part of the transition, rather than introducing a new `accepted` vs `done` split.

## User-facing behavior

A human who has reviewed a run and is happy with it runs:

```
agent-workbench complete <run_id>
```

(or invokes `/complete <run_id>` in Claude Code). The CLI:

1. Pre-flights the worktree: refuses if the worktree at `metadata.target.worktree.path` has uncommitted changes (`git status --porcelain` non-empty), pointing the human at what to commit or stash.
2. Resolves the parent branch from `metadata.target.repo.base_ref`. Refuses with a clear error if that ref isn't a real branch in the target repo.
3. Checks out the parent branch in the target repo (NOT in the worktree). Refuses cleanly if the target repo's working tree is dirty.
4. Runs `git merge --no-ff <worktree_branch>` against the parent branch, creating an explicit merge commit so the run's history stays visible in the parent's log.
5. On success: captures the new merge SHA via `git rev-parse HEAD`, records `metadata.completion.completion_ref = "merge:<sha>"`, emits a `WorktreeMerged` event, advances `status` to `done`, prints `done` plus the merge SHA.
6. On conflict: runs `git merge --abort`, emits a `MergeConflict` event with the conflicted file list, leaves `status` at `human_review`, returns a non-zero exit code, and tells the human to resolve manually and re-run `complete`.

The `/complete` slash command surfaces a one-line pre-flight warning ahead of the call ("This will run `git merge --no-ff` on `<parent_branch>`. Make sure the worktree is committed.") so the human is not surprised.

The board (`agent-workbench board`) shows a warning badge on any `done` run whose `completion_ref` still starts with `local-branch:` — flagging legacy orphan runs until they're backfilled. After the backfill ships, that count is zero.

## Acceptance criteria

1. **Success path.** Running `complete` on a clean worktree, against a valid parent branch, with a non-conflicting merge: transitions the run to `done` AND records `metadata.completion.completion_ref = "merge:<40-char-sha>"`. The SHA resolves to a real merge commit on the parent branch. `git log --merges` shows the worktree branch's history under that commit.
2. **Dirty worktree refusal.** Running `complete` on a worktree with uncommitted changes: leaves `status` at `human_review`, returns non-zero, prints an error naming the offending files. No event is emitted other than (optionally) a structured rejection note.
3. **Bad base_ref refusal.** If `metadata.target.repo.base_ref` is not a real branch in the target repo (e.g. branch was deleted): refuse cleanly, leave status untouched, explain.
4. **Conflict path.** If the merge produces a conflict: `git merge --abort` runs cleanly, a `MergeConflict` event is appended to `events.jsonl` with `{worktree_branch, parent_branch, conflicted_files: [...]}`, status stays at `human_review`, exit code is non-zero.
5. **New event registered.** `schemas/events.jsonl` documents `WorktreeMerged` and `MergeConflict` with their payloads. The event-validation layer accepts both.
6. **Board warning.** `agent-workbench board` (and `lib/board/snapshot.py` directly) renders a visible badge on any `done` run whose `completion_ref` starts with `local-branch:`.
7. **Backfill complete.** The three orphan runs (`2026-05-22-context-graph`, `2026-05-22-audit-unit-tests-for-duplication`, `2026-05-22-token-efficiency-tracking`) have their `metadata.completion.completion_ref` rewritten to `merge:<sha>` using the known merge SHAs `c635745`, `a02dd16`, `271ab58`. No retroactive `WorktreeMerged` events are emitted for them — the merge happened outside the lifecycle.
8. **Slash command help.** `/complete` calls out the merge behavior explicitly, with a one-line pre-flight statement.
9. **Lifecycle doc.** `docs/lifecycle.md`'s `done` row says `done` means accepted AND merged; `completion_ref` is a merge SHA.
10. **Tests.** Each path above has a focused test. The state-machine tests assert both the event stream and the final `metadata.yaml` shape.

## Non-goals

- **No auto-push to remote.** Merging is local-only. The human pushes themselves if they want.
- **No in-line conflict resolution.** On conflict, we abort and bounce the human back to manual resolution. No new state is added for "conflicted" — the run simply stays in `human_review`.
- **No change to `abandoned`.** Still a clean terminal that never integrated.
- **No rebase / squash-merge strategies.** Pin `--no-ff` for now. A future task can make the merge strategy configurable.
- **No change to how `bounce` works.** Bounce already exists for "human wants changes."
- **No retroactive `WorktreeMerged` events for the three orphan runs.** They were merged outside the lifecycle; emitting events would mis-state what happened.

## Good examples

- A run reaches `human_review` cleanly. The human inspects the diff, is happy, runs `agent-workbench complete <id>`. The CLI checks out `master`, runs `git merge --no-ff agent/<slug>`, prints `done merge:<sha>`, and the parent branch now contains the merge commit.
- A run reaches `human_review`. The human realizes they have an unstaged tweak in the worktree. `complete` refuses, naming the dirty files. The human commits, re-runs `complete`, and it succeeds.
- A run reaches `human_review`. Some unrelated change has happened on `master` since `/start`, and the merge produces a conflict. `complete` aborts the merge, records `MergeConflict`, leaves the run in `human_review`, and the human resolves manually before re-running.

## Bad examples

- `complete` swallows a merge failure and still marks the run `done`. (Hard requirement: that must not happen.)
- `complete` rewrites the run's worktree branch (e.g. via rebase) silently. (No — `--no-ff` only.)
- `complete` pushes to a remote. (No — local only.)
- `complete` attempts to fix conflicts by re-trying or by resetting state. (No — abort and surface to the human.)
- The three orphan runs are rewritten in a way that mints fake `WorktreeMerged` events. (No — backfill the label only.)

## Constraints

- The merge runs INSIDE the per-run lock so a concurrent `bounce` or `abandon` cannot race it.
- `completion_ref` schema is preserved: it remains a string, just with a `merge:` prefix instead of `local-branch:`.
- No new lifecycle state. `done` continues to be terminal.
- The CLI must be idempotent on the success path within a transaction sense: if the merge succeeds but the metadata write fails, the merge commit still exists on the parent branch (acceptable; humans can recover by inspecting the parent branch). Conversely, the metadata write should not happen if the merge does not succeed.
- The `lib/transitions.transition` engine remains the only writer of `status`. The merge logic in `cmd_complete` performs the side effect, then calls into the transition engine to record the move.

## Assumptions

- The target repo's parent branch checkout is safe to perform on the user's local machine. The CLI refuses if it is not (e.g. parent repo has a dirty index).
- Three orphan runs are exactly: `2026-05-22-context-graph` (merge `c635745`), `2026-05-22-audit-unit-tests-for-duplication` (merge `a02dd16`), `2026-05-22-token-efficiency-tracking` (merge `271ab58`). These SHAs match the merge commits on `master` recorded in TODO.md § "Completed work."
- All current runs use `--no-ff` semantics; no run currently in flight expects squash or rebase.

## Suggested QA scenarios

1. **Happy path.** Create a tmp git repo, run `new-run` → `shape` → `plan` → `start` → make a commit on the worktree → `validate` → `followups` → `complete`. Assert `metadata.completion.completion_ref` matches `merge:[0-9a-f]{40}`. Assert `git log --merges` on parent branch shows the merge.
2. **Dirty worktree refusal.** Same setup, but leave an unstaged file in the worktree before `complete`. Assert non-zero exit, status stays `human_review`.
3. **Conflict.** Same setup, but BEFORE `complete`, make a conflicting commit directly on `master`. Run `complete`. Assert `git merge --abort` ran, `MergeConflict` event present, status stays `human_review`.
4. **Backfill.** Inspect `runs/2026-05-22-context-graph/metadata.yaml` (and the other two) after backfill — assert `completion_ref` matches `merge:c635745...`, etc.
5. **Board badge.** Construct a fixture run whose `metadata.completion.completion_ref` starts with `local-branch:`. Render the board. Assert the warning badge is present.
6. **/complete slash command.** Open `.claude/commands/complete.md` and verify the pre-flight statement names the merge behavior.
