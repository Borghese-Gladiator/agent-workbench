# Review

## Decision

approve

## Did the implementation satisfy the brief?

Yes for 8 of the 10 acceptance criteria; #7 (CLAUDE.md/AGENTS.md 30% weight shrink) and #9 (E2E cache_read 40% drop) are flagged as Known issues in build.md and call out concrete follow-up.

What landed cleanly against the brief:

- Three independent bucket sub-sections in `agent-workbench metrics <id>` output. The renderer in `lib/cli/cmd_metrics.py` drops the "cache_read not bucketed" disclaimer and replaces it with `input buckets:`, `cache_read buckets:`, `cache_creation buckets:` — each rendered with the same sort-by-size pattern. AC #1.
- `metrics.jsonl` schema_version bumps to 2 with `cache_read_attribution` + `cache_creation_attribution` keys per turn (additive). Reader tolerates v1 rows. AC #10.
- Correlator fix in `lib/metrics/transcript.py`: `current_command` hoisted to function-scope (persists across multi-file transcripts) and a workbench-fallback path for cwd mismatches. AC #2.
- `validate --init` writes `stages/5_validating/validate-context.md` + `blast-radius.txt` deterministically — pure Python, no LLM call. AC #3.
- `.claude/commands/validate.md` Step 2-3 rewritten to read `validate-context.md`; subagent-first guidance added. AC #4.
- `agent-workbench-live/AGENTS.md` § "Session discipline" with four rules + `## Why` paragraph anchored on the pass-1 measurement. AC #5.
- `validate --init` prints a copy-pasteable fresh-session handoff block when `largest_session_turns > threshold`, configurable via `session_staleness_threshold_turns`. AC #6.
- Subagent discipline expanded with the >3-files Explore rule. AC #8.

## Did it accidentally expand scope?

The auto-`Scope creep check` step the CLI runs at `validate` time will populate this section if it found anything (depth-1 only). Manually: the brief listed 18 file paths; the diff touched 22 files (4 untracked test/template files plus `.gitignore` for the v3 lib unignore). The 4 extra files break down as:

- `tests/test_metrics_cache_buckets.py`, `tests/test_validate_context_build.py`, `tests/test_validate_init_handoff_block.py` — all listed in the brief's "Files likely to change".
- `lib/validate_context.py` — listed in the brief.
- `templates/validate-context.md` — listed in the brief.
- `.gitignore` — NOT listed in the brief. Honest scope expansion: the worktree was created from `e60742f` which lacked the v3 lib unignore that master added later (commit `6a29192`). Without this edit, `lib/validate_context.py` would be silently ignored by git. Strictly necessary; documented in build.md "Files changed".

Nothing else slipped in.

## Are there fragile assumptions?

- **ASM-002** (pass-1 dogfood transcript on disk) — used by C2's regression-test path conceptually, but the test file actually only synthesizes transcripts; the dogfood re-run is documented as a manual QA step in `qa/report.md`. Honest: the C2 acceptance criterion isn't fully closed in this PR.
- **ASM-004** (4-chars/token heuristic). Same approach as pass-1. C1's proportional-attribution test is intentionally loose (0.5–2% per bucket) to absorb integer-rounding error in `_scale_to_total`.
- **ASM-007** (CLAUDE.md edit in scope). Reconsidered in implementation — DR-007 deliberately *not* applied; the operator's global config wasn't touched. See build.md "Known issues".
- **ASM-010** (E2E `happy/` fixture is workload-comparable). On reflection, it's not. The `happy/` fixture is a few-turn smoke run; the pass-1 dogfood was 621 turns. Comparing `cache_read` totals between them measures fixture size, not pass-2's lever. Build.md "Known issues" flags this as a deferred follow-up.

## Are there missing tests?

- **C2's dogfood-transcript regression test** is a synthetic substitute (`test_correlator_inherits_command_across_files` + `test_workbench_fallback_attributes_known_command`) rather than loading the actual production transcript. The production-transcript test was the original spec; the synthetic version pins the *intent* of the fix (the two root-cause paths identified in DR-002) but doesn't prove the dogfood run will re-attribute correctly. Acceptable per ASM-002 ("test degrades; doesn't block") — the dogfood re-run is a manual QA step in `qa/report.md`.
- **No integration test for `cmd_validate --init`'s validate-context.md / blast-radius.txt generation.** The unit tests pin the generator (`test_validate_context_build.py`); the end-to-end "drive `validate --init` against a fixture run, assert both files appear in `stages/5_validating/`" path is not yet covered. Worth adding in a follow-up.

## Are there security / data loss / migration risks?

None of substance. The schema bump is additive — v1 readers continue to function. The new `_session_staleness_threshold` reads `cfg.raw` which is the parsed YAML; bad/missing values fall back to 100 (`test_falls_back_to_default_on_bad_value`). The `lib/validate_context.py` git invocations use `subprocess.run(check=False)` and return None on failure; the caller swallows exceptions (`_write_validate_context_artifacts` wraps the whole flow in `try: ... except Exception: pass`) so a malformed worktree never breaks the transition.

