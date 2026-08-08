import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { logPathFor, pidPathFor, serviceDefinition, uiPort, type ServiceKey } from './services.js';
import { resolveRuntimeConfig } from '@awb/config';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readServicePid(key: ServiceKey): number | undefined {
  const path = pidPathFor(key);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isNaN(pid) ? undefined : pid;
}

export function isServiceRunning(key: ServiceKey): boolean {
  const pid = readServicePid(key);
  return pid !== undefined && isAlive(pid);
}

/** Spawns a managed service detached, redirecting its output to the service log. No-op if already running. */
export function startService(key: ServiceKey): { started: boolean; pid?: number } {
  const existing = readServicePid(key);
  if (existing !== undefined && isAlive(existing)) {
    return { started: false, pid: existing };
  }
  const def = serviceDefinition(key);
  const logFd = openSync(logPathFor(key), 'a');
  const child = spawn(def.command, def.args, {
    cwd: def.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    // Merge any service-specific env (e.g. the OTLP endpoint for worker/daemon) over the inherited env.
    env: def.env ? { ...process.env, ...def.env } : process.env,
  });
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`Failed to start ${def.label}: no pid assigned.`);
  }
  writeFileSync(pidPathFor(key), String(child.pid), 'utf8');
  return { started: true, pid: child.pid };
}

/** Sends SIGTERM to a managed service and clears its pid file. Returns whether anything was stopped. */
export function stopService(key: ServiceKey): boolean {
  const pid = readServicePid(key);
  if (pid === undefined) return false;
  let stopped = false;
  try {
    process.kill(pid, 'SIGTERM');
    stopped = true;
  } catch {
    // process already gone
  } finally {
    const path = pidPathFor(key);
    if (existsSync(path)) unlinkSync(path);
  }
  return stopped;
}

/** Waits for the daemon to answer /api/health, the last of the runtime services to come up. */
export async function waitForDaemonHealth(timeoutMs = 30_000): Promise<boolean> {
  const healthUrl = `${resolveRuntimeConfig().daemonUrl}/api/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
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

/** Waits for the Vite dev server to accept connections on the UI port. */
export async function waitForUi(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(uiPort())) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
