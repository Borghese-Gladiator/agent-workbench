import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  registerRepository,
  approveRepository,
  getRepository,
  listRepositories,
  refreshRepositorySnapshot,
  getLatestSnapshot,
  findRepositoryByCanonicalPath,
  unregisterRepository,
} from '@awb/repository';
import type { Repository } from '@awb/domain';
import { listTasks, deleteTask } from '@awb/database';
import { loadConfig, resolveLayout } from '@awb/config';
import { openWorkbenchDatabase } from '../db.js';
import { rememberRepositoryId, resolveRepositoryId } from '../remembered.js';
import { emitJson, outputOptions, printError, printInfo, printResult } from '../output.js';

/** `[]` when `awb init` hasn't run yet — registration itself doesn't require a config.yaml. */
function loadEnterpriseRepoRoots(): string[] {
  const layout = resolveLayout();
  if (!existsSync(layout.configFile)) return [];
  return loadConfig(layout).enterpriseRepoRoots;
}

/** Resolves the git top-level for a path, so `repo add .` registers the repo root, not a subdir. */
export function gitTopLevel(path: string): string | undefined {
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolves a repo reference to an id. A path-like ref (".", "./x", absolute) is matched against the
 * registry by its git top-level; anything else is treated as an id, falling back to the last used.
 */
export async function resolveRepoRef(ref: string | undefined): Promise<string> {
  const db = openWorkbenchDatabase().db;
  if (ref === '.' || ref?.startsWith('./') || ref?.startsWith('/') || ref?.startsWith('../')) {
    const top = gitTopLevel(resolve(ref));
    if (!top) throw new Error(`${ref} is not inside a Git repository`);
    const found = await findRepositoryByCanonicalPath(db, top);
    if (!found) throw new Error(`No registered repository at ${top}. Run \`awb repo add .\` first.`);
    return found.id;
  }
  return resolveRepositoryId(ref);
}

function printRepoLine(r: Repository): void {
  printResult(`${r.id}  ${r.trusted ? '[trusted]  ' : '[untrusted]'}  ${r.name}  ${r.canonicalPath}`);
}

export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Manage registered repositories');

  repo
    .command('add [path]')
    .description('Register a local Git repository (defaults to the current directory)')
    .option('--name <name>', 'Display name for the repository')
    // TASK-104: trust is a one-time config flag, so registering and trusting in one step is the
    // normal path for a repo you already own. A task on an untrusted repo is refused up front.
    .option('--trust', 'Also mark the repository trusted, so tasks may run against it')
    .action(async (path: string | undefined, opts: { name?: string; trust?: boolean }) => {
      const db = openWorkbenchDatabase().db;
      const target = resolve(path ?? '.');
      const canonicalPath = gitTopLevel(target) ?? target;
      const repository = await registerRepository(db, {
        canonicalPath,
        name: opts.name,
        enterpriseRepoRoots: loadEnterpriseRepoRoots(),
      });
      rememberRepositoryId(repository.id);
      if (opts.trust) await approveRepository(db, repository.id);
      if (outputOptions().json) {
        emitJson({ ...repository, trusted: opts.trust === true });
        return;
      }
      printResult(repository.id);
      if (opts.trust) {
        printInfo(`Registered ${repository.name} — trusted.`);
        printInfo(`Next: awb repo sync ${repository.id}`);
      } else {
        printInfo(`Registered ${repository.name} — untrusted until approved.`);
        printInfo(`Next: awb repo sync ${repository.id} && awb repo trust ${repository.id}`);
      }
    });

  repo
    .command('list')
    .alias('ls')
    .description('List registered repositories')
    .action(async () => {
      const db = openWorkbenchDatabase().db;
      const repositories = await listRepositories(db);
      if (outputOptions().json) {
        emitJson(repositories);
        return;
      }
      if (repositories.length === 0) {
        printInfo('No repositories registered yet. Use `awb repo add`.');
        return;
      }
      for (const r of repositories) printRepoLine(r);
    });

  repo
    .command('show [repo]')
    .alias('inspect')
    .description('Show details for a repository (path, id, or the last one used)')
    .action(async (ref: string | undefined) => {
      const db = openWorkbenchDatabase().db;
      const id = await resolveRepoRef(ref);
      const repository = await getRepository(db, id);
      if (!repository) {
        printError(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      const snapshot = await getLatestSnapshot(db, id);
      emitJson({ repository, latestSnapshot: snapshot });
    });

  repo
    .command('current')
    .description('Print the repository registered for the current directory')
    .action(async () => {
      const db = openWorkbenchDatabase().db;
      const top = gitTopLevel(process.cwd());
      if (!top) {
        printError('Not inside a Git repository.');
        process.exitCode = 1;
        return;
      }
      const found = await findRepositoryByCanonicalPath(db, top);
      if (!found) {
        printError(`No registered repository at ${top}. Run \`awb repo add .\` first.`);
        process.exitCode = 1;
        return;
      }
      if (outputOptions().json) emitJson(found);
      else printRepoLine(found);
    });

  repo
    .command('sync [repo]')
    .alias('refresh')
    .description('Run discovery and record a new repository snapshot')
    .action(async (ref: string | undefined) => {
      const db = openWorkbenchDatabase().db;
      const id = await resolveRepoRef(ref);
      const repository = await getRepository(db, id);
      if (!repository) {
        printError(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      const snapshot = await refreshRepositorySnapshot(db, repository);
      if (outputOptions().json) emitJson(snapshot);
      else
        printInfo(
          `Recorded snapshot ${snapshot.id} at ${snapshot.headSha.slice(0, 12)} — ${snapshot.units.length} unit(s), ${snapshot.commands.length} command(s).`,
        );
    });

  repo
    .command('trust [repo]')
    .alias('approve')
    // TASK-104: this is the ONLY trust decision in the system. It is made once, here, out of band —
    // never mid-run. `approve` stays as an alias so existing scripts keep working.
    .description('Mark a repository trusted, so tasks may run against it')
    .action(async (ref: string | undefined) => {
      const db = openWorkbenchDatabase().db;
      const id = await resolveRepoRef(ref);
      const repository = await getRepository(db, id);
      if (!repository) {
        printError(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      await approveRepository(db, id);
      if (outputOptions().json) emitJson({ id, trusted: true });
      else printInfo(`Repository ${id} is now trusted.`);
    });

  repo
    .command('remove [repo]')
    .alias('rm')
    .description('Unregister a repository (does not delete its files)')
    .option('--yes', 'Skip the confirmation prompt')
    .option('--with-tasks', "Also delete the repository's tasks (otherwise they would be orphaned)")
    .action(async (ref: string | undefined, opts: { yes?: boolean; withTasks?: boolean }) => {
      const db = openWorkbenchDatabase().db;
      const id = await resolveRepoRef(ref);
      const repository = await getRepository(db, id);
      if (!repository) {
        printError(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      if (opts.yes !== true && !outputOptions().input) {
        printError(`Refusing to remove ${id} without --yes (no interactive input available).`);
        process.exitCode = 1;
        return;
      }
      const repoTasks = listTasks(db).filter((t) => t.repositoryId === id);
      if (opts.withTasks) {
        for (const t of repoTasks) deleteTask(db, t.id);
      } else if (repoTasks.length > 0) {
        // Don't silently orphan tasks — warn and name them so the user can re-run with --with-tasks.
        printError(
          `${repoTasks.length} task(s) reference ${id} and would be orphaned: ${repoTasks.map((t) => t.id).join(', ')}. ` +
            `Re-run with --with-tasks to delete them too.`,
        );
        process.exitCode = 1;
        return;
      }
      await unregisterRepository(db, id);
      if (outputOptions().json) emitJson({ removed: id, tasksDeleted: opts.withTasks ? repoTasks.length : 0 });
      else printInfo(`Unregistered ${repository.name} (${id}). Files left untouched.`);
    });

  repo
    .command('open [repo]')
    .description('Open the repository directory in the system file browser')
    .action(async (ref: string | undefined) => {
      const db = openWorkbenchDatabase().db;
      const id = await resolveRepoRef(ref);
      const repository = await getRepository(db, id);
      if (!repository) {
        printError(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      const command =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      const child = spawn(command, [repository.canonicalPath], { detached: true, stdio: 'ignore' });
      child.unref();
      if (outputOptions().json) emitJson({ opened: repository.canonicalPath });
      else printInfo(`Opening ${repository.canonicalPath}`);
    });
}
