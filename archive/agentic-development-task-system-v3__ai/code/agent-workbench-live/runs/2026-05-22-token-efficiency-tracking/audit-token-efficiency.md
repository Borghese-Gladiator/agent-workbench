# Token/cache efficiency audit

## Executive summary

The token-efficiency-tracking run exists and writes a real `metrics.jsonl`. But the bucket attribution it ships only splits `input_tokens` (the fresh tail of each turn), which on this run totals **2,934 tokens out of 123.4M** — i.e. **0.0024% of cost**. The remaining 99.997% — 121.8M `cache_read` + 1.18M `cache_creation` — is by design left unattributed (`buckets.py:127-135` calls this out explicitly; `cmd_metrics.py:88` literally prints "cache_read not bucketed"). So the user's complaint is structurally correct: the bucket report cannot explain the cache numbers because it was never wired to.

The actual story behind 121.8M `cache_read`: this run accumulated **621 assistant turns** in long-lived Claude Code sessions. Each turn re-reads the full conversation prefix (system prompt + tool defs + CLAUDE.md + AGENTS.md + every prior user message, assistant message, and tool result) from cache. The mean cache_read per turn is **~196k tokens**; the top turns hit **295k**. At Opus 4.7 cache-read prices (~$1.50/M), that's ~$0.30 per turn × 621 = **$186 of cache-read alone**, plus ~$3.50 for cache writes, plus ~$47 for output. The reported total is **$236.73**.

Second-order finding: the slash-command correlator is silently broken on this run. 100% of turns landed in `stage=other, command=""`. The reason is almost certainly the slug-mismatch path between the run's session ID and what `slugify_project_path` derives — turns ARE being captured, they just can't be assigned to `/shape`/`/plan`/`/build`/`/validate`. Without that mapping you can't even attribute cost to a phase, let alone to a context source.

The four highest-leverage changes, in order:

1. **Add cache attribution buckets** (per-turn `cache_read_breakdown`) so the report tells you whether the 121.8M is system prompt, tool defs, or accumulated conversation. Without this, no future optimization decision is informed.
2. **Fix command correlation** so `stage` and `command` aren't always `other`. The fix is small but it's a precondition for any per-phase cost analysis.
3. **Introduce a compact pre-validate context** so the validator doesn't re-read 600 turns of build chatter every time. Today's `/validate` says "Inspect the worktree", which causes the model to read files via tool calls *in the same session that has 100k+ tokens of build history already cached*.
4. **Add a fresh-session policy** — at minimum, recommend the human run `/validate` from a new Claude Code session (or have `validate --init` print a "consider starting a fresh session for review" hint) so the cache prefix is shorter.

## Evidence found

Source-of-truth files inspected, with the relevant numbers:

- `agent-workbench-live/runs/2026-05-22-token-efficiency-tracking/metrics.jsonl` — 621 `turn` rows, computed by running `python3` against the file. Totals: input 2,934 / output 425,478 / cache_read 121,786,040 / cache_creation 1,178,364. Cost $236.73.
- `lib/metrics/buckets.py` (worktree path: `worktrees/.../20260522__token-efficiency-tracking/agentic-development-task-system-v2__ai/agent-workbench-live/lib/metrics/buckets.py`) — `attribute()` operates over `turn.usage["input_tokens"]` only; `cache_read_input_tokens` and `cache_creation_input_tokens` are not bucketed. Lines 127-135 say so in a comment.
- `lib/metrics/transcript.py:201-211` — `_assistant_usage()` reads all four token counts from `message.usage`, so the raw data IS being collected; nothing downstream uses the cache fields except the totals.
- `lib/metrics/transcript.py:283-287` — turns whose `cwd` doesn't match `run_cwd` are stamped `stage="other"`; on this run every turn ended up in `other`, which means either the cwd-match heuristic or the slash-command detector is whiffing on this transcript.
- `lib/cli/cmd_metrics.py:88` — UI literally renders `Context buckets (input tokens only; cache_read not bucketed):`. The system knows the bucket only covers fresh input.
- `lib/cli/cmd_validate.py:396, 440` and `cmd_followups.py:133` — `record_run_metrics` is called when the run leaves `validating`, not before. So the metrics are produced AFTER validation, never before; nothing in this codebase shrinks context BEFORE the validate pass.
- `.claude/commands/validate.md` — instructs the model to (Step 2-3) read `brief.md`, `plan.md`, the diff, and the worktree, then write the review. There is no mechanism that bounds what gets pulled into the validate session's context.
- `templates/review.md` lines 29-54 — instructs the reviewer to run `git diff --name-only`, then `git grep -n <symbol>` per modified symbol, up to depth 3. On a typical worktree this generates substantial tool_results that get cached for the rest of the session.

