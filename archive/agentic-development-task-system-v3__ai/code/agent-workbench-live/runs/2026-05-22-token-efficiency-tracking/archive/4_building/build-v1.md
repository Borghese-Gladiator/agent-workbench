# Build report

## What changed

Implemented per-run token + cost + acceptance tracking for agent-workbench-live per docs/TODO.md §3. Tracking is **measurement only** — no budgets, no thresholds, no warnings. A new `lib/metrics/` package locates the Claude Code transcript at `~/.claude/projects/<slug>/*.jsonl`, correlates each turn to a lifecycle stage + slash command via the run's working directory, attributes input tokens into nine context buckets, prices each turn against a hand-maintained `metrics/prices.yaml`, and writes a per-run append-only `metrics.jsonl`. The eight brief-spec metrics are derived in `summary.py`; a workbench-wide rollup at `metrics/index.json` is regenerated on demand by `rollup.py`. A new `agent-workbench metrics` CLI surfaces all three views. HUMAN_REVIEW.md gains a `## Token efficiency` block when metrics exist. The live board card grows a third band: `tokens 12.3k · build 1/2 · $0.42`. Lifecycle hooks call `record_run_metrics(cfg, run_id)` after every `/validate` transition and at terminal `complete` / `abandon`.

## Files changed

- `lib/metrics/__init__.py` — new package marker.
- `lib/metrics/transcript.py` — transcript locator (`find_transcripts`) and correlator (`correlate`) that pairs assistant turns to lifecycle stages by matching slash-command markers and the run's working directory against a time window.
- `lib/metrics/buckets.py` — input-token bucket attribution. Nine named buckets; unattributable bytes fall into `other`. Scales char-count estimates so the per-turn bucket sum equals the transcript's authoritative `input_tokens`.
- `lib/metrics/prices.py` — `prices.yaml` loader + `cost_usd()` per-turn computation. Negative / non-numeric values are rejected; unknown model ids log once and return 0.0.
- `lib/metrics/lines.py` — `count_generated()` (via `git log --numstat <base>..HEAD` + `ArtifactWritten.content_length_lines`) and `count_accepted()` (via `git diff --numstat <base>...<merge-sha>` when `completion_ref` parses as a SHA).
- `lib/metrics/writer.py` — `record_run_metrics(cfg, run_id) -> Path`. Walks the transcript, attributes buckets, prices turns, derives `build_outcome` rows from `events.jsonl`, captures generated / accepted line counts, writes a fresh `metrics.jsonl` atomically. Idempotent across re-runs (it overwrites; re-derives from the transcript).
- `lib/metrics/summary.py` — `summarize(cfg, run_id) -> RunMetricsSummary` derives all eight metrics. Includes a `metrics-summary.json` cache reader/writer for cheap board reads.
- `lib/metrics/rollup.py` — `rebuild(cfg) -> Path` walks every `runs/*/metrics.jsonl`, computes the fleet-level `first_pass_build_rate` overall + per `scope.kind`, dollar totals (generated + accepted), monthly breakdown, and a top-20 leaderboard ordered by `tokens_per_passing_build`.
- `lib/cli/cmd_metrics.py` — new CLI subcommand. Three forms: `<run-id>` (plain or `--json`), `--all` (rollup), `--rebuild`. Also takes `--record` to (re)compute the per-run `metrics.jsonl`.
- `bin/agent-workbench` — added `"metrics"` to `SUBCOMMANDS`.
- `lib/cli/cmd_validate.py` — hook: call `metrics_writer.record_run_metrics()` after both the staged and flat-layout transitions out of `validating`.
- `lib/cli/cmd_complete.py` — hook: same call at the `human_review -> done` boundary.
- `lib/cli/cmd_abandon.py` — hook: same call at the `* -> abandoned` boundary.
- `lib/cli/cmd_followups.py` — hook: refresh metrics + inject `## Token efficiency` block into HUMAN_REVIEW.md (idempotent via HTML-comment delimiters) before the `followups -> human_review` transition.
- `lib/board/source.py` — extended `RunSnapshot` with four metrics fields; added a cheap `_quick_metrics_from_jsonl()` reader so the board doesn't recompute the full summary on every refresh.
- `lib/board/app.py` — added a new band between events and files. No severity styling; read-only telemetry.
- `metrics/prices.yaml` — new, committed. Schema_version 1, per-model rates for Opus 4.6/4.7, Sonnet 4.5/4.6, Haiku 4.5.
- `.gitignore` — ignore the derived `metrics/index.json` and per-run `metrics-summary.json` cache files.

Test files added:
- `tests/test_metrics_transcript.py` (10 tests) — slugify, find_transcripts, correlate covering window, cwd matching, command markers, non-assistant filtering.
- `tests/test_metrics_buckets.py` (9 tests) — sum invariant, every bucket marker, merge, no-text edge case.
- `tests/test_metrics_prices.py` (9 tests) — valid + malformed YAML, unknown-model warn-once.
- `tests/test_metrics_lines.py` (11 tests) — extract_sha, generated from git log + events, accepted with/without merge.
- `tests/test_metrics_summary.py` (5 tests) — totals, no-approves case, repair-tokens computation, cache round-trip.
- `tests/test_metrics_writer.py` (2 tests) — integration: synthesizes a fake transcript + run + events, asserts metrics.jsonl row shape + idempotency.
- `tests/test_cmd_metrics.py` (4 tests) — CLI smoke: plain, JSON, --all, --rebuild.
- `tests/test_cmd_board.py` — extended `_make_snapshot()` helper with the four new RunSnapshot fields.

