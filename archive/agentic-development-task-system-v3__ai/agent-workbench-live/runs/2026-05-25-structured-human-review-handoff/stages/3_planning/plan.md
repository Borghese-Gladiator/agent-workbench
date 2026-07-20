# Implementation plan

## Current repo understanding

The workbench has a single stop-banner helper at `agent-workbench-live/lib/cli/_stop_banner.py`. It prints a `STOP.` frame plus a static body keyed on landing state (`ready`, `human_review`, `done`, `abandoned`). Today the `human_review` body is just a "Next moves" list that uses the shell form `agent-workbench <verb> <run_id> - <description>`.

Two call sites produce a `human_review` landing:

- `lib/cli/cmd_validate.py` (`run()` flat-layout path, lines 514–558): for non-staged runs only — emits `HumanHandoffCreated`, transitions to `human_review`, prints branch / worktree / audit lines, then calls `print_stop_banner("human_review", run_id)`. Staged runs never hit this branch; they go to `followups` instead.
- `lib/cli/cmd_followups.py` (default-mode tail, lines 162–194): for staged runs — renders HUMAN_REVIEW.md via `lib.human_review.render(cfg, run_id)`, emits `HumanHandoffCreated`, transitions to `human_review`, prints entries / review-path lines, then calls `print_stop_banner("human_review", run_id)`.

The renderer at `lib/human_review.py` writes a canonical HUMAN_REVIEW.md with these sections (per `REQUIRED_HUMAN_REVIEW_HEADINGS`): `## Files`, `## Summary of changes`, `## Testing` (with `**Manual testing**` sub-section), `## Run timeline`. The `## Summary of changes` section is markdown — top-level `- ` bullets summarize the implementation-summary first paragraph, files-changed count + nested `  -` rows, AC coverage, and docs touched + nested rows. The brief said "≤3 bullets from `## Summary of changes`"; for the banner we take only the **top-level** `- ` bullets and ignore the indented `  -` rows (the latter are details, not summary items).

Metadata's `target.repo.base_ref_sha` is set at `/start` time by `cmd_start.py:64-78` via `repos.resolve_ref_to_sha(repo_path, base_ref)`. For older runs predating `303bd40` the field is null. `lib/metrics/lines.py:60-75` has a pattern for "prefer SHA, lazily resolve symbolic via `git rev-parse`, fall back to symbolic" that the diffstat builder should reuse.

QA pass/fail is emitted as a `QACompleted` event with `payload.tests_passed: bool` and `payload.known_issues_count: int`. The renderer in `lib/human_review.py:339-376` consumes the same fields via `events.iter_events` + a `_latest_event(events, "QACompleted")` helper. The renderer also reads the QA report's `## Manual testing` section to detect a recorded dogfood/manual run (returning the body verbatim, or empty when the section is missing or only contains a `_None._` placeholder).

The existing E2E test (`tests/test_e2e.py:208-212`) already asserts the absolute HUMAN_REVIEW.md path appears in stdout after `followups`. The unit test for the banner (`tests/test_stop_banner.py:34-41`) asserts `"agent-workbench complete"`, `"agent-workbench bounce"`, `"agent-workbench abandon"` substrings in the rendered human_review banner — these substrings must disappear when we switch to slash-form decision lines. The snapshot file `tests/snapshots/stop_banner_human_review.expected.txt` currently encodes the old format (10 lines, last-line `============`); it must be re-baselined.

## Relevant files