## Per-call token/cost breakdown

I cannot give a true per-`/shape`/`/plan`/`/build`/`/validate` breakdown for this run because **every turn was labeled `stage=other, command=""`** — the slash-command correlation didn't fire. The metrics.jsonl that exists has:

| Bucket | Tokens | Notes |
|---|---:|---|
| fresh input (sum) | 2,934 | trivially small — model never re-sent the prefix |
| output | 425,478 | model-generated text + tool calls |
| cache_creation | 1,178,364 | first-write of prefix on cache misses |
| cache_read | 121,786,040 | dominant cost driver, see below |
| **total** | **123,392,816** | **$236.73** |

Top 5 cache-heavy turns:

| Turn | input | cache_creation | cache_read | output |
|---|---:|---:|---:|---:|
| #1 | 1 | 564 | 295,443 | 290 |
| #2 | 1 | 564 | 295,443 | 290 |
| #3 | 1 | 1,693 | 293,750 | 273 |
| #4 | 1 | 1,693 | 293,750 | 273 |
| #5 | 1 | 299 | 293,451 | 1,564 |

The pattern is unmistakable: tiny fresh input, tiny output, ~290k re-read prefix. This is the cost of carrying a long session, multiplied by 621 turns.

**What is needed to populate the per-phase table:** fix command correlation (next section) and re-run `metrics --record` against this transcript. After that, the table can be produced from `tokens_by_command` already returned by `summary.py:147`.

## Cache creation attribution gaps

The user's specific request — buckets for system prompt, tool defs, CLAUDE.md/AGENTS.md, imported context, conversation history, assistant history, user messages, tool results, repo files, logs/test output, generated drafts/diffs, validation context, other/unknown — is **not implementable from `cache_read_input_tokens` alone** because the API only reports the aggregate read count, not per-region attribution. But it IS approximable, and the workbench is already doing the right thing for fresh `input_tokens`. The fix is to apply the *same heuristic* to the cache prefix.

Concrete proposal — extend `lib/metrics/buckets.py` to:

