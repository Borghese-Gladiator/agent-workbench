# Implementation plan

## Current repo understanding

This is the Agent Workbench, a local-only run orchestrator for AI-driven dev tasks. The pass-1 token-efficiency work (run `2026-05-22-token-efficiency-tracking`, merge `271ab58`) shipped per-run metrics under `lib/metrics/` (8 modules) plus a `cmd_metrics` CLI, a board metrics band, and a HUMAN_REVIEW.md "Token efficiency" block. Two known pass-1 gaps:

1. **Bucketer only attributes `input_tokens`.** `lib/metrics/buckets.py:attribute()` returns a dict for input only; `cache_read_input_tokens` and `cache_creation_input_tokens` are tracked at the turn level but not bucketed. The renderer in `lib/cli/cmd_metrics.py:88` literally prints "cache_read not bucketed."
2. **Correlator silently broke.** `lib/metrics/transcript.py:correlate()` landed 100% of 621 turns on the dogfood run into `stage=other, command=""`. Two suspects: (a) `_cwd_matches()` resolving the live `cwd` of the operator's session against the worktree path the run records — when the operator drives a run from the parent repo dir (or the worktree path was renamed), nothing matches. (b) `current_command` resets to None when a fresh transcript file is opened, and the operator's session can span multiple JSONL files; turns in subsequent files have `current_command=None` until another `<command-name>` is seen.

The lifecycle has eight stages (`draft`, `shaping`, `planning`, `ready`, `building`, `validating`, `human_review`, `done`); the LLM-bearing stages have slash-command bodies under `.claude/commands/` and Python entry points under `lib/cli/cmd_*.py`. The validate path is the largest cache_read driver per the TODO §1 measurement: `validate.md` instructs reading `brief.md` + `plan.md` + the diff + running `git diff` / `git grep`, all in the build session's prefix.

## Relevant files

