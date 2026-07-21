import { resolve } from 'node:path';
import type { Command } from 'commander';
import {
  registerRepository,
  approveRepository,
  getRepository,
  listRepositories,
  refreshRepositorySnapshot,
  getLatestSnapshot,
} from '@awb/repository';
import { openWorkbenchDatabase } from '../db.js';
import { rememberRepositoryId, resolveRepositoryId } from '../remembered.js';

export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Manage registered repositories');

  repo
    .command('add <path>')
    .description('Register a local Git repository')
    .option('--name <name>', 'Display name for the repository')
    .option('--json', 'Print the registered repository as JSON')
    .action(async (path: string, opts: { name?: string; json?: boolean }) => {
      const { db } = openWorkbenchDatabase();
      const canonicalPath = resolve(path);
      const repository = await registerRepository(db, { canonicalPath, name: opts.name });
      rememberRepositoryId(repository.id);
      if (opts.json) {
        console.log(JSON.stringify(repository, null, 2));
        return;
      }
      console.log(`Registered repository ${repository.id} (${repository.name}) — untrusted until approved.`);
      console.log(`Run 'awb repo refresh ${repository.id}' to discover its structure, then 'awb repo approve ${repository.id}'.`);
    });

  repo
    .command('list')
    .description('List registered repositories')
    .option('--json', 'Print the repository list as JSON')
    .action(async (opts: { json?: boolean }) => {
      const { db } = openWorkbenchDatabase();
      const repositories = await listRepositories(db);
      if (opts.json) {
        console.log(JSON.stringify(repositories, null, 2));
        return;
      }
      if (repositories.length === 0) {
        console.log('No repositories registered yet. Use `awb repo add <path>`.');
        return;
      }
      for (const r of repositories) {
        console.log(`${r.id}  ${r.trusted ? '[trusted]  ' : '[untrusted]'}  ${r.name}  ${r.canonicalPath}`);
      }
    });

  repo
    .command('inspect [repositoryId]')
    .description('Show details for a registered repository (falls back to the last one used)')
    .action(async (repositoryId: string | undefined) => {
      const { db } = openWorkbenchDatabase();
      const id = resolveRepositoryId(repositoryId);
      const repository = await getRepository(db, id);
      if (!repository) {
        console.error(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      const snapshot = await getLatestSnapshot(db, id);
      console.log(JSON.stringify({ repository, latestSnapshot: snapshot }, null, 2));
    });

  repo
    .command('refresh [repositoryId]')
    .description('Run discovery and record a new repository snapshot (falls back to the last one used)')
    .action(async (repositoryId: string | undefined) => {
      const { db } = openWorkbenchDatabase();
      const id = resolveRepositoryId(repositoryId);
      const repository = await getRepository(db, id);
      if (!repository) {
        console.error(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      const snapshot = await refreshRepositorySnapshot(db, repository);
      console.log(
        `Recorded snapshot ${snapshot.id} at ${snapshot.headSha.slice(0, 12)} — ${snapshot.units.length} unit(s), ${snapshot.commands.length} command(s).`,
      );
    });

  repo
    .command('approve [repositoryId]')
    .description('Mark a discovered repository profile as trusted (falls back to the last one used)')
    .action(async (repositoryId: string | undefined) => {
      const { db } = openWorkbenchDatabase();
      const id = resolveRepositoryId(repositoryId);
      const repository = await getRepository(db, id);
      if (!repository) {
        console.error(`No repository with id ${id}`);
        process.exitCode = 1;
        return;
      }
      await approveRepository(db, id);
      console.log(`Repository ${id} is now trusted.`);
    });
}
