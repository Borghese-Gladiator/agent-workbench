# Follow-ups

---
title: Runtime test that cmd_complete suppresses the banner on abort
motivation: Brief AC-12 listed a runtime test confirming `complete` does NOT print the banner when the merge aborts (e.g. dirty worktree, merge conflict). The current run reasoned this by code construction instead of landing the test. Without a test, a future refactor of `cmd_complete.run()` could accidentally move the banner above the failure paths and the regression would land silently.
suggested_scope: One focused subprocess test (in `tests/test_e2e.py` or a new `tests/test_complete_failures.py`) that drives a happy-path run to `human_review`, intentionally dirties the worktree, calls `complete`, and asserts `STOP.` does not appear in stdout (and that the run is still in `human_review`).
category: tech_debt
---

The "no banner on abort" guarantee is currently a code-reading property of `cmd_complete.py`'s control flow (every failure path returns `fail(...)` before the banner line). A runtime assertion would harden it against future refactors.

---
title: Flat-layout E2E fixture so cmd_validate.py flat path is regression-covered
motivation: `cmd_validate.py`'s flat-layout success path (validating -> human_review directly) is the only one of the five banner sites without runtime coverage. The repo doesn't have an E2E fixture that exercises a non-staged run, so the wiring is verified only by code reading + the `human_review` snapshot. Future changes to the flat-layout path could regress without a test catching it.
suggested_scope: One new E2E fixture (`tests/fixtures/flat_happy/` or similar) plus a single test method that drives a run through the legacy non-staged path and asserts STOP appears after `validate` (and not after `validate --init`). Probably 50-100 LOC of fixture content + a test method that mirrors `test_happy_path` minus the followups stage.
category: tech_debt
---

The flat layout exists in `cmd_validate.py` for legacy runs only and could plausibly be deleted in a future cleanup, but as long as it ships it deserves a test.

---
title: Document the .gitignore lib/ re-include pattern for new sibling projects
motivation: This run discovered that `.gitignore` re-includes `lib/` for the v2 path only; the v3 path was implicitly ignored, which would have silently dropped `_stop_banner.py` from a fresh clone. The fix was a one-line addition. The next sibling project under `new-tech-monorepo/` will hit the same trap.
suggested_scope: Either (a) add a comment block in `.gitignore` near the v2/v3 lib/ re-includes explaining the pattern, or (b) collapse the per-project re-includes into a glob (`!*/agent-workbench-live/lib/`) — needs a quick check that no sibling project intends to be ignored. ~5 minutes of work; tiny PR.
category: docs
---

Small, but the failure mode is "silent dropped file" which is worse than a noisy failure.