**Metrics core (pass-1 modules — patch, don't rewrite):**
- `lib/metrics/transcript.py` — `CorrelatedTurn`, `correlate()`, `_cwd_matches()`, `_extract_command()`, `_user_message_text()`, `_tool_result_bodies()`, `_assistant_usage()`. A1 fix lives here. A3 extends `CorrelatedTurn` with three prefix-accumulator fields.
- `lib/metrics/buckets.py` — `BUCKET_NAMES`, `attribute()`, `_classify_user_text()`, `merge()`. A2 lives here. New buckets added; `attribute()` return signature changes to a triple of dicts.
- `lib/metrics/summary.py` — `RunMetricsSummary` (frozen dataclass). A4 adds the cache bucket dicts. A6 adds `cache_misses`. A7 adds `billable_net_per_passing_build`. A8 adds `largest_session_turns`, `largest_session_id`.
- `lib/metrics/writer.py` — `record_run_metrics()`, `SCHEMA_VERSION`. A5 bumps schema_version to 2 and writes the new per-turn attribution keys.
- `lib/cli/cmd_metrics.py` — `_render_summary_plain()`. A4 + A6 + A7 + A8 surface here as new sub-sections.

**Board:**
- `lib/board/source.py` — `RunSnapshot.metrics_*`. A9 adds a `metrics_largest_session_turns` field.
- `lib/board/app.py` — `_format_metrics_line()`. A9 appends `· turns: N` when > 100.

**Validate path:**
- `lib/cli/cmd_validate.py` — `--init` mode at `agent-workbench-live/lib/cli/cmd_validate.py:180-274`. B2 + B4 + B5 hook into `_stage()` after templates are written but before the `building -> validating` transition.
- `templates/review.md` — B4 rewrites the "Blast radius" recipe to read `blast-radius.txt`.
- `.claude/commands/validate.md` — B3 rewrites Step 2-3 to read `validate-context.md`.

**Templates (new file):**
- `agent-workbench-live/templates/validate-context.md` — new template + deterministic generator.

**Discipline docs:**
- `agent-workbench-live/AGENTS.md` — B1 adds `## Session discipline`. B7 expands `## Subagent discipline`. B8 adds tool-output budget guidance.
- `~/.claude/CLAUDE.md` + repo-root `AGENTS.md` — B6 audit + shrink (out-of-tree edits in scope per ASM-7).

**Config:**
- `agent-workbench-live/agent-workbench.yaml` — new `session_staleness_threshold_turns: 100` default.

**Tests:**
- `agent-workbench-live/tests/test_metrics_buckets.py` — existing; expand for C1.
- `agent-workbench-live/tests/test_metrics_transcript.py` — existing; expand for C2.
- `agent-workbench-live/tests/test_validate_init_*.py` — existing snapshot tests; C3 extends.
- `agent-workbench-live/tests/test_cmd_metrics.py` — existing CLI smoke; C4 extends.

## Proposed changes

The implementation order matches the TODO: **Part A first** (visibility — fix correlator + bucket cache + surface), **Part B next** (mitigation), **Part C last** (tests + acceptance). Within Part A: A1 (correlator) is a prerequisite for everything since pass-1 didn't ship working stage attribution.

### Part A — visibility

**A1. Correlator fix.** Two changes to `transcript.py:correlate()`:
- **Inherit `current_command` across the transcript-files boundary.** Today the per-file loop reinitializes `current_command = None` and `current_stage = "other"`. Change: pull these up to the function level so they persist across multiple JSONL files. The buffered `pending_user_text` / `pending_tool_results` stay per-file (they reset on a slash-command change anyway).
- **Add a fallback path resolution.** When `_cwd_matches()` returns False but the slash command is one of the workbench's known set (`/shape`, `/plan`, `/build`, `/validate`, `/followups`, `/start`, `/complete`, `/bounce`, `/abandon`), treat the cwd mismatch as a soft warning and still attribute to the current stage. The hard match is only used to filter out *cross-run* contamination; a slash command driven against the workbench is always for the active run regardless of the operator's terminal cwd. Add a `_run_is_workbench()` heuristic: any of the candidate cwds (worktree, repo) lives under the workbench root → workbench-driven, accept the slash-command attribution.

**A2. Cache bucket attribution.** Refactor `buckets.py:attribute()` from returning a `dict[str, int]` to returning a `BucketAttribution` dataclass with three dicts:
```python
@dataclasses.dataclass(frozen=True)
class BucketAttribution:
    input_buckets: dict[str, int]
    cache_read_buckets: dict[str, int]
    cache_creation_buckets: dict[str, int]
```
Cache-bucket computation: walk the turn's accumulated session prefix (the new A3 fields), classify each text region into a bucket via the same regex set + new markers (`system_prompt` ← first-turn measurement of pre-user content; `tool_defs` ← `len(tool_defs) * 150`; `repo_files` ← tool_results matching `^\s*\d+\t`; `validation_context` ← tool_results inside a `/validate` span; `generated_drafts` ← assistant turns whose body contains `^## ` headers). Scale to the turn's `cache_read_input_tokens` / `cache_creation_input_tokens` independently; residual into `other`.

New `BUCKET_NAMES` tuple gains: `system_prompt`, `tool_defs`, `repo_files`, `validation_context`, `generated_drafts`. Existing input-bucket call sites get a thin adapter: `attribute_input_only(turn) -> dict[str, int]` returns `.input_buckets` for backwards-compat with the v1 row writer until A5 bumps the schema.

**A3. Carry session prefix through `correlate()`.** Extend `CorrelatedTurn`:
```python
prefix_user_messages: tuple[str, ...]      # monotonic across the session
prefix_assistant_messages: tuple[str, ...]  # monotonic across the session
prefix_tool_results: tuple[str, ...]        # monotonic across the session
```
Maintain three new accumulator lists at the *function* level (not per-file, not per-turn); append into them in the existing loop but never reset on turn-boundary. The new `attribute()` reads from these for cache-bucket classification. To keep memory bounded, cap each list at ~50k entries (truncate from the front); typical sessions are under 5k.

**A4. Surface new buckets.** `RunMetricsSummary` gains:
```python
cache_read_by_bucket: dict      # str -> int
cache_creation_by_bucket: dict  # str -> int
```
`_render_summary_plain()` (cmd_metrics.py:88-90) replaces "Context buckets (input tokens only; cache_read not bucketed):" with three sub-sections — `input buckets:`, `cache_read buckets:`, `cache_creation buckets:` — each rendered via the same sort-by-size pattern.

**A5. Per-turn `metrics.jsonl` row update.** Bump `SCHEMA_VERSION = 2` in `writer.py`. Turn rows gain two keys alongside `bucket_attribution`:
```json
"cache_read_attribution": {...},
"cache_creation_attribution": {...}
```
The summary reader's `summarize()` reads all three independently with `.get(key, {})`; v1 rows naturally have empty cache dicts.

**A6. Cache misses.** `RunMetricsSummary` gains `cache_misses: int`. Computed in `summarize()` as `sum(1 for r in turn_rows if r["usage"].get("cache_creation", 0) > 1000)`. Rendered as `cache misses: N` in the per-run summary, anchored to the existing "Build progress" block.

**A7. Re-baseline `tokens_per_passing_build`.** `RunMetricsSummary` gains `billable_net_per_passing_build: float | None`. Computed as `(total_input + total_output + total_cache_creation) / approves` when `approves > 0`. Render both `tokens / agent-approved validate:` lines side-by-side.

**A8. Session-turn-count metric.** `RunMetricsSummary` gains `largest_session_turns: int` and `largest_session_id: str`. Computed by counting turn_rows per `transcript_ref.session_id` and picking the max. Renders one line: `largest session: <8-char id...> (N turns)`.

**A9. Board: turns indicator.** `RunSnapshot.metrics_largest_session_turns: int | None`. `_quick_metrics_from_jsonl()` (board/source.py:657) returns a 5-tuple now. `_format_metrics_line()` (board/app.py:88) appends ` · turns N` when `largest_session_turns > 100`. No severity styling; dim.

### Part B — mitigation

**B1. `## Session discipline` in `agent-workbench-live/AGENTS.md`.** New section between `## Subagent discipline` and `## Context library`. Four imperative rules + a `## Why` paragraph anchored on the prefix-grows-monotonically mechanic and the pass-1 measurement (123.4M cache_read on 621 turns).

**B2. `validate-context.md` template + generator.** New file: `templates/validate-context.md` (skeleton with comments marking sections). New helper module: `lib/validate_context.py` exposing `def build(cfg, run_id, rd, meta) -> str`. Called from `cmd_validate._stage()` when `staged=True`, immediately after templates are written. Writes to `rd / "stages" / "5_validating" / "validate-context.md"` (staged layout) — same dir as the future blast-radius.txt. Sections in the output:
1. **Original task** — copies `## Goal` and `## User-facing behavior` from `brief.md`.
2. **Acceptance criteria** — `## Acceptance criteria` from `brief.md`.
3. **Plan decisions + assumptions (filtered)** — parses `plan.md` for `### DR-NNN` / `### ASM-NNN`. Cross-references against `build.md`: only includes IDs mentioned in `build.md`'s body. (If `build.md` doesn't reference any, includes all — fallback.)
4. **Final diff** — runs `git -C <worktree> diff --stat <base_ref>...HEAD` always; runs `git diff <base_ref>...HEAD` and includes full diff if line count ≤ 500, else includes `name-status` + per-file line counts.
5. **Files changed** — `git diff --name-status <base_ref>...HEAD`.
6. **Commands run** — parses `build.md` for `## Commands run`.
7. **Test results** — parses `qa/report.md` for `## Test results` (best-effort; emits "see qa/report.md" if absent).
8. **Known issues / risks** — parses `build.md` for `## Known issues`.
9. **Reviewer reading order** — parses `build.md` for `## Reviewer reading order` (or falls back to a default ordered list).

