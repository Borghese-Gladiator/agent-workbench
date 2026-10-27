# Implementation plan

## Current repo understanding

`agent-workbench-live/lib/metadata.py` is the sole owner of `runs/<run_id>/metadata.yaml` reads and writes. It exposes `load()`, `save()`, `create()`, `update()`, `set_status()`, plus `STATUSES` and `REQUIRED_TOP_LEVEL`. Today's `_validate(data)` (lines 97-105) checks only three things: that `data` is a dict, that all `REQUIRED_TOP_LEVEL` keys are present, and that `status` is in `STATUSES`. Nothing checks nested structure — `target.repo`, `target.worktree`, `validation`, `completion`, and `build` are unvalidated. A typo like `target.repo.nme` loads silently and only crashes when downstream code dereferences the missing real key.

`schemas/run-metadata.yaml` exists but is descriptive — the only reference in code is `cmd_doctor.py:73` listing it as a file to sanity-check. Real-run shape (sampled across 20 existing runs):

- always present: `schema_version`, `run_id`, `status`, `created_at`, `updated_at`, all five sub-blocks (`target`, `scope`, `artifacts`, `validation`, `completion`, `build`), and their nested keys
- nullable: `target.repo.{base_ref_sha,fingerprint,created_by_run}`, `target.worktree.{path,initial_commit_sha}` (set later in lifecycle), all `artifacts.*` (filled stage-by-stage), all `completion.*` (until done/abandoned), `build.{iterations,exit_reason}` (until `validate --init`).

`agent-workbench.yaml` has a `policies:` block (lines 19-28) — natural home for a new `metadata_validation: warn | strict` flag. The codebase reads optional config via `cfg.raw.get(...)` with a default fallback (`cmd_validate.py:92-99` is the precedent).

The project is **stdlib-only Python 3**. No `pyproject.toml`, no `requirements.txt` at root, no external schema libraries installed. Tests use `unittest` (`python3 -m unittest discover -s tests -v`), `unittest.TestCase` subclasses, and helpers from `tests/_helpers.py` (`make_tmp_workbench`, `cleanup`, `reset_caches`). `tests/test_metadata.py` already has a backward-compat test (lines 82-139) that constructs raw YAML inline — that pattern extends cleanly to the new validation cases.

**Duplicate-`metadata.yaml` bug — investigation finding:** Not reproducible in current code. Across all 20 existing runs in both master and worktree views, every run tree contains exactly one `metadata.yaml`, at the run root. The only write site in the codebase is the atomic temp-write-then-rename pattern at `lib/metadata.py:135-137`, called only from `save()`. `save()` is called from `create()`, `set_status()`, and `update()` — never doubled. `lifecycle.py:153-177`'s `_STAGE_OUTPUTS` move table targets only the stage's markdown artifact, never `metadata.yaml`. The phenomenon the user may have seen is most likely TODO §1's master-vs-worktree divergence (same file at two different git refs), not a within-tree duplicate. I will still ship a defensive guard that refuses to load when more than one `metadata.yaml` is found under a single run tree — cheap, and pays for itself if the bug surfaces later.

## Relevant files

- `agent-workbench-live/lib/metadata.py` — `load()`, `_validate()`, `STATUSES`, `REQUIRED_TOP_LEVEL`, atomic write at lines 135-137.
- `agent-workbench-live/schemas/run-metadata.yaml` — currently descriptive; will become load-bearing.
- `agent-workbench-live/agent-workbench.yaml` — `policies:` block at lines 19-28.
- `agent-workbench-live/tests/test_metadata.py` — existing test suite; add new parametrized cases.
- `agent-workbench-live/tests/_helpers.py` — `make_tmp_workbench` fixture.
- `agent-workbench-live/lib/cli/cmd_doctor.py:73` — already references the schema file; will keep working.
- `agent-workbench-live/runs/*/metadata.yaml` — 20 real runs used as backward-compat oracles.

