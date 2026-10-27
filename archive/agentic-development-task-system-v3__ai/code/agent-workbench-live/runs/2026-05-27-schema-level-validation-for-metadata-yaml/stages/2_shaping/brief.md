# Brief

## Goal

Make `metadata.yaml` self-validating on load so typos and shape drift fail loudly instead of silently. Replace the current minimal top-level-key check with a thorough schema that walks the nested structure (`target.repo`, `target.worktree`, `validation`, `completion`, `build`) and enforces field presence, types, and enum values every time `metadata.load()` runs.

Secondary, scoped into this run: investigate whether duplicate `metadata.yaml` files are being written under a single `runs/<run_id>/` tree. If real, fix the write-path and have the new validator refuse to load when more than one `metadata.yaml` exists per run.

## User-facing behavior

"User" here = the developer running the workbench CLI and the agents driving slash commands. There is no end-user UI.

- A `metadata.yaml` whose top-level or nested keys are mistyped (e.g. `bse_ref` for `base_ref`, `target.workree` for `target.worktree`) produces a clear, single-line warning to stderr at load time, naming the offending key path and the run_id.
- A `metadata.yaml` with a mistyped scalar (e.g. a list where a string is expected) or an out-of-enum value (e.g. `status: shapeing`) produces the same warning shape.
- A missing required field also produces a warning by default — load still succeeds with whatever data is present, matching today's behavior so existing runs don't break.
- When `agent-workbench.yaml`'s policies block sets a strict-mode flag, all of the above become hard errors that abort the load with a non-zero exit at the CLI boundary.
- Unknown extra keys at any level are tolerated by default (additive backward compat) — they may produce an info-level note but never a warning or error in default mode. Strict mode may reject them; that's a sub-decision to surface in `/plan`.
- If duplicate `metadata.yaml` files exist within a single run tree, the load always fails (regardless of mode) with a message naming both paths. This is treated as an integrity violation, not a schema mismatch.

## Acceptance criteria

Carried over verbatim from the TODO plus the duplicate-file addendum:

1. A `metadata.yaml` with a typo'd top-level key under `target.repo` (e.g. `target.repo.nme` instead of `target.repo.name`) produces a warning at load time and an error under strict mode.
2. Existing `runs/` directories load without warnings under default mode — zero false positives on real data already on disk.
3. `tests/test_metadata.py` covers at least:
   - missing required field (top-level and nested),
   - mistyped scalar (string where dict expected, list where scalar expected),
   - enum violation (bad `status`),
   - additive backward compat (unknown extra key tolerated under default mode).