Pure Python, deterministic, no LLM call. Writes are idempotent: re-running `validate --init` rewrites the file.

**B3. Update `/validate` to read `validate-context.md`.** Rewrite `.claude/commands/validate.md` Step 2-3:
- Step 2 (was "Inspect the worktree, run git status / diff / log, write implementation-summary.md and diff-summary.md") → keep the worktree inspection but mark it as **already done by the builder**; the validator should read `runs/<id>/build.md` for the same info. Remove the `git status / git diff --stat / git log --oneline` block.
- Step 3 (was "Be adversarial. Read brief.md, plan.md, and the diff") → "Read `runs/<id>/stages/5_validating/validate-context.md`. That file is the curated entry point. Read brief/plan/build/qa directly only if validate-context.md points you at a specific section."
- Add a one-line: "Do NOT re-read files that are already summarized in validate-context.md."

**B4. Pre-compute blast radius.** New helper: `lib/blast_radius.py` exposing `def build(cfg, run_id, rd, meta) -> str`. Same call-site as B2 (`cmd_validate._stage`). Writes `rd / "stages" / "5_validating" / "blast-radius.txt"`. Computation:
- Depth-1: `git -C <worktree> diff --name-only <base_ref>...HEAD`.
- Depth-2: for each changed file, extract top-level Python `def`/`class` symbols modified in the diff (regex on the diff hunks); for each, `git -C <worktree> grep -n <symbol>`.
- Depth-3: for each depth-2 hit's file, repeat with the depth-2 file's top symbols.
- Cap total output at 200 lines. Reject pathological diffs (>500 changed files) with `(blast radius not computed: diff too large)`.

Update `templates/review.md` `## Blast radius` block: remove the embedded recipe (lines 26-54), replace with: "Read `runs/<id>/stages/5_validating/blast-radius.txt`. Summarize anything notable; the file already has the depth-1/2/3 tree."

**B5. Fresh-session handoff at `validate --init`.** Add to `cmd_validate.run()`, just before the `--init` `print(...)` at line 273:
- Load the run's existing `metrics-summary.json` (or call `summary_mod.summarize()` directly).
- Read the threshold from `cfg.config["session_staleness_threshold_turns"]` (default 100).
- If `largest_session_turns > threshold`, print the handoff block (six lines: header, three indented `key: value`, exit instructions, four-step copy-paste) **before** the existing `validating -> followups` line. Wrap in `=` rules for visibility.
- If the run is brand-new and `metrics.jsonl` doesn't exist yet, skip silently (no false positives).

