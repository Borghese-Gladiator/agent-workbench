import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from '@awb/execution';
import { createReadOnlyDatabase } from '@awb/database';
import { initDataDir } from '@awb/config';
import {
  getRepositoryCommands,
  getRepository,
  runGit,
  getChangedPaths,
  discoverCommands,
  resolveRunCommand,
  type RunCommandSource,
} from '@awb/repository';
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
 * Resolves the registered repository's canonical on-disk path. The plan phase
 * runs BEFORE prepare materializes the task worktree, so without this the planner would inspect the
 * workbench's own repo (process.cwd()) instead of the target — the observed effect was a planner
 * that reported "no games in this repo" while planning against the wrong tree. Returns undefined
 * when the repo is unknown, so the caller keeps its process.cwd() fallback.
 */
export async function resolveRepositoryPath(repositoryId: string): Promise<string | undefined> {
  const { layout } = initDataDir();
  const database = createReadOnlyDatabase(layout.workbenchSqlite);
  try {
    const repo = await getRepository(database.db, repositoryId);
    return repo?.canonicalPath;
  } finally {
    database.close();
  }
}

/**
 * Resolves the repository's real discovered verification commands, replacing the hardcoded
 * `echo ok`. Returns the `unit-test` and `build` commands from the latest snapshot, cwd-rebased to
 * the task worktree so they run against the candidate diff. Returns [] when discovery found none
 * (the caller then keeps its placeholder / treats it as nothing-to-verify).
 */
export async function resolveVerificationCommands(input: {
  repositoryId: string;
  worktreePath: string;
}): Promise<ValidatedCommand[]> {
  const { layout } = initDataDir();
  const database = createReadOnlyDatabase(layout.workbenchSqlite);
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
  const database = createReadOnlyDatabase(layout.workbenchSqlite);
  try {
    const all = await getRepositoryCommands(database.db, repositoryId);
    return all.find((c) => c.purpose === 'install')?.command;
  } finally {
    database.close();
  }
}

/**
 * Resolves the repository's discovered dev-server start command (purpose `start`), if any, for the
 * browser-QA path. Returns the command string cwd-rebased implicitly via the caller's
 * worktree, or undefined when the repo has no discovered start command.
 */
export async function resolveStartCommand(repositoryId: string): Promise<string | undefined> {
  const { layout } = initDataDir();
  const database = createReadOnlyDatabase(layout.workbenchSqlite);
  try {
    const all = await getRepositoryCommands(database.db, repositoryId);
    return all.find((c) => c.purpose === 'start')?.command;
  } finally {
    database.close();
  }
}

/**
 * A resolved start command for the browser-QA path. `serves: true` carries the `baseUrl` a browser
 * loads; `serves: false` is a one-shot run / CLI / compiled binary (captured for a future non-browser
 * QA consumer, never driven by `waitForServer`). Mirrors `@awb/repository`'s `ResolvedRunCommand`, with
 * the extra `repository-commands` / `worktree-discovery` sources for the persisted/discovered tiers.
 */
export type ResolvedStartCommand =
  | { command: string; serves: true; baseUrl: string; source: RunCommandSource | 'repository-commands' | 'worktree-discovery' }
  | { command: string; serves: false; source: RunCommandSource | 'repository-commands' | 'worktree-discovery' };

/**
 * Resolves a run command for a task worktree, for the browser-QA path (TASK-65).
 *
 * A greenfield task starts against an EMPTY repo, so `repository_commands` (populated by `repo
 * refresh` from the registered snapshot) has no `start` row — the runnable form of the app only exists
 * *after* implement, in the worktree. This resolves against the worktree in tiers so `exercise` has a
 * real target without a human hand-inserting a `start` row into SQLite:
 *   1. the persisted `repository_commands` `start` (a pre-existing repo that already ships a dev server);
 *   2. fresh discovery over the worktree (`discoverCommands` maps a package.json `start`/`dev` script
 *      to purpose `start`), for an app that produced its own scripts;
 *   3. comprehensive, cross-ecosystem inference (`@awb/repository`'s `resolveRunCommand`): explicit run
 *      declarations first (Procfile / docker-compose / Make-Task-just / Pipfile / pyproject scripts),
 *      then framework/convention inference (Django/FastAPI/Flask, Next/Vite/CRA, Spring Boot, Go http),
 *      then a bare language default — each tagged `serves` (a web server vs a CLI/binary).
 *
 * Returns undefined only when no tier recognizes the project at all; the caller then keeps its CLI
 * fallback. Tiers 1-2 are assumed to be servers (a discovered `start`/`dev` script is a dev server);
 * tier 3 carries its own `serves` tag.
 */
export async function resolveStartCommandForWorktree(input: {
  repositoryId: string;
  worktreePath: string;
  /** The browser baseUrl the caller intends to use (env/default); inference matches its port when set. */
  requestedBaseUrl?: string;
}): Promise<ResolvedStartCommand | undefined> {
  const baseUrl = input.requestedBaseUrl ?? 'http://localhost:5173';

  const persisted = await resolveStartCommand(input.repositoryId);
  if (persisted) {
    return { command: persisted, serves: true, baseUrl, source: 'repository-commands' };
  }

  const discovered = (await discoverCommands(input.worktreePath)).find((c) => c.purpose === 'start');
  if (discovered) {
    return { command: discovered.command, serves: true, baseUrl, source: 'worktree-discovery' };
  }

  return resolveRunCommand(input.worktreePath, { requestedBaseUrl: input.requestedBaseUrl });
}

/**
 * Computes the real candidate diff + changed paths from the worktree, replacing the
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

/**
 * Computes the changed-line + changed-file counts for a `base..head` range via `git diff --numstat`
 * (velocity guardrail). Binary files report `-` for adds/dels in numstat — those rows count
 * toward the file total but contribute 0 lines. Returns zeros on any git error so the guardrail never
 * crashes a phase (a missing range simply reads as "no diff", i.e. under any cap).
 */
export async function resolveDiffNumstat(input: {
  worktreePath: string;
  baseSha: string;
  headSha: string;
}): Promise<{ changedLines: number; changedFiles: number }> {
  try {
    const { stdout } = await runGit(input.worktreePath, ['diff', '--numstat', `${input.baseSha}..${input.headSha}`]);
    const rows = stdout.split('\n').filter((line) => line.trim().length > 0);
    let changedLines = 0;
    for (const row of rows) {
      const [added, deleted] = row.split('\t');
      changedLines += (Number.parseInt(added ?? '', 10) || 0) + (Number.parseInt(deleted ?? '', 10) || 0);
    }
    return { changedLines, changedFiles: rows.length };
  } catch {
    return { changedLines: 0, changedFiles: 0 };
  }
}
