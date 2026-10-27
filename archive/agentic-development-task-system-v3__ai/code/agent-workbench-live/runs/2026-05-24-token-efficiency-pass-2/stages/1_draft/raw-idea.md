# Token efficiency — pass 2: stop bleeding cache_read

## Why this is here

Pass 1 shipped per-run metrics, but on its own dogfood run (`runs/2026-05-22-token-efficiency-tracking/metrics.jsonl`) the numbers are:

| Bucket | Tokens | Share | Bucketed by pass 1? |
|---|---:|---:|:---:|
| fresh input | 2,934 | 0.0024% | yes |
| output | 425,478 | 0.34% | n/a |
| cache_creation | 1,178,364 | 0.95% | **no** |
| cache_read | **121,786,040** | **98.7%** | **no** |
| **total** | **123,392,816** | | |
| **cost** | **$236.73** | | |

Pass 1 only buckets `input_tokens`. That accounts for **0.003% of cost**. The renderer literally prints "cache_read not bucketed" (`lib/cli/cmd_metrics.py:88`). So measurement is half-built. Worse: 100% of 621 turns on that run landed in `stage=other, command=""` — the slash-command correlator silently broke, so there isn't even a per-phase split. Both are pass-1 gaps that this section closes.

## Root cause of the 121.8M cache_read

It is the same conversation prefix re-billed every turn:

```
total cache_read ≈ (average prefix size) × (number of turns)
                 ≈ 196,000 × 621
                 ≈ 121.7M
```

Three multiplicative drivers, in priority order of impact:

1. **One long session for build + validate.** 621 turns in one session = a prefix that grows to 295k tokens by the end, re-read on every step. Biggest lever. Mitigation: fresh session at `/validate`.
2. **Validate independently re-reads what the builder already loaded.** `.claude/commands/validate.md` Step 2-3 instructs the model to read `brief.md`, `plan.md`, the diff, and run `git diff` / `git grep` inside the session that already holds the full build history. Every read sticks in the prefix forever after. Mitigation: a single curated `validate-context.md` file.
3. **Per-turn fixed overhead (CLAUDE.md, AGENTS.md, tool defs).** ~10-30k tokens that load every single turn. Even small, multiplied by 621 turns = millions of tokens. Mitigation: audit and shrink.

## Design principles

- **Reduce by structure, not by hiding context.** The validator needs the diff and the right files — not the build session's conversation history. Cut the latter, keep the former.
- **Deterministic context curation > model-curated.** `validate-context.md` is built by Python in `validate --init`, with no LLM call. Cheaper, repeatable, testable.
- **Fresh sessions are first-class lifecycle discipline.** Not "a hint" — call it out in `AGENTS.md`, surface it in CLI output, and make the handoff (`validate-context.md` + run_id + worktree path) explicit. The human still chooses, but the workflow is built around the right default.
- **Attribution before reduction.** Pass 1's bucketer is the only way to know whether mitigations actually worked. Land the cache buckets first; measure the impact of each subsequent task.
- **Honest under-attribution beats confident mis-attribution.** Cache buckets use the same heuristic-and-residual-into-`other` pattern as input buckets.

## Tasks — Part A: visibility (you can't fix what you can't see)

