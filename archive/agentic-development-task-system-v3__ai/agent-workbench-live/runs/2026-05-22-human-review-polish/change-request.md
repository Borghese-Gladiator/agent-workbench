# Change request — Human Review polish v2

## Reviewer

timothy.shee — 2026-05-22

## Summary

The v1 render still treats the reviewer like a workbench insider. Three problems break the "I only have this file open" promise:

1. **Relative-path column is dead weight.** The `## Files` table renders both Relative + Absolute. Without the worktree open, the relative path tells the reader nothing. The Absolute column is the only useful one.
2. **Absolute paths still aren't clickable in practice.** Most terminals/markdown viewers need each path on a single, unbroken line — wrapped paths (or paths embedded in a wider markdown table cell that line-wraps) won't auto-link. The current Files table jams everything into one row, which encourages soft-wrapping.
3. **No actual evidence of testing.** "Validation suite → tests_passed=true — ✓ all green" is a *claim*. The reviewer wants the **command that ran** and the **output that proves it passed**, inline. If they want depth, they'll click into `qa/report.md` — but the surface should answer "does it work" without a click.

## Required changes

### CR-001 — Drop the Relative column; make absolute paths the primary visual

Replace the three-column Files table with a single-column flat list. Each row is one artifact, one line, one absolute path inside backticks:

```markdown
## Files

- **Brief** — `/Users/.../runs/<id>/stages/2_shaping/brief.md`
- **Plan** — `/Users/.../runs/<id>/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/Users/.../runs/<id>/stages/4_building/build.md`
- ...
```

Rationale: one path per line means line-wrap can't break it; backticks make most terminal emulators tag the whole token as a click target; the absolute path is now the *only* path so there's nothing to compare against.

Drop the relative path entirely from this file. (It still lives in `audit.md` and the events log for anyone who needs it.)

### CR-002 — Inline the actual QA evidence

Replace the current outcome-claim block with a section that shows the **command** and the **output** verbatim, plus a one-line interpretation. Pull the command from `qa/commands.txt` if it exists, falling back to a sensible default (`python -m pytest tests/ -q`). Pull the output from `qa/report.md` — render its body (or its `## Summary` / `## Results` section if present) as a fenced block inside HUMAN_REVIEW.md.

Suggested shape:

```markdown
## Manual testing performed

`python -m pytest tests/ -q`

```
193 passed in 18.20s
```

✓ all green — 0 known issues.

Full report: `/Users/.../runs/<id>/stages/5_validating/qa/report.md`
```

The full path at the end is for "I want more"; the inline block is for "show me it works."

If `qa/commands.txt` is empty, render a `_(no command recorded — see qa/report.md)_` placeholder so the section is never blank.

If `qa/report.md` is structured (has a `## Summary` heading), inline the body of that section. Otherwise inline the whole file. Keep it short — cap at ~30 lines; if longer, truncate with `…` and the abs-path pointer.

### CR-003 — Apply the same "absolute path on its own line" rule to every link

- The `→ Full diff:` line in `## Summary of changes`: already one line; fine.
- The `Report:` line in `## Manual testing performed`: already one line; subsume into the new section per CR-002.
- The post-table `Human review (this file)` row: drop it (the reader already has the file).
- The footer `_Scope:_ <summary>` line is fine.

### CR-004 — Update snapshot tests + lifecycle gate

- Update both `tests/snapshots/human_review_*.expected.md` files. Bootstrap via `AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1`.
- The required-heading gate in `lib/lifecycle.py` stays at the same four headings (`## Files`, `## Summary of changes`, `## Manual testing performed`, `## Run timeline`); section *contents* change but heading names don't.
- The `tests/test_lifecycle.py` and `tests/test_transitions.py` heading literals don't need to change.
- Add a unit test that asserts every line in the Files section starts with `- **<Label>**` and contains exactly one backticked path. Add a unit test that asserts `## Manual testing performed` contains a fenced code block (the inline qa output).

### CR-005 — Verify with the dogfood run

Before declaring done, regenerate `runs/2026-05-22-human-review-polish/HUMAN_REVIEW.md` (run the renderer against this very run's events) and paste the result into the response. The reviewer reads it as if they had nothing else open.

## Non-goals

- Don't redesign the timeline section — the reviewer accepted that part.
- Don't change what `build.md` looks like.
- Don't add new event types.
