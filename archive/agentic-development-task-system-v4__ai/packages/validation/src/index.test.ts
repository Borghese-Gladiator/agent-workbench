import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandValidationRunner, isTestPath, scopeTestCommand } from './index.js';

const runner = new CommandValidationRunner();
const base = { taskId: 'task_1', cwd: process.cwd(), kind: 'test' as const };

describe('CommandValidationRunner', () => {
  it('passes on exit 0 and captures stdout', async () => {
    const res = await runner.run({ ...base, command: 'echo hello && exit 0' });
    expect(res.status).toBe('passed');
    expect(res.output).toContain('hello');
  });

  it('fails on a non-zero exit and captures output', async () => {
    const res = await runner.run({ ...base, command: 'echo boom >&2 && exit 3' });
    expect(res.status).toBe('failed');
    expect(res.output).toContain('boom');
  });

  it('skips an empty command without spawning', async () => {
    const res = await runner.run({ ...base, command: '   ' });
    expect(res.status).toBe('skipped');
    expect(res.output).toBe('');
  });

  it('runs the command in the requested cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-val-'));
    const res = await runner.run({ ...base, cwd: dir, command: 'pwd' });
    expect(res.status).toBe('passed');
    // macOS prefixes tmp paths with /private; match the unique suffix instead.
    expect(res.output).toContain(dir.split('/').pop()!);
  });

  it('fails (not throws) when the command times out', async () => {
    const fast = new CommandValidationRunner(150);
    const res = await fast.run({ ...base, command: 'sleep 5' });
    expect(res.status).toBe('failed');
  });
});

describe('scopeTestCommand', () => {
  it('appends changed test paths to a pytest command', () => {
    expect(scopeTestCommand('bin/pytest -m unit', ['tests/foo/test_bar.py'])).toBe(
      "bin/pytest -m unit 'tests/foo/test_bar.py'",
    );
  });

  it('appends multiple paths', () => {
    expect(scopeTestCommand('pytest', ['a/test_x.py', 'b/test_y.py'])).toBe(
      "pytest 'a/test_x.py' 'b/test_y.py'",
    );
  });

  it('leaves a pytest command unchanged when there are no changed test paths', () => {
    expect(scopeTestCommand('bin/pytest -m unit', [])).toBe('bin/pytest -m unit');
  });

  it('does not touch a non-pytest command (different runner)', () => {
    expect(scopeTestCommand('turbo test', ['src/foo.test.ts'])).toBe('turbo test');
  });

  it('returns an empty/whitespace command unchanged', () => {
    expect(scopeTestCommand('   ', ['tests/test_x.py'])).toBe('   ');
  });

  it('quotes paths containing single quotes safely', () => {
    expect(scopeTestCommand('pytest', ["tests/o'brien_test.py"])).toBe(
      "pytest 'tests/o'\\''brien_test.py'",
    );
  });
});

describe('isTestPath', () => {
  it.each([
    'tests/data/test_catalog.py',
    'src/app/test_thing.py',
    'pkg/thing_test.py',
    'web/src/Button.test.tsx',
    'web/src/Button.spec.ts',
    'apps/test/helpers.py',
  ])('treats %s as a test file', (p) => {
    expect(isTestPath(p)).toBe(true);
  });

  it.each([
    'src/app/datasources/catalog_datasource.py',
    'docs/README.md',
    'src/components/Button.tsx',
    'config/settings.py',
  ])('treats %s as NOT a test file', (p) => {
    expect(isTestPath(p)).toBe(false);
  });
});
