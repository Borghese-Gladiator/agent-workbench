# Human review — 2026-05-25-structured-human-review-handoff

## Files

- **Brief** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/2_shaping/brief.md`
- **Plan** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/4_building/build.md`
- **QA report** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/5_validating/qa/report.md`
- **Review decision** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/5_validating/review.md`
- **Follow-ups** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/6_followups/follow-ups.md`
- **Audit** — `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/audit.md`

## Summary of changes

- Replaced the static next-moves text on `human_review` landings with a structured five-section banner body sourced from HUMAN_REVIEW.md, the QA report, the latest `QACompleted` event, and a `git diff --shortstat` against the run's worktree.…
- 9 file(s) touched:
  - ``agent-workbench-live/lib/cli/_stop_banner.py` — added `_build_human_review_body(cfg, run_id)` plus helper functions (`_render_summary_bullets`, `_render_testing_line`, `_render_diffstat`, `_render_next_moves_slash_form`, `_extract_section`, `_truncate_inline`, `_latest_event`, `_resolve_qa_report_path`, `_manual_testing_recorded`, `_resolve_effective_ref`). Extended `print_stop_banner` with an optional `cfg=None` kwarg. The `_SPECS["human_review"]` entry no longer carries a static `next_moves` tuple — slash-form lines live in `_HUMAN_REVIEW_NEXT_MOVES` and are rendered by the body builder. Module grew from 88 LoC to ~315 LoC.`
  - ``agent-workbench-live/lib/cli/cmd_validate.py` — one-line edit at the flat-layout `print_stop_banner` call site (line 557) to pass `cfg=cfg`.`
  - ``agent-workbench-live/lib/cli/cmd_followups.py` — one-line edit at the staged `print_stop_banner` call site (line 194) to pass `cfg=cfg`.`
  - ``agent-workbench-live/tests/test_stop_banner.py` — updated `test_human_review_banner_structure` to assert slash-form decisions (`/complete <id>`, `/bounce <id>`, `/abandon <id>`) and to explicitly assert the absence of the shell-form `agent-workbench complete` substrings. The `Next moves` header string also changed to "Next moves (human-triggered, type in a session):".`
  - ``agent-workbench-live/tests/test_stop_banner_human_review_body.py` — new file. 24 unit cases across 5 test classes: TestSummaryBullets, TestTestingLine, TestDiffstat, TestFullBanner, TestNoConfigFallback. Each builder helper has independent test coverage; TestFullBanner integrates them.`
  - ``agent-workbench-live/tests/test_e2e.py` — extended `TestE2EHappyPath::test_happy_path` and `TestE2EBounceLoop::test_bounce_loop` to assert the five new section substrings appear in order on the `followups -> human_review` landings, plus slash-form presence and shell-form absence.`
  - ``agent-workbench-live/tests/snapshots/stop_banner_human_review.expected.txt` — re-baselined for the no-cfg minimal fallback shape (three slash-form `/complete`, `/bounce`, `/abandon` lines under the new "Next moves (human-triggered, type in a session):" header).`
  - ``docs/TODO.md` — deleted §2 ("Structured human_review handoff output"). No renumber needed; only §1 remained.`
  - …and 1 more
- 2 doc(s) touched:
  - `docs/TODO.md — deleted §2 ("Structured human_review handoff output") per the two-file contract in AGENTS.md`
  - `docs/LOG.md — appended a 2026-05-25 entry covering what shipped, test counts, decision rationale highlights`

→ Full diff: `/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/4_building/build.md`

## Testing

**Unit tests**

`python -m pytest agent-workbench-live/tests/`

```
- **tests_passed**: true
- **known_issues_count**: 0
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._

The change is exercised entirely by automated tests. A dogfood run against the workbench itself isn't possible in the same session because the CLI invoked by `agent-workbench validate` reads code from master (`AGENT_WORKBENCH_ROOT` resolves to the master checkout), not from the worktree — the new banner code only lives on the worktree branch until merge. This is the same chicken-and-egg constraint described in `docs/LOG.md` § 2026-05-24 entries for the auto-merge-on-complete and stop-banner runs.

Review decision: **approve**.

Full QA report:

`/Users/timothy.shee/GitHub/new-tech-monorepo/agentic-development-task-system-v3__ai/agent-workbench-live/runs/2026-05-25-structured-human-review-handoff/stages/5_validating/qa/report.md`

## Run timeline

- [04:22:58] SHAPING — entered shaping
- [04:24:44] PLANNING — entered planning
- [04:29:22] PLANNING — assumption ASM-001: The QA report's `## Manual testing` section is the workbench's canonical signal for whether a dogfood/manual run happened, and runs that record such a run do p…
- [04:29:22] PLANNING — assumption ASM-002: `git diff --shortstat <effective_ref>..HEAD` inside the run's worktree is correct for the banner's diffstat field — using the dotted form (`..`), not the three…
- [04:29:22] PLANNING — assumption ASM-003: The existing E2E fixtures (`tests/fixtures/happy/`, `tests/fixtures/bounce_pass2/`) produce a worktree whose HEAD differs from `base_ref` by at least one commi…
- [04:29:22] PLANNING — assumption ASM-004: The existing snapshot test for `human_review` at `tests/snapshots/stop_banner_human_review.expected.txt` represents the no-cfg minimal fallback after this chan…
- [04:29:22] PLANNING — assumption ASM-005: Both `cmd_validate.py`'s flat-layout `human_review` landing and `cmd_followups.py`'s staged landing have `cfg` in scope at the call site.
- [04:29:22] PLANNING — assumption ASM-006: It is acceptable for `print_stop_banner("human_review", run_id)` called without `cfg` to render only the three slash-form `/complete`, `/bounce`, `/abandon` Ne…
- [04:29:22] PLANNING — decision DR-001: Thread `cfg` as an optional kwarg into `print_stop_banner` rather than introducing a separate `print_human_review_banner` function.
- [04:29:22] PLANNING — decision DR-002: "Bullets" in the `## Summary of changes` section means **top-level `- ` lines only**, not the nested `  -` rows.
- [04:29:22] PLANNING — decision DR-003: Two distinct diffstat "no result" states — `unavailable (base_ref unresolved).` (cannot resolve a base ref) vs. `0 files changed, +0 / −0 lines` (resolved base…
- [04:29:22] PLANNING — decision DR-004: Heuristic for the "dogfood/manual run recorded" sentence is "the QA report's `## Manual testing` section has a non-empty body that isn't a `_None._`-class plac…
- [04:29:22] READY — entered ready
- [04:29:35] BUILDING — worktree at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__structured-human-review-handoff` on `agent/structured-human-review-handoff`
- [04:29:35] BUILDING — worktree on `agent/structured-human-review-handoff` at `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260525__structured-human-review-handoff`
- [04:42:02] VALIDATING — entered validating
- [04:44:39] VALIDATING — review decision: approve
- [04:44:39] VALIDATING — tests_passed=true; known_issues=0
- [04:44:39] FOLLOWUPS — entered followups
- [04:45:48] FOLLOWUPS — 4 follow-up(s) recorded (bug_risk, scope_extension, tech_debt)
- [04:45:51] FOLLOWUPS — handoff record created
- [04:45:51] HUMAN_REVIEW — handed off
