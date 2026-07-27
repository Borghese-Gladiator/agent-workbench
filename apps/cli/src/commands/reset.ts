import { existsSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { resolveLayout } from '@awb/config';
import { runtimeDirs } from '../services.js';
import { stopService } from '../process-control.js';
import { emitJson, outputOptions, printError, printInfo } from '../output.js';
import type { ServiceKey } from '../services.js';

function clearDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir)) {
    unlinkSync(join(dir, entry));
    count += 1;
  }
  return count;
}

export function registerResetCommands(program: Command): void {
  const reset = program.command('reset').description('Reset local state (explicit scope required)');

  reset
    .command('runtime')
    .description('Stop all services and clear pid + log files (keeps databases and config)')
    .action(() => {
      for (const key of ['ui', 'daemon', 'worker', 'temporal'] as ServiceKey[]) stopService(key);
      const { pidsDir, logsDir } = runtimeDirs();
      const pids = clearDir(pidsDir);
      const logs = clearDir(logsDir);
      if (outputOptions().json) emitJson({ clearedPidFiles: pids, clearedLogFiles: logs });
      else printInfo(`reset runtime — cleared ${pids} pid file(s), ${logs} log file(s)`);
    });

  reset
    .command('logs')
    .description('Clear service log files')
    .action(() => {
      const { logsDir } = runtimeDirs();
      const logs = clearDir(logsDir);
      if (outputOptions().json) emitJson({ clearedLogFiles: logs });
      else printInfo(`reset logs — cleared ${logs} log file(s)`);
    });

  reset
    .command('data')
    .description('Delete the workbench database and artifacts (DESTRUCTIVE)')
    .option('--yes', 'Confirm the destructive reset without prompting')
    .action((opts: { yes?: boolean }) => {
      if (opts.yes !== true) {
        printError('reset data is destructive. Re-run with --yes to confirm.');
        process.exitCode = 1;
        return;
      }
      const layout = resolveLayout();
      const removed: string[] = [];
      for (const dir of [layout.databaseDir, layout.artifactsDir]) {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        }
      }
      if (outputOptions().json) emitJson({ removed });
      else printInfo(`reset data — removed ${removed.length} path(s)`);
    });
}
