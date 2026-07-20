# QA report

## Summary

- **tests_passed**: true (16/16 new + 337/339 full suite; 2 pre-existing snapshot failures unrelated to this change)
- **known_issues_count**: 2 (both documented in `build.md` — not blocking)

## What ran

- Unit tests for the new `lib/build_context.py` — `python -m pytest tests/test_build_context.py -v` (16 cases).
- Full test suite — `python -m pytest tests/ --tb=short` (339 cases).
- Manual smoke for `/start` via throwaway run `2026-05-25-bctx-smoke` — confirmed `build-context.md` lands at the expected worktree path with all 11 sections populated correctly.

## Results

### Unit tests

`tests/test_build_context.py` — **16 passed, 0 failed**.

Coverage by case:

- `TestBuildContextBuild::test_renders_all_sections` — all 11 top-level headings present (`# build-context.md`, `## Acceptance criteria`, `## Non-goals`, `## Proposed changes`, `## Files likely to change`, `## Test plan`, `## Definition of done`, `## Decisions & assumptions`, `## Worktree`, `## build.md template skeleton`, `## Rules`).
- `test_brief_sections_inlined` / `test_plan_sections_inlined` — content lifts correctly from brief + plan.
- `test_decisions_block_includes_all_dr_and_asm` — DR-001 and ASM-001 both appear (DR-004 in plan: no filter against build.md at building-entry).
- `test_worktree_block_renders_metadata` — path, branch, base_ref, base_ref_sha all rendered from meta dict.
- `test_template_inlined` — template contents appear under the `## build.md template skeleton` section.
- `test_rules_block_load_bearing_one_liners` — the "Stay bounded" and "Record deviations" sentences both present.
- `test_missing_brief_section_emits_fallback` / `test_missing_plan_section_emits_fallback` — `(none in brief.md)` / `(none in plan.md)` fallback rendered when section is missing.
- `test_missing_template_emits_fallback` — `(templates/build.md missing or empty)` fallback rendered when template path doesn't exist.
- `test_missing_brief_file_does_not_crash` — builder doesn't crash; falls back gracefully.
- `test_missing_meta_fields_render_fallback` — `(not set)` fallback for empty `meta`.
- `test_returns_string` — sanity: return type is `str`.
- `test_write_creates_parent_dir` — `build_context.write` creates `stages/4_building/` if missing.
- `TestWriteBuildContextArtifacts::test_writes_build_context_md_for_flat_run` — integration: `cmd_start._write_build_context_artifacts` writes the file to the right place for a flat-layout run.
- `TestWriteBuildContextArtifacts::test_swallows_builder_exception` — integration: when `build_context.build` raises, the helper swallows; transition succeeds; file is absent (proves the except fired).

Log: `qa/artifacts/test_build_context.log` (16 PASSED, 0 FAILED, runtime ~0.3s).

### Integration tests

Full suite covers the integration surface area. See **Full suite** below. No regressions in `test_e2e.py`, `test_self_modifying.py`, `test_lifecycle.py`, or `test_metadata.py`.

### Lint / typecheck

Not run. `agent-workbench-live` does not have lint/typecheck configured today (no `mypy`, `ruff`, or equivalent in the repo). No new external dependencies introduced (pure stdlib).

### Browser / Playwright

N/A — backend-only Python change.

### Smoke scripts

`agent-workbench` CLI smoke via the throwaway run `2026-05-25-bctx-smoke`:

1. `agent-workbench new-run --repo-path <wt> --worktree-name bctx-smoke --idea-file /tmp/aw-idea-bctx-smoke.md` — created run; printed run_id.
2. `agent-workbench shape <id> --init` → staged brief template; transitioned `draft → shaping`.
3. (Wrote synthetic brief.)
4. `agent-workbench shape <id>` → transitioned `shaping → planning`.
5. `agent-workbench plan <id> --init` → staged plan template.
6. (Wrote synthetic plan.)
7. `agent-workbench plan <id>` → transitioned `planning → ready` with STOP banner.
8. `agent-workbench start <id> --approved-by qa-smoke` → transitioned `ready → building`; printed worktree path. **Verified `build-context.md` written to `runs/2026-05-25-bctx-smoke/stages/4_building/build-context.md`** with all 11 expected sections and content correctly lifted from synthetic brief + plan + metadata + `templates/build.md`.

Manual visual inspection of the rendered `build-context.md`: every section is populated, fallback paths not triggered (all expected content present), worktree-metadata triple shows real values (path, branch, base_ref_sha).

## Captured artifacts

- `qa/artifacts/test_build_context.log` — pytest output for the 16 new cases.
- `qa/artifacts/pytest_full.log` — full suite pytest output.

## Known issues (informational, not blocking)

1. **Visual hierarchy noise in rendered `build-context.md`.** The inlined `templates/build.md` skeleton contains its own `##` headings (e.g. `## What changed`, `## Files changed`) that render as siblings to `build-context.md`'s outer `##` sections in markdown viewers. The wrapping `## build.md template skeleton` heading makes the intent clear to a reader, but a future polish could wrap the inlined template in a fenced ```markdown``` block or HR-bounded region. F-002 in `review.md`.
2. **Empty `## Final diff` in this run's own `validate-context.md`.** Pre-existing: `validate_context._render_diff` uses symbolic `base_ref: "HEAD"`; `git diff HEAD...HEAD` is empty. Same root cause as TODO §3 item 2a (`base_ref_sha` plumbing into `validate_context`). Not introduced by this change; flagged in `review.md` F-003 so the human reviewer knows the curated context is degraded for this specific review.

## Untested / out of scope

- **Staged-layout integration test for `_write_build_context_artifacts`.** The two integration tests in `test_build_context.py` are flat-layout. The staged-vs-flat branch (cmd_start.py:138–145) is exercised by manual smoke (the throwaway run is a staged self-modifying run) and is structurally simple, but no automated test covers it. Recorded as a follow-up; one-line `assertTrue((run_dir / "stages/4_building/build-context.md").exists())` in `test_e2e.py::TestE2EHappyPath::test_happy_path` after the `/start` step would close this.
- **Missing-template behavior in the integration path.** Unit `test_missing_template_emits_fallback` covers the builder; the integration tests assume the template exists. Low-value coverage gap.
