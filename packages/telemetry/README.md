# @awb/telemetry

## Purpose

The workbench's diagnostics layer — OpenTelemetry traces + metrics, structured
logging, and the deterministic one-trace-per-run bridging (TASK-34 / TASK-36,
ADR-008). Telemetry is diagnostics-only and never load-bearing: it is OFF unless
an OTLP endpoint is configured, so unit tests and the mock runtime run with no
exporters, background timers, or network egress.

## Responsibilities

- `resolveTelemetryConfig` / `TelemetryConfig` (`config.ts`) — decides whether
  telemetry is enabled from `OTEL_EXPORTER_OTLP_ENDPOINT`, honoring the
  `AWB_TELEMETRY_DISABLED` / `OTEL_SDK_DISABLED` kill switches. A bare
  `pnpm test` leaves the endpoint unset, so telemetry is a no-op.
- `initTelemetry` / `telemetryEnabled` / `shutdownTelemetry` (`init.ts`) —
  boots the OTLP trace+metric NodeSDK. A no-op when disabled, idempotent so the
  worker and daemon can both call it defensively, best-effort shutdown that
  never fails a process exit.
- `withSpan` + `deriveRunTraceId` / `runSpanContext` (`spans.ts`) — opens a span
  around an async fn, marking it ERROR + recording the exception on throw.
  `deriveRunTraceId(runId)` = SHA-256(runId) first 16 bytes as hex, so passing
  `parentRunId` parents every phase of a run to one deterministic run-level
  trace (TASK-36) — separate Temporal activity executions reconstruct the same
  parent and land in a single nested trace instead of one random trace per
  phase.
- `record*` metric helpers (`metrics.ts`) — the cross-run instruments (phase
  started/failed, retry scheduled, transport drop, phase duration histogram)
  that per-task token breakdowns can't answer.
- `createLogger` / `Logger` (`logger.ts`) — a dependency-free leveled logger
  emitting one JSON line per record to stdout/stderr, level via `AWB_LOG_LEVEL`.

Every span, metric, and log record carries the `run_id`/`task_id` bridge
attributes (ADR-008) so any signal links back to the run's `semantic_events`.

## Does NOT

- Persist anything. It exports to an external OTLP collector; it is not a store
  and never writes SQLite or Temporal history (`docs/observability.md` covers
  the three-channel split and why).
- Decide what to observe. Callers (phase Activities in `workers/temporal-worker`,
  the daemon) choose span boundaries, metrics, and log points — this package
  only provides the instruments.
- Emit OTel logs via an SDK — the logger is deliberately dependency-free JSON to
  stdout/stderr, consumed by the collector's scraper or `awb logs`.

## Dependencies

`@opentelemetry/*` (API + NodeSDK + OTLP HTTP exporters). No `@awb/*`
dependency — this is a leaf package.