4. Duplicate-file investigation produces a written finding (in the run's notes or a stage artifact). If the bug is real, the fix is included in this run and there is a test that demonstrates the load refuses to proceed on a run tree containing two `metadata.yaml` files.
5. `schemas/run-metadata.yaml` is load-bearing: `metadata.load()` reads it (or an in-code equivalent generated from it) rather than the file existing only as documentation. The field-type contract is documented in `lib/metadata.py`'s module docstring.

## Non-goals

- Validating `artifacts` or `scope` blocks — both are free-form by design for this pass.
- Building a general-purpose schema framework usable by other YAML files in the repo. Scope is `metadata.yaml` only.
- Refactoring `lib/metadata.py`'s public API. Existing callers must keep working unchanged; `load()` stays `load()`.
- Migrating older `metadata.yaml` files to a new shape. Schema additions must remain additive — old files keep loading.
- Building a UI or rich diagnostic renderer. A clear, single-line stderr warning per problem is enough.
- Validating `agent-workbench.yaml` itself.

## Good examples

- `lib/metadata.py:load()` calls a single `_validate(data, run_id, strict=...)` helper that walks the schema and accumulates problems before deciding whether to warn or raise. Tests can call the same helper directly with synthetic dicts.
- The schema is expressed once, in `schemas/run-metadata.yaml` (or a generated/imported Python equivalent), and consumed by both `metadata.load()` and `tests/test_metadata.py`. Adding a new required field is a one-line schema change plus a test.
- Strict mode is keyed off a single named flag in `agent-workbench.yaml`'s policies block, e.g. `policies.metadata_validation: strict` vs `warn`. The default is `warn`. The flag's name and location are decided in `/plan`.
- Warning output looks like: `metadata.yaml: run=2026-05-27-foo: unexpected key 'target.repo.nme' (did you mean 'name'?)`. One line per problem, prefixed with the run_id so a batch load is greppable.
- Duplicate-file check is the first thing the loader does — before reading YAML — so even a malformed second copy can't mask the first. It uses a glob like `runs/<run_id>/**/metadata.yaml` and refuses if more than one match.

## Bad examples

- Hand-rolling a deep `if "target" not in data: raise ...` ladder. The user explicitly said: prefer a real schema library if it gives better guarantees than a hand-roll, and to evaluate options during `/shape` (deferred to `/plan` since library choice is implementation). Either way, avoid the unstructured-ladder dead-end.
- Failing loudly on unknown extra keys in default mode. That breaks acceptance criterion #2 — existing runs would regress.
- Coupling the validator to filesystem layout (e.g. baking `runs/` into the validator). The validator takes a parsed dict + run_id and returns problems; the loader handles I/O.
- Logging warnings via `print(...)` to stdout. Use stderr, or the project's logging convention, so machine consumers of CLI stdout aren't polluted.
- Treating "duplicate `metadata.yaml`" as a soft warning. It's an integrity error — always hard-fail.
- Validating fields that the brief explicitly excludes (`artifacts`, `scope`).
- Renaming `schemas/run-metadata.yaml` or moving it; downstream consumers may reference the path.

## Constraints

- **No new heavyweight dependency without justification.** If a schema library is added (pydantic, jsonschema, cerberus, etc.), `/plan` must record why hand-rolled typed accessors aren't enough. The user explicitly wants thoroughness over minimal LOC, but new top-level deps still need a written rationale.
- **Backward compat is mandatory.** Real runs already on disk must load without warnings in default mode. The brief's acceptance criterion #2 is a hard gate.
- **Strict mode must be opt-in.** Default behavior cannot change for existing users.
- **The validator must run on every `metadata.load()` call.** Not just at CLI entry — every stage that re-reads metadata gets the check.
- **Investigate before fixing the duplicate-file bug.** The brief commits to producing a written finding. If the bug isn't reproducible, document that and only ship the validator's "refuse if >1" guard as a defense in depth.
- **Code is in `agent-workbench-live/lib/metadata.py`.** Self-modifying repo — changes apply to the workbench itself. Stage 1_draft/raw-idea + this brief sit in the worktree; tests run in the worktree.

## Assumptions

- The schema covers exactly the blocks the TODO names: `target.repo`, `target.worktree`, `validation`, `completion`, `build`. If `/plan` discovers other blocks (e.g. `metrics`, `events`), they're documented as out-of-scope unless they trivially fit.
- The duplicate-`metadata.yaml` bug, if real, lives in one of: `lib/metadata.py`'s write path, a `cmd_*.py` call site that writes twice, or a worktree-vs-master path confusion (the workbench writes a copy on the master side at some lifecycle stages — see TODO §1).
- TODO §1 ("master-side `metadata.yaml` after `cmd_complete`") describes a related-but-distinct phenomenon: that's about reconciling a stale master-side copy after completion. The duplicate-file bug suspected here is about *concurrent* duplicates within a single run tree. `/plan` should confirm these are distinct before proceeding.
- The "policies block" already exists in `agent-workbench.yaml`. If it doesn't, adding a new top-level `policies:` block is in scope; the validator's strict-mode flag is the first entry.
- Test fixtures use real-looking dicts, not on-disk fixture files, so the suite stays hermetic.
- The user accepts that a schema library, if chosen, will appear in `pyproject.toml` (or equivalent). They have not pre-approved a specific library — that decision lives in `/plan`.

## Suggested QA scenarios

Manual (run after implementation):

- Load a known-good run from `runs/` — no warnings, no errors, exit 0.
- Temporarily edit a copy of a real `metadata.yaml` to misspell `target.repo.name` as `target.repo.nme`. Run a workbench command that triggers a load (e.g. `agent-workbench status <run_id>`). Expect: one stderr warning naming the bad key path; exit 0.
- Flip strict mode on in `agent-workbench.yaml` and repeat the previous step. Expect: same message but exit non-zero.
- Drop an extra junk key (`favorite_color: blue`) into the same file. Default mode: no warning. Strict mode: warning or error (whichever `/plan` lands on).
- Manually create a second `metadata.yaml` deeper in the run tree (e.g. `runs/<id>/stages/1_draft/metadata.yaml`). Run any load. Expect: hard error, both paths named, exit non-zero, *regardless* of strict mode.

Unit (in `tests/test_metadata.py`):

- Parametrized: each acceptance-criteria case (#3 from the TODO).
- Each enum field on `status` gets one in-bounds and one out-of-bounds case.
- Backward-compat fixture: a minimal `metadata.yaml` that predates new fields like `build`, `completion`, `base_ref_sha` — must still load clean in default mode.
- Duplicate-file: build a `tmp_path` with two `metadata.yaml` files and assert `load()` raises with both paths in the message.

Investigation deliverable (for the duplicate-file bug):

- A written finding (one paragraph) in the run's plan or a stage artifact: "is the bug real? where? what fixes it?" If real, the implementation includes the fix and a regression test.
