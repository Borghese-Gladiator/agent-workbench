# Build report

## Implementation summary

Replaced the static next-moves text on `human_review` landings with a structured five-section banner body sourced from HUMAN_REVIEW.md, the QA report, the latest `QACompleted` event, and a `git diff --shortstat` against the run's worktree. Both `cmd_validate` (flat-layout) and `cmd_followups` (staged) now route through the same body builder so their stop-banner output is byte-identical for the same run. Next-moves switched from shell-form (`agent-workbench complete <id> --accepted-by ...`) to slash-form (`/complete <id>`, `/bounce <id>`, `/abandon <id>`) since the human types decisions inside a Claude Code session, not at a terminal.

## Files changed

- `agent-workbench-live/lib/cli/_stop_banner.py` — added `_build_human_review_body(cfg, run_id)` plus helper functions (`_render_summary_bullets`, `_render_testing_line`, `_render_diffstat`, `_render_next_moves_slash_form`, `_extract_section`, `_truncate_inline`, `_latest_event`, `_resolve_qa_report_path`, `_manual_testing_recorded`, `_resolve_effective_ref`). Extended `print_stop_banner` with an optional `cfg=None` kwarg. The `_SPECS["human_review"]` entry no longer carries a static `next_moves` tuple — slash-form lines live in `_HUMAN_REVIEW_NEXT_MOVES` and are rendered by the body builder. Module grew from 88 LoC to ~315 LoC.
- `agent-workbench-live/lib/cli/cmd_validate.py` — one-line edit at the flat-layout `print_stop_banner` call site (line 557) to pass `cfg=cfg`.
- `agent-workbench-live/lib/cli/cmd_followups.py` — one-line edit at the staged `print_stop_banner` call site (line 194) to pass `cfg=cfg`.
- `agent-workbench-live/tests/test_stop_banner.py` — updated `test_human_review_banner_structure` to assert slash-form decisions (`/complete <id>`, `/bounce <id>`, `/abandon <id>`) and to explicitly assert the absence of the shell-form `agent-workbench complete` substrings. The `Next moves` header string also changed to "Next moves (human-triggered, type in a session):".
- `agent-workbench-live/tests/test_stop_banner_human_review_body.py` — new file. 24 unit cases across 5 test classes: TestSummaryBullets, TestTestingLine, TestDiffstat, TestFullBanner, TestNoConfigFallback. Each builder helper has independent test coverage; TestFullBanner integrates them.
- `agent-workbench-live/tests/test_e2e.py` — extended `TestE2EHappyPath::test_happy_path` and `TestE2EBounceLoop::test_bounce_loop` to assert the five new section substrings appear in order on the `followups -> human_review` landings, plus slash-form presence and shell-form absence.
- `agent-workbench-live/tests/snapshots/stop_banner_human_review.expected.txt` — re-baselined for the no-cfg minimal fallback shape (three slash-form `/complete`, `/bounce`, `/abandon` lines under the new "Next moves (human-triggered, type in a session):" header).
- `docs/TODO.md` — deleted §2 ("Structured human_review handoff output"). No renumber needed; only §1 remained.
- `docs/LOG.md` — appended a 2026-05-25 entry covering what shipped, the test counts, and the decision rationale highlights (DR-001 through DR-004).

## Reviewer reading order

