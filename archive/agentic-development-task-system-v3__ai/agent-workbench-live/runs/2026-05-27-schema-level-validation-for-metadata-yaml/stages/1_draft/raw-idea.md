> Extracted from `docs/TODO.md` §7 on 2026-05-27.

## 7. Schema-level validation for `metadata.yaml` on load

`lib/metadata.py:_validate` enforces top-level keys + the status enum only. `schemas/run-metadata.yaml` is descriptive — `metadata.load()` doesn't read it. Typos like `bse_ref` instead of `base_ref` load silently, surface later as missing-field crashes or wrong-data renders. As fields proliferate (`base_ref_sha`, `target.worktree.branch_name`, the `build:` block, the new `completion:` shape), the surface area for silent drift grows.

- [ ] Add a lightweight YAML-schema validator (or hand-roll typed accessors that raise on missing-or-mistyped) that walks `target.repo`, `target.worktree`, `validation`, `completion`, `build` and enforces field types + enum values on load.
- [ ] Surface mismatches as warnings by default; error behind a strict mode toggled in `agent-workbench.yaml`'s policies block.
- [ ] Keep `artifacts` and `scope` un-validated for this pass — they're free-form by design.
- [ ] Update `schemas/run-metadata.yaml` to be load-bearing rather than descriptive; document the field-type contract in `lib/metadata.py`'s module docstring.

### Acceptance

- A `metadata.yaml` with a typo'd top-level key under `target.repo` produces a warning at load time and an error under strict mode.
- Existing `runs/` directories load without warnings (no false positives on real data).
- `tests/test_metadata.py` covers at least: missing required field, mistyped scalar, enum violation, additive backward compat (unknown extra key tolerated under default mode).

---

### User notes for this run (in addition to TODO §7 above)

- **Don't default to "lightweight."** The TODO offers "lightweight YAML-schema validator OR hand-rolled typed accessors" as a hint — but I want the schema validator to be **as thorough as it needs to be** to actually enforce that `metadata.yaml` has all the info it needs. If a real schema library (e.g. `pydantic`, `jsonschema`, `cerberus`, or similar) gives better guarantees than a hand-roll, prefer it. Evaluate options during `/shape`. The goal is correctness + clear error messages, not minimal LOC.
- **Investigate the duplicate `metadata.yaml` bug.** I suspect there is a bug where duplicate `metadata.yaml` files are being created (e.g. nested under the run directory, or written twice by different code paths). Before implementing the schema validator, **investigate whether this is actually happening** and, if so, scope a fix into this run. Look for: multiple `metadata.yaml` files within a single `runs/<run_id>/` tree, write-paths in `lib/metadata.py` that could fire twice, and `cmd_*.py` call sites that might double-write. If the duplication is real, the validator should also fail loudly when it encounters more than one `metadata.yaml` for a single run.
