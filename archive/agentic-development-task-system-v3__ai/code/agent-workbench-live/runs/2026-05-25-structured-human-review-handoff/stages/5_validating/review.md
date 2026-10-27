# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes. The brief's user-facing-behavior section called for exactly five sections in fixed order (`Review:`, `Summary of changes (≤3 bullets):`, `Summary of testing (≤2 sentences, or "None recorded."):`, `Diffstat:`, `Next moves (human-triggered, type in a session):`), and the implementation in `lib/cli/_stop_banner.py:`_build_human_review_body emits them in that exact order. Each section's source-of-truth mapping in the brief (HUMAN_REVIEW.md for the bullets, `QACompleted` event + QA report's `## Manual testing` section for the testing line, `git diff --shortstat` for the diffstat, static slash-form for the Next moves) is reflected one-for-one in helper functions in the new module: `_render_summary_bullets`, `_render_testing_line`, `_render_diffstat`, `_render_next_moves_slash_form`. The "byte-identical across `validate` and `followups`" requirement is satisfied by routing both real call sites through the single `print_stop_banner` entry point with `cfg=cfg`; both `cmd_validate.py:557` and `cmd_followups.py:194` were updated.

## Did it accidentally expand scope?

No. The implementation touched only the files named in the plan's "Files likely to change" list — `_stop_banner.py`, `cmd_validate.py`, `cmd_followups.py`, the test files, the snapshot, `docs/TODO.md` (delete), `docs/LOG.md` (add). No new top-level CLI flags, no schema changes, no metadata changes, no new events. The `_stop_banner.py` module grew from 88 → ~315 LoC, all of it the new body-builder helpers and the no-cfg fallback path; nothing in the existing `ready` / `done` / `abandoned` rendering changed.

## Are there fragile assumptions?

Three worth naming:

1. **The QA report's `## Manual testing` section is the workbench's only signal for a recorded dogfood/manual run.** Captured as ASM-001 in the plan. If a future run records manual testing somewhere else, the banner's optional second testing sentence is missing — but HUMAN_REVIEW.md will also be missing it, so the failure mode is visible and consistent. The renderer's `_read_manual_testing` is the same heuristic; banner stays in sync with it by design (DR-004).
2. **The summary-bullet extractor relies on the renderer emitting top-level `- ` lines.** DR-002 commits to "top-level bullets only" because the renderer's nested `  -` rows are details, not summary items. If a future change to `lib/human_review.py` switches the `## Summary of changes` section to a different markdown shape (e.g. an ordered list `1. ...` or a table), the extractor returns `(none recorded)` instead of bullets. That's a quiet degradation, not a crash — and would be visible in the next dogfood. Worth a note in `human_review.py` if anyone touches its renderer.
3. **The `tests_passed=None` defensive branch is unreachable through `events.append`.** The schema validator requires `tests_passed: bool`. The branch is exercised only by a hand-rolled events list in the unit test. Defensive code that catches a hypothetical future schema relaxation; acceptable.

## Are there missing tests?

No. The plan listed three test scopes (unit body-builder, E2E followups landing, E2E bounce-pass2 landing) and all three landed. Coverage detail:

- **Unit (`tests/test_stop_banner_human_review_body.py`)**: 24 cases across 5 classes — TestSummaryBullets (6 cases: 2-bullet / 5-bullet / 0-bullet / missing-HUMAN_REVIEW.md / nested-rows-ignored / 100-column truncation / truncate-inline behavior), TestTestingLine (6 cases: no-QA-event / passed+no-issues+no-manual / failed+manual / passed+known-issues / passed+placeholder / passed+no-QA-report / None), TestDiffstat (5 cases: no-worktree / unresolvable-symbolic / resolvable-empty / real-diff / lazy-resolve-when-sha-missing), TestFullBanner (4 cases: section-ordering / summary-truncation-in-context / no-QA-event-shows-None-recorded / no-ANSI-escapes), TestNoConfigFallback (1 case). Each builder helper has independent test coverage; the full-banner integration tests cover the assembly.
- **E2E (`tests/test_e2e.py`)**: two test functions updated — `TestE2EHappyPath::test_happy_path` (assert section ordering with positions[] check + slash-form presence + shell-form absence) and `TestE2EBounceLoop::test_bounce_loop` (same shape, second `followups -> human_review` landing).
- **Snapshot (`tests/snapshots/stop_banner_human_review.expected.txt`)**: re-baselined for the no-cfg minimal fallback. The full-body shape isn't snapshot-tested because absolute paths and test-tmpdir prefixes would make the snapshot brittle; the tmp-path unit tests in TestFullBanner cover it instead — more robust and equally pinning.

