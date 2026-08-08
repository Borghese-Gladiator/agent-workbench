import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { ensureDataDir, resolveDataDir, isolatedOverrides, resolveRuntimeConfig } from '@awb/config';
import { probeHealth, type RuntimeHealth, type ServiceHealth } from '../health.js';
import { RUNTIME_SERVICES, logPathFor, repoRoot, type ServiceKey } from '../services.js';
import { startService, stopService, waitForDaemonHealth } from '../process-control.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';
import { parseDuration } from '../duration.js';

const ALL_SERVICES: ServiceKey[] = ['otel', 'temporal', 'worker', 'daemon', 'ui'];

function isServiceKey(value: string): value is ServiceKey {
  return (ALL_SERVICES as string[]).includes(value);
}

function formatUptime(ms?: number): string {
  if (ms === undefined) return '—';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
}

/** Starts the three runtime services (idempotent) and waits for the daemon to answer health. */
async function ensureRuntime(): Promise<{ ready: boolean; alreadyReady: boolean; elapsedMs: number }> {
  const start = Date.now();
  const before = await probeHealth();
  if (before.runtime === 'ready') {
    return { ready: true, alreadyReady: true, elapsedMs: Date.now() - start };
  }
  // Provision the data dir BEFORE starting Temporal. Temporal's `start-dev --db-filename
  // <dataDir>/temporal/temporal.sqlite` crashes ("failed checking dir for database file") if the
  // `temporal/` subdir does not exist yet, and the daemon (the only other caller of initDataDir)
  // starts LAST in RUNTIME_SERVICES — so on a fresh AWB_DATA_DIR the subdir must be created here.
  ensureDataDir();
  for (const key of RUNTIME_SERVICES) {
    startService(key);
  }
  const ready = await waitForDaemonHealth();
  return { ready, alreadyReady: false, elapsedMs: Date.now() - start };
}

/**
 * Populate the isolation env overrides (ports/queue/OTel-container/data-dir) derived from THIS
 * checkout's workspace root, so an isolated stack occupies a deterministic slot with a low collision
 * probability for typical local usage. Sets
 * only vars not already set (an explicit override the user passed still wins), and must run before
 * any service def / health probe resolves its config. Returns the applied overrides for reporting.
 */
function applyIsolation(): Record<string, string> {
  const dataDirBase = process.env.AWB_DATA_DIR ?? join(homedir(), '.agentic-workbench');
  const overrides = isolatedOverrides(repoRoot(), dataDirBase);
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return overrides;
}

