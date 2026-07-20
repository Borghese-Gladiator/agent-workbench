# Brief — Human Review polish

## Goal

`HUMAN_REVIEW.md` is the human's landing page when a run moves into `human_review`. Today it's awkward to use:

- File pointers are relative (`stages/4_building/build.md`) — not clickable from a text editor.
- The `human_review` transition surfaces the run id but not the path to `HUMAN_REVIEW.md` itself, so the reviewer has to hunt for it.
- "Suggested first checks" reads like a manual QA script the reviewer is expected to run by hand; in reality validation already ran the tests — the reviewer wants the result, not the recipe.
- "Run timeline" is too generic — every run says "draft created", "brief transcribed", "plan written". It never names *what* the brief said, *what* the plan decided, *what* the build delivered.
- No timestamps on the timeline, even though `events.jsonl` already carries ISO timestamps per event.
- No table-of-contents at the top, so click-to-open in a text editor is friction-heavy.

Treat `HUMAN_REVIEW.md` as a **launchpad**, not a checklist. Every interesting artifact should be one click away. Trust validation: surface what was tested and the result, not a script the human re-runs.

## User-facing behavior

When a staged-layout run transitions from `followups` → `human_review`, the renderer regenerates `HUMAN_REVIEW.md` so it carries:

1. **Files table** at the top — one row per artifact that actually exists. Each row has the artifact label, the relative path (readable on GitHub/in git diffs), and the absolute path (clickable from VS Code / terminal).
2. **`## Summary of changes`** — 3–5 bullets pulled from `build.md` describing what was delivered (files touched, AC coverage, test-count delta) followed by a one-line pointer to the absolute path of `build.md`.
3. **`## Manual testing performed`** — reports what `validate` already ran: command, outcome (read from `qa/report.md` / `events.jsonl`), one-line interpretation (`✓ all green` / `⚠ N known issues`). No imperative steps. A `## Needs human verification` block is rendered separately when applicable, empty by default.
4. **`## Run timeline`** — every row is `[HH:MM:SS] STAGE — what specifically happened`. Pulled from `events.jsonl`: `at`, `payload.summary`, artifact paths. No more `draft created` / `brief transcribed` boilerplate.

In the same transition, the slash command / CLI output (and the live board card body) prints the absolute path to `HUMAN_REVIEW.md` so the reviewer can click it directly.

## Acceptance criteria

- AC1. `HUMAN_REVIEW.md` opens with a `## Files` table whose absolute-path column is click-to-open in VS Code and the terminal. Only rows for files that exist on disk render.
- AC2. The `followups → human_review` transition stdout contains the absolute path to `HUMAN_REVIEW.md` (regression test asserts this on the staged-layout path in `cmd_followups`).
- AC3. No section instructs the human to run shell commands. The `## Manual testing performed` section reports outcomes only; the old `## Suggested first checks` shell block is removed.
- AC4. Every timeline row matches `[HH:MM:SS] STAGE — <specific description>`. None match the templated denylist (`template staged`, `draft created`, `brief transcribed`) without an additional specific clause. A unit test on the timeline projector asserts shape + denylist rejection.
- AC5. E2E snapshot tests cover the rendered `HUMAN_REVIEW.md` for the existing `happy/` and `bounce_pass2/` fixtures.
- AC6. The required-heading gate in the transition engine still passes for the new render (the existing `REQUIRED_HUMAN_REVIEW_HEADINGS` is updated to reflect the new section names).
- AC7. The workbench's full pytest suite (post-change) stays green.

## Non-goals

- Redesigning the review decision flow (`stages/5_validating/review.md`).
- Changing what the builder writes into `build.md`.
- Adding new event types to `events.jsonl` — this work only consumes existing fields (`ArtifactWritten.payload.summary`, `TransitionApplied.from`/`to`, `ReviewCompleted`, `QACompleted`, etc.).
- Touching the flat-layout (legacy) `handoff.md` flow.

## Good examples

A timeline row that meets the bar (drawn from the audit-unit-tests run):

