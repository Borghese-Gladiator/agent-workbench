# Brief

## Goal

Pass-2 of token-efficiency work for the Agent Workbench. Pass-1 shipped per-run metrics, but bucketed only `input_tokens` — which on the pass-1 dogfood run was **0.003% of total cost**. The remaining 98.7% landed in `cache_read` and was unattributed; the renderer literally printed "cache_read not bucketed". On top of that, the slash-command correlator silently broke (100% of 621 turns landed in `stage=other, command=""`), so there isn't even a per-phase split.

Pass-2 does two things:

1. **Attribution** — bucket `cache_read` and `cache_creation`, fix the correlator, expand the per-run summary so the question "where did the cache_read go?" has an answer.
2. **Mitigation** — reduce the cache_read bleed by structural changes: fresh sessions at the validate boundary, a deterministically-built `validate-context.md`, pre-computed blast-radius, subagent-first reads in `/build` and `/validate`, and a measured shrink of always-loaded instruction files.

Target: ≥ 40% reduction in `cache_read` on an equivalent-workload E2E fixture vs. the pass-1 baseline (~123.4M → ≤ 74M).

## User-facing behavior

The "user" here is the agent operator (the human driving runs) and the agent itself.

**For the operator:**

- `agent-workbench metrics <run-id>` prints three bucket sub-sections — `input buckets`, `cache_read buckets`, `cache_creation buckets` — that sum (within ±2%) to the run's totals. The "cache_read not bucketed" disclaimer is gone.
- The per-run summary adds `cache misses: N`, `largest session: <id> (<N> turns)`, and `billable_net_per_passing_build` alongside the existing `tokens_per_passing_build`.
- `agent-workbench board` appends a `turns: N` indicator on the metrics band when any session in the run has > 100 turns. Read-only nudge; no loud-card behavior.
- `agent-workbench validate <id> --init` produces `stages/5_validating/validate-context.md` and `stages/5_validating/blast-radius.txt` before any LLM call. When `largest_session_turns > 100`, `--init` prints a copy-pasteable fresh-session handoff block (run_id, worktree, branch, exit-and-restart steps).

**For the agent:**

- `.claude/commands/validate.md` instructs reading `validate-context.md` instead of brief/plan/build separately.
- `agent-workbench-live/AGENTS.md` gets a `## Session discipline` section (fresh-session-at-validate, new-session-between-runs, stay-in-session for shape→plan→build, restart-on-auto-compact, plus the rationale).
- `agent-workbench-live/AGENTS.md` § "Subagent discipline" requires routing multi-file exploratory reads (>3 files, non-edit) through an `Explore` subagent in `/build` and `/validate`.
- `agent-workbench-live/AGENTS.md` carries a tool-output budget guidance section (`head`/`tail`/grep for >2k-token reads, `git log -n 20`, `git diff --stat` first).

## Acceptance criteria

1. `agent-workbench metrics <run-id>` prints `cache_read buckets` and `cache_creation buckets` that sum (within ±2%) to the run's `total_cache_read` / `total_cache_creation`.
2. Re-running `agent-workbench metrics 2026-05-22-token-efficiency-tracking --record` on the pass-1 dogfood run produces a per-turn `stage` distribution that is no longer 100% `other` (> 50% non-`other`).
3. `agent-workbench validate <id> --init` on a fresh run produces `stages/5_validating/validate-context.md` and `stages/5_validating/blast-radius.txt` before any LLM call.
4. `.claude/commands/validate.md` instructs reading `validate-context.md` instead of brief/plan/build separately.
5. `agent-workbench-live/AGENTS.md` has a `## Session discipline` section that names the fresh-session-at-validate rule, the new-session-between-runs rule, and the why.
6. `validate --init` prints the full fresh-session handoff block (not just a one-line hint) when `largest_session_turns > 100`.
7. `~/.claude/CLAUDE.md` + repo `AGENTS.md` files have measurably-shrunk always-loaded weight (before/after counts in the LOG.md entry).
8. `agent-workbench-live/AGENTS.md` § "Subagent discipline" prescribes `Explore` subagents for multi-file reads in `/build` and `/validate`.
9. On a `happy/` E2E fixture run, total `cache_read` is ≥ 40% lower than the pass-1 dogfood baseline.
10. `metrics.jsonl` schema_version bumps to 2 with new `cache_read_attribution` / `cache_creation_attribution` keys per turn; summary reader tolerates both v1 and v2 rows.

## Non-goals

