# Implementation plan

## Current repo understanding

The workbench's lifecycle is implemented as a transition engine (`agent-workbench-live/lib/transitions.py`) reading a static rule set from `schemas/transitions.yaml`. Only `lib/transitions.transition(...)` writes `status`; commands acquire a per-run lock (`lib/locks.acquire`) before calling it. Each transition appends a `TransitionApplied` event and zero or more secondary events declared in the rule's `emits:` list. Secondary-event payloads are mapped from the evidence dict by `transitions._secondary_payload`.

`human_review → done` is implemented by `lib/cli/cmd_complete.py` (71 lines). It currently:

1. Validates state is `human_review`, validates `audit.md` exists.
2. Derives `completion_ref = args.completion_ref or f"local-branch:{branch_name}"`.
3. Acquires the per-run lock and calls `transitions.transition(cfg, run_id, "done", evidence={accepted_by, completion_ref, audit_path}, actor)`.
4. Mutates `metadata.completion` with `accepted_by` / `completion_ref` / `completed_at`.
5. Best-effort `metrics_writer.record_run_metrics`.
6. Prints two lines: `{run_id}: human_review -> done` and `completion_ref: …`.

Nothing about this flow touches git. The string `local-branch:<branch_name>` is a *label* — not a merge SHA. Three runs landed in `status: done` while their deliverables remained on per-run worktree branches; the gap is now TODO §1, and Option A — extend `cmd_complete` to perform the merge — has been picked.

Git operations elsewhere in the workbench go through `lib/repos.py`, which centralizes the `git -C <repo_path> …` pattern via two helpers: `_git(...)` (capture-and-return) and `_git_strict(...)` (raise `RepoError` on non-zero). All git invocations use `-C`; we never `cd`. `create_worktree` (lines 98-115) is the closest analogue to what I need — it composes the command from a path, an args list, and checks `branch_exists` / path existence first.

Events are validated against `schemas/events.jsonl` before they hit disk: `lib/events.append(...)` looks up the event's `payload_required` keys and rejects writes missing any. So adding `WorktreeMerged` / `MergeConflict` means adding two lines to that file.

The board's per-run snapshot (`lib/board/source.RunSnapshot`) does NOT currently carry `completion_ref` — `_load_run_snapshot()` extracts only `completion.completed_at`, `completion.accepted_by`, and `completion.abandoned_reason`. The badge work therefore needs a small extension to `RunSnapshot` + its constructor, then a one-line check in `lib/board/app.py` where `run.status == "done"` is rendered (lines 327-332).

`docs/lifecycle.md`'s `done` section already names Option A as the chosen direction (lines 545-583), so the doc update is a copy-edit, not a rewrite.

## Relevant files

- `agent-workbench-live/lib/cli/cmd_complete.py` — main target. The merge logic, the conflict abort, the metadata-write order, and the print output all live here.
- `agent-workbench-live/lib/repos.py` — host for the new `merge_no_ff(repo_path, branch, message=...)` helper. Returns merge SHA on success; raises a typed conflict error on conflict (after running `git merge --abort`).
- `agent-workbench-live/schemas/events.jsonl` — add `WorktreeMerged` and `MergeConflict` schema lines.
- `agent-workbench-live/lib/transitions.py` — extend `_secondary_payload` to map evidence for `WorktreeMerged` *if* I decide to emit it as a transition-secondary event. **Decision (see DR-001)**: emit `WorktreeMerged` and `MergeConflict` from `cmd_complete` directly via `lib/events.append`, NOT through the transition engine. That keeps the transition rule (`emits: [TransitionApplied, RunCompleted]`) untouched and avoids the conflict-path needing a fake "rejected" event.
- `agent-workbench-live/lib/board/source.py` — extend `RunSnapshot` with a `completion_ref: str | None` field and populate it in `_load_run_snapshot()`.
- `agent-workbench-live/lib/board/app.py` — append a `⚠ unmerged` badge when `run.status == "done"` and `run.completion_ref` starts with `local-branch:`.
- `agent-workbench-live/.claude/commands/complete.md` — surface the new pre-flight + the merge behavior.
- `docs/lifecycle.md` — rewrite the `done` section's "What `cmd_complete` does / does NOT do" so it matches the post-merge reality.
- `agent-workbench-live/runs/2026-05-22-context-graph/metadata.yaml`, `…/2026-05-22-audit-unit-tests-for-duplication/metadata.yaml`, `…/2026-05-22-token-efficiency-tracking/metadata.yaml` — backfill `completion.completion_ref` to `merge:<sha>` using the known merge SHAs.
- `agent-workbench-live/tests/test_e2e.py` — already exercises the happy path (lines 134-217). Either extend it to assert `completion_ref` matches `merge:<sha>` post-complete, or add a new TestE2EComplete merge-specific class.
- `agent-workbench-live/tests/test_transitions.py` — covers `transition` evidence shape; one new test for "dirty worktree blocks complete" since the gate now lives in `cmd_complete` rather than the transition engine.
- `agent-workbench-live/tests/test_board_snapshot.py` — add a test that constructs a `done` run with `local-branch:` completion_ref and asserts the badge string.

