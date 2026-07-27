import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { resolveLayout } from '@awb/config';

export const DAEMON_PORT = 4417;
export const TEMPORAL_PORT = 7233;
export const UI_PORT = 5317;

export type ServiceKey = 'temporal' | 'worker' | 'daemon' | 'ui';

/** Services that make up the core runtime, in start order. `ui` is intentionally excluded. */
export const RUNTIME_SERVICES: ServiceKey[] = ['temporal', 'worker', 'daemon'];

export interface ServiceDefinition {
  key: ServiceKey;
  label: string;
  /** The process AWB spawns. */
  command: string;
  args: string[];
  cwd: string;
  /** TCP port the service listens on, if any (worker has none). */
  port?: number;
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
      ui: false,
    },
    daemon: {
      key: 'daemon',
      label: 'Daemon (Fastify API)',
      command: 'pnpm',
      args: ['--filter', '@awb/daemon', 'dev'],
      cwd: root,
      port: DAEMON_PORT,
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