- Enforcing `cache_read` budgets — no hard limits, no warnings that block transitions.
- Auto-restarting Claude Code — no harness automation that exits the user's session.
- Rewriting `lib/metrics/transcript.py` correlator from scratch — it's load-bearing for pass 1; patch, don't rewrite.
- Cross-session de-duplication of cached prefix — Anthropic's cache layer is what it is; we work around it via session discipline.
- Supporting non-Claude-Code LLMs.
- Build-phase mid-session checkpointing (deferred to a future run; pass 2 mitigates via fresh sessions at the validate boundary only).
- Per-turn cost throttling.
- Changing Claude Code's auto-compaction timing (Anthropic-side only).

## Good examples

- A `cache_read buckets` block in `agent-workbench metrics <id>` that names: `system_prompt`, `tool_defs`, `claude_md_and_agents_md`, `context_imports`, `slash_command_body`, `user_messages`, `assistant_history`, `tool_results`, `repo_files`, `validation_context`, `generated_drafts`, `other` — each with a token count and the residual landing in `other`.
- A `validate-context.md` whose sections cover: original task, acceptance criteria, plan decisions + assumptions (filtered to ASM-/DR- IDs referenced in build.md), `git diff --stat`, full `git diff` capped at 500 lines (filenames + per-file counts otherwise), files changed, commands run, test results, known issues / risks, reviewer reading order.
- A `## Session discipline` section in `AGENTS.md` whose rules are imperatives with a one-paragraph rationale anchored on the prefix-grows-monotonically mechanic.
- A fresh-session handoff block printed at `validate --init` that the operator can copy-paste verbatim to exit Claude Code, `cd`, relaunch, and `/validate <id>`.

## Bad examples

