# TASK-46 — Token-cost measurement

Per-phase / per-slice token instrumentation of real (`AWB_AGENT_RUNTIME=claude`)
runs, the ranked reducible costs, and the one lever the numbers point to.

Reproduce with `scripts/measure-token-cost.mjs [path-to-workbench.sqlite]` (reads
`model_invocations` + `context_composition`; read-only).

## What was measured

Four real claude runs against `wip-browser-games`:
- **3 historical runs** captured in the shared `~/.agentic-workbench` DB (task ids
  `2d711d1f`, `ed33645f`, `f47a0d8e` — a game-count README edit, the President card
  game, and a one-line note).
- **1 fresh run** (this task) in an isolated DB, driven end-to-end plan→release, the
  first run with the cache-**write** column populated (see "The fix" below).

Token data lives in SQLite `model_invocations` (one row per agent session = per
builder slice), rolled up by `getTokenBreakdown()`. The 8-bucket
`context_composition` estimate (`chars/4` of our assembled `contextPayload`) is the
"% preamble" signal.

## Headline numbers

3 historical runs, aggregated by phase:

| phase | sessions | fresh input | cached-read | output | cost | cached:fresh |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| implement | 3 | 196 | 4,478,118 | 41,716 | $5.01 | 22,848× |
| challenge | 3 | 175 | 2,926,876 | 23,929 | $3.31 | 16,725× |
| plan | 6 | 101 | 871,601 | 16,971 | $2.67 | 8,630× |
| **total** | | **472** | **8,276,595** | **82,616** | **$10.98** | |

Fresh run (cache-write now visible), single trivial README edit:

| phase | sessions | fresh input | cached-read | cached-write | output | cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| plan | 2 | 23 | 245,954 | 55,195 | 3,881 | $0.77 |
| implement | 1 | 24 | 315,247 | 32,580 | 2,783 | $0.55 |
| challenge | 1 | 26 | 392,757 | 26,182 | 3,431 | $0.54 |
| **total** | | **73** | **953,958** | **113,957** | **10,095** | **$1.87** |

## The finding: it is NOT the re-sent preamble

The symptom ("burns a TON of `cached_tokens`") is real and confirmed:
**cached-read tokens outnumber fresh input by ~8,000–23,000×**, and cached-read is
the cost base (8.3M tokens across 3 trivial tasks).

But the TASK-46 fork — *is this repeated **preamble** (history replay) or bloated
**tool output**?* — resolves clearly to **neither preamble specifically**. The
decisive comparison, per phase:

- **Our assembled preamble is tiny.** The `context_composition` estimate for the
  builder is **206–1,306 tokens** (the serialized `{slice}` we inject on the first
  turn). Yet that session's cached-read is **300K–2.2M tokens**. The preamble is
  **~0.03–0.1%** of what the model re-reads.
- **The cost is accumulated *in-session* context.** Each session runs dozens of
  turns (implement: 46–149 semantic events per session), and every turn re-reads the
  entire accumulated prefix from cache: the system prompt + tool definitions + the
  growing transcript + **all prior tool outputs and file reads**. That prefix — not
  our injected `contextPayload` — is the 300K–2M cached-read tokens.

So the Karpathy "subgraph retrieval vs. replay history" lever (TASK-47) attacks the
*wrong layer* for this cost: our cross-run preamble is already negligible, and the
SDK already prompt-caches it. The tokens are the agent's own within-session working
context.

## Ranked reducible costs

1. **In-session accumulated context (dominant).** Cached-read is ~99.9% of input
   tokens and the bulk of cost. Levers, in order:
   - **Compress tool-result output before it re-enters context** (the RTK/Caveman
     *technique*, applied inside `packages/execution` — NOT the personal CLI, whose
     shell hook never intercepts SDK-driven agents). A 400-line `npm test`/`git`
     dump fed back verbatim is re-cached on every subsequent turn, so trimming it
     compounds across the session. This is the single highest-leverage change.
   - **Fewer turns per session.** Turn count drives how many times the prefix is
     re-read. Tighter per-slice instructions / stop conditions reduce it.
2. **Output tokens (second).** 82K output at ~$75/Mtok is a meaningful slice of the
   $10.98. Less reducible (it is the actual work), but verbose agent narration adds
   to it.
3. **Cross-run preamble (negligible).** Do **not** spend a caching/subgraph-retrieval
   project on this — the measurement shows it is not the cost. (TASK-47's ADR reaches
   the same conclusion independently and de-scopes the cost claim from the graph
   spike.)

## The fix shipped with this measurement

The SDK reports `cacheCreationInputTokens` (cache-**write**) per invocation, but the
adapter **dropped** it (`toDomainUsage`, `claude-adapter.ts`), so "cached" meant
cache-read only and total cached cost was undercounted. This task wires it end to
end: `ModelUsage` + `model_invocations` (migration `0004_cache_creation_tokens`) +
`toDomainUsage` + `getTokenBreakdown`. The fresh run above is the live proof — 114K
cache-write tokens that were previously invisible. (Unit tests:
`claude-adapter.test.ts`, `observability.test.ts`.)

## Recommended next task (spun out)

**Compress tool-result output at the execution layer** (`packages/execution`):
truncate/summarize large command outputs (test runs, `git`, file dumps) before they
re-enter the agent's context, off by default for MOCK, on for the real path. This is
the lever the numbers point to; it is distinct from — and does not need — the graph
plane or preamble caching. Measure the cached-read delta on a re-driven task to
confirm.

`UsageAggregator` (`packages/agent-gateway`) is dead code (no production caller); the
live path is `ObservabilityAccumulator` → `model_invocations`. Removing or wiring it
is a separate cleanup, noted here so the next reader is not misled.
