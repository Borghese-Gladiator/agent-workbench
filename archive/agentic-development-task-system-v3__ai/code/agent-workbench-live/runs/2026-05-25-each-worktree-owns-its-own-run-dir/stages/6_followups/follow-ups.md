# Follow-ups

---
title: HUMAN_REVIEW.md renderer drops the rich build content
motivation: For this run, HUMAN_REVIEW.md's `## Summary of changes` ended up with only two doc-touched bullets (`README.md` and `docs/api.md` — extracted from `build.md`'s "Documentation touched" section), and `## Manual testing performed` was "None recorded." Neither reflected the actual scope (A1–A5 + B1–B3 + C1–C4) or the QA outcome (298 tests). The renderer in `lib/human_review.py` pulls from very narrow signals — the "Documentation touched" section header and `QACompleted` event payloads — so a run that touches lots of code but only mentions docs in passing produces a misleading summary. The reviewer ends up reading the file pointers in `## Files` and has to open `build.md` to see what actually happened.
suggested_scope: In `lib/human_review.py`, replace the `## Summary of changes` extractor: (a) parse `build.md`'s `## What changed` and `## Files changed` sections (already present in the build report template) instead of only `## Documentation touched`; (b) cap at 5 bullets with a "…(N more in build.md)" overflow line; (c) for `## Manual testing performed`, also surface `qa/report.md`'s `## Summary` table (tests_passed, known_issues_count) rather than only events. Add a snapshot test fixture (`tests/fixtures/human_review/rich_changes/`) that exercises a run with non-doc changes and asserts the renderer doesn't claim "None recorded." for testing. Roughly 100 lines of renderer + 60 lines of test.
category: bug_risk
---

---
title: Full self-modifying lifecycle E2E test
motivation: This run added `test_self_modifying.py` for `new-run` only. Without an E2E test that drives a self-modifying run through `shape → plan → start → validate → complete`, regressions in the pre-merge stage-and-commit step (A4) or the worktree-side run-dir resolution could land silently. The architecture's correctness depends on master staying clean across every transition.
suggested_scope: Extend `tests/test_self_modifying.py` with one new test that uses the CLI surface to drive the full lifecycle of a synthetic self-modifying run, asserting master's `git status --porcelain` shows no `runs/` entries at each step, and that `complete` produces a merge commit whose tree contains the run dir at `<workbench>/runs/<id>/`. Roughly 150 lines of test code; reuses `_make_self_modifying_workbench` from this run.
category: tech_debt
---

---
title: Unit tests for `stage_and_commit_run_dir` and `archive_tree_to_path`
motivation: Both helpers in `lib/repos.py` are new (A4 + A5) and only exercised via the integration paths in `cmd_complete` and `cmd_abandon`. Direct unit tests would catch drift early, particularly the `--strip-components` count in `archive_tree_to_path` which depends on the source path's segment count.
suggested_scope: Add a `TestStageAndCommitRunDir` and a `TestArchiveTreeToPath` class to `tests/test_repos.py`. Each ~30 lines: tmp git repo with deep path, exercise the helper, assert output. Covers the rename edge case where the source path has 2 segments vs 4.
category: tech_debt
---

---
title: Backfill audit trail for pre-A1 done orphans on master
motivation: Two run dirs (`2026-05-24-fix-generated-lines-base-ref-head/`, `2026-05-24-token-efficiency-pass-2/`) sit untracked in master's working tree as status=done. Their `complete` merges happened pre-A1, so the run dir audit trail isn't in git history. After this run lands, a one-off `git add` + commit on master would backfill the audit trail and bring `doctor`'s warning count to zero (modulo other in-flight orphans).
suggested_scope: One-shot bash: `git add agent-workbench-live/runs/2026-05-24-fix-generated-lines-base-ref-head/ agent-workbench-live/runs/2026-05-24-token-efficiency-pass-2/ && git commit -m "runs: backfill audit trail for pre-A1 done orphans"`. No code changes; ~5 minutes including verification.
category: docs
---

---
title: Worktree-side board watchdog
motivation: DR-007 deferred this: the board's `lib/board/app.py` watchdog observer only watches `cfg.runs_path`. When a run in another worktree changes a file (writes a brief, lands a commit), the live TUI catches the change via the 1Hz fallback timer rather than a watchdog event. ~1s latency for cross-worktree updates. Fine in practice but worth tightening if the board becomes the primary UI for multi-run sessions.
suggested_scope: In `AgentBoardApp.on_mount`, after the initial `obs.schedule(_Handler(self), cfg.runs_path, recursive=True)`, walk `runs.iter_all_runs(cfg)` and schedule additional observers on each unique worktree-side `runs/` directory. Add a re-schedule on a longer interval (e.g. 30s) to pick up new worktrees created mid-session. ~40 lines.
category: scope_extension
---

---
title: Document the cache-reset contract in `lib/runs.py`
motivation: `_list_workbench_worktrees` caches its output for the process lifetime. `cmd_new_run` calls `runs_mod.reset_caches()` after `git worktree add` to make the new worktree visible in the same process. The contract — "if you mutate the worktree set, call `reset_caches`" — is not documented in `lib/runs.py` itself. A future caller could forget.
suggested_scope: One-paragraph addition to the `lib/runs.py` module docstring explaining the cache contract, plus a one-line comment on `_list_workbench_worktrees` and `reset_caches`. ~10 lines of comments; no code change.
category: docs
---
