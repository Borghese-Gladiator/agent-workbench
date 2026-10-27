# Review

## Decision

approve

Rationale: every acceptance criterion is met (verified empirically — 20/20 real runs validate clean, schema is now load-bearing, the strict/warn modes behave per the brief, duplicate guard hard-fails, walker emits the four problem codes the brief calls for). 415-test suite has 28/28 metadata tests passing; the 2 failures are pre-existing date-baked snapshots unrelated to this change. The hand-roll choice (DR-001) is well-defended given the stdlib-only constraint; the integrity guard ships as honest defense in depth after the duplicate-bug investigation found nothing reproducible. Findings below are minor cleanups and forward-looking notes, not blockers.

## Did the implementation satisfy the brief?

Yes, all five acceptance criteria are met:

1. **Typo in nested key produces warning under default, error under strict** — `TestValidationMode::test_warn_mode_silent_on_unknown_key` confirms silent-on-unknown in warn (matches the brief's "may produce an info-level note but never a warning or error in default mode"); `test_strict_mode_raises_on_unknown_key` confirms hard-fail under strict; manual QA confirms a wrong-type at `target.repo` raises in strict and warns in warn.
2. **Existing runs load without warnings** — `qa/artifacts/validate_real_runs.log` shows 20/20 real runs with zero non-`unknown_key` problems AND zero `unknown_key` problems. The schema is precise.
3. **Test coverage** — missing required (top + nested), mistyped scalar (root + nested), enum violation (status + repo.mode), additive backcompat (unknown key tolerated in warn): all present, mostly parametrized via `subTest`.
4. **Duplicate-file investigation written up** — `docs/LOG.md` entry explains the three parallel `Explore` subagents and the finding "not reproducible". Defensive guard ships anyway with two dedicated tests in `TestDuplicateMetadataIntegrity`.
5. **Schema is load-bearing** — `lib/metadata.py:_load_schema_from_path` + `_walk` + the import-time `_assert_constants_match_schema` collectively make the schema the source of truth. The module docstring lines 1-39 document the contract.

## Did it accidentally expand scope?

Largely no. Scope is appropriate. Two near-misses worth noting (neither rises to a finding):

- `_validate(data)` (the pre-existing fast-path called by `save()`) was kept rather than replaced — the rewrite restricted the old function to a structural pre-check that only runs on write. That's a sensible narrowing, not a scope expansion. The narrative in `docs/LOG.md` calls this out.
- `_assert_constants_match_schema()` runs at module import time. This is a load-time side effect added to `metadata.py`. It has a safety guard (`if not schema_path.exists(): return`) so tooling-only environments don't break. Reasonable, but it does mean any third-party importer of `lib.metadata` (e.g. a tool inside a fresh worktree before schemas are populated) silently tolerates a missing schema. Acceptable trade-off; documented in the function docstring.

Depth-1 file inventory matches the brief's expected scope exactly: schema, metadata module, agent-workbench.yaml (one new key under `policies`), tests, and the docs (LOG + TODO renumber). No unexpected adjacent files touched.

## Are there fragile assumptions?

A few, all minor:

1. **`_load_schema_from_path` cache key is the `pathlib.Path` object.** The `lru_cache(maxsize=4)` could return stale data if a test mutates the schema file in place (same path, different content). Today no test does this; the warn/strict tests mutate `agent-workbench.yaml`, not the schema. **Risk: future-test footgun, not a current bug.**
2. **`tests/_helpers.py:reset_caches()` doesn't clear `metadata._load_schema_from_path.cache`.** Each `make_tmp_workbench()` copies the schema to a new temp path, so the cache key differs per test — collision-safe in practice, but the cache grows by one entry per test method (capped at `maxsize=4`, so older entries evict). No correctness risk; could be cleaner if `reset_caches` were complete.
3. **The duplicate-file guard uses `rglob("metadata.yaml")`** and matches anywhere in the tree. Today `lifecycle.py` does not move `metadata.yaml` (line 37: "The module never reads or writes metadata.yaml") and no template ships a stray copy (verified by `grep -r metadata.yaml templates/`), so false-positive risk is nil. If a future feature ever legitimately needs a *second* `metadata.yaml` (e.g. for archived run versions), this guard would block it. Documented in `_check_duplicate_metadata`'s docstring.
4. **`Python int` rejection of `bool` (line 81 of `metadata.py`).** The schema has two `int` leaves: `validation.known_issues_count` and `build.{iterations,max_iterations}`. None of these legitimately accept a bool, so the strictness is correct. **Verified.**
5. **`_validation_mode` reads `policies.metadata_validation` from `cfg.raw`.** The default-when-absent path returns `"warn"`. The TestValidationMode test mutates `cfg.raw` indirectly by rewriting `agent-workbench.yaml` and reloading `config.load(self.tmp)`. Implementation is correct; assumption is that `cfg.raw` always reflects on-disk truth, which is true in this codebase.

## Are there missing tests?

A few thin spots, none blocking:

- **No assertion that warn mode prints `unknown_key` to stderr at any level.** Per the brief: "they may produce an info-level note." The implementation chose "silent" (DR-004) which matches the brief's "tolerated by default — may produce an info-level note but never a warning or error." Documented as a design decision; the user explicitly approved this in shaping. If the user later wants info-level visibility, this is a one-line change in `_report_problems`.
- **No test for the module-import drift assertion (`_assert_constants_match_schema`).** It runs at import time so testing requires a sub-process or schema-mutation-then-reimport — both possible but heavyweight. The function is well-guarded (early-return on missing-file or unparseable-schema). Acceptable.
- **No test that `validate()` with no `schema` argument falls through to the shipped schema.** `lib/metadata.py:215` resolves the schema relative to `__file__`. Could break in odd packaging scenarios, but the project has no packaging.
- **No round-trip test for `Problem.__eq__` / hash.** The dataclass is `frozen=True`, so equality works; tests already do `assertIn("missing_required", codes)` which is sufficient.

## Are there security / data loss / migration risks?

- **Data loss**: none. The validator never mutates data — `validate()` is pure, `_walk` only appends to `problems`, `_check_duplicate_metadata` only raises. `save()` is unchanged.
- **Migration**: existing 20 runs validate clean under both warn AND strict mode (verified — zero unknown keys across the board). So flipping `policies.metadata_validation: strict` today would not break any existing run.
- **Security**: no auth, network, or shell-out surface added.
- **Failure-mode for legit edge cases**: if `agent-workbench.yaml` is missing or `policies:` is null, `_validation_mode` reads `(cfg.raw.get("policies") or {})` — handles the null-`policies` case correctly. Good.

## What should the human review first?

In priority order:

1. **`lib/metadata.py:73-220`** — the type-token table, `_walk`, and `validate()`. This is the new core. Read it once to confirm the schema vocabulary is what you want long-term. Specifically check the `_type_matches` handling of unions (line 99 — `type:` can be `str | list`).
2. **`schemas/run-metadata.yaml`** — confirm the field types reflect your intent. The biggest design call is which fields are `required: true` vs `required: false`. Today `target.repo.base_ref_sha` is optional (deliberately — added 2026-05-23 lazily to existing runs); `build:` is optional (legacy `2026-05-18-poker` predates the block); `target.worktree.path` is optional. If you'd rather backfill and tighten, that's a fast follow-up.
3. **`agent-workbench.yaml` lines 30-34** — the new `metadata_validation: warn` knob. Decide whether you'd rather ship `strict` as the default given that all 20 real runs already validate clean.
4. **`lib/metadata.py:310-344`** — the import-time drift assertion. Make sure the import-time side-effect is something you're OK with; alternative is to call it lazily.
5. **`tests/test_metadata.py:280-318`** — the unknown-key behavior. If you want warn mode to *surface* unknown keys at info level (per the brief's optional language), that's a one-line change in `_report_problems`.

## Blast radius

The CLI did not append a "Scope creep check" section to this review.md, meaning depth-1 changes stayed within the expected scope (schema, metadata module, config, tests, LOG, TODO). Verified independently.

Depth-2: `_walk`, `_check_duplicate_metadata`, `_filter_problems_for_mode`, `_report_problems`, `_validation_mode`, `_load_schema_from_path` are all brand-new symbols introduced by this run. The blast-radius depth-2 list shows them with edges into `docs/LOG.md` and `tests/test_metadata.py` only — i.e. no caller outside this run depends on them. Good. The `validate` and `Problem` symbol names produce massive depth-2 hit lists in the blast-radius dump (e.g. `lib/metadata.py:validate -> ...110+ files`), but inspection shows those are all unrelated `validate`/`Problem` symbols in other repos under the monorepo (the v1/v2 ancestor repos, other vendor projects). The `git grep`-based caller resolver has no semantic information; the noise is expected and harmless.

Depth-3: same story — symbol-name collisions across unrelated repos. None of the listed files actually import from this run's `lib/metadata.py`.

No depth-2 file lives outside the brief's expected scope.

## Findings

### F-001 (minor): warn-mode unknown-key visibility may surprise

- **Severity**: minor
- **Where**: `lib/metadata.py:256-263` (`_filter_problems_for_mode`)
- **Issue**: Under warn mode, unknown keys are *fully silent* (filtered out before `_report_problems`). The brief allows "info-level note." The user's stated reviewer concern is whether warn-mode silence "defeats the typo-catching benefit too aggressively." Given that all 20 real runs have zero unknown keys today, silence has zero current cost — but a typo like `target.repo.nme` will load silently and only fail later when something tries to read the (still-missing) `name`. In strict mode this is caught.
- **Suggested fix**: Either (a) ship `policies.metadata_validation: strict` as the default given the empirical clean state, or (b) emit `unknown_key` to stderr in warn mode prefixed with `[info]` to keep the visible-but-not-noisy property. One-line change in `_filter_problems_for_mode` and one in `_report_problems` to tag the line level. **Recommendation**: defer to follow-up; the design is in-spec per the brief.

### F-002 (minor): `_assert_constants_match_schema` import-time side effect

- **Severity**: minor
- **Where**: `lib/metadata.py:344` (top-level call at import)
- **Issue**: Reads schema from disk on every import of `lib.metadata`. Guarded against missing file, but still performs I/O at import. For test reruns and CLI invocations, this is fine (single import per process). The fall-through for unparseable schema (line 322-324, `except MetadataError: return`) silently swallows any `MetadataError` from `_load_schema_from_path` — which means a corrupted schema would also silently disable the drift check. A second `_load_schema_from_path` call from `validate()` would raise on the same corrupt schema, which surfaces the problem at load time. So in practice the corruption isn't permanently hidden.
- **Suggested fix**: None required. If the import-time side effect ever becomes a concern, move the assertion into a `Config`-bound check that fires at CLI bootstrap instead. Note for future.

### F-003 (minor): `_helpers.reset_caches()` doesn't clear `metadata._load_schema_from_path`

- **Severity**: minor (forward-looking)
- **Where**: `tests/_helpers.py:27-32`
- **Issue**: New `lru_cache` on `_load_schema_from_path` is not cleared by `reset_caches()`. Today this is safe because each `make_tmp_workbench()` produces a unique schema path → unique cache key. But if a future test mutates the in-place schema file within a single workbench (same path, different content), the cache will return stale data. Easy to add now while the convention is fresh.
- **Suggested fix**: Add `from lib import metadata as md_mod; md_mod._load_schema_from_path.cache_clear()` to `reset_caches()`. Two lines.

### F-004 (minor): `build.md` was left as the empty template

- **Severity**: minor (process, not code)
- **Where**: `runs/2026-05-27-.../stages/4_building/build.md`
- **Issue**: The builder's `build.md` was not filled in — all sections are still `<!-- ... -->` placeholders. The bulk of the build narrative landed in `docs/LOG.md` (which is the right place for cross-run history) but the per-run `build.md` was meant to capture acceptance-criteria coverage and reviewer reading order. The validate-context.md generation reflects this — every "Test results" sub-section is empty.
- **Suggested fix**: Not blocking. If the validate CLI's audit pass cares about the `build.md` Documentation-touched section, it may flag this; in that case populate it. Otherwise treat as a process improvement for the next run.

