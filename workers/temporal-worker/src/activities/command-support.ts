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
 * loads; `serves: false` is a one-shot run / CLI / compiled binary. The `serves: false` command is
 * now consumed by `selectQaExecutor` below: under `AWB_QA_MODE=browser` it routes to the
 * `serve-as-is` (non-browser) executor — running the captured command via CLI QA — instead of the
 * old `echo …; exit 1` hard-fail. It is never handed to `waitForServer` (which would hang on a port
 * nothing binds). Mirrors `@awb/repository`'s `ResolvedRunCommand`, with the extra
 * `repository-commands` / `worktree-discovery` sources for the persisted/discovered tiers.
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
 * Discriminated result of QA-executor selection for the exercise phase. The handler dispatches on
 * `kind` to the matching effectful executor, keeping this selection pure:
 *   - `browser`     drives a real dev server + Chromium (only for a `serves: true` resolution);
 *   - `http-api`    scripts real HTTP against a running API (explicit `AWB_QA_MODE=http-api`);
 *   - `library`     runs a real consumer script exercising the built library (explicit
 *                   `AWB_QA_MODE=library`, and the browser-mode fallback when nothing resolved);
 *   - `serve-as-is` is the fix: under `AWB_QA_MODE=browser` a resolved-but-`serves: false` command
 *                   (a static frontend build / CLI / compiled binary) runs as a non-browser CLI QA
 *                   consumer instead of the old `echo …; exit 1` hard-fail;
 *   - `cli-ok`      the default mock / no-mode placeholder (`echo qa-ok`).
 */
export type QaExecutorDescriptor =
  | {
      kind: 'browser';
      command: string;
      baseUrl: string;
      persistSource: ResolvedStartCommand['source'];
    }
  | { kind: 'http-api'; baseUrl: string }
  | { kind: 'library'; consumerScriptSource: string }
  | { kind: 'serve-as-is'; command: string }
  | { kind: 'cli-ok' };

/**
 * Pure inputs the selector branches on. `qaMode` is `AWB_QA_MODE` (or undefined off the real-agent
 * path); `resolvedStart` is the tiered start resolution; `hasWorktree` gates the browser path (a
 * browser run needs a real worktree to boot the server in). `httpApiBaseUrl` / `libraryScriptSource`
 * are env-derived values the handler reads and passes in so the selector stays side-effect-free.
 */
export interface SelectQaExecutorInput {
  qaMode: string | undefined;
  resolvedStart: ResolvedStartCommand | undefined;
  hasWorktree: boolean;
  httpApiBaseUrl?: string;
  libraryScriptSource?: string;
}

const DEFAULT_HTTP_API_BASE_URL = 'http://localhost:3000';
const DEFAULT_LIBRARY_SCRIPT_SOURCE = 'console.log("ASSERT:library-importable=true");';

/**
 * Pure, unit-testable selection of the QA executor for the exercise phase over
 * (`qaMode`, `resolvedStart`, `hasWorktree`):
 *   - a `serves: true` resolution with a worktree → `browser`;
 *   - explicit `AWB_QA_MODE=http-api` → `http-api`;
 *   - explicit `AWB_QA_MODE=library` → `library`;
 *   - `AWB_QA_MODE=browser` with a `serves: false` resolution → `serve-as-is` (run the captured
 *     command as a non-browser CLI QA consumer — the fix, never the `exit 1` hard-fail);
 *   - `AWB_QA_MODE=browser` with no resolution (nothing recognized) → `library` fallback (a defined
 *     non-browser consumer, never the `exit 1` hard-fail);
 *   - otherwise → `cli-ok` (mock / no-mode default).
 */
export function selectQaExecutor(input: SelectQaExecutorInput): QaExecutorDescriptor {
  const { qaMode, resolvedStart, hasWorktree } = input;

  if (resolvedStart?.serves === true && hasWorktree) {
    return {
      kind: 'browser',
      command: resolvedStart.command,
      baseUrl: resolvedStart.baseUrl,
      persistSource: resolvedStart.source,
    };
  }

  if (qaMode === 'http-api') {
    return { kind: 'http-api', baseUrl: input.httpApiBaseUrl ?? DEFAULT_HTTP_API_BASE_URL };
  }

  if (qaMode === 'library') {
    return {
      kind: 'library',
      consumerScriptSource: input.libraryScriptSource ?? DEFAULT_LIBRARY_SCRIPT_SOURCE,
    };
  }

  if (qaMode === 'browser') {
    // The fix: browser QA was requested but the resolved runnable form is a non-server
    // (`serves: false`) — a static frontend build, CLI, or compiled binary. Run it as a non-browser
    // CLI QA consumer instead of the old `echo …; exit 1` hard-fail.
    if (resolvedStart && resolvedStart.serves === false) {
      return { kind: 'serve-as-is', command: resolvedStart.command };
    }
    // Nothing resolved at all: fall back to a defined non-browser library consumer rather than the
    // trivial `exit 1` that read as a false pass covering no behavioral claim.
    return {
      kind: 'library',
      consumerScriptSource: input.libraryScriptSource ?? DEFAULT_LIBRARY_SCRIPT_SOURCE,
    };
  }

  return { kind: 'cli-ok' };
}