**B6. CLAUDE.md / AGENTS.md audit + shrink.** Three files in scope:
- `~/.claude/CLAUDE.md` — operator's private global config. Identify duplicates with the repo-level files; mark stage-specific guidance for migration into slash-command bodies. Token-count baseline: `wc -c`.
- repo-root `AGENTS.md` — review for duplication with `agent-workbench-live/AGENTS.md` and CLAUDE.md. The "Slash commands" + "Project slash commands" content is already in `CLAUDE.md`; consolidate to one place.
- `agent-workbench-live/AGENTS.md` — already in scope for B1/B7/B8 additions; this is also where audit-driven trims happen.

Target: ≥ 30% combined char-count reduction. Record before/after in LOG.md as part of the run's completion entry.

**B7. Subagent-first read strategy.** Update `agent-workbench-live/AGENTS.md` `## Subagent discipline`. New imperative: "When a stage needs to read more than 3 files for *exploration* (not for editing), route through an `Explore` subagent." Add concrete examples to `.claude/commands/validate.md` (after Step 3) and — if it exists — `.claude/commands/build.md`. Note: no `build.md` slash-command file exists today; the `/build` workflow runs inside the building stage and is documented in `lifecycle.md`. Add the build-side guidance to `AGENTS.md` itself in the same section.

**B8. Tool-output budget guidance.** New subsection in `agent-workbench-live/AGENTS.md` under `## Subagent discipline` titled `### Tool-output budget`. Soft rules:
- Read outputs > 2k tokens → use `head -n 100`, `tail -n 100`, or `grep` to scope.
- `git log` → cap with `-n 20` unless the question demands full history.
- `git diff` → `--stat` first; full `git diff` only if needed.
- `find` → scope by `-name` or `-path`; avoid full-tree walks.

Not enforced; guidance only.

### Part C — tests + acceptance

**C1. Fixture-driven cache-bucket attribution test.** New file `tests/test_metrics_cache_buckets.py`. Synthetic transcript with a 100k-token prefix mixing all bucket types in known proportions (10% system_prompt, 15% tool_defs, 25% claude_md_and_agents_md, 20% repo_files, 15% user_messages, 10% slash_command_body, 5% other). Build a `CorrelatedTurn` whose `prefix_*` fields contain these. Run `attribute()` and assert each `cache_read_by_bucket[name]` is within ±2% of expected.

**C2. Correlator regression test.** New test in `tests/test_metrics_transcript.py`. Load the pass-1 dogfood run's transcript via `find_transcripts(slugify_project_path(<dogfood worktree path>))` (the slug is deterministic). If the transcript exists locally, run `correlate()` and assert > 50% of turns have non-`other` stage. Skip with `pytest.skip` (not xfail) when the transcript file isn't present — keeps CI green on fresh checkouts.

**C3. Snapshot test for `validate-context.md`.** Extend `tests/test_validate_init_*.py` (or add new file `tests/test_validate_context_build.py`). Use the existing `happy/` and `bounce_pass2/` E2E fixtures. Drive `validate --init`; snapshot `stages/5_validating/validate-context.md` byte-for-byte. Re-running the test asserts no drift. Same pattern for `blast-radius.txt`.

**C4. CLI smoke test.** Extend `tests/test_cmd_metrics.py`. After running the existing happy-path metric setup, assert stdout contains: `input buckets:`, `cache_read buckets:`, `cache_creation buckets:`, `cache misses:`, `billable_net_per_passing_build:`, `largest session:`.

**C5. E2E cache_read reduction.** Defer to post-implementation. Run the `happy/` E2E fixture in a fresh Claude Code session after Part B lands; record `total_cache_read` before and after in `qa/report.md`. Acceptance: ≥ 40% reduction from the pass-1 baseline (123.4M → ≤ 74M). Documented as a manual QA step in this run's QA report; not asserted by an automated test (the workflow involves driving a full E2E run, not a unit test).

## Files likely to change

- `agent-workbench-live/lib/metrics/transcript.py` (A1, A3)
- `agent-workbench-live/lib/metrics/buckets.py` (A2)
- `agent-workbench-live/lib/metrics/summary.py` (A4, A6, A7, A8)
- `agent-workbench-live/lib/metrics/writer.py` (A5)
- `agent-workbench-live/lib/cli/cmd_metrics.py` (A4, A6, A7, A8)
- `agent-workbench-live/lib/board/source.py` (A9)
- `agent-workbench-live/lib/board/app.py` (A9)
- `agent-workbench-live/lib/cli/cmd_validate.py` (B2, B4, B5)
- `agent-workbench-live/lib/validate_context.py` (B2, new)
- `agent-workbench-live/lib/blast_radius.py` (B4, new)
- `agent-workbench-live/templates/validate-context.md` (B2, new)
- `agent-workbench-live/templates/review.md` (B4)
- `agent-workbench-live/.claude/commands/validate.md` (B3)
- `agent-workbench-live/AGENTS.md` (B1, B7, B8)
- `agent-workbench-live/agent-workbench.yaml` (B5 config key)
- `~/.claude/CLAUDE.md` (B6, out-of-tree)
- `AGENTS.md` (repo root, B6)
- `agent-workbench-live/tests/test_metrics_buckets.py` (C1 extension)
- `agent-workbench-live/tests/test_metrics_cache_buckets.py` (C1, new)
- `agent-workbench-live/tests/test_metrics_transcript.py` (C2)
- `agent-workbench-live/tests/test_validate_context_build.py` (C3, new)
- `agent-workbench-live/tests/test_cmd_metrics.py` (C4)
- `agent-workbench-live/docs/LOG.md` (run completion entry incl. B6 measurements)
- `agent-workbench-live/docs/TODO.md` (mark §1 done)

