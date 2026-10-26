# 008 — Observability is split by purpose: `semantic_events` for domain data, OpenTelemetry for runtime telemetry

## Decision

Keep two distinct observability layers rather than unifying everything into one
system:

1. **Domain / evidence events → `semantic_events` (SQLite), unchanged.** The
   agent activity stream (each provider `AgentEvent` normalized into a
   `SemanticEvent` and persisted through the daemon's single-writer path) stays
   exactly where it is. It is a durable, queryable domain record.
2. **Runtime telemetry → OpenTelemetry.** Traces (phase → agent-session →
   tool-call spans), metrics (failure/retry rates, transport-drop frequency, p95
   phase duration, tokens/cost time-series), and a structured, leveled app logger
   are emitted via the OTel SDK to an OTLP collector — **replacing** the raw
   `worker.log`/`daemon.log`/`temporal.log` stdout diagnostics.

The two layers are **bridged, not merged**: every span and metric carries the
`run_id`/`task_id`, so a trace in the collector links back to the exact
`semantic_events` rows for that run. Control-plane events (a phase failing, a
retry being scheduled, a transport drop) are emitted as OTel span-events and — when
they are user-facing — also as `semantic_events` rows so the dashboard shows them.

## Why

The instinct to "emit everything to one shared OpenTelemetry space to simplify the
architecture" is right for the *telemetry* layer and wrong for the whole system,
because `semantic_events` is not telemetry:

- **It is product data.** It is the user-facing activity feed rendered live in the
  web dashboard (WebSocket bus) and re-served by the reconnect catch-up route.
- **It is load-bearing for correctness.** It is part of the evidentiary trail the
  deterministic completion policy reads (ADR-003 — the workbench, not the agent,
  decides a phase is done) and that the PR evidence matrix is built from.
- **It must not be lossy.** OTel logs/traces are sampling-and-exporter based by
  design; dropping or sampling them is expected and fine for diagnostics. Applying
  that to the "did this phase actually pass" record would reintroduce exactly the
  "lifecycle moved forward on a lie" failure mode ADR-003 exists to prevent.
- **SQLite is the deliberate store for durable state** (ADR-002). `semantic_events`
  living there is consistent with that choice; it is queried transactionally
  alongside the other lifecycle rows.

Conversely, the gaps that motivated looking at OTel are real and are genuinely a
telemetry problem, not a domain-data problem: no span/trace tree (the run 5a513429
timeline had to be hand-reconstructed), no cross-run metrics (can't answer "is the
retry rate getting worse?"), no structured app logger (the worker uses Temporal's
SDK logger + `console`, so control-plane failures land only in stdout). OTel is the
industry-standard vocabulary for exactly these three, and adopting it unifies the
diagnostics layer and deletes the "grep three log files" workflow.

So the simplification the split delivers is: **one telemetry system (OTel) instead
of three ad-hoc stdout logs**, while *keeping* the one channel that is actually
product data where it belongs. Merging them would not simplify — it would put a
correctness-critical record into a lossy pipe.

## Consequences

- A newcomer debugging a run uses OTel traces/metrics/logs for "why/how long/how
  often," and `semantic_events` for "what the agent did / what the workbench
  decided." The bridge id ties them together. This is documented in
  `docs/observability.md` (TASK-35).
- The local stack (`awb up`) gains a collector (Tempo/Prometheus or an all-in-one).
  That is new operational surface to run and is accepted as the cost of the trace
  and metric layers.
- Control-plane events are dual-emitted (OTel span-event always; `semantic_events`
  row when user-facing). The taxonomy of which is which is defined in
  `packages/domain/src/events.ts` and `docs/observability.md`.
- `semantic_events`, `agent_sessions`, and `phase_observability` schemas do not
  change as a result of this decision. The single-writer invariant (ADR /
  `docs/storage.md`, TASK-21) is preserved — the daemon remains the only writer of
  those tables; OTel export is a separate, non-DB egress.

## Status

**Accepted; implementation open (TASK-34).** This ADR records the architecture
decision. The control-plane events + OTel SDK + collector + bridge are implemented
under TASK-34, and the end-to-end model is documented under TASK-35
(`docs/observability.md`). Until TASK-34 lands, the runtime-telemetry layer does
not yet exist — diagnostics still rely on the raw process logs, and that limitation
is called out honestly in the observability doc rather than documented as if the
OTel layer were already present.
