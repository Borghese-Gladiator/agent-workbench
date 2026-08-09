import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  readPackageJson,
  findPythonManifests,
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

export interface ResolvedStartCommand {
  command: string;
  /** The URL the app is expected to serve once started, so browser QA drives the right host/port. */
  baseUrl: string;
  source: 'repository-commands' | 'worktree-discovery' | 'framework-inference';
}

/**
 * Resolves a dev-server start command for a task worktree, for the browser-QA path (TASK-65).
 *
 * A greenfield task starts against an EMPTY repo, so `repository_commands` (populated by `repo
 * refresh` from the registered snapshot) has no `start` row — the runnable form of the app only exists
 * *after* implement, in the worktree. This resolves against the worktree in three tiers so `exercise`
 * has a real target without a human hand-inserting a `start` row into SQLite:
 *   1. the persisted `repository_commands` `start` (a pre-existing repo that already ships a dev server);
 *   2. fresh discovery over the worktree (`discoverCommands` maps a package.json `start`/`dev` script
 *      to purpose `start`), for an app that produced its own scripts;
 *   3. framework inference from the produced project shape (a FastAPI app → `uvicorn`, a Vite/Node app
 *      with no start script → the package-manager `dev` runner), for the common greenfield MVP.
 *
 * Returns undefined only when no tier yields a runnable target; the caller then keeps its CLI fallback.
 */
export async function resolveStartCommandForWorktree(input: {
  repositoryId: string;
  worktreePath: string;
  /** The browser baseUrl the caller intends to use (env/default); inference matches its port when set. */
  requestedBaseUrl?: string;
}): Promise<ResolvedStartCommand | undefined> {
  const persisted = await resolveStartCommand(input.repositoryId);
  if (persisted) {
    return { command: persisted, baseUrl: input.requestedBaseUrl ?? 'http://localhost:5173', source: 'repository-commands' };
  }

  const discovered = (await discoverCommands(input.worktreePath)).find((c) => c.purpose === 'start');
  if (discovered) {
    return {
      command: discovered.command,
      baseUrl: input.requestedBaseUrl ?? 'http://localhost:5173',
      source: 'worktree-discovery',
    };
  }

  return inferStartCommandFromWorktree(input.worktreePath, input.requestedBaseUrl);
}

function portFromUrl(url: string | undefined, fallback: number): number {
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number.parseInt(parsed.port, 10);
    return parsed.protocol === 'https:' ? 443 : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Infers a start command from a produced project's shape when neither the DB nor package.json scripts
 * carry one. Recognizes a FastAPI ASGI app (a `FastAPI(` at a conventional module path → `uvicorn`)
 * and a Vite/Node app (a `package.json` + `index.html`, or a `vite` dependency → the package-manager
 * dev runner). Returns undefined for an unrecognized shape.
 */
export async function inferStartCommandFromWorktree(
  worktreePath: string,
  requestedBaseUrl?: string,
): Promise<ResolvedStartCommand | undefined> {
  const fastApi = await inferFastApiModulePath(worktreePath);
  if (fastApi) {
    const port = portFromUrl(requestedBaseUrl, 8000);
    return {
      command: `python -m uvicorn ${fastApi}:app --host 127.0.0.1 --port ${port}`,
      baseUrl: `http://127.0.0.1:${port}`,
      source: 'framework-inference',
    };
  }

  const pkg = await readPackageJson(worktreePath);
  if (pkg) {
    const isVite =
      existsSync(join(worktreePath, 'index.html')) ||
      Boolean(pkg.dependencies?.vite) ||
      Boolean(pkg.devDependencies?.vite);
    if (isVite) {
      const packageManager = pkg.packageManager?.split('@')[0] ?? 'npm';
      const runner = packageManager === 'yarn' ? 'yarn' : packageManager === 'pnpm' ? 'pnpm' : 'npm run';
      const port = portFromUrl(requestedBaseUrl, 5173);
      return {
        command: `${runner} dev -- --host 127.0.0.1 --port ${port}`,
        baseUrl: `http://127.0.0.1:${port}`,
        source: 'framework-inference',
      };
    }
  }

  return undefined;
}

/**
 * Finds the module path of a FastAPI app instance (`app = FastAPI(...)`) at a conventional location,
 * returned in `uvicorn` dotted-module form (e.g. `app.main` for `app/main.py`). Undefined when no
 * FastAPI app is found — the repo is not a FastAPI service.
 */
async function inferFastApiModulePath(worktreePath: string): Promise<string | undefined> {
  const manifests = await findPythonManifests(worktreePath);
  if (manifests.length === 0) return undefined;
  const candidates = [
    { file: 'app/main.py', module: 'app.main' },
    { file: 'main.py', module: 'main' },
    { file: 'src/main.py', module: 'src.main' },
    { file: 'app/app.py', module: 'app.app' },
  ];
  for (const { file, module } of candidates) {
    const path = join(worktreePath, file);
    if (!existsSync(path)) continue;
    try {
      const raw = await readFile(path, 'utf8');
      if (/\bFastAPI\s*\(/.test(raw) && /\bapp\s*=/.test(raw)) return module;
    } catch {
      continue;
    }
  }
  return undefined;
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
