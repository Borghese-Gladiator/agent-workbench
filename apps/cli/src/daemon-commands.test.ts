import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliEntry = join(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], dataDir: string): string {
  return execFileSync('node', [cliEntry, ...args], {
    env: { ...process.env, AWB_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

describe('awb daemon CLI', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'awb-cli-daemon-data-'));
  });

  afterEach(() => {
    // Best-effort stop in case a test left a daemon running, then clean up.
    try {
      runCli(['daemon', 'stop'], dataDir);
    } catch {
      // no daemon running — fine
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts a real daemon process and writes a pid file', async () => {
    const output = runCli(['daemon', 'start'], dataDir);
    expect(output).toContain('Daemon started');

    const pidPath = join(dataDir, 'runtime', 'pids', 'daemon.pid');
    expect(existsSync(pidPath)).toBe(true);
    const pid = Number(readFileSync(pidPath, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);

    // Give the daemon a moment to bind before checking health, then confirm it's really up.
    await waitForCondition(async () => {
      try {
        const res = await fetch('http://127.0.0.1:4417/api/health');
        return res.ok;
      } catch {
        return false;
      }
    });
    const health = await fetch('http://127.0.0.1:4417/api/health');
    expect(await health.json()).toEqual({ status: 'ok' });
  }, 15_000);

  it('reports "already running" on a second start without erroring', () => {
    runCli(['daemon', 'start'], dataDir);
    const secondOutput = runCli(['daemon', 'start'], dataDir);
    expect(secondOutput).toContain('already running');
  }, 15_000);

  it('stops a running daemon and removes the pid file', async () => {
    runCli(['daemon', 'start'], dataDir);
    await waitForCondition(async () => {
      try {
        const res = await fetch('http://127.0.0.1:4417/api/health');
        return res.ok;
      } catch {
        return false;
      }
    });

    const stopOutput = runCli(['daemon', 'stop'], dataDir);
    expect(stopOutput).toContain('SIGTERM');

    const pidPath = join(dataDir, 'runtime', 'pids', 'daemon.pid');
    expect(existsSync(pidPath)).toBe(false);
  }, 15_000);

  it('reports a clear message when stopping with no daemon running', () => {
    const output = runCli(['daemon', 'stop'], dataDir);
    expect(output).toContain('No daemon pid file found');
  });
});

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 8000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitForCondition timed out');
}