## Proposed changes

### 1. Re-target `schemas/run-metadata.yaml` from "documentation" to "load-bearing JSON-schema-shaped doc"

Restructure the file so each section explicitly declares: `required:` list, `optional:` list, and a `type:` mapping per field. Keep it YAML (no new dep), and keep the existing template at the end. The header block becomes the contract the validator reads, not just illustrative prose.

Example shape (final form is decided as decisions DR-002/DR-003 below):

```yaml
schema:
  schema_version: {type: int, required: true, eq: 1}
  run_id:         {type: str, required: true}
  status:         {type: str, required: true, enum: [draft, shaping, planning, ready, building, validating, followups, human_review, done, abandoned]}
  created_at:     {type: str, required: true}
  updated_at:     {type: str, required: true}
  target:
    type: dict
    required: true
    keys:
      repo:
        type: dict
        required: true
        keys:
          mode:           {type: str, required: true, enum: [existing, new]}
          path:           {type: str, required: true}
          name:           {type: str, required: true}
          base_ref:       {type: str, required: true}
          base_ref_sha:   {type: [str, null], required: true}
          fingerprint:    {type: [str, null], required: true}
          created_by_run: {type: [str, null], required: true}
      worktree:
        type: dict
        required: true
        keys:
          name:                {type: str, required: true}
          path:                {type: [str, null], required: true}
          branch_name:         {type: str, required: true}
          created:             {type: bool, required: true}
          base_ref:            {type: str, required: true}
          initial_commit_sha:  {type: [str, null], required: true}
  scope:      {type: dict, required: true, free_form: true}   # not deep-validated
  artifacts:  {type: dict, required: true, free_form: true}   # not deep-validated
  validation:
    type: dict
    required: true
    keys:
      required:            {type: bool, required: true}
      review_completed:    {type: bool, required: true}
      qa_completed:        {type: bool, required: true}
      qa_recorded:         {type: bool, required: true}
      tests_passed:        {type: [bool, null], required: true}
      known_issues_count:  {type: int, required: true}
  completion:
    type: dict
    required: true
    keys:
      accepted_by:       {type: [str, null], required: true}
      completion_ref:    {type: [str, null], required: true}
      completed_at:      {type: [str, null], required: true}
      abandoned_reason:  {type: [str, null], required: true}
  build:
    type: dict
    required: true
    keys:
      iterations:      {type: [int, null], required: true}
      exit_reason:     {type: [str, null], required: true}
      max_iterations:  {type: int, required: true}
```

`scope` and `artifacts` are tagged `free_form: true` and skipped per the brief's non-goal. `schema_version: 1` is enforced (acts as an upgrade gate for future schema bumps).

### 2. Add a schema-walker validator inside `lib/metadata.py`

A new internal module-level helper, e.g. `_load_schema()` (lru-cached, reads `schemas/run-metadata.yaml` once) plus `_validate_against_schema(data, schema, run_id) -> list[Problem]`. `Problem` is a small dataclass: `path: str`, `code: str`, `message: str`. The walker:

- recurses through schema keys, mirroring the data tree.
- for each schema field, checks: presence (if `required: true`), type (allowing `null` if listed in the `type` union), enum (if `enum:` present), eq (if `eq:` present).
- for unknown keys at any level not marked `free_form`, emits a `code: unknown_key` problem (severity adjustable by mode — see DR-004).
- accumulates all problems instead of failing fast — one load reports every issue, not just the first.

Public surface added:

- `validate(data, run_id) -> list[Problem]` — pure, callable from tests.
- `_validate()` (existing) extends to call the schema walker, then decides whether to warn-print or raise based on the mode flag.

The existing `REQUIRED_TOP_LEVEL` tuple and `STATUSES` set stay as Python constants but become *generated from the schema* (or asserted equal at import time) so the schema is single source of truth. Cheaper choice: leave them as belt-and-braces literals and assert equality at import time — fail loudly if they drift.