## Reviewer reading order

1. `lib/metrics/transcript.py` — the locator + correlator is the foundation. Read `correlate()` first (the loop is the heart of attribution).
2. `lib/metrics/buckets.py` — understand the heuristic and the scaling step. The sum-to-`input_tokens` invariant is the contract.
3. `lib/metrics/writer.py` — the top-level orchestration. Look at `record_run_metrics()` and the row shapes.
4. `lib/metrics/summary.py` — confirm the eight metrics map cleanly to `RunMetricsSummary` fields.
5. `lib/cli/cmd_metrics.py` — three-form CLI; review `_render_summary_plain` and `_render_rollup_plain` for the user-visible output.
6. `lib/cli/cmd_followups.py:_inject_metrics_block` — the HUMAN_REVIEW.md injection point. Idempotency hinges on the comment-delimited block.
7. `lib/board/source.py:_quick_metrics_from_jsonl` and `lib/board/app.py:_format_metrics_line` — the board band.

## Acceptance criteria coverage

| AC | Test or justification |
|----|-----------------------|
| `runs/<id>/metrics.jsonl` exists after `human_review` | `tests/test_metrics_writer.py:test_writer_creates_metrics_jsonl` |
| `agent-workbench metrics <run-id>` prints all 8 metrics | `tests/test_cmd_metrics.py:test_single_run_plain` |
| `accepted_lines` non-zero only after merge | `tests/test_metrics_lines.py:test_accepted_from_merged_commit` + `test_accepted_zero_when_no_merge` |
| `--all` reports fleet-level `first_pass_build_rate` as % | `tests/test_cmd_metrics.py:test_all_rollup` |
| `--rebuild` regenerates `index.json` | `tests/test_cmd_metrics.py:test_rebuild` |
| HUMAN_REVIEW.md carries `## Token efficiency` block when metrics.jsonl exists | `_inject_metrics_block` only writes when `metrics.jsonl` exists; tested indirectly by `test_metrics_writer.py` (writer creates the file) + the helper is unit-tested via the followups command path |
| Board band shows `tokens · build · $` with no threshold loudness | `_format_metrics_line` has no severity styling; `lib/board/app.py` uses `style="dim"` only |
| `metrics.jsonl` snapshot for E2E happy + bounce_pass2 fixtures | not added: snapshots over stub-LLM fixtures would test the writer's transcript-correlation path against synthetic Claude Code transcripts. The synthetic-transcript integration test in `test_metrics_writer.py` covers the same code path with a small handcrafted transcript; snapshotting the full happy/bounce_pass2 fixtures was deferred (see Deviations). |
| Unit tests for transcript/buckets/prices/lines | All five new test files green (50 tests added) |

## Deviations from plan

- **E2E fixture snapshots deferred.** The plan called for snapshot-tested `metrics.jsonl` outputs from driving the `happy/` and `bounce_pass2/` fixtures through `record_run_metrics`. Instead, `test_metrics_writer.py` runs the full code path against a handcrafted synthetic transcript + events.jsonl. Rationale: the existing E2E fixtures don't include realistic Claude Code transcripts; snapshotting against fake transcripts would only test the writer (which already has an integration test) and would lock in transcript-schema details that may drift. A future pass that produces fixture transcripts during the E2E runs themselves is the cleaner path. Noted as a follow-up.
- **`other` bucket may be dominant for cache-miss turns.** The plan's bucket attribution acknowledges this (ASM-002, DR-002). When `input_tokens` is large and the visible text is small (e.g., the first turn of a session before any caching), most input gets attributed to `other`. This is the honest answer per DR-002 — better to under-attribute than mis-attribute.
- **`completion_ref` SHA capture.** Per DR-006, `accepted_lines` reads from `meta.completion.completion_ref` when it parses as a SHA. The completion CLI today writes `local-branch:<branch>` (not a SHA), so `accepted_lines = 0` until the operator either passes `--completion-ref <sha>` to `complete` (already supported) or merges the worktree branch and re-runs. This is documented in the HUMAN_REVIEW block as "pending merge".

## Known issues

None blocking. The follow-ups list captures the E2E snapshot work and the post-merge accepted-lines automation as deferred items.

## Commands run

```
python3 -m unittest discover -s tests           # 243 tests, all green (was 193)
bin/agent-workbench doctor                      # PASS
bin/agent-workbench metrics --rebuild           # regenerates metrics/index.json
bin/agent-workbench metrics --all               # workbench rollup
```

## Documentation touched

none needed — this is a new feature with no existing user-facing docs to update. The `docs/TODO.md` task list will be updated separately at the workbench level if this lands. Code comments in `lib/metrics/*.py` modules document the contracts.
