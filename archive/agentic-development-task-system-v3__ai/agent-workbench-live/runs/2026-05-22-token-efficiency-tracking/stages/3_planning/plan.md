# Implementation plan

## Current repo understanding

`agent-workbench-live/` is a stdlib-only Python orchestrator for run lifecycle. Source-of-truth files per run:
- `runs/<id>/metadata.yaml` — state, repo+worktree pointers, validation flags.
- `runs/<id>/events.jsonl` — append-only event log. Written **only** through `lib/events.py`.
- `runs/<id>/stages/<n>_<stage>/...` for staged runs; flat files at run root for legacy runs.

Key modules already in place:
- CLI dispatcher: `bin/agent-workbench` (lines 25–64) routes via dynamic import `lib.cli.cmd_<name>`. Each `cmd_*.py` exports `HELP`, `register(p)`, `run(args) -> int`.
- Transitions: `lib/transitions.py` `transition()` writes status (line 146), emits `TransitionApplied` (line 157), then any secondary events declared in the schema rule (line 168). Staged-layout file-promotion happens between (lines 151–155).
- Events: `lib/events.py` `append(cfg, run_id, type, payload, actor, from_state, to_state)` is the only writer of `events.jsonl`. Schema in `schemas/events.jsonl`.
- HUMAN_REVIEW: staged from `templates/HUMAN_REVIEW.md`; lives at `runs/<id>/HUMAN_REVIEW.md`. The `followups` stage is what eventually renders / promotes it to `human_review`. Renderer lives partly in `lib/cli/cmd_validate.py` + `lib/cli/cmd_followups.py`.
- Board: `lib/board/source.py` builds a `RunSnapshot` (frozen dataclass) from `metadata.yaml` + `events.jsonl`; `lib/board/app.py` `_card_text()` (line 102) renders bands: title → meta → body → events → files. Each band separated by `_band_rule()` (line 68).
- YAML: `lib/yaml_io.py` is a flat-subset reader/writer (stdlib only). Handles nested dicts; suitable for `prices.yaml`.
- Tests: `tests/test_e2e.py` runs the CLI as a subprocess with `AGENT_WORKBENCH_STUB_LLM=<fixture-dir>`. Fixtures under `tests/fixtures/e2e/{happy,bounce_pass1,bounce_pass2}/`.

There is **no existing** `lib/metrics/` or `agent-workbench-live/metrics/` directory.

## Relevant files

- `lib/transitions.py:157` — append `TransitionApplied`; we need a post-transition hook here (or in `cmd_validate.py` after `transition()` returns).
- `lib/cli/cmd_validate.py:323-395` — emits `ReviewCompleted`, `QACompleted`, then transitions out. Hook after the transition.
- `lib/cli/cmd_complete.py`, `lib/cli/cmd_abandon.py` — terminal transitions; hook after `transition()` returns.
- `lib/cli/cmd_followups.py` — renders `HUMAN_REVIEW.md` (or stages it); the `## Token efficiency` block appends here.
- `lib/board/source.py` — add `metrics_summary` fields to `RunSnapshot` (best-effort, optional).
- `lib/board/app.py:178` — between events band and files band, insert a new metrics band.
- `bin/agent-workbench:25` — add `"metrics"` to `SUBCOMMANDS`.
- `agent-workbench.yaml` — no changes needed (price table lives in a separate file).
- `templates/HUMAN_REVIEW.md` — no template change; the metrics block is post-injected.

## Proposed changes

### New package: `lib/metrics/`

```text
lib/metrics/__init__.py
lib/metrics/transcript.py    # locate + correlate Claude Code transcript
lib/metrics/buckets.py       # input-token attribution
lib/metrics/prices.py        # load + validate prices.yaml; per-model rates
lib/metrics/lines.py         # generated_lines + accepted_lines
lib/metrics/writer.py        # record_run_metrics(run_id) → metrics.jsonl
lib/metrics/summary.py       # RunMetricsSummary dataclass; reads metrics.jsonl
lib/metrics/rollup.py        # workbench-wide rollup → metrics/index.json
```

Module responsibilities:

- **`transcript.py`** — `find_transcripts(project_slug, since_ts, until_ts) -> list[Path]` walks `~/.claude/projects/<slug>/*.jsonl` and returns transcripts whose mtime overlaps the run window. `correlate(transcript_paths, run_meta) -> list[CorrelatedTurn]` walks transcript lines, identifies slash-command tool-use payloads, and emits `(turn_id, stage, command, model, usage, ts)` tuples. The project slug is derived from the absolute path of the run's working directory (slash → dash, leading dash stripped) — same scheme Claude Code uses. Best-effort: turns we can't attribute to a stage get `stage = "other"`. Pure function over transcript bytes — unit-testable with fixture JSONL files.

- **`buckets.py`** — `attribute(turn) -> dict[bucket, tokens]`. Parses the user/system messages and tool-result blocks inside one turn, attributes input token count to the bucket whose marker matches: `system_prompt` (role=system), `tool_defs` (the `tools` array on the message), `claude_md_and_agents_md` (text matching `Contents of /Users/.../CLAUDE.md|AGENTS.md`), `context_imports` (text matching `@context/...` import expansion), `slash_command_body` (text inside `<command-name>...<command-args>`), `user_messages` (other user-role text), `assistant_history` (assistant turns in the transcript), `tool_results` (`tool_result` blocks). Unattributable bytes → `other`. Output bucket totals must sum to (within ±1 token of) the turn's reported `input_tokens` — we test this invariant.

- **`prices.py`** — `load(path) -> dict[model_id, Rates]` where `Rates = {input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_creation_per_mtok}`. Validates types, rejects negative values, errors clearly on malformed input. `cost(usage, rates) -> Decimal` computes `(input*r.input + output*r.output + cache_read*r.cache_read + cache_create*r.cache_create) / 1_000_000`. Unknown model → log to stderr, skip the turn's cost contribution (no crash, no synthetic price).

- **`lines.py`** — `count_generated(run_id, events_path) -> int` walks `events.jsonl` for `ArtifactWritten` rows + the worktree git history (`git log --numstat <branch>`), sums `+` lines. `count_accepted(run_id, meta) -> tuple[int, str|None]` runs `git diff --numstat <base_ref>...<merge_commit>` if a merge commit is captured; otherwise returns `(0, None)`. Merge commit capture: a new event `WorktreeMerged` is emitted from `cmd_complete.py` when the worktree is torn down (deferred — for now we read it from `metadata.completion.completion_ref` if it parses as a sha; non-zero accepted lines only after that field is populated).

- **`writer.py`** — `record_run_metrics(cfg, run_id) -> Path`. Pure function: walks transcript → bucketer → price table → writes a fresh `metrics.jsonl` (idempotent — overwrites, not appends, because we re-derive from the transcript every time). Also emits `build_outcome` rows by re-reading `events.jsonl` for `ReviewCompleted` events and pairing them with the most-recent `building→validating` transition. Emits `line_count` rows for both `generated` and `accepted` phases.

- **`summary.py`** — `summarize(metrics_path) -> RunMetricsSummary` reads `metrics.jsonl` and aggregates into the eight metrics. Frozen dataclass with `total_tokens`, `total_input`, `total_output`, `total_cache_read`, `total_cache_creation`, `tokens_per_passing_build`, `attempts`, `bucket_totals: dict[str, int]`, `generated_lines`, `accepted_lines`, `repair_tokens`, `cost_generated_usd`, `cost_accepted_usd` (Decimal → float for JSON). `first_pass_build_rate` is **not** a single-run metric; it's a fleet-level rollup computed in `rollup.py`.

- **`rollup.py`** — `rebuild(cfg) -> Path` walks every `runs/*/metrics.jsonl`, derives:
  - `first_pass_build_rate` overall and per `scope.kind`.
  - Totals: tokens, cost (generated), cost (accepted, only for `done` runs).
  - Monthly cost breakdown (`YYYY-MM` keys).
  - Leaderboard: top 20 runs by `tokens_per_passing_build` (worst at top).
  Writes `agent-workbench-live/metrics/index.json`. Regenerated on demand only.

### Price table

