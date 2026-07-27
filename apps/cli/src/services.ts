import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { resolveLayout } from '@awb/config';

export const DAEMON_PORT = 4417;
export const TEMPORAL_PORT = 7233;
export const UI_PORT = 5317;
/** OTLP/HTTP receiver port of the local collector (grafana/otel-lgtm all-in-one), TASK-34. */
export const OTEL_OTLP_PORT = 4318;
/** The collector's Grafana UI port (traces/metrics/logs explorer). */
export const OTEL_UI_PORT = 3000;
/** The OTLP/HTTP endpoint the worker + daemon export to; injected into their env by `awb up`. */
export const OTEL_ENDPOINT = `http://127.0.0.1:${OTEL_OTLP_PORT}`;

export type ServiceKey = 'temporal' | 'worker' | 'daemon' | 'ui' | 'otel';

/**
 * Services that make up the core runtime, in start order. The OTel collector starts FIRST so the
 * worker + daemon see `OTEL_EXPORTER_OTLP_ENDPOINT` at boot and export from their first span (TASK-34).
 * `ui` is intentionally excluded from `up`.
 */
export const RUNTIME_SERVICES: ServiceKey[] = ['otel', 'temporal', 'worker', 'daemon'];

export interface ServiceDefinition {
  key: ServiceKey;
  label: string;
  /** The process AWB spawns. */
  command: string;
  args: string[];
  cwd: string;
  /** TCP port the service listens on, if any (worker has none). */
  port?: number;
  /** Extra environment for the spawned process, merged over the inherited env. */
  env?: Record<string, string>;
  /** True for the optional UI, false for the three runtime services. */
  ui: boolean;
}

function repoRoot(): string {
  return resolve(new URL('../../../..', import.meta.url).pathname);
}

export function serviceDefinitions(): Record<ServiceKey, ServiceDefinition> {
  const root = repoRoot();
  const layout = resolveLayout();
  return {
    otel: {
      key: 'otel',
      label: 'OTel collector (grafana/otel-lgtm)',
      // All-in-one collector: OTLP receiver + Tempo (traces) + Prometheus (metrics) + Loki (logs) + a
      // Grafana explorer on 3000. Run under Docker so `awb up` needs no separate binary install; --rm
      // keeps it disposable (traces/metrics are diagnostics, not durable product data — ADR-008). Named
      // so `down`/restart can target it. We publish only OTLP/HTTP (4318, what @awb/telemetry exports to)
      // and Grafana (3000); the gRPC receiver (4317) is left unpublished so this never collides with an
      // unrelated collector already holding 4317 on the host.
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--name',
        'awb-otel-lgtm',
        '-p',
        `${OTEL_OTLP_PORT}:4318`,
        '-p',
        `${OTEL_UI_PORT}:3000`,
        'grafana/otel-lgtm:latest',
      ],
      cwd: root,
      port: OTEL_OTLP_PORT,
      ui: false,
    },
    temporal: {
      key: 'temporal',
      label: 'Temporal dev server',
      command: 'temporal',
      args: ['server', 'start-dev', '--db-filename', layout.temporalSqlite],
      cwd: root,
      port: TEMPORAL_PORT,
      ui: false,
    },
    worker: {
      key: 'worker',
      label: 'Temporal worker',
      command: 'pnpm',
      args: ['--filter', '@awb/temporal-worker', 'dev'],
      cwd: root,
      // Point the worker's OTel SDK at the local collector (TASK-34); a no-op if the collector isn't up.
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_ENDPOINT },
      ui: false,
    },
    daemon: {
      key: 'daemon',
      label: 'Daemon (Fastify API)',
      command: 'pnpm',
      args: ['--filter', '@awb/daemon', 'dev'],
      cwd: root,
      port: DAEMON_PORT,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_ENDPOINT },
      ui: false,
    },
    ui: {
      key: 'ui',
      label: 'Web UI (Vite)',
      command: 'pnpm',
      args: ['--filter', '@awb/web', 'dev'],
      cwd: root,
      port: UI_PORT,
      ui: true,
    },
  };
}

export function serviceDefinition(key: ServiceKey): ServiceDefinition {
  return serviceDefinitions()[key];
}

export function runtimeDirs(): { pidsDir: string; logsDir: string } {
  const layout = resolveLayout();
  const logsDir = join(layout.runtimeDir, 'logs');
  mkdirSync(layout.runtimePidsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return { pidsDir: layout.runtimePidsDir, logsDir };
}

export function pidPathFor(key: ServiceKey): string {
  return join(runtimeDirs().pidsDir, `${key}.pid`);
}

export function logPathFor(key: ServiceKey): string {
  return join(runtimeDirs().logsDir, `${key}.log`);
}