export function registerLifecycleCommands(program: Command): void {
  program
    .command('up')
    .description('Start the core runtime (OTel collector, Temporal, worker, daemon) and wait until healthy')
    .option('--dev', 'Run worker + daemon from live source via tsx watch (hot reload) instead of pinned dist')
    .option(
      '--isolated',
      'Derive a deterministic port block + task queue + OTel container + data dir from this checkout, so N worktrees run concurrent stacks without collision',
    )
    .action(async (opts: { dev?: boolean; isolated?: boolean }) => {
      if (opts.dev === true) process.env.AWB_RUNTIME_MODE = 'dev';
      if (opts.isolated === true) applyIsolation();
      const cfg = resolveRuntimeConfig();
      const { ready, alreadyReady, elapsedMs } = await ensureRuntime();
      const stack = {
        daemonUrl: cfg.daemonUrl,
        temporalAddress: cfg.temporalAddress,
        taskQueue: cfg.taskQueue,
        dataDir: resolveDataDir(),
      };
      if (outputOptions().json) {
        emitJson({ ok: ready, runtime: ready ? 'ready' : 'unhealthy', alreadyReady, isolated: opts.isolated === true, stack });
        if (!ready) process.exitCode = 1;
        return;
      }
      if (!ready) {
        printError(`daemon unhealthy: health check timed out`);
        printError('Next: awb logs daemon --tail 50');
        process.exitCode = 1;
        return;
      }
      if (opts.isolated === true) {
        printInfo(`isolated stack: daemon ${stack.daemonUrl}, temporal ${stack.temporalAddress}, queue ${stack.taskQueue}`);
        printInfo(`data dir: ${stack.dataDir}`);
      }
      if (alreadyReady) {
        printInfo('runtime already ready');
      } else {
        printInfo(`runtime ready (temporal, worker, daemon) [${(elapsedMs / 1000).toFixed(1)}s]`);
      }
    });

  program
    .command('down')
    .description('Stop all AWB-managed local services')
    .action(() => {
      // Stop UI first, then runtime in reverse start order, so dependents die before their deps. The
      // OTel collector started first (so worker/daemon saw its endpoint), so it stops last.
      const order: ServiceKey[] = ['ui', 'daemon', 'worker', 'temporal', 'otel'];
      const stopped = order.filter((key) => stopService(key));
      if (outputOptions().json) {
        emitJson({ stopped });
        return;
      }
      if (stopped.length === 0) {
        printInfo('nothing to stop');
        return;
      }
      printInfo(`stopped ${stopped.join(', ')}`);
    });

  program
    .command('restart [service]')
    .description('Restart the runtime or one service')
    .action(async (service: string | undefined) => {
      if (service === undefined) {
        for (const key of ['daemon', 'worker', 'temporal'] as ServiceKey[]) stopService(key);
        const { ready, elapsedMs } = await ensureRuntime();
        if (outputOptions().json) {
          emitJson({ ok: ready, runtime: ready ? 'ready' : 'unhealthy' });
          if (!ready) process.exitCode = 1;
          return;
        }
        if (ready) printInfo(`runtime restarted (temporal, worker, daemon) [${(elapsedMs / 1000).toFixed(1)}s]`);
        else {
          printError('daemon unhealthy: health check timed out');
          printError('Next: awb logs daemon --tail 50');
          process.exitCode = 1;
        }
        return;
      }
      if (!isServiceKey(service)) {
        printError(`Unknown service "${service}". Known: ${ALL_SERVICES.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      stopService(service);
      startService(service);
      // The daemon is the health gate for the runtime; wait when it (or a dep) was restarted.
      if (service === 'daemon' || service === 'worker' || service === 'temporal') {
        await waitForDaemonHealth();
      }
      if (outputOptions().json) emitJson({ restarted: service });
      else printInfo(`restarted ${service}`);
    });

  program
    .command('status [service]')
    .description('Show runtime and service health')
    .option('--verbose', 'Show a per-service table with pid, port, and uptime')
    .action(async (service: string | undefined, opts: { verbose?: boolean }) => {
      if (service !== undefined && !isServiceKey(service)) {
        printError(`Unknown service "${service}". Known: ${ALL_SERVICES.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      const health = await probeHealth();
      const runtimeUnhealthy = health.runtime !== 'ready';

      if (outputOptions().json) {
        emitJson(toJson(health, service as ServiceKey | undefined));
        if (runtimeUnhealthy) process.exitCode = 1;
        return;
      }

      const verbose = opts.verbose === true || outputOptions().verbose;
      if (verbose) {
        printVerboseTable(health, service as ServiceKey | undefined);
      } else if (service) {
        printResult(`${service}=${health.services[service as ServiceKey].state}`);
      } else {
        const parts = [`runtime=${health.runtime}`, ...ALL_SERVICES.map((k) => `${k}=${health.services[k].state}`)];
        printResult(parts.join(' '));
      }
      // Exit nonzero when the required runtime is unhealthy so `status` doubles as a health check.
      if (runtimeUnhealthy) process.exitCode = 1;
    });

  program
    .command('logs [service]')
    .description('Show recent service logs')
    .option('--tail <count>', 'Number of trailing lines to show', '50')
    .option('--since <duration>', 'Only show lines newer than this (e.g. 10m)')
    .option('-f, --follow', 'Stream new log lines (does not exit)')
    .action(async (service: string | undefined, opts: { tail: string; since?: string; follow?: boolean }) => {
      const target = service ?? 'daemon';
      if (!isServiceKey(target)) {
        printError(`Unknown service "${target}". Known: ${ALL_SERVICES.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      const path = logPathFor(target);
      if (!existsSync(path)) {
        printError(`No log file for ${target} yet (${path}).`);
        process.exitCode = 1;
        return;
      }
      const tail = Number(opts.tail);
      const sinceMs = opts.since ? parseDuration(opts.since) : undefined;
      printRecentLines(path, tail, sinceMs);
      if (opts.follow) {
        await followLog(path);
      }
    });
}

function toJson(health: RuntimeHealth, only: ServiceKey | undefined): unknown {
  const services = only
    ? { [only]: serviceJson(health.services[only]) }
    : Object.fromEntries(ALL_SERVICES.map((k) => [k, serviceJson(health.services[k])]));
  return {
    ok: health.runtime === 'ready',
    runtime: health.runtime,
    services: only ? services : Object.fromEntries(ALL_SERVICES.map((k) => [k, health.services[k].state])),
    ...(only ? { detail: services } : {}),
  };
}

function serviceJson(s: ServiceHealth): Record<string, unknown> {
  return { state: s.state, pid: s.pid ?? null, port: s.port ?? null, uptimeMs: s.uptimeMs ?? null };
}

function printVerboseTable(health: RuntimeHealth, only: ServiceKey | undefined): void {
  const keys = only ? [only] : ALL_SERVICES;
  const header = ['SERVICE', 'STATUS', 'PID', 'PORT', 'UPTIME'];
  const rows = keys.map((k) => {
    const s = health.services[k];
    return [k, s.state, s.pid ? String(s.pid) : '—', s.port ? String(s.port) : '—', formatUptime(s.uptimeMs)];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  printResult(fmt(header));
  for (const row of rows) printResult(fmt(row));
}

function printRecentLines(path: string, tail: number, sinceMs: number | undefined): void {
  const content = readFileSync(path, 'utf8');
  let lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  if (sinceMs !== undefined) {
    const cutoff = Date.now() - sinceMs;
    lines = lines.filter((line) => {
      const ts = Date.parse(line.slice(0, 24));
      return Number.isNaN(ts) ? true : ts >= cutoff;
    });
  }
  const slice = Number.isNaN(tail) ? lines : lines.slice(-tail);
  for (const line of slice) process.stdout.write(`${line}\n`);
}

async function followLog(path: string): Promise<void> {
  const { watch } = await import('node:fs');
  let position = readFileSync(path).length;
  await new Promise<void>(() => {
    watch(path, () => {
      const buf = readFileSync(path);
      if (buf.length > position) {
        process.stdout.write(buf.subarray(position).toString('utf8'));
        position = buf.length;
      } else if (buf.length < position) {
        position = buf.length; // truncated/rotated
      }
    });
    // Never resolves — follow runs until the user interrupts.
  });
}

// Re-exported for reuse by open/ui commands.
export { ensureRuntime };
