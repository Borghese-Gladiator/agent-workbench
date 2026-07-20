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

export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Manage registered repositories');

  repo
    .command('add <path>')
    .description('Register a local Git repository')
    .option('--name <name>', 'Display name for the repository')
    .action(async (path: string, opts: { name?: string }) => {
      const { db } = openWorkbenchDatabase();
      const canonicalPath = resolve(path);
      const repository = await registerRepository(db, { canonicalPath, name: opts.name });
      console.log(`Registered repository ${repository.id} (${repository.name}) — untrusted until approved.`);
      console.log(`Run 'awb repo refresh ${repository.id}' to discover its structure, then 'awb repo approve ${repository.id}'.`);
    });

  repo
    .command('list')
    .description('List registered repositories')
    .action(async () => {
      const { db } = openWorkbenchDatabase();
      const repositories = await listRepositories(db);
      if (repositories.length === 0) {
        console.log('No repositories registered yet. Use `awb repo add <path>`.');
        return;
      }
      for (const r of repositories) {
        console.log(`${r.id}  ${r.trusted ? '[trusted]  ' : '[untrusted]'}  ${r.name}  ${r.canonicalPath}`);
      }
    });

  repo
    .command('inspect <repositoryId>')
    .description('Show details for a registered repository')
    .action(async (repositoryId: string) => {
      const { db } = openWorkbenchDatabase();
      const repository = await getRepository(db, repositoryId);
      if (!repository) {
        console.error(`No repository with id ${repositoryId}`);
        process.exitCode = 1;
        return;
      }
      const snapshot = await getLatestSnapshot(db, repositoryId);
      console.log(JSON.stringify({ repository, latestSnapshot: snapshot }, null, 2));
    });

  repo
    .command('refresh <repositoryId>')
    .description('Run discovery and record a new repository snapshot')
    .action(async (repositoryId: string) => {
      const { db } = openWorkbenchDatabase();
      const repository = await getRepository(db, repositoryId);
      if (!repository) {
        console.error(`No repository with id ${repositoryId}`);
        process.exitCode = 1;
        return;
      }
      const snapshot = await refreshRepositorySnapshot(db, repository);
      console.log(
        `Recorded snapshot ${snapshot.id} at ${snapshot.headSha.slice(0, 12)} — ${snapshot.units.length} unit(s), ${snapshot.commands.length} command(s).`,
      );
    });

  repo
    .command('approve <repositoryId>')
    .description('Mark a discovered repository profile as trusted')
    .action(async (repositoryId: string) => {
      const { db } = openWorkbenchDatabase();
      const repository = await getRepository(db, repositoryId);
      if (!repository) {
        console.error(`No repository with id ${repositoryId}`);
        process.exitCode = 1;
        return;
      }
      await approveRepository(db, repositoryId);
      console.log(`Repository ${repositoryId} is now trusted.`);
    });
}
