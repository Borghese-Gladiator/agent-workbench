# Spec — the 6 new per-stage profiling metrics

Goal: add the 6 profiling metrics not captured today, **derived from the
`AgentRunEvent` stream we already persist** (no adapter changes for v1, except
where explicitly flagged). These metrics are also the instrument that will
validate the "plan exhaustively, execute mechanically" fix (see
`profiling-audit-findings.md`): they must be able to express the regression we
saw ("implementation: 19 turns, repo surveyed 2×, N redundant re-reads").

## What the event stream gives us (verified against run `arun_UPW0KQA2Z5`)

Each `AgentRun` has an ordered list of `AgentRunEvent`s; each event has `seq`
(monotonic) and `createdAt` (ISO ms). Payloads by type:

| Event | Payload keys | Notes |
|---|---|---|
| `assistant_text` | `text` | model thinking / narration |
| `tool_call` | `name`, `input` | `input` is the tool args object |
| `tool_result` | `status` (`ok`\|`error`), `summary` | **summary is truncated**, not the full body |
| `cost` | token + cost fields, `numTurns` | one per run (the 5 existing metrics) |
| `result` | `subtype`, `isError`, `denials[]` | `denials` = tool names that were permission-denied |

**Critical limitations to design around:**
- **No tool_call↔tool_result id.** They pair by **adjacency**: the `tool_result`
  immediately following a `tool_call` (by `seq`) is its result. Safe because the
  workbench executes tools serially within a turn. Pairing logic must assert this
  (a `tool_call` not followed by a `tool_result` before the next `tool_call` =
  unmatched; count it, don't crash).
- **`tool_result.summary` is summarized/truncated** — it is NOT the raw tool
  output. So "tool result bytes" measured from the stream is a **lower-bound
  proxy** (summary length), not the true payload size. True bytes need adapter-side
  capture (see Metric 4). v1 ships the proxy and labels it as such.
- **"Turn" is not an event.** `cost.numTurns` is the only turn count; per-turn
  splits must be inferred (a turn boundary ≈ an `assistant_text`/`tool_call`
  cluster between two model responses). For v1 we treat **each `tool_call` as the
  unit** and report per-run aggregates + the tool-call timeline, NOT a reconstructed
  per-turn table (that needs adapter-emitted turn markers — deferred).

---

## The 6 metrics

### Metric 1 — Tool execution latency
**Definition:** for each matched `tool_call`→`tool_result` pair,
`latency = result.createdAt − call.createdAt`. Report per-tool (Bash/Read/Edit/
Write/Grep/Glob/Task) min/median/max/total, and the top-N slowest individual calls.
**Why:** shows whether shell/test/search is the bottleneck vs. model wait.
**Derivation:** adjacency pairing; group by `tool_call.name`.
**Edge:** unmatched call (no following result) → record latency = null, flag it.

### Metric 2 — Number of tool calls (and serialism)
**Definition:** total `tool_call` count per run; plus a **batching ratio** =
tool_calls / assistant_text-clusters (proxy for "calls issued per model turn").
Low ratio ⇒ the agent is too serial (one tool per turn).
**Why:** your original table — "low number often means the agent is too serial."
**Derivation:** count events; cluster `tool_call`s that share no intervening
`assistant_text` as "issued together."

### Metric 3 — Files read / commands run / tests run
**Definition:** classify each `tool_call` by `name` + `input`:
- **files read** = `Read` calls (count + distinct `input.file_path`).
- **commands run** = `Bash` calls (count).
- **tests run** = `Bash` calls whose `input.command` matches a test runner
  pattern (`pytest`, `vitest`, `npm test`, `turbo test`, `go test`, …).
- **files written** = `Write`/`Edit` (count + distinct paths) — useful denominator.
**Why:** reveals thrashing and the work-vs-survey ratio (3 writes / 18 calls = mostly survey).
**Derivation:** pure classification over `tool_call` payloads.

### Metric 4 — Tool result bytes/chars
**Definition (v1, proxy):** sum and max of `len(tool_result.summary)` per run,
per tool. **Labeled as a lower-bound** because summary is truncated.
**Definition (v2, accurate):** capture the raw result byte length adapter-side
(in `packages/agents/src/claude.ts` where the CLI stream is parsed) and add it to
the `tool_result` payload as `bytes`. Then this metric reads `bytes` directly.
**Why:** "huge logs poison future turns" — big results inflate every later turn's
cache_read. This is the metric that *explains* Finding 1's cache_read growth.
**Derivation:** v1 from stream; v2 needs the one adapter field.

### Metric 5 — Repeated reads of the same file
**Definition:** for `Read` (and `cat`-style `Bash`) calls, count files opened
**more than once within a run**, and files opened in **a later stage that an
earlier stage already opened** (cross-stage repeat — needs joining runs by task).
Report: `{ path, timesReadInRun, alsoReadInStages: [...] }`.
**Why:** "shows missing working memory" — this is THE metric for Findings 1–3.
**Derivation:** within-run = group `Read` by `file_path`, count > 1. Cross-stage =
union across the task's runs, ordered by stage.
**Edge:** normalize paths (worktree-absolute → repo-relative) so the same file
across stages/worktrees matches.

### Metric 6 — Retry / rate-limit / permission waits
**Definition:**
- **permission denials** = `result.denials[]` (tool names) + any `tool_result`
  with `status:"error"` whose summary matches the permission/gate denial text
  (e.g. "not allowed", "Compound commands … are not allowed").
- **retries** = consecutive `tool_call`s with identical `name`+`input` (the agent
  re-issuing the same call) — the duplicate-survey pattern surfaces here.
- **rate-limit waits** = gaps between a `tool_result` and the next `assistant_text`
  exceeding a threshold with no intervening tool activity (model stalled). v1:
  report the largest inter-event gaps; true rate-limit signals need adapter capture.
**Why:** "often invisible but expensive."
**Derivation:** denials from `result`; retries from adjacent-duplicate detection;
stalls from `createdAt` deltas.

---

## Where it lives (as built)

- **Pure functions in `@workbench/core/src/profiling.ts`**: `profileStage(stage,
  events) → StageProfile` (all 6 metrics for one run) plus `crossStageRepeatedReads`
  / `readPathsOf` for the task-level "missing working memory" signal. No I/O;
  unit-tested with synthetic event arrays in `profiling.test.ts`.
- **`wb task profile <id>`** (`packages/client/src/cli.ts`) is the report entry
  point — NOT a loose script. It lives in the CLI because that package already
  depends on `@workbench/core` and the typed client, so the imports resolve
  (workspace packages aren't linked at the repo root, which is why the original
  standalone `scripts/profile-task.ts` was removed). It fetches `getTask`
  (the 5 token/cost metrics) + `getRun` per run (events for the 6 derived), and
  renders Markdown to stdout: `wb task profile <id> > report.md`.
- **v2 adapter field** (`tool_result.bytes`) is the only non-derived change, and
  it's optional — gated behind Metric 4 v2. **Confirmed needed:** on the live run
  every stage's "largest result" reported exactly **501 chars** — the
  `tool_result.summary` truncation ceiling. So the v1 proxy is *saturated* and only
  tells you "≥501ch", not the true size. Metric 4 is not usefully quantitative
  until v2.

## Acceptance (self-validating against the known-bad run) — RESULTS

Ran `wb task profile task_wCjLi3jHgJ`. The metrics surfaced the regression:
- **implementation: 18 tool calls, work ratio 0.33** (6 writes / 18), 11 Bash
  commands — confirms survey-heavy, though less extreme than first eyeballed.
- **cross-stage repeated reads:** `engine.py` read in **discovery → implementation
  → verification → agent_self_review** — the "missing working memory" gap, now
  measured. This is the headline number the "plan exhaustively" fix must drive down.
- **verification is the serialism outlier:** 62 calls, batch ratio **0.11**, 18
  errored calls — not just slow from the browser; it thrashes too.
- The `profiling.test.ts` self-validating case asserts this shape on synthetic
  events so the contract holds without a live daemon.

The unit test (synthetic) is the durable acceptance gate; the live run above is the
baseline the fix is measured against.
