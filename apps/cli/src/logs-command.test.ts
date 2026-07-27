import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliEntry = join(__dirname, '..', 'dist', 'index.js');

function runCli(args: string[], dataDir: string): { stdout: string; code: number } {
  try {
    const stdout = execFileSync('node', [cliEntry, ...args], {
      env: { ...process.env, AWB_DATA_DIR: dataDir },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5000,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', code: e.status ?? 1 };
  }
}

function seedLog(dataDir: string, key: string, lineCount: number): void {
  const logsDir = join(dataDir, 'runtime', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
  writeFileSync(join(logsDir, `${key}.log`), `${lines}\n`, 'utf8');
}

describe('awb logs', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'awb-cli-logs-data-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('defaults to the last 50 lines and exits (never follows)', () => {
    seedLog(dataDir, 'daemon', 200);
    const { stdout, code } = runCli(['logs', 'daemon'], dataDir);
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe('line 151');
    expect(lines[49]).toBe('line 200');
    expect(code).toBe(0);
  });

  it('honors --tail', () => {
    seedLog(dataDir, 'worker', 200);
    const { stdout } = runCli(['logs', 'worker', '--tail', '10'], dataDir);
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe('line 191');
  });

  it('errors clearly when the log file does not exist', () => {
    const { code } = runCli(['logs', 'temporal'], dataDir);
    expect(code).not.toBe(0);
  });
});
