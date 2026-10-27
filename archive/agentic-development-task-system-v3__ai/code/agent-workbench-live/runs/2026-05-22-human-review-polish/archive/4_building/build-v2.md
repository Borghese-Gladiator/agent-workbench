# Build report — Human Review polish (pass 2)

## What changed

Pass-2 addresses the three concerns the reviewer raised in `change-request.md`:

1. **Files section is now a flat list, one absolute path per line.** The three-column Markdown table (Artifact | Relative | Absolute) is gone. Each row is `- **<Label>** — \`<abs path>\``, so the absolute path stands alone and most terminals tag it as a single click target. The Relative column carried no information the reviewer could use (they don't have the worktree open) and is dropped. The self-reference "Human review (this file)" row is also dropped — the reader already has the file.
2. **`## Manual testing performed` now carries actual evidence inline.** A new `_testing_block` reads `qa/commands.txt` (falling back to `python -m pytest tests/ -q`) and the body of `qa/report.md` (preferring its `## Summary` or `## Results` section if present). The command renders as a backticked line; the report body inlines as a fenced code block; a one-line verdict (`✓ all green — 0 known issues.` / `⚠` / `✕`) follows; the absolute path to `qa/report.md` is a trailing pointer for "I want more."
3. **No more "Reviewer doesn't have the worktree" assumptions.** No relative paths anywhere; every clickable target is an absolute path on its own line.

## Implementation summary

`lib/human_review.py`: two surface changes. The Files-section block (`render()`) writes a bullet list instead of a Markdown table; the testing block (`_testing_block`) gains a `commands_path` argument and renders command + inlined report body + verdict. New helpers: `_read_command(commands_path)` (skip blank/comment lines), `_read_report_body(qa_path)` (prefer Summary/Results, fall back to whole file minus title), `_truncate(text, n)` (`QA_INLINE_MAX_LINES = 30`).

## Files changed

- `agent-workbench-live/lib/human_review.py`
- `agent-workbench-live/tests/test_human_review.py`
- `agent-workbench-live/tests/snapshots/human_review_happy.expected.md`
- `agent-workbench-live/tests/snapshots/human_review_bounce_pass2.expected.md`

## Reviewer reading order

1. `lib/human_review.py` — read `render()` (the Files-section change is ~10 lines) and then `_testing_block` + its three new helpers. Whole module remains one file.
2. `tests/snapshots/human_review_happy.expected.md` — this is the artifact you'll actually receive. Eyeball it as a reviewer would. Compare lines 5-10 (Files) and lines 20-33 (Manual testing performed) against pass-1.
3. `tests/test_human_review.py::TestRender::test_files_section_format_one_line_per_artifact` — the new test that locks in the per-row shape.
4. `tests/test_human_review.py::TestRender::test_manual_testing_inlines_qa_report_as_fenced_block` — the new test that locks in the inlined evidence.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| CR-001 (single-column Files list, abs path only) | `test_files_section_format_one_line_per_artifact` asserts every row matches `- **<Label>** — \`<abs path>\`` exactly, contains exactly one backticked path, and that path is absolute. `test_files_section_omits_missing_files` confirms only existing files render. |
| CR-002 (inline qa evidence) | `test_manual_testing_inlines_qa_report_as_fenced_block` asserts the section contains a fenced code block and the inlined report body. `test_manual_testing_falls_back_when_qa_missing` confirms the section is never blank. The default command (`python -m pytest tests/ -q`) and the report's Summary-preferring extraction are both exercised. |
| CR-003 (abs path on its own line) | The new Files-section rows are by construction one path per line; the self-reference row was dropped; the trailing `Full QA report:` block puts the path on its own line. The `→ Full diff:` line was already on its own line and is unchanged. |
| CR-004 (snapshots + new unit tests) | Both `tests/snapshots/human_review_*.expected.md` regenerated; the three new unit tests pass. |
| CR-005 (dogfood) | The renderer is run against this very run when the second-pass validate cycle re-enters `cmd_followups`. The rendered HUMAN_REVIEW.md becomes this run's handoff artifact and is the verifier for "I have no worktree open." |

## Deviations from plan

None. The change request was a tight three-point ask and pass-2 lands exactly those three points.

## Known issues

None new. The pass-1 "two near-identical worktree timeline rows" cosmetic still applies; it remains queued as a follow-up (see `follow-ups.md`).

## Commands run

```bash
# Inside the worktree, agent-workbench-live/ directory:
python -m pytest tests/ -q
# 193 baseline -> 212 final (19 new tests in test_human_review.py)
AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1 python -m pytest tests/test_human_review.py::TestSnapshotRender -v
# Regenerated the two snapshot files; rerun without the env var confirms equality.
```

## Documentation touched

- (none — pass-2 is renderer-internal and doesn't change user-facing docs. The TODO.md ✅ summary and LOG.md entry from pass-1 remain accurate.)
