import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig, resolveLayout } from '@awb/config';
import { probeHealth } from '../health.js';
import { DAEMON_PORT, TEMPORAL_PORT, UI_PORT, pidPathFor, runtimeDirs, type ServiceKey } from '../services.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';

type CheckStatus = 'pass' | 'warn' | 'error';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Optional repair applied when --fix is set. */
  fixed?: boolean;
}

function which(bin: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose dependencies, ports, and local state')
    .option('--fix', 'Apply conservative repairs (stale pid files, missing directories)')
    .action(async (opts: { fix?: boolean }) => {
      const fix = opts.fix === true;
      const layout = resolveLayout();
      const checks: CheckResult[] = [];

      // Node version.
      const nodeMajor = Number(process.versions.node.split('.')[0]);
      checks.push({
        name: 'node version',
        status: nodeMajor >= 20 ? 'pass' : 'error',
        detail: `node ${process.versions.node}`,
      });

      // Required binaries.
      for (const bin of ['pnpm', 'temporal', 'git']) {
        checks.push({
          name: `binary: ${bin}`,
          status: which(bin) ? 'pass' : bin === 'temporal' ? 'error' : 'warn',
          detail: which(bin) ? 'found' : 'not found on PATH',
        });
      }

      // Data directory presence + log dir writability.
      if (!existsSync(layout.root)) {
        if (fix) {
          mkdirSync(layout.root, { recursive: true });
          checks.push({ name: 'data directory', status: 'pass', detail: `created ${layout.root}`, fixed: true });
        } else {
          checks.push({ name: 'data directory', status: 'warn', detail: `missing (${layout.root}) — run awb init` });
        }
      } else {
        checks.push({ name: 'data directory', status: 'pass', detail: layout.root });
      }

      const { logsDir } = runtimeDirs();
      try {
        accessSync(logsDir, constants.W_OK);
        checks.push({ name: 'log directory writable', status: 'pass', detail: logsDir });
      } catch {
        checks.push({ name: 'log directory writable', status: 'error', detail: `not writable: ${logsDir}` });
      }

      // Config validity.
      if (existsSync(layout.configFile)) {
        try {
          loadConfig(layout);
          checks.push({ name: 'config valid', status: 'pass', detail: layout.configFile });
        } catch (err) {
          checks.push({ name: 'config valid', status: 'error', detail: err instanceof Error ? err.message : String(err) });
        }
      } else {
        checks.push({ name: 'config valid', status: 'warn', detail: 'no config.yaml — run awb init' });
      }

      // Stale pid files: pid file present but process gone.
      for (const key of ['temporal', 'worker', 'daemon', 'ui'] as ServiceKey[]) {
        const path = pidPathFor(key);
        if (!existsSync(path)) continue;
        const pid = Number(readFileSync(path, 'utf8').trim());
        if (!Number.isNaN(pid) && !pidAlive(pid)) {
          if (fix) {
            unlinkSync(path);
            checks.push({ name: `stale pid: ${key}`, status: 'pass', detail: `removed ${path}`, fixed: true });
          } else {
            checks.push({ name: `stale pid: ${key}`, status: 'warn', detail: `pid ${pid} not running (${path})` });
          }
        }
      }

      // Port conflicts: a port held by something AWB does not track.
      const health = await probeHealth();
      for (const [key, port] of [
        ['daemon', DAEMON_PORT],
        ['temporal', TEMPORAL_PORT],
        ['ui', UI_PORT],
      ] as [ServiceKey, number][]) {
        const svc = health.services[key];
        if (svc.state === 'external') {
          checks.push({ name: `port ${port} (${key})`, status: 'warn', detail: 'occupied by an external process' });
        }
      }

      // Runtime connectivity, from the daemon's own view.
      checks.push({
        name: 'temporal connectivity',
        status: health.services.temporal.state === 'ready' ? 'pass' : health.services.temporal.state === 'stopped' ? 'warn' : 'error',
        detail: health.services.temporal.state,
      });
      checks.push({
        name: 'daemon health',
        status:
          health.services.daemon.state === 'ready'
            ? 'pass'
            : health.services.daemon.state === 'stopped' || health.services.daemon.state === 'external'
              ? 'warn'
              : 'error',
        detail: health.services.daemon.state,
      });
      checks.push({
        name: 'worker registration',
        status: health.services.worker.state === 'ready' ? 'pass' : health.services.worker.state === 'stopped' ? 'warn' : 'error',
        detail: health.services.worker.state,
      });
      checks.push({
        name: 'ui ↔ daemon',
        status: health.services.ui.state === 'ready' || health.services.ui.state === 'stopped' ? 'pass' : 'warn',
        detail: health.services.ui.state,
      });

      const passed = checks.filter((c) => c.status === 'pass').length;
      const warnings = checks.filter((c) => c.status === 'warn').length;
      const errors = checks.filter((c) => c.status === 'error').length;

      if (outputOptions().json) {
        emitJson({ passed, warnings, errors, checks });
        if (errors > 0) process.exitCode = 1;
        return;
      }

      if (outputOptions().verbose) {
        for (const c of checks) {
          const tag = c.status === 'pass' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'ERR ';
          printResult(`${tag} ${c.name}: ${c.detail}${c.fixed ? ' (fixed)' : ''}`);
        }
      } else {
        for (const c of checks.filter((c) => c.status !== 'pass')) {
          const line = `${c.status}: ${c.name} — ${c.detail}${c.fixed ? ' (fixed)' : ''}`;
          if (c.status === 'error') printError(line);
          else printInfo(line);
        }
      }
      printInfo(`doctor: ${passed} passed, ${warnings} warning${warnings === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}`);
      if (errors > 0) process.exitCode = 1;
    });
}
