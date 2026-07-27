import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { probeHealth } from '../health.js';
import { UI_PORT, logPathFor } from '../services.js';
import { startService, stopService, waitForUi } from '../process-control.js';
import { ensureRuntime } from './lifecycle.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';

const UI_URL = `http://localhost:${UI_PORT}`;

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function ensureUi(withDeps: boolean): Promise<{ ready: boolean; runtimeReady: boolean }> {
  let runtimeReady = true;
  if (withDeps) {
    const runtime = await ensureRuntime();
    runtimeReady = runtime.ready;
  }
  startService('ui');
  const ready = await waitForUi();
  return { ready, runtimeReady };
}

export function registerUiCommands(program: Command): void {
  program
    .command('open')
    .description('Ensure the UI is running and open it in a browser')
    .action(async () => {
      const { ready, runtimeReady } = await ensureUi(true);
      if (!runtimeReady) {
        printError('runtime unhealthy: cannot start the UI without a healthy runtime');
        printError('Next: awb doctor');
        process.exitCode = 1;
        return;
      }
      if (!ready) {
        printError('ui unhealthy: the frontend did not become reachable in time');
        printError('Next: awb logs ui --tail 50');
        process.exitCode = 1;
        return;
      }
      openBrowser(UI_URL);
      if (outputOptions().json) emitJson({ ok: true, url: UI_URL });
      else printInfo(`ui ready at ${UI_URL}`);
    });

  const ui = program.command('ui').description('Manage the optional frontend');

  ui
    .command('up')
    .description('Start the UI (and its runtime dependencies unless --no-deps)')
    .option('--no-deps', 'Do not start runtime dependencies first (advanced)')
    .action(async (opts: { deps?: boolean }) => {
      const withDeps = opts.deps !== false;
      const { ready, runtimeReady } = await ensureUi(withDeps);
      if (withDeps && !runtimeReady) {
        printError('runtime unhealthy: cannot start the UI without a healthy runtime');
        process.exitCode = 1;
        return;
      }
      if (outputOptions().json) {
        emitJson({ ok: ready, url: ready ? UI_URL : null });
        if (!ready) process.exitCode = 1;
        return;
      }
      if (ready) printInfo(`ui ready at ${UI_URL}`);
      else {
        printError('ui unhealthy: the frontend did not become reachable in time');
        printError('Next: awb logs ui --tail 50');
        process.exitCode = 1;
      }
    });

  ui
    .command('down')
    .description('Stop the UI')
    .action(() => {
      const stopped = stopService('ui');
      if (outputOptions().json) emitJson({ stopped: stopped ? ['ui'] : [] });
      else printInfo(stopped ? 'stopped ui' : 'nothing to stop');
    });

  ui
    .command('restart')
    .description('Restart the UI')
    .action(async () => {
      stopService('ui');
      startService('ui');
      const ready = await waitForUi();
      if (outputOptions().json) emitJson({ ok: ready, url: ready ? UI_URL : null });
      else printInfo(ready ? `ui ready at ${UI_URL}` : 'ui restarted (not yet reachable)');
      if (!ready) process.exitCode = 1;
    });

  ui
    .command('status')
    .description('Show UI health')
    .action(async () => {
      const health = await probeHealth();
      const state = health.services.ui.state;
      if (outputOptions().json) emitJson({ ui: state, url: state === 'ready' ? UI_URL : null });
      else printResult(`ui=${state}`);
      if (state !== 'ready') process.exitCode = 1;
    });

  ui
    .command('logs')
    .description('Show recent UI logs')
    .option('--tail <count>', 'Number of trailing lines to show', '50')
    .action((opts: { tail: string }) => {
      const path = logPathFor('ui');
      if (!existsSync(path)) {
        printError(`No log file for ui yet (${path}).`);
        process.exitCode = 1;
        return;
      }
      const content = readFileSync(path, 'utf8');
      let lines = content.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
      const tail = Number(opts.tail);
      const slice = Number.isNaN(tail) ? lines : lines.slice(-tail);
      for (const line of slice) process.stdout.write(`${line}\n`);
    });
}