- **A1. Fix the slash-command correlator.** `lib/metrics/transcript.py:correlate()` + `_cwd_matches()` are landing 100% of turns into `stage=other, command=""` on the pass-1 dogfood run. Diagnose first (suspect: worktree-path resolution vs. `meta.target.worktree.path`, OR `current_command` not propagating across record types). Land a regression test that points at the production transcript's `session_id` and asserts non-empty `stage` distribution. Without this, every per-phase metric is broken.
- **A2. Bucket `cache_read_input_tokens` and `cache_creation_input_tokens`.** Extend `lib/metrics/buckets.py:attribute()` to return three dicts: existing `input_buckets` plus new `cache_read_buckets` and `cache_creation_buckets`. Computation: walk the transcript prefix per turn (accumulate user/assistant/tool-result text monotonically), apply the existing 4-chars/token heuristic per region, scale to the API's `cache_read_input_tokens` / `cache_creation_input_tokens` counts respectively, residual into `other`. Add the missing buckets: `system_prompt` (constant estimate or first-turn measurement), `tool_defs` (count of tools × ~150 tokens/tool), `repo_files` (tool_results matching the `Read` output gutter pattern `^\s*\d+\t`), `validation_context` (tool_results within a `/validate` span), `generated_drafts` (assistant turns whose body contains markdown headers — proxy for review.md / build.md drafts). Keep `claude_md_and_agents_md`, `context_imports`, `slash_command_body`, `user_messages`, `assistant_history`, `tool_results`, `other`.
- **A3. Carry session prefix through `correlate()`.** Extend `CorrelatedTurn` with three new tuple fields: `prefix_user_messages`, `prefix_assistant_messages`, `prefix_tool_results`. Unlike the existing `pending_*` per-turn buffers, these accumulate monotonically across the session so A2's bucketer can attribute the cache prefix. Don't clear them on turn boundary.
- **A4. Surface the new buckets.** Update `RunMetricsSummary` (`lib/metrics/summary.py`) with `cache_read_by_bucket: dict[str, int]` and `cache_creation_by_bucket: dict[str, int]`. Update `_render_summary_plain` (`lib/cli/cmd_metrics.py:88-90`) to drop the "input tokens only" disclaimer and render three sub-sections: `input buckets`, `cache_read buckets`, `cache_creation buckets`.
- **A5. Per-turn `metrics.jsonl` row update.** `lib/metrics/writer.py:177-199` writes one `bucket_attribution` key today; add `cache_read_attribution` and `cache_creation_attribution` next to it. Bump `schema_version` to 2; summary reader tolerates both.
- **A6. Cache-miss visibility.** Add `cache_misses: int` to `RunMetricsSummary`, computed as the count of turns where `cache_creation > 1000`. Surface as `cache misses: N` in the per-run summary. Helps detect long pauses that re-wrote the cache (5-minute TTL).
- **A7. Re-baseline `tokens_per_passing_build`.** Today it's `total_tokens / approves` where `total_tokens` is dominated by `cache_read`, so the metric tracks session length more than agent efficiency. Add `billable_net_per_passing_build = (input + output + cache_creation) / approves` — excluding `cache_read` — alongside. Keep the original for continuity; render both.
- **A8. Session-turn-count metric.** Add `largest_session_turns: int` and `largest_session_id: str` to `RunMetricsSummary`. Surface in the per-run summary. Required input for A9 and Part B.
- **A9. Board: session-staleness band.** `lib/board/snapshot.py` already renders a metrics band per pass 1. Append a `turns: N` indicator when `largest_session_turns > 100`. Read-only nudge; no loud-card behavior.

## Tasks — Part B: mitigation (largest impact first)

- **B1. Promote fresh sessions to a lifecycle discipline in `agent-workbench-live/AGENTS.md`.** Add a `## Session discipline` section. Rules:
  - **Always start a new Claude Code session at the `/validate` boundary** when the building session has > 100 turns. The handoff is the run_id + worktree path; nothing else needs to carry over.
  - **Always start a new session between independent runs.** A new `/new-run` for an unrelated task = exit and relaunch first.
  - **Stay in the same session for `/shape` → `/plan` → `/build`.** These share useful context and the cache amortizes well.
  - **Restart when you see Claude Code's auto-compact notice.** That's a signal you're already paying for a lot of prefix; better to restart than let it compact mid-task.
  - Include the rationale (one paragraph on the prefix-grows-monotonically mechanic; reference the pass-1/pass-2 measurement). Discipline only sticks if the "why" is in front of the reader.
