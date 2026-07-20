# Implementation plan — Human Review polish

## Current repo understanding

The workbench's `HUMAN_REVIEW.md` is the reviewer's landing page when a staged run reaches `human_review`. Today it is **not rendered by code** — it is authored by the LLM in `/validate` (or copied verbatim from a fixture via `lib/stub_llm.py` when E2E stub mode is on). The transition engine only checks that two required headings (`## Suggested first checks` and `## Run timeline`) are present in the file at the moment `followups -> human_review` fires (`lib/lifecycle.py:53` and `lib/lifecycle.py:346`).

There is no equivalent of `lib/audit.py` for `HUMAN_REVIEW.md`. The audit module **does** show how to walk `events.jsonl` and pull `payload.summary` / `from` / `to` — the new renderer reuses that pattern.

The `followups -> human_review` transition fires from `lib/cli/cmd_followups.py` (default mode). It already has the run's metadata, the events stream, and the absolute paths to all artifacts. It already prints two lines to stdout (`{run_id}: followups -> human_review` and `entries: …`). Adding a third "review:" line with the absolute path is a one-line change.

There is no existing `tests/snapshots/` directory; tests are unittest-based and stored alongside `tests/test_*.py`. The E2E test harness already drives `happy/` and `bounce_pass2/` runs through to `done` and inspects the rendered file paths; the snapshot test bolts onto that flow.

## Relevant files