`agent-workbench-live/metrics/prices.yaml` (committed):

```yaml
schema_version: 1
models:
  claude-opus-4-7:
    input_per_mtok: 15.00
    output_per_mtok: 75.00
    cache_read_per_mtok: 1.50
    cache_creation_per_mtok: 18.75
  claude-opus-4-6:
    input_per_mtok: 15.00
    output_per_mtok: 75.00
    cache_read_per_mtok: 1.50
    cache_creation_per_mtok: 18.75
  claude-sonnet-4-6:
    input_per_mtok: 3.00
    output_per_mtok: 15.00
    cache_read_per_mtok: 0.30
    cache_creation_per_mtok: 3.75
  claude-sonnet-4-5:
    input_per_mtok: 3.00
    output_per_mtok: 15.00
    cache_read_per_mtok: 0.30
    cache_creation_per_mtok: 3.75
  claude-haiku-4-5:
    input_per_mtok: 0.80
    output_per_mtok: 4.00
    cache_read_per_mtok: 0.08
    cache_creation_per_mtok: 1.00
```

Prices are illustrative defaults; the file is hand-edited and committed. The loader rejects negative or non-numeric values.

### New CLI: `lib/cli/cmd_metrics.py`

Three modes:
- `agent-workbench metrics <run-id>` — plain-text report (eight metrics, per-stage breakdown, bucket histogram). `--json` for machine output.
- `agent-workbench metrics --all` — workbench rollup (leaderboard, fleet-level rates).
- `agent-workbench metrics --rebuild` — force rollup regeneration.

Pattern: load config, call `summary.summarize()` or `rollup.rebuild()`, render. No locking required (read-only against `metrics.jsonl`).

Wire into `bin/agent-workbench` `SUBCOMMANDS` list.

### Lifecycle hook

Add **one** call site to keep the change blast radius small: at the end of `lib/cli/cmd_validate.py`'s default-mode run (after `validating → followups` transition in staged mode, after `validating → human_review` in flat mode), call `metrics.writer.record_run_metrics(cfg, run_id)` inside a `try/except` that logs but never raises. Also call it from `cmd_complete.py` and `cmd_abandon.py` after the terminal transition. Three call sites total. Slash commands themselves do not self-report.

### HUMAN_REVIEW.md integration

`lib/cli/cmd_followups.py` (the renderer that promotes `HUMAN_REVIEW.md` for staged runs) gains a helper `_render_metrics_block(rd) -> str` that:
- Reads `runs/<id>/metrics.jsonl` if present.
- Calls `summary.summarize()`.
- Returns a markdown `## Token efficiency` block; empty string if no metrics exist.
- Appends to `HUMAN_REVIEW.md` after the existing content (idempotent: replaces any prior block delimited by markdown comments).

### Board card band

Add to `lib/board/source.py` `RunSnapshot`:
- `metrics_total_tokens: int | None`
- `metrics_build_attempts: tuple[int, int] | None`  # (approves, total_validates)
- `metrics_cost_usd: float | None`

`build_run_snapshot()` reads `runs/<id>/metrics-summary.json` if present (cheap path; cached by `metrics-summary.json` mtime). If `metrics.jsonl` exists but `metrics-summary.json` is stale, lazy-recompute via `summary.summarize()`.

Add to `lib/board/app.py` `_card_text()`, between the events band and files band: a new band rendered as `tokens 12.3k · build 1/2 · $0.42` with no severity styling. Compact mode unchanged.

## Files likely to change

