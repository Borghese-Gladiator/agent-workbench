# Observability

How a run is observed, end to end. There are **three channels**, each with a
distinct job, bridged by a shared `run_id`/`task_id`. The governing decision is
[ADR-008](decisions/008-observability-split.md): **domain/evidence data lives in
SQLite; runtime telemetry lives in OpenTelemetry; never the reverse.**

Use this doc to go from "a run failed" to the right channel and query without
reading source — see the [runbook](#debugging-a-failed-run) at the end.

## The three channels

### 1. `semantic_events` — the durable domain / evidence stream

The user-facing activity record. Every agent turn (a message, a tool call, a
file change, a finding, a usage sample) and every user-facing **control-plane**
event (a phase failing, a retry being scheduled, a transport drop) lands here as
a `SemanticEvent` row in workbench SQLite.

- **Purpose:** the live dashboard feed (WebSocket) + reconnect catch-up; input to
  the deterministic completion policy
  ([ADR-003](decisions/003-deterministic-completion-not-agent-selfreport.md) — the
  workbench, not the agent, decides a phase is done); the source the PR evidence
  matrix is built from.
- **Load-bearing and lossless.** It is product data and part of the correctness
  trail, so it is never sampled or dropped. This is exactly why it is **not**
  telemetry (ADR-008).
- **Schema:** `semantic_events` (`packages/database/src/schema/sessions.ts`).
  Written by the daemon only.

### 2. `agent_sessions` / observability tables — per-session token & cost attribution

Fine-grained accounting for §27: one `agent_sessions` row per agent session, its
`model_invocations` (tokens/cost), `runtime_attribution` (the 12 wall-clock
buckets per phase attempt), and `context_composition` (the 8 token-source
buckets). Read back on demand by `getTokenBreakdown` / `getRuntimeAttribution`
(`packages/database/src/data-access/observability.ts`) — computed on read, not a
time series.

- **Purpose:** "where did this task's tokens/cost/time go?" per phase and model.
- Also the durable home of the builder's **resume tokens** (`resume_session_id`,
  TASK-32): reconstructed into `builderResumeSessions` on worker restart so a
  retry resumes rather than cold-starts.

### 3. OpenTelemetry — traces, metrics, and app logs (runtime telemetry)

The runtime-diagnostics layer added under TASK-34, per ADR-008. Emitted via the
`@awb/telemetry` package to an OTLP collector.

- **Traces:** a span per phase (`phase.<name>`), tagged with the `run_id`/`task_id`
  bridge, so a run is a nested-duration tree instead of a flat event list.
- **Metrics:** cross-run time series the on-read token breakdown can't give —
  phase-failure rate (`awb.phase.failed`), retry rate
  (`awb.attempt.retry_scheduled`), transport-drop frequency (`awb.transport.drop`),
  p95 phase duration (`awb.phase.duration_ms`).
- **App logs:** a leveled, structured logger (`createLogger`) stamped with
  `run_id`/`task_id`, replacing raw stdout diagnostics. Live in the daemon and worker
  bootstrap sinks and the size-classifier shadow line (child logger bound to
  `run_id`/`task_id`); it writes one JSON record per line to stdout/stderr, which the
  collector's stdout scraper and `awb logs <service>` both consume.
- **Lossy by design and NOT product data.** Sampling/dropping telemetry is fine;
  applying that to `semantic_events` would reintroduce the "lifecycle advanced on a
  lie" failure [ADR-003](decisions/003-deterministic-completion-not-agent-selfreport.md)
  prevents.

> **Status (kept honest).** Telemetry is **off unless an OTLP endpoint is
> configured** (`OTEL_EXPORTER_OTLP_ENDPOINT`). `awb up` boots an all-in-one
> collector (`grafana/otel-lgtm`, Grafana on :3000) and points the worker + daemon
> at it. A plain `pnpm test` or a daemon-less smoke run starts no exporter, so
> until you run the collector, diagnostics still come from `semantic_events` + the
> raw process logs (`awb logs <service>`).

### How they bridge

Every span and metric carries `run_id` (and `task_id`), the same ids that key
`semantic_events` and `agent_sessions`. So a slow span or a metric spike links
straight back to the exact rows for that run. `run_id` is `runIdForTask(taskId)`
= `${taskId}-run`.

## The event pipeline

