import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const cliEntry = join(__dirname, '..', 'dist', 'index.js');

describe('awb CLI', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'awb-cli-data-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('awb init creates the data directory', () => {
    // mkdtempSync already creates `dataDir` itself, so point AWB_DATA_DIR at a not-yet-existing
    // child of it to genuinely exercise the "first access" branch.
    const freshDir = join(dataDir, 'awb-root');
    const output = execFileSync('node', [cliEntry, 'init'], {
      env: { ...process.env, AWB_DATA_DIR: freshDir },
      encoding: 'utf8',
    });
    expect(output).toContain('Initialized');
    expect(existsSync(join(freshDir, 'config.yaml'))).toBe(true);
  });

  it('unimplemented stub commands exit non-zero with a clear message', () => {
    expect(() =>
      execFileSync('node', [cliEntry, 'repo', 'add'], {
        env: { ...process.env, AWB_DATA_DIR: dataDir },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  // TASK-9: the contract/plan approval version options must NOT collide with commander's global
  // `--version` (which prints "0.1.0" and no-ops). They were renamed to `--contract-version` /
  // `--plan-version`; passing them must reach the daemon-request layer, not the version short-circuit.
  it('approve-contract --contract-version reaches the daemon (no --version collision)', () => {
    let output = '';
    try {
      output = execFileSync('node', [cliEntry, 'task', 'approve-contract', 'r', 't', '--contract-version', '1'], {
        env: { ...process.env, AWB_DATA_DIR: dataDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      output = (err as { stdout?: string; stderr?: string }).stdout ?? '';
      output += (err as { stderr?: string }).stderr ?? '';
    }
    expect(output).not.toContain('0.1.0');
    expect(output).toContain('daemon');
  });

  // TASK-10: a single leading `--` (injected by `pnpm … cli -- <args>`) must be stripped so
  // subcommand options like `--prompt` pass through instead of being swallowed by commander's
  // options terminator.
  it('strips a leading -- so --prompt passes through', () => {
    let output = '';
    try {
      output = execFileSync('node', [cliEntry, '--', 'task', 'create', 'r', '--prompt', 'hello'], {
        env: { ...process.env, AWB_DATA_DIR: dataDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      output = (err as { stdout?: string; stderr?: string }).stdout ?? '';
      output += (err as { stderr?: string }).stderr ?? '';
    }
    expect(output).not.toContain("required option '--prompt");
    expect(output).toContain('daemon');
  });

  it('approve-plan --plan-version reaches the daemon (no --version collision)', () => {
    let output = '';
    try {
      output = execFileSync('node', [cliEntry, 'task', 'approve-plan', 'r', 't', '--plan-version', '1'], {
        env: { ...process.env, AWB_DATA_DIR: dataDir },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      output = (err as { stdout?: string; stderr?: string }).stdout ?? '';
      output += (err as { stderr?: string }).stderr ?? '';
    }
    expect(output).not.toContain('0.1.0');
    expect(output).toContain('daemon');
  });
});
