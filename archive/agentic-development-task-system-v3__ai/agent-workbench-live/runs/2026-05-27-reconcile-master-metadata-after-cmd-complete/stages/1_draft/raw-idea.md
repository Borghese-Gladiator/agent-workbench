> Extracted from `docs/TODO.md` §1 on 2026-05-27.

## 1. Reconcile master-side `metadata.yaml` after `cmd_complete` — kill the stale-`human_review` ghosts

### Symptom

`agent-workbench list` and `agent-workbench board` disagree on the status of runs that have already been merged and marked `done`. For self-modifying runs whose worktree is still on disk, the *worktree-side* `runs/<id>/metadata.yaml` carries the correct post-merge `status: done`, but the *master-side* `runs/<id>/metadata.yaml` is still frozen at `status: human_review` — `cmd_complete` updates only the worktree copy. Both copies coexist because the run dir is a tracked file inside each worktree's checkout.

Concrete pair observed 2026-05-27, both already merged into master:

| Run | master copy | worktree copy | `list` shows | `board` shows |
|---|---|---|---|---|
| `2026-05-25-generalize-stage-context-md` | `human_review` (stale) | `done` (post-merge) | `done` | `human_review` |
| `2026-05-26-board-freshness-across-worktrees` | `human_review` (stale) | `done` (post-merge) | `done` | `human_review` |

Both `list` and `board` traverse the same `iter_all_runs` enumerator, but they apply opposite preferences when the same run resolves to two on-disk copies:

- **`list` (`lib/cli/cmd_list_runs.py:18-20`)** takes the deduplicated run IDs, then re-reads metadata via `metadata.load(cfg, rid)`. `metadata.run_dir` resolves to the worktree copy whenever both exist and the worktree is live (`lib/metadata.py:60-90` → `lib/runs.py:175-198`). The worktree copy says `done`, so `list` prints `done`.
- **`board` (`lib/board/snapshot.py:76-92`)** uses the `Run` objects from `iter_all_runs` directly. `_walk_worktrees` (`lib/runs.py:278-310`) filters out any *worktree* hit whose status is `done` / `abandoned` — treating them as "merged history that happens to be checked out here, NOT live work." The worktree hit is discarded, the master hit (still `human_review`) survives, board shows `human_review`.