```
AgentEvent                         (raw provider event; agent-gateway)
  → normalizeAgentEvent(...)        → SemanticEvent (compact, never raw tokens)
  → daemon.postEvent(event)         → POST /internal/events   (worker → daemon)
  → insertSemanticEvent(...)        → assigns authoritative per-run `sequence`,
                                       persists to semantic_events (single writer)
  → eventBus.publish(stored)        → live WebSocket clients (/api/events/stream)
```

- **Agent-produced events** flow through `createPhaseEventSink`
  (`durable-event-sink.ts`): each `adapter.execute` turn emits `AgentEvent`s that
  are normalized and posted. The worker sends a provisional `sequence: 0`; the
  daemon assigns the authoritative monotonic sequence on write.
- **Control-plane events** (TASK-34) are emitted by `createControlPlaneEmitter`
  (`control-plane-events.ts`) directly with `producer: 'workbench'`, over the same
  `POST /internal/events` path — so the dashboard and catch-up route get them for
  free with no route change. Best-effort: a dropped control-plane event never fails
  the phase.
- **Reconnect catch-up:** `GET /api/events?runId=…&afterSequence=N`
  (`apps/daemon/src/routes/websocket.ts`) replays persisted rows past a sequence;
  the web hook (`useEventStream`) backfills on (re)connect, then streams live.

## Event taxonomy

`EventProducer` and `EventType` are defined in `packages/domain/src/events.ts`.

**Producers.** Agent roles map to producers via `ROLE_TO_PRODUCER`
(`agent-gateway/src/event-normalization.ts`): `planner`, `plan-critic`, `builder`,
`verifier`, `qa`, `reviewer`. Plus `tool`, `workflow`, and — for control-plane
lifecycle events — `workbench`.

**Types.**

| Type | Producer | Fires when |
| --- | --- | --- |
| `intent` | agent | the agent states what it's about to do |
| `command-started` / `command-completed` | agent | a tool/command starts / finishes |
| `file-changed` | agent (builder) | a file is edited |
| `finding-created` | agent (critic/reviewer) | a finding is raised |
| `evidence-created` | agent | evidence is recorded |
| `usage-reported` | agent | a usage/token sample is reported |
| `status-changed` | agent | the agent's plan/status changes |
| `message` | agent | free-text narration |
| `phase-started` | `workbench` | a phase attempt begins (carries cwd + resume key) |
| `phase-failed` | `workbench` | a phase attempt throws (carries error class + resumable) |
| `attempt-retry-scheduled` | `workbench` | a Temporal retry will follow the failure |
| `transport-error` | `workbench` | a resumable transport drop was seen |
| `session-started` | `workbench` | an agent session cold-starts |
| `session-resumed` | `workbench` | an agent session resumes a prior transcript (TASK-32) |

## Debugging a failed run

The workflow run 5a513429 (a transport drop mid-implement that wasted ~47 min on
cold-restart retries) is the motivating case: it had to be reconstructed by hand
from `semantic_events` + `worker.log`. With the channels above it is a targeted
query.

- **"What did the agent do / what did the workbench decide?"** →
  `semantic_events`.
  ```sql
  SELECT sequence, producer, type, summary
  FROM semantic_events WHERE run_id = '<taskId>-run' ORDER BY sequence;
  ```
- **"Did a phase fail, and was a retry scheduled?"** → the control-plane rows.
  ```sql
  SELECT type, payload_json FROM semantic_events
  WHERE run_id = '<taskId>-run'
    AND type IN ('phase-failed','attempt-retry-scheduled','transport-error');
  ```
  `attempt-retry-scheduled` count should equal the Temporal activity attempt count
  and the `awb.attempt.retry_scheduled` metric for the run.
- **"Why so slow / how long did each phase take?"** → the OTel **trace** for the
  run (Grafana → Tempo, filter `run_id`), or `runtime_attribution` for the
  per-bucket wall-clock.
- **"Is the retry / failure rate getting worse across runs?"** → the OTel
  **metrics** (Grafana → Prometheus): `awb.phase.failed`, `awb.attempt.retry_scheduled`,
  `awb.transport.drop`, `awb.phase.duration_ms`.
- **"Where did the tokens/cost go?"** → `getTokenBreakdown(taskId)` (per model) and
  `getRuntimeAttribution(taskId)` (per bucket).

If the telemetry collector isn't running, the first two queries still answer most
questions; the trace/metric steps require `awb up` to have started the collector.
