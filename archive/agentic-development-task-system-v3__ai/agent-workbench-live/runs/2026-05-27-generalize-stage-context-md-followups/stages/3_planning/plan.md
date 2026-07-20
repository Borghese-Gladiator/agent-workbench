# Implementation plan

## Current repo understanding

The agent-workbench is a self-modifying Python CLI living at `agent-workbench-live/`. Its `lib/` houses stage-specific generators (today: `build_context.py`, `validate_context.py`) and `lib/cli/cmd_*.py` houses the per-stage CLI subcommands. The §5 follow-up adds three sibling generators (`shape_context.py`, `plan_context.py`, `followups_context.py`) and three corresponding `--init` write sites in `cmd_shape.py`, `cmd_plan.py`, `cmd_followups.py`. The pattern is fully defined by the existing two siblings:

- **Generator module shape**: `build(*, <keyword-only paths and dicts>) -> str` returns a rendered markdown string; `write(path, body) -> None` writes it idempotently and creates parents.
- **Write-site shape**: `cmd_<stage>.py` defines a private `_write_<stage>_context_artifacts(cfg, run_id, ...)` helper that resolves paths, calls `<stage>_context.build(...)`, calls `<stage>_context.write(...)`, and wraps the whole thing in a single `try: … except Exception: pass`. The helper is called from the `--init` mode BEFORE the `ArtifactWritten` event emission, AFTER template staging.
- **Helper duplication**: `_read()`, `_section()`, `_collect_id_blocks()`, and `_HEADING_RE` are duplicated locally in each generator (per `lib/build_context.py`'s docstring policy: "the two builders may diverge as the other `<stage>-context.md` siblings land"). New generators continue the duplication; no extraction to `_context_common.py`.
- **Structure of each rendered file**: heading + generated-at comment, lifted-inline sections from prior artifacts, `## Worktree` metadata block where applicable, optional `## <stage>.md template skeleton` section, and a `## Rules` block at the bottom (stage-specific guidance as bullet list).

`docs/lifecycle.md` § building has a "Curated entry context" sub-block describing `build-context.md` (worktree metadata + lifted sections + Rules). The three new stages need analogous sub-blocks under shape/plan/followups in lifecycle.md, plus an additive "*-context.md" row in each stage's table.

`agent-workbench.yaml`'s policies block lists behavioral toggles only (`local_only`, `one_repo_per_run`, etc.) — no build/test command registry. The brief's assumption that `plan-context.md` would source build/test commands from `agent-workbench.yaml`'s policies block is wrong; the planner needs to detect them from the target repo itself (Makefile, pyproject.toml, package.json, .github/workflows/, etc.) — see ASM-001 below.

The three target `cmd_*.py --init` modes have predictable insertion points:

- **`cmd_shape.py:--init`**: copies `templates/brief.md` to `rd / brief.md` (lines ~40–55). Insertion point for `_write_shape_context_artifacts(...)` is after the template copy, before the `ArtifactWritten` event emission.
- **`cmd_plan.py:--init`**: calls `_stage_templates(cfg, rd, staged)` (line ~127) to stage `plan.md` (and `preflight.md`/`assumptions.md`/`decisions.md` for flat-layout runs). Insertion point for `_write_plan_context_artifacts(...)` is after `_stage_templates()`, before the for-loop emitting `ArtifactWritten` events.
- **`cmd_followups.py:--init`**: calls `_stage_template(cfg, rd)` to stage `follow-ups.md` (line ~63), then immediately calls `transitions.transition()` to move `validating → followups`. Insertion point for `_write_followups_context_artifacts(...)` is between `_stage_template()` and `transitions.transition()` — the curated file must exist before the agent reads `follow-ups.md`, but after the prior artifacts (build.md, review.md, qa/report.md) have been finalized.

The three slash command bodies (`.claude/commands/shape.md`, `plan.md`, `followups.md`) all have a "Step 2 — read prior artifacts" section that lists what the agent should read. Each needs a new instruction redirecting that to `<stage>-context.md`, mirroring `validate.md`'s exact wording.

## Relevant files

**Reference (read-only design templates):**

- `agent-workbench-live/lib/build_context.py` — design template; copy the function signatures, helper layout, and Rules-block pattern.
- `agent-workbench-live/lib/validate_context.py` — reference for filtered-DR/ASM rendering, worktree metadata block format.
- `agent-workbench-live/lib/cli/cmd_start.py` — `_write_build_context_artifacts` is the canonical `try/except` swallow helper (lines 144–178).
- `agent-workbench-live/lib/cli/cmd_validate.py` — `_write_validate_context_artifacts` (lines 46–89) — same shape; both new sites mirror it.
- `agent-workbench-live/tests/test_build_context.py` — design template for unit tests; copy the `tempfile.mkdtemp` setUp/tearDown + `self.assertIn(section, body)` style.
- `agent-workbench-live/tests/test_validate_context_build.py` — alternate test pattern using real git repo (use only if a generator needs git introspection — none of the three new ones do).

**Files to create:**

- `agent-workbench-live/lib/shape_context.py`
- `agent-workbench-live/lib/plan_context.py`
- `agent-workbench-live/lib/followups_context.py`
- `agent-workbench-live/tests/test_shape_context.py`
- `agent-workbench-live/tests/test_plan_context.py`
- `agent-workbench-live/tests/test_followups_context.py`

**Files to modify:**

- `agent-workbench-live/lib/cli/cmd_shape.py` — add `_write_shape_context_artifacts()` and call it from `--init`.
- `agent-workbench-live/lib/cli/cmd_plan.py` — add `_write_plan_context_artifacts()` and call it from `--init`.
- `agent-workbench-live/lib/cli/cmd_followups.py` — add `_write_followups_context_artifacts()` and call it from `--init`.
- `agent-workbench-live/.claude/commands/shape.md` — add Step 1.5 / extend Step 2 to read `shape-context.md` first.
- `agent-workbench-live/.claude/commands/plan.md` — same for `plan-context.md`.
- `agent-workbench-live/.claude/commands/followups.md` — same for `followups-context.md`.
- `agent-workbench-live/docs/lifecycle.md` — add curated-entry-context bullet + `*-context.md` row to the shape, plan, followups stage tables.
- `docs/TODO.md` — mark §5's three remaining sub-tasks as complete.

## Proposed changes

### A. `lib/shape_context.py` (new, ~120 LOC)

Public surface:

```python
def build(
    *,
    raw_idea_path: Path,
    answers_path: Path | None,
    brief_template_path: Path,
) -> str: ...

def write(path: Path, body: str) -> None: ...
```

Rendered sections (in order):

1. `# shape-context.md` + generated-at comment.
2. `## Raw idea` — verbatim contents of `raw-idea.md`.
3. `## Answers` — verbatim contents of `answers.md` if present; section omitted entirely if absent.
4. `## brief.md template skeleton` — inlined contents of `templates/brief.md` (the full template including HTML comments — the agent benefits from the section-description hints inside them).
5. `## Rules` — bullet list with the two shaping rules:
   - "Do NOT read code in the target repo. This stage is code-blind."
   - "Do NOT ask the user questions. Convert ambiguity into Assumptions in `brief.md`."
   - Plus a curated-file rule mirroring build-context.md's: "Do not re-read `raw-idea.md`, `answers.md`, or `templates/brief.md` unless this file's sections are insufficient."

Local helpers (duplicated from build_context.py): `_read()`, optional `_section()` if needed. Shape doesn't filter DR/ASM blocks, so `_collect_id_blocks()` is not needed.

No worktree-metadata block — shaping is code-blind and doesn't reference the worktree.

### B. `lib/plan_context.py` (new, ~180 LOC)

Public surface:

```python
def build(
    *,
    brief_path: Path,
    plan_template_path: Path,
    worktree_path: str | None,
    meta: dict,
) -> str: ...

def write(path: Path, body: str) -> None: ...

def _detect_repo_map(worktree_path: str | None) -> str:
    """Return a curated repo-map block: top-level dirs (depth-1), detected
    languages (presence of pyproject.toml / package.json / Cargo.toml / etc.),
    and inferred build/test commands (Makefile targets, package.json scripts,
    pyproject [tool.pytest], etc.). Returns a fallback '(worktree not yet
    created — repo-map unavailable)' string if worktree_path is None.
    """
```

Rendered sections (in order):

1. `# plan-context.md` + generated-at comment.
2. `## Brief` — full contents of `brief.md` (small, load-bearing — same as how validate-context.md lifts brief sections wholesale).
3. `## Repo map` — output of `_detect_repo_map()`:
   - Top-level dirs at depth 1 (filtered: skip `.git`, `node_modules`, `__pycache__`, dotfiles).
   - Detected languages with one-line evidence per language.
   - Build/test/lint commands inferred from common manifests.
4. `## Files likely to change (from brief)` — lifted verbatim from brief's "Files likely to change" section if present; section omitted if absent.
5. `## Worktree` — metadata block (path, branch, base_ref, base_ref_sha) — uses `meta["target"]["worktree"]`.
6. `## plan.md template skeleton` — inlined contents of `templates/plan.md`.
7. `## Rules` — bullets:
   - "You may read code in the target repo's worktree."
   - "Do NOT ask the user questions. Convert ambiguity into Assumptions (ASM-NNN) in `plan.md`."
   - "Re-read `brief.md` only if this file's Brief section is insufficient — the cache cost sticks in the session prefix forever."

Local helpers (duplicated): `_read()`, `_section()`. `_collect_id_blocks()` not needed at plan-init time (no prior plan to lift from).

`_detect_repo_map()` is the only meaningful new logic. It walks the worktree once, returns a multi-paragraph string. See DR-001 below for the language-detection rule.

### C. `lib/followups_context.py` (new, ~160 LOC)

Public surface:

```python
def build(
    *,
    brief_path: Path,
    plan_path: Path,
    build_md_path: Path,
    review_path: Path,
    qa_report_path: Path,
    followups_template_path: Path,
) -> str: ...

def write(path: Path, body: str) -> None: ...
```

Rendered sections (in order):

1. `# followups-context.md` + generated-at comment.
2. `## Brief: Non-goals` — lifted from brief's Non-goals section (frequent source of followup candidates).
3. `## Plan: Risks` — lifted from plan's Risks section.
4. `## Review: Decision + findings` — lifted from review.md's Decision and Findings sections.
5. `## QA: Known issues` — lifted from qa/report.md's Known issues section (if present).
6. `## Build: Deviations from plan` — lifted from build.md's Deviations from plan section.
7. `## follow-ups.md schema` — inlined template with YAML frontmatter example (category enum, etc.).
8. `## Rules` — bullets:
   - "Read-only stage. Do not modify code or prior artifacts."
   - "Write 1–5 entries OR a single `no_followups` sentinel entry. The CLI rejects empty or > 5 entries."
   - "Each entry's frontmatter must have title, motivation, suggested_scope, category. Category is the enum: tech_debt | scope_extension | bug_risk | refactor | docs | deferred_from_bounce | no_followups."

Local helpers (duplicated): `_read()`, `_section()`. `_collect_id_blocks()` not needed.

No worktree metadata block — followups is post-validate, the worktree state doesn't change.

### D. Three `cmd_*.py --init` write sites

Each gets a private helper named `_write_<stage>_context_artifacts(cfg, run_id, …)` that mirrors `cmd_start._write_build_context_artifacts`:

```python
def _write_shape_context_artifacts(cfg, run_id: str) -> None:
    """Render shape-context.md. Idempotent. Errors swallowed.
    Mirrors cmd_start._write_build_context_artifacts."""
    try:
        rd = metadata.run_dir(cfg, run_id)
        raw_idea_path = rd / "raw-idea.md"
        answers_path = rd / "answers.md" if (rd / "answers.md").exists() else None
        brief_template_path = cfg.root / "templates" / "brief.md"
        body = shape_context.build(
            raw_idea_path=raw_idea_path,
            answers_path=answers_path,
            brief_template_path=brief_template_path,
        )
        shape_context.write(rd / "shape-context.md", body)
    except Exception:
        pass
```

The plan and followups variants follow the same shape, varying only in which paths are gathered. Each is called from its `cmd_*.py:--init` mode at the insertion point described in "Current repo understanding."

`cmd_followups.py` is the trickiest because its `--init` also performs the `validating → followups` transition. The curated file must be written BEFORE the transition (so it lives in the right stage dir after the transition moves files around). See DR-002 below.

### E. Three slash-command body updates

Each `.claude/commands/<stage>.md` gains a Step 1.5 (or extends an existing step) with this language pattern (adapted from `validate.md` step 2):

> Read `runs/$RUN_ID/<stage>-context.md`. Do NOT re-read `<prior artifact 1>`, `<prior artifact 2>`, or `templates/<stage>.md` separately if `<stage>-context.md` already covers what you need. Re-reads in the master session pay a permanent cache cost.

Concrete texts:

- **shape.md**: "Read `runs/$RUN_ID/shape-context.md`. Do NOT re-read `raw-idea.md`, `answers.md`, or `templates/brief.md` separately if `shape-context.md` already covers what you need."
- **plan.md**: "Read `runs/$RUN_ID/plan-context.md`. Do NOT re-read `brief.md` or `templates/plan.md` separately if `plan-context.md` already covers what you need. (You still need to read code in the worktree — that's where the planner's leverage is.)"
- **followups.md**: "Read `runs/$RUN_ID/followups-context.md`. Do NOT re-read `brief.md`, `plan.md`, `build.md`, `review.md`, or `qa/report.md` separately if `followups-context.md` already covers what you need."

### F. lifecycle.md updates

Each of the three stage tables gets:

1. A new "Curated entry context" sub-block describing the `*-context.md` file: what it lifts inline, which file generates it, and a back-reference to the §5 TODO origin (mirroring building's existing block).
2. A `*-context.md` row in the table sibling to "Reads" and "Produces" (or simply add it to "Produces" if a separate row reads awkward — the building stage's table uses a sub-block, not a row, so go with sub-block for consistency).

### G. Tests

Each new `tests/test_<stage>_context.py` mirrors `test_build_context.py`'s shape:

- Class `Test<Stage>ContextBuild(unittest.TestCase)` using `tempfile.mkdtemp` setUp/tearDown.
- Helper `_build()` that constructs synthetic prior artifacts and invokes `<stage>_context.build(...)`.
- ~6–8 tests per file:
  - `test_renders_all_sections` — assert each `## ` heading appears.
  - `test_lifts_<source>_section` — assert a specific lifted section's content appears.
  - `test_missing_optional_input_omits_section` — e.g. shape with no answers.md, plan with no "Files likely to change" in brief.
  - `test_rules_block_present` — assert the stage-specific Rules block bullets appear.
  - `test_worktree_metadata_rendered` — plan-context only.
  - (plan-context) `test_repo_map_detects_<language>` — synthetic worktree with a pyproject.toml / package.json / etc.
  - (plan-context) `test_repo_map_handles_missing_worktree` — worktree_path is None, fallback string appears.

Plus a small integration-style class per file mirroring `TestWriteBuildContextArtifacts` — uses `make_tmp_workbench()` from `_helpers.py` to construct a flat-layout run, calls the cmd-level helper directly, asserts the file exists and contains expected content.

### H. docs/TODO.md update

After everything else lands, mark §5's three remaining unchecked sub-tasks as `[x]` and prepend a "Shipped 2026-05-27 in run …" note inline with each, mirroring how the build-context.md task is annotated today.

## Files likely to change

- `agent-workbench-live/lib/shape_context.py` (new)
- `agent-workbench-live/lib/plan_context.py` (new)
- `agent-workbench-live/lib/followups_context.py` (new)
- `agent-workbench-live/lib/cli/cmd_shape.py`
- `agent-workbench-live/lib/cli/cmd_plan.py`
- `agent-workbench-live/lib/cli/cmd_followups.py`
- `agent-workbench-live/.claude/commands/shape.md`
- `agent-workbench-live/.claude/commands/plan.md`
- `agent-workbench-live/.claude/commands/followups.md`
- `agent-workbench-live/docs/lifecycle.md`
- `agent-workbench-live/tests/test_shape_context.py` (new)
- `agent-workbench-live/tests/test_plan_context.py` (new)
- `agent-workbench-live/tests/test_followups_context.py` (new)
- `docs/TODO.md`

## Data model changes

None. `metadata.yaml` is untouched. No new transition events. No new lifecycle states. The new context files live at `runs/$RUN_ID/<stage>-context.md` at write time, and `cmd_<stage>` finalize-mode moves them into `stages/N_<stage>/` as part of the existing transition file-move logic (the new files inherit that behavior because they live in the same run-dir scan).

## UI changes

None. No board or list output changes. The new files appear in `runs/<id>/` directory listings; that's it.

## Test plan

**Unit tests** (new):

- `tests/test_shape_context.py`: ~6 tests covering renders-all-sections, lifts-raw-idea, optional-answers-handling, rules-block-present, write-helper-idempotency, and integration via cmd_shape's helper.
- `tests/test_plan_context.py`: ~8 tests covering renders-all-sections, lifts-brief, repo-map-detects-python, repo-map-detects-javascript, repo-map-handles-missing-worktree, files-likely-to-change-lift, worktree-metadata-block, integration via cmd_plan's helper.
- `tests/test_followups_context.py`: ~7 tests covering renders-all-sections, lifts-{non-goals,risks,findings,known-issues,deviations}, schema-block-present, integration via cmd_followups's helper.

**Existing tests that must still pass:**

- `tests/test_e2e.py::TestE2EHappyPath::test_happy_path` — drives the full lifecycle; the three new `--init` write sites must not break the existing transitions.
- `tests/test_self_modifying.py::TestSelfModifying::test_new_run_creates_worktree_and_clean_master` — the workbench-targets-itself path; verifies adding the new files doesn't pollute master.
- `tests/test_build_context.py` and `tests/test_validate_context_build.py` — unchanged; the existing two siblings stay behavior-compatible.

**Run command (from agent-workbench-live worktree):**

```bash
cd /Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__generalize-stage-context-md-followups/agentic-development-task-system-v3__ai/agent-workbench-live
python -m unittest tests.test_shape_context tests.test_plan_context tests.test_followups_context -v
python -m unittest discover tests -v
```

## QA plan

Per the brief's Suggested QA scenarios:

1. After the implementation lands and the run reaches `validating`, the validator should see all three new files written into their respective `stages/N_<stage>/` directories (after each stage's transition moves them). Spot-check via `ls runs/$RUN_ID/stages/`.
2. The validator should drive a synthetic "missing-input" scenario: temporarily rename `runs/$RUN_ID/answers.md` before re-running `agent-workbench shape $RUN_ID --init`, confirm `shape-context.md` is re-rendered without the Answers section, and that no error appears on stderr beyond the expected warning.
3. Read each generated `<stage>-context.md` end-to-end and confirm:
   - All expected sections are present.
   - Lifted-inline content matches the source artifact verbatim (modulo heading depth normalization if any).
   - The Rules block contains the stage-specific bullets.
   - For plan-context: the repo-map block correctly identifies this run's worktree as a Python repo (pyproject.toml present) with pytest discoverable.

## Risks

1. **`cmd_followups.py --init` performs the transition; ordering is delicate.** If `_write_followups_context_artifacts()` is called AFTER `transitions.transition()`, the file might land in the wrong stage dir (validating-stage dir vs. followups-stage dir). Mitigation: call it BEFORE the transition (so the file lives at `rd/followups-context.md`, then the transition's file-move logic relocates it to `stages/6_followups/`). Verify via integration test. Low-medium risk — easy to test, easy to fix if wrong.
2. **`plan-context.md`'s `_detect_repo_map()` is the only meaningful new logic.** Misdetection (false-positive language, missing manifest) would render an inaccurate repo-map. Mitigation: keep the detection rules narrow (presence of canonical manifest files only — no heuristics), document each rule as a code comment, write language-specific unit tests. If a manifest is absent, the language is simply not listed; no fabrication. Low risk for the happy path; medium if we try to be too clever.
3. **The brief assumed build/test commands come from `agent-workbench.yaml`'s policies block; they don't.** This run's plan changes the source to "detect from target repo manifests." If a target repo has no recognizable manifest, the build/test section reads "no build/test commands detected" — that's acceptable degradation. Low risk; documented as ASM-001.
4. **`templates/brief.md`, `templates/plan.md`, `templates/follow-ups.md` are inlined verbatim.** If any template gains HTML comments or has unexpected structure, the rendered `<stage>-context.md` carries them through. That's fine for shape (the brief template is meant to be a skeleton the agent edits); it's mildly distracting for plan (the planner sees the template structure inline). Mitigation: leave the template content verbatim — the agent sees the same thing it would see by reading the template directly. Zero risk; behavior-preserving.
5. **The three new generators duplicate helpers.** `_read()`, `_section()`, etc. now exist in five places. If a future change needs to update parsing behavior, all five must be updated. Mitigation: document in each new generator's docstring that helpers are intentionally duplicated; the divergence rationale is already in `build_context.py`'s docstring. Low risk; consistent with the existing pattern.
6. **`shape-context.md`'s value is genuinely modest.** Shape has the least prior context to filter; the win is mostly inlining the template. If the agent ends up still reading `templates/brief.md` separately out of habit, the cache-discipline win is lost. Mitigation: the new shape.md slash-command body explicitly says "Do NOT re-read templates/brief.md." Re-evaluate after a few runs; if the inline-template lift turns out to be wasted bytes, the file can be slimmed down without changing the contract. Low risk per ASM-002.
7. **No new dependencies, but `_detect_repo_map()` may shell out to `find` / `ls`.** Mitigation: use `pathlib.Path.iterdir()` only, no subprocess calls. Pure Python. Zero risk.

## Definition of done

- Three new generator modules exist with the public surface described above; each compiles, has a docstring matching the build_context.py pattern, and locally duplicates the parsing helpers.
- Three new `_write_<stage>_context_artifacts()` helpers exist in the corresponding `cmd_*.py`, each wrapped in `try/except Exception: pass`, called from `--init` at the documented insertion point.
- Three new slash-command bodies have the curated-file read instruction (mirroring `validate.md` step 2's wording).
- `docs/lifecycle.md` has a Curated entry context sub-block in each of the shape, plan, followups stage sections (mirroring building's existing sub-block).
- Three new test files exist with the test counts described in Test plan; `python -m unittest discover tests` passes locally.
- `docs/TODO.md` §5 has the three remaining sub-tasks marked `[x]` with a "Shipped 2026-05-27 in run …" annotation.
- The full E2E (`tests/test_e2e.py`) and self-modifying (`tests/test_self_modifying.py`) suites pass without modification.
- Manual spot-check: re-running `agent-workbench shape $RUN_ID --init`, `… plan … --init`, `… followups … --init` on this very run produces the three new files at the expected paths.

## Preflight

- **Worktree**: `/Users/timothy.shee/GitHub/LOCAL_worktrees/new-tech-monorepo/agent-workbench-live/worktrees/agentic-development-task-system-v3-ai/20260527__generalize-stage-context-md-followups/agentic-development-task-system-v3__ai`. Confirmed exists; run dir is inside it. Self-modifying run.
- **Branch**: `agent/generalize-stage-context-md-followups` (auto-derived). Will be created by `/start`.
- **base_ref**: `master`. base_ref_sha will be resolved at `/start` time.
- **Python**: 3.10+ (per existing module shebangs).
- **No new dependencies**: stdlib + existing `lib/yaml_io.py` / `lib/metadata.py` / `lib/runs.py` / `lib/repos.py` only.
- **No CI changes**: tests run via `python -m unittest discover tests` (the workbench's existing convention).
- **`templates/brief.md`, `templates/plan.md`, `templates/follow-ups.md`**: all confirmed to exist at the workbench root's `templates/`. They will be re-read live by each generator at runtime (not snapshotted at import).

## Decisions & assumptions

### DR-001

- **Decision**: `plan-context.md`'s `_detect_repo_map()` detects languages and build/test commands by checking for canonical manifest files at the worktree root only — no recursive scanning, no heuristics. Specifically: `pyproject.toml` → Python (lift `[tool.pytest]` / `[tool.poetry.scripts]` if present); `package.json` → JavaScript/TypeScript (lift `scripts` block if present); `Cargo.toml` → Rust (lift `[package]` name and `cargo test` as default test command); `go.mod` → Go (default `go test ./...`); `Makefile` → check for `test:` and `build:` targets and lift them. No other manifests are recognized in this pass. If none match, the repo-map says "no recognized manifests at worktree root" and lists top-level dirs only.
- **Rationale**: Narrow detection is easier to test, less likely to misfire, and the §5 brief explicitly calls out that this is "deterministic and front-loaded" work — heuristics defeat that. The four manifest types above cover every repo the workbench targets in practice (workbench-itself, app, fender, ddl-py).
- **Alternatives considered**: (a) heuristic scanning (look for `*.py` files → assume Python), (b) shell out to `tree` / `find` for a richer map, (c) read CI configuration files (`.github/workflows/*.yml`, `.buildkite/`) to extract commands.
- **Why not the alternatives**: (a) too noisy — a config file with one .py snippet would falsely trigger Python. (b) external dependency, harder to test deterministically. (c) too repo-specific and CI configs are voluminous — would inflate plan-context.md past its cache-discipline goal. Manifest-only is the smallest accurate signal.

### DR-002

- **Decision**: In `cmd_followups.py`, `_write_followups_context_artifacts()` is called BEFORE `transitions.transition()`. The curated file is written at `runs/$RUN_ID/followups-context.md` and the transition's standard file-move logic relocates it to `stages/6_followups/` along with the staged `follow-ups.md` template.
- **Rationale**: The transition moves files based on their location at transition time; writing first ensures the file is in the right place when the transition fires. Writing after would either (a) require manual relocation logic in the cmd helper, or (b) leave the file in `validating/`-stage dir, hidden from the followups agent.
- **Alternatives considered**: Write after the transition, then move manually to `stages/6_followups/`.
- **Why not the alternative**: Adds bespoke move logic to the cmd helper; bypasses the existing transition file-move convention; risks divergence from how `validate-context.md` and `build-context.md` are written (both written at the start of a stage, before transitioning into it).

### DR-003

- **Decision**: Each new generator module duplicates `_read()`, `_section()`, `_HEADING_RE`, and (where used) `_collect_id_blocks()` locally. No extraction to a `lib/_context_common.py`.
- **Rationale**: Continues the existing convention from `build_context.py`'s docstring: "Helper functions are duplicated (not imported from validate_context) because the two builders may diverge as the other `<stage>-context.md` siblings land." With five generators in the family, premature consolidation forecloses future divergence (e.g. `plan_context._section()` may want different blank-line handling than `followups_context._section()`). A shared module can be extracted later if the helpers stay verbatim across all five for a sustained period.
- **Alternatives considered**: Extract to `lib/_context_common.py` now and import in all five generators.
- **Why not the alternative**: Existing convention says duplication is correct for this family; consolidating now requires editing all five generators on every helper tweak, and the duplication cost (one regex + three short functions × five modules) is small.

### DR-004

- **Decision**: `shape-context.md` is built (per the run's answers.md decision: "Build it for consistency"). Its `## Rules` block emphasizes the cache-discipline win specifically because shape's prior-artifact set is smallest; the inlined-template lift is the dominant value.
- **Rationale**: Skipping shape would leave the §5 contract uneven (4/5 stages have a curated context). The code is the thinnest of the three new modules. Future subagent work (§10) benefits from contract uniformity.
- **Alternatives considered**: Skip shape, record a DR-explaining skip in TODO §5.
- **Why not the alternative**: User explicitly chose "Build it for consistency" in the draft Q2 answer. Skip would require revisiting later anyway when §10 lands.

### DR-005

- **Decision**: The three new `_write_<stage>_context_artifacts()` helpers each accept only the args they need (not a uniform signature). `_write_shape_context_artifacts(cfg, run_id)` is sufficient; the plan and followups variants take only what they read.
- **Rationale**: The existing two (`cmd_start._write_build_context_artifacts` and `cmd_validate._write_validate_context_artifacts`) have different signatures already — uniformity isn't the existing convention. Keeping each helper's signature minimal matches the local-scope-only pattern.
- **Alternatives considered**: A shared `_write_context_artifact(cfg, run_id, stage)` dispatcher.
- **Why not the alternative**: Adds indirection without saving lines; each cmd has its own metadata-loading and path-resolution boilerplate that the dispatcher would need to duplicate or factor differently.

### DR-006

- **Decision**: Order of work in the build stage: `shape_context.py` → `followups_context.py` → `plan_context.py`. Shape and followups are mechanically simpler (no repo-map logic); doing them first builds confidence in the pattern before tackling plan's `_detect_repo_map()`. Tests in the same order.
- **Rationale**: De-risks the most novel logic (repo-map detection) by landing it last, with the pattern firmly established. Each generator can land as its own commit on the agent branch.
- **Alternatives considered**: Plan first (highest leverage), then followups, then shape.
- **Why not the alternative**: Highest-leverage-first is the right strategic ordering when implementations are independent; here they share patterns, so confidence-first ordering compounds better.

### ASM-001

- **Text**: `agent-workbench.yaml`'s policies block does NOT carry build/test command information. The brief's assumption that `plan-context.md` would source build/test commands from `agent-workbench.yaml` is wrong. The plan-context generator detects them from the target repo's manifests (see DR-001).
- **Reason**: Confirmed by the Explore subagent that mapped `agent-workbench.yaml` — its policies block contains only behavioral toggles (`local_only`, `one_repo_per_run`, etc.). No build/test/lint commands.
- **Impact**: medium — the implementation deviates from the brief's stated source for build/test commands. The deviation is captured here (and in plan-context.md's repo-map section) so reviewers can confirm the change is acceptable.

### ASM-002

- **Text**: `shape-context.md`'s leverage is real but modest. The primary win is inlining the brief.md template so the agent doesn't context-switch into `templates/`. If post-landing observation shows the agent still reads `templates/brief.md` separately out of habit (e.g. via some other tool or skill), the contract holds but the cache-discipline win is dampened.
- **Reason**: Shape has the least prior context to filter — no brief, plan, or review yet. The lifted content is just the raw idea + answers + the template skeleton.
- **Impact**: low — the file is cheap to build; if it underperforms expectations, the response is to slim it down or update the slash-command body to enforce the read more firmly, not to roll it back.

### ASM-003

- **Text**: The `templates/plan.md` template currently includes inline section blocks for `## Preflight` and `## Decisions & assumptions` (the staged-runs convention). When plan-context.md inlines `templates/plan.md`'s skeleton verbatim, those blocks appear in the rendered file. The planning agent reading plan-context.md sees them and authors them in the run's `plan.md` directly.
- **Reason**: Confirmed by reading the staged `plan.md` for this very run — it already has Preflight + Decisions & assumptions sections inline.
- **Impact**: low — this is the expected behavior; the template is the single source of truth for plan.md's structure, and plan-context.md just lifts it.

### ASM-004

- **Text**: `cmd_followups.py --init` performs the `validating → followups` transition. The `_write_followups_context_artifacts()` call inserts between `_stage_template()` and `transitions.transition()`. After the transition, `runs/$RUN_ID/followups-context.md` is moved into `stages/6_followups/followups-context.md` by the existing transition file-move logic.
- **Reason**: The transition file-move logic relocates loose files in the run dir into the appropriate `stages/N_<stage>/` directory based on the stage being entered. Writing the curated file at the run root before the transition lets that logic do the right thing without bespoke move code.
- **Impact**: medium — the assumption depends on the existing transition file-move logic actually relocating arbitrary new files; if it only moves a whitelisted set, the followups-context.md would be left at the run root. Verification: write the file, trigger the transition, check that `runs/$RUN_ID/followups-context.md` no longer exists and `runs/$RUN_ID/stages/6_followups/followups-context.md` does. Adjust if wrong (likely just add the filename to whatever whitelist exists).