- `agent-workbench-live/lib/cli/_stop_banner.py` — helper for the `STOP.` frame + per-state body. Add the `human_review` body builder here.
- `agent-workbench-live/lib/cli/cmd_validate.py` — flat-layout `human_review` landing; calls `print_stop_banner("human_review", ...)` at line 557.
- `agent-workbench-live/lib/cli/cmd_followups.py` — staged-layout `human_review` landing; calls `print_stop_banner("human_review", ...)` at line 194.
- `agent-workbench-live/lib/human_review.py` — canonical HUMAN_REVIEW.md renderer; banner extractor reads its `## Summary of changes` output.
- `agent-workbench-live/lib/metadata.py` — `metadata.load(cfg, run_id)` for run metadata + `metadata.run_dir(cfg, run_id)` for the absolute run dir.
- `agent-workbench-live/lib/metrics/lines.py:60-75` — the `_effective_ref` pattern reused by the diffstat builder.
- `agent-workbench-live/tests/test_stop_banner.py` — unit + snapshot tests; both must be updated.
- `agent-workbench-live/tests/snapshots/stop_banner_human_review.expected.txt` — snapshot file to re-baseline.
- `agent-workbench-live/tests/test_e2e.py:200-260` — happy-path E2E that already asserts the absolute HUMAN_REVIEW.md path. Extend it to assert the new banner shape.
- `agent-workbench-live/tests/test_e2e.py:264-340` — bounce-pass2 E2E (drives two passes through `human_review`); extend it the same way.
- `agent-workbench-live/lib/lifecycle.py` (read-only) — `is_staged_run` resolves whether to look in stages/ subtree or run root.

## Proposed changes

### 1. Extend `_stop_banner.py` to render the structured body

The current `print_stop_banner(landing_state, run_id)` signature is too narrow: the `human_review` body needs the `cfg` (to load metadata + locate the run dir) and the run's `Run`-equivalent (we have `run_id` + `metadata.run_dir`). The simplest extension is to make the body source-aware:

- Keep the existing `print_stop_banner(landing_state, run_id)` signature for backwards compatibility (ready/done/abandoned all stay unchanged). Default behavior for `human_review` falls back to the existing static next-moves text **when no `cfg` is supplied**, so any caller that doesn't have a `cfg` (e.g. unit tests) still gets a banner.
- Add an optional `cfg=None` parameter. When `cfg` is supplied and `landing_state == "human_review"`, the banner body is the new five-section structure. When `cfg` is None and `landing_state == "human_review"`, the body falls back to a minimal version (no Review/Summary/Testing/Diffstat sections, just the three `Next moves` slash-form lines). This keeps the existing unit-test-via-direct-call ergonomics while letting both real call sites pass `cfg`.
- The body builder is a separate module-private function `_build_human_review_body(cfg, run_id) -> list[str]`. It returns the 5 body sections as a list of lines, joined into the banner by the caller. Pure-Python; no I/O beyond reading HUMAN_REVIEW.md and running `git diff --shortstat`.

The `STOP.` frame stays identical (`STOP. State: human_review (human-owned).` + the existing explanation line, then a blank line, then the body, then the closing border).

### 2. Body builder — five sections

```
Review:
  HUMAN_REVIEW.md: <absolute path>

Summary of changes (≤3 bullets):
  - <bullet 1>
  - <bullet 2>
  - <bullet 3>
  …(N more in HUMAN_REVIEW.md)        # only if source had >3 bullets

Summary of testing (≤2 sentences, or "None recorded."):
  <one-to-two sentences, or the literal "None recorded.">

Diffstat:
  <N files changed, +X / −Y lines>     # or the "unavailable" fallback

Next moves (human-triggered, type in a session):
  /complete <run-id>  — accept; auto-merges worktree branch into parent
  /bounce <run-id>    — send back to building with structured feedback
  /abandon <run-id>   — discard the run
```