- `lib/lifecycle.py` — owns `REQUIRED_HUMAN_REVIEW_HEADINGS` (line 53) and `validate_human_review_sections` (line 346). The required headings must change to match the new render.
- `lib/audit.py` — shows the existing events-walk pattern (`events_mod.iter_events`). The new renderer module mirrors its shape (pure function over cfg + run_id, writes a file at run root, returns the path).
- `lib/cli/cmd_followups.py` — where the new renderer is called from, and where the new stdout line is added.
- `lib/cli/cmd_bounce.py` — references `HUMAN_REVIEW.md`; not modified by this run (only printed on bounce).
- `lib/events.py` — `iter_events(cfg, run_id)` is the reader API the renderer uses.
- `templates/HUMAN_REVIEW.md` — old template (kept; stub-LLM uses it only as a fallback). The fixture-driven content is overwritten by the renderer, so the template's role is reduced to "what gets written if a non-stub-LLM author never writes the file" — but the renderer will overwrite even that, so the template becomes vestigial. We leave it in place rather than delete it (out of scope).
- `tests/test_e2e.py` — current happy/bounce_pass2 drivers. New tests bolt on, asserting against the rendered HUMAN_REVIEW.md.
- `tests/test_lifecycle.py` (lines 220-251) — `TestHumanReviewValidation` asserts the old heading set. Update the literal strings in this test to match the new required headings.
- `tests/fixtures/e2e/{happy,bounce_pass2}/validating/HUMAN_REVIEW.md` — these are stub-LLM source files. Since the renderer overwrites HUMAN_REVIEW.md at `cmd_followups` time, the **content** of these fixture files becomes a no-op (the renderer always wins). We leave the fixture files in place — they still satisfy the `_STAGE_FILES` mapping in `lib/stub_llm.py` even though their content is discarded by the renderer. (Alternative: drop them from `stub_llm.py`'s `validating` tuple. Decided no — see DR-003.)
- `tests/snapshots/` (new) — directory to hold checked-in `.expected.md` files for the snapshot tests. Snapshot files normalize absolute paths to `<RUN_ROOT>` and timestamps to `<HH:MM:SS>` so they're portable.

## Proposed changes

### A. New renderer module `lib/human_review.py`

Pure function `render(cfg, run_id) -> pathlib.Path`. Idempotent (overwrites). Steps:

1. Load metadata and `events.jsonl`.
2. Walk every artifact path in the `## Files` table candidates (see below); keep only the ones that exist. The candidate list is hardcoded (the staged-layout invariant pins each artifact to a known path) — no dynamic discovery.
3. Pull `build.md` and extract the "Summary of changes" bullets via a header-matcher (looks for `## Implementation summary`, `## Files changed`, and the AC table). Fall back to a single `→ Full diff:` line when the headers are absent.
4. Pull the `## Manual testing performed` payload from `events.jsonl`'s `QACompleted` and `qa/report.md`.
5. Build the timeline by walking `events.jsonl`: extract `(at, status_or_to, payload.summary, type)` from a curated set of event types (TransitionApplied, ArtifactWritten, ReviewCompleted, QACompleted, FollowupsRecorded, BounceRequested, WorktreeCreated, HumanHandoffCreated). For each row, format `[HH:MM:SS] STAGE — <description>`.
6. Write the file at run root.

The renderer is **the** producer of HUMAN_REVIEW.md going forward. The transition engine still validates required headings — but those headings now match what the renderer writes (`## Files`, `## Summary of changes`, `## Manual testing performed`, `## Run timeline`).

### B. Timeline projector — substring inside `lib/human_review.py`

Function `project_timeline(events: Iterable[dict]) -> list[TimelineRow]` is the unit-testable core:

- One row per "interesting" event. Skip `ArtifactWritten` rows whose summary is exactly `"template staged"` (the renderer hides these because they're not informative — the next non-template artifact write or the next TransitionApplied for the same stage carries the real story).
- A denylist (`{"template staged", "draft created", "brief transcribed", "plan written"}`) is applied: any row whose description, after specific-field projection, matches one of these literally with no extra context is rejected (caller treats the row as merge-with-next or skip).
- Output rows have `(at_hhmmss: str, stage: str, description: str)`. The stage is the event's `status` field, uppercased.

### C. Wire renderer into `cmd_followups`

Inside `cmd_followups.run`, default mode (followups → human_review):

1. **Before** the transition call (so the heading gate sees the rendered file): call `human_review.render(cfg, run_id)`. Renderer overwrites whatever was authored / stub-copied earlier.
2. **After** the successful transition: print a new line `review:   {abs_path_to_HUMAN_REVIEW.md}` so the reviewer can click it in their terminal/editor.

### D. Update required headings

`REQUIRED_HUMAN_REVIEW_HEADINGS` in `lib/lifecycle.py` becomes:

```python
REQUIRED_HUMAN_REVIEW_HEADINGS = (
    "## Files",
    "## Summary of changes",
    "## Manual testing performed",
    "## Run timeline",
)
```

The old `## Suggested first checks` heading is intentionally dropped.

### E. Tests

- `tests/test_human_review.py` (new) — unit tests for:
  - `project_timeline` shape: every returned row has `at_hhmmss`, `stage`, and a non-empty `description`.
  - Denylist rejection: a synthesized event list with a "template staged" `ArtifactWritten` row produces zero rows for that event (or merges into the next non-template event for the same stage).
  - Files-table filtering: when `follow-ups.md` is absent, the Files row for "Follow-ups" is omitted.
  - `render` writes a file containing every required heading (sanity check that the lifecycle gate stays satisfied).
- `tests/test_e2e.py` — extend with two new assertions piggybacking on the existing `test_happy_path` and `test_bounce_loop` runs:
  - The captured `agent-workbench followups <id>` stdout contains the absolute path to `HUMAN_REVIEW.md` (AC2 regression test).
  - The rendered `HUMAN_REVIEW.md` matches `tests/snapshots/human_review_happy.expected.md` (after path/timestamp normalization). Same for bounce_pass2.
- `tests/test_lifecycle.py::TestHumanReviewValidation` — update the literal headings used in the fixture text to match the new required set (the gate test stays).

### F. Snapshot files

Two new files under `tests/snapshots/`:

- `human_review_happy.expected.md`
- `human_review_bounce_pass2.expected.md`

Path normalizer replaces the absolute run-root prefix with `<RUN_ROOT>`. Timestamps `[HH:MM:SS]` are replaced with `[<HH:MM:SS>]` (because each test run produces fresh timestamps). The snapshot tooling is a tiny helper in `tests/test_human_review.py` — no new test framework, just `re.sub` + `assertMultiLineEqual`.

## Files likely to change

- `agent-workbench-live/lib/human_review.py` (new)
- `agent-workbench-live/lib/lifecycle.py`
- `agent-workbench-live/lib/cli/cmd_followups.py`
- `agent-workbench-live/tests/test_human_review.py` (new)
- `agent-workbench-live/tests/test_e2e.py`
- `agent-workbench-live/tests/test_lifecycle.py`
- `agent-workbench-live/tests/snapshots/human_review_happy.expected.md` (new)
- `agent-workbench-live/tests/snapshots/human_review_bounce_pass2.expected.md` (new)
- `docs/TODO.md` (delete §2; move ✅ summary into Completed work)
- `docs/LOG.md` (add today's entry)

## Data model changes

None. No new event types. No metadata.yaml schema changes. Only consumes existing `events.jsonl` fields.

## UI changes

The rendered `HUMAN_REVIEW.md` is the UI. See the brief's "Good examples" / "Bad examples" for the exact shape.

The `cmd_followups` stdout grows one line:

```
{run_id}: followups -> human_review
entries:  {n} ({categories})
review:   /abs/path/to/HUMAN_REVIEW.md
```

## Test plan

### Unit (`tests/test_human_review.py`)
- `test_project_timeline_filters_template_staged` — synthetic event list with a `template staged` ArtifactWritten followed by a real artifact write; only the real one survives.
- `test_project_timeline_rejects_denylist` — synthetic event list with a row whose description would be `draft created` (no further detail); row is rejected (asserted by `assertNotIn`).
- `test_project_timeline_shape` — every row has `[HH:MM:SS]`, an uppercase stage, and an em-dash separator.
- `test_render_writes_required_headings` — drive `render` against a synthetic run dir; assert all four required headings appear in the output.
- `test_files_table_omits_missing_files` — synthetic run dir without `follow-ups.md`; the Files table has no "Follow-ups" row.

### Snapshot (`tests/test_human_review.py`)
- `test_happy_snapshot` — drives the happy E2E flow, normalizes the rendered file, compares against `human_review_happy.expected.md`. Updates the snapshot via env var `AGENT_WORKBENCH_UPDATE_SNAPSHOTS=1` (writes the actual normalized output to the .expected file; for human-confirmation only).
- `test_bounce_pass2_snapshot` — same for the bounce flow.

### E2E (`tests/test_e2e.py`)
- Extend `test_happy_path`: after the `cli(self.tmp, "followups", run_id, …)` call, assert `str(rd / "HUMAN_REVIEW.md")` appears in `r.stdout`.
- Extend `test_bounce_loop`: same assertion on the second `followups` invocation (the post-bounce one).

### Lifecycle
- `tests/test_lifecycle.py::TestHumanReviewValidation` — the test bodies use the new heading strings (`## Files`, `## Summary of changes`, `## Manual testing performed`, `## Run timeline`).

## QA plan

```bash
# Inside the worktree's agent-workbench-live/ directory:
python -m pytest tests/ -q
# Expect: every test passes; new tests are counted in.
python -m pytest tests/test_human_review.py -v
# Expect: 5+ named tests in this file, all pass.
python -m pytest tests/test_e2e.py -v
# Expect: happy + bounce + abandon tests still pass; new stdout assertion passes.
```

The renderer's output is also eyeballed by inspecting the rendered `HUMAN_REVIEW.md` from an E2E run (`tests/fixtures/e2e/happy/`).

## Risks

- **Snapshot brittleness.** Timestamp + path normalization is the main hazard. Mitigation: keep the normalizer trivial (two `re.sub` calls) and assert the normalizer's output against the canonical snapshot.
- **Existing heading gate compatibility.** The old gate required `## Suggested first checks` + `## Run timeline`. Test fixtures (`tests/fixtures/e2e/*/validating/HUMAN_REVIEW.md`) contain the old headings. After the renderer overwrites them, the new gate (looking for `## Files` etc.) will pass. Risk is the **transition order**: the renderer must run before the engine's heading check. Plan: call `render` inside `cmd_followups.run` immediately before `transitions.transition(...)`. Verified by reading `cmd_followups.py:144-156`.
- **Build.md format drift.** If a future builder writes `build.md` with different headers, the Summary block falls back to "→ Full diff: <abs path>". Plan: the renderer parses headers defensively; missing sections degrade to the fallback line, not an error.

## Definition of done

- The renderer writes all four required headings.
- The `followups → human_review` transition stdout contains the absolute path to `HUMAN_REVIEW.md`.
- `tests/test_human_review.py` exists with the unit + snapshot tests; all pass.
- Snapshot `.expected` files are checked in.
- `tests/test_lifecycle.py::TestHumanReviewValidation` uses the new heading strings and passes.
- The full pytest suite passes.
- `docs/TODO.md` no longer lists §2; the ✅ summary block at the top includes the commit SHA.
- `docs/LOG.md` carries today's entry with the commit SHA and a narrative paragraph.

## Preflight

- **Python**: 3.10+ — confirmed; existing test suite uses unittest + pytest.
- **Test invocation**: `python -m pytest tests/ -q` inside the worktree's `agent-workbench-live/` directory works without `PYTHONPATH` (the `lib/` package + sys.path tricks are handled in the CLI script, not in tests).
- **Repo state**: clean main branch; worktree will be created off the parent run's branch (`202605_agent_workbench_v2`).
- **No new dependencies**.

## Decisions & assumptions

### DR-001
- **Decision**: The renderer is a pure function `human_review.render(cfg, run_id) -> pathlib.Path` in a new module `lib/human_review.py`. It is the sole writer of `HUMAN_REVIEW.md` going forward; it always overwrites whatever is on disk.
- **Rationale**: The TODO explicitly wants the renderer to consume events + artifacts and produce a deterministic file. Centralizing this in a Python module (mirroring `audit.py`) makes it testable and idempotent. Letting the LLM author the file *and* a renderer also write it would create two sources of truth.
- **Alternatives considered**: (a) keep LLM-authored content, just append a Files table at the top; (b) author the file in markdown templates with placeholder substitution; (c) split renderer into multiple modules per section.
- **Why not the alternatives**: (a) leaves the timeline non-specific and the manual-testing-performed prose drift-prone; the TODO's whole point is to replace LLM-authored copy with code-derived copy. (b) placeholder templates don't handle the conditional Files-table filtering cleanly. (c) the renderer is ~150 lines total — splitting it adds friction without value.

### DR-002
- **Decision**: The renderer is called from `cmd_followups.run` (default mode), immediately before `transitions.transition(..., "human_review", ...)`.
- **Rationale**: This is the single chokepoint for `followups -> human_review`. The transition engine already validates HUMAN_REVIEW.md headings at this point; the renderer must run before that check. Putting the call in `cmd_followups` keeps lifecycle logic out of `lib/transitions.py` (which is the rule engine, not a content producer).
- **Alternatives considered**: Call the renderer inside `lib/transitions.transition` as a side-effect before the heading-gate check.
- **Why not the alternatives**: That would couple the rule engine to a specific producer; the cleaner contract is "the caller produces the file, the engine validates it". Mirrors how `cmd_validate` calls `audit.render` and then transitions.

### DR-003
- **Decision**: Keep the existing `tests/fixtures/e2e/*/validating/HUMAN_REVIEW.md` fixture files in place even though the renderer makes their content a no-op.
- **Rationale**: The `lib/stub_llm.py` `_STAGE_FILES["validating"]` tuple references the file; removing the fixture without updating stub_llm.py would crash on `materialize()`. Updating both means a wider blast radius for marginal benefit. Leaving them is cheap (~10 lines of dead content in two files).
- **Alternatives considered**: Drop both fixture files and remove the entry from `_STAGE_FILES["validating"]`.
- **Why not the alternatives**: It splits the change across stub_llm.py and the fixtures, raises the scope-creep surface, and creates a flag-day for anyone running E2E in stub mode locally. The renderer-always-wins design makes the fixture content effectively dead; the stub_llm code path doesn't care that the renderer will overwrite immediately.

### DR-004
- **Decision**: All polish lands in a single commit on the feature branch.
- **Rationale**: One feature = one commit, matching `docs/LOG.md`'s recent entries' convention. The renderer + tests + docs are coupled enough that a multi-commit split would just shuffle hunks without bisect value.
- **Alternatives considered**: Renderer commit, then tests commit, then docs commit.
- **Why not the alternatives**: No bisect signal — the suite is green at every intermediate step. Splitting only matters if a future regression localises to one phase, and the diff is small enough that `git log -p` reads cleanly on a single commit.

### DR-005
- **Decision**: Snapshot tests normalize via two `re.sub` calls (one for the run-root path, one for `[HH:MM:SS]` patterns). The snapshot harness is inline in `tests/test_human_review.py`; no third-party snapshot library.
- **Rationale**: The standard library is sufficient. The normalization is trivial and adding a dep (`pytest-regressions`, `syrupy`) would be over-engineering.
- **Alternatives considered**: Use `pytest-regressions` for richer diffs; commit raw un-normalized snapshots and patch the test runtime.
- **Why not the alternatives**: New dep for a 20-line helper. Raw snapshots tie the test to a specific home dir / clock, defeating portability.

### ASM-001
- **Text**: The renderer can derive a 3-5 bullet "Summary of changes" by header-matching on `build.md` for `## Implementation summary`, `## Files changed`, and the AC table.
- **Reason**: The two fixture `build.md` files (`happy/building/build.md` and `bounce_pass2/building/build.md`) both have these headers; real runs follow the same template (`templates/build.md`). The audit module's `_summarize_artifact` shows the codebase already extracts the first line of an artifact for summaries, so this is a small extension.
- **Impact**: low — if a future `build.md` lacks the expected headers, the Summary block degrades to `→ Full diff: <abs path>` with no bullets. That's the documented fallback; no error.

### ASM-002
- **Text**: All E2E fixture runs (`happy/`, `bounce_pass2/`) produce a `qa/report.md` that contains a one-line outcome string suitable for the `## Manual testing performed` interpretation.
- **Reason**: Both fixture files I read (`tests/fixtures/e2e/happy/validating/qa/report.md` and `bounce_pass2/.../qa/report.md`) are single-paragraph; they read naturally as the "outcome" copy. The QACompleted event carries `tests_passed` (bool) and `known_issues_count` (int) — the renderer's interpretation line uses those, not the QA prose.
- **Impact**: low — the Manual-testing-performed block is data-driven from QACompleted; the qa/report.md path appears as a link only.

### ASM-003
- **Text**: The `cmd_followups` default-mode flow runs after `cmd_validate` has already emitted `ReviewCompleted` and `QACompleted` events, so the renderer can read those from `events.jsonl` at the moment it runs.
- **Reason**: Reading `cmd_validate.py:323-330` (ReviewCompleted) and `:338-350` (QACompleted), both emit before `transitions.transition(..., "followups", ...)`. So by the time `cmd_followups.run` is called, the events are persisted.
- **Impact**: low — if the events are absent (a partial run), the renderer's Manual-testing-performed block degrades to a single line `_pending: no QA event recorded._`. No error.
