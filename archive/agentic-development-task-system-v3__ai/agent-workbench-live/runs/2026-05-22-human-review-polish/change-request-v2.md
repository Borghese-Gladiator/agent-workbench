# Change request v2 — Human Review polish (pass 3)

## Reviewer

timothy.shee — 2026-05-22

## Summary

Two concrete problems with the pass-2 render, plus one definitional drift in `qa/report.md` that we need to correct.

## Required changes

### CR-006 — Files-touched bullet must be a real list, not comma-soup

`lib/human_review.py::_extract_build_summary` currently produces:

```
- 4 file(s) touched: `a`, `b`, `c`, `d`
```

That collapses into an unreadable line at 4+ files. Replace with:

```
- 4 file(s) touched:
  - `agent-workbench-live/lib/human_review.py`
  - `agent-workbench-live/tests/test_human_review.py`
  - `agent-workbench-live/tests/snapshots/human_review_happy.expected.md`
  - `agent-workbench-live/tests/snapshots/human_review_bounce_pass2.expected.md`
```

Same shape for the `docs touched` bullet. Cap at 8 nested entries; on overflow show 8 and add a `  - …and N more` line. Add a unit test asserting the nested-bullet shape on a 4-file fixture and a `>8 files` truncation test.

### CR-007 — Rename "Manual testing performed" → "Testing"; split sub-sections

The section name was wrong: pytest output is not manual testing. Rename the heading and split the body:

```markdown
## Testing

**Unit tests**

`python -m pytest tests/ -q`

```
<inlined output>
```

✓ all green — 0 known issues.

**Manual testing**

<inlined body of qa/report.md's `## Manual testing` section, or `_None recorded._` when absent>

Review decision: **approve**.

Full QA report:

`<abs path>`
```

- Update `REQUIRED_HUMAN_REVIEW_HEADINGS` in `lib/lifecycle.py` to use `## Testing`.
- Update `tests/test_lifecycle.py::TestHumanReviewValidation` + `tests/test_transitions.py::TestStagedLayoutTransitions::test_followups_to_human_review_rejects_missing_sections` heading literals.
- Update both snapshot files.
- Two new unit tests: (a) Testing section contains both `**Unit tests**` and `**Manual testing**`; (b) Manual-testing body falls back to `_None recorded._` when `qa/report.md` has no such section.

### CR-008 — Fill `qa/report.md` with actual evidence (per its own template)

`agent-workbench-live/templates/qa/report.md` defines `## Results` with subsections for Unit / Integration / Lint / **Browser / Playwright** / Smoke. We've been writing only unit-test results and a one-line claim — that's a definitional regression from the template.

For pass 3:

- Drive a fresh staged E2E run end-to-end via the worktree's CLI (not just pytest). Capture the actual stdout from `agent-workbench followups <id>` — proving the `review:   <abs>` line really fires.
- Read the rendered HUMAN_REVIEW.md from that fresh run; paste a representative excerpt into `qa/report.md` under a new `## Manual testing` section.
- The renderer's new `**Manual testing**` sub-section then surfaces that excerpt automatically — closing the loop between "what we said we tested" and "what HUMAN_REVIEW.md shows."

This isn't a renderer change — it's a discipline fix in the QA artifact this run produces. The renderer change in CR-007 is what makes the discipline visible in HUMAN_REVIEW.md.

### CR-009 — Regenerate snapshots + dogfood again

Same as CR-005 before: after CR-006 + CR-007 land, regenerate `tests/snapshots/human_review_*.expected.md` via `AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1` and re-dogfood the renderer against this very run so the HUMAN_REVIEW.md you click reflects pass 3.

## Non-goals

- Don't redesign the timeline (still good).
- Don't change the Files section (CR-001 from v1 stuck).
- Don't add new event types.
