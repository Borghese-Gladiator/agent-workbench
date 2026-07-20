# Build report

## What changed

Closed TODO §5 by shipping the three remaining `<stage>-context.md` generators (`shape-context.md`, `plan-context.md`, `followups-context.md`) plus their `--init` write sites, slash-command body updates, lifecycle.md documentation, and unit tests. The contract now holds for every LLM-bearing stage (shape, plan, build, validate, followups): each `--init` writes a curated entry-context file the agent reads first, instead of re-reading the prior artifacts and template separately. Pattern mirrors the existing `build-context.md` (shipped 2026-05-25) and `validate-context.md` (pre-existing); helpers are duplicated across the five generator modules per the project's existing convention (see DR-003 in `plan.md`).

## Files changed

- `agent-workbench-live/lib/shape_context.py` (new, ~80 LOC) — renders `shape-context.md`. Lifts `raw-idea.md` verbatim, `answers.md` if present, the brief.md template skeleton, and the two shaping rules.
- `agent-workbench-live/lib/plan_context.py` (new, ~220 LOC) — renders `plan-context.md`. Lifts the full brief.md, a deterministic repo-map block (top-level dirs + detected languages + build/test commands from canonical manifests), the brief's "Files likely to change" section, worktree metadata, the plan.md template skeleton, and the planning rules. `_detect_repo_map()` is the only meaningful new logic — narrow manifest-file detection (no recursive scanning, no heuristics).
- `agent-workbench-live/lib/followups_context.py` (new, ~140 LOC) — renders `followups-context.md`. Lifts brief's Non-goals, plan's Risks, review's Decision + Findings, qa report's Known issues, build's Deviations from plan, the follow-ups.md schema, and the followups rules.
- `agent-workbench-live/lib/cli/cmd_shape.py` — added `_write_shape_context_artifacts(cfg, run_id, rd)` helper; called from `--init` after template staging. Imports updated to include `lifecycle` and `shape_context`.
- `agent-workbench-live/lib/cli/cmd_plan.py` — added `_write_plan_context_artifacts(cfg, run_id, rd, staged, meta)` helper; called from `--init` after template staging. Imports updated to include `plan_context`.
- `agent-workbench-live/lib/cli/cmd_followups.py` — added `_write_followups_context_artifacts(cfg, run_id, rd)` helper; called from `--init` after the `validating → followups` transition completes. Imports updated to include `followups_context`.
- `agent-workbench-live/.claude/commands/shape.md` — added "Step 2 — read the curated context" pointing at `stages/2_shaping/shape-context.md`; existing steps renumbered to 3 & 4. Step 1 now documents that `--init` writes the curated file.
- `agent-workbench-live/.claude/commands/plan.md` — same pattern: new Step 2 reads `stages/3_planning/plan-context.md`; existing steps renumbered to 3, 4, 5. Step 1 updated.
- `agent-workbench-live/.claude/commands/followups.md` — same pattern: Step 2 now reads `stages/6_followups/followups-context.md`. The pre-existing list of prior artifacts is replaced by a "reach for these only when the curated context is insufficient" framing, with `events.jsonl` and `archive/*` reads kept directly (they aren't lifted into the curated file).
- `agentic-development-task-system-v3__ai/docs/lifecycle.md` — added a "Curated entry context" sub-block under the shape, plan, followups stage sections, mirroring the building stage's existing sub-block. The Reads list in each was reframed to prefer the curated file first.
- `agent-workbench-live/tests/test_shape_context.py` (new, 13 tests) — mirrors `test_build_context.py`'s shape. Class `TestShapeContextBuild` covers renders-all-sections, raw-idea-inlined, answers-handling (present, None, file-missing), template-inlined, rules block, fallback strings, write-helper idempotency. Class `TestWriteShapeContextArtifacts` exercises the cmd-level helper end-to-end with a synthetic flat-layout run.
- `agent-workbench-live/tests/test_plan_context.py` (new, 23 tests) — mirrors the same shape. Heavier coverage on `_detect_repo_map()`: Python (pyproject), JavaScript (package.json), Rust (Cargo.toml), Go (go.mod), Makefile target detection (with "uninteresting" target filtering), top-level dir listing with skip-dirs, missing-worktree fallback, nonexistent-path fallback, no-manifests fallback. Plus integration tests.
- `agent-workbench-live/tests/test_followups_context.py` (new, 19 tests) — same shape. Covers all six lifted sections, alternate-heading fallback (`Findings & remediations`), all five missing-source fallbacks, rules-block content, write-helper. Integration tests synthesize a full staged run with prior-stage outputs in their stage dirs.
- `agentic-development-task-system-v3__ai/docs/TODO.md` — §5's three remaining sub-tasks marked `[x]` with "Shipped 2026-05-27 in run …" annotations.

## Reviewer reading order

1. `lib/build_context.py` — the design template all three new generators mirror. Read this first if you aren't already familiar with the pattern; everything else flows from it.
2. `lib/shape_context.py` — simplest of the three new generators. Confirms the pattern travels well to a stage with minimal prior context. Look for: are the duplicated helpers (`_read`, `_section` is intentionally omitted because shape doesn't need it) consistent with the family?
3. `lib/followups_context.py` — middle-complexity generator. Has more lifted sections than shape; reuses `_section()`. Look for: does the alternate-heading fallback (Findings vs Findings & remediations) feel principled or hacky? It mirrors how `validate_context.py` handles similar variations.
4. `lib/plan_context.py` — the most novel logic lives here in `_detect_repo_map()`. Look for: is the manifest-detection narrowness justified? The brief originally assumed build/test commands would come from `agent-workbench.yaml` policies; reality (per the Explore subagent) is that policies has no such block, so detection moved to target-repo manifests (DR-001 + ASM-001 in `plan.md`).
5. `lib/cli/cmd_followups.py` — non-obvious because the new helper is called AFTER `transitions.transition()` (not before). This is the same pattern `cmd_validate._write_validate_context_artifacts` uses for the same reason: the transition file-move whitelists specific files, so writing the curated file directly into the destination stage dir AFTER the transition is cleaner than relying on the file-move (this overrides the plan's DR-002, which assumed writing before; see "Deviations from plan").
6. `lib/cli/cmd_shape.py` and `lib/cli/cmd_plan.py` — simpler write sites; the helper resolves the stage dir via `lifecycle.stage_dir()` and writes directly.
7. `.claude/commands/{shape,plan,followups}.md` — confirm the new Step 2 wording mirrors `validate.md` step 2 in spirit.
8. `tests/test_plan_context.py` — the most novel test file (repo-map detection has 6 distinct cases). The other two are very close to `test_build_context.py`.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| AC1: New generator modules exist with public `build()` + `write()` | `tests/test_{shape,plan,followups}_context.py::Test*ContextBuild` — every test exercises `build()` and `test_write_creates_parent_dir` exercises `write()` |
| AC2: `cmd_shape.py --init` writes shape-context.md with try/except swallow | `tests/test_shape_context.py::TestWriteShapeContextArtifacts::test_writes_shape_context_md_into_stage_dir` + `test_swallows_builder_exception` |
| AC3: `cmd_plan.py --init` writes plan-context.md with try/except swallow | `tests/test_plan_context.py::TestWritePlanContextArtifacts::test_writes_plan_context_md_into_stage_dir` + `test_swallows_builder_exception` |
| AC4: `cmd_followups.py --init` writes followups-context.md with try/except swallow | `tests/test_followups_context.py::TestWriteFollowupsContextArtifacts::test_writes_followups_context_md_into_stage_dir` + `test_swallows_builder_exception` |
| AC5: shape-context.md content (raw-idea, answers, template, rules) | `test_shape_context.py::test_renders_all_sections_with_answers`, `test_raw_idea_inlined`, `test_answers_inlined_when_present`, `test_template_inlined`, `test_rules_block_load_bearing_lines` |
| AC6: plan-context.md content (brief, repo-map, files-likely-to-change, worktree, template, rules) | `test_plan_context.py::test_renders_all_sections`, plus dedicated tests per section (`test_brief_inlined`, `test_files_likely_to_change_lifted`, `test_worktree_block_renders`, `test_template_inlined`, `test_rules_block_load_bearing_lines`, and 6 repo-map detection tests) |
| AC7: followups-context.md content (non-goals, risks, decision, findings, known issues, deviations, schema, rules) | `test_followups_context.py::test_renders_all_sections` + dedicated tests per lifted section (`test_brief_non_goals_lifted`, `test_plan_risks_lifted`, `test_review_decision_and_findings_lifted`, `test_qa_known_issues_lifted`, `test_build_deviations_lifted`, `test_template_inlined`, `test_rules_block_load_bearing_lines`) |
| AC8: Visual consistency with build-context.md (Rules block + sectioned structure) | Code reading; each new module's `_rules_block()` follows the same multi-line-string-of-bullets format as `build_context._rules_block()`, and the section order in `build()` mirrors the existing siblings. |
| AC9: Slash-command bodies updated with mirroring language | Code reading — see `.claude/commands/{shape,plan,followups}.md` Step 2 in each. Same "Do NOT re-read X if `<stage>-context.md` already covers what you need" wording with stage-appropriate substitutions. |
| AC10: lifecycle.md adds curated-entry-context sub-blocks | Code reading — `docs/lifecycle.md` § shaping, § planning, § followups each gained a "Curated entry context" sub-block (rather than a row) mirroring building's existing sub-block. |
| AC11: Unit tests mirror `tests/test_build_context.py`'s shape | Code reading + run results — all three new test files use the same `TempDir + setUp/tearDown` pattern, the same `assertIn(section, body)` assertion style, and a sibling integration class. 55 new tests total. |
| AC12: Existing E2E + self-modifying suites still pass | Test run: `tests.test_e2e`, `tests.test_self_modifying`, `tests.test_lifecycle`, `tests.test_build_context`, `tests.test_validate_context_build` — all pass. See "Commands run" below. |
| AC13: TODO §5 sub-tasks marked complete | `docs/TODO.md` §5 task list — all four checkboxes flipped to `[x]` with "Shipped 2026-05-27" annotations. |

## Deviations from plan

1. **DR-002 superseded.** The plan said `followups-context.md` should be written BEFORE the `validating → followups` transition so the transition file-move logic would relocate it. Investigation of `lib/lifecycle.py:_STAGE_OUTPUTS` (during build) revealed the file-move logic is a WHITELIST — it only moves named files per stage (e.g. `follow-ups.md` for the followups transition). Writing `followups-context.md` at the run root pre-transition would leave it stranded there. The correct pattern (already used by `cmd_validate._write_validate_context_artifacts`) is to write the curated file directly into the destination stage dir AFTER the transition completes, using `lifecycle.stage_dir(cfg, run_id, "followups")`. This is what shipped. ASM-004 (which sat downstream of DR-002) is also superseded; the file is never at the run root.
2. **ASM-001 confirmed.** `agent-workbench.yaml`'s policies block does not carry build/test commands. `_detect_repo_map()` sources commands from target-repo manifests (`pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`, `Makefile`) instead. This is what the plan recorded; the build matched.
3. **Order of work followed DR-006.** Shape → followups → plan. The repo-map logic in plan-context.md was the most novel, and shipping it last (with the pattern already firmly established by the two simpler generators) made writing the 6 repo-map detection tests straightforward.

## Known issues

1. **Seven pre-existing test failures.** The full suite reports 7 failures (`tests.test_backfill_base_ref_sha::*` × 5, `tests.test_human_review.TestSnapshotRender::test_happy_snapshot`, `test_bounce_pass2_snapshot`). All seven reproduce on master (the worktree's parent) without my changes. The backfill failures are a PYTHONPATH issue with `tools/backfill_base_ref_sha.py`; the snapshot failures are date-sensitive (the snapshots expect `2026-05-22-…` run IDs but today's date is `2026-05-27`). Out of scope for this run; flagging for a separate fix.
2. **Helper duplication is now 5-way.** `_read()`, `_HEADING_RE`, `_section()`, and `_collect_id_blocks()` (where used) are now duplicated across `lib/build_context.py`, `lib/validate_context.py`, `lib/shape_context.py`, `lib/plan_context.py`, `lib/followups_context.py`. This is consistent with the existing convention (`build_context.py`'s docstring explicitly endorses the duplication), but the case for extraction has grown stronger with five generators. Not in scope for this run; candidate follow-up.
3. **`shape-context.md`'s leverage is modest.** As noted in the plan (ASM-002), shape has the least prior context to filter. The main win is inlining the brief.md template so the shaping agent doesn't context-switch into `templates/`. Whether this win materializes depends on the agent honoring the slash-command body's "do not re-read" instruction. Re-evaluate after a few real runs.

## Commands run

- `python -m unittest tests.test_shape_context -v` → 13/13 pass.
- `python -m unittest tests.test_plan_context -v` → 23/23 pass (after fixing one test-helper bug where the `_build()` helper used `None` as a sentinel; switched to a distinct sentinel object).
- `python -m unittest tests.test_followups_context -v` → 19/19 pass.
- `python -m unittest tests.test_shape_context tests.test_plan_context tests.test_followups_context tests.test_build_context tests.test_validate_context_build tests.test_lifecycle tests.test_self_modifying -v` → 105/105 pass (focused set: the new tests plus the existing tests for adjacent modules).
- `python -m unittest discover tests -v` → 443/450 pass; 7 failures are all pre-existing on master (see "Known issues").

## Documentation touched

- `agent-workbench-live/.claude/commands/shape.md` — added a new Step 2 (read curated context) and renumbered remaining steps.
- `agent-workbench-live/.claude/commands/plan.md` — same.
- `agent-workbench-live/.claude/commands/followups.md` — restructured Step 2 to put the curated read first; pre-existing artifact-by-artifact list deferred to a "reach for these only when needed" note.
- `agentic-development-task-system-v3__ai/docs/lifecycle.md` — added a "Curated entry context" sub-block under the shape, plan, followups stage sections, plus reworded each stage's "Reads" list to prefer the curated file.
- `agentic-development-task-system-v3__ai/docs/TODO.md` — §5 task list updated to mark the three remaining sub-tasks as shipped, plus shipped-date annotations.
