# Lifecycle papercuts: `.lock` in `.gitignore` and the `ready` banner

Two unrelated one-shot fixes grouped because they're both tiny, both touch the agent-stopping handoff path, and both have a clear single-line shape. Worth landing together to avoid a near-empty section per item.

## 1a. `runs/*/.lock` not gitignored — every `/complete` falls back to `--no-merge`

`locks.acquire(cfg, run_id)` creates `runs/<id>/.lock` inside the run directory before `repos.merge_no_ff` runs `worktree_dirty_files(repo_path)`. The run dir is tracked in the parent repo, so the lock file appears in `git status --porcelain` and the merge refuses with `refusing to merge: <repo> has uncommitted changes: ['runs/<id>/.lock']`. Workaround so far has been `complete --no-merge` + manual `git merge --no-ff` + `tools/backfill_completion_refs.py`. Hit on at least three runs (stop-banner, token-efficiency-pass-2, structured-human-review-handoff).

Root `.gitignore` is currently just `tmp/`; the entry has to be added.

- [ ] Add `agentic-development-task-system-v3__ai/agent-workbench-live/runs/*/.lock` to root `.gitignore` (also add the v2 sibling path if v2 still produces lock files).
- [ ] Verify by running `/complete` on a real run after the entry lands — the dirty-files check should pass without `--no-merge`.
- [ ] Update `tools/backfill_completion_refs.py`'s docstring/comments to reference this fix and note that the backfill is no longer needed for new runs.

## 1b. `ready` banner still uses shell-form

`_SPECS["ready"]` in `lib/cli/_stop_banner.py` prints `agent-workbench start <id>` as the next move. `human_review` was migrated to slash-form (`/complete`, `/bounce`, `/abandon`) in the structured-handoff run (`a698f62`); `ready` was explicitly out-of-scope there. The inconsistency is now visible to anyone watching two banners in a row.

- [ ] Change `_SPECS["ready"]` to render `/start <id>` with a one-line description (e.g. "approve the plan and create the worktree").
- [ ] Re-baseline `tests/snapshots/stop_banner_ready.expected.txt`.
- [ ] No new structured-body builder required — `ready` has one decision; the five-section shape isn't justified.

## Acceptance

- `/complete <id>` on a run that committed its run dir produces a successful `git merge --no-ff` without needing `--no-merge`.
- `_stop_banner.py` contains no `agent-workbench start` literal; the `ready` banner snapshot reflects the slash-form.

## Source

This is TODO §2 ("Lifecycle papercuts") from `docs/TODO.md` in this repo.
