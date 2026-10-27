# Brief

## Goal

Land two small, independent lifecycle papercuts grouped into one run because each is too thin to justify its own:

1. **`runs/<id>/.lock` is tracked-dir-resident and not gitignored**, so the `worktree_dirty_files` check inside `repos.merge_no_ff` reports a dirty tree on every `/complete`. The workaround so far has been `complete --no-merge` + manual `git merge --no-ff` + `tools/backfill_completion_refs.py`. The fix is one `.gitignore` line.
2. **The `ready` stop banner still tells the user to run `agent-workbench start <id>`** (shell-form). Every other agent-stopping banner now uses slash-form (`/complete`, `/bounce`, `/abandon`). The fix is to update `_SPECS["ready"]` in `lib/cli/_stop_banner.py` and re-baseline one snapshot.

Both touch the agent-stopping handoff path. Both have a clear single-line shape. Landing them together avoids two near-empty TODO sections and two near-empty runs.

## User-facing behavior

**Papercut 1a — `.lock` gitignored.** Running `/complete <id>` on a run whose run dir has already been committed succeeds via `git merge --no-ff` without needing `--no-merge`. The `worktree_dirty_files` check no longer reports `runs/<id>/.lock` as dirty. The user does not see `refusing to merge: <repo> has uncommitted changes: ['runs/<id>/.lock']`. The user does not have to fall back to the manual merge + backfill path.

**Papercut 1b — `ready` banner slash-form.** When a run transitions into `ready` and the agent-stopping banner prints, the "next move" line reads `/start <id>` rather than `agent-workbench start <id>`. The banner is consistent with the `human_review` banner the user just saw moments earlier on a prior run. A one-line description accompanies the slash command (e.g. "approve the plan and create the worktree"), matching the description-line style already used by `human_review`'s slash entries.

## Acceptance criteria

- `/complete <id>` on a run that has committed its run dir produces a successful `git merge --no-ff` without needing `--no-merge`. Verified on a real run after the gitignore entry lands.
- A `.lock` file inside `<workbench>/runs/<id>/` is not picked up by `git status --porcelain` in the parent repo.
- `lib/cli/_stop_banner.py` contains no `agent-workbench start` literal anywhere.
- The `ready` banner snapshot at `tests/snapshots/stop_banner_ready.expected.txt` is re-baselined to the new slash-form output and the snapshot test passes.
- The existing slash-form banners for `human_review` (and any other state already migrated) are unchanged — the snapshot diff is scoped to `ready` only.
- `tools/backfill_completion_refs.py`'s docstring/header comment notes that the underlying dirty-`.lock` issue has been fixed and that the backfill is no longer needed for new runs.
- The full test suite (workbench-side, the only suite this run touches) is green; pass count rises by at most the snapshot re-baseline; no test count regression.

## Non-goals

- **Restructuring the lock mechanism itself.** `locks.acquire`/`locks.release` and the `.lock` file's location inside the run dir stay as-is. The fix is gitignore-only; do not move the lock file, do not change its name, do not switch to a flock-style or filesystem-lock-free scheme.
- **Removing `tools/backfill_completion_refs.py`.** The tool still exists for pre-fix runs whose completion ref is missing. Only its documentation is updated; the script's behavior is unchanged.
- **Auditing every other stop banner.** Only `ready` is in scope. If another state's banner is also shell-form, file a follow-up; do not fix it here. (The TODO entry calls out `ready` specifically; `human_review` was migrated already.)
- **Introducing a new structured five-section body for the `ready` banner.** `ready` has one decision (run `/start`); the structured shape used by `human_review` is overkill. Keep the current shape, swap the command literal + description line.
- **V2 lock-file path.** The TODO mentions "also add the v2 sibling path if v2 still produces lock files." Treat as an assumption to check (see Assumptions), not a hard scope item — if v2's `.lock` semantics differ or v2 is dormant, document and skip.
- **Touching any other lifecycle code in `lib/cli/`** beyond `_stop_banner.py`'s `_SPECS["ready"]`.

## Good examples

- A `.gitignore` line of the form `agentic-development-task-system-v3__ai/agent-workbench-live/runs/*/.lock` (workbench-relative path glob) added under or alongside the existing `tmp/` entry. Comment optional, but a one-line comment explaining what the file is would be welcome since gitignore patterns are otherwise opaque.
- A `_SPECS["ready"]` change that mirrors the structural shape of the slash-form entries already in the file — same dict keys, same description-line idiom, no new code paths.
- A snapshot re-baseline that's exactly one file, exactly one diff hunk, with no incidental whitespace or ordering churn elsewhere in the snapshot tree.
- A `tools/backfill_completion_refs.py` doc edit that's a short paragraph at the top of the file (or in its module docstring), pointing the future reader at the gitignore fix and the run-id that committed it.

