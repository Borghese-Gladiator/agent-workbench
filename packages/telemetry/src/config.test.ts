import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTelemetryConfig } from './config.js';

describe('resolveTelemetryConfig (TASK-34: telemetry is off unless an OTLP endpoint is set)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.AWB_TELEMETRY_DISABLED;
    delete process.env.OTEL_SDK_DISABLED;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is disabled with no OTLP endpoint (a plain test run never starts an exporter)', () => {
    expect(resolveTelemetryConfig('worker').enabled).toBe(false);
  });

  it('is enabled once an OTLP endpoint is configured', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    const config = resolveTelemetryConfig('worker');
    expect(config.enabled).toBe(true);
    expect(config.otlpEndpoint).toBe('http://127.0.0.1:4318');
  });

  it('honors the kill switch even when an endpoint is present', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    process.env.AWB_TELEMETRY_DISABLED = '1';
    expect(resolveTelemetryConfig('worker').enabled).toBe(false);
  });
});