### 3. Mode flag in `agent-workbench.yaml` policies

Add `policies.metadata_validation: warn` (default). Allowed values: `warn` | `strict`. Read at the call site in `metadata.load()` via `cfg.raw.get("policies", {}).get("metadata_validation", "warn")`. In `warn` mode, problems print one line per problem to stderr, prefixed with the run_id, and `load()` returns the data. In `strict` mode, problems print AND raise `MetadataError` with all messages joined.

### 4. Duplicate-file integrity guard

Before reading YAML, `load()` runs a `glob` for `metadata.yaml` under the resolved run dir's full subtree (excluding `stages/` archived markdown — but `metadata.yaml` is never moved to stages, so a true match means a real duplicate). If `len(matches) > 1`, raise `MetadataError` immediately with both paths in the message — independent of warn/strict mode. Cheap to compute; runs on every load.

### 5. Tests

Extend `tests/test_metadata.py` with parametrized cases. Since the suite uses stdlib `unittest`, parametrization is via per-test loops or `subTest` (decision DR-005). New cases:

- top-level required-key missing
- nested required-key missing under `target.repo`
- mistyped scalar (string where dict expected, list where scalar expected)
- enum violation on `status`
- enum violation on `target.repo.mode`
- additive backward compat: unknown extra key under default mode → no warning/error
- unknown extra key under strict mode → error
- duplicate `metadata.yaml` in run tree → hard-fail regardless of mode
- real-data smoke: load each of the 20 existing `runs/*/metadata.yaml` under default mode and assert zero problems (acceptance criterion #2)

### 6. Module docstring

Update `lib/metadata.py`'s module docstring to describe the field-type contract pointer to `schemas/run-metadata.yaml`, and call out that the schema is now load-bearing (was descriptive).

## Files likely to change

- `agent-workbench-live/lib/metadata.py`
- `agent-workbench-live/schemas/run-metadata.yaml`
- `agent-workbench-live/agent-workbench.yaml`
- `agent-workbench-live/tests/test_metadata.py`

Possibly:

- `agent-workbench-live/tests/_helpers.py` — only if a new test fixture (e.g. "make a metadata dict") is genuinely shared. Default: no.
- `agent-workbench-live/lib/cli/cmd_doctor.py` — only if doctor should surface validation problems in its check list. Default: no for this run (defer to a follow-up).

## Data model changes

No on-disk format changes. The validator enforces the existing shape; it does not add or remove fields. Strict mode is opt-in. `schema_version` stays at `1` — a future shape change would bump it.

## UI changes

None. CLI behavior change: under default `warn` mode, `metadata.load()` may print one-or-more `metadata.yaml: run=<id>: <path>: <message>` lines to stderr. Under `strict` mode, the same conditions raise and produce a non-zero CLI exit.

## Test plan

Unit tests (`python3 -m unittest tests.test_metadata -v`):

1. `test_validate_missing_top_level_key` — drop `created_at`; assert problem with path `created_at`, code `missing_required`.
2. `test_validate_missing_nested_key` — drop `target.repo.name`; assert problem with path `target.repo.name`.
3. `test_validate_mistyped_scalar` — set `target` to a string; assert problem `target: wrong_type`.
4. `test_validate_enum_violation_status` — set `status: shapeing`; assert enum problem.
5. `test_validate_enum_violation_mode` — set `target.repo.mode: weird`; assert enum problem.
6. `test_validate_unknown_extra_key_default_mode_tolerated` — add `favorite_color: blue`; warn mode loads clean (no exception). Capture stderr; assert no warning emitted in warn mode for unknown keys (DR-004 decides: warn mode = silent on unknown; strict mode = error). Update if DR-004 lands differently.
7. `test_validate_unknown_extra_key_strict_mode_errors` — same, strict mode → `MetadataError`.
8. `test_validate_typo_warn_then_strict` — misspell `target.repo.nme` → warn mode emits stderr line, returns data; strict mode raises.
9. `test_duplicate_metadata_files_hard_fail` — drop a second `metadata.yaml` under `runs/<id>/stages/`; `load()` raises in both modes; message contains both paths.
10. `test_real_runs_load_clean` — iterate `runs/*/metadata.yaml` in the actual repo, call `load()` in warn mode for each, assert zero problems. (Skipped if running outside repo via env check.)
11. Backward-compat existing tests (`test_load_without_build_block`, etc.) — must continue passing untouched.

QA (manual, after green tests):

- Copy a real `metadata.yaml` to a scratch dir, misspell `target.repo.name` as `target.repo.nme`. Run `agent-workbench status <run_id>` (or `list-runs`). Expect one stderr warning, exit 0.
- Edit `agent-workbench.yaml` to set `policies.metadata_validation: strict`. Repeat. Expect: same message, exit non-zero.
- Drop a junk key `favorite_color: blue`. Default mode: silent. Strict mode: warning or error per DR-004.
- Manually create a second `metadata.yaml` deep in a run tree. Run any load. Expect: hard error, both paths named, regardless of mode.

## QA plan

Same as the manual section above. Captured in `qa-report.md` after the build stage. Tester role: developer running the workbench CLI.

## Risks

- **False positives on real data.** Acceptance criterion #2 forbids this. Mitigation: test #10 above loads every existing run in CI and asserts clean; ship blocked on that test passing.
- **Schema drift between `schemas/run-metadata.yaml` and Python constants.** Mitigation: import-time assertion that `STATUSES` set equals the schema's enum, and `REQUIRED_TOP_LEVEL` equals the schema's top-level required set. Fail loudly on drift.
- **Performance regression on hot paths.** `metadata.load()` runs many times per CLI invocation (every `cmd_*.py` reads it). The schema walker is O(fields) ~50 fields — negligible — but lru-cache the parsed schema, never re-read it per load.
- **Duplicate-file glob false positives.** If the run tree happens to contain another file *named* `metadata.yaml` (template, fixture), the glob misfires. Mitigation: glob is scoped to `runs/<id>/**/metadata.yaml` only; templates live at `agent-workbench-live/templates/`, schemas at `agent-workbench-live/schemas/` — both outside `runs/`. Audited: zero existing run tree contains a second match.
- **Strict mode is destructive if defaulted on.** Mitigation: default stays `warn`. Strict is opt-in. Documented in module docstring and `agent-workbench.yaml` comment.
- **Discovering during /build that the duplicate-file bug is real after all.** The current investigation says "not reproducible." If implementation reveals a real path, scope expands. Mitigation: the defensive guard ships regardless, so a future regression is caught — even if we don't find the source today.

## Definition of done

- `schemas/run-metadata.yaml` rewritten to a schema-walker-readable shape; the file is read by `lib/metadata.py:load()` at runtime.
- `lib/metadata.py` extended with a schema walker, a `validate()` function callable from tests, a duplicate-file integrity guard in `load()`, and an updated module docstring.
- `agent-workbench.yaml` gains `policies.metadata_validation: warn` (default).
- `tests/test_metadata.py` covers all eleven cases listed in the test plan; the full suite passes via `python3 -m unittest discover -s tests -v`.
- All 20 existing `runs/*/metadata.yaml` files load clean under default mode (no warnings, no errors).
- A typo'd top-level key under `target.repo` produces a warning at load (default) and an error (strict). Verified manually.
- Manual duplicate-`metadata.yaml` scenario hard-fails in both modes.
- Module docstring on `lib/metadata.py` documents the field-type contract.

## Preflight

- **Tooling:** Python 3, stdlib `unittest`. No new dependencies. Verified: no `pyproject.toml` change required.
- **Repo state:** worktree at `2026-05-27-schema-level-validation-for-metadata-yaml`, branch `agent/schema-level-validation-for-metadata-yaml`, base `HEAD` at `6374738`. Clean to start.
- **Tests baseline:** `python3 -m unittest discover -s tests -v` is expected to pass at the base ref before any change.
- **Backward-compat oracle:** 20 real runs under `agent-workbench-live/runs/`. Test #10 iterates all of them.
- **Self-modifying note:** changes live inside `agent-workbench-live/lib/` — the workbench mutates itself. The run that triggers `/build` should continue to operate against the *current* checked-out version of `metadata.py`, not the version being built. No in-flight load happens against the new schema until after build commits.

## Decisions & assumptions

### DR-001
- **Decision**: Hand-roll the schema walker in `lib/metadata.py` against a schema described in `schemas/run-metadata.yaml`. Do **not** add an external schema library (pydantic, jsonschema, cerberus).
- **Rationale**: The project is stdlib-only with no `pyproject.toml`. Adding a top-level dependency introduces packaging questions (poetry? uv? plain pip?) that this run shouldn't have to answer. The user said "as thorough as it needs to be" and explicitly listed hand-roll OR library as acceptable; the schema is shallow (~50 fields, one nesting level deep) and the walker is ~80 lines. A library would buy little here.
- **Alternatives considered**: pydantic v2 (typed models per block), jsonschema (load a JSON schema and validate), cerberus (Python-native schema dict).
- **Why not the alternatives**: pydantic forces a class-per-block design that doesn't fit the existing dict-shaped API; jsonschema requires translating YAML to JSON Schema's vocabulary (which is verbose for this size); cerberus is the closest fit but still adds a dep for marginal gain. Revisit if the schema grows to multiple nesting levels or needs $ref-style reuse.

### DR-002
- **Decision**: Schema lives in `schemas/run-metadata.yaml` in a hand-designed YAML shape (`{type, required, enum, eq, keys, free_form}` per field), parsed by `_load_schema()` and walked recursively.
- **Rationale**: Keep schema in YAML so docs and contract are the same artifact; users editing the schema don't need to know Python.
- **Alternatives considered**: Schema as a Python literal in `lib/metadata.py`; schema as a separately checked-in JSON file.
- **Why not the alternatives**: Python literal duplicates the existing YAML; JSON loses readability for the human reading the schema.

### DR-003
- **Decision**: `scope` and `artifacts` are tagged `free_form: true` and skipped by the walker. The walker still requires the top-level key to *exist* and be a dict, but does not descend.
- **Rationale**: The brief's non-goal section says these blocks are free-form by design. Enforcing them would break runs that legitimately use varying artifact subsets per scope kind.
- **Alternatives considered**: Validate `artifacts.*` keys against a fixed list; validate `scope.kind` enum but skip `scope.summary`.
- **Why not the alternatives**: The fixed list of artifacts already drifts (e.g. `audit` is sometimes present, sometimes absent). Validating `scope.kind` is *almost* worth doing — but the CLI's `--scope-kind` arg already enforces the enum at write time, so the load-time check is redundant. Revisit if `scope.kind` divergence appears in real data.

### DR-004
- **Decision**: Unknown extra keys are tolerated silently in `warn` mode. In `strict` mode, they emit a problem with code `unknown_key` and trigger the strict-mode error.
- **Rationale**: Acceptance criterion #2 forbids false positives on existing data, but existing data is clean today — the risk is *future* drift adding new keys. Default-silent on unknowns means a developer who adds a new field doesn't break every existing CLI run before the validator schema is updated. Strict mode catches it for the developer who opts in.
- **Alternatives considered**: Warn on unknown keys in default mode too; ignore unknown keys entirely in both modes.
- **Why not the alternatives**: Warning-by-default is noisy during a schema migration. Ignoring entirely in strict mode loses the value of strict mode for catching typos that happen to be one-letter-off from a valid key.

### DR-005
- **Decision**: Parametrize new tests using `unittest.TestCase.subTest()` rather than restructuring the suite to pytest.
- **Rationale**: The existing suite is stdlib `unittest`. Switching to pytest adds a dependency. `subTest` is the stdlib idiom for parametrization and gives per-case failure output.
- **Alternatives considered**: Add pytest as a dev dependency; write one method per case without parametrization.
- **Why not the alternatives**: pytest dep contradicts DR-001's spirit. One-method-per-case is fine but verbose; subTest keeps the suite tidy.

### DR-006
- **Decision**: The duplicate-`metadata.yaml` integrity check uses `glob("**/metadata.yaml", recursive=True)` scoped to the run directory and ignores files older than the run dir's `created_at`. If >1 match, raise `MetadataError` immediately with all paths listed.
- **Rationale**: Glob is cheap, runs once per load (lru-cacheable per-run-dir-mtime if it becomes hot). The age guard prevents false positives from manually-archived old copies.
- **Alternatives considered**: Skip the guard entirely (investigation says no current bug); use `os.walk` and bail on the first second hit (slightly faster but messier message).
- **Why not the alternatives**: Skipping leaves a future regression undetectable. `os.walk` is a micro-optimization that doesn't matter at this scale.

### DR-007
- **Decision**: `STATUSES` (set) and `REQUIRED_TOP_LEVEL` (tuple) stay in Python as constants but are asserted equal to their schema-derived counterparts at module import time.
- **Rationale**: The constants are referenced by other modules. Removing them is a wider refactor than this run needs. The import-time assertion catches drift without changing the public API.
- **Alternatives considered**: Generate them from the schema; remove the constants entirely.
- **Why not the alternatives**: Either change broadens scope (cmd_*.py and transitions.py read these constants). Defer to a follow-up.

### ASM-001
- **Text**: The duplicate-`metadata.yaml` bug is not real in current code. The user is most likely recalling TODO §1 (master-vs-worktree divergence) or a one-off historical artifact.
- **Reason**: Direct evidence — all 20 existing run trees inspected, exactly one `metadata.yaml` per tree; single atomic write site at `lib/metadata.py:135-137`; no copy/move/glob operations target `metadata.yaml`; lifecycle's `_STAGE_OUTPUTS` only moves markdown artifacts.
- **Impact**: medium — if wrong, we still ship the defensive guard, so a real bug surfaces loudly. But we do not implement a root-cause fix this run because there is no observed root cause to fix.

### ASM-002
- **Text**: Adding a `metadata_validation` key to `agent-workbench.yaml`'s `policies:` block is non-breaking — existing checked-in configs without the key will fall back to `warn` and behave as before.
- **Reason**: All reads use `cfg.raw.get("policies", {}).get("metadata_validation", "warn")` with a literal default.
- **Impact**: low.

### ASM-003
- **Text**: The 20 existing `runs/*/metadata.yaml` files are clean under the new schema as proposed (no field-type or enum violations under default mode).
- **Reason**: The schema was designed *from* the union of keys observed across 3 sampled runs; I extrapolated to the other 17 from naming conventions. Test #10 verifies this empirically at build time. If a run fails to load, scope the fix to *either* loosening the schema (if the schema is wrong) *or* fixing the offending metadata via a one-off backfill (if the data is wrong).
- **Impact**: high — if multiple real runs fail validation, the run is blocked until resolved. Resolution path is well-trodden (TODO mentions a `tools/backfill_base_ref_sha.py` precedent).

### ASM-004
- **Text**: The user has not pre-approved any specific schema library, and the hand-roll + YAML-schema design (DR-001/DR-002) is the right call for this run.
- **Reason**: User said "evaluate options during `/shape`"; `/shape` deferred library choice to `/plan`; `/plan` chose hand-roll given the stdlib-only project context. If the user disagrees, this is reversible — the validator's public API (`validate(data, run_id) -> list[Problem]`) is library-agnostic.
- **Impact**: medium — wrong call means rework; right call means we ship cleanly.
