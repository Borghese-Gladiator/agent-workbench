import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { resolveRuntimeConfig } from '@awb/config';
import { stopService, startService, waitForDaemonHealth } from '../process-control.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';

const daemonHealthUrl = (): string => `${resolveRuntimeConfig().daemonUrl}/api/health`;

function repoRoot(): string {
  return resolve(new URL('../../../..', import.meta.url).pathname);
}

/**
 * Daemon-specific operations only. Generic process management (start/stop/status) lives on the
 * shared lifecycle commands: `awb status daemon`, `awb logs daemon`, `awb restart daemon`.
 */
export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('Daemon-specific operations');

  daemon
    .command('run')
    .description('Run the daemon in the foreground (does not detach)')
    .action(() => {
      const child = spawn('pnpm', ['--filter', '@awb/daemon', 'start'], {
        cwd: repoRoot(),
        stdio: 'inherit',
      });
      child.on('exit', (code) => {
        process.exitCode = code ?? 0;
      });
    });

  daemon
    .command('ping')
    .description('Check whether the daemon is answering on its health endpoint')
    .action(async () => {
      try {
        const res = await fetch(daemonHealthUrl());
        const ok = res.ok;
        if (outputOptions().json) emitJson({ ok, status: res.status });
        else printResult(ok ? 'pong' : `daemon responded ${res.status}`);
        if (!ok) process.exitCode = 1;
      } catch {
        if (outputOptions().json) emitJson({ ok: false });
        else printError('daemon not reachable');
        process.exitCode = 1;
      }
    });

  daemon
    .command('reload')
    .description('Restart the daemon process in place')
    .action(async () => {
      stopService('daemon');
      startService('daemon');
      const ready = await waitForDaemonHealth();
      if (outputOptions().json) emitJson({ ok: ready });
      else printInfo(ready ? 'daemon reloaded' : 'daemon reloaded (not yet healthy)');
      if (!ready) process.exitCode = 1;
    });
}
