# Review — Human Review polish (pass 3)

## Decision

approve

## Did the implementation satisfy the change request?

Yes, all four CRs land cleanly:

- **CR-006** — `_extract_build_summary` returns pre-formatted markdown lines including nested `  - \`<path>\`` rows for files / docs touched, capped at 8 with a `…and N more` overflow row. Verified by `test_files_touched_renders_as_nested_list` (4-file fixture), `test_files_touched_truncates_above_cap` (12-file fixture → 8 shown + overflow line), and the two existing TestExtractBuildSummary cases (revised for the new shape).
- **CR-007** — `## Manual testing performed` is now `## Testing` with `**Unit tests**` and `**Manual testing**` sub-sections. The Manual sub-section is populated from `qa/report.md`'s `## Manual testing` body via the new `_read_manual_testing` helper, falling back to `_None recorded._`. `REQUIRED_HUMAN_REVIEW_HEADINGS` updated; `tests/test_lifecycle.py` + `tests/test_transitions.py` heading literals retargeted. Four new unit tests cover the structure + the new code path.
- **CR-008** — `qa/report.md` for this run carries an actual `## Manual testing` section with the captured stdout from a real `agent-workbench followups <id>` invocation against the worktree's CLI plus a pasted excerpt of the renderer's output. That closes the loop the v2 review correctly flagged: the QA artifact now matches the contract its own template defines.
- **CR-009** — Both snapshot files regenerated. The worktree-CLI dogfood (logged inline in `qa/report.md`) is itself the second-line dogfood the change request asked for.

## Did it accidentally expand scope?

No. Only the renderer, the lifecycle heading constant, and the three test files changed. No new event types, no template changes, no docs changes.

## Are there fragile assumptions?

- `_read_manual_testing` treats any of `_None._`, `_None recorded._`, `None.`, `None recorded.` (case-insensitive, trimmed) as "no body" and falls back to `_None recorded._`. If a QA author writes a different "no manual testing" phrase, the renderer will inline that phrase verbatim. Not a bug — the author signaling explicit absence is fine — but worth knowing.
- The nested-files cap (`SUMMARY_NESTED_CAP = 8`) is a hard literal. Easy to tune; not configurable per-run.

## Are there missing tests?

No. Every CR has an explicit test or an explicit assertion in an existing test. The snapshot files act as a third line of defense.

## Are there security / data loss / migration risks?

No. Renderer-internal change. No new IO, no shell-out, no metadata mutation. The lifecycle gate is unchanged in shape — same four required headings, just one renamed.

## What should the human review first?

1. The pass-3 happy snapshot (`tests/snapshots/human_review_happy.expected.md`) — this is the artifact you'll click. Read it end-to-end.
2. `qa/report.md`'s `## Manual testing` section — the new evidence block. The pasted followups stdout shows the `review:   <abs>` line really fires; the pasted HUMAN_REVIEW.md excerpt shows the pass-3 render produces the expected shape in a real lifecycle pass.
3. `lib/human_review.py::_extract_build_summary` + `_nested_path_list` + `_testing_block` + `_read_manual_testing` — the ~50 lines that implement the change request.

## Blast radius

depth 1 (changed files in pass 3):
- `agent-workbench-live/lib/human_review.py`
- `agent-workbench-live/lib/lifecycle.py`
- `agent-workbench-live/tests/test_human_review.py`
- `agent-workbench-live/tests/test_lifecycle.py`
- `agent-workbench-live/tests/test_transitions.py`
- `agent-workbench-live/tests/snapshots/human_review_*.expected.md`

depth 2 (callers of changed symbols):
- `human_review.render` — sole caller is `lib/cli/cmd_followups.py:run()`; signature unchanged.
- `lifecycle.REQUIRED_HUMAN_REVIEW_HEADINGS` — read by `lifecycle.validate_human_review_sections`; that's exercised by the transition engine on `followups → human_review`. The new heading set (`## Files`, `## Summary of changes`, `## Testing`, `## Run timeline`) is what the renderer now writes.

depth 3:
- `transitions.transition(..., "human_review", ...)` — called by `lib/cli/cmd_followups.py` and by every E2E test. The contract — "HUMAN_REVIEW.md exists with the four required headings" — is still satisfied.

Nothing in depth 2/3 lives outside the change request's scope.

## Findings

(no blocking findings)
