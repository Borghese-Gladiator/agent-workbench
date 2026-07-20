# Follow-ups

These candidates emerged from the schema-level-validation run. None were
executed here; each is a forward-looking bite for a future run.

---
title: Surface unknown_key problems in warn mode (or ship strict as default)
motivation: DR-004 chose silence-on-unknown for warn mode, in line with the brief's "may produce an info-level note but never a warning or error." Empirically, all 20 real runs validate with zero unknown keys today, so silence has zero current cost. But a typo like `target.repo.nme` will load silently under the default mode and only fail later when downstream code dereferences the (still-missing) `name`. That defeats some of the typo-catching value the user originally asked for. The brief landed at "thorough enforcement, default warn" — once the soak period confirms no real-run regressions, the next bite is to tighten the visible behavior in warn mode (info-level stderr line) or promote strict to default.
suggested_scope: Pick one of two paths and ship it. **Path A** (small): in `lib/metadata.py:_filter_problems_for_mode` and `_report_problems`, retain `unknown_key` problems in warn mode but tag them as `[info]` (or `[unknown]`) on the stderr line so they're visible-but-distinct from genuine warnings. One-line filter change plus a level prefix in the reporter. Add a test in `TestValidationMode` asserting warn-mode stderr emits the info line. **Path B** (slightly bigger): flip `policies.metadata_validation` default to `strict` in `agent-workbench.yaml` (and the template if one is added), update DR-004's reasoning in the module docstring, and verify all 20 real runs still load clean. Both paths preserve back-compat (the policy key is read with a default). Pick one — Path A is the lower-risk first move.
category: scope_extension
---

The user explicitly approved silence during shaping, so this is not a bug
fix — it's the next bite once the conservative default has earned trust.

---
title: Defer or remove the import-time schema-drift assertion in lib/metadata.py
motivation: `_assert_constants_match_schema()` at `lib/metadata.py:344` runs at module import time and reads the schema from disk. It's guarded by `if not schema_path.exists(): return` and by a broad `except MetadataError: return`, so it doesn't crash tooling-only environments — but it does do file I/O on every import and silently disables itself if the schema is unparseable. The reviewer flagged this (F-002) as a load-time side effect added by this run. For test reruns and one-shot CLI invocations the cost is negligible, but the broader pattern (silent fall-through on corrupted schema) is the kind of thing that hides regressions.
suggested_scope: Move the drift assertion out of module-import scope. Options: (a) call it lazily from `validate()` on first invocation, gated by a module-level `_drift_checked` flag; (b) call it from a CLI bootstrap step (`lib/cli/cmd_doctor.py` already references the schema file — natural home for an explicit drift check that fails loudly). Keep the import-time call as a one-line wrapper that does nothing unless `AW_DEBUG=1` (or similar). Add a test that the assertion still runs at least once per CLI invocation. Touches `lib/metadata.py` plus one CLI file plus one new test.
category: tech_debt
---

---
title: Clear the _load_schema_from_path lru_cache in tests/_helpers.reset_caches
motivation: This run added `@lru_cache(maxsize=4)` to `lib/metadata._load_schema_from_path`. `tests/_helpers.py:reset_caches()` already clears the other module caches between tests but doesn't touch this one. Today it's safe because each `make_tmp_workbench()` produces a unique schema path (so cache keys differ per test), and the `maxsize=4` cap evicts older entries naturally. But the moment a future test mutates a schema file in place — same path, different content — the cache will return stale data and the test will pass for the wrong reason. Easy to fix while the convention is fresh; reviewer flagged as F-003.
suggested_scope: Add `from lib import metadata as md_mod; md_mod._load_schema_from_path.cache_clear()` to `tests/_helpers.reset_caches()`. Two-line change. Add one regression test that mutates the schema file in place between two `validate()` calls and asserts the second call reflects the new schema. No other files need to change.
category: tech_debt
---

---
title: Generate STATUSES and REQUIRED_TOP_LEVEL from the schema instead of belt-and-braces literals
motivation: DR-007 deferred this on purpose — `STATUSES` (set) and `REQUIRED_TOP_LEVEL` (tuple) stay as Python constants in `lib/metadata.py` and the import-time drift assertion catches mismatches. That's a sensible defer, but the duplication is real: two places to update on every schema change, and `cmd_*.py` / `transitions.py` import the Python constants directly. Now that the schema is load-bearing (this run's whole point), the constants are downstream of the schema and should be derived from it. The drift assertion is essentially admitting this — it exists only because the two representations can diverge.
suggested_scope: Replace the literal `STATUSES` and `REQUIRED_TOP_LEVEL` declarations with module-level computed values: `STATUSES = frozenset(_load_schema()["status"]["enum"])` and `REQUIRED_TOP_LEVEL = tuple(k for k, v in _load_schema().items() if isinstance(v, dict) and v.get("required"))`. Remove `_assert_constants_match_schema` (no longer needed). Audit callers: `lib/cli/cmd_*.py`, `lib/transitions.py` — they consume the same names, so the API surface is unchanged. Verify the full test suite still passes. Adds one new test confirming the computed values match the previous literals (one-time guard during the refactor). Touches `lib/metadata.py` plus the new test; no caller changes expected.
category: refactor
---

---
title: Block /validate from advancing when stages/4_building/build.md is template-identical
motivation: F-004 in the review noted that this run's `stages/4_building/build.md` is still the empty template — every section is a `<!-- ... -->` placeholder. The builder put the real narrative in `docs/LOG.md` (correct for cross-run history) but the per-run `build.md` was meant to carry acceptance-criteria coverage and reviewer reading order. The validate audit didn't flag it, and the run still transitioned cleanly to `followups`. That's a tooling gap: nothing forced the builder to produce a real `build.md`. A future reviewer landing in `runs/<id>/stages/4_building/` to triage will see boilerplate and have to chase the narrative to LOG.md. The transition engine already validates other artifacts (e.g. plan.md preflight, review.md decision); applying the same check to `build.md` closes the gap.
suggested_scope: In `lib/transitions.py` (the function that handles `building -> validating`), compare the run's `stages/4_building/build.md` against `templates/build.md` byte-for-byte (or after stripping HTML comments). If they match — or if `## Files changed` and `## Acceptance criteria coverage` sections contain only placeholder comments — refuse the transition with a clear error. Optionally allow an `--allow-template-build` escape hatch for self-modifying workbench runs. Add a test in `tests/test_transitions.py` for both the refuse and allow paths. Touches `lib/transitions.py` (one new check) plus a new helper plus one test method.
category: tech_debt
---
