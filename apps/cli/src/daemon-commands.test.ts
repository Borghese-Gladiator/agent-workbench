import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliEntry = join(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], dataDir: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('node', [cliEntry, ...args], {
      env: { ...process.env, AWB_DATA_DIR: dataDir },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status ?? 1 };
  }
}

describe('awb daemon CLI', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'awb-cli-daemon-data-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // The daemon listens on a fixed port shared across data dirs, so a dev machine may or may not have
  // one running. Assert the command's contract (valid JSON with an `ok` boolean, exit agreeing with
  // it) rather than a fixed reachable/unreachable verdict.
  it('daemon ping --json emits a machine-readable ok boolean', () => {
    const { stdout, code } = runCli(['daemon', 'ping', '--json'], dataDir);
    const parsed = JSON.parse(stdout) as { ok: boolean };
    expect(typeof parsed.ok).toBe('boolean');
    expect(code === 0).toBe(parsed.ok);
  });
});