## Data model changes

- `metrics.jsonl` `SCHEMA_VERSION` 1 → 2.
- Per-turn row gains: `cache_read_attribution: dict`, `cache_creation_attribution: dict`. Existing `bucket_attribution: dict` (= input only) stays.
- `RunMetricsSummary` gains: `cache_read_by_bucket: dict`, `cache_creation_by_bucket: dict`, `cache_misses: int`, `billable_net_per_passing_build: float | None`, `largest_session_turns: int`, `largest_session_id: str`. Existing fields unchanged.
- `RunSnapshot` gains: `metrics_largest_session_turns: int | None`. Existing fields unchanged.
- `BUCKET_NAMES` tuple grows by five: `system_prompt`, `tool_defs`, `repo_files`, `validation_context`, `generated_drafts`. Existing names unchanged.
- `agent-workbench.yaml` schema gains optional key `session_staleness_threshold_turns: int` (default 100). Schema-additive.

No `metadata.yaml` schema change. No `events.jsonl` schema change.

## UI changes

- `agent-workbench metrics <id>` plain output gains three bucket subsections plus three new fields. JSON output stays a flat dict (all new fields exposed).
- Board card metrics band: ` · turns N` suffix when > 100. Single optional bit; no layout change.
- `validate --init` stdout: prepends a fresh-session handoff block when `largest_session_turns > threshold`. Existing `<id>: building -> validating` line stays.
- `templates/review.md` `## Blast radius` block is shorter (instruction replaced with "read blast-radius.txt").

## Test plan

Unit tests (parametrized where natural):

- `test_metrics_transcript.py::test_correlator_inherits_command_across_files` — multi-file transcript with the slash command issued in file 1 and assistant turns continuing into file 2; assert turns in file 2 carry the command.
- `test_metrics_transcript.py::test_correlator_workbench_fallback_match` — cwd mismatch but candidate is under workbench root → still attributes.
- `test_metrics_transcript.py::test_prefix_accumulators_monotonic` — three turns; assert `prefix_user_messages` length grows monotonically.
- `test_metrics_cache_buckets.py::test_attribution_within_2_percent` — fixture-driven (C1).
- `test_metrics_cache_buckets.py::test_attribution_residual_other` — prefix with no recognizable markers → 100% in `other`.
- `test_metrics_summary.py::test_billable_net_excludes_cache_read` — synthetic rows; compute billable_net; assert it excludes cache_read.
- `test_metrics_summary.py::test_cache_misses_threshold` — synthetic rows: 3 with cache_creation > 1000, 2 below; assert `cache_misses == 3`.
- `test_metrics_summary.py::test_largest_session_picks_max` — three sessions of different sizes; assert largest_session_id matches.
- `test_metrics_writer.py::test_schema_version_2_rows` — write a turn row; assert row has all three attribution dicts and `schema_version == 2`.
- `test_metrics_writer.py::test_summary_reader_tolerates_v1_rows` — mix v1 and v2 rows; assert no error, v1 contributes 0 to cache buckets.
- `test_cmd_metrics.py::test_output_has_three_bucket_subsections` — C4.
- `test_board_app.py::test_metrics_line_appends_turns_when_high` — when `metrics_largest_session_turns = 250`, line ends with `· turns 250`.
- `test_validate_context_build.py::test_happy_fixture_snapshot` — C3.
- `test_validate_context_build.py::test_bounce_pass2_fixture_snapshot` — C3.
- `test_validate_context_build.py::test_plan_filter_by_build_md_references` — DR-001/ASM-001 only included if referenced in build.md.
- `test_blast_radius.py::test_depth_3_truncation` — diff with 5 layers of callers; output stops at depth 3.
- `test_blast_radius.py::test_large_diff_refuses` — diff with 600 changed files; output is the refuse message.
- `test_validate_init_handoff_block.py::test_prints_block_when_over_threshold` — metrics summary with `largest_session_turns=200` → handoff block in stdout.
- `test_validate_init_handoff_block.py::test_silent_when_under_threshold` — metrics summary with `largest_session_turns=50` → no block.
- `test_validate_init_handoff_block.py::test_silent_when_no_metrics_yet` — no metrics.jsonl → no block.

## QA plan

