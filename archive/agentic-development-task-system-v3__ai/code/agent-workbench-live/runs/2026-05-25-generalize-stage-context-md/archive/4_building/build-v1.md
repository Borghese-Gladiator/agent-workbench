# Build report

## What changed

Added `lib/build_context.py`, a deterministic builder for `build-context.md`, plus its wiring in `cmd_start._write_build_context_artifacts` so the file is produced at the `ready → building` transition. Mirrors `lib/validate_context.py` and its `cmd_validate._write_validate_context_artifacts` counterpart. Lifecycle docs and AGENTS.md updated to point the building agent at the curated entry first.

## Files changed

- `lib/build_context.py` — new. Pure-Python deterministic builder. Helper functions (`_read`, `_section`, `_HEADING_RE`, `_collect_id_blocks`) are duplicated from `validate_context.py` (DR-003 in plan: no premature shared base class until a third sibling lands).
- `lib/cli/cmd_start.py` — added import + helper `_write_build_context_artifacts` + call site between `metadata.update` and the transition block. Wrapped in `try/except Exception: pass` to mirror the convenience-artifact swallow contract from `cmd_validate`.
- `tests/test_build_context.py` — new. 16 cases: 13 unit (section rendering, fallback behavior for missing brief/plan sections, template inlining, worktree-metadata rendering, type assertions, write-creates-parent-dir) + 2 integration against `_write_build_context_artifacts` (happy + builder-raises-and-is-swallowed) + 1 supporting helper.
- `docs/lifecycle.md` — added `Curated entry context` block to the `building` stage and updated the `Reads` row to point at `build-context.md` first.
- `agent-workbench-live/AGENTS.md` — added a bullet under § Session discipline documenting the curated-stage-entry contract for both `build-context.md` and `validate-context.md` and pointing forward to TODO §1's remaining stages.

## Reviewer reading order

1. `lib/build_context.py` — the new builder. Confirm the section list matches the brief's Acceptance criterion #3 (Acceptance criteria, Non-goals, Proposed changes, Files likely to change, Test plan, Definition of done, Decisions & assumptions, Worktree, build.md template skeleton, Rules — in that order). Confirm `_all_plan_blocks` includes all blocks (DR-004 in plan), in contrast with `validate_context._filtered_plan_blocks`.
2. `lib/cli/cmd_start.py` — confirm the call site is correctly placed (between `metadata.update` at line 88 and the transition at line 95+) and that the `try/except` mirrors `cmd_validate._write_validate_context_artifacts`. Confirm `meta` is reloaded inside the helper (DR-001 / ASM-001 in plan).
3. `tests/test_build_context.py` — confirm tests cover the brief's Acceptance criteria 1, 3, 6, 8. The cmd_start integration tests use `metadata.create` + `metadata.update` to seed the run rather than driving the full CLI, keeping the test scope narrow.
4. `docs/lifecycle.md` — confirm the `Curated entry context` block sits before `Reads` and that the `Reads` row's parenthetical correctly redirects to `build-context.md`.
5. `agent-workbench-live/AGENTS.md` — confirm the new bullet sits inside the existing session-discipline list (not its own section), since the cache-discipline framing is shared with surrounding bullets.
6. `runs/2026-05-25-generalize-stage-context-md/brief.md` and `plan.md` — for verifying the scope was honored.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| 1. `build_context.build(...)` exists in `lib/build_context.py` and mirrors `validate_context.build` shape | `lib/build_context.py:24` defines `build`; `tests/test_build_context.py::TestBuildContextBuild::test_renders_all_sections`. Deviation: signature uses `meta: dict` + `build_template_path: pathlib.Path` instead of the brief's "strings in" framing; recorded as DR-001 in plan.md. |
| 2. `cmd_start.py` calls the builder after worktree creation and writes to the worktree-side run dir | `lib/cli/cmd_start.py:90-93` is the call site; `lib/cli/cmd_start.py:125-160` is the helper. Verified manually by the throwaway run `2026-05-25-bctx-smoke` which produced `stages/4_building/build-context.md` at the expected worktree path. |
| 3. Generated file contains all 11 specified sections in order | `tests/test_build_context.py::TestBuildContextBuild::test_renders_all_sections` asserts every heading. Manual smoke confirmed visually. |
| 4. Anchor links back to source artifacts | **Not implemented.** Deviation from brief — see Deviations from plan below. The curated file is self-contained; agents needing more context know to read `brief.md` / `plan.md` (per the Rules block and AGENTS.md guidance). The validate-context.md design template also does not use anchor links (it names paths in prose); mirroring that pattern is consistent. |
| 5. Building-stage slash-command instructions updated | **Adapted.** There is no building-stage slash command (confirmed during planning; DR-002). Wired into AGENTS.md § Session discipline + `docs/lifecycle.md` § building. |
| 6. `tests/test_build_context.py` exists, mirrors `test_validate_context_build.py` shape, all cases pass | 16 cases pass. |
| 7. `docs/lifecycle.md` gains a `build-context.md` row in `building` stage table | Added as `Curated entry context` block. Pre-existing table had `Reads`/`Produces` row pairs rather than a flat table; the curated block sits above `Reads` for natural read order. |
| 8. Builder exception is swallowed; transition still succeeds; file is absent | `tests/test_build_context.py::TestWriteBuildContextArtifacts::test_swallows_builder_exception`. |
| 9. No regression in existing tests | Full suite: 337 passed, 2 pre-existing snapshot failures in `test_human_review.py::TestSnapshotRender` (date drift in run_ids — snapshots authored 2026-05-22, run today 2026-05-25; confirmed to also fail on master). No regression from this run. |