1. Track the **cumulative cached prefix** per session by walking the transcript in time order. At each assistant turn, the prefix is "everything before this turn in the session." For each prefix region, count chars with the existing 4-chars/token heuristic. Map regions to buckets the same way the user-text classifier does today.
2. Attribute `cache_read_input_tokens` to the prefix's bucket distribution. Attribute the *delta* (`new_prefix - old_prefix`) to `cache_creation` for that turn.
3. Add buckets the current schema is missing:
   - `system_prompt`: detected from the first `type=summary` / `type=system` records (or, lacking those, the first assistant turn's `tool_definitions` reflection — see `~/.claude/projects/<slug>/<sid>.jsonl` line 1).
   - `tool_defs`: estimated from the count of tools listed in the first assistant turn × ~150 tokens/tool (conservative); refine by parsing the transcript's tool definitions if present.
   - `tool_results`: already tracked via `turn.raw_tool_results`; sum these across the prefix.
   - `assistant_history`: text of prior assistant turns (read from the same transcript walk).
   - `repo_files` (new): tool_result bodies whose content matches `Read` outputs (heuristic: leading line-number gutter like `^\s*\d+\t`).
   - `validation_context` (new): tool_result bodies produced after `_extract_command` returned `/validate` for the current span.
   - `generated_drafts` (new): assistant-turn message bodies that contain large markdown blocks (`# `, `## `) — a proxy for `review.md`/`build.md` drafts.

Buckets that should remain unchanged: `claude_md_and_agents_md`, `context_imports`, `slash_command_body`, `user_messages`, `other`.

What you genuinely cannot attribute (be explicit): the *exact* portion of the cached prefix that is the Anthropic-side system prompt vs. tool defs. The transcript doesn't carry those bytes. The heuristic above gives a defensible estimate, not ground truth. The current code already accepts this tradeoff for `other`; the proposal extends the same honesty.

The current `summary.py` exposes `total_cache_read` and `total_cache_creation` but does NOT expose the proposed per-bucket cache breakdown. Add two fields: `cache_read_by_bucket: dict[str, int]`, `cache_creation_by_bucket: dict[str, int]`. Render them in `cmd_metrics.py:88` next to the existing input-bucket display.

## Largest persistent context items

Inferred from the transcript pattern (621 turns, mean ~196k cache_read, growing prefix):

1. **The session's own assistant history.** 425k output tokens means the assistant emitted ~425k tokens of text/tool-call JSON over the run. Every later turn re-reads this. Largest contributor on long runs.
2. **Tool results — specifically Read-tool output and git output.** The build phase reads source files (typical 200-500 lines × 4 chars/token ≈ 1k-2k tokens each); the validate phase runs `git diff` / `git grep` (templates/review.md:32-37). These persist in the session until summarization (which Claude Code does at high context fill, not aligned to lifecycle).
3. **User slash-command bodies.** `<command-name>/validate</command-args>` plus the full body of `.claude/commands/validate.md` (111 lines) gets pasted each invocation.
4. **CLAUDE.md + AGENTS.md.** Both load every turn that's outside a compacted summary. `agent-workbench-live/AGENTS.md` (113 lines) + repo-root `AGENTS.md` (69 lines) + global `~/.claude/CLAUDE.md` (~200 lines per the message header). ~5-10k tokens of prefix that never changes within a session.
5. **The plan.md + brief.md + build.md the model loaded earlier in the run.** Once read, they stay in the cached prefix until compaction.

Recommendations:

- **Compact build.md / plan.md before validate.** Concretely: validate.md should instruct the model to read a `validate-context.md` (new template) rather than re-reading brief.md, plan.md, build.md fully. The new file is produced by `validate --init` and contains: brief's acceptance criteria, plan's decisions/assumptions, build.md's `## What changed` + `## Files changed` + `## Acceptance criteria coverage`. Drops the wholesale-doc load.
- **Externalize git command output to files.** Today's review template instructs `git diff --name-only`, `git grep -n <symbol>`. Have `validate --init` pre-compute these into `runs/<id>/stages/5_validating/blast-radius.txt` so the model reads one file instead of running N grep tool calls whose outputs accumulate.
- **Bound `qa/commands.txt` output capture.** Slash commands tell QA to "put outputs/screenshots in `qa/artifacts/`" — make sure the model is reading those as references (paths in a manifest), not pasting them into the chat.

## Validation context issues

Re-read of `.claude/commands/validate.md` and `lib/cli/cmd_validate.py` confirms: **validators today consume the full chat session, not the final diff + relevant files.** There is no compaction step, no scoped context window, no "restart for review" hint. The validate steps explicitly tell the model to load brief/plan/diff/worktree.

This is the largest single contributor to cache_read inflation on long runs: the validate phase fires AFTER building, in the same session, with the entire build history cached and re-billed on every tool call the validator makes.

Tradeoff to acknowledge: the validator does need real correctness context. Specifically it needs:
- The brief's acceptance criteria (short).
- The plan's decisions + assumptions (short).
- The final diff (variable; on a typical run, 100-500 lines = 1-3k tokens).
- The build's claimed test mapping (short).
- The actual changed files' current contents (this is the only large item).
- Nearby unchanged code for review (situational — should be a model decision, not a default load).

What it does NOT need: every prior tool call the builder made, every assistant turn from `/shape`/`/plan`/`/build`, every intermediate Read of unrelated files.

## Recommended changes

| Priority | Change | Expected savings | Risk | Files/functions |
|---|---|---|---|---|
| P0 | Add cache-prefix bucket attribution (`cache_read_by_bucket`, `cache_creation_by_bucket`) computed by walking the transcript prefix per turn. | 0% direct savings, but unlocks all downstream optimization. Without it the user is blind. | Low. Pure additive — extends `buckets.py:attribute()` signature; existing fresh-input buckets unchanged. | `lib/metrics/buckets.py` (extend `attribute()` to accept session-prefix state); `lib/metrics/transcript.py:correlate()` (carry prefix state across turns); `lib/metrics/summary.py:RunMetricsSummary` (add two dict fields); `lib/cli/cmd_metrics.py:_render_summary_plain` (render the new buckets). |
| P0 | Fix slash-command correlation so `stage`/`command` aren't always `other`. Current bug: 100% of 621 turns landed in `other` on the production-est run. | 0% direct savings, but precondition for per-phase analysis. | Low. Diagnose first, then small targeted fix. | `lib/metrics/transcript.py:_cwd_matches()` (likely the resolved-path comparison vs. worktree symlink); `lib/metrics/transcript.py:correlate()` (validate the `current_command` propagation across record types). |
| P0 | Add a "compact validate context" template and pre-stage it during `validate --init`. | 30-60% of validate-phase tokens. Validate today re-reads build/brief/plan; with a compact, validate reads ~one file. | Medium. Need to make sure no correctness context is dropped. Tradeoff: validator may need to read individual files; that's fine, the file list is short in the compact summary. | `agent-workbench-live/templates/validate-context.md` (new); `lib/cli/cmd_validate.py` `_init` path (build the file from brief.md+plan.md+build.md when `--init` runs); `.claude/commands/validate.md` (update Step 2-3 to read this file instead). |
| P0 | Recommend (and document) a fresh Claude Code session for `/validate`. | Up to 80% of cache_read on long runs that did /build in the same session. | Low. Reversible — just guidance + a CLI hint. | `.claude/commands/validate.md` (preamble); `lib/cli/cmd_validate.py:_init` output (one-line "consider starting a new session" hint when transcript has > N turns). |
| P1 | Pre-compute git blast-radius into a file at `validate --init`, instead of having the model run tool calls during validate. | 5-20% of validate phase. Trades model tool calls for fixed-size file content. | Low. CLI is already running git commands in `_check_scope_creep_staged`; just extend. | `lib/cli/cmd_validate.py` (extend the `--init` path); `templates/review.md` (instruct reading the precomputed file). |
| P1 | Add a "session staleness" warning in `record_run_metrics` and the board: if a single session accumulates > 100 turns, surface it. | 0% direct; behavioral nudge. | Low. | `lib/metrics/summary.py` (add `turns_in_largest_session` field); `lib/board/snapshot.py` (display). |
| P2 | Cache `qa/report.md` outputs by reference, not value. The template + slash command already point the model at `qa/artifacts/` — verify nothing in the audit renderer expands those into chat context. | 5-15% depending on QA verbosity. | Low. | `lib/audit.py`; check what `render audit` actually inlines. |
| P2 | When `tokens_per_passing_build` is reported, also show `cache_read_share` and `cache_efficiency` (cache_read / (cache_read + cache_creation)). | 0% direct; helps detect cache-eviction issues. | Low. | `lib/metrics/summary.py`; `lib/cli/cmd_metrics.py`. |
| P3 | Tool-defs estimation column in the new cache-bucket table. Approximate by counting unique tool names in `<functions>` blocks, multiply by 150 tokens. | 0% direct; transparency. | Low. | `lib/metrics/buckets.py`. |

## Proposed compaction strategy

A `validate-context.md` template, staged by `validate --init`, with this exact shape:

```markdown
# Validate context — <run_id>

<!-- Auto-generated by `agent-workbench validate <id> --init`. Read THIS,
     not brief.md / plan.md / build.md separately, unless this file points
     you to a specific section. -->

## Original task
<!-- brief.md § Original request, verbatim if ≤ 20 lines, else truncate -->

## Acceptance criteria
<!-- brief.md § Acceptance criteria, full -->

## Plan decisions and assumptions (only the load-bearing ones)
<!-- plan.md § Decisions, plan.md § Assumptions, filtered for ASM-/DR- IDs
     referenced in build.md -->

## Final diff
<!-- `git diff --stat <base_ref>...HEAD` followed by `git diff
     <base_ref>...HEAD` capped at 500 lines; if longer, list filenames + per-file
     line counts only -->

## Files changed (full list)
<!-- `git diff --name-status <base_ref>...HEAD` -->

## Commands run by the builder
<!-- build.md § Commands run -->

## Test results
<!-- build.md § Acceptance criteria coverage table + qa/report.md § Summary -->

## Known issues / risks declared by the builder
<!-- build.md § Known issues, build.md § Deviations from plan -->

## What to read in the worktree (no other reads needed)
<!-- Ordered file list from build.md § Reviewer reading order -->
```

What it explicitly excludes:
- Full conversation history of the build session.
- Full prior tool_result outputs.
- The shape brief's exploratory sections (kept-but-not-final).
- Obsolete plans / abandoned drafts in `archive/`.
- Anything in `runs/<id>/` not listed above.

If `validate --init` runs this aggregation in Python (no LLM call), it's free and deterministic. The model then reads ONE file at the start of validate instead of four-to-six.

## Validator input contract

Required:
- `validate-context.md` (built by `--init`)
- The current contents of files listed in build.md's "Reviewer reading order" (model reads them via Read tool, one at a time, as needed).
- `runs/<id>/stages/5_validating/review.md` (the template the model is going to fill).
- `runs/<id>/stages/5_validating/qa/report.md` (the template for QA output).

Optional, only on demand:
- `runs/<id>/blast-radius.txt` (pre-computed git callers, if `--init` produced it).

Forbidden / strongly-discouraged:
- The full `events.jsonl`, except via the audit renderer (which already summarizes).
- Wholesale reads of `archive/` contents.
- Re-reading brief.md, plan.md, build.md (they're already folded into validate-context.md).
- Tool_result outputs from earlier sessions (Claude Code's transcript leakage from prior sessions can sneak in via cwd-match — verify `_cwd_matches` doesn't pull in old session prefixes from the same project slug).

Correctness tradeoff: if the validator needs context that ISN'T in `validate-context.md`, it should Read the file from the worktree, not be handed it eagerly. This is a Read tool call (small fresh input + small fresh output for that file's contents), not a pre-loaded chunk that lives in the cached prefix for the entire session.

## Fresh-session policy

Recommended rules, in priority order:

1. **Start a new Claude Code session at the `/validate` boundary.** The build session's cached prefix has zero correctness value to validate, but full cost. The handoff is the new `validate-context.md` file — that's all validate needs to bootstrap.
2. **Start a new session after `/complete` and before any follow-up work.** Independent issues should not share session prefix.
3. **Start a new session when transcript turns in the current session > 100** (a soft threshold; pick after measuring). Surface this as a hint in `validate --init` output and the board snapshot.
4. **Start a new session before unrelated debugging excursions.** If the user opens a `/board` to inspect, they don't need build-session context.
5. **Stay in the same session for `/shape` → `/plan` → `/build`** (these share planning + build context productively; the user already pays the cache prefix once and it's amortized over many short turns).

Handoff template for new sessions (one-shot, copy-pasteable in the CLI's `validate --init` output):

```
This run is ready for validation in a fresh Claude Code session.

  run_id:    2026-05-22-token-efficiency-tracking
  worktree:  /Users/.../worktrees/.../20260522__token-efficiency-tracking
  branch:    agent/token-efficiency-tracking

To start a fresh session for /validate, exit and re-launch claude in:
  cd <worktree>
  claude

Then run:
  /validate 2026-05-22-token-efficiency-tracking

The validate command will load runs/<id>/stages/5_validating/validate-context.md
as its sole entry point — everything else is read on demand.
```

## Implemented changes or patch plan

I have not modified the worktree branch (`agent/token-efficiency-tracking`) because the workbench's two-rule discipline (AGENTS.md §"Two hard rules") says only the lifecycle CLI advances state, and this audit is the kind of cross-cutting change that should land as its own run, not a sidecar edit to the existing one. I also haven't switched branches, per the global `feedback_branch_switching.md` memory.

What I propose as the next run (`/new-run` → "token efficiency, pass 2: bucket the cache"):

**File-by-file patch plan**, with the exact edit points:

1. **`lib/metrics/transcript.py:CorrelatedTurn` (dataclass)** — add two fields:
   ```python
   prefix_user_messages: tuple[str, ...]  # all prior user-text in this session prefix
   prefix_assistant_messages: tuple[str, ...]  # all prior assistant-text in this session prefix
   prefix_tool_results: tuple[str, ...]  # all prior tool_result bodies in this session prefix
   ```
   And in `correlate()` (lines 219-309), accumulate these BUT do not clear them per turn (current code clears `pending_*` on line 307-308 — keep those as the per-turn buffers; add separate `prefix_*` lists that grow monotonically).

2. **`lib/metrics/buckets.py:attribute()`** — change signature to `attribute(turn) -> tuple[dict[str, int], dict[str, int], dict[str, int]]`. Return three dicts: `input_buckets` (existing behavior), `cache_read_buckets`, `cache_creation_buckets`. The latter two:
   - Compute per-region char counts using `turn.prefix_*` plus a system-prompt + tool-defs estimate (constants documented at top of file).
   - Scale to `turn.usage["cache_read_input_tokens"]` and `turn.usage["cache_creation_input_tokens"]` respectively, using the existing `est_total` → scale → `other` residual pattern.

3. **`lib/metrics/writer.py:record_run_metrics()` lines 177-199** — update the `turn` row to include `cache_read_attribution` and `cache_creation_attribution` keys next to the existing `bucket_attribution`.

4. **`lib/metrics/summary.py:RunMetricsSummary`** — add `cache_read_by_bucket: dict[str, int]` and `cache_creation_by_bucket: dict[str, int]`. Aggregate via `buckets_mod.merge` over the new per-turn dicts.

5. **`lib/cli/cmd_metrics.py:_render_summary_plain` lines 88-90** — replace the "input tokens only" disclaimer with three sub-sections: `input buckets`, `cache_read buckets`, `cache_creation buckets`.

6. **`lib/metrics/transcript.py:_cwd_matches` + `_extract_command`** — debug the "100% turns landed in `other`" issue first. Suspect cause: the worktree path's resolved form differs from `meta.target.worktree.path` because of symlinks in `/Users/...`, OR the slug-match in `_project_slugs_for_run` is hitting the WRONG transcript file (worktree slug vs. repo slug). Add unit test against the production metrics.jsonl's `transcript_ref.session_id` to lock the regression.

7. **`agent-workbench-live/templates/validate-context.md`** (new file) — content as shown in "Proposed compaction strategy" above.

8. **`lib/cli/cmd_validate.py:_init`** (the init path that stages templates) — after staging `review.md` / `qa/report.md` / `HUMAN_REVIEW.md`, also generate `validate-context.md` by reading brief.md + plan.md + build.md and running `git diff --stat <base_ref>...HEAD`. All Python, no LLM.

9. **`.claude/commands/validate.md`** Step 2 — replace "Read brief.md, plan.md, and the diff" with "Read `runs/<id>/stages/5_validating/validate-context.md`. That file is the curated entry point; only read brief/plan/build directly if it points you to a specific section."

10. **`lib/cli/cmd_validate.py:_init` print statement** — when a transcript with > 100 turns is detected in the run's session, print the fresh-session hint at the top of the output.

I'd write this as one well-scoped run rather than a single drive-by commit, because (per AGENTS.md) infrastructure changes must update `docs/TODO.md` + `docs/LOG.md` and ship with tests — the existing `tests/test_metrics_*.py` need extension to cover cache-bucket attribution, and the synthetic transcript fixtures need new prefix-bearing records.

## Open questions

1. **Is the user's "1.2M cache_creation, 81M cache_read" figure from THIS run, or from an earlier one?** This run shows 1.18M cache_creation (matches) but **121.8M cache_read**, not 81M. Either the run grew since the user last looked (likely — events show two validation passes), OR they're looking at a different run / a board aggregate.
2. **Slug derivation:** `slugify_project_path()` uses `/` → `-`, `_` → `-`, `.` → `-`. The current project slug in `~/.claude/projects/` is `-Users-timothy-shee-GitHub-LOCAL-worktrees-202605-agent-workbench-v2-agentic-development-task-system-v2--ai`. Confirm whether double-dash (`--ai`) comes from the trailing `__ai` (double underscore). If so, an extra `_` → `-` replacement is missing and the slug computation should be checked. (Looks correct to me on second pass — but verify, because if the slug is wrong by even one character, the writer pulls zero transcripts.)
3. **Cache TTL behavior:** Anthropic's prompt-cache has a 5-min TTL. Long pauses between turns cause cache_creation (a re-write of the same prefix). The 1.18M cache_creation on this run hints at a handful of cache misses (which is expected for a multi-hour run with breaks). Worth surfacing in the report as a "cache misses: N" line, computed as count of turns where cache_creation > 1000.
4. **Subagents:** `AGENTS.md:92-98` says subagents are session-internal. Are subagent turns showing up in the transcript? If yes, do they share the parent session prefix or get their own (often shorter) one? This matters for the validate strategy — `Explore` subagents in particular could be a cheap way to keep validate prefix tiny.
5. **`turns_per_passing_build`:** the existing metric divides total_tokens by approves. With cache_read at 99% of total_tokens, this metric is mostly tracking "how big was the cached prefix" not "how efficient was the agent." Consider switching to `(input + output + cache_creation) / approves` — i.e., excluding cache_read — as the "billable-net-of-cache" measure.
