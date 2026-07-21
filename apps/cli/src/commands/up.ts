import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { resolveLayout } from '@awb/config';

const DAEMON_PORT = 4417;
const HEALTH_URL = `http://127.0.0.1:${DAEMON_PORT}/api/health`;

interface ManagedProcess {
  key: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
}

function repoRoot(): string {
  return resolve(new URL('../../../..', import.meta.url).pathname);
}

function managedProcesses(): ManagedProcess[] {
  const root = repoRoot();
  const layout = resolveLayout();
  return [
    {
      key: 'temporal',
      label: 'Temporal dev server',
      command: 'temporal',
      args: ['server', 'start-dev', '--db-filename', layout.temporalSqlite],
      cwd: root,
    },
    {
      key: 'worker',
      label: 'Temporal worker',
      command: 'pnpm',
      args: ['--filter', '@awb/temporal-worker', 'dev'],
      cwd: root,
    },
    {
      key: 'daemon',
      label: 'Daemon (Fastify API)',
      command: 'pnpm',
      args: ['--filter', '@awb/daemon', 'dev'],
      cwd: root,
    },
  ];
}

function runtimeDirs(): { pidsDir: string; logsDir: string } {
  const layout = resolveLayout();
  const logsDir = join(layout.runtimeDir, 'logs');
  mkdirSync(layout.runtimePidsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return { pidsDir: layout.runtimePidsDir, logsDir };
}

function pidPathFor(key: string): string {
  return join(runtimeDirs().pidsDir, `${key}.pid`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(key: string): number | undefined {
  const path = pidPathFor(key);
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isNaN(pid) ? undefined : pid;
}

async function waitForHealth(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {
      // daemon not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startOne(proc: ManagedProcess): void {
  const existing = readPid(proc.key);
  if (existing !== undefined && isAlive(existing)) {
    console.log(`${proc.label} already running (pid ${existing}).`);
    return;
  }

  const { logsDir } = runtimeDirs();
  const logFd = openSync(join(logsDir, `${proc.key}.log`), 'a');
  const child = spawn(proc.command, proc.args, {
    cwd: proc.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  if (child.pid !== undefined) {
    writeFileSync(pidPathFor(proc.key), String(child.pid), 'utf8');
    console.log(`Started ${proc.label} (pid ${child.pid}).`);
  } else {
    console.error(`Failed to start ${proc.label}: no pid assigned.`);
    process.exitCode = 1;
  }
}

function stopOne(proc: ManagedProcess): void {
  const pid = readPid(proc.key);
  if (pid === undefined) {
    console.log(`${proc.label}: no pid file — not tracked as running.`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to ${proc.label} (pid ${pid}).`);
  } catch (err) {
    console.error(`Could not stop ${proc.label}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    const path = pidPathFor(proc.key);
    if (existsSync(path)) unlinkSync(path);
  }
}

export function registerUpDown(program: Command): void {
  program
    .command('up')
    .description('Boot the full stack (Temporal, worker, daemon) and wait for the daemon to be healthy')
    .action(async () => {
      for (const proc of managedProcesses()) {
        startOne(proc);
      }
      process.stdout.write('Waiting for the daemon to become healthy… ');
      const healthy = await waitForHealth();
      if (healthy) {
        console.log('ready.');
        console.log(`Daemon: http://127.0.0.1:${DAEMON_PORT}  —  logs in ${runtimeDirs().logsDir}`);
      } else {
        console.error(`timed out. Check logs in ${runtimeDirs().logsDir}.`);
        process.exitCode = 1;
      }
    });

  program
    .command('down')
    .description('Stop the daemon, worker, and Temporal dev server started by `awb up`')
    .action(() => {
      for (const proc of [...managedProcesses()].reverse()) {
        stopOne(proc);
      }
    });
}