- **B2. `validate-context.md` template + deterministic auto-generation.** New file at `agent-workbench-live/templates/validate-context.md`. Sections: original task, acceptance criteria, plan decisions + assumptions (load-bearing only — filter for ASM-/DR- IDs referenced in build.md), final diff (`git diff --stat` always; full `git diff` capped at 500 lines, otherwise filenames + per-file line counts), files changed (full list from `git diff --name-status`), commands run (from build.md), test results (from qa/report.md), known issues / risks (from build.md), reviewer reading order (from build.md). `lib/cli/cmd_validate.py:_init` populates the file by reading the run's existing artifacts + running git. Pure Python, deterministic, no LLM call.
- **B3. Update `/validate` to read `validate-context.md`.** Edit `.claude/commands/validate.md` Step 2-3: replace "Read `brief.md`, `plan.md`, and the diff" with "Read `runs/<id>/stages/5_validating/validate-context.md`. That file is the curated entry point. Read brief/plan/build/qa directly only if validate-context.md points you at a specific section." Add a one-line note that the validator should NOT re-read files that are summarized in validate-context.md.
- **B4. Pre-compute blast radius.** `templates/review.md` lines 29-54 instruct the model to run `git diff --name-only` + `git grep -n <symbol>` up to depth 3. Move that to Python in `validate --init`: compute the same tree and write `runs/<id>/stages/5_validating/blast-radius.txt`. Update `templates/review.md` to read the file rather than running the commands live. Trades N tool_results for one fixed-size file.
- **B5. Fresh-session handoff at `validate --init`.** When `validate --init` runs, check `largest_session_turns` for the session that produced `building`. If > 100, print a top-of-output **handoff block** (not just a hint) with the copy-pasteable shape:
  ```
  This run is ready for validation in a fresh Claude Code session.
    run_id:    <id>
    worktree:  <abs path>
    branch:    <branch>
  Exit Claude Code, then:
    cd <worktree>
    claude
    /validate <id>
  The new session bootstraps from validate-context.md — no other context needed.
  ```
  Make the threshold configurable via `agent-workbench.yaml` (`session_staleness_threshold_turns: 100` default).
- **B6. Audit and shrink CLAUDE.md / AGENTS.md weight.** On a 621-turn session, each 1k tokens of always-loaded instructions costs ~621k tokens of `cache_read`. Read `~/.claude/CLAUDE.md`, repo-root `AGENTS.md`, `agent-workbench-live/AGENTS.md`. For each: identify content that's (a) duplicated across files, (b) only relevant to a specific stage (move into the slash-command body instead — loaded once per invocation), (c) historical/contextual reference that doesn't drive agent behavior (move to docs/architecture.md or LOG.md). Target: cut combined always-loaded instruction weight by 30%+. Land as a single PR with before/after token counts measured via the pass-1 metrics on a same-length dogfood run.
- **B7. Subagent-first read strategy for `/build` and `/validate`.** Today, file reads happen in the master session and their results stick in the master prefix forever. Update `agent-workbench-live/AGENTS.md` § "Subagent discipline" to require: when a stage needs to read more than 3 files for exploration (not edits), route through an `Explore` subagent. The subagent returns a summary; the master keeps a tiny prefix. Add concrete examples to `.claude/commands/build.md` and `.claude/commands/validate.md`. This is the single most impactful change after fresh sessions — it bounds how big the build session's own prefix can grow.
- **B8. Tool-output budget guidance.** Add to `agent-workbench-live/AGENTS.md`: a soft budget per Bash tool call (Read outputs > 2k tokens → use `head`/`tail`/grep; `git log` → cap with `-n 20`; `git diff` → `--stat` first, full diff only if needed). Document the pattern so it sticks across sessions. Not enforced — guidance only.

## Tasks — Part C: tests + acceptance gating