- `[05:38:49] SHAPING — brief.md written: "audit unit tests for duplication across 6 modules; preserve regression locks"`
- `[05:40:10] PLANNING — plan.md written: DR-001..DR-004 (combined-assertions folds; no prod changes; single-commit landing)`
- `[05:58:14] BUILDING — baseline 193 tests; after pruning 134 tests (−59)`
- `[06:05:23] VALIDATING — review.md decision: approve; qa/report.md: tests_passed=true, known_issues=0`
- `[06:06:24] HUMAN_REVIEW — handed off`

A `## Manual testing performed` block that meets the bar:

```markdown
## Manual testing performed

- `python -m pytest tests/ -q` → **193 passed, 0 failed** — ✓ all green
- Doc-claims check → 0 unverified entries
- Scope-creep check → 0 unexpected files

## Needs human verification

_None._
```

## Bad examples

A timeline row that does NOT meet the bar (the current template output):

- `[05:38:49] SHAPING — brief transcribed`
- `[05:40:10] PLANNING — plan written`

A `## Manual testing performed` block that does NOT meet the bar (this is what `## Suggested first checks` does today):

```bash
# From inside the worktree's agent-workbench-live/ directory:
python -m pytest tests/ -q
# Expect: 134 passed
```

(Imperative; asks the reviewer to run commands; recipe rather than result.)

## Constraints

- Stay inside the staged-layout path (`lifecycle.is_staged_run`); the flat-layout legacy path keeps writing `handoff.md` unchanged.
- The transition engine's required-heading gate must still validate the rendered file — if section names change, update `lifecycle.REQUIRED_HUMAN_REVIEW_HEADINGS` accordingly.
- Render at the same moment the existing flow renders (when `followups` → `human_review` fires, i.e. inside `cmd_followups`).
- Absolute paths are the raw filesystem path (no `~`-expansion shortening). Tests should snapshot the file using a path-normalizer so the fixture snapshot doesn't bind to a specific home dir.

## Assumptions

- The existing `audit.py` module already shows the right interface for reading `events.jsonl` (`events_mod.iter_events`). The new renderer uses the same primitive.
- The `payload.summary` field on `ArtifactWritten` is the canonical place to get a one-line description of an artifact. When it equals the literal `"template staged"`, the row is *uninteresting* — the renderer should look past it to a later artifact write (or to a subsequent stage event) that has real content.
- `build.md` carries a stable section for "Files touched" / "Acceptance criteria coverage" / "Test count" that the renderer can extract by header match. If a build.md doesn't have those headers, the Summary block falls back to a single line `→ Full diff: <abs path to build.md>` with no bullets.
- The E2E fixtures under `tests/fixtures/e2e/` (or wherever the existing `happy/` and `bounce_pass2/` fixtures live) drive `record_run` through to `human_review`; the new snapshot test reads the rendered `HUMAN_REVIEW.md` and compares against a checked-in `.expected` file.

## Suggested QA scenarios

1. **Happy fixture snapshot.** Drive the `happy/` E2E fixture to `human_review`; the rendered `HUMAN_REVIEW.md` matches the new `.expected` file. Paths in the snapshot use a placeholder like `<RUN_ROOT>` so the test is portable.
2. **Bounce fixture snapshot.** Same for `bounce_pass2/`. The timeline reflects the bounce (a `human_review → building` transition row appears between the two validating passes).
3. **Transition stdout regression.** Drive a fresh staged run to `human_review`; assert the captured stdout from `agent-workbench followups <id>` contains the absolute path to `HUMAN_REVIEW.md`.
4. **Timeline projector denylist.** Synthesize a fixture `events.jsonl` with one `ArtifactWritten` row whose `payload.summary == "template staged"` and another whose summary is `"brief.md written: …"`. The projector returns one row (the specific one) and skips the template-staged row, or merges it with the next non-templated event for that stage.
5. **Files-table filtering.** Synthesize a run where `follow-ups.md` was never written; the rendered table omits the Follow-ups row entirely (does not render an absent-file row).
6. **Required-heading gate compatibility.** Run the existing `validating → human_review` transition test (or `followups → human_review`); the gate still passes against the new render.

