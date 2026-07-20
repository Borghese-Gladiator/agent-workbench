import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveLayout } from '@awb/config';

const DAEMON_PORT = 4417;

function pidFilePath(): string {
  const layout = resolveLayout();
  mkdirSync(layout.runtimePidsDir, { recursive: true });
  return join(layout.runtimePidsDir, 'daemon.pid');
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('Manage the local daemon process');

  daemon
    .command('start')
    .description('Start the local daemon in the background')
    .action(() => {
      const pidPath = pidFilePath();
      if (existsSync(pidPath)) {
        const existingPid = Number(readFileSync(pidPath, 'utf8').trim());
        try {
          process.kill(existingPid, 0);
          console.log(`Daemon already running (pid ${existingPid}).`);
          return;
        } catch {
          unlinkSync(pidPath);
        }
      }

      const daemonEntry = new URL('../../../daemon/dist/index.js', import.meta.url).pathname;
      const child = spawn(process.execPath, [daemonEntry], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      if (child.pid !== undefined) {
        writeFileSync(pidPath, String(child.pid), 'utf8');
        console.log(`Daemon started (pid ${child.pid}) on http://127.0.0.1:${DAEMON_PORT}`);
      } else {
        console.error('Failed to start daemon: no pid assigned.');
        process.exitCode = 1;
      }
    });

  daemon
    .command('stop')
    .description('Stop the running local daemon')
    .action(() => {
      const pidPath = pidFilePath();
      if (!existsSync(pidPath)) {
        console.log('No daemon pid file found — is the daemon running?');
        return;
      }
      const pid = Number(readFileSync(pidPath, 'utf8').trim());
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Sent SIGTERM to daemon (pid ${pid}).`);
      } catch (err) {
        console.error(`Could not stop daemon: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        unlinkSync(pidPath);
      }
    });
}
