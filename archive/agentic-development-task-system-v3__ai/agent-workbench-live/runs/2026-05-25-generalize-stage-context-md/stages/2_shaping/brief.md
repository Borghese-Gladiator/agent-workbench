# Brief

## Goal

Generalize the `*-context.md` pattern that today exists only for the `validate` stage to every LLM-bearing stage (`shape`, `plan`, `build`, `followups`). Each `--init` step writes a deterministic `<stage>-context.md` containing exactly what the next stage needs, filtered from prior artifacts. The agent reads that one curated file at stage entry instead of multiple raw artifacts. Two payoffs: a smaller master-session prefix (cache discipline), and a self-contained file that's the natural input for an Agent-tool subagent.

This run lands the highest-leverage piece first — `build-context.md` — and is scoped to that one builder plus its tests, wiring, and lifecycle-doc row. The other three builders (`plan-context.md`, `followups-context.md`, `shape-context.md`) are explicit non-goals for this run; they're follow-ups.

## User-facing behavior

The agent operating a run sees one new file appear in `runs/<id>/build-context.md` once `/start` succeeds. The `/build` slash-command instructions point the agent at that file first; the agent reads it and is expected to skip re-reading `brief.md` and `plan.md` unless something the curated file flags as "see anchor in brief.md#X" sends it deeper.

There is no new slash command. There is no new CLI subcommand. The existing `/start` transition does one additional deterministic write before the worktree is handed back to the user. The board, audit log, and metrics writers are unchanged — `build-context.md` is just another artifact in the run directory.

Failure mode: if `build-context.md` cannot be generated (e.g. malformed `brief.md` or `plan.md`), the `start` transition still succeeds and a sentinel file is written explaining what was missing. This mirrors the convenience-artifact swallow-and-continue pattern used today by `_write_validate_context_artifacts` (cmd_validate.py:82-84). The state machine never blocks on a context-file generation failure.

## Acceptance criteria

