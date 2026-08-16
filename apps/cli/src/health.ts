import { readFileSync, existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { daemonPort, uiPort, otelOtlpPort, pidPathFor, serviceDefinitions, type ServiceKey } from './services.js';
import { resolveRuntimeConfig } from '@awb/config';

export type ServiceState = 'stopped' | 'starting' | 'ready' | 'unhealthy' | 'external' | 'unknown';

export interface ServiceHealth {
  key: ServiceKey;
  state: ServiceState;
  pid?: number;
  port?: number;
  /** ms since the pid file was written, our best proxy for uptime. */
  uptimeMs?: number;
}

/**
 * The runtime-shaping env the running stack booted with, as reported by the daemon's /api/status
 * (TASK-70). Lets `up`/`status` show whether a warm stack is actually running `claude` vs a silent
 * `mock`, and with what QA mode — the visibility a driver needs before creating a task.
 * Undefined when the daemon is unreachable or is an older build without the field.
 */
export interface RuntimeConfigHealth {
  agentRuntime: string;
  qaMode: string | null;
}

export interface RuntimeHealth {
  runtime: ServiceState;
  services: Record<ServiceKey, ServiceHealth>;
  runtimeConfig?: RuntimeConfigHealth;
}

const daemonStatusUrl = (): string => `${resolveRuntimeConfig().daemonUrl}/api/status`;

interface DaemonStatusResponse {
  runtime: string;
  services: { temporal: string; worker: string; daemon: string };
  runtimeConfig?: RuntimeConfigHealth;
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
    const res = await fetch(daemonStatusUrl());
    // 503 is expected when the runtime is degraded — the body still carries per-service state.
    const body = (await res.json()) as Partial<DaemonStatusResponse>;
    // Guard against an older daemon (or a 404 error body) that lacks the per-service shape.
    if (!body || typeof body.services !== 'object' || body.services === null) return undefined;
    const { temporal, worker, daemon } = body.services;
    if (typeof temporal !== 'string' || typeof worker !== 'string' || typeof daemon !== 'string') return undefined;
    return { runtime: body.runtime ?? 'unknown', services: { temporal, worker, daemon }, runtimeConfig: body.runtimeConfig };
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
  const port = uiPort();
  const listening = await portOpen(port);
  if (pidInfo && isAlive(pidInfo.pid)) {
    return { key: 'ui', state: listening ? 'ready' : 'starting', pid: pidInfo.pid, port, uptimeMs: pidInfo.uptimeMs };
  }
  // Port answered but AWB has no pid for it → an external process owns it.
  if (listening) return { key: 'ui', state: 'external', port };
  return { key: 'ui', state: 'stopped', port };
}

/**
 * The OTel collector's health, derived CLI-side like the UI: ready when its OTLP port answers under an
 * AWB-tracked pid. The collector is diagnostics-only (ADR-008), so it is NOT part of the runtime-ready
 * gate — a run proceeds whether or not it is up.
 */
async function otelHealth(): Promise<ServiceHealth> {
  const pidInfo = readPid('otel');
  const port = otelOtlpPort();
  const listening = await portOpen(port);
  if (pidInfo && isAlive(pidInfo.pid)) {
    return { key: 'otel', state: listening ? 'ready' : 'starting', pid: pidInfo.pid, port, uptimeMs: pidInfo.uptimeMs };
  }
  if (listening) return { key: 'otel', state: 'external', port };
  return { key: 'otel', state: 'stopped', port };
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
    } else if (await portOpen(daemonPort())) {
      daemon = { key: 'daemon', state: 'external', port: defs.daemon.port };
    } else {
      daemon = { key: 'daemon', state: 'stopped', port: defs.daemon.port };
    }
  }

  const ui = await uiHealth();
  const otel = await otelHealth();

  // The OTel collector is diagnostics-only (ADR-008) and deliberately excluded from the runtime-ready
  // gate — telemetry being down must never block a run.
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

  return { runtime, services: { temporal, worker, daemon, ui, otel }, runtimeConfig: status?.runtimeConfig };
}