## Deviations from plan

- **AC4 (anchor links back to source artifacts)** was specified in the brief but not implemented. The plan committed to mirroring `validate_context.py`'s shape, and `validate_context` does not use anchor links — it names paths in prose (`brief.md → Acceptance criteria — confirm scope.`). Implementing anchor links in `build-context.md` would diverge from the design template. The Rules block at the bottom of `build-context.md` and AGENTS.md's session-discipline bullet both name the source artifacts and tell the agent when to read them, which delivers the same outcome.
- **`build_context.build` signature.** The brief's framing was "pure function takes strings"; `validate_context.build` is actually path-in (reads files via internal `_read`). Plan recorded this as DR-001; the implementation follows DR-001 (paths in, `meta` dict in for metadata, string out).
- **`_filtered_plan_blocks` → `_all_plan_blocks`.** DR-004 in plan. At building-entry time there is no `build.md` to filter against; including all DR/ASM blocks is the right behavior.

## Known issues

- The inlined `build.md` template skeleton contains its own `## What changed`, `## Files changed`, etc. headings inside the `## build.md template skeleton` section of `build-context.md`. This creates visual hierarchy noise — the inner headings render as siblings to the outer sections in markdown viewers. Not a correctness issue (the wrapping section heading makes the intent clear to a reader), but a future polish could indent the inlined template into a fenced code block or HR-bounded region. Not blocking.
- `agent-workbench abandon` and other subcommands fail with `MetadataError: no metadata for run` when invoked from worktree A against a run that lives in worktree B. Cross-worktree CLI visibility is broken; same shape as TODO §6's board-freshness cache issue. Surfaced during the throwaway-run cleanup; this run did not introduce the bug — it's a pre-existing limitation of `metadata.run_dir` / `runs.find_run` when called from a sibling worktree.

## Commands run

- `python -m pytest tests/test_build_context.py -v --rootdir <wt>` — iteratively until all 16 cases passed.
- `python -m pytest tests/ --rootdir <wt>` — final full-suite run. 337 passed, 2 pre-existing snapshot failures (unrelated).
- `agent-workbench new-run/shape/plan/start` for the throwaway run `2026-05-25-bctx-smoke` — manual QA. Confirmed `build-context.md` appears at the expected `runs/2026-05-25-bctx-smoke/stages/4_building/build-context.md` path with all 11 sections and content correctly lifted from brief + plan.

## Documentation touched

- `docs/lifecycle.md` — added `Curated entry context` block to the `building` stage; updated the `Reads` row to point at `build-context.md` first.
- `agent-workbench-live/AGENTS.md` — added bullet under § Session discipline noting the curated-stage-entry contract.