The board's filter is right on its own terms; the bug is upstream — the master-side metadata should never be `human_review` for a run that has been completed. Right now the only thing that flips master's copy to `done` is the merge commit itself (the worktree's `done` write is the file that gets merged onto master). For self-modifying runs `cmd_complete` (commit `77a5a13`) does a `git merge --no-ff` followed by an immediate `git worktree remove` + `git branch -D`, but the worktree-side `metadata.yaml` write happened *before* the merge — so master ends up with whichever status the worktree had at the moment of the merge SHA, which for the observed runs was a pre-`done` state.

### Confirmed root cause

`lib/cli/cmd_complete.py`'s self-modifying path writes the worktree-side `metadata.yaml` first (sets `status: done`, populates `completion.accepted_by` / `completion.completion_ref` / `completion.completed_at`), then merges. The merge commit *should* carry that updated file onto master. For the two observed runs, it didn't — likely the worktree-side write landed in a later commit on the branch that wasn't part of the merge ref, or the merge was a fast-forward that picked up an older tree. Either way, master's copy is stale and the workbench has no reconciliation path: nothing in the lifecycle ever rewrites `runs/<id>/metadata.yaml` from master's side after the merge.

Three runs on disk currently sit in this inconsistent state — the two above plus `2026-05-25-each-worktree-owns-its-own-run-dir` and `2026-05-25-lifecycle-papercuts-lock-ready-banner` for which the underlying changes are already merged but the master-side `metadata.yaml` is still `human_review` (these surfaced when comparing `git log --oneline master | grep "Merge branch 'agent/"` against the four-strong `human_review` column in the board).

### Tasks

- [ ] **Decide the canonical fix point.** Two candidates:
  - (a) `cmd_complete.py` writes the post-merge `metadata.yaml` directly into the *master* checkout after the merge succeeds (e.g. an extra `git add runs/<id>/metadata.yaml` + amend, or a follow-up commit `metadata: backfill done status for <run_id>`). This guarantees master's copy matches worktree's `done`.
  - (b) `_walk_worktrees`'s "drop terminal-state worktree hits" filter is loosened to "drop terminal-state worktree hits *only if the master copy is also terminal*; otherwise prefer the worktree copy and emit a warning." Cheaper, but leaves the on-disk inconsistency in place.
  - (c) Master-side `metadata.yaml` becomes purely derived (e.g. write a `STATUS.txt` or `.status` sentinel at `cmd_complete` time and have the renderer prefer it). Largest change.
  - Pick (a) unless friction surfaces — it keeps `metadata.yaml` the single source of truth and avoids divergence between enumerators.
- [ ] **Write a one-shot reconciliation script** (`tools/reconcile_master_metadata.py` or a `doctor --fix-stale-done` mode) that walks `runs/<id>/metadata.yaml` on master, detects any run whose status is `human_review` / `building` / `validating` / `followups` but whose branch is already merged into the current `HEAD`, and rewrites the master-side metadata to `done` with `completion.accepted_by`, `completion.completion_ref` (the merge SHA), and `completion.completed_at` populated from the merge commit's author + date. Dry-run by default; `--write` to apply.
- [ ] **Backfill the four observed stale runs.** Run the reconciliation against `2026-05-25-generalize-stage-context-md`, `2026-05-26-board-freshness-across-worktrees`, `2026-05-25-each-worktree-owns-its-own-run-dir`, `2026-05-25-lifecycle-papercuts-lock-ready-banner`. Verify `list` and `board` agree afterwards.
- [ ] **Add a `doctor` check** that flags any run whose master-side status is non-terminal but whose branch is already merged into the workbench's root branch (or whose worktree has been removed). One-line warning per offending run with the merge SHA. Doctor doesn't auto-fix — the reconciliation script does.
- [ ] **Unit tests for the chosen fix.** If (a): a test that drives `cmd_complete` end-to-end on a self-modifying synthetic workbench and asserts that after the merge, `git show master:runs/<id>/metadata.yaml` reports `status: done`. If (b): a test where the worktree copy is `done` and the master copy is `human_review` and `iter_all_runs` yields the `done` hit (the opposite of today's behavior). Place under `tests/test_runs.py` or a new `tests/test_self_modifying_complete.py`.
- [ ] **Document the invariant** in `lib/runs.py`'s `_walk_worktrees` and `lib/cli/cmd_complete.py` module docstrings: "After `/complete` returns successfully, the master-side `runs/<id>/metadata.yaml` MUST carry `status: done` plus a populated `completion` block. The worktree-side copy is allowed to vanish (the worktree is removed by `cmd_complete`); the master copy is the canonical archive."

### Acceptance

- After `/complete` succeeds on a self-modifying run, `git show master:runs/<id>/metadata.yaml | grep status` reports `status: done`. Verified by the new unit test.
- `agent-workbench list` and `agent-workbench board --static --status human_review` agree on which runs are actually in `human_review` — no ghost runs from stale master-side metadata. Verified by spot-checking the column counts before and after the backfill.
- `agent-workbench doctor` flags any run whose master-side metadata is non-terminal but whose branch is already merged into the workbench root branch. (Until the reconciliation script runs, doctor surfaces the four observed offenders; after backfill, doctor is silent.)
- The four pre-existing stale runs are reconciled — their master-side `metadata.yaml` reports `status: done` with the correct `completion.completion_ref` SHA from the original merge commit.

### Non-goals

- **Removing the worktree-side metadata write.** `cmd_complete` still updates the worktree copy first; the fix is to ensure master ends up consistent, not to relocate the write.
- **Backfilling runs whose worktrees are already gone *and* whose master copy is correct.** The 15 `done` runs from earlier weeks are fine — only runs where master and reality disagree are in scope.
- **Reconciling abandoned-state runs.** Same shape of bug could exist for `cmd_abandon`; if it does, file as a separate TODO. Don't expand scope here.
- **Refactoring `_walk_worktrees`'s filter** beyond what option (b) above would require if it's the chosen path. The filter logic is intentional ("worktree copies of terminal runs are just merged history checked out here") — keep it.
- **Cross-machine reconciliation.** If a run was `/complete`-d on a different machine and the local checkout never saw the post-merge state, that's a sync issue, not a workbench-correctness issue.

### Origin

Surfaced 2026-05-27 while answering "what's the current status of tasks inside agent-workbench-live?" `agent-workbench list` and the board disagreed: list showed two runs as `done` that the board placed in `human_review`. Tracing through `lib/runs.py:iter_all_runs` + `_walk_worktrees` + `lib/metadata.py:run_dir` revealed that both enumerators correctly resolve the collision, but in opposite directions, and that the underlying problem is master-side `metadata.yaml` being a pre-`done` snapshot for self-modifying runs whose worktree completed the lifecycle locally. The board's "drop terminal-state worktree hits" filter is correct on its own terms; the bug is that master should never have been left in `human_review` after `cmd_complete` returned. Four runs in the current repo demonstrate the issue; the reconciliation script + future `cmd_complete` fix close it.
