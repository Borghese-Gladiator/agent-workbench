# Investigation — Observability: latency (TTFT, inter-event gaps, UI surfacing)

Date: 2026-06-25
Branch: `worktree-observability-latency`

## Brief

Three questions:
1. **Time to first token (TTFT)** — do we measure it, and is it good enough?
2. **Prevent inter-event gaps** — can we detect/attribute stalls between streamed events?
3. **UI surfacing** — how do we get all this latency info in front of the user?

## TL;DR

The hard part is **already built**. The daemon emits per-turn TTFT markers, the
event stream is double-timestamped (`receivedAt` vs `createdAt`), and a full
profiling layer (`packages/core/src/profiling.ts`) derives tool-latency,
inter-event gaps, and turn stats from the persisted stream. The gap is **surface
area**: all of it is exposed only through the CLI (`wb task profile`), and **none
of it reaches the web UI**, which still shows just live cost/turns/tokens.

So this is mostly a *plumbing + rendering* effort, not new instrumentation. Two
genuinely new pieces of measurement are worth adding (inter-event gap series and
the `receivedAt`/`createdAt` divergence), and both are cheap because the
timestamps already exist on every row.

---

## 1. Time to first token

### What exists

TTFT is measured **per turn**, not just once per run.

- The Claude adapter anchors a turn-boundary clock and stamps the first model
  emission: `packages/agents/src/claude.ts:670` (initial boundary at run start),
  `:857-864` (first-token stamp when `awaitingFirstToken`), `:911-914` (each
  `tool_result` resets the boundary, opening the next turn).
- It emits a `turn` event carrying `ttftMs = firstTokenMs - turnBoundaryMs`:
  `packages/agents/src/claude.ts:877-890`.
- Payload shape `TurnEventPayload { index, ttftMs, ...tokens }`:
  `packages/core/src/agent-runs.ts:126-135`.
- The daemon already logs a WARN for slow turns (`ttftMs >= 20s`):
  `apps/daemon/src/agent-run-executor.ts:36-37, 274-288`.
- Aggregation into count/min/median/max + slowest turn:
  `turnStats()` in `packages/core/src/profiling.ts:374-402`.

There is **also** a true model-API latency from the CLI `result` line
(`duration_api_ms`), carried on the `cost` event as `durationApiMs`
(`packages/core/src/agent-runs.ts:48-61`; emitted at `claude.ts:935-944`). This
is the model's own wall-clock for the API slice, separate from our
turn-boundary measurement.

### Assessment

TTFT measurement is solid and arguably ahead of where most agent harnesses are
(per-turn, not just first-turn). Two caveats:

- **`durationMs`/`durationApiMs` are dropped from the AgentRun row** — they live
  only on the streamed `cost` event (`apps/daemon/src/agent-run-executor.ts:290-293`).
  Anything that reads runs from the DB without replaying events can't see API
  latency. If we want it queryable/sortable, persist it on the row.
- Mock runtime emits no turn events, so TTFT only exists under the `claude`
  runtime (consistent with the existing memory note on the two timing clocks).

**Recommendation:** keep the measurement as-is; persist `durationApiMs` (and
optionally a run-level `ttftMs` = first turn's TTFT) onto the `AgentRun` row so
it survives without event replay and can be listed/sorted.

---

## 2. Inter-event gaps

### What exists

Every streamed event is double-timestamped on the way into the store:

- `receivedAt = input.receivedAt ?? now()` stamped when the event enters the
  daemon's `emit()`, before the SQLite write; `createdAt` stamped at insert:
  `packages/store/src/store.ts:810-820`.
- Both columns on `agent_run_events`: `packages/store/src/schema-types.ts:132-144`.

The divergence `createdAt - receivedAt` isolates **daemon persist delay** from
model/network latency — but nothing currently computes or displays it.

Tool-execution gaps (the dominant non-model latency) are fully derived:

- `pairToolCalls()` pairs each `tool_call` with the next `tool_result` by `seq`
  adjacency and computes `latencyMs`: `packages/core/src/profiling.ts:105-191`.
- `toolLatency()` aggregates to overall/per-tool/top-5 slowest:
  `packages/core/src/profiling.ts:171-190`.
- `toolVolume()` reports `batchingRatio` (1.0 = fully serial) as a serialism
  signal: `:198-226`.

### The actual gap (no pun intended)

There is **no first-class "inter-event gap" series** — i.e. the time delta
between consecutive events of any type, which is what surfaces *stalls* that
aren't a tool call (model thinking between turns, permission waits, daemon
hiccups). It's trivially derivable from the existing `receivedAt`/`createdAt`
sequence but not yet computed.

### Can we *prevent* gaps?

Mostly the gaps are intrinsic (model latency, tool execution). The controllable
ones:

- **Daemon persist delay** — if `createdAt - receivedAt` is ever non-trivial,
  that's an event-loop block on our side. This is exactly the
  `spawnSync`/`execFileSync` class of bug already documented in memory
  ([[econnreset-rootcause-spawnsync]]). A gap series that separates "model gap"
  (between `receivedAt`s) from "persist gap" (`createdAt - receivedAt`) makes
  that regression *visible* instead of inferred.
- **Tool serialism** — `batchingRatio` already tells us when the agent is
  running tools one-at-a-time that could batch. Surfacing it nudges prompt/agent
  changes.

**Recommendation:** add a pure `eventGaps(events)` helper to `profiling.ts` that
returns, per consecutive pair: `gapMs` (model/transit, `receivedAt[n] -
receivedAt[n-1]`), `persistMs` (`createdAt - receivedAt`), and a label for the
boundary type (e.g. `tool_result→assistant_text`). Aggregate to
max/median/p95 + top-N stalls. This is the one new computation worth writing;
everything else is rendering.

---

## 3. Surfacing in the UI

### Where latency data lives today

- **CLI only.** `wb task profile <id>` renders the whole thing as Markdown:
  per-session duration/API-latency/tokens/cost table, per-stage tool
  activity/efficiency, waste signals, cross-stage repeated reads:
  `packages/client/src/cli.ts:224-303`.
- **Web UI shows almost none of it.** `RunTerminal` subscribes to the run SSE
  stream and renders only a live cost badge (`turns · $ · tokens`):
  `apps/web/src/components/RunTerminal.tsx:79-161`, `apps/web/src/lib/cost.ts:37-49`.
  `TaskDetail` shows a live wall-clock and live cost:
  `apps/web/src/pages/TaskDetail.tsx:107, 116, 195-200`.
- The `turn` events (with `ttftMs`) already flow over the same SSE stream
  (`apps/daemon/src/app.ts:348-425`) but the web client ignores them.

So the web app **already receives** TTFT and all timing data — it just drops it
on the floor.

### Recommendation — three incremental UI deliverables

Ordered by value/effort. All read data that already arrives over SSE or the
existing `getRun`/`getTask` endpoints; no new daemon endpoints required for #1–2.

1. **Live TTFT + gap strip in `RunTerminal`** (cheap, high value)
   Consume the `turn` events already on the stream; show current/last TTFT and a
   small sparkline of per-turn TTFT. Add a "stalled" indicator driven by a
   client-side timer since the last event (mirror the daemon's 20s WARN
   threshold). This makes a hang *visible while it's happening*.

2. **Per-stage "Profiling" panel in `TaskDetail`** (medium)
   Render the same data the CLI `profile` command produces, reusing the pure
   `profileStage`/`turnStats`/`toolLatency` functions from
   `packages/core/src/profiling.ts` (they're duck-typed to work on the client's
   event mirror — `profiling.ts:17-18, 41`). Tables: duration / API latency /
   TTFT median / tokens per stage; tool latency top-N; waste signals. This is
   "the CLI report, in the browser."

3. **Run timeline / gap visualization** (larger)
   A horizontal timeline of events for a run, bars colored by boundary type,
   width = `gapMs` from the new `eventGaps()` helper, with `persistMs` overlaid
   so daemon-side stalls are distinguishable from model waits. This is the
   strongest "where did the latency go" view but needs the most UI work.

---

## What I'd build first (proposed scope)

A tight, shippable slice that answers all three questions:

1. **`eventGaps()`** in `packages/core/src/profiling.ts` (+ unit test) — the one
   new computation; separates model gap from persist gap.
2. **Persist `durationApiMs`** (and run-level `ttftMs`) onto the `AgentRun` row so
   API latency is queryable without event replay.
3. **`RunTerminal` TTFT/gap strip** — consume the `turn` events already on the
   wire + a stall indicator.
4. **`TaskDetail` profiling panel** — reuse the existing pure profiling functions
   to render the CLI report in the browser.

Items 3–4 are pure rendering of data that already arrives; item 1 is ~30 lines of
pure function; item 2 is a small schema + executor change. No new instrumentation
in the hot streaming path.

## Key references

- TTFT calc / turn events: `packages/agents/src/claude.ts:670, 857-864, 877-890, 911-914, 935-944`
- Turn payload / cost payload: `packages/core/src/agent-runs.ts:48-61, 126-135`
- Slow-turn WARN + dropped durations: `apps/daemon/src/agent-run-executor.ts:36-37, 274-293`
- Double-timestamping: `packages/store/src/store.ts:810-820`; `schema-types.ts:132-144`
- Profiling library: `packages/core/src/profiling.ts:105-226, 374-402`
- CLI report: `packages/client/src/cli.ts:224-303`
- Web (current surface): `apps/web/src/components/RunTerminal.tsx:79-161`; `apps/web/src/pages/TaskDetail.tsx:107-200`; `apps/web/src/lib/cost.ts:37-49`
- Run SSE stream: `apps/daemon/src/app.ts:348-425`