- `lib/metrics/__init__.py` (new)
- `lib/metrics/transcript.py` (new)
- `lib/metrics/buckets.py` (new)
- `lib/metrics/prices.py` (new)
- `lib/metrics/lines.py` (new)
- `lib/metrics/writer.py` (new)
- `lib/metrics/summary.py` (new)
- `lib/metrics/rollup.py` (new)
- `lib/cli/cmd_metrics.py` (new)
- `bin/agent-workbench` (add subcommand to dispatcher)
- `lib/cli/cmd_validate.py` (add post-transition hook in default mode)
- `lib/cli/cmd_complete.py` (add post-terminal hook)
- `lib/cli/cmd_abandon.py` (add post-terminal hook)
- `lib/cli/cmd_followups.py` (add `## Token efficiency` block to HUMAN_REVIEW)
- `lib/board/source.py` (extend `RunSnapshot` with metrics fields)
- `lib/board/app.py` (insert metrics band)
- `agent-workbench-live/metrics/prices.yaml` (new)
- `tests/test_metrics_transcript.py` (new)
- `tests/test_metrics_buckets.py` (new)
- `tests/test_metrics_prices.py` (new)
- `tests/test_metrics_lines.py` (new)
- `tests/test_metrics_summary.py` (new)
- `tests/test_metrics_e2e.py` (new — integration over happy/bounce_pass2 fixtures)
- `tests/test_cmd_metrics.py` (new — CLI smoke)
- `tests/fixtures/transcripts/` (new — small transcript JSONL fixtures)

## Data model changes