- **C1. Fixture-driven cache-bucket attribution test.** Synthetic transcript with a 100k-token prefix that includes all bucket types in known proportions. Assert `cache_read_by_bucket` attributes correctly within ±2% (the scale step adds rounding noise).
- **C2. Regression test for the correlator fix.** Load the pass-1 dogfood run's actual transcript via `find_transcripts`. Assert that after the A1 fix, > 50% of turns have non-`other` `stage`.
- **C3. Snapshot test for `validate-context.md`.** Drive the existing `happy/` and `bounce_pass2/` E2E fixtures through `validate --init`; snapshot the generated file. Catches regressions in the deterministic builder.
- **C4. CLI smoke test.** `agent-workbench metrics <id>` output includes the three bucket sub-sections, `cache misses: N`, `billable_net_per_passing_build`, and `turns: N`.
- **C5. End-to-end cost measurement.** After all Part B tasks land, run a `happy/` E2E fixture and measure the new `cache_read` total. Acceptance: total `cache_read` for the run is ≥ 40% lower than the pass-1 dogfood baseline (123.4M → ≤ 74M for an equivalent workload).

## Acceptance

- `agent-workbench metrics <run-id>` prints `cache_read buckets` and `cache_creation buckets` that sum (within ±2%) to the run's `total_cache_read` / `total_cache_creation`.
- On the pass-1 dogfood run, re-running `agent-workbench metrics <id> --record` produces a per-turn `stage` distribution that is no longer 100% `other`.
- `/validate <id>` on a fresh run produces `stages/5_validating/validate-context.md` and `blast-radius.txt` before any LLM call.
- `.claude/commands/validate.md` instructs reading `validate-context.md` instead of brief/plan/build separately.
- `agent-workbench-live/AGENTS.md` has a `## Session discipline` section that names the fresh-session-at-validate rule, the new-session-between-runs rule, and the why.
- `validate --init` prints the full fresh-session handoff block (not just a one-line hint) when `largest_session_turns > 100`.
- `~/.claude/CLAUDE.md` + repo `AGENTS.md` files have measurably-shrunk always-loaded weight (before/after counts in the LOG.md entry).
- `agent-workbench-live/AGENTS.md` § "Subagent discipline" prescribes Explore subagents for multi-file reads in `/build` and `/validate`.
- E2E fixture cache_read drops by ≥ 40% vs. the pass-1 baseline.

## Non-goals

Enforcing cache_read budgets (no hard limits, no warnings that block transitions); auto-restarting Claude Code (no harness automation that exits the user's session); rewriting `lib/metrics/transcript.py` correlator from scratch (it's load-bearing for pass 1 — patch, don't rewrite); cross-session de-duplication of cached prefix (Anthropic's cache layer is what it is — we work around it via session discipline, not at the API layer); supporting non-Claude-Code LLMs.

## How far this gets us — and what it doesn't solve

After this section lands, the answer to "where did the cache_read go" is no longer "unknown." The validate phase's contribution drops materially (curated context + fresh session + pre-computed blast radius). The fixed per-turn overhead drops (CLAUDE.md/AGENTS.md audit). Multi-file exploration stops accumulating in the master prefix (subagent routing).

What pass 2 still doesn't solve and would need future runs:

- **Build-phase compaction.** A `/build` that lasts 200+ turns inside one session still grows its own prefix. Pass 2 mitigates via fresh sessions at the validate boundary, but doesn't address build-mid checkpointing. A future `agent-workbench build --checkpoint` could prompt the model to write `build-progress.md` and recommend a session refresh mid-build.
- **Per-turn cost throttling.** Pass 2 reports per-turn cost but doesn't throttle. Throttling would require either model-side self-summarization or harness-level hard limits — both more invasive than this section's scope.
- **Anthropic-side: auto-compact timing.** Claude Code's auto-compaction isn't aligned to the lifecycle (build → validate boundary). Only Anthropic can change that.

## Source

This idea is TODO §1 ("Token efficiency — pass 2: stop bleeding cache_read") in `docs/TODO.md` of the agentic-development-task-system-v3 repo. The pass-1 predecessor shipped as run `2026-05-22-token-efficiency-tracking` (merge `271ab58`).
