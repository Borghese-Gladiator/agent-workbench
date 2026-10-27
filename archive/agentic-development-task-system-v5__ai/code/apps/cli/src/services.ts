import { dirname, join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveLayout, resolveRuntimeConfig } from '@awb/config';

/**
 * Every port / URL / container name below is resolved at CALL time from `resolveRuntimeConfig()`
 * (env-driven, current values as defaults) rather than frozen as a module-level constant — so
 * `awb up --isolated`, which populates the override env vars before starting services, moves the
 * whole stack together in this same CLI process.
 */
export const daemonPort = (): number => resolveRuntimeConfig().daemonPort;
export const temporalPort = (): number => resolveRuntimeConfig().temporalPort;
export const uiPort = (): number => resolveRuntimeConfig().uiPort;
/** OTLP/HTTP receiver port of the local collector (grafana/otel-lgtm all-in-one). */
export const otelOtlpPort = (): number => resolveRuntimeConfig().otelOtlpPort;
/** The collector's Grafana UI port (traces/metrics/logs explorer). */
export const otelUiPort = (): number => resolveRuntimeConfig().otelUiPort;
/** The OTLP/HTTP endpoint the worker + daemon export to; injected into their env by `awb up`. */
export const otelEndpoint = (): string => resolveRuntimeConfig().otelEndpoint;

export type ServiceKey = 'temporal' | 'worker' | 'daemon' | 'ui' | 'otel';

/**
 * Services that make up the core runtime, in start order. The OTel collector starts FIRST so the
 * worker + daemon see `OTEL_EXPORTER_OTLP_ENDPOINT` at boot and export from their first span.
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

/**
 * The workspace root, found by walking UP from this module to the directory holding
 * `pnpm-workspace.yaml`. A fixed `../../../..` hop is fragile: the depth differs between the built
 * `dist/` layout and the buildless `tsx src/` path the `awb` CLI actually runs under, and when it
 * overshoots it lands on the PARENT of a worktree (e.g. `LOCAL_worktrees/agent-workbench`), whose
 * `workers/temporal-worker` does not exist — so `awb up` spawns the worker with a non-existent cwd
 * and fails with a misleading `spawn … ENOENT`. Anchoring on the workspace marker is correct for
 * src, dist, and any worktree location.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repoRoot: could not locate pnpm-workspace.yaml above ${fileURLToPath(import.meta.url)}`);
}

/**
 * Runtime execution mode:
 * - `pinned` (default): worker + daemon run compiled `dist` (`node dist/index.js`) from the live
 *   repo — no `tsx watch`, so editing the live `src/` can never hot-reload the running runtime.
 *   This is the precondition for safely running a task against the workbench's own code.
 * - `dev`: worker + daemon run `tsx watch` from the live source (workbench inner-loop DX).
 *
 * Requires `dist` to be built (`pnpm build`); `awb up` in pinned mode assumes a prior build.
 */
export type RuntimeMode = 'pinned' | 'dev';

export function resolveRuntimeMode(): RuntimeMode {
  return process.env.AWB_RUNTIME_MODE === 'dev' ? 'dev' : 'pinned';
}

export function serviceDefinitions(mode: RuntimeMode = resolveRuntimeMode()): Record<ServiceKey, ServiceDefinition> {
  const root = repoRoot();
  const layout = resolveLayout();
  const cfg = resolveRuntimeConfig();
  const pinned = mode === 'pinned';
  // Spawn pinned services with the SAME node binary running this CLI (`process.execPath`) rather than
  // a bare `'node'`: under pnpm/fnm the child's PATH does not always include the active node (fnm's
  // shim is an ephemeral per-shell dir), so `spawn('node', …)` fails with ENOENT when booting from a
  // worktree. `process.execPath` is an absolute path and always resolves.
  const nodeBin = process.execPath;
  const workerService: ServiceDefinition = pinned
    ? {
        key: 'worker',
        label: 'Temporal worker',
        command: nodeBin,
        args: ['dist/index.js'],
        cwd: join(root, 'workers', 'temporal-worker'),
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: cfg.otelEndpoint },
        ui: false,
      }
    : {
        key: 'worker',
        label: 'Temporal worker',
        command: 'pnpm',
        args: ['--filter', '@awb/temporal-worker', 'dev'],
        cwd: root,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: cfg.otelEndpoint },
        ui: false,
      };
  const daemonService: ServiceDefinition = pinned
    ? {
        key: 'daemon',
        label: 'Daemon (Fastify API)',
        command: nodeBin,
        args: ['dist/index.js'],
        cwd: join(root, 'apps', 'daemon'),
        port: cfg.daemonPort,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: cfg.otelEndpoint },
        ui: false,
      }
    : {
        key: 'daemon',
        label: 'Daemon (Fastify API)',
        command: 'pnpm',
        args: ['--filter', '@awb/daemon', 'dev'],
        cwd: root,
        port: cfg.daemonPort,
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: cfg.otelEndpoint },
        ui: false,
      };
  return {
    otel: {
      key: 'otel',
      label: 'OTel collector (grafana/otel-lgtm)',
      // All-in-one collector: OTLP receiver + Tempo (traces) + Prometheus (metrics) + Loki (logs) + a
      // Grafana explorer on 3000. Run under Docker so `awb up` needs no separate binary install; --rm
      // keeps it disposable (traces/metrics are diagnostics, not durable product data). Named
      // so `down`/restart can target it. We publish only OTLP/HTTP (4318, what @awb/telemetry exports to)
      // and Grafana (3000); the gRPC receiver (4317) is left unpublished so this never collides with an
      // unrelated collector already holding 4317 on the host.
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--name',
        cfg.otelContainerName,
        '-p',
        `${cfg.otelOtlpPort}:4318`,
        '-p',
        `${cfg.otelUiPort}:3000`,
        'grafana/otel-lgtm:latest',
      ],
      cwd: root,
      port: cfg.otelOtlpPort,
      ui: false,
    },
    temporal: {
      key: 'temporal',
      label: 'Temporal dev server',
      command: 'temporal',
      // `--port` sets the frontend gRPC port the client/worker connect to; `--ui-port 0` disables the
      // bundled Web UI so a non-default `--port` never drags the UI onto a colliding port.
      args: ['server', 'start-dev', '--db-filename', layout.temporalSqlite, '--port', String(cfg.temporalPort), '--ui-port', '0'],
      cwd: root,
      port: cfg.temporalPort,
      ui: false,
    },
    worker: workerService,
    daemon: daemonService,
    ui: {
      key: 'ui',
      label: 'Web UI (Vite)',
      command: 'pnpm',
      args: ['--filter', '@awb/web', 'dev'],
      cwd: root,
      port: cfg.uiPort,
      // Vite's /api proxy resolves its target from this at config load; pass the resolved daemon URL
      // so an isolated stack's UI proxies to ITS daemon, not the default 4417.
      env: { AWB_DAEMON_URL: cfg.daemonUrl },
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
