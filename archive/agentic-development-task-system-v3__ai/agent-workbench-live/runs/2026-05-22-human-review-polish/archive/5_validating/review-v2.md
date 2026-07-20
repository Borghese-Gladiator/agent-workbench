# Review — Human Review polish (pass 2)

## Decision

approve

## Did the implementation satisfy the change request?

Yes, point-for-point:

- **CR-001 (single-column Files list)** — `lib/human_review.py::render` no longer emits a Markdown table for the Files section. Each existing artifact renders as `- **<Label>** — \`<abs path>\``, one row per line. The Relative column is gone; the self-reference "Human review (this file)" row is dropped. Verified by `test_files_section_format_one_line_per_artifact` (asserts shape + backtick count + abs-path prefix) and `test_files_section_omits_missing_files` (asserts the section has zero rows when no artifacts exist).
- **CR-002 (inline qa evidence)** — `_testing_block` now reads `qa/commands.txt` (default `python -m pytest tests/ -q`) and the body of `qa/report.md` (preferring `## Summary` / `## Results` if present, falling back to whole file minus the H1). Output goes as backticked command + fenced code block + one-line verdict + trailing absolute path. Verified by `test_manual_testing_inlines_qa_report_as_fenced_block` and `test_manual_testing_falls_back_when_qa_missing`.
- **CR-003 (abs path on its own line)** — each Files row is one path. The trailing `Full QA report:` block is one path on its own line. The pre-existing `→ Full diff:` line was already one path on its own line and is unchanged.

## Did it accidentally expand scope?

No. Only `lib/human_review.py` and the test files changed. No new event types, no lifecycle gate changes, no template files touched, no docs changes.

## Are there fragile assumptions?

- The new `_read_report_body` matches `## Summary` and `## Results` headings literally. If a builder names their summary section something else (`## TLDR`, `## Outcome`), the renderer falls through to "whole file minus title". That's a documented fallback, not a bug.
- `QA_INLINE_MAX_LINES = 30` is a hard cap. A real-world QA report that exceeds 30 lines will be truncated with `…`. The trailing absolute-path pointer gives the reviewer a path to the full text, so the cap is non-lossy in practice.

## Are there missing tests?

No. Every CR has a matching test or matching assertion in an existing test. The snapshot files act as a third line of defense — any future renderer change that breaks the contract will fail snapshot equality.

## Are there security / data loss / migration risks?

No. The change is renderer-internal. No new IO, no shell-out, no metadata mutation. The lifecycle gate is unchanged — same four required headings.

## What should the human review first?

1. The two regenerated snapshots under `tests/snapshots/`. Read them as the artifact you'll receive.
2. The Files-section block in `lib/human_review.py::render` (the ~10-line change).
3. `_testing_block` in `lib/human_review.py` — the bulk of pass-2 logic.

## Blast radius

depth 1 (changed files in pass 2):
- `agent-workbench-live/lib/human_review.py`
- `agent-workbench-live/tests/test_human_review.py`
- `agent-workbench-live/tests/snapshots/human_review_*.expected.md`

depth 2 (callers of changed symbols):
- `human_review.render` — called only by `lib/cli/cmd_followups.py:run()`. Signature unchanged (`cfg, run_id`), so the call site is untouched.
- `human_review._testing_block` — internal; called only by `render`. Signature gained `commands_path` arg.

depth 3:
- `cmd_followups.run` — called by the `agent-workbench followups` CLI subcommand and by `tests/test_e2e.py` + `tests/test_human_review.py`. The contract they observe is "HUMAN_REVIEW.md exists at run root and has the four required headings", which pass-2 still satisfies.

Nothing in depth 2/3 lives outside the change request's scope.

## Findings

(no blocking findings)
