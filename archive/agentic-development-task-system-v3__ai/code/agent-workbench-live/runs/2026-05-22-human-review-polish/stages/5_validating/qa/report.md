# QA report — Human Review polish (pass 3)

## Summary

216 passed, 0 failed (baseline 193 + 23 new). Plus a real end-to-end dogfood run driven against the worktree's CLI — see ## Manual testing below.

- **tests_passed**: true
- **known_issues_count**: 0

## Results

### Unit tests

`python -m pytest tests/ -q` inside the worktree's `agent-workbench-live/` directory.

```
............................................................................ [ 33%]
............................................................................ [ 66%]
............................................................................ [100%]
216 passed in 18.08s
```

Coverage of the 23 new `tests/test_human_review.py` cases:

- **Project-timeline** (5): denylist drop, template-staged drop, shape regex, bounce row carries reason, handoff row says "handed off."
- **Build-summary extraction** (7): missing file, no headers, impl + files + AC fixture (revised for nested shape), docs touched (revised), docs-none skipped, 4-file nested-list, 12-file truncation.
- **Render** (8): all four required headings present, Files-section empty when no artifacts, Files-section shape (`- **<Label>** — \`<abs>\`` + abs-path prefix + exactly one backtick pair), Testing has both sub-headings, Testing inlines qa report as fenced block, Manual sub-section falls back to `_None recorded._`, Manual sub-section inlines `## Manual testing` from qa/report.md when present, idempotent re-render.
- **Snapshot** (2): happy + bounce_pass2 round-trip.
- **Stdout regression** (1): `followups` stdout contains the absolute path to HUMAN_REVIEW.md.

### Integration tests

`tests/test_e2e.py::TestE2EHappyPath::test_happy_path` and `::TestE2EBounceLoop::test_bounce_loop` assert the new `review:   <abs path>` stdout line on every `followups` invocation. Both pass.

## Manual testing

The renderer was driven end-to-end against the **worktree's CLI** (not pytest) via `/tmp/dogfood_e2e.py` — a Python script that:

1. Spins up a temp workbench root + a temp git repo;
2. Runs `agent-workbench new-run → shape → plan → start → validate → followups` against the worktree's `bin/agent-workbench` using the existing `tests/fixtures/e2e/happy/` stub-LLM fixture;
3. Captures real stdout from the final `followups` invocation;
4. Reads the rendered `HUMAN_REVIEW.md` from the temp run's root.

**Captured `agent-workbench followups <id>` stdout** (proves AC2 — the absolute path appears on stdout):

```
2026-05-22-dogfood-pass3: followups -> human_review
entries:  1 (tech_debt)
review:   /private/var/folders/mf/vwdv1gdx3cgf4722fskvskwm0000gp/T/aw-dogfood-jxm46klx/runs/2026-05-22-dogfood-pass3/HUMAN_REVIEW.md
```

**Excerpt of the rendered HUMAN_REVIEW.md** (proves the renderer produces the expected pass-3 shape in a real lifecycle pass, not just inside pytest's harness):

```markdown
## Files

- **Brief** — `/private/var/folders/.../runs/2026-05-22-dogfood-pass3/stages/2_shaping/brief.md`
- **Plan** — `/private/var/folders/.../runs/2026-05-22-dogfood-pass3/stages/3_planning/plan.md`
- **Build (diffs + AC coverage)** — `/private/var/folders/.../runs/2026-05-22-dogfood-pass3/stages/4_building/build.md`
- **QA report** — `/private/var/folders/.../runs/2026-05-22-dogfood-pass3/stages/5_validating/qa/report.md`
- **Review decision** — `/private/var/folders/.../runs/2026-05-22-dogfood-pass3/stages/5_validating/review.md`
- **Audit** — `/private/var/folders/.../runs/2026-05-22-dogfood-pass3/audit.md`

## Summary of changes

- Added a `hello` case to `bin/cli` that prints `hello, world`.
- 1 file(s) touched:
  - `bin/cli`
- AC coverage: 2/2 covered

→ Full diff: `/private/var/folders/.../runs/2026-05-22-dogfood-pass3/stages/4_building/build.md`

## Testing

**Unit tests**

`python -m pytest tests/ -q`

```
Ran `bin/cli hello`; exit 0, stdout matched `hello, world`. Tests pass.
```

✓ all green — 0 known issues.

**Manual testing**

_None recorded._
```

Both checks confirm pass-3 behavior end-to-end against the worktree's CLI. The `_None recorded._` fallback at the bottom of the excerpt is the expected output for the `tests/fixtures/e2e/happy/` fixture (its `qa/report.md` doesn't include a `## Manual testing` section, so the renderer's fallback fires — exactly as designed in CR-007).

### Lifecycle gate

`tests/test_lifecycle.py::TestHumanReviewValidation` (4 tests) and `tests/test_transitions.py::TestStagedLayoutTransitions::test_followups_to_human_review_rejects_missing_sections` updated to the new heading set and pass.

## Captured artifacts

- `tests/snapshots/human_review_happy.expected.md` — regenerated, 59 lines after pass 3.
- `tests/snapshots/human_review_bounce_pass2.expected.md` — regenerated, includes the post-bounce timeline rows.
- `/tmp/dogfood_e2e.py` — the dogfood driver (not checked in; reproducible from this report).