## Bad examples

- Wildcarding `*.lock` at the gitignore root — would mask any lock file anywhere in the repo, not just the workbench's. Keep the pattern narrow to the workbench's runs directory.
- Refactoring `_stop_banner.py`'s spec shape "while we're here" — out of scope. A future-proof refactor belongs in its own run.
- Adding a structured body builder for `ready` — explicitly out of scope; the TODO calls this out.
- Deleting `tools/backfill_completion_refs.py` — out of scope; it still serves pre-fix runs.
- Bumping snapshot files for any state other than `ready`.
- Touching `runs/<id>/.lock` itself (deleting it from existing runs, moving it, etc.). The file's behavior at runtime is unchanged.

## Constraints

- **Self-modifying workbench.** This run targets the monorepo root containing `agent-workbench-live/`. The run's worktree branch is `agent/lifecycle-papercuts-lock-ready-banner`. Changes land in the worktree and merge to master via the normal `/complete` flow.
- **Two-file contract (root `AGENTS.md`).** When this run ships, `docs/TODO.md` §2 must be deleted and remaining sections renumbered; `docs/LOG.md` must get a dated entry. Both happen during this run, not as a follow-up.
- **Test-first discipline.** The snapshot re-baseline is the only test artifact that should change. Any other test diff (counts, names, ordering) is a smell.
- **Don't pollute the master session's read prefix.** The implementation can be a single small commit; don't `git log`-chase the history of `_SPECS["ready"]` if it isn't load-bearing for the change.
- **`local_only: true`** policy is in effect; no remote calls.

## Assumptions

- The `.gitignore` path pattern at the root of the monorepo is what `git status --porcelain` consults inside the parent repo during `worktree_dirty_files`. There is no additional `.git/info/exclude`-style escape hatch in play. (If there is, surface it during `/plan`.)
- The v2 sibling `agentic-development-task-system-v2__ai/agent-workbench-live/runs/*/.lock` either no longer produces lock files (v2 is dormant) or behaves identically. The fix can add a symmetric entry defensively; if the v2 tree is gone, skip.
- `tests/snapshots/stop_banner_ready.expected.txt` exists today and the snapshot test that consumes it loads it via the same `_normalize`-style helper used by the `human_review` snapshots — so re-baselining is a one-line content swap, not a test-harness change.
- No code path *outside* the test suite reads the `ready` banner's text as a parsed contract (e.g. a script that greps for `agent-workbench start` in stop-banner output). If such a contract exists, surface during `/plan`.
- The `worktree_dirty_files` check in `repos.merge_no_ff` is the only place the `.lock` file's tracked-dir-resident location bites. The `locks.release` path is uninteresting (it removes the file before any merge check would run on a normal `/complete`).
- The `human_review` banner's description-line style is the right template for `ready`'s new description line. (One short imperative phrase per slash command, no body paragraphs.)

## Suggested QA scenarios

1. **End-to-end `/complete` happy path.** On a real run that has committed its run dir, run `/complete <id>` after the gitignore entry lands. Assert: the command succeeds, the merge is `--no-ff` into master, no `--no-merge` fallback is needed, no `refusing to merge` error appears. This is the headline acceptance.
2. **`worktree_dirty_files` unit test.** With a synthetic workbench whose run dir contains a `.lock` file and otherwise-clean tree, assert `worktree_dirty_files` returns an empty list. Today this would return the `.lock` path; after the gitignore fix, it should be empty.
3. **`ready` banner snapshot.** Run the banner test that emits `ready` output, assert the rendered text matches the new baseline exactly, assert no `agent-workbench start` literal appears anywhere in the banner-source tree.
4. **`ready` banner runtime smoke.** Trigger a `planning -> ready` transition on a synthetic run, capture stdout, assert the banner's "next move" line reads `/start <id>`.
5. **Cross-state non-regression.** Re-run the `human_review` banner snapshot tests. Assert no diff. The `ready` change must not touch any other state's spec.
6. **Backfill tool docstring.** Read `tools/backfill_completion_refs.py`'s top-of-file docstring/comments. Assert it mentions the gitignore fix and indicates the script is legacy for pre-fix runs.
7. **Two-file-contract artifacts.** After the implementation lands, verify `docs/TODO.md` no longer contains a §2 "Lifecycle papercuts" section and that numbering is contiguous; verify `docs/LOG.md` has a `## 2026-05-25` (or later) entry that names this run, the commit SHA, and the test-count delta.
