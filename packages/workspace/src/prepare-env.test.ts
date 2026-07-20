import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepositoryUnit } from '@awb/domain';
import { prepareEnvironment, defaultExecutor } from './prepare-env.js';

function makeUnit(overrides: Partial<RepositoryUnit> = {}): RepositoryUnit {
  return {
    id: 'unit-1',
    root: '.',
    language: 'typescript',
    kind: 'library',
    dependsOn: [],
    ...overrides,
  };
}

describe('prepareEnvironment', () => {
  it('is a no-op for a pure python unit', async () => {
    const calls: unknown[] = [];
    const result = await prepareEnvironment('/some/worktree', makeUnit({ language: 'python' }), async (...args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    expect(result.ran).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['pnpm', ['install']],
    ['yarn', ['install']],
    ['npm', ['install']],
  ] as const)('runs "%s %s" for a typescript unit declaring that package manager', async (manager, args) => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const result = await prepareEnvironment(
      '/some/worktree',
      makeUnit({ packageManager: manager }),
      async (command, cmdArgs, options) => {
        calls.push({ command, args: cmdArgs, cwd: options.cwd });
        return { stdout: '', stderr: '' };
      },
    );
    expect(result).toEqual({ ran: true, command: manager, args: [...args] });
    expect(calls).toEqual([{ command: manager, args: [...args], cwd: '/some/worktree' }]);
  });

  it('defaults to npm install when no packageManager is declared on a typescript unit', async () => {
    const calls: unknown[] = [];
    const result = await prepareEnvironment('/some/worktree', makeUnit(), async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: '', stderr: '' };
    });
    expect(result).toEqual({ ran: true, command: 'npm', args: ['install'] });
  });

  it('joins the unit root onto the worktree path for a nested unit', async () => {
    let seenCwd = '';
    await prepareEnvironment('/some/worktree', makeUnit({ root: 'packages/foo' }), async (_cmd, _args, options) => {
      seenCwd = options.cwd;
      return { stdout: '', stderr: '' };
    });
    expect(seenCwd).toBe(join('/some/worktree', 'packages/foo'));
  });

  it('treats a "mixed" language unit as needing install too', async () => {
    const result = await prepareEnvironment('/some/worktree', makeUnit({ language: 'mixed' }), async () => ({
      stdout: '',
      stderr: '',
    }));
    expect(result.ran).toBe(true);
  });

  describe('defaultExecutor (real exec, no mocks)', () => {
    let dir: string;

    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('executes a trivial no-op command and resolves', async () => {
      dir = await mkdtemp(join(tmpdir(), 'awb-workspace-exec-'));
      const result = await defaultExecutor('node', ['-e', 'process.exit(0)'], { cwd: dir });
      expect(result.stdout).toBe('');
    });
  });
});