- A bucketer that confidently mis-attributes — pass 2 explicitly prefers under-attribution-into-`other` over confident mis-attribution.
- A `validate-context.md` that's a free-form LLM summary rather than a deterministically-built artifact.
- A `## Session discipline` section without the "why" (discipline doesn't stick).
- A fresh-session handoff that's a one-line hint rather than a copy-pasteable block.
- A subagent-discipline rule with no concrete examples in `.claude/commands/build.md` / `.claude/commands/validate.md`.
- A schema-version bump that breaks the v1 summary reader.
- Mutating existing v1 `metrics.jsonl` rows in place. Schema changes are additive; v1 readers see v1 rows.

## Constraints

- **Pass-1 bucketer is load-bearing.** Patch `lib/metrics/buckets.py:attribute()` and `lib/metrics/transcript.py:correlate()`. Don't rewrite.
- **Heuristic-and-residual-into-`other` pattern.** Cache buckets use the same approach as input buckets: walk the transcript prefix per turn, accumulate text by region monotonically, scale to API counts, residual into `other`.
- **Schema-additive only.** New keys (`cache_read_attribution`, `cache_creation_attribution`, `cache_read_by_bucket`, `cache_creation_by_bucket`, `cache_misses`, `billable_net_per_passing_build`, `largest_session_turns`, `largest_session_id`) are added alongside existing ones. The summary reader tolerates both schema_version=1 and =2 rows.
- **No LLM call in `validate --init`.** `validate-context.md` and `blast-radius.txt` are pure-Python deterministic builds from existing artifacts + git.
- **Session-staleness threshold configurable.** `agent-workbench.yaml` gets `session_staleness_threshold_turns: 100` as the default; `validate --init`'s handoff block uses that.
- **The `Session discipline` and `Subagent discipline` text in `AGENTS.md` is normative for agents.** Phrase rules as imperatives ("Always start a new session at the `/validate` boundary when > 100 turns") with a `## Why` paragraph.
- **Tests pin both attribution math and stage distribution.** Cache-bucket attribution within ±2%; correlator regression test against the pass-1 dogfood transcript asserts > 50% non-`other` stage.

## Assumptions

- **ASM-1.** The agent driving this run has a Python 3.10+ available for `agent-workbench` invocations and the existing test suite still runs locally without environment changes.
- **ASM-2.** The pass-1 dogfood run's transcript file (the JSONL the correlator consumes) is still on disk under its original session_id and accessible via `find_transcripts`. The C2 regression test depends on this.
- **ASM-3.** `cache_read_input_tokens` and `cache_creation_input_tokens` in Claude Code's per-turn API records can be summed across turns to reach the totals seen in `metrics.jsonl`. The pass-1 dogfood numbers (121,786,040 cache_read; 1,178,364 cache_creation) confirm this.
- **ASM-4.** The 4-chars/token heuristic in `lib/metrics/buckets.py` is good enough for cache-bucket scaling. Pass 2 keeps it; per-bucket calibration is out of scope.
- **ASM-5.** The pass-1 `metrics.jsonl` schema (one row per turn) is what `lib/metrics/writer.py:177-199` writes today. Pass 2 bumps to schema_version=2 only by adding keys.
- **ASM-6.** `.claude/commands/validate.md`, `.claude/commands/build.md`, and `templates/review.md` live in the worktree (not in `~/.claude`) so an edit-in-PR is sufficient. They are repo-tracked.
- **ASM-7.** `~/.claude/CLAUDE.md` is the user's private global config and edits to it are in scope for B6 (the operator authored this work; we can edit their personal config with the same care any PR review would apply). Before/after token counts are measurable via `wc -c` or the pass-1 buckets re-run on a fixed transcript.
- **ASM-8.** The board snapshot's metrics band (per pass-1) is the right surface for the `turns: N` indicator — no separate UI change beyond appending one element.
- **ASM-9.** "Subagent" in `AGENTS.md` refers to the Claude Code `Agent` tool with `subagent_type=Explore` specifically; no new runtime is introduced.
- **ASM-10.** The 40% E2E reduction target assumes the `happy/` fixture is roughly comparable in workload to the pass-1 dogfood run. The acceptance check is "≥ 40% drop" measured on that fixture; if the fixture is much smaller, we'll dogfood pass 2 itself and use that as the comparison artifact too.

## Suggested QA scenarios

1. **Cache-bucket attribution math.** Construct a synthetic transcript with a 100k-token prefix that includes all bucket types in known proportions. Run the bucketer; assert each `cache_read_by_bucket[name]` is within ±2% of the expected count. Negative case: a transcript with no slash-command body — verify `slash_command_body` is 0, residual lands in `other`.

2. **Correlator regression.** Load the pass-1 dogfood run's transcript via `find_transcripts`. Run the correlator. Assert: > 50% of turns have non-`other` `stage`; at least one turn per slash-command (`shape`, `plan`, `build`, `validate`, `followups`) is detected; the suspected-broken `_cwd_matches()` path is exercised by the test fixture.

3. **`validate --init` produces deterministic outputs.** Drive `happy/` and `bounce_pass2/` E2E fixtures through `validate --init`. Snapshot `stages/5_validating/validate-context.md` and `stages/5_validating/blast-radius.txt`. Re-run; snapshots must match byte-for-byte.

4. **CLI smoke.** `agent-workbench metrics <id>` output for a pass-1 run includes: `input buckets:` header, `cache_read buckets:` header, `cache_creation buckets:` header, `cache misses: N`, `largest session: <id> (<N> turns)`, `billable_net_per_passing_build: <float>`.

5. **Fresh-session handoff block.** Construct a metadata file whose recorded `largest_session_turns` is > 100. Run `validate --init`. Assert stdout includes the four lines of the handoff block (`run_id:`, `worktree:`, `branch:`, the four-step copy-paste). Negative: when `largest_session_turns ≤ 100`, no handoff block is printed.

6. **Schema-version tolerance.** Mix v1 and v2 rows in a `metrics.jsonl`. Run `agent-workbench metrics <id> --rebuild`. Assert no error; v1 rows show empty bucket dicts; v2 rows show populated dicts.

7. **AGENTS.md normative-language audit.** Grep `agent-workbench-live/AGENTS.md` for the literal strings `## Session discipline`, `## Subagent discipline`, and the four session rules. All must be present.

8. **CLAUDE.md / AGENTS.md weight shrink.** Measure character count and token count (via pass-1 bucketer on a fixed sample) of `~/.claude/CLAUDE.md`, repo-root `AGENTS.md`, and `agent-workbench-live/AGENTS.md` before and after B6. Assert combined drop ≥ 30%.

9. **E2E cache_read reduction.** Run `happy/` E2E fixture before and after Part B lands. Compare `total_cache_read`. Assert ≥ 40% reduction. Record both numbers in LOG.md.

10. **Backward-compat of `metrics --rebuild`.** Run `agent-workbench metrics 2026-05-22-token-efficiency-tracking --rebuild` on the dogfood run. Assert no error, `cache_read_by_bucket` non-empty, residual `other` < 50% of total `cache_read` (i.e., we're attributing the majority).
