# Build report — Human Review polish

## What changed

Replaced LLM-authored `HUMAN_REVIEW.md` with a code-derived render produced by a new `lib/human_review.py` module. The renderer is invoked by `cmd_followups.run` immediately before the `followups → human_review` transition fires, so it owns the file content going forward. Required headings in `lib/lifecycle.py` updated to the four sections the renderer writes (`## Files`, `## Summary of changes`, `## Manual testing performed`, `## Run timeline`). The `cmd_followups` stdout grew one line (`review:   <abs path>`) so the reviewer can click straight into the file from the terminal. Unit + snapshot tests cover the renderer; the `happy/` and `bounce_pass2/` E2E flows now snapshot the rendered output.

## Implementation summary

The renderer is a pure projection of `events.jsonl` + `metadata.yaml` + the artifacts each stage already wrote. No new event types. Files-table candidates are hardcoded against the staged-layout invariant; rows whose target file doesn't exist are dropped. The `## Summary of changes` bullets are extracted from `build.md` (`## Implementation summary`, `## Files changed`, `## Acceptance criteria coverage`, `## Documentation touched`); when those headers are absent the section degrades to a `→ Full diff:` line. The `## Manual testing performed` block reports outcomes from `QACompleted` / `ReviewCompleted` / `DocClaimsVerified` / `ScopeCreepChecked` events — never imperative commands. The `## Run timeline` walks every interesting event, formats `[HH:MM:SS] STAGE — <description>`, and applies a denylist (`template staged`, `draft created`, `brief transcribed`, `plan written`) so boilerplate `ArtifactWritten` rows don't pollute the output.

## Files changed

- `agent-workbench-live/lib/human_review.py` (new)
- `agent-workbench-live/lib/lifecycle.py`
- `agent-workbench-live/lib/cli/cmd_followups.py`
- `agent-workbench-live/templates/HUMAN_REVIEW.md`
- `agent-workbench-live/tests/test_human_review.py` (new)
- `agent-workbench-live/tests/test_e2e.py`
- `agent-workbench-live/tests/test_lifecycle.py`
- `agent-workbench-live/tests/test_transitions.py`
- `agent-workbench-live/tests/snapshots/human_review_happy.expected.md` (new)
- `agent-workbench-live/tests/snapshots/human_review_bounce_pass2.expected.md` (new)
- `docs/TODO.md`
- `docs/LOG.md`

## Reviewer reading order

1. `lib/human_review.py` — the new renderer. Start with `render()` (bottom of file), then read upward through `project_timeline`, `_describe`, `_extract_build_summary`, and the `FILE_TABLE_CANDIDATES` constant. The module is intentionally one file: every helper is exercised by a unit test in `tests/test_human_review.py`.
2. `lib/cli/cmd_followups.py` — the two-line change that wires the renderer in (call `human_review.render(...)` before `transitions.transition(...)`) plus the new `print(f"review:   {handoff_path}")` line.
3. `lib/lifecycle.py` (lines 53-57) — the new `REQUIRED_HUMAN_REVIEW_HEADINGS` tuple. This is the contract the renderer must satisfy.
4. `tests/test_human_review.py` — unit tests + the snapshot tests. Read the `_normalize` helper carefully; it's the bit that makes the snapshots portable across machines.
5. `tests/snapshots/human_review_happy.expected.md` and `tests/snapshots/human_review_bounce_pass2.expected.md` — the snapshot output. Eyeball them as a reviewer would; if anything reads off, the renderer needs adjustment.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| AC1 (clickable Files table, only existing files) | `tests/test_human_review.py::TestRender::test_files_table_omits_missing_files` + `test_files_table_includes_existing_files` + the snapshots (each shows absolute paths in the `Absolute (click)` column). |
| AC2 (transition stdout has absolute path) | `tests/test_human_review.py::TestTransitionStdoutHasAbsolutePath::test_followups_stdout_contains_absolute_human_review_path` + the AC2 assertions added to `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` and `::TestE2EBounceLoop::test_bounce_loop`. |
| AC3 (no shell-command instructions) | Source check: the renderer never emits a `bash`/`fenced` block; the `## Manual testing performed` section is bullet-only. Verified by the snapshots. |
| AC4 (every timeline row is `[HH:MM:SS] STAGE — …`, no denylisted descriptions) | `tests/test_human_review.py::TestProjectTimeline::test_every_row_has_required_fields` + `test_template_staged_artifactwritten_dropped` + `test_denylist_rejects_generic_descriptions` + `test_bounce_row_includes_reason` + `test_handoff_row_uses_handed_off_phrase`. |
| AC5 (snapshot tests for happy + bounce_pass2) | `tests/test_human_review.py::TestSnapshotRender::test_happy_snapshot` + `::test_bounce_pass2_snapshot`. Snapshots live in `tests/snapshots/`. |
| AC6 (heading gate still passes for the new render) | The four required headings in `lib/lifecycle.py` match exactly what `human_review.render` writes; the transition engine's gate runs immediately after the render and is exercised by every E2E test (210 passed). Updated `tests/test_lifecycle.py::TestHumanReviewValidation` + `tests/test_transitions.py::TestStagedLayoutTransitions::test_followups_to_human_review_rejects_missing_sections` to the new heading set. |
| AC7 (full test suite green) | 210 passed (baseline 193 + 17 new). |

## Deviations from plan

- The plan said the renderer would extract bullets from `build.md`'s `## Implementation summary` / `## Files changed` / `## Acceptance criteria coverage` sections — done. While there, the renderer also pulls a `## Documentation touched` bullet when that section is present and non-`(none)`. Small addition; covered by `tests/test_human_review.py::TestExtractBuildSummary::test_docs_touched_bullet_added` + `test_docs_touched_none_entry_skipped`.
- The plan kept the fixture `HUMAN_REVIEW.md` files under `tests/fixtures/e2e/*/validating/` as dead content (DR-003). That's what landed — the renderer overwrites them at `cmd_followups` time, so their stub-LLM-staging is effectively a no-op.
- The plan called for a denylist that the renderer applies to *all* row descriptions. The implementation applies the denylist to the final description string (lowercased + stripped), which only kicks in for events whose `_describe` projection yields *exactly* one of the denylist phrases. The intent — drop the generic boilerplate rows — is achieved more cleanly by dropping `ArtifactWritten` rows whose `payload.summary == "template staged"` directly inside `_describe`. The denylist constant + check at the projection layer is kept as a belt-and-braces second line of defense.

## Known issues

- The `WorktreeCreated` event and the `TransitionApplied: ready → building` event both project to a "worktree at … on …" / "worktree on … at …" row at the same timestamp; the timeline shows both. Cosmetic, not actionable. A future pass could dedupe by timestamp + payload similarity.
- Snapshot tests bind to two specific E2E fixtures (`happy/`, `bounce_pass2/`). If those fixtures' canned content changes, the snapshots need a manual `AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1` run. This is by design (matches the TODO §2 contract); the snapshot harness mentions the env var in the assertion message.

## Commands run

```bash
# Inside the worktree, agent-workbench-live/ directory:
python -m pytest tests/ -q
# Baseline: 193 passed. Final: 210 passed.
python -m pytest tests/test_human_review.py -v
# 17 new tests pass.
AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1 python -m pytest tests/test_human_review.py::TestSnapshotRender -v
# Bootstrap-only; rerun without the env var to confirm snapshots match.
```

## Documentation touched

- `docs/TODO.md` — deleted §2; moved a ✅ summary into the new "Completed work" block at the top; renumbered §3 → §2.
- `docs/LOG.md` — appended a Human Review polish paragraph under the existing `2026-05-22` section.
