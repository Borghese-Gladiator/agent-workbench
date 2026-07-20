# Follow-ups

---
title: Split TestHumanReviewValidation predicate-lambda fold into two-assertion form
motivation: The fold in `tests/test_lifecycle.py::TestHumanReviewValidation.test_validation_cases` uses a `predicate(errs)` lambda per case. On regression, the failure surfaces as "got [...]" rather than "expected substring 'not found' in errs[0]". The diagnosis is slightly weaker than the original two-line `assertEqual` + `assertIn`. F-001 in review.md flagged it as minor.
suggested_scope: Inside the single test method, replace the lambda with explicit `(expected_len, expected_substring_or_None)` per case and two `assertEqual`/`assertIn` calls. Net test count stays at 1 (no re-inflation). One-file change.
category: tech_debt
---

Tiny readability tweak. Worth doing only if a regression in this code path actually surfaces with confusing diagnostics; otherwise leave it.

---
title: Document the "combined-assertions" fold pattern in tests/README.md
motivation: This run established a concrete fold pattern (one test method, a `cases` list of `(label, …)` tuples, a `for` loop with `msg=label`). Future contributors writing new tests should follow it for consistency, and reviewers should know to suggest it when they see N tests with identical setup. Currently the pattern is implicit — it appears in 10 files but isn't documented anywhere.
suggested_scope: Add a short section to `agent-workbench-live/tests/README.md` showing the shape, with one before/after example pulled from this run's diff. ~30 lines.
category: docs
---

Low-cost, high-leverage: next contributor reading test code will internalize the convention immediately.

---
title: Investigate whether tests/test_integration.py's TestBounceLoop scenarios can fold
motivation: Four bounce tests share `_drive_to_human_review` setUp (~40 lines per test). Each tests a different bounce path (vanilla, with change-request, missing file, empty file). They were left unmerged in this run because the validations differ meaningfully (one is happy-path, three are error-path). But the error-path trio might collapse into one test with a (label, path-setup, expected-error-substring) loop — saving 2 tests and ~60 lines of duplication.
suggested_scope: Re-survey the four bounce tests; if the error-path trio shares enough shape, fold them. Keep the happy-path one separate. ~−2 tests if it works out.
category: refactor
---

Could not justify in this run because the call-shape varies (one passes `--change-request-path` to a real file, one to a missing file, one to an empty file). Worth a second look.

---
title: Consider extracting the seed_run() builder in test_board_snapshot.py to _helpers.py
motivation: `seed_run()` is a ~110-line function that writes a faked `metadata.yaml`. It's only used by one test file today, but the patterns inside it (varied tests_passed, build_iterations, accepted_by, abandoned_reason) are exactly what `test_cmd_board.py` also needs (it has its own simpler `write_run` helper). Centralizing in `tests/_helpers.py` would let board-related test files share one builder.
suggested_scope: Move `seed_run` into `tests/_helpers.py`, keep its full signature, port `test_cmd_board.py`'s `write_run` callers to use it. ~150 lines moved, no count change.
category: refactor
---

Explicit non-goal of this run (the brief forbids fixture refactors beyond what's mechanically required for a merge). Surface for the next bite.
