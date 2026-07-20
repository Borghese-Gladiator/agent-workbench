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
});