1. `agent-workbench-live/lib/cli/_stop_banner.py` — read the new `_build_human_review_body` first, then the per-section helpers (`_render_summary_bullets`, `_render_testing_line`, `_render_diffstat`, `_render_next_moves_slash_form`). The closed-set validation and the static `_SPECS` table are unchanged for non-`human_review` states.
2. `agent-workbench-live/tests/test_stop_banner_human_review_body.py` — read the test fixtures and assertions to see what behavior the builder is pinned to. The 5-class structure (TestSummaryBullets / TestTestingLine / TestDiffstat / TestFullBanner / TestNoConfigFallback) mirrors the five body sections.
3. `agent-workbench-live/lib/cli/cmd_validate.py:557` and `cmd_followups.py:194` — confirm both real call sites pass `cfg=cfg`. One-line edits, but they're the integration points that make the new banner reach real users.
4. `docs/TODO.md` and `docs/LOG.md` — confirm the two-file contract: TODO §2 deleted, LOG 2026-05-25 entry added.
5. `agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/3_planning/plan.md` § "Decisions & assumptions" — read DR-001 through DR-004 to understand the load-bearing choices.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| AC-1: validate-equivalent flow produces 5 sections in order | `tests/test_stop_banner_human_review_body.py::TestFullBanner::test_five_sections_in_order` |
| AC-2: followups-equivalent flow produces byte-identical body | `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` (followups call sites assertions) + `TestE2EBounceLoop::test_bounce_loop` (same assertions on second landing) |
| AC-3: Review: section prints absolute path | `tests/test_stop_banner_human_review_body.py::TestFullBanner::test_five_sections_in_order` (asserts `str((rd / "HUMAN_REVIEW.md").resolve())` appears) |
| AC-4: Summary of changes: ≤3 bullets with `…(N more)` tail | `TestSummaryBullets::test_two_bullets_renders_both_no_tail`, `::test_five_bullets_truncates_with_tail` |
| AC-5: Each bullet single-line truncated at 100 columns | `TestSummaryBullets::test_long_bullet_truncated_at_column_cap` |
| AC-6: Summary of testing: 1 sentence default, 2 with manual, "None recorded." fallback | `TestTestingLine::test_passed_no_known_issues_no_manual_one_sentence`, `::test_failed_with_manual_testing_two_sentences`, `::test_no_qa_event_returns_none_recorded` |
| AC-7: Diffstat: target format OR "unavailable" fallback | `TestDiffstat::test_real_diff_renders_target_format`, `::test_unresolvable_symbolic_ref_returns_unavailable`, `::test_resolvable_empty_diff_returns_zero_files_changed` |
| AC-8: Next moves: exactly 3 slash-form lines, no `agent-workbench` shell form | `TestFullBanner::test_five_sections_in_order` (asserts presence of slash form + absence of shell form), E2E equivalents |
| AC-9: cmd_validate ad-hoc multi-paragraph block removed | inspection: `cmd_validate.py` flat-layout path now ends with branch/worktree/audit lines + `print_stop_banner(..., cfg=cfg)` — no other inline output |
| AC-10: cmd_followups terse next-moves replaced | inspection: `cmd_followups.py` default path's last lines are `print(...entries...)` + `print(...review path...)` + `print_stop_banner(..., cfg=cfg)` |
| AC-11: Banner is ASCII-only | `TestFullBanner::test_ascii_only_no_color_escapes` |
| AC-12 (tests): body assembly for 2/5/0-bullet × passed/failed × manual present/absent | TestSummaryBullets + TestTestingLine full matrix |
| AC-12 (E2E): both `/followups` and staged `/validate` lands assert path + 3 Next moves + diffstat | `tests/test_e2e.py::TestE2EHappyPath::test_happy_path`, `TestE2EBounceLoop::test_bounce_loop` |

## Deviations from plan

- The plan suggested a fixture-based snapshot test for the full banner across `happy/` and `bounce_pass2/`. The implementation chose to satisfy the drift-catching requirement via `TestFullBanner`'s structural assertions plus the E2E substring assertions, because absolute paths and tmpdir prefixes would make a static snapshot brittle. The fixture-based approach with `_normalize`-style helpers is captured as a follow-up so a future run can add it if drift becomes an issue. Net: equivalent assertion surface, fewer brittle file dependencies.

- The plan suggested that the `_SPECS["human_review"]` entry could either keep its old `next_moves` tuple (repurposed for slash-form) or drop it entirely. Implementation dropped it — slash-form lines live in `_HUMAN_REVIEW_NEXT_MOVES` and are rendered directly by `_render_next_moves_slash_form`. The `_BannerSpec` named-tuple still has the `next_moves` field (other states use it); the `human_review` spec sets it to an empty tuple to signal "body builder handles it".

## Known issues

None blocking. Two cosmetic / follow-up items:

- The `Summary of changes` rendering for this run shows a single bullet `"2 doc(s) touched:"` because the run's `build.md` was a stub template until late in the build (the actual implementation summary was authored after `validate --init` had already extracted the section). The renderer's `_extract_build_summary` correctly pulls top-level bullets only (per DR-002), so a header without nested content shows as a half-sentence with a trailing colon. This is a known quirk of the data, not the banner code — the same banner code, given a non-stub build.md, produces clean bullets. Worth noting in human-review summary so the reviewer knows the live dogfood shape isn't typical.
- The validate-context.md generator computes `git diff` against `<base_ref>...HEAD` of the target repo, not the worktree. With `base_ref: HEAD` and the target repo being master, this resolves to an empty diff. Captured as a follow-up (`bug_risk` category) in `follow-ups.md`.

## Commands run

```
python -m pytest agent-workbench-live/tests/
python -m pytest agent-workbench-live/tests/test_stop_banner.py agent-workbench-live/tests/test_stop_banner_human_review_body.py -v
python -m pytest agent-workbench-live/tests/test_e2e.py -v
WRITE_SNAPSHOTS=1 python -m pytest agent-workbench-live/tests/test_stop_banner.py::TestSnapshots -v
```

Final suite: 311 passed / 2 failed. The 2 failures are pre-existing date-baked snapshot drift in `tests/test_human_review.py::TestSnapshotRender` (the snapshot file bakes `2026-05-22-happy-snap` but today's run_id is `2026-05-25-happy-snap`). Verified against master at run-start to confirm they're not caused by this work.

## Documentation touched

- docs/TODO.md — deleted §2 ("Structured human_review handoff output") per the two-file contract in AGENTS.md
- docs/LOG.md — appended a 2026-05-25 entry covering what shipped, test counts, decision rationale highlights