Manual QA against this run's own worktree:
1. Run `agent-workbench-live/tests` via pytest: assert all tests pass (`pytest -q`).
2. Run `agent-workbench metrics 2026-05-22-token-efficiency-tracking --record` and confirm: stdout has the three bucket subsections; `largest session:` line shows the original 621-turn count; `cache_read buckets` shows non-trivial attribution (residual `other` < 50% of total cache_read).
3. Run `agent-workbench show 2026-05-24-token-efficiency-pass-2` and inspect the metrics band.
4. Hand-roll a synthetic 200-turn run by inflating `largest_session_turns` via a test config override, then run `agent-workbench validate <id> --init` against a fixture run and confirm the handoff block prints.
5. Visually inspect the rendered `validate-context.md` on a fixture run; confirm sections match the spec, plan filter works, diff is bounded.
6. `wc -c` on `~/.claude/CLAUDE.md`, repo-root `AGENTS.md`, `agent-workbench-live/AGENTS.md` before and after B6; record in LOG.md.

E2E QA (deferred per C5): run a fresh `happy/` E2E in a clean Claude Code session post-implementation; record `total_cache_read`.

## Risks

- **R1. Cache-bucket attribution accuracy.** The 4-chars/token heuristic can drift on heavy code-heavy prefixes. Mitigation: residual-into-`other` is the safety valve; C1 test pins ±2% on a synthetic fixture; honest under-attribution is preferred per the design principles.
- **R2. Correlator A1 fix is wrong about root cause.** Two suspects identified; the actual bug may be a third path. Mitigation: C2 regression test against the production transcript pins the fix to a measured outcome.
- **R3. `validate-context.md` generator runs on unparseable artifacts.** A run whose `build.md` is malformed could crash the generator. Mitigation: every parser uses best-effort extraction with sentinel fallbacks; the file always writes, even if half-empty.
- **R4. Schema bump breaks downstream readers.** Mitigation: summary reader treats `bucket_attribution`, `cache_read_attribution`, `cache_creation_attribution` independently with `.get(key, {})`. Existing v1 rows pass through cleanly. Add a `test_summary_reader_tolerates_v1_rows` regression.
- **R5. B6 (CLAUDE.md / AGENTS.md audit) breaks behaviors.** Edits to the operator's private global config are sensitive. Mitigation: only remove content that's (a) duplicated elsewhere OR (b) historical reference; never remove imperatives. Diff is presented in the run's HUMAN_REVIEW.md for inspection.
- **R6. E2E cache_read 40% target is missed.** The reduction depends heavily on session discipline being followed. Mitigation: the structural changes (validate-context.md, blast-radius, subagent guidance) deliver some of the reduction even without behavioral change; the 40% target is the acceptance bar for the *workflow*, not for any single PR. If the dogfood E2E shows < 40%, mark as a known issue in `qa/report.md` and propose Part B variants.
- **R7. The correlator A1 fix changes attribution on pre-existing runs.** Re-running `agent-workbench metrics <id> --record` on old runs could shift their stage breakdown materially. This is intended — the existing breakdown is wrong — but the rollup tracks aggregates. Mitigation: A5 schema_version=2 lets the rollup reader detect mixed-version data and warn.

## Definition of done

