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

/**
 * Sends SIGTERM to a managed service and clears its pid file. Returns whether anything was stopped.
 *
 * Kills the whole PROCESS GROUP, not just the recorded pid. `startService` spawns detached, which
 * makes the child a group leader (PGID == its pid), so `process.kill(-pid, …)` signals the child and
 * every descendant it spawned. This matters for services launched via a `pnpm --filter … dev`
 * wrapper (ui, and worker/daemon in --dev mode): the recorded pid is pnpm's, and pnpm's real work —
 * the `vite`/`tsx` child — runs in the same group but does NOT reliably die when only pnpm is
 * signaled. Killing pnpm alone orphaned vite, which kept holding the UI port and produced the
 * `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` / `Exit status 143` restart loop on the next start. Falls back
 * to a single-pid kill if the group is already gone.
 */
export function stopService(key: ServiceKey): boolean {
  const pid = readServicePid(key);
  if (pid === undefined) return false;
  let stopped = false;
  try {
    // Negative pid = the process group led by `pid` (see the detached spawn in startService).
    process.kill(-pid, 'SIGTERM');
    stopped = true;
  } catch {
    // The group is already gone, or the pid was never a group leader — try the bare pid.
    try {
      process.kill(pid, 'SIGTERM');
      stopped = true;
    } catch {
      // process already gone
    }
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
    // Connect to `localhost`, NOT a hardcoded `127.0.0.1`: Vite binds `localhost` which on this
    // platform resolves to IPv6 `::1` only, so an IPv4-only probe never connects even though the dev
    // server is up — which made `waitForUi` time out (30s silent wait) and the UI report unhealthy.
    // Node resolves `localhost` and tries the returned address families, matching however Vite bound.
    const socket = createConnection({ host: 'localhost', port });
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

/**
 * Streams new lines appended to one or more services' log files to stdout, prefixed with the service
 * key, until `stop()` is called. Used by `--verbose` so the user sees live startup output (vite /
 * daemon / worker) instead of a silent wait on a detached process whose output goes only to a log
 * file. Best-effort: a missing log file is simply skipped until it appears.
 */
export function streamServiceLogs(keys: ServiceKey[]): { stop: () => void } {
  const positions = new Map<ServiceKey, number>();
  for (const key of keys) {
    // Start from the current end so we show only output produced from now on, not the whole history.
    try {
      positions.set(key, existsSync(logPathFor(key)) ? readFileSync(logPathFor(key)).length : 0);
    } catch {
      positions.set(key, 0);
    }
  }
  const label = keys.length > 1;
  const pump = () => {
    for (const key of keys) {
      const path = logPathFor(key);
      if (!existsSync(path)) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(path);
      } catch {
        continue;
      }
      const from = positions.get(key) ?? 0;
      if (buf.length > from) {
        const chunk = buf.subarray(from).toString('utf8');
        const text = label ? chunk.replace(/^(?=.)/gm, `[${key}] `) : chunk;
        process.stdout.write(text);
        positions.set(key, buf.length);
      } else if (buf.length < from) {
        positions.set(key, buf.length); // truncated/rotated
      }
    }
  };
  const interval = setInterval(pump, 200);
  return {
    stop: () => {
      pump(); // flush any final lines
      clearInterval(interval);
    },
  };
}
