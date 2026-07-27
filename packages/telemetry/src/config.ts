/**
 * Telemetry is OFF unless an OTLP endpoint is configured (TASK-34 / ADR-008). This keeps every unit
 * test and the mock runtime free of exporters, background timers, and network egress — telemetry is a
 * diagnostics layer, never load-bearing. `awb up` sets `OTEL_EXPORTER_OTLP_ENDPOINT` to the local
 * collector; a bare `pnpm test` leaves it unset and telemetry is a no-op.
 */
export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  otlpEndpoint: string | undefined;
}

export function resolveTelemetryConfig(serviceName: string): TelemetryConfig {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined;
  // Explicit kill switch wins even if an endpoint is present.
  const disabled = process.env.AWB_TELEMETRY_DISABLED === '1' || process.env.OTEL_SDK_DISABLED === 'true';
  return {
    enabled: Boolean(otlpEndpoint) && !disabled,
    serviceName,
    otlpEndpoint,
  };
}