One thing to keep an eye on long-term: the workbench-fallback path in the correlator (A1) attributes any workbench-driven slash-command turn to the active stage regardless of cwd, when the cwd is under `workbench_root`. If two runs are driven from the same workbench root with overlapping time windows, the time-window filter is the only deduplicator. Pass-1 didn't have this fallback; if the operator runs simultaneous workbench sessions in the future, cross-attribution risk goes up. Flagged in build.md "Known issues".

## What should the human review first?

In this order:

1. **`lib/metrics/buckets.py`** — the heart of A2. Three independent attribution streams (`attribute_input` / `attribute_cache_read` / `attribute_cache_creation`), each scaled to the turn's authoritative token count. Verify `BucketAttribution` dataclass shape, the validate-span fold for tool results, and the residual-into-`other` invariant.
2. **`lib/metrics/transcript.py`** — the A1 fix. Check the function-scope hoist of `current_command` + `current_stage` (was per-file; now persists across files), the workbench-fallback branch (only fires for known slash commands), and the `prefix_*` accumulator wiring + truncation cap.
3. **`lib/validate_context.py`** — pure-Python deterministic builder. Read for accuracy: the `_section()` extractor, the DR/ASM filter against `build.md` references, the 500-line diff cap, the blast-radius truncation.
4. **`lib/cli/cmd_validate.py`** — confirm the `--init` flow order: stage templates → write context artifacts → record metrics → print handoff → emit transition. The metrics-refresh moved earlier in the flow (was after the transition; now before so the handoff block has data).
5. **`agent-workbench-live/AGENTS.md`** — the new `## Session discipline` section is normative. Confirm the four imperatives are unambiguous and the `## Why` actually grounds in pass-1's 121.8M cache_read measurement.
6. **`tests/test_metrics_cache_buckets.py`** — 11 unit tests for the cache attribution math. Verify the proportional test's threshold is appropriate (0.5–2% per bucket).
7. **`tests/test_validate_init_handoff_block.py`** — uses `unittest.mock` to test the handoff block. Confirm the path-mocking covers the realistic call shape.

## Blast radius

Pass-2 (B4): the `blast-radius.txt` file is computed at `validate --init` from `git diff` + `git grep`. On this run, `cmd_validate` ran under master's code (pre-pass-2), so `blast-radius.txt` did not generate — once this branch lands, future runs will get it automatically. For this branch's adversarial review:

Manual blast radius (depth 1-2):

depth 1 (changed files):
  agent-workbench-live/lib/metrics/transcript.py
  agent-workbench-live/lib/metrics/buckets.py
  agent-workbench-live/lib/metrics/summary.py
  agent-workbench-live/lib/metrics/writer.py
  agent-workbench-live/lib/cli/cmd_metrics.py
  agent-workbench-live/lib/cli/cmd_validate.py
  agent-workbench-live/lib/validate_context.py            (new)
  agent-workbench-live/lib/board/source.py
  agent-workbench-live/lib/board/app.py

depth 2 (callers of changed symbols):
  buckets.attribute_all       -> writer.record_run_metrics
  buckets.attribute           -> writer.record_run_metrics (back-compat shim)
  transcript.correlate        -> writer.record_run_metrics
  transcript.CorrelatedTurn   -> writer, buckets, tests
  summary.RunMetricsSummary   -> cmd_metrics._render_summary_plain, board.source._quick_metrics_from_jsonl, rollup
  validate_context.build      -> cmd_validate._write_validate_context_artifacts
  validate_context.build_blast_radius -> cmd_validate._write_validate_context_artifacts

depth 3 (one hop out):
  writer.record_run_metrics   -> cmd_validate (twice; pre-init and post-init), cmd_followups, cmd_complete, cmd_abandon
  cmd_metrics                 -> bin/agent-workbench dispatch
  rollup                      -> cmd_metrics --all

Nothing in depth 2/3 lives outside the brief's expected scope.

## Findings

(no blocking findings)

### F-001
- **Severity**: minor
- **Where**: `lib/metrics/buckets.py`, `_scale_to_total()`
- **Issue**: When a heuristic estimate exceeds the actual `total` (overlapping regex matches), the function force-sums by adjusting the largest bucket. That bias inflates the largest single bucket — fine for visibility, but a notional user comparing two bucket totals across runs would see the largest one over-amplified. Documented at lines 144-152.
- **Suggested fix**: None for now. The behavior is intentional (mirrors v1) and the residual-into-`other` invariant remains. A future pass could distribute the rounding delta proportionally instead of dumping into the largest bucket.

### F-002
- **Severity**: minor
- **Where**: `lib/cli/cmd_validate.py`, `_write_validate_context_artifacts()`
- **Issue**: The helper wraps the whole flow in `try: ... except Exception: pass`. That's deliberate — convenience artifacts shouldn't break the transition — but it also means a bug in the generator silently produces no file. A test for "generator raises → no file written, but transition still succeeds" is missing.
- **Suggested fix**: Defer to follow-up. The behavior is correct; the missing test is a coverage gap, not a bug.
