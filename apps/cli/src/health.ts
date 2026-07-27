import { readFileSync, existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { DAEMON_PORT, UI_PORT, pidPathFor, serviceDefinitions, type ServiceKey } from './services.js';

export type ServiceState = 'stopped' | 'starting' | 'ready' | 'unhealthy' | 'external' | 'unknown';

export interface ServiceHealth {
  key: ServiceKey;
  state: ServiceState;
  pid?: number;
  port?: number;
  /** ms since the pid file was written, our best proxy for uptime. */
  uptimeMs?: number;
}

export interface RuntimeHealth {
  runtime: ServiceState;
  services: Record<ServiceKey, ServiceHealth>;
}

const DAEMON_STATUS_URL = `http://127.0.0.1:${DAEMON_PORT}/api/status`;

interface DaemonStatusResponse {
  runtime: string;
  services: { temporal: string; worker: string; daemon: string };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(key: ServiceKey): { pid: number; uptimeMs: number } | undefined {
  const path = pidPathFor(key);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf8').trim());
  if (Number.isNaN(pid)) return undefined;
  let uptimeMs: number | undefined;
  try {
    uptimeMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    uptimeMs = undefined;
  }
  return { pid, uptimeMs: uptimeMs ?? 0 };
}

async function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function fetchDaemonStatus(): Promise<DaemonStatusResponse | undefined> {
  try {
    const res = await fetch(DAEMON_STATUS_URL);
    // 503 is expected when the runtime is degraded — the body still carries per-service state.
    const body = (await res.json()) as Partial<DaemonStatusResponse>;
    // Guard against an older daemon (or a 404 error body) that lacks the per-service shape.
    if (!body || typeof body.services !== 'object' || body.services === null) return undefined;
    const { temporal, worker, daemon } = body.services;
    if (typeof temporal !== 'string' || typeof worker !== 'string' || typeof daemon !== 'string') return undefined;
    return { runtime: body.runtime ?? 'unknown', services: { temporal, worker, daemon } };
  } catch {
    return undefined;
  }
}

function normalize(state: string): ServiceState {
  return state === 'ready' ? 'ready' : state === 'unhealthy' ? 'unhealthy' : 'unknown';
}

/**
 * Determines the state of a runtime service (temporal/worker) when the daemon itself is down and
 * cannot report on it. We fall back to the PID file: a tracked, alive process is `starting`
 * (running but not yet confirmed healthy end to end); no pid means `stopped`.
 */
function pidFallbackState(key: ServiceKey): ServiceHealth {
  const pidInfo = readPid(key);
  if (pidInfo && isAlive(pidInfo.pid)) {
    return { key, state: 'starting', pid: pidInfo.pid, uptimeMs: pidInfo.uptimeMs };
  }
  return { key, state: 'stopped' };
}

async function uiHealth(): Promise<ServiceHealth> {
  const pidInfo = readPid('ui');
  const listening = await portOpen(UI_PORT);
  const port = UI_PORT;
  if (pidInfo && isAlive(pidInfo.pid)) {
    return { key: 'ui', state: listening ? 'ready' : 'starting', pid: pidInfo.pid, port, uptimeMs: pidInfo.uptimeMs };
  }
  // Port answered but AWB has no pid for it → an external process owns it.
  if (listening) return { key: 'ui', state: 'external', port };
  return { key: 'ui', state: 'stopped', port };
}

/**
 * Aggregates the health of every managed service. The daemon's /api/status is authoritative for the
 * three runtime services when it is reachable; otherwise we fall back to PID files. The UI is always
 * derived CLI-side from its port + pid file.
 */
export async function probeHealth(): Promise<RuntimeHealth> {
  const defs = serviceDefinitions();
  const status = await fetchDaemonStatus();

  let temporal: ServiceHealth;
  let worker: ServiceHealth;
  let daemon: ServiceHealth;

  if (status) {
    const pidT = readPid('temporal');
    const pidW = readPid('worker');
    const pidD = readPid('daemon');
    temporal = { key: 'temporal', state: normalize(status.services.temporal), pid: pidT?.pid, port: defs.temporal.port, uptimeMs: pidT?.uptimeMs };
    worker = { key: 'worker', state: normalize(status.services.worker), pid: pidW?.pid, uptimeMs: pidW?.uptimeMs };
    daemon = { key: 'daemon', state: normalize(status.services.daemon), pid: pidD?.pid, port: defs.daemon.port, uptimeMs: pidD?.uptimeMs };
  } else {
    // Daemon unreachable. Its own port tells us whether something external holds it.
    temporal = { ...pidFallbackState('temporal'), port: defs.temporal.port };
    worker = pidFallbackState('worker');
    const daemonPidInfo = readPid('daemon');
    if (daemonPidInfo && isAlive(daemonPidInfo.pid)) {
      daemon = { key: 'daemon', state: 'unhealthy', pid: daemonPidInfo.pid, port: defs.daemon.port, uptimeMs: daemonPidInfo.uptimeMs };
    } else if (await portOpen(DAEMON_PORT)) {
      daemon = { key: 'daemon', state: 'external', port: defs.daemon.port };
    } else {
      daemon = { key: 'daemon', state: 'stopped', port: defs.daemon.port };
    }
  }

  const ui = await uiHealth();

  const runtimeReady = temporal.state === 'ready' && worker.state === 'ready' && daemon.state === 'ready';
  const anyStarting = [temporal, worker, daemon].some((s) => s.state === 'starting');
  const allStopped = [temporal, worker, daemon].every((s) => s.state === 'stopped');
  const runtime: ServiceState = runtimeReady
    ? 'ready'
    : allStopped
      ? 'stopped'
      : anyStarting
        ? 'starting'
        : 'unhealthy';

  return { runtime, services: { temporal, worker, daemon, ui } };
}