1. A function `build_context.build(meta, brief_text, plan_text) -> str` exists in `agent-workbench-live/lib/build_context.py`, mirroring the shape of `lib/validate_context.py`.
2. `cmd_start.py` calls that builder after the worktree is created and writes the result to `runs/<id>/build-context.md` inside the worktree's run directory (per the per-worktree-run-dir convention from the prior run).
3. The generated file contains, in order: Acceptance criteria + Non-goals (lifted from `brief.md`), Proposed changes + Files likely to change + Test plan + Definition of done (lifted from `plan.md`), Filtered Decisions & assumptions (from `plan.md#decisions--assumptions` if present), Worktree path + branch name + base_ref_sha (lifted from metadata), and the `build.md` template skeleton, and a rules-reminder block ("stay bounded by brief, record deviations in `build.md`").
4. Each section contains anchor links back to the full source artifact so an agent that needs more context knows exactly where to look (mirroring `validate-context.md`'s anchor pattern).
5. `agent-workbench-live/.claude/commands/handoff.md` and/or whichever command opens the building stage is updated so step 1 reads `build-context.md` first, with language mirroring `validate.md` step 2: "Do NOT re-read `brief.md` / `plan.md` if `build-context.md` already covers what you need."
6. A unit test file `tests/test_build_context.py` exists, mirroring `tests/test_validate_context.py`'s shape: feed synthetic `brief.md` + `plan.md` + `metadata.yaml`; assert the generated context has all the expected sections, the anchor links resolve, and the sentinel-fallback path triggers when prior artifacts are malformed.
7. `docs/lifecycle.md` gains a `build-context.md` row in the `building` stage's table, sibling to "Reads" and "Produces."
8. If `build-context.md` generation raises, the `start` transition still succeeds and a sentinel file is written (test coverage: monkey-patch builder to raise, assert transition still succeeds and sentinel file is on disk).
9. No regression in existing tests. The full pytest suite passes.

## Non-goals

- Building `plan-context.md`, `followups-context.md`, or `shape-context.md`. Those are TODO §1 items 2–4 and stay TODO items for follow-up runs.
- Changing the contents of `brief.md`, `plan.md`, `build.md`, or `validate-context.md` itself. The builders read existing artifacts; they don't alter them.
- Merging stages, renaming stages, or changing the lifecycle transition graph.
- Replacing template-driven artifact authoring with anything generative — the existing `templates/build.md` skeleton stays the source of truth for the template skeleton inlined into `build-context.md`.
- Building a separate `repo-map.md` artifact. (That's a `plan-context.md` concern, which this run defers.)
- Re-engineering the cache-discipline metrics. This run produces no new metrics. Whether the curated-context approach measurably reduces cache spend is a follow-up dogfood observation, not part of this run's acceptance.
- Per-stage tool-policy gating (TODO §8). Out of scope until §7 lands.

## Good examples

- A `runs/<id>/build-context.md` whose Acceptance-criteria section is verbatim from `brief.md#acceptance-criteria` followed by an anchor `[see full brief](../brief.md#acceptance-criteria)`. The agent never needs to read the brief unless it wants context beyond the acceptance bullets.
- A unit test that constructs a 3-line `brief.md` + 5-line `plan.md` + minimal `metadata.yaml` in a `tmp_path` fixture, calls `build_context.build(...)`, and asserts both the section presence (via headings) and the anchor presence (via regex on `(../brief.md#`).
- An `agent-workbench-live/.claude/commands/handoff.md` whose step 1 says, in the same paragraph: "Read `build-context.md`. Do NOT re-read `brief.md` or `plan.md` unless `build-context.md`'s anchors send you to a specific section."

## Bad examples

- A `build_context.build` that reads files itself by path. The builder should be pure: take `meta` dict + raw `brief_text` + raw `plan_text` strings + return a string. Reading from disk happens in `cmd_start.py`. Mirror `validate_context.build`'s purity.
- A `build-context.md` that omits the rules-reminder block. "Stay bounded by brief, record deviations in `build.md`" is the load-bearing one-liner that prevents scope creep; it must be in the curated file even though the master session has read it before.
- A `build-context.md` that's a full copy-paste of `brief.md` + `plan.md`. The whole point is filtering. If the file is the same size as the sum of its inputs, the cache-discipline payoff disappears.
- A `cmd_start.py` change that fails the start transition if `build-context.md` generation raises. The convenience-artifact-must-not-break-the-transition contract (already established for validate-context) applies.
- Edits to `validate_context.py` itself. Reuse its shape via copying / mirroring, not via shared helpers. The two builders may diverge later (different sources, different filters) and a shared base class would couple them prematurely.

## Constraints

- The builder lives at `agent-workbench-live/lib/build_context.py` and follows the structure of `lib/validate_context.py`.
- The write site is `cmd_start.py` (per the design decision in the raw idea: "`start` is cleaner because the file is ready before the LLM session begins").
- The output path is `runs/<id>/build-context.md` inside the worktree's run dir (per the per-worktree-run-dir convention from the prior `each-worktree-owns-its-own-run-dir` run).
- Pure-Python, no new third-party dependencies.
- Existing test infrastructure: `tests/test_validate_context.py` is the structural template. Whatever helpers / fixtures it uses, `tests/test_build_context.py` should match.
- The `start` transition currently runs in the master CWD (the source repo); the new write must target the worktree-side run dir, not the master one. The metadata's `target.worktree.path` is the source of truth.
- No changes to `schemas/run-metadata.yaml`, `schemas/transitions.yaml`, or `schemas/events.jsonl`. This is a pure artifact-write addition.

## Assumptions

- `brief.md` and `plan.md` use the section headings shown in `templates/brief.md` and `templates/plan.md`. The builder's section-extraction logic relies on those headings being stable. If a brief lacks one of the expected sections (e.g. no Non-goals), the builder emits a `(none)` placeholder under that heading in `build-context.md` rather than crashing.
- `validate_context.build` is the structural template. Reading it during planning will confirm whether it takes the `meta` dict + raw artifact text, or if it does its own disk reads. (Acceptance criterion #1 above assumes pure; the planner should verify and adjust if needed.)
- The decision to write `build-context.md` at `/start` time rather than at first `/build` invocation is final for this run. The raw idea floated both options; brief commits to `/start` for cleanness.
- The existing `templates/build.md` skeleton stays inlined into `build-context.md` verbatim. If the template doesn't yet exist, a minimal skeleton is added to `templates/`; if it does, it's used unmodified.
- Lifecycle doc `docs/lifecycle.md` has a per-stage table with "Reads" / "Produces" rows; the new row sits alongside those. If the doc structure differs, the planner records a deviation.
- The handoff slash-command sequence (the one that opens the `building` stage) is `agent-workbench-live/.claude/commands/handoff.md`. If the building-stage entry point is a different file (e.g. there's no `build.md` slash command and the agent enters by reading handoff output), the planner identifies the actual entry point and wires it there.

## Suggested QA scenarios

1. **Happy path.** Run `agent-workbench shape <id> --init` → write brief → `shape <id>` → `plan <id> --init` → write plan → `plan <id>` → `start <id>`. Confirm `runs/<id>/build-context.md` exists inside the worktree's run dir, has all expected sections, and anchor links resolve to real artifact paths.
2. **Missing-section brief.** Use a brief that omits the Non-goals section. Confirm `build-context.md` contains a `Non-goals` heading with `(none)` under it, not a crash.
3. **Malformed plan.** Use a `plan.md` with unparseable structure (e.g. no headings at all). Confirm the sentinel-fallback file is written rather than a crash, and the `start` transition still succeeds.
4. **Builder raises.** Monkey-patch `build_context.build` to raise `RuntimeError`. Confirm `cmd_start` swallows, the transition succeeds, and a sentinel file noting the failure is on disk.
5. **Anchor correctness.** For a real run, open `build-context.md` and click each anchor. Each should resolve to a real section in `brief.md` or `plan.md`.
6. **Cache-discipline spot check (manual, not pass/fail).** After landing, run the next self-modifying run with `/build` reading `build-context.md` first. Compare the prefix-size growth during the building stage against a prior run that re-read `brief.md` + `plan.md` at builder entry. Recorded as observation in `docs/TODO.md` §1 acceptance, not enforced here.
