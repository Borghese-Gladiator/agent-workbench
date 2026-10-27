# Brief

## Goal

Add per-run token + cost + acceptance tracking to agent-workbench so operators can answer
"how expensive was this run?" without grepping the Claude Code transcript by hand. Tracking is
**measurement only** — no budgets, no thresholds, no warnings.

Eight metrics, computed from the existing Claude Code transcript (`~/.claude/projects/<slug>/*.jsonl`)
correlated against the run's lifecycle events:

1. `total_tokens_per_task` — input + output + cache-read + cache-creation summed across every turn
   fired inside the run's slash commands.
2. `tokens_per_passing_build` — `total_tokens / count(validate=APPROVE)`. Higher = more retries.
3. `first_pass_build_rate` — fleet-level: share of runs whose first `/validate` after the first
   `/build` returned APPROVE with no later re-validation. Not per-run.
4. `attempts_per_success` — count of build → validate cycles up to terminal state.
5. `context_tokens_by_bucket` — input tokens split by `system_prompt`, `tool_defs`,
   `claude_md_and_agents_md`, `context_imports`, `slash_command_body`, `user_messages`,
   `assistant_history`, `tool_results`, and `other`.
6. `accepted_lines / generated_lines` — generated = every `+` line the agent wrote (including
   discards); accepted = `+` lines from `git diff --numstat <base_ref>...<merge_commit>` after
   worktree merge.
7. `repair_tokens_per_task` — tokens consumed by re-runs of `/validate`, `/build` re-entries
   after bounce, and post-validate session work that re-touched build artifacts.
8. Total cost (generated) and total cost (accepted) — per-model price table at turn-fire time.

## User-facing behavior

- New CLI: `agent-workbench metrics <run-id>` shows the eight metrics for one run with a per-stage
  breakdown and bucket histogram. `--json` for machine consumption.
- `agent-workbench metrics --all` shows the workbench rollup: leaderboard by
  `tokens_per_passing_build`, fleet-level `first_pass_build_rate` per scope kind, monthly cost
  totals.
- `agent-workbench metrics --rebuild` forces the rollup to regenerate from per-run files.
- `HUMAN_REVIEW.md` for any run with a `metrics.jsonl` carries a `## Token efficiency` block
  (one line per metric + one cost summary line `generated: $X.XX · accepted: $Y.YY pending merge`).
- The live board card grows a third band below the meta line:
  `tokens 12.3k · build 1/2 · $0.42`. Read-only telemetry — no loud-card behavior.

## Acceptance criteria

- After any run reaches `human_review` or beyond, `runs/<id>/metrics.jsonl` exists and contains at
  least one `turn` row per Claude Code turn fired inside that run's slash commands.
- `agent-workbench metrics <run-id>` prints all eight metrics. `accepted_lines` is non-zero only
  after the worktree has merged.
- `agent-workbench metrics --all` reports a fleet-level `first_pass_build_rate` as a percentage
  (not a per-run boolean).
- `HUMAN_REVIEW.md` carries the `## Token efficiency` block for runs whose `metrics.jsonl` exists.
- The live board card renders the `tokens · build · $` band with no threshold-driven loudness.
- E2E fixture runs (`happy/`, `bounce_pass2/`) produce snapshot-tested `metrics.jsonl` outputs.
- Unit tests cover `transcript.py`, `buckets.py`, `prices.py`, `lines.py`.

## Non-goals

- Budgets, limits, warnings, or any threshold-driven UI loudness.
- Per-turn live metering — tracking batches at transition time from the transcript.
- Non-Claude-Code LLMs.
- Price discovery — `prices.yaml` is hand-maintained, committed in repo.
- Cross-project rollups. Scope is this workbench only.
- Cost-allocation per developer or team. Tracking is per-run only.
- Changing the existing review-decision flow or what the builder writes into `build.md`.

## Good examples

- A `human_review` run prints:
  ```
  total_tokens: 184,210 (input 110k, output 12k, cache_read 60k, cache_create 2k)
  tokens_per_passing_build: 184,210
  attempts_per_success: 1
  context_tokens_by_bucket: { system_prompt: 8.2k, tool_defs: 12.4k, claude_md_and_agents_md: 6.1k,
    context_imports: 4.0k, slash_command_body: 2.8k, user_messages: 18.0k, assistant_history: 41.5k,
    tool_results: 17.0k, other: 0 }
  generated_lines: 612
  accepted_lines: 0 (pending merge)
  repair_tokens_per_task: 0
  cost_generated_usd: 1.42
  cost_accepted_usd: 0.00 (pending merge)
  ```

## Bad examples

- A `## Token budget` block warning the user that a run exceeded a threshold. **Not built.**
- A live per-turn meter updating mid-`/build`. **Not built** — we batch at transition boundaries.
- A "tokens used by Tim vs Alice" leaderboard. **Not built** — per-run only.

## Constraints

- Stdlib-only for the core (matches the existing CLI). The board band may use the existing TUI
  library, but the metrics CLI must run with no `pip install`.
- `metrics.jsonl` is append-only and idempotent: re-running `record_run_metrics(run_id)` on the
  same run produces the same file content (overwrite, not append).
- Best-effort attribution: unattributable input bytes go into the `other` bucket rather than being
  guessed at. Better to under-report than mis-report.
- Unknown model ids in the transcript log a warning and skip cost computation for that turn — no
  synthetic prices.
- Per-run `metrics.jsonl` is the source of truth. Workbench rollup at
  `agent-workbench-live/metrics/index.json` is regenerated on demand and never edited by hand.

## Assumptions

- The Claude Code transcript lives at `~/.claude/projects/<project-slug>/*.jsonl` where
  `<project-slug>` is the slugified absolute path of the working directory.
- Each transcript turn carries `message.usage.{input_tokens, output_tokens, cache_read_input_tokens,
  cache_creation_input_tokens}` and a `model` id.
- Slash-command turns are identifiable by the user-message body containing `<command-name>` and
  `<command-args>` tags or equivalent — we can correlate via tool-use payload and the run's working
  directory.
- The run's working directory during `/build` / `/validate` is the worktree path recorded in
  `metadata.yaml.target.worktree.path`.

## Suggested QA scenarios

- Drive the `happy/` E2E fixture through `record_run_metrics`; snapshot `metrics.jsonl`; assert
  the eight summary metrics match hand-computed expectations.
- Drive the `bounce_pass2/` fixture (which has a request-changes followed by re-validate); assert
  `attempts_per_success >= 2` and `repair_tokens_per_task > 0`.
- Run `agent-workbench metrics` against a finished run; verify `--json` output round-trips.
- Run `agent-workbench metrics --all`; verify `first_pass_build_rate` is computed across runs and
  rendered as a percentage.
- Render a `HUMAN_REVIEW.md` for a run with `metrics.jsonl` and confirm the `## Token efficiency`
  block appears. Render one without `metrics.jsonl` and confirm the block is absent.
- Open the live board and confirm the `tokens · build · $` band appears for runs with metrics; no
  loudness or color-coding tied to thresholds.
- Hand-edit `prices.yaml` with a malformed entry; assert `agent-workbench metrics` errors clearly.
- Point at a transcript referencing an unknown model id; assert the cost computation logs a warn
  and continues without crashing.
