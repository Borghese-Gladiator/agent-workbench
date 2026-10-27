# Token Efficiency Tracking

Add per-run token + cost + acceptance tracking to agent-workbench. Today we have no idea how
expensive a run is — we don't know which stage burns the most tokens, whether bouncing through
validation is a 2× or 10× tax, or which scope kinds deliver the most accepted code per dollar.
This work adds **measurement only** — no limits, no budgets, no warnings.

Per the §3 spec in `docs/TODO.md`, eight metrics are tracked:

1. `total_tokens_per_task` — sum of input/output/cache-read/cache-creation tokens across every
   Claude Code turn fired inside the run's slash commands.
2. `tokens_per_passing_build` — `total_tokens / number_of_APPROVE_validates`.
3. `first_pass_build_rate` — fleet-level share of runs where the first `/validate` after the first
   `/build` returned APPROVE with no subsequent re-validation.
4. `attempts_per_success` — count of build → validate cycles to reach `done` (or to `abandoned`).
5. `context_tokens_by_bucket` — input tokens by bucket: `system_prompt`, `tool_defs`,
   `claude_md_and_agents_md`, `context_imports`, `slash_command_body`, `user_messages`,
   `assistant_history`, `tool_results`, `other`.
6. `accepted_lines / generated_lines` — generated counts every `+` line the agent wrote across all
   drafts (including discarded); accepted is the `+` lines from
   `git diff --numstat <base_ref>...<merge_commit>` after worktree merge.
7. `repair_tokens_per_task` — tokens consumed by re-runs of `/validate`, `/build` re-entries after
   a bounce, and post-validate session work that re-touched build artifacts.
8. Total cost (generated) and total cost (accepted) — dollar cost of every token consumed,
   computed against a per-model price table at turn-fire time.

Storage layout: `agent-workbench-live/metrics/{index.json, prices.yaml}` workbench-wide,
`runs/<id>/metrics.jsonl` (append-only) + `metrics-summary.json` (derived) per run.

Data source: the Claude Code transcript at `~/.claude/projects/<slug>/*.jsonl`. Every turn already
carries `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`
plus a model id — correlate transcript turns to run by matching slash-command tool-use payloads
at turn start and the run's working directory, against the run's `created_at`..`updated_at` window.

Modules to add under `lib/metrics/`:
- `transcript.py` — locator + correlator, given run_id → list of `(turn, stage, command)` tuples.
- `buckets.py` — input-token attribution per turn.
- `prices.py` — price-table loader, validates `prices.yaml`.
- `writer.py` — `record_run_metrics(run_id) -> None`, idempotent; writes `metrics.jsonl`.
- `lines.py` — generated_lines / accepted_lines computation.
- `summary.py` — reads `metrics.jsonl`, returns `RunMetricsSummary` dataclass with all 8 metrics.
- `rollup.py` — workbench rollup; writes `metrics/index.json`.

CLI: `agent-workbench metrics <run-id>` (plain + `--json`), `metrics --all`, `metrics --rebuild`.

Integrations:
- HUMAN_REVIEW.md: append a `## Token efficiency` block when `metrics.jsonl` exists.
- Live board card: extra band `tokens 12.3k · build 1/2 · $0.42`; read-only telemetry, no
  threshold-driven loudness.
- Lifecycle hooks: call `record_run_metrics` after every `/validate` transition and at terminal
  `done`/`abandoned`.

Tests:
- Unit: `transcript.py`, `buckets.py`, `prices.py`, `lines.py`.
- Integration: drive existing E2E fixtures (`happy/`, `bounce_pass2/`) through
  `record_run_metrics`, snapshot the resulting `metrics.jsonl`.
- CLI smoke for all three `metrics` forms.

Non-goals: budgets/limits/warnings; per-turn live metering (batch at transition time);
non-Claude-Code LLMs; price discovery (`prices.yaml` is hand-maintained); cross-project rollups;
per-developer cost allocation.