- **Review.** `str(metadata.run_dir(cfg, run_id) / "HUMAN_REVIEW.md")` — that's already absolute (run_dir resolves to an absolute path).
- **Summary of changes.** Read HUMAN_REVIEW.md. Extract the `## Summary of changes` section via the same `_section(text, "Summary of changes")` regex pattern `lib/human_review.py:284` already uses (factor that helper out or duplicate it locally — duplicate is fine, it's three lines). Pull lines that start with `- ` (a hyphen + space) at column 0 — these are top-level bullets. Drop the trailing `→ Full diff:` line and any nested `  -` rows. Cap at 3 bullets. If more, append the literal line `  …(<N> more in HUMAN_REVIEW.md)` where N = total − 3. Each bullet single-line truncated at 100 columns with a `…` suffix when longer. If the source has 0 top-level bullets, render the single line `(none recorded)`.
- **Summary of testing.** Read the latest `QACompleted` event via `events.iter_events(cfg, run_id)` + a `_latest_event` helper (duplicate the 3-line helper from `human_review.py:308-313` locally). If no event, line is `None recorded.`. Otherwise:
  - First sentence built from `tests_passed` + `known_issues_count`: `tests_passed=True, known_issues=0` → `Unit tests passed; no known issues.`; `tests_passed=True, known_issues>0` → `Unit tests passed (N known issue(s)).`; `tests_passed=False` → `Unit tests failed (see HUMAN_REVIEW.md).`; `tests_passed=None` → `Test outcome unrecorded.`.
  - Second sentence (optional): read the run's QA report's `## Manual testing` section via the same `_read_manual_testing` shape used in `human_review.py:404-418`. If the body is non-empty (i.e. a real dogfood/manual entry), append `A dogfood/manual run was recorded.`. Otherwise no second sentence.
  - If somehow >2 sentences would be produced, truncate to 2 (defensive — current shape produces at most 2).
- **Diffstat.** Inside `meta["target"]["worktree"]["path"]`, run `git diff --shortstat <effective_ref>..HEAD`, where `<effective_ref>` follows the prefer-SHA / lazy-resolve / symbolic fallback pattern from `lib/metrics/lines.py:60-75`. Parse the shortstat output (`N files changed, X insertions(+), Y deletions(-)` — note plural variants) into the target form `N files changed, +X / −Y lines`. If `_effective_ref` returns the symbolic name unchanged AND `git rev-parse <symbolic>` also fails, print the literal `unavailable (base_ref unresolved).`. If the diff command runs but the output is empty (HEAD == base_ref SHA, zero changes), print `0 files changed, +0 / −0 lines` — distinguishable from the unavailable case.
- **Next moves.** Three static lines, slash-form, with descriptions. No `agent-workbench` shell text.

### 3. Update `_SPECS` and `print_stop_banner`

The current `human_review` spec uses `next_moves: tuple[(str, str), ...]` with shell-form. Repurpose `next_moves` for the new slash-form entries (`/complete`, `/bounce`, `/abandon`) and use a single rendering path that just prefixes each tuple's first element with `/`. Other landing states (`ready`) continue to use the old `agent-workbench` shell form — those banners are unchanged. To avoid a confused mixed-form rendering, give `human_review` a new spec field (e.g. `decision_form="slash"`) or split the rendering into two helpers. Simpler: just hand-build the three lines in the body builder. Drop `human_review` from `_SPECS.next_moves` entirely; render the three lines as part of the body.

### 4. Update call sites

- `cmd_validate.py:557` — change `print_stop_banner("human_review", run_id)` to `print_stop_banner("human_review", run_id, cfg=cfg)`. Keep the existing `print(f"branch: ...")` + `print(f"worktree: ...")` + `print(f"audit: ...")` lines BEFORE the banner — they're still useful operator output. (Banner body duplicates `branch/worktree/audit` only minimally — none of those three fields are in the banner.)
- `cmd_followups.py:194` — same: pass `cfg=cfg`. Keep the existing `print(f"entries: ...")` + `print(f"review: ...")` lines before it.

### 5. Tests

- `tests/test_stop_banner.py`
  - Update `test_human_review_banner_structure` to no longer assert `agent-workbench complete/bounce/abandon` substrings (those are gone). Assert `/complete`, `/bounce`, `/abandon` substrings.
  - Add `test_human_review_no_cfg_minimal_body`: verify `print_stop_banner("human_review", run_id)` (no cfg) renders the minimal fallback (3 slash-form Next moves lines only). Asserts the new test can still exercise the helper without a config.
  - Add `test_human_review_with_cfg_full_body`: build a synthetic `cfg` + tmp run dir containing a minimal `metadata.yaml`, an `events.jsonl` with a single `QACompleted` event, a `HUMAN_REVIEW.md` with a `## Summary of changes` section, and a `worktree.path` pointing at a tiny `git init`-ed repo. Assert the rendered body has the five sections in order, the absolute HUMAN_REVIEW.md path appears under `Review:`, the bullets are truncated/extracted correctly, the testing line shape matches expectations, the diffstat parses to `N files changed, +X / −Y lines`, and exactly three slash-form Next moves lines appear.
  - Re-baseline `tests/snapshots/stop_banner_human_review.expected.txt` for the **no-cfg minimal** case (the snapshot test still drives the bare `_render("human_review")` call). The five-section body is exercised by the new with-cfg unit test, not the snapshot test.

- New unit test for body builder, `tests/test_stop_banner_human_review_body.py`:
  - Fixture HUMAN_REVIEW.md files generated in-test via tmp_path:
    - (a) 2 top-level bullets + `QACompleted{tests_passed=True, known_issues_count=0}` + QA report with empty `## Manual testing` → 5-section body; testing line is exactly `Unit tests passed; no known issues.`; no `…(N more)` tail.
    - (b) 5 top-level bullets + `QACompleted{tests_passed=False, known_issues_count=2}` + QA report with a real `## Manual testing` body → 5-section body; testing line is `Unit tests failed (see HUMAN_REVIEW.md). A dogfood/manual run was recorded.`; `…(2 more in HUMAN_REVIEW.md)` tail.
    - (c) 0 top-level bullets + no `QACompleted` event + no QA report → 5-section body; summary line is the single line `(none recorded)`; testing line is the literal `None recorded.`.
  - Truncation test: a bullet whose source line is 150 columns long renders as a 100-column line ending in `…`.
  - Diffstat tests:
    - resolvable base ref + non-empty diff → real shortstat line in target format.
    - resolvable base ref + empty diff (HEAD == base_ref_sha) → `0 files changed, +0 / −0 lines`.
    - unresolvable base ref (no `base_ref_sha`, symbolic name doesn't resolve in the worktree) → `unavailable (base_ref unresolved).`.

- `tests/test_e2e.py`
  - Happy path (`test_e2e_happy` or whatever the existing function is named): extend the `STOP. State: human_review` assertion block to also assert each of:
    - `Review:` substring.
    - `Summary of changes` substring.
    - `Summary of testing` substring.
    - `Diffstat:` substring.
    - `/complete <run-id>`, `/bounce <run-id>`, `/abandon <run-id>` substrings — exactly three slash-form Next moves lines.
    - No `agent-workbench complete` / `agent-workbench bounce` / `agent-workbench abandon` substrings.
  - Bounce path: same assertions on the second `human_review` landing.

### 6. Repo hygiene

Per `AGENTS.md` § "The two-file contract": when this run lands and merges, `docs/TODO.md` § 2 must be deleted and renumbered, and `docs/LOG.md` must get a new dated entry. Both happen during the build, not at planning time. Noted here so it doesn't get forgotten.

## Files likely to change

- `agent-workbench-live/lib/cli/_stop_banner.py`
- `agent-workbench-live/lib/cli/cmd_validate.py`
- `agent-workbench-live/lib/cli/cmd_followups.py`
- `agent-workbench-live/tests/test_stop_banner.py`
- `agent-workbench-live/tests/snapshots/stop_banner_human_review.expected.txt`
- `agent-workbench-live/tests/test_stop_banner_human_review_body.py` (new file)
- `agent-workbench-live/tests/test_e2e.py`
- `docs/TODO.md`
- `docs/LOG.md`

## Data model changes

None. No metadata schema changes, no new fields, no new events.

## UI changes

The agent-facing CLI output is the only "UI". The `STOP.` banner body changes shape for `human_review` landings only. No color, no Unicode, ASCII only. Width is the existing 60-column rule for borders; body lines themselves are not column-padded.

## Test plan

Unit tests (new + updated, in `agent-workbench-live/tests/`):

- `test_stop_banner.py::test_human_review_banner_structure` — updated to assert slash-form, not shell-form.
- `test_stop_banner.py::test_human_review_no_cfg_minimal_body` (new) — minimal fallback.
- `test_stop_banner.py::test_human_review_with_cfg_full_body` (new) — full five-section render.
- `test_stop_banner_human_review_body.py` (new file) — exhaustive body-builder behavior: 2-bullet/5-bullet/0-bullet shapes, testing line shape across tests_passed × manual-testing presence × no-QACompleted, truncation at 100 columns, diffstat resolvable/empty/unavailable.
- Existing `test_stop_banner.py` snapshot test for `human_review` re-baselined to the new minimal-fallback shape.

E2E (`test_e2e.py`):

- Happy path: assert the five new section substrings appear after `followups -> human_review`; assert exactly three `/complete`/`/bounce`/`/abandon` lines; assert no `agent-workbench complete` substring.
- Bounce path: same assertions on the second landing.

Run commands:

```bash
cd agent-workbench-live
python -m pytest tests/ -q
```

## QA plan

After unit + E2E green:

- Run the workbench's own dogfood: `./agent-workbench-live/bin/agent-workbench followups <this-run-id>` lands the run in `human_review`. Verify the printed banner against the five-section spec: HUMAN_REVIEW.md path is absolute; ≤3 summary bullets; 1-or-2-sentence testing line; diffstat shows real `N files changed, +X / −Y lines`; three slash-form Next moves; no shell-form anywhere.
- Verify HUMAN_REVIEW.md itself is unchanged (the renderer file wasn't touched).

## Risks

- **`_stop_banner.py`'s static-`_SPECS` design didn't anticipate per-state cfg parameters.** Threading `cfg` through is the smallest invasive change; the alternative is a separate `print_human_review_banner` function and a deprecation of the `human_review` entry in `_SPECS`. We're choosing the threaded-cfg approach because both real call sites already have a `cfg` in scope. Mitigation: keep the no-cfg fallback so the unit-test ergonomic doesn't break.
- **The "≤100 columns per bullet" truncation rule conflicts with terminals narrower than 100 columns.** Accepted — terminals wider than 80 are universal today; the brief's "~100" is a soft cap and a 100-column terminal is what the test harness uses.
- **`git diff --shortstat` output format varies across git versions.** Modern git (≥2.0) outputs `N file(s) changed, X insertion(s)(+), Y deletion(s)(-)`. We need to parse all four pluralization variants. Mitigation: parse with a regex that allows `file/files`, `insertion/insertions`, `deletion/deletions`, and treat any missing field as 0 (e.g. an additions-only commit prints no deletions clause). Add a unit test for the parser.
- **The "Manual testing" QA section is the heuristic for the dogfood-recorded sentence — its absence is treated as "no dogfood recorded".** That's the renderer's current behavior; we're consistent with it. If a run records a dogfood result somewhere other than the QA report's `## Manual testing` section, the banner won't reflect it. Accepted — out of scope to redesign the dogfood signal.
- **The existing snapshot test for `human_review` is in `tests/snapshots/stop_banner_human_review.expected.txt` and we must re-baseline it.** The brief lists "snapshot test across two fixture runs" as a deliverable; the existing snapshot is for the no-cfg minimal-fallback shape and is the right thing to re-baseline. The full-body snapshot wasn't ever taken; we test the full body via tmp-path-driven unit tests instead, which is more robust to absolute-path interpolation than a static snapshot file.
- **The cmd_validate flat-layout path is exercised only by older `bin/cli`-style integration tests, not the happy-path E2E (which is staged).** That branch will route through the new builder via `print_stop_banner("human_review", run_id, cfg=cfg)` but no E2E covers it. Mitigation: a dedicated unit test exercises the builder directly; the flat-layout call-site change is mechanical (1-line edit).

## Definition of done

- `agent-workbench-live/lib/cli/_stop_banner.py` exports `print_stop_banner(landing_state, run_id, cfg=None)` and renders the five-section body when `landing_state == "human_review"` and `cfg` is supplied.
- `cmd_validate.py` and `cmd_followups.py` both call `print_stop_banner("human_review", run_id, cfg=cfg)` at the `human_review` landing.
- All `human_review` Next moves lines use slash-form (`/complete`, `/bounce`, `/abandon`); no `agent-workbench` shell-form appears in the banner.
- Banner is ASCII-only; no color or Unicode line-drawing beyond the `STOP.` frame border.
- `tests/test_stop_banner.py` passes; the snapshot file is re-baselined for the minimal-fallback shape.
- The new `tests/test_stop_banner_human_review_body.py` passes.
- `tests/test_e2e.py` passes with the new section-substring assertions on both happy and bounce paths.
- The whole workbench test suite (`python -m pytest tests/ -q`) is green.
- Dogfood: this run's own `human_review` landing renders the new banner shape, verified visually.
- `docs/TODO.md` § 2 is deleted (and following sections renumbered); `docs/LOG.md` has a new dated entry covering what shipped, why, commit SHAs, test counts, and any surprises — per `AGENTS.md`'s two-file contract.

## Preflight

- Python is the runtime; no third-party deps need adding. The existing `pyyaml` / `pytest` / repo internals are sufficient.
- Git is required at runtime for `git diff --shortstat` and `git rev-parse`. The diffstat builder swallows `FileNotFoundError` (no git) the same way `lib/metrics/lines.py` does.
- The fixtures `tests/fixtures/happy/` and `tests/fixtures/bounce_pass2/` already exist and drive the staged-layout `human_review` landing. They're consumed by `test_e2e.py`; no fixture changes needed beyond extended assertions.
- The workbench root in this run is the same repo it operates on — dogfood works directly without any external repo setup.

## Decisions & assumptions

### DR-001
- **Decision**: Thread `cfg` as an optional kwarg into `print_stop_banner` rather than introducing a separate `print_human_review_banner` function.
- **Rationale**: Both real call sites (`cmd_validate` and `cmd_followups`) already have `cfg` in scope. A single entry point keeps the call-site mechanics identical across landing states (`ready`, `human_review`, `done`, `abandoned`), so future expansions (e.g. structured body for `ready` per TODO non-goal) drop in the same way. The unit-test ergonomic (`_render("human_review")` with no cfg) keeps working via a minimal fallback.
- **Alternatives considered**: (a) a separate `print_human_review_banner(cfg, run_id)` function; (b) refactor `_SPECS` to embed callable body builders.
- **Why not the alternatives**: (a) leaves the call site with two different banner functions to choose between, and existing tests would have to know which to call; the closed-set validation on `landing_state` is the same surface today and worth preserving. (b) over-engineers for the single state that needs cfg today — `_SPECS` is fine as static data; the cfg-aware path is a one-line branch.

### DR-002
- **Decision**: "Bullets" in the `## Summary of changes` section means **top-level `- ` lines only**, not the nested `  -` rows.
- **Rationale**: Inspecting `runs/2026-05-22-human-review-polish/HUMAN_REVIEW.md` and the happy fixture's snapshot shows the renderer emits top-level bullets for distinct summary items (implementation-summary sentence, files-touched header, AC coverage, docs-touched header) and indented `  -` rows for the per-file detail under each. The banner's "≤3 bullets" cap is meant to surface the highest-level items, not interleave details.
- **Alternatives considered**: Counting every `- ` (including indented `  -`) as a bullet.
- **Why not the alternatives**: A run with 4 files touched would have its first bullet (the implementation-summary sentence) plus a "4 file(s) touched:" header consume two of the 3 allowed bullets, then start spilling per-file rows into the third — that's noise, not summary. Top-level-only matches the brief's intent.

### DR-003
- **Decision**: Two distinct diffstat "no result" states — `unavailable (base_ref unresolved).` (cannot resolve a base ref) vs. `0 files changed, +0 / −0 lines` (resolved base ref, genuine empty diff).
- **Rationale**: The brief's bad-example explicitly flags `0 files changed, +0 / −0 lines` for an unresolvable base ref as misleading; the QA-scenario 8 calls out the boundary as the high-value one. The renderer needs to know which case applies.
- **Alternatives considered**: Always print `unavailable` when the diff command produces no output (collapse both cases).
- **Why not the alternatives**: A genuine empty diff is meaningful operator information ("the agent landed in `human_review` without changing any code — investigate"). Collapsing it loses signal.

### DR-004
- **Decision**: Heuristic for the "dogfood/manual run recorded" sentence is "the QA report's `## Manual testing` section has a non-empty body that isn't a `_None._`-class placeholder".
- **Rationale**: Reuses the renderer's own `_read_manual_testing` shape (`lib/human_review.py:404-418`) so banner + HUMAN_REVIEW.md disagree only if the renderer changes.
- **Alternatives considered**: Adding a dedicated `manual_testing_recorded: bool` payload to `QACompleted`.
- **Why not the alternatives**: New event-payload fields are a schema change; out of scope for this task. The QA-section-body heuristic is the same signal HUMAN_REVIEW.md displays today, so consistency is automatic.

### ASM-001
- **Text**: The QA report's `## Manual testing` section is the workbench's canonical signal for whether a dogfood/manual run happened, and runs that record such a run do populate that section (not some other location).
- **Reason**: That's the section `lib/human_review.py:_read_manual_testing` reads to render the `**Manual testing**` sub-block in HUMAN_REVIEW.md; it has been the convention since the renderer was introduced.
- **Impact**: medium. If a future run records manual testing outside this section, the banner's "A dogfood/manual run was recorded." sentence is missing — but HUMAN_REVIEW.md will also be missing it, so the failure mode is consistent and visible.

### ASM-002
- **Text**: `git diff --shortstat <effective_ref>..HEAD` inside the run's worktree is correct for the banner's diffstat field — using the dotted form (`..`), not the three-dot form (`...`).
- **Reason**: The dotted form gives "what HEAD has that base_ref doesn't" — exactly the set of changes the run authored relative to its base. The three-dot form would also exclude commits unique to base_ref, which doesn't change the answer for HEAD-only commits but adds a confusing "what's unique to base" reading for no benefit. The renderer at `lib/metrics/lines.py:82` uses the dotted form too.
- **Impact**: low. Both forms produce the same shortstat for the typical case (HEAD is on a fast-forwarded branch). The two-dot form is the right choice for narrative consistency.

### ASM-003
- **Text**: The existing E2E fixtures (`tests/fixtures/happy/`, `tests/fixtures/bounce_pass2/`) produce a worktree whose HEAD differs from `base_ref` by at least one commit by the time `human_review` lands, so the diffstat field will resolve to a non-empty value in the E2E assertions.
- **Reason**: The happy-path E2E at `tests/test_e2e.py:214-227` makes a real commit on the worktree branch (`feature.txt`) before calling `complete`, but **after** the `followups -> human_review` transition. So when the banner is rendered inside `followups`, the worktree may have zero diff against base_ref. The diffstat assertion in the E2E must therefore accept **either** `N files changed, +X / −Y lines` **or** the `0 files changed, +0 / −0 lines` empty form, not require a non-zero number. The "unavailable" fallback should not appear because `base_ref_sha` is captured at `/start` time.
- **Impact**: medium — affects the exact E2E assertion shape. The test asserts "the line `Diffstat:` appears, followed by a non-`unavailable` value" rather than "the line shows specific file counts".

### ASM-004
- **Text**: The existing snapshot test for `human_review` at `tests/snapshots/stop_banner_human_review.expected.txt` represents the no-cfg minimal fallback after this change, and re-baselining it is acceptable.
- **Reason**: Re-baselining a snapshot file under the existing `WRITE_SNAPSHOTS=1` workflow is a one-line update with a visual diff for review. Snapshot drift in the unit test is expected for this kind of wording change.
- **Impact**: low — the test will fail on first run and require the WRITE_SNAPSHOTS=1 baseline pass, which is how the existing test harness already handles such updates.

### ASM-005
- **Text**: Both `cmd_validate.py`'s flat-layout `human_review` landing and `cmd_followups.py`'s staged landing have `cfg` in scope at the call site.
- **Reason**: Read of both files: `cmd_validate.py:257` (`cfg = load_config(args)`) and `cmd_followups.py:41` (same). Both functions hold `cfg` for the entire `run(args)` lifetime.
- **Impact**: low. If wrong, the call-site edit is a 1-line revert per file.

### ASM-006
- **Text**: It is acceptable for `print_stop_banner("human_review", run_id)` called without `cfg` to render only the three slash-form `/complete`, `/bounce`, `/abandon` Next moves lines and nothing else (no Review/Summary/Testing/Diffstat sections).
- **Reason**: The only no-cfg caller today is the unit test in `test_stop_banner.py`. Real CLI commands pass `cfg`. A minimal fallback keeps unit-test ergonomics simple without requiring synthetic metadata.
- **Impact**: low. If a future caller forgets to pass `cfg`, the banner is incomplete but never crashes — and the missing sections are visually obvious in the terminal output.
