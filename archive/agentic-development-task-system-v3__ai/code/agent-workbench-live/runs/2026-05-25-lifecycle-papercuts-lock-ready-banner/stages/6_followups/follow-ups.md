# Follow-ups

---
title: Normalize the run-id date prefix in test_human_review snapshot tests
motivation: `tests/test_human_review.py::TestSnapshotRender::{test_happy_snapshot,test_bounce_pass2_snapshot}` fail on any day after the snapshot was baked. The `_normalize` helper at lines 460-470 collapses `<TMP>`, `<TEST_REPO>`, and timestamps but explicitly does NOT collapse the run-id date prefix (comment at lines 466-467 calls it intentional). The result is that 2 tests in the full workbench suite currently fail on date rollover, masking real regressions if anyone introduces one. Surfaced live during this run when the date rolled 2026-05-25 → 2026-05-26 mid-session and turned a green suite red.
suggested_scope: Extend `_normalize` to collapse the run-id date suffix (e.g. `(2026-)?\d{2}-\d{2}-(happy|bounce)-snap` → `<DATE>-$2-snap`), OR pin `today()` via monkey-patch so the test class always uses 2026-05-22. Two tests, ~5 lines of change. Re-baseline both `human_review_{happy,bounce_pass2}.expected.md` snapshots if anything else has drifted. Belongs inside TODO §4 (test-coverage gaps) but is small enough to do as its own run.
category: bug_risk
---

This is exactly the shape TODO §4 anticipated: a test that's "verified by code-reading or by tmp-dir structural assertions but doesn't have a runtime drive-and-assert" — except here, the runtime assertion exists and fires correctly, it just fires for the wrong reason (date drift, not behavior drift).

---
title: Extract a shared slash-form next-moves renderer
motivation: After this run, `lib/cli/_stop_banner.py`'s `elif spec.next_moves:` branch and `_render_next_moves_slash_form` are near-duplicates — same padding logic, same em-dash separator, same header literal pattern. Today the duplication is benign (one entry vs. three) but the next state added with non-empty `next_moves` will compound it. Future regression: someone updates the format in one place and not the other.
suggested_scope: Extract a `_render_next_moves(spec, run_id, header_suffix="")` helper that both call sites use. The `human_review`-specific dynamic next-moves (which use `_HUMAN_REVIEW_NEXT_MOVES`, not `spec.next_moves`) stay separate or join the same helper with an override. Sketch: ~30 line diff, one new test method asserting the helper produces the same output for both call sites against a fixture.
category: refactor
---

Listed as F-003 in this run's review.md. Out of scope per brief's non-goal, but a clear candidate.

---
title: Pin the `validate-context.md` empty-diff bug as part of TODO §2 (base_ref_sha plumbing) acceptance
motivation: This run's `stages/5_validating/validate-context.md` reads "(no files changed yet)" in the Files Changed block. That's the exact symptom TODO §2 papercut 2a names: `validate_context.build` and `build_blast_radius` take symbolic `base_ref="HEAD"` and shell out `git diff HEAD...HEAD` literally, producing an empty diff. The reviewer of this run had to inspect the diff via `git diff master HEAD --stat` manually because validate-context.md was unable to provide it.
suggested_scope: Implementing TODO §2 (now §2 in renumbered docs/TODO.md) covers this fully — add `base_ref_sha` kwarg to `validate_context.build`, prefer the SHA when present, fall back to symbolic lazy-resolve. Mirror the existing `lib/metrics/lines.py:_effective_ref` shape. One file, one unit test in `tests/test_validate_context.py` (or wherever the validate-context tests live).
category: tech_debt
---

Already in TODO §2 (post-renumbering). This follow-up just witnesses the live symptom from this run as fresh evidence that the gap matters.

---
title: TODO renumber-on-merge guardrail
motivation: This run discovered (during validate) that master gained TODO §9 (`1d4e71f`, board snapshot perf) after this branch's `base_ref_sha`. The two diverged renumberings — master keeping §§1-9 with new §9 content, my branch deleting §2 and renumbering §§3-9 → §§2-8 — guarantee a conflict at `/complete` merge time. Manageable by hand, but a small tool would resolve the class.
suggested_scope: Build `tools/renumber_todo_sections.py` that takes two TODO.md files (mine + master's), detects which sections each side modified, and produces a merged renumbering preserving cross-section refs (`§N PR-flow`, `§N tool-policy`, etc.). Idempotent. `--dry-run` flag. Used by hand at merge time when a conflict appears in `docs/TODO.md` — not auto-invoked. Documented in AGENTS.md's two-file contract section.
category: scope_extension
---

Sits beside, not inside, the workbench's lifecycle. Useful when self-modifying runs run in parallel and both touch TODO.md.

---
title: Capture the brief-names-acceptance / plan-names-the-file rule in shape.md
motivation: This run's brief said "update `_SPECS["ready"]` in `lib/cli/_stop_banner.py`"; the plan caught that the bug actually lives in the renderer f-string at `_stop_banner.py:104`. The brief survived because its *acceptance criteria* were correct ("no `agent-workbench start` literal"); only the implementation pointer was off. Future shape-stage agents will write similar pointers if they read TODO entries that name specific functions — and the brief is code-blind, so it can't verify the pointer.
suggested_scope: Add one bullet to `agent-workbench-live/.claude/commands/shape.md`'s "Rules" section: "Don't pin specific function names or line numbers in the brief — those belong in `/plan` after the code is read. Acceptance criteria can name behavior, files in scope can list paths, but implementation locations are advisory and may be wrong." Plus a one-line callout in the brief template's comment header. ~5 line change across two files.
category: docs
---

Cheap, mostly clarifies an existing constraint. The rule is already implicit in "code-blind, no questions"; making it explicit prevents the next agent from repeating this run's mis-pointer.