- All 10 acceptance criteria from brief.md pass.
- All unit + integration tests pass locally.
- `agent-workbench metrics 2026-05-22-token-efficiency-tracking --record` produces a non-trivial `cache_read buckets` distribution (residual `other` < 50%).
- `agent-workbench validate <some-fixture-run> --init` produces both `validate-context.md` and `blast-radius.txt`.
- LOG.md gains a completion entry with: before/after weight measurements (B6), the cache_read measurement on the dogfood `metrics --record` re-run (acceptance #2), and the merge SHA.
- `docs/TODO.md` § 1 closed.

## Preflight

- **Tooling.** Python 3.10.9 (per `~/.claude/CLAUDE.md`). pytest available via `pytest`. `agent-workbench` CLI at `agent-workbench-live/bin/agent-workbench`.
- **Repo state.** Branch will be `agent/token-efficiency-pass-2`, created by `/start`. Base ref `HEAD` = current master.
- **Dependency hygiene.** No new third-party deps. All new modules are stdlib-only.
- **Pass-1 dogfood transcript on disk.** ASM-2 depends on this. Verification: `ls ~/.claude/projects/-Users-timothy-shee-GitHub-LOCAL-worktrees-202605-agent-workbench-v2-agentic-development-task-system-v2--ai/` should be non-empty. If not, C2 will skip (acceptable per the test design).
- **No live runs blocking the worktree dir.** Verified by `git worktree list` at `/start`.

## Decisions & assumptions

### DR-001
- **Decision**: Refactor `buckets.py:attribute()` to return a `BucketAttribution` dataclass with three sibling dicts (`input_buckets`, `cache_read_buckets`, `cache_creation_buckets`).
- **Rationale**: The cache buckets need different inputs (the session prefix, not the per-turn user text), so they can't be folded into a single dict-merge. A dataclass keeps the three concerns separate at the call site while staying compatible with `.to_dict()` for serialization.
- **Alternatives considered**: (a) Return one dict with prefixed keys like `cache_read.system_prompt`. (b) Three separate top-level functions.
- **Why not the alternatives**: Prefixed-key dicts lose IDE introspection and force every reader to know the prefix scheme. Three functions duplicate the prefix-walking work three times.

### DR-002
- **Decision**: A1's correlator fix uses two minimal patches — inherit `current_command` across the per-file loop boundary, plus a workbench-fallback path match — rather than rewriting `correlate()`.
- **Rationale**: Pass-1 explicitly listed "rewriting the correlator from scratch" as a non-goal. The function is load-bearing for pass-1 metrics; the two suspects identified in TODO §1 cover the observed 100%-`other` symptom.
- **Alternatives considered**: Greenfield rewrite using a state-machine library.
- **Why not the alternatives**: Out of scope per the brief's constraints. Risk of regression on existing tests is much higher than two surgical patches.

### DR-003
- **Decision**: `validate-context.md` is built by a pure-Python generator in `lib/validate_context.py`, no LLM call.
- **Rationale**: Design principle 2 (deterministic > model-curated). LLM-curated context is both more expensive (cache_read + new tokens) and harder to test (snapshot tests for non-deterministic outputs).
- **Alternatives considered**: Have `/validate` Step 2 author `validate-context.md` itself.
- **Why not the alternatives**: That's how today's `/validate` already loads the diff + brief + plan, which is the bleed pass-2 is trying to stop. Re-asking the LLM to write a curated file would *add* cache_read on top.

### DR-004
- **Decision**: Cache bucket attribution uses session-prefix accumulators (the new `prefix_*` fields on `CorrelatedTurn`), not per-turn buffers.
- **Rationale**: `cache_read_input_tokens` per turn corresponds to the *cumulative* prefix at that turn, not just the new text. Bucketing has to look at what's *in* the cache, which is everything before the turn.
- **Alternatives considered**: Bucket the per-turn `cache_creation_input_tokens` only (newly-cached text); ignore `cache_read` entirely.
- **Why not the alternatives**: cache_read is 98.7% of cost — ignoring it would re-create the pass-1 gap. cache_creation alone is < 1%.

### DR-005
- **Decision**: Fresh-session handoff block (B5) is **printed**, not enforced. The agent can ignore it and proceed.
- **Rationale**: Consistent with `## Session discipline` being convention, not a runtime block. Pass-2 explicitly disclaims hard enforcement (non-goal: "auto-restarting Claude Code"). The handoff block is the most visible nudge possible without breaking automation.
- **Alternatives considered**: `validate --init` exits non-zero when `largest_session_turns > threshold`.
- **Why not the alternatives**: Would break programmatic / scripted invocations and CI-driven E2E. The signal is the block; the choice is the human's.

### DR-006
- **Decision**: B4's blast-radius computation lives in a new module `lib/blast_radius.py`, separate from `lib/cli/cmd_validate.py`.
- **Rationale**: Same shape as the existing `lib/doc_claims.py` and `lib/scope_check.py` — small, testable, pure-function modules co-located with the CLI. Keeps `cmd_validate` thin.
- **Alternatives considered**: Add it as a nested function in `cmd_validate.run()`.
- **Why not the alternatives**: Harder to unit-test in isolation.

### DR-007
- **Decision**: B6 (CLAUDE.md / AGENTS.md audit) edits the operator's `~/.claude/CLAUDE.md` directly, with the diff presented in HUMAN_REVIEW.md for the human to inspect.
- **Rationale**: ASM-7 — the operator authored this work, can reason about edits to their own config. The 30% target needs the global CLAUDE.md to be in scope; the global file alone is a large fraction of the per-turn weight on long sessions.
- **Alternatives considered**: Touch only the repo-tracked files (`AGENTS.md`, `agent-workbench-live/AGENTS.md`); leave global CLAUDE.md alone.
- **Why not the alternatives**: Would miss most of the addressable weight. The global file's bytes are the worst kind of cache_read driver — every turn, every session.

### DR-008
- **Decision**: `session_staleness_threshold_turns` is a config key in `agent-workbench.yaml` (default 100), not hardcoded.
- **Rationale**: Different teams / operators may want different thresholds. Config keeps it tunable without code changes.
- **Alternatives considered**: Hardcoded constant in `cmd_validate.py`.
- **Why not the alternatives**: Requires a code change to tune; not great.

### DR-009
- **Decision**: Existing `bucket_attribution` field on turn rows stays as "input only"; new `cache_read_attribution` / `cache_creation_attribution` are siblings.
- **Rationale**: Keeps schema_version=1 readers fully functional. Three independent dicts also make the JSON output more legible.
- **Alternatives considered**: Rename `bucket_attribution` to `input_attribution` and add the cache variants.
- **Why not the alternatives**: Breaking rename of a public-ish field for cosmetic improvement; not worth the migration cost.

### DR-010
- **Decision**: A9 board indicator uses ` · turns N` appended to the existing dim metrics line; no new band.
- **Rationale**: Read-only nudge per the brief. A separate band would compete with the existing severity indicators for visual weight.
- **Alternatives considered**: New "session health" band with its own colored indicator.
- **Why not the alternatives**: Brief explicitly says "no loud-card behavior."

### ASM-001
- **Text**: Pass-1's `metrics.jsonl` format is what `lib/metrics/writer.py:177-199` writes today; v1 schema is what's on disk for every prior run.
- **Reason**: Direct read of writer.py confirms `SCHEMA_VERSION = 1`; the dogfood run's `metrics.jsonl` matches.
- **Impact**: low (verified)

### ASM-002
- **Text**: The pass-1 dogfood transcript file is still on disk under `~/.claude/projects/<slug>/` and can be located via `slugify_project_path`.
- **Reason**: C2 depends on this. If absent, the test skips gracefully.
- **Impact**: low (test degrades; doesn't block)

### ASM-003
- **Text**: `cache_read_input_tokens` and `cache_creation_input_tokens` in Claude Code's per-turn API records can be summed across turns to reach the totals seen in `metrics.jsonl`.
- **Reason**: The pass-1 dogfood totals (121.7M / 1.2M) match what the writer aggregates.
- **Impact**: low (verified)

### ASM-004
- **Text**: The 4-chars/token heuristic in `lib/metrics/buckets.py` is good enough for cache-bucket scaling.
- **Reason**: Per-bucket calibration is non-goal for pass-2. The honest-under-attribution principle says when it drifts, residual goes to `other`.
- **Impact**: medium — could shift bucket distributions noticeably. C1 test bounds the error at ±2% on a synthetic fixture.

### ASM-005
- **Text**: `validate --init`'s call site can synchronously call `metrics summarize` (which reads metrics.jsonl) to get `largest_session_turns` before printing the handoff block.
- **Reason**: `record_run_metrics` is called *after* the transition in the current code path (line 396); to read it before the print, we either move `record_run_metrics` earlier or call `summarize` against the existing on-disk file (from a prior `metrics --record`).
- **Impact**: medium. Decision: call `record_run_metrics` earlier in `--init` flow (after _stage(), before transition), so `summarize` has fresh data for the handoff block. Existing call site after the transition stays as a no-op safety net.

### ASM-006
- **Text**: `.claude/commands/validate.md`, `templates/review.md`, and `templates/validate-context.md` live in the repo (not in `~/.claude/commands/`) so a single PR edits them.
- **Reason**: `ls agent-workbench-live/.claude/commands/` confirms validate.md lives in-repo.
- **Impact**: low (verified)

### ASM-007
- **Text**: The operator's `~/.claude/CLAUDE.md` is in scope for editing in B6.
- **Reason**: The operator authored this work and can review the diff in HUMAN_REVIEW.md before accepting.
- **Impact**: medium — touches global operator config. The diff will be visible and surface for human approval before the run lands.

### ASM-008
- **Text**: The board's metrics band (`_format_metrics_line`) is the right surface for the `turns: N` indicator.
- **Reason**: Direct read of `board/app.py:88-104` shows the existing tokens/build/cost line; appending a fourth field is minimal change.
- **Impact**: low (verified)

### ASM-009
- **Text**: Subagent guidance in `AGENTS.md` refers to Claude Code's `Agent` tool with `subagent_type=Explore` specifically.
- **Reason**: No other runtime is in scope per the brief (non-goal: "supporting non-Claude-Code LLMs").
- **Impact**: low

### ASM-010
- **Text**: The `happy/` E2E fixture is workload-comparable to the pass-1 dogfood run for the C5 acceptance check.
- **Reason**: It's the closest available comparison artifact. If the fixture is dramatically smaller, we'll dogfood pass-2 itself and use that as the comparison.
- **Impact**: medium — could mean a smaller absolute reduction; relative % target is what matters.

### ASM-011
- **Text**: No `.claude/commands/build.md` slash-command file exists; the building stage runs without a wrapping slash command.
- **Reason**: `ls agent-workbench-live/.claude/commands/ | grep build` is empty.
- **Impact**: low — B7's "concrete examples in build.md" guidance moves to `agent-workbench-live/AGENTS.md` instead.

### ASM-012
- **Text**: `RunSnapshot` can grow a new field (`metrics_largest_session_turns`) without breaking serialization.
- **Reason**: It's a `@dataclasses.dataclass(frozen=True)` that's only consumed by the board renderer in-memory.
- **Impact**: low (verified)
