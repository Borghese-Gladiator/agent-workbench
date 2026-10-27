# Follow-ups

---
title: Fix validate-context.md diff resolution against worktree branch HEAD
motivation: During this run's dogfood I noticed `validate-context.md`'s `Files changed` block read `(no files changed yet)` even though the worktree branch had a real commit with ~875 lines of changes. The generator at `lib/validate_context.py:_files_changed` (and `build_blast_radius`) shells out `git diff --name-only <base_ref>...HEAD` using the **symbolic** `base_ref` against the target-repo path. With `base_ref: HEAD`, that resolves to the target repo's current HEAD — not the worktree branch's HEAD. The worktree's actual commits don't appear in validate-context.md, and downstream the reviewer's blast-radius narrative is fed an empty list. The `target.repo.base_ref_sha` field added in `303bd40` already captures the right reference; switch the diff invocation to use it (and the worktree path, not the target-repo path).
suggested_scope: Update `lib/validate_context.py`'s `build` and `build_blast_radius` to accept and prefer a `base_ref_sha` argument, falling back to symbolic `base_ref` only when the SHA is missing. Threaded through `cmd_validate.py:_write_validate_context_artifacts`. Update the diff target from `target.repo.path` to `target.worktree.path` so the worktree's commits show up. Unit test against a synthetic two-commit worktree. Out of scope: schema changes, changes to the `validate-context.md` template structure.
category: bug_risk
---

The fix mirrors the same prefer-SHA / lazy-resolve / fallback pattern `lib/metrics/lines.py:_effective_ref` already uses, and the same pattern `lib/cli/_stop_banner.py:_resolve_effective_ref` now uses for the new banner diffstat. The validate-context generator predates that pattern and never got updated. Likely cause: it was written when runs were assumed to commit directly in the target repo (flat-layout days), and the worktree-as-execution-environment shift in TODO §1 didn't sweep through this module.

---
title: Add HUMAN_REVIEW.md fixture snapshot test for the full human_review banner
motivation: The plan called for a "snapshot test across two fixture runs (`happy/` and `bounce_pass2/`)" but we chose to satisfy the drift-detection requirement via tmp-path structural assertions in `TestFullBanner` plus E2E `assertIn` substring checks. The structural surface is comparable, but a real snapshot file would catch wording drift in the exact body (e.g. someone tweaking the testing-line phrasing or the Next-moves descriptions). The reason we deferred: absolute paths and test-tmp prefixes make a static snapshot brittle. A future run could solve that by normalizing the snapshot in the same way `tests/test_human_review.py::_normalize` already does for HUMAN_REVIEW.md snapshots.
suggested_scope: Reuse the `_normalize`-style helper (collapse `<TMP>`, `<TEST_REPO>`, `<HH:MM:SS>`, `<RUN_ROOT>`, etc.) to render a stable snapshot for the full banner body. Two fixture-driven snapshots — one for the happy path, one for bounce-pass2 — under `tests/snapshots/stop_banner_human_review_{happy,bounce_pass2}.expected.txt`. Out of scope: changes to the banner body itself.
category: tech_debt
---

The drift-detection value is real: if someone changes "auto-merges worktree branch into parent" to "merges into parent", structural tests pass but the user-facing wording drifts. A snapshot catches that.

---
title: Banner body shape for the `ready` landing
motivation: This run scoped exactly the `human_review` body. The `ready` landing today still uses the old shell-form `agent-workbench start <id>` line. The same pattern applies — slash-form `/start <id>` would match how the human actually drives the workbench in a Claude Code session. Lower priority than `human_review` because `ready` lands less often (one per run) and has only one decision option, but the inconsistency between `ready` (shell-form) and `human_review` (slash-form) banners is now visible and worth aligning.
suggested_scope: Extend the body-builder pattern to `ready`: change `_SPECS["ready"]` to render its Next moves line via the same slash-form padding logic the `human_review` builder uses. Add a one-line description ("approve the plan and create the worktree"). Re-baseline the `stop_banner_ready.expected.txt` snapshot. Out of scope: a richer body for `ready` (it has only one decision; the structured five-section shape isn't justified).
category: scope_extension
---

The TODO entry's non-goals section explicitly excluded `ready` as out of scope for this run. Reopening it as a separate task here keeps the surface aligned over time.

---
title: Fix the `.lock` file showing up in master's `git status` during complete
motivation: Mentioned in `docs/LOG.md` § 2026-05-24 (stop-banner run): the dirty-files check in `complete` refuses on the `.lock` file that `locks.acquire` creates just before the dirty check runs. The lock lives in the run dir, which is committed to master, so `git status` of the parent repo shows it as a dirty file and the merge refuses. Workaround so far has been `--no-merge` + manual `git merge --no-ff`. The proper fix is one line in `.gitignore` (`agentic-development-task-system-v3__ai/agent-workbench-live/runs/*/.lock` and the v2 sibling). Carried forward because it's directly relevant: any future run merging via `/complete` hits it.
suggested_scope: Add the gitignore entry for `runs/*/.lock` (covering both v2 and v3 trees). Verify by running `complete` on a real run with the new entry in place — the dirty check should pass. Out of scope: redesigning the lock file location or moving it outside the run dir.
category: tech_debt
---

A one-line `.gitignore` change unblocks every future `/complete` invocation from needing `--no-merge`. Low effort, high recurring value.
