import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '@awb/execution';
import { createDatabase } from '@awb/database';
import { initDataDir } from '@awb/config';
import { getRepositoryCommands, getRepository, runGit, getChangedPaths } from '@awb/repository';
import type { ValidatedCommand, CommandPurpose } from '@awb/domain';

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Installs the worktree's dependencies during prepare (a real live-run blocker: a fresh
 * `git worktree` has no `node_modules`, so verify's `vite build` failed with "Cannot find package
 * 'vite'"). Uses the repo's discovered `install` command when present, else a package-manager
 * default inferred from the lockfile in the worktree. Node-ecosystem only for now — repos without a
 * recognized lockfile are treated as nothing-to-install (returns true) rather than failing prepare.
 * Runs with the worker's real env so the package manager resolves on PATH.
 */
export async function installWorktreeDependencies(input: {
  repositoryId: string;
  worktreePath: string;
  timeoutMs?: number;
}): Promise<{ ran: boolean; ok: boolean; command?: string }> {
  const discovered = await resolveInstallCommand(input.repositoryId);
  const command = discovered ?? defaultInstallCommand(input.worktreePath);
  if (!command) return { ran: false, ok: true };

  const [executable, ...args] = command.split(/\s+/);
  const result = await runCommand({
    command: executable ?? command,
    args,
    cwd: input.worktreePath,
    env: inheritedEnv(),
    timeoutMs: input.timeoutMs ?? 600_000,
  });
  return { ran: true, ok: result.exitCode === 0, command };
}

/** Infers the install command from the lockfile present in the worktree. Undefined = nothing to do. */
function defaultInstallCommand(worktreePath: string): string | undefined {
  if (existsSync(join(worktreePath, 'pnpm-lock.yaml'))) return 'pnpm install';
  if (existsSync(join(worktreePath, 'yarn.lock'))) return 'yarn install';
  if (existsSync(join(worktreePath, 'package-lock.json'))) return 'npm install';
  if (existsSync(join(worktreePath, 'package.json'))) return 'npm install';
  return undefined;
}

/**
 * Resolves the registered repository's canonical on-disk path (Fix: planner cwd). The plan phase
 * runs BEFORE prepare materializes the task worktree, so without this the planner would inspect the
 * workbench's own repo (process.cwd()) instead of the target — the observed effect was a planner
 * that reported "no games in this repo" while planning against the wrong tree. Returns undefined
 * when the repo is unknown, so the caller keeps its process.cwd() fallback.
 */
export async function resolveRepositoryPath(repositoryId: string): Promise<string | undefined> {
  const { layout } = initDataDir();
  const database = createDatabase(layout.workbenchSqlite);
  try {
    const repo = await getRepository(database.db, repositoryId);
    return repo?.canonicalPath;
  } finally {
    database.close();
  }
}

/**
 * Resolves the repository's real discovered verification commands (Fix 2), replacing the hardcoded
 * `echo ok`. Returns the `unit-test` and `build` commands from the latest snapshot, cwd-rebased to
 * the task worktree so they run against the candidate diff. Returns [] when discovery found none
 * (the caller then keeps its placeholder / treats it as nothing-to-verify).
 */
export async function resolveVerificationCommands(input: {
  repositoryId: string;
  worktreePath: string;
}): Promise<ValidatedCommand[]> {
  const { layout } = initDataDir();
  const database = createDatabase(layout.workbenchSqlite);
  try {
    const all = await getRepositoryCommands(database.db, input.repositoryId);
    const verifyPurposes: CommandPurpose[] = ['unit-test', 'build'];
    return all
      .filter((c) => verifyPurposes.includes(c.purpose))
      .map((c) => ({ ...c, cwd: input.worktreePath }));
  } finally {
    database.close();
  }
}

/**
 * Resolves the repository's discovered dependency-install command (purpose `install`), if any.
 * The prepare phase runs this in the fresh worktree so verify/QA don't fail on missing
 * `node_modules` (a real live-run blocker: a `git worktree` has no deps of its own, so `vite build`
 * failed with "Cannot find package 'vite'"). Returns undefined when discovery found no install
 * command; the caller then falls back to a sensible default per package manager.
 */
export async function resolveInstallCommand(repositoryId: string): Promise<string | undefined> {
  const { layout } = initDataDir();
  const database = createDatabase(layout.workbenchSqlite);
  try {
    const all = await getRepositoryCommands(database.db, repositoryId);
    return all.find((c) => c.purpose === 'install')?.command;
  } finally {
    database.close();
  }
}

/**
 * Resolves the repository's discovered dev-server start command (purpose `start`), if any, for the
 * browser-QA path (Fix 5). Returns the command string cwd-rebased implicitly via the caller's
 * worktree, or undefined when the repo has no discovered start command.
 */
export async function resolveStartCommand(repositoryId: string): Promise<string | undefined> {
  const { layout } = initDataDir();
  const database = createDatabase(layout.workbenchSqlite);
  try {
    const all = await getRepositoryCommands(database.db, repositoryId);
    return all.find((c) => c.purpose === 'start')?.command;
  } finally {
    database.close();
  }
}

/**
 * Computes the real candidate diff + changed paths from the worktree (Fix 4), replacing the
 * hardcoded placeholder diff string handed to the adversarial reviewer. Uses `baseSha..candidateSha`
 * so the reviewer sees exactly what the builder produced. Returns an empty diff on any git error
 * (e.g. no real commit yet), so the reviewer still runs rather than the phase crashing.
 */
export async function resolveReviewDiff(input: {
  worktreePath: string;
  baseSha: string;
  candidateSha: string;
}): Promise<{ diff: string; changedPaths: string[] }> {
  try {
    const { stdout } = await runGit(input.worktreePath, ['diff', `${input.baseSha}..${input.candidateSha}`]);
    const changedPaths = await getChangedPaths(input.worktreePath, input.baseSha, input.candidateSha);
    return { diff: stdout, changedPaths };
  } catch {
    return { diff: '', changedPaths: [] };
  }
}