No `metadata.yaml` field changes. No new event types in `schemas/events.jsonl` (the brief's non-goals call this out).

The new on-disk artifacts are entirely contained in `runs/<id>/metrics.jsonl` (append-only schema, validated only by writer.py — no transition-schema enforcement), `runs/<id>/metrics-summary.json` (derived, regeneratable), `agent-workbench-live/metrics/prices.yaml` (hand-edited), and `agent-workbench-live/metrics/index.json` (derived).

## UI changes

- `agent-workbench metrics ...` — new CLI subcommand. Plain-text by default, `--json` for machines.
- `HUMAN_REVIEW.md` — gains a `## Token efficiency` block at the bottom (only when `metrics.jsonl` exists).
- Live board card — gains a 3rd band `tokens · build · $`. No color/severity styling.

## Test plan

### Unit tests

- `test_metrics_transcript.py` — feed a fixture `~/.claude/projects/<slug>/abc.jsonl` containing 3 turns (one `/shape`, one `/build`, one out-of-run) plus correlate against a fixture `metadata.yaml`; assert correlator returns 2 turns with correct (stage, command) labels.
- `test_metrics_buckets.py` — feed a turn with known message segments; assert per-bucket attribution sums to (within ±1 token of) `input_tokens`. Cover every named bucket plus `other`.
- `test_metrics_prices.py` — valid file loads; malformed (negative value, missing key, unknown type) errors clearly; unknown model logs and skips.
- `test_metrics_lines.py` — generated-only run (no merge); merged run (sha captured); abandoned run (accepted=0).
- `test_metrics_summary.py` — feed a small `metrics.jsonl` and assert each of the 8 metrics matches hand-computed expectations.

### Integration tests

- `test_metrics_e2e.py` — drive the `happy/` fixture through `record_run_metrics`, snapshot `metrics.jsonl`, assert summary matches expected. Same for `bounce_pass2/` with `attempts >= 2` and `repair_tokens > 0`.

### CLI smoke

- `test_cmd_metrics.py` — invoke `agent-workbench metrics <run-id>` (plain), `--json` (parses), `--all` (no error on empty workbench), `--rebuild` (creates `index.json`).

### Board test

- `test_board_snapshot.py` (extend) — verify the metrics band appears when `metrics-summary.json` exists.

## QA plan

Run the full unit test suite:

```bash
cd agent-workbench-live
python3 -m unittest discover -s tests -v
```

Walk the existing `2026-05-22-token-efficiency-tracking` run through `validate` (in a stub-LLM E2E fixture) and verify `metrics.jsonl` materializes, the metrics CLI prints all 8 fields, and the HUMAN_REVIEW.md gains the `## Token efficiency` block.

## Risks

- **Transcript schema drift.** Claude Code's `~/.claude/projects/*.jsonl` format isn't a public contract. Mitigation: schema-tolerant parsing (best-effort `dict.get(...)` chains), and a fixture-based test that pins behavior against a snapshot. Re-validate against a current transcript before landing.
- **Slug derivation for project dir.** We assume `~/.claude/projects/<slug>` slug = absolute working-dir path with `/` → `-` and leading `-` stripped. If Claude Code uses a different scheme, transcript lookup misses. Mitigation: ASM-001 — log a "transcript not found" warning and produce a metrics file with `total_tokens=0` rather than crashing.
- **Bucket attribution drift.** Heuristic-based parsing of the transcript's text content (e.g., "Contents of /Users/.../CLAUDE.md" marker). When that string changes, more bytes fall into `other`. Mitigation: track the `other` fraction; assert in CI that it stays <10% on the happy fixture.
- **Accepted-lines computation gap.** Without a merge step (the workbench's `merge_branches: false` policy), `accepted_lines` is always 0 unless the user merges manually outside the workbench. Document this; surface "pending merge" explicitly in the HUMAN_REVIEW block and board card.
- **Cost noise from short-lived turns.** Single-token cache-creation events can dominate dollars for very short stages. Acceptable — we surface the raw numbers; the operator interprets.

## Definition of done

- All new modules under `lib/metrics/` exist, exported from `__init__.py`.
- `agent-workbench metrics <run-id>` prints all eight metrics for a finished run.
- `agent-workbench metrics --all` reports `first_pass_build_rate` as a percentage.
- `agent-workbench metrics --rebuild` regenerates `metrics/index.json`.
- `runs/<id>/metrics.jsonl` exists for runs that have reached at least `validating`.
- `HUMAN_REVIEW.md` carries `## Token efficiency` for runs whose `metrics.jsonl` exists.
- Live board card renders the third band when metrics exist; absent otherwise.
- All unit tests pass; E2E happy + bounce_pass2 snapshots committed.
- No threshold-driven UI loudness (no warnings, no red/yellow on the metrics band).

## Preflight

Tooling: Python 3 stdlib only (matches existing CLI). No new deps. `pip install -r requirements-board.txt` for the optional TUI is unchanged.

Repo state: this run targets the same monorepo path as the workbench itself
(`/Users/timothy.shee/GitHub/LOCAL_worktrees/202605_agent_workbench_v2/agentic-development-task-system-v2__ai`). The worktree
created by `/start` will live under `agent-workbench-live/worktrees/agentic-development-task-system-v2-ai/<wt>`.

Existing tests pass: `python3 -m unittest discover -s tests -v` runs cleanly before any changes (will be confirmed at start-of-build).

Branch hygiene: `agent/token-efficiency-tracking` does not yet exist (will be created by `start`).

## Decisions & assumptions

### DR-001
- **Decision**: Per-run `metrics.jsonl` is regenerated wholesale from the transcript on each call to `record_run_metrics`, not appended incrementally.
- **Rationale**: Idempotency is easier to test, the transcript is the immutable source of truth, and re-running on a finished run must yield the same file content.
- **Alternatives considered**: (a) Append-only per turn fired from inside the slash commands. (b) Append-only at every lifecycle hook, deduping on `turn_id`.
- **Why not the alternatives**: (a) requires slash commands to self-report, which the brief's non-goals forbid. (b) leaves us with a duplicate-detection problem and risks divergence between `metrics.jsonl` and the transcript.

### DR-002
- **Decision**: Best-effort bucket attribution. Unattributable bytes fall into `other` rather than being guessed.
- **Rationale**: "Better to under-report than mis-report" — operators reading the histogram should see a clean `other` bucket if our heuristics break, not silently-wrong assignments.
- **Alternatives considered**: (a) Distribute unknown bytes proportionally across known buckets. (b) Raise an error when `other > 5%` of input.
- **Why not the alternatives**: (a) hides the heuristic drift behind plausible-looking numbers. (b) breaks downstream CLI flows over a measurement artifact that doesn't affect correctness.

### DR-003
- **Decision**: `first_pass_build_rate` is a fleet-level metric only, never per-run.
- **Rationale**: The TODO spec says so (§3 #3 — "Computed at the **fleet** level, not per-run"). A per-run boolean is much less informative than a percentage across many runs.
- **Alternatives considered**: Computing it per-run as `1 if first validate APPROVE no later changes else 0` and rolling up later.
- **Why not the alternatives**: A per-run boolean is misleading on its own; a single failed run is not a "0%" rate. The rollup must work over a population.

### DR-004
- **Decision**: Lifecycle hook is wired in three CLI command files (`cmd_validate.py`, `cmd_complete.py`, `cmd_abandon.py`), not inside `lib/transitions.py`.
- **Rationale**: `transitions.py` is pure state-machine logic. Adding I/O (transcript walks, file writes) inside it would couple every transition to filesystem availability and complicate unit testing. Hooking in command files keeps `transitions.py` deterministic.
- **Alternatives considered**: A generic post-transition callback registered with the transitions module.
- **Why not the alternatives**: Three call sites is small enough that explicit calls beat a hook abstraction; the abstraction would obscure where metrics are recorded and pay no carrying cost back.

### DR-005
- **Decision**: `prices.yaml` is hand-maintained, schema_version=1, lives at `agent-workbench-live/metrics/prices.yaml`, and committed.
- **Rationale**: The brief's non-goals call this out — no price discovery, no auto-update. The workbench is local-only and unconnected to billing APIs.
- **Alternatives considered**: Pulling rates from Anthropic's billing API at run time.
- **Why not the alternatives**: Adds a network dependency and an auth flow to what is otherwise a stdlib-only, offline CLI.

### DR-006
- **Decision**: `accepted_lines` reads from `metadata.completion.completion_ref` when it parses as a SHA, then runs `git diff --numstat <base_ref>...<sha>`. No new event type is added.
- **Rationale**: The workbench's `merge_branches: false` policy means the workbench itself doesn't merge. The `completion_ref` field already captures `local-branch:<branch>` on completion; we extend it minimally to also capture a merge SHA if the user manually merges and re-runs `complete`. No schema change needed (the field is a free-form string).
- **Alternatives considered**: A new `WorktreeMerged` event type.
- **Why not the alternatives**: The brief's non-goals forbid new event types. A free-form string interpretation is enough for the read path.

### ASM-001
- **Text**: Claude Code's transcript directory at `~/.claude/projects/<slug>/` uses a project slug derived from the absolute working-directory path with `/` → `-` and leading dash stripped.
- **Reason**: This is the convention observed in `~/.claude/projects/-Users-timothy-shee-GitHub-new-tech-monorepo/` in this very machine's home directory.
- **Impact**: medium. If wrong, the correlator silently produces empty metrics; we surface a "transcript not found" log line so the operator can diagnose.

### ASM-002
- **Text**: Every Claude Code transcript turn carries `message.usage.input_tokens`, `message.usage.output_tokens`, `message.usage.cache_read_input_tokens`, `message.usage.cache_creation_input_tokens` (or zero for absent fields), plus a `model` id at the top of the turn record.
- **Reason**: Documented in Anthropic's API; observed in existing transcripts.
- **Impact**: high. If the schema drifts, the writer's `usage` extraction returns zeros and the metrics under-report. Mitigation: defensive `.get(..., 0)` with a per-turn warning when all four are zero.

### ASM-003
- **Text**: Slash-command turns can be identified by the user-message body containing `<command-name>` and `<command-args>` XML-style tags, or equivalent.
- **Reason**: This is the convention observed in transcripts in `~/.claude/projects/-Users-timothy-shee-GitHub-new-tech-monorepo/`.
- **Impact**: medium. If absent, those turns fall into `stage = "other"` rather than being mis-attributed.

### ASM-004
- **Text**: The `monorepo` worktree we're working in is itself a git worktree of `~/Klaviyo/Repos/...`'s style structure. `git diff --numstat <base_ref>...HEAD` runs cleanly inside the worktree.
- **Reason**: Confirmed via `git -C <worktree> worktree list` during planning.
- **Impact**: low. If the diff command fails, lines.py returns `(0, error_str)` and we surface the error rather than crash.

### ASM-005
- **Text**: The board's existing TUI library (`rich`) supports adding additional `Text.append(...)` lines without changing layout machinery.
- **Reason**: The card renderer in `lib/board/app.py:102` is already band-additive — every band is one `text.append_text(_band_rule())` + content + (optional) `text.rstrip()`.
- **Impact**: low. The new band drops cleanly into the existing pattern.