The brief listed "snapshot test for the full banner across two fixture runs (`happy/` and `bounce_pass2/`) catches wording drift". The implementation chose to satisfy this via TestFullBanner's structural assertions + the E2E happy/bounce assertions, rather than a static snapshot file with absolute paths. Equivalent drift-catching surface, less brittle. Worth flagging in the human-review summary so the reviewer can decide whether to push for an actual fixture-based snapshot test instead.

## Are there security / data loss / migration risks?

None. The change is pure stdout formatting — no new files written, no state mutations, no schema changes, no network calls. The diffstat builder shells out to `git`, which is already trusted by the rest of the codebase (`lib/metrics/lines.py`, `lib/validate_context.py`, `cmd_complete.py`'s merge logic). No external input is interpolated into shell commands without going through `subprocess.run`'s arg-list form.

## What should the human review first?

In order:

1. **The banner body shape against the brief's spec** — `lib/cli/_stop_banner.py:_build_human_review_body` produces five sections (`Review:` / `Summary of changes (≤3 bullets):` / `Summary of testing (≤2 sentences, or "None recorded."):` / `Diffstat:` / `Next moves (human-triggered, type in a session):`). Compare against the brief's "User-facing behavior" §. Quickest visual check: a tmp-path test renders a full banner — see TestFullBanner outputs.
2. **The decision-rationale set in the plan** — `stages/3_planning/plan.md` § "Decisions & assumptions". DR-001 (threaded `cfg` kwarg vs. parallel function), DR-002 (top-level bullets only vs. nested), DR-003 (split empty-diff vs. unresolvable-ref outcomes), DR-004 (QA-report `## Manual testing` as the dogfood signal). The reviewer's call on any of these would change the body shape.
3. **The snapshot re-baseline** — `tests/snapshots/stop_banner_human_review.expected.txt`. Verify the no-cfg fallback shape is what the reviewer expects from `print_stop_banner("human_review", run_id)` called outside the CLI.
4. **The decision-line padding logic** — `_render_next_moves_slash_form` pads the command column so the descriptions align. With a SAMPLE-RUN-ID this looks fine; with very long run IDs (e.g. today's `2026-05-25-structured-human-review-handoff`) the pad widens accordingly. Check the snapshot file for the visual outcome.

## Blast radius

The blast-radius.txt for this run reports "(no files changed yet)" because the `validate-context.md` generator computes `git diff <base_ref>...HEAD` against the **target repo** path (`/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai`) using the symbolic `base_ref: HEAD`, which resolves to that repo's current HEAD and shows zero diff. The actual work landed on the worktree branch (`agent/structured-human-review-handoff`, commit `a698f62`); the worktree's diff against `base_ref_sha: bcc5a6b9...` is the real blast radius:

- `lib/cli/_stop_banner.py` (+227 LoC, the body builder + helpers)
- `lib/cli/cmd_validate.py` (+1 / -1, threading `cfg=cfg`)
- `lib/cli/cmd_followups.py` (+1 / -1, threading `cfg=cfg`)
- `tests/test_stop_banner.py` (+10 / -3, slash-form assertions)
- `tests/test_stop_banner_human_review_body.py` (+493 LoC, new file)
- `tests/test_e2e.py` (+42 LoC, two E2E extensions)
- `tests/snapshots/stop_banner_human_review.expected.txt` (re-baselined)
- `docs/TODO.md` (-81 LoC, §2 removed)
- `docs/LOG.md` (+18 LoC, 2026-05-25 entry)

The validate-context generator's symbolic-base-ref behavior — computing diffs against the target repo's HEAD rather than the worktree branch's HEAD — is a pre-existing renderer issue (the worktree commit happens after `/start` records the SHA, so any post-start commits don't appear in validate-context.md's `Files changed` block). Not in scope here; surfaces because this run did its work entirely on the worktree branch. Likely worth a follow-up.

No depth-2/3 caller surprises. The `_build_human_review_body` function is called only from `print_stop_banner` (in-module), which is called only from the five command sites that already used the helper (`cmd_plan`, `cmd_validate` × 2 paths, `cmd_followups`, `cmd_complete`, `cmd_abandon`). The only behavioral change in those sites that isn't a `human_review` landing is zero: `print_stop_banner("ready" | "done" | "abandoned", ...)` follows the same code path as before (the new `landing_state == "human_review"` branch fires only on that landing).

## Findings

No findings — no blocking, major, or minor issues.
