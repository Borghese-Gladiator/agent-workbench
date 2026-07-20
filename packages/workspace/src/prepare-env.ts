import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { RepositoryUnit } from '@awb/domain';

export interface CommandExecutor {
  (command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }>;
}

/** Default executor: shells out via `node:child_process`. Tests should inject a fake instead. */
export const defaultExecutor: CommandExecutor = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed in ${options.cwd}: ${stderr || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

export interface PrepareEnvironmentResult {
  ran: boolean;
  command?: string;
  args?: string[];
}

function resolveInstallCommand(unit: RepositoryUnit): { command: string; args: string[] } | undefined {
  if (unit.language !== 'typescript' && unit.language !== 'mixed') return undefined;

  const manager = unit.packageManager?.toLowerCase();
  if (manager === 'pnpm') return { command: 'pnpm', args: ['install'] };
  if (manager === 'yarn') return { command: 'yarn', args: ['install'] };
  if (manager === 'npm') return { command: 'npm', args: ['install'] };

  // No declared packageManager: default to npm, the lowest-common-denominator installer that
  // works against any package.json regardless of which lockfile (if any) is present.
  return { command: 'npm', args: ['install'] };
}

/**
 * Prepares a task's worktree environment for a given repository unit. For the MVP this means:
 * if the unit is a Node/TS unit (has a package.json), run the repo's normal install command in
 * the worktree. Non-TS units (pure Python, etc.) are a no-op here — Python env prep is out of
 * scope for this package's MVP.
 *
 * The executor is injectable so unit tests can assert on decision logic and command construction
 * without ever shelling out; only an explicit integration-style test should pass the real
 * `defaultExecutor`.
 */
export async function prepareEnvironment(
  worktreePath: string,
  unit: RepositoryUnit,
  executor: CommandExecutor = defaultExecutor,
): Promise<PrepareEnvironmentResult> {
  const resolved = resolveInstallCommand(unit);
  if (!resolved) return { ran: false };

  const cwd = unit.root === '.' ? worktreePath : join(worktreePath, unit.root);
  await executor(resolved.command, resolved.args, { cwd });
  return { ran: true, command: resolved.command, args: resolved.args };
}
