# Build report — Human Review polish (pass 3)

## Implementation summary

Pass 3 addresses three points raised against the pass-2 render: files-touched flattened into a nested bullet list (CR-006), `## Manual testing performed` renamed to `## Testing` with `**Unit tests**` and `**Manual testing**` sub-sections (CR-007), and `qa/report.md` now carries an actual `## Manual testing` section populated by driving a fresh staged run end-to-end through the worktree's CLI (CR-008).

## Files changed

- `agent-workbench-live/lib/human_review.py`
- `agent-workbench-live/lib/lifecycle.py`
- `agent-workbench-live/tests/test_human_review.py`
- `agent-workbench-live/tests/test_lifecycle.py`
- `agent-workbench-live/tests/test_transitions.py`
- `agent-workbench-live/tests/snapshots/human_review_happy.expected.md`
- `agent-workbench-live/tests/snapshots/human_review_bounce_pass2.expected.md`

## Reviewer reading order

1. `lib/human_review.py::_extract_build_summary` + the new `_nested_path_list` helper — the CR-006 change. Returns a list of pre-formatted markdown lines (parent + nested) instead of a list of plain strings.
2. `lib/human_review.py::_testing_block` + the new `_read_manual_testing` helper — the CR-007 change. Two `**Unit tests**` / `**Manual testing**` sub-sections.
3. `lib/lifecycle.py` lines 53-58 — the `REQUIRED_HUMAN_REVIEW_HEADINGS` rename.
4. `tests/test_human_review.py::TestRender` block — new unit tests for the two-subheading structure, the nested files list, and the truncation cap.
5. `tests/snapshots/human_review_happy.expected.md` — read this end-to-end as the artifact you'll receive.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| CR-006 (nested files-list with cap) | `test_files_touched_renders_as_nested_list` asserts the parent bullet + 4 nested rows. `test_files_touched_truncates_above_cap` asserts the `…and N more` overflow line at 12 files. `test_pulls_implementation_files_and_ac_count` (revised) asserts the nested shape on a 2-file fixture. `test_docs_touched_renders_as_nested_list` asserts the same shape for docs. |
| CR-007 (Testing rename + two sub-sections) | `test_testing_section_has_unit_and_manual_subheadings` asserts both bolded sub-headings exist and Unit precedes Manual. `test_testing_section_inlines_qa_report_as_fenced_block` asserts the unit-test sub-section still inlines the report's Summary. `test_manual_testing_falls_back_to_none_recorded` asserts the fallback string. `test_manual_testing_inlines_qa_manual_section_when_present` asserts the new code path that pulls `## Manual testing` out of qa/report.md. `lib/lifecycle.py` heading set updated; `tests/test_lifecycle.py` + `tests/test_transitions.py` heading literals retargeted. |
| CR-008 (real qa evidence + dogfood) | `qa/report.md` for THIS run carries a `## Manual testing` section with the actual stdout from a fresh `agent-workbench followups <id>` run driven against the worktree's CLI. That stdout proves the `review:   <abs>` line fires; the pasted HUMAN_REVIEW.md excerpt proves the renderer produces the expected output in a real lifecycle pass, not just under pytest. |
| CR-009 (snapshot + dogfood) | Both `tests/snapshots/human_review_*.expected.md` regenerated. The pass-3 renderer is run against this very run (see Manual testing in qa/report.md). |

## Deviations from plan

None. CR-006..CR-009 land exactly as scoped.

## Known issues

None new. The two-near-identical-worktree-rows cosmetic remains queued.

## Commands run

```bash
python -m pytest tests/ -q
# 193 -> 216 green.
AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1 python -m pytest tests/test_human_review.py::TestSnapshotRender -v
# Regenerated both snapshot files; rerun without the env var confirms equality.
python3 /tmp/dogfood_e2e.py
# Drove a fresh happy E2E against the worktree's CLI; captured real stdout + the
# rendered HUMAN_REVIEW.md; pasted both into qa/report.md's ## Manual testing
# section.
```

## Documentation touched

- (none — pass-3 is renderer-internal. The TODO.md ✅ summary and LOG.md entry from pass 1 still describe the feature accurately; only the rendered output changed shape.)