## Proposed changes

1. **Add `lib/repos.merge_no_ff(repo_path, parent_branch, worktree_branch, *, message=None) -> str`.** Resolves the parent-branch checkout (refusing if the parent repo's working tree is dirty), runs `git merge --no-ff <worktree_branch>` against the checked-out parent branch, captures `git rev-parse HEAD` on success, runs `git merge --abort` + raises `MergeConflictError(conflicted_files)` on failure. Returns the new merge SHA. The helper is the only new piece of git logic; everything else in `cmd_complete` calls into it.

2. **Add `lib/repos.worktree_is_clean(worktree_path) -> bool`** plus a sister `worktree_dirty_files(worktree_path) -> list[str]`. Uses `git -C <worktree> status --porcelain`; clean = empty stdout. The "dirty files" helper is for the error message.

3. **Rewrite `cmd_complete.run(args)` to follow the six-step Option A flow** (worktree-clean check → resolve parent branch → checkout in target repo → merge --no-ff → success path records `merge:<sha>` and emits `WorktreeMerged` → conflict path aborts and emits `MergeConflict`). The transition call moves to AFTER the merge succeeds, so a failed merge leaves status at `human_review`. Inside the per-run lock, the order is:
    - clean check → parent-branch resolve → checkout parent → merge → record SHA → call `transitions.transition` with `completion_ref="merge:<sha>"` → emit `WorktreeMerged`.

4. **Add two event schemas to `schemas/events.jsonl`** (one line each, appended at the end):
    - `WorktreeMerged`: `payload_required: [worktree_branch, parent_branch, merge_sha, merge_strategy]`.
    - `MergeConflict`: `payload_required: [worktree_branch, parent_branch, conflicted_files]`.

5. **Extend `RunSnapshot` with `completion_ref: str | None`** and populate it in `_load_run_snapshot()`. In `lib/board/app.py`'s `done` branch, render `f"{base_line} ⚠ unmerged"` when `run.completion_ref and run.completion_ref.startswith("local-branch:")`.

6. **Update `.claude/commands/complete.md`** with a one-line pre-flight notice ("This will run `git merge --no-ff` on `<parent_branch>` of `<repo_path>`. Make sure the worktree is committed.") and a "What this now does" bullet list mirroring the new lifecycle.md.

7. **Update `docs/lifecycle.md` § `done`.** The "does NOT" section becomes "does." Refresh the `completion_ref` examples to lead with `merge:<sha>`.

8. **Backfill the three orphan runs.** A one-shot script `tools/backfill_completion_refs.py` (not added to the CLI surface, just a script) rewrites `runs/<id>/metadata.yaml` for the three known runs to `completion_ref: merge:<full_sha>`. Resolves the full SHA via `git rev-parse <short>` against the monorepo. Idempotent — re-running on already-backfilled metadata is a no-op. Run once locally, do NOT emit retro events.

9. **Tests** (see § Test plan below).

## Files likely to change

- `agent-workbench-live/lib/cli/cmd_complete.py`
- `agent-workbench-live/lib/repos.py`
- `agent-workbench-live/schemas/events.jsonl`
- `agent-workbench-live/lib/board/source.py`
- `agent-workbench-live/lib/board/app.py`
- `agent-workbench-live/.claude/commands/complete.md`
- `agent-workbench-live/runs/2026-05-22-context-graph/metadata.yaml`
- `agent-workbench-live/runs/2026-05-22-audit-unit-tests-for-duplication/metadata.yaml`
- `agent-workbench-live/runs/2026-05-22-token-efficiency-tracking/metadata.yaml`
- `agent-workbench-live/tests/test_e2e.py`
- `agent-workbench-live/tests/test_board_snapshot.py`
- `agent-workbench-live/tools/backfill_completion_refs.py` (NEW, one-shot)
- `docs/lifecycle.md`

## Data model changes

None in the strict-schema sense. The shape of `metadata.completion.completion_ref` stays `string | null` — we're tightening the convention (prefix is now `merge:`) but the schema continues to accept the legacy `local-branch:` prefix for backwards compatibility with orphan runs that exist on disk today.

Two new event types in `schemas/events.jsonl`. The board's `RunSnapshot` gets one new field: `completion_ref: str | None`. Both are additive.

## UI changes

The board cards for `done` runs gain a `⚠ unmerged` suffix when `completion_ref` starts with `local-branch:`. No other UI surface changes — the CLI prints one extra line on `complete` (the merge SHA).

## Test plan

- **Unit, `lib/repos.merge_no_ff`:** With a tmp git repo, create two commits on `main`, branch off, commit on the branch, merge — assert the returned SHA matches `git rev-parse HEAD` on `main` and that `git log --merges` shows the merge commit. Conflict case: a conflicting commit on `main`, attempt merge, assert `MergeConflictError` is raised with the right file list AND that `git status --porcelain` is clean afterward (the abort ran).
- **Unit, `lib/repos.worktree_is_clean` + `worktree_dirty_files`:** Tmp repo, no changes → clean. Add an unstaged file → dirty, lists the file. Add a tracked-but-modified file → dirty, lists the file. Stage but don't commit → still dirty.
- **E2E happy-path extension (`tests/test_e2e.py:TestE2EHappyPath`):** After the existing `complete` call (line 190), assert `metadata.completion.completion_ref` matches `merge:[0-9a-f]{40}` AND assert the parent branch's `git log --merges` includes that SHA. Also assert a `WorktreeMerged` event was appended.
- **E2E dirty-worktree refusal (new test):** Drive a run to `human_review`, then write an unstaged file to the worktree, then call `complete`. Assert non-zero exit, status stays `human_review`, error mentions the dirty file.
- **E2E conflict path (new test):** Drive a run to `human_review`, but BEFORE `complete` add a conflicting commit on the parent branch in the target repo. Call `complete`. Assert non-zero exit, status stays `human_review`, a `MergeConflict` event is present in `events.jsonl`, and the parent branch's working tree is clean (abort ran).
- **Board badge (`tests/test_board_snapshot.py`):** Construct a fixture run with `status: done` and `completion.completion_ref: local-branch:agent/foo`. Render the board. Assert the rendered card text contains `unmerged`.
- **Backfill smoke (`tools/backfill_completion_refs.py`):** Run the script against a fixture metadata file; assert `completion_ref` was rewritten and that re-running is a no-op.

## QA plan

Manual smoke test in this real repo (the workbench eating its own dogfood):

1. After implementation lands on `agent/auto-merge-on-complete`, drive *another* throwaway run end-to-end inside a clean tmp repo to verify the merge path runs against a happy graph.
2. Try `complete` on a dirty worktree — confirm the error is human-readable and that no partial state was written.
3. Inspect `agent-workbench board` after the backfill — confirm the three orphan runs no longer show the `unmerged` badge.

## Risks

- **R1 — Order-of-operations between merge and `transitions.transition`.** If the merge succeeds but the transition write fails (e.g. lock contention, disk full), the parent branch will have the merge commit but the run will stay in `human_review`. The recovery is "human inspects the parent branch and re-runs complete" — but a second `complete` would attempt a second merge which would either be a no-op or a conflict. **Mitigation**: call the transition INSIDE the same lock that wrapped the merge, and document the recovery explicitly. Accept the residual risk; it is strictly better than the current state where `done` can mean "not merged."
- **R2 — Parent-branch checkout side-effects on the user's actual workspace.** `cmd_complete` will now check out `master` (or whatever `base_ref` resolves to) in the user's primary clone. If they had a different branch checked out, that changes underfoot. **Mitigation**: refuse if the target repo's `HEAD` is dirty (i.e. `git status --porcelain` non-empty on the target repo, not just the worktree). Always restore the original branch on success, via `git checkout -` — this is symmetrical to how a careful human would run the merge by hand. Document the behavior in `/complete` help.
- **R3 — `base_ref` resolution.** `base_ref` is currently a literal "HEAD" for many runs (the default). We need to resolve it to a branch name. If we can't resolve (e.g. HEAD is detached), refuse. Today, `cmd_start` already calls `git worktree add … <base_ref>` so the same "must be a real ref" rule applies. **Mitigation**: walk through `git symbolic-ref --short HEAD` against the target repo when `base_ref == "HEAD"`, otherwise use `base_ref` as-is. Refuse if neither is a real branch.
- **R4 — The three orphan runs reference target repos that are no longer where the metadata says they were.** All three runs' `target.repo.path` points at `LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai/` — an old v2 worktree. The merges happened in a different repo (the current `agentic-development-task-system-v3__ai/`). **Mitigation**: the backfill is data-only — it rewrites the `completion_ref` string label. It does NOT attempt to re-run the merge or validate that the SHA exists in the target repo. The SHAs are known and provided by the human (`c635745`, `a02dd16`, `271ab58`) from the v3 monorepo's master.

## Definition of done

- `agent-workbench complete <id>` on a happy run merges the worktree branch into the parent and records `completion_ref: merge:<sha>`.
- `complete` on a dirty worktree refuses with a structured error and leaves status at `human_review`.
- `complete` on a conflicting merge runs `git merge --abort`, emits `MergeConflict`, and leaves status at `human_review`.
- `schemas/events.jsonl` carries `WorktreeMerged` + `MergeConflict` entries; both are validated against `payload_required`.
- The board shows a `⚠ unmerged` badge on `done` runs whose `completion_ref` starts with `local-branch:`.
- The three orphan runs (`2026-05-22-context-graph`, `2026-05-22-audit-unit-tests-for-duplication`, `2026-05-22-token-efficiency-tracking`) have `completion_ref: merge:<full-sha>`.
- `/complete` slash command body lists the pre-flight one-liner.
- `docs/lifecycle.md` § `done` describes the integration step.
- New / extended tests pass; existing tests still pass (1 modification to the happy-path E2E; new conflict + dirty-worktree E2E + board-badge + repos unit).

## Preflight

- **Python**: 3.10+, already in use (per project CLAUDE.md, `app` uses 3.10.9; the workbench has no pinned Python beyond what's already in CI). No new dependencies.
- **Subprocess + git**: `git merge --no-ff`, `git merge --abort`, `git rev-parse HEAD`, `git status --porcelain`, `git symbolic-ref --short HEAD`, `git checkout <branch>`, `git checkout -`. All standard, all available on the user's system (already used elsewhere in `lib/repos.py`).
- **Tests harness**: `tests/test_e2e.py` builds throwaway repos via `make_throwaway_repo()` and exercises the CLI via subprocess. The conflict E2E test will need to commit on the parent branch in the throwaway repo before `complete` — the existing fixture infra supports this (just call `git commit` directly via subprocess).
- **No DB / external services touched.**
- **Repo state at start**: clean. `master` ahead of `origin/master` by 2 commits (the initial v3 import).
- **Locking**: per-run lock at `runs/<run_id>/.lock` already exists. No new locking primitive needed.

## Decisions & assumptions

### DR-001
- **Decision**: Emit `WorktreeMerged` and `MergeConflict` from `cmd_complete` directly via `lib/events.append`, NOT through the transition engine's `emits:` list.
- **Rationale**: The transition rule for `human_review → done` already emits `[TransitionApplied, RunCompleted]`. Adding `WorktreeMerged` to that list would mean the engine emits it unconditionally — but on the conflict path, we explicitly do NOT transition. The conflict event therefore has to live outside the rule machinery. Keeping both new events in `cmd_complete` keeps the merge events together and lets the engine stay strictly about state changes.
- **Alternatives considered**: (a) add `WorktreeMerged` to the rule's `emits:` and engineer the engine to skip it conditionally; (b) introduce a new state `merging` so the rule fires `human_review → merging → done` and the secondary events naturally hang off the rule.
- **Why not the alternatives**: (a) is leaky — the engine becomes condition-aware, breaking the clean "rule fires every emit" invariant. (b) adds lifecycle complexity for a transient internal step the human never observes; it would also force every existing run / fixture to be migrated.

### DR-002
- **Decision**: Run the merge inside the per-run lock, but allow the merge to mutate the target repo's checked-out branch as a side effect. Restore the original branch with `git checkout -` after the merge attempt (whether it succeeded or aborted).
- **Rationale**: The merge needs a checked-out parent branch in the target repo (not the worktree, which is on the run's feature branch). Restoring the original branch is symmetrical to what a careful human would do by hand. Per-run lock is fine for serializing within this run; users who run two `complete`s against different runs targeting the same repo simultaneously will still race against each other — but that's already a latent risk in the workbench (two worktrees both think they own the parent branch).
- **Alternatives considered**: (a) require the user to have the parent branch already checked out (refuse otherwise); (b) work entirely in a detached HEAD via `git merge-tree`.
- **Why not the alternatives**: (a) is hostile UX for what should be a one-command operation. (b) is correct theoretically but `git merge-tree`'s output handling is awkward and we'd be reinventing what `git merge` already does.

### DR-003
- **Decision**: Pin `--no-ff` for the merge strategy. Do not make the strategy configurable in this run.
- **Rationale**: `--no-ff` preserves the run's branch history in the parent's log, which matches the lifecycle's emphasis on auditability. Configuring the strategy adds a config knob with no observable user demand yet. The TODO explicitly defers rebase/squash to a future task.
- **Alternatives considered**: (a) default-ff with `--no-ff` opt-in; (b) configurable via `agent-workbench.yaml`.
- **Why not the alternatives**: (a) loses the audit trail for trivially-applicable runs. (b) over-engineers a hypothetical preference.

### DR-004
- **Decision**: The backfill is a one-shot script in `tools/`, NOT a CLI subcommand.
- **Rationale**: The backfill touches exactly three runs and will never need to run again. Adding `agent-workbench backfill-completion-refs` to the CLI surface area would carry a long-tail maintenance cost (help text, tests, documentation) for a one-time operation. A script in `tools/` is discoverable enough for the maintainer and disappears from cognitive load once the three runs are fixed.
- **Alternatives considered**: (a) inline the rewrites as a single git commit with no script; (b) ship a generic `metadata-fix` command.
- **Why not the alternatives**: (a) hides the logic in the commit history. The script is small but auditable. (b) is over-engineering.

### DR-005
- **Decision**: On the conflict path, leave the parent branch checked out in the target repo as-is *after* `git merge --abort`. Do not auto-restore the user's original branch on the conflict path.
- **Rationale**: A merge conflict is a state the human has to resolve. Leaving the parent branch checked out makes the conflict visible (the human is dropped into the right place to inspect or fix). Auto-restoring would hide the fact that the parent's working tree is currently representing the parent's tip (post-abort it is clean) — but at the cost of obscuring the recovery path.
- **Alternatives considered**: Auto-restore in all cases including conflict.
- **Why not the alternatives**: It hides where the human needs to act.

### ASM-001
- **Text**: The three orphan runs' merge SHAs (`c635745`, `a02dd16`, `271ab58`) are full prefixes of commits that exist on the v3 monorepo's `master` branch.
- **Reason**: TODO.md § "Completed work" lists them as merge commits ("merge commits `c635745`+`a02dd16`+`271ab58`") for the orphan-merge cleanup of 2026-05-24.
- **Impact**: medium. If wrong, the backfill writes invalid completion_refs and the user notices on `git rev-parse`. Easily corrected.

### ASM-002
- **Text**: All current `done` runs were authored via the workbench's `cmd_complete`, so their `completion_ref` starts with `local-branch:` (the default in today's code).
- **Reason**: That's the only default path. The CLI accepts `--completion-ref` to override, but no run-author would have done so manually.
- **Impact**: low. Affects only the board badge's "did we backfill all of them" heuristic. If some legacy run carried a different prefix, the badge would simply not trigger for that run — the user can audit by hand.

### ASM-003
- **Text**: The user wants the parent branch's HEAD restored after a successful merge (i.e. they'll do `git push` themselves and probably want to be back on their working branch). On the conflict path, leave the parent branch checked out so they can resolve.
- **Reason**: Matches what a careful operator would do by hand. The success-path symmetry keeps the user's workspace stable; the conflict-path leaves the user where the recovery happens.
- **Impact**: medium. Affects DX, not correctness.

### ASM-004
- **Text**: The merge runs in the **target repo** (`metadata.target.repo.path`), not in the worktree. The worktree's HEAD is on the feature branch; switching the worktree to the parent branch would be incorrect (the worktree is, by git's rules, "checked out on" the feature branch from the target repo's POV, and `git checkout master` in the worktree would fail).
- **Reason**: Git's worktree semantics: a branch can only be checked out in one worktree at a time. The parent branch is normally checked out in the *main* checkout of the repo, which is `target.repo.path`.
- **Impact**: high. If we ran the merge in the wrong directory, it would either fail or produce nonsense.
