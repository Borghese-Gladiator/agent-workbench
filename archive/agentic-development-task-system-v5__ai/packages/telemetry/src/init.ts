import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { Resource } from '@opentelemetry/resources';
import { resolveTelemetryConfig, type TelemetryConfig } from './config.js';

/** The OTel resource attribute key for a service's name (avoids a semantic-conventions version pin). */
const SERVICE_NAME_ATTR = 'service.name';

let sdk: NodeSDK | undefined;
let activeConfig: TelemetryConfig | undefined;

/**
 * Boots the OpenTelemetry NodeSDK (traces + metrics) exporting to the OTLP collector. A
 * no-op when no OTLP endpoint is configured — telemetry is diagnostics-only, so a test run or the mock
 * runtime never starts an exporter. Idempotent: a second call while running is ignored so both the
 * worker and daemon bootstraps can call it defensively.
 */
export function initTelemetry(serviceName: string): TelemetryConfig {
  const config = resolveTelemetryConfig(serviceName);
  if (!config.enabled || sdk) {
    activeConfig = config;
    return config;
  }

  sdk = new NodeSDK({
    resource: new Resource({ [SERVICE_NAME_ATTR]: config.serviceName }),
    traceExporter: new OTLPTraceExporter({ url: `${config.otlpEndpoint}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${config.otlpEndpoint}/v1/metrics` }),
      exportIntervalMillis: 15_000,
    }),
  });
  sdk.start();
  activeConfig = config;
  return config;
}

/** Whether telemetry is currently exporting (used by helpers to short-circuit cheaply). */
export function telemetryEnabled(): boolean {
  return activeConfig?.enabled ?? false;
}

/** Flushes and shuts the SDK down (best-effort). Safe to call when telemetry was never started. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // best-effort: telemetry shutdown must never fail a process exit.
  } finally {
    sdk = undefined;
    activeConfig = undefined;
  }
}
